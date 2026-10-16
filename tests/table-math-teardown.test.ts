import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
// Actual CM widgets and DOM events. Geometry stubs do not establish browser
// hover appearance, hit testing, touch, or reference runtime equivalence.
function setup(t: TestContext, value: string) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { pretendToBeVisual: true, url: 'https://app.local/index.html' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, entry] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: entry });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = document.querySelector<HTMLElement>('#host')!, changes: string[] = [];
  const editor = createEditor(host, { value, mode: 'live', paths: () => [], open() {}, onChange: value => changes.push(value) });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  let destroyed = false;
  const destroy = () => { if (!destroyed) { destroyed = true; editor.destroy(); } };
  t.after(() => {
    destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const click = (target: Element) => target.dispatchEvent(new dom.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
  const button = (kind: 'row' | 'column') => host.querySelector<HTMLButtonElement>(`.cm-table-add-${kind}`)!;
  const active = () => {
    const node = host.querySelector('.cm-live-table .cm-editor'); assert.ok(node);
    return EditorView.findFromDOM(node)!;
  };
  const activate = (row: number, column: number) => {
    const cell = host.querySelector<HTMLElement>(`.cm-live-table [data-row="${row}"][data-column="${column}"]`)!;
    assert.ok(cell);
    cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    return active();
  };
  return { dom, host, editor, view, changes, destroy, click, button, active, activate };
}


const source = 'Before\n\n| A | B |\n| --- | --- |\n| $x$ | plain |\n\nAfter';
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function deferredEngine(dom: JSDOM) {
  await flush();
  const pending: { source: string; resolve: (element: HTMLElement) => void }[] = [];
  (dom.window as unknown as { MathJax: unknown }).MathJax = {
    startup: { promise: Promise.resolve() },
    tex2chtmlPromise: (source: string) => new Promise<HTMLElement>(resolve => pending.push({ source, resolve })),
    chtmlStylesheet: () => null,
  };
  const script = dom.window.document.querySelector('script[data-zorid-mathjax]');
  assert.ok(script, 'actual inline renderer starts the local engine');
  script.dispatchEvent(new dom.window.Event('load')); await flush();
  assert.equal(pending.length, 1);
  const complete = async (index = 0) => {
    const node = dom.window.document.createElement('mjx-container'); node.textContent = `rendered ${pending[index].source}`;
    pending[index].resolve(node); await flush();
  };
  return { pending, complete };
}

test('activating a rendered math cell cancels its pending output without changing note history', async t => {
  const { dom, host, editor, view, activate } = setup(t, source);
  const old = host.querySelector('.math')!;
  const { complete } = await deferredEngine(dom);
  const child = activate(1, 0);
  await complete();
  assert.equal(old.querySelector('mjx-container'), null);
  assert.equal(old.classList.contains('is-loaded'), false);
  assert.equal(child.state.doc.toString(), '$x$');
  assert.equal(child.hasFocus, true);
  assert.equal(editor.getValue(), source);
  assert.equal(undo(view), false, 'render cancellation does not enter document history');
});

test('replacing rendered cell content rejects stale output while its successor renders', async t => {
  const { dom, host, view, editor } = setup(t, source);
  const old = host.querySelector('.math')!;
  const { pending, complete } = await deferredEngine(dom);
  const at = source.indexOf('$x$');
  view.dispatch({ changes: { from: at, to: at + 3, insert: '$y$' } });
  const fresh = host.querySelector('.math')!; assert.notEqual(old, fresh);
  await complete();
  assert.equal(old.querySelector('mjx-container'), null);
  assert.equal(pending[1].source, 'y'); await complete(1);
  assert.equal(fresh.textContent, 'rendered y');
  assert.equal(editor.getValue(), source.replace('$x$', '$y$'));
  assert.equal(undo(view), true); assert.equal(editor.getValue(), source);
});

test('structural grid replacement disposes removed cells but preserves the successor math', async t => {
  const { dom, host, click, button } = setup(t, source);
  const old = host.querySelector('.math')!;
  const { complete } = await deferredEngine(dom);
  click(button('row'));
  const fresh = host.querySelector('.math')!; assert.notEqual(old, fresh);
  await complete();
  assert.equal(old.querySelector('mjx-container'), null);
  assert.equal(fresh.textContent, 'rendered x');
  assert.equal(host.querySelectorAll('tbody tr').length, 2);
});

test('destroying the parent disposes pending table math without rendering an active cell again', async t => {
  const { dom, host, destroy, activate } = setup(t, source);
  const old = host.querySelector('.math')!;
  const { pending, complete } = await deferredEngine(dom);
  const child = activate(1, 1);
  child.dispatch({ changes: { from: 0, to: child.state.doc.length, insert: '$unused$' } });
  destroy(); await complete();
  assert.equal(old.querySelector('mjx-container'), null);
  assert.deepEqual(pending.map(item => item.source), ['x'], 'destroy does not start a new render for the active cell');
});

test('resetting the document disposes rendered table cells before late completion', async t => {
  const { dom, host, editor } = setup(t, source);
  const old = host.querySelector('.math')!;
  const { complete } = await deferredEngine(dom);
  editor.setValue('Replacement'); await complete();
  assert.equal(old.querySelector('mjx-container'), null);
  assert.equal(host.querySelector('.cm-live-table'), null);
  assert.equal(editor.getValue(), 'Replacement');
});
