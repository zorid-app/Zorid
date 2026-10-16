import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMathRenderer } from '../src/ui/math-renderer.ts';

// Work counts, not elapsed-time benchmarks. This fixture models leaving a note
// while the first conversion is still running and later unique formulas queue.
test('disposed math owners do not run queued conversions after leaving a note', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const converted: string[] = [];
  const render = createMathRenderer(async () => ({
    async convert(source) {
      converted.push(source);
      if (source === 'formula-0') await blocked;
      const result = dom.window.document.createElement('span'); result.textContent = source; return result;
    },
    stylesheet: () => null,
  }));
  const handles = Array.from({ length: 16 }, (_, index) => render(dom.window.document.createElement('span'), `formula-${index}`));
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  assert.deepEqual(converted, ['formula-0']);
  handles.forEach(handle => handle.dispose());
  release();
  const ready = await Promise.all(handles.map(handle => handle.ready));
  await render(dom.window.document.createElement('span'), 'sentinel').ready;
  try {
    assert.ok(ready.every(value => !value), 'disposed owners never receive stale DOM');
    assert.deepEqual(converted, ['formula-0', 'sentinel'], 'only the running conversion and active sentinel may finish; unused queued formulas should be cancelled');
  } finally { dom.window.close(); }
});

test('cancelled cache jobs can be retried while surviving shared owners still convert once', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const parent = () => dom.window.document.createElement('span');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const converted: string[] = [];
  const render = createMathRenderer(async () => ({
    async convert(source) {
      converted.push(source); if (source === 'blocker') await blocked;
      const result = parent(); result.textContent = source; return result;
    }, stylesheet: () => null,
  }));
  const first = render(parent(), 'blocker'), abandoned = render(parent(), 'retry');
  const sharedA = render(parent(), 'shared'), sharedParent = parent(), sharedB = render(sharedParent, 'shared');
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  abandoned.dispose(); sharedA.dispose(); first.dispose(); release();
  try {
    assert.deepEqual(await Promise.all([first.ready, abandoned.ready, sharedA.ready, sharedB.ready]), [false, false, false, true]);
    assert.deepEqual(converted, ['blocker', 'shared']);
    const retried = parent(); assert.equal(await render(retried, 'retry').ready, true);
    assert.equal(retried.textContent, 'retry'); assert.equal(sharedParent.textContent, 'shared');
    assert.deepEqual(converted, ['blocker', 'shared', 'retry']);
  } finally { dom.window.close(); }
});
