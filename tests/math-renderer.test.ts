import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMathRenderer } from '../src/ui/math-renderer.ts';
import type { MathEngine } from '../src/ui/math-renderer.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t: TestContext) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://zorid.test/' });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const element = (text = '') => { const node = document.createElement('span'); node.textContent = text; return node; };
  const parent = () => { const node = element(); document.body.append(node); return node; };
  return { document, element, parent };
}

test('duplicate work shares conversion while each result owns independent cloned DOM', async t => {
  const { document, element, parent } = fixture(t), gate = deferred<HTMLElement>();
  let loads = 0, conversions = 0, notifications = 0;
  const original = element('x'), style = document.createElement('style');
  const renderer = createMathRenderer(async () => { loads++; return {
    convert: async () => { conversions++; return gate.promise; }, stylesheet: () => style,
  }; });
  const first = parent(), second = parent();
  const a = renderer(first, 'x', { onReady: () => { notifications++; } });
  const b = renderer(second, 'x', { onReady: () => { notifications++; } });
  gate.resolve(original);
  assert.deepEqual(await Promise.all([a.ready, b.ready]), [true, true]);
  assert.equal(loads, 1); assert.equal(conversions, 1); assert.equal(notifications, 2);
  assert.equal(first.textContent, 'x'); assert.ok(first.classList.contains('is-loaded'));
  assert.notEqual(first.firstChild, second.firstChild); assert.notEqual(first.firstChild, original);
  first.firstChild!.textContent = 'changed';
  assert.equal(second.textContent, 'x'); assert.equal(original.textContent, 'x');
  assert.equal(document.head.querySelectorAll('style').length, 1);
});

test('display flag partitions cache and each owning document loads independently', async t => {
  const first = fixture(t), second = fixture(t), calls: boolean[] = [];
  let loads = 0;
  const render = createMathRenderer(async document => { loads++; return {
    convert: async (_source, display) => { calls.push(display); return document.createElement('span'); }, stylesheet: () => null,
  }; });
  const inline = first.parent(), block = first.parent();
  await render(inline, 'x').ready; await render(block, 'x', { display: true }).ready;
  await render(first.parent(), 'x').ready; await render(second.parent(), 'x').ready;
  assert.deepEqual(calls, [false, true, false]); assert.equal(loads, 2);
  assert.ok(inline.classList.contains('math-inline')); assert.ok(block.classList.contains('math-block'));
  await render(block, 'x').ready;
  assert.ok(block.classList.contains('math-inline')); assert.equal(block.classList.contains('math-block'), false);
});

test('disposal and later renders prevent stale results or notifications on an owned parent', async t => {
  const { element, parent } = fixture(t), gate = deferred<HTMLElement>(), started = deferred<void>();
  let notifications = 0;
  const render = createMathRenderer(async () => ({ convert: async source => {
    if (source === 'old') { started.resolve(); return gate.promise; }
    return element(source);
  }, stylesheet: () => null }));
  const target = parent();
  const old = render(target, 'old', { onReady: () => { notifications++; } });
  await started.promise;
  const fresh = render(target, 'fresh', { onReady: () => { notifications++; } });
  gate.resolve(element('obsolete'));
  assert.equal(await old.ready, false); assert.equal(await fresh.ready, true);
  assert.equal(target.textContent, 'fresh'); assert.equal(notifications, 1);
  const disposed = render(target, 'never', { onReady: () => { notifications++; } });
  disposed.dispose(); assert.equal(await disposed.ready, false); assert.equal(notifications, 1);
  assert.equal(target.textContent, 'never');
});

test('disposing an in-flight conversion suppresses late output and onReady', async t => {
  const { element, parent } = fixture(t), gate = deferred<HTMLElement>(), started = deferred<void>();
  let notifications = 0;
  const render = createMathRenderer(async () => ({ convert: async () => {
    started.resolve(); return gate.promise;
  }, stylesheet: () => null }));
  const target = parent(), handle = render(target, 'source', { onReady: () => { notifications++; } });
  await started.promise; handle.dispose(); target.textContent = 'host content';
  gate.resolve(element('late'));
  assert.equal(await handle.ready, false); assert.equal(target.textContent, 'host content'); assert.equal(notifications, 0);
});

test('conversion errors preserve source, notify once and can be retried', async t => {
  const { element, parent } = fixture(t); let attempts = 0, notifications = 0;
  const render = createMathRenderer(async () => ({ convert: async source => {
    if (++attempts === 1) throw new Error('bad formula'); return element(source);
  }, stylesheet: () => null }));
  const target = parent();
  assert.equal(await render(target, '\\bad', { onReady: () => { notifications++; } }).ready, false);
  assert.equal(target.textContent, '\\bad'); assert.ok(target.classList.contains('math-error'));
  assert.equal(await render(target, '\\bad', { onReady: () => { notifications++; } }).ready, true);
  assert.equal(attempts, 2); assert.equal(notifications, 2); assert.equal(target.classList.contains('math-error'), false);
});

test('failed engine loading can be retried without poisoning the document', async t => {
  const { element, parent } = fixture(t); let attempts = 0;
  const render = createMathRenderer(async () => {
    if (++attempts === 1) throw new Error('offline');
    return { convert: async source => element(source), stylesheet: () => null };
  });
  assert.equal(await render(parent(), 'x').ready, false);
  assert.equal(await render(parent(), 'x').ready, true); assert.equal(attempts, 2);
});

test('conversion queue serializes engine mutation and continues after a rejection', async t => {
  const { element, parent } = fixture(t), gate = deferred<HTMLElement>(), started = deferred<void>();
  const calls: string[] = [];
  const render = createMathRenderer(async () => ({ convert: async source => {
    calls.push(source);
    if (source === 'first') { started.resolve(); return gate.promise; }
    return element(source);
  }, stylesheet: () => null }));
  const a = render(parent(), 'first'), b = render(parent(), 'second');
  await started.promise; assert.deepEqual(calls, ['first']);
  gate.reject(new Error('first failed'));
  assert.deepEqual(await Promise.all([a.ready, b.ready]), [false, true]);
  assert.deepEqual(calls, ['first', 'second']);
});

test('cache is LRU bounded by entries and a hit renews its retention', async t => {
  const { element, parent } = fixture(t), calls: string[] = [];
  const render = createMathRenderer(async () => ({ convert: async source => { calls.push(source); return element(source); }, stylesheet: () => null }));
  const target = parent();
  for (let i = 0; i < 128; i++) await render(target, String(i)).ready;
  await render(target, '0').ready; await render(target, '128').ready; await render(target, '0').ready;
  assert.equal(calls.filter(source => source === '0').length, 1);
  await render(target, '1').ready; assert.equal(calls.filter(source => source === '1').length, 2);
});

test('cache bounds total TeX size and does not retain individually oversized formulas', async t => {
  const { element, parent } = fixture(t); let conversions = 0;
  const render = createMathRenderer(async () => ({ convert: async () => { conversions++; return element('result'); }, stylesheet: () => null }));
  const target = parent(), sources = Array.from({ length: 9 }, (_, index) => `${index}${'x'.repeat(32767)}`);
  for (const source of sources) await render(target, source).ready;
  await render(target, sources[0]).ready; assert.equal(conversions, 10);
  const large = 'x'.repeat(32769);
  await render(target, large).ready; await render(target, large).ready; assert.equal(conversions, 12);
});

test('macro definitions invalidate cached output and are converted every time', async t => {
  const { element, parent } = fixture(t); const calls: string[] = [];
  const render = createMathRenderer(async () => ({ convert: async source => { calls.push(source); return element(source); }, stylesheet: () => null }));
  const target = parent(), definition = '\\newcommand{\\foo}{x}';
  await render(target, '\\foo').ready; await render(target, '\\foo').ready;
  await render(target, definition).ready; await render(target, '\\foo').ready;
  await render(target, definition).ready;
  assert.deepEqual(calls, ['\\foo', definition, '\\foo', definition]);
});

test('final output guard removes executable descendants and attributes while retaining safe anchors', async t => {
  const { element, parent } = fixture(t), output = element();
  output.innerHTML = '<script>bad()</script><iframe></iframe><object></object><embed><link><meta><base>' +
    '<a id="bad" href="java&#10;script:bad()" onclick="bad()">bad</a>' +
    '<a id="data" href="data:text/html,bad">data</a><a id="file" href="file:///tmp/file">file</a>' +
    '<a id="web" href="https://example.com/path">web</a><a id="mail" href="mailto:a@example.com">mail</a>' +
    '<a id="hash" href="#eq1">hash</a><span style="color: red" onmouseover="bad()">math</span>';
  output.setAttribute('onload', 'bad()');
  const engine: MathEngine = { convert: async () => output, stylesheet: () => null };
  const target = parent(); assert.equal(await createMathRenderer(async () => engine)(target, 'x').ready, true);
  assert.equal(target.querySelectorAll('script,iframe,object,embed,link,meta,base,[onclick],[onload],[onmouseover]').length, 0);
  for (const id of ['bad', 'data', 'file']) assert.equal(target.querySelector(`#${id}`)!.hasAttribute('href'), false);
  for (const id of ['web', 'mail', 'hash']) {
    assert.ok(target.querySelector(`#${id}`)!.hasAttribute('href'));
    assert.equal(target.querySelector(`#${id}`)!.getAttribute('rel'), 'noopener noreferrer');
  }
  assert.equal(target.querySelector('span[style]')!.getAttribute('style'), 'color: red');
  assert.ok(output.querySelector('script'), 'guard only mutates its independent imported copy');
});

test('unsafe engine root cannot enter the output document', async t => {
  const { document, parent } = fixture(t), target = parent(), output = document.createElement('iframe');
  output.setAttribute('src', 'https://example.com/');
  const render = createMathRenderer(async () => ({ convert: async () => output, stylesheet: () => null }));
  await render(target, 'x').ready;
  assert.equal(target.querySelector('iframe'), null);
});

test('a throwing onReady callback does not change successful rendering or repeat notification', async t => {
  const { element, parent } = fixture(t), target = parent(); let notifications = 0;
  const render = createMathRenderer(async () => ({ convert: async () => element('rendered'), stylesheet: () => null }));
  const handle = render(target, 'source', { onReady: () => { notifications++; throw new Error('host callback failed'); } });
  assert.equal(await handle.ready, true);
  assert.equal(target.textContent, 'rendered'); assert.equal(notifications, 1);
  assert.equal(target.classList.contains('math-error'), false);
});
