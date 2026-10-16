import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { createEditor } from '../src/ui/editor.ts';
import type { EditorOptions } from '../src/ui/editor.ts';

// These exercise the real editor/Reading integration with a controlled asynchronous
// MathJax runtime. They establish lifecycle ownership, not TeX or native fidelity.
function setup(t: TestContext, source: string, renderEmbed?: EditorOptions['renderEmbed']) {
  const dom = new JSDOM('<!doctype html><body><main></main>', { pretendToBeVisual: true, url: 'https://app.local/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = document.querySelector<HTMLElement>('main')!;
  const editor = createEditor(host, { value: source, mode: 'live', paths: () => [], open() {}, onChange() {}, renderEmbed });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  let destroyed = false;
  const destroy = () => { if (!destroyed) { destroyed = true; editor.destroy(); } };
  t.after(() => { destroy(); dom.window.close(); for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } });
  const focusAt = async (position: number) => { view.focus(); view.dispatch({ selection: { anchor: position } }); await Promise.resolve(); };
  const click = (node: Element) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  return { dom, host, editor, view, destroy, focusAt, click };
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function pendingMath(dom: JSDOM) {
  await settle();
  const script = dom.window.document.querySelector<HTMLScriptElement>('script[data-zorid-mathjax]');
  assert.ok(script, 'actual editor integration loads the math renderer');
  let complete!: (node: HTMLElement) => void, conversions = 0;
  (dom.window as unknown as { MathJax: unknown }).MathJax = {
    startup: { promise: Promise.resolve() },
    tex2chtmlPromise() { conversions++; return new Promise<HTMLElement>(resolve => { complete = resolve; }); },
    chtmlStylesheet() { return dom.window.document.createElement('style'); },
  };
  script.dispatchEvent(new dom.window.Event('load')); await settle();
  assert.equal(conversions, 1, 'one conversion is pending');
  return async () => {
    const result = dom.window.document.createElement('mjx-container'); result.textContent = 'finished math'; complete(result);
    await settle(); await settle();
  };
}
const table = '# Section\n\n| A |\n| --- |\n| $x$ |\n\n# End\nText';
const callout = '# Section\n\n> [!note] Title\n> $x$\n\n# End\nText';

for (const operation of ['activate', 'replace', 'fold', 'destroy'] as const) test(`table math ignores late output after ${operation}`, async t => {
  const { dom, host, editor, view, destroy, focusAt } = setup(t, table);
  await focusAt(0);
  const oldMath = host.querySelector<HTMLElement>('.cm-live-table .math');
  assert.ok(oldMath, 'table cell uses the shared Reading math renderer');
  const complete = await pendingMath(dom), literal = oldMath.textContent;
  if (operation === 'activate') host.querySelector('td')!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  if (operation === 'replace') editor.setValue(table.replace('$x$', 'plain'));
  if (operation === 'fold') assert.ok(editor.fold!('fold'));
  if (operation === 'destroy') destroy();
  assert.equal(oldMath.isConnected, false, 'old rendered subtree is removed');
  await complete();
  assert.equal(oldMath.textContent, literal, 'removed subtree is disposed before pending output resolves');
  assert.equal(oldMath.classList.contains('is-loaded'), false);
  if (operation !== 'replace' && operation !== 'destroy') assert.equal(view.state.doc.toString(), table);
});

for (const operation of ['source', 'fold', 'replace', 'destroy'] as const) test(`callout math ignores late output after ${operation}`, async t => {
  const { dom, host, editor, view, destroy, focusAt, click } = setup(t, callout);
  await focusAt(0);
  const oldMath = host.querySelector<HTMLElement>('.cm-live-callout .math');
  assert.ok(oldMath, 'callout body uses the shared Reading math renderer');
  const complete = await pendingMath(dom), literal = oldMath.textContent;
  if (operation === 'source') click(host.querySelector('.cm-callout-edit')!);
  if (operation === 'fold') assert.ok(editor.fold!('fold'));
  if (operation === 'replace') editor.setValue(callout.replace('$x$', 'plain'));
  if (operation === 'destroy') destroy();
  assert.equal(oldMath.isConnected, false);
  await complete();
  assert.equal(oldMath.textContent, literal, 'removed callout math must ignore late output');
  assert.equal(oldMath.classList.contains('is-loaded'), false);
  if (operation !== 'replace' && operation !== 'destroy') assert.equal(view.state.doc.toString(), callout);
});

test('fold and unfold remounts pending callout math without reviving its disposed predecessor', async t => {
  const { dom, host, editor, focusAt } = setup(t, callout);
  await focusAt(0);
  const before = host.querySelector<HTMLElement>('.cm-live-callout .math')!;
  assert.ok(before); const complete = await pendingMath(dom);
  assert.ok(editor.fold!('fold')); assert.ok(editor.fold!('unfold'));
  const after = host.querySelector<HTMLElement>('.cm-live-callout .math')!;
  assert.ok(after); assert.notEqual(after, before);
  await complete();
  assert.equal(before.classList.contains('is-loaded'), false);
  assert.equal(after.classList.contains('is-loaded'), true, 'new consumer receives the shared conversion result');
  assert.equal(after.textContent, 'finished math'); assert.equal(editor.getValue(), callout);
});

test('composition defers callout source reveal and preserves document plus secondary caret', async t => {
  const { dom, host, view, focusAt } = setup(t, callout);
  await focusAt(0);
  const original = host.querySelector('.cm-live-callout'); assert.ok(original);
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(callout.indexOf('Title'))], 1) });
  assert.equal(host.querySelector('.cm-live-callout'), original);
  view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(host.querySelector('.cm-live-callout'), null);
  assert.equal(view.state.selection.main.head, callout.indexOf('Title'));
  assert.equal(view.state.selection.ranges.length, 2);
  assert.equal(view.state.doc.toString(), callout);
});

test('mixed callout body renders display math and ordinary fence controls under one block owner', async t => {
  const source = 'Before\n\n> [!note] Mixed\n> $$\n> x^2\n> $$\n>\n> ```js\n> const x = 1;\n> ```\n>\n> | A |\n> | --- |\n> | $y$ |\n\nAfter';
  const { host, editor, focusAt } = setup(t, source);
  await focusAt(0);
  const callout = host.querySelector('.cm-live-callout'); assert.ok(callout);
  assert.equal(callout.querySelectorAll('.math-block').length, 1, 'multiline display math renders in the callout body');
  assert.equal(callout.querySelectorAll('table .math-inline').length, 1);
  assert.equal(callout.querySelectorAll('.zorid-code-copy').length, 1, 'ordinary fence uses shared code controls');
  assert.equal(host.querySelectorAll('.cm-live-table,.cm-live-math,.cm-fence-flair').length, 0, 'enclosing callout owns all nested renderers');
  assert.equal(editor.getValue(), source);
});


test('editing math source never mounts wiki embeds lexically contained in the formula', async t => {
  const source = 'Before\n\n$![[picture.png]]$\n\n$$\n![[other.png]]\n$$\n\nAfter';
  let mounted = 0;
  const { host, editor, focusAt } = setup(t, source, () => {
    mounted++; return { dom: document.createElement('span'), destroy() {} };
  });
  await focusAt(0);
  assert.equal(mounted, 0);
  await focusAt(source.indexOf('picture'));
  assert.equal(host.querySelectorAll('.cm-live-embed').length, 0, 'inline math syntax owns embed-looking source during editing');
  await focusAt(source.indexOf('other'));
  assert.equal(host.querySelectorAll('.cm-live-embed').length, 0, 'display math syntax owns embed-looking source during editing');
  assert.equal(mounted, 0); assert.equal(editor.getValue(), source);
});
