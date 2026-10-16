import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMathRenderer } from '../src/ui/math-renderer.ts';
import { createReadingMathRenderer, destroyMathRenders } from '../src/ui/reading-math.ts';
import { renderMarkdown } from '../src/ui/markdown.ts';

function harness() {
  const document = new JSDOM('<!doctype html><main></main>').window.document;
  const pending: { source: string; display: boolean; resolve: (element: HTMLElement) => void }[] = [];
  const api = createReadingMathRenderer(createMathRenderer(async () => ({
    convert: (source, display) => new Promise<HTMLElement>(resolve => pending.push({ source, display, resolve })),
    stylesheet: () => null,
  })));
  const output = (source: string) => { const element = document.createElement('mjx-container'); element.textContent = `rendered ${source}`; return element; };
  return { document, pending, output, ...api };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

test('Reading math renders into the owning document and forwards display and completion', async () => {
  const { document, pending, output, renderReadingMath } = harness();
  const parent = document.createElement('span'); let calls = 0;
  const handle = renderReadingMath(parent, 'x^2', { display: true, onReady: () => calls++ });
  await flush(); assert.deepEqual(pending.map(({ source, display }) => ({ source, display })), [{ source: 'x^2', display: true }]);
  pending[0].resolve(output('x^2'));
  assert.equal(await handle.ready, true); assert.equal(calls, 1);
  assert.equal(parent.firstElementChild?.ownerDocument, document);
  assert.equal(parent.textContent, 'rendered x^2');
});

test('subtree disposal suppresses late writes and callbacks on detached Reading output', async () => {
  const { document, pending, output, renderReadingMath, destroyMathRenders } = harness();
  const container = document.querySelector('main')!, parent = document.createElement('span');
  container.append(parent); let calls = 0;
  const handle = renderReadingMath(parent, 'old', { onReady: () => calls++ });
  await flush(); destroyMathRenders(container); container.replaceChildren();
  pending[0].resolve(output('old'));
  assert.equal(await handle.ready, false); assert.equal(calls, 0); assert.equal(parent.textContent, 'old');
  destroyMathRenders(container); handle.dispose();
});

test('root disposal and replacement cannot cancel or overwrite a newer math owner', async () => {
  const { document, pending, output, renderReadingMath, destroyMathRenders } = harness();
  const parent = document.createElement('span');
  const old = renderReadingMath(parent, 'old'); await flush();
  const fresh = renderReadingMath(parent, 'fresh'); old.dispose();
  pending[0].resolve(output('old')); assert.equal(await old.ready, false); await flush();
  pending[1].resolve(output('fresh')); assert.equal(await fresh.ready, true);
  assert.equal(parent.textContent, 'rendered fresh');
  const last = renderReadingMath(parent, 'last'); await flush(); destroyMathRenders(parent);
  pending[2].resolve(output('last')); assert.equal(await last.ready, false);
  assert.equal(parent.textContent, 'last');
});

test('Reading list labels, heading text, quote text and table cells use the inline math renderer', () => {
  const document = new JSDOM('<!doctype html><main></main>').window.document;
  const previous = globalThis.document; globalThis.document = document;
  const parent = document.querySelector('main')!;
  try {
    renderMarkdown(parent, '# $h$\n\n- **$a$**\n\n> $q$\n\n| $x$ | value |\n| --- | --- |\n| *$y$* | text |', () => {});
    assert.equal(parent.querySelector('h1 > .math-inline')?.textContent, 'h');
    assert.equal(parent.querySelector('li strong > .math-inline')?.textContent, 'a');
    assert.equal(parent.querySelector('blockquote .math-inline')?.textContent, 'q');
    assert.equal(parent.querySelector('th > .math-inline')?.textContent, 'x');
    assert.equal(parent.querySelector('td em > .math-inline')?.textContent, 'y');
  } finally { destroyMathRenders(parent); globalThis.document = previous; }
});
