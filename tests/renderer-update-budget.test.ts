import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { createEditor } from '../src/ui/editor.ts';
import { renderMarkdown } from '../src/ui/markdown.ts';
import { destroyMarkdown } from '../src/ui/markdown-lifecycle.ts';

function setup(t: TestContext) {
  const dom = new JSDOM('<!doctype html><body><main></main>', { pretendToBeVisual: true, url: 'https://zorid.test/' });
  const cleanup: (() => void)[] = [];
  const records: { active: boolean; kind: string; callback: Function }[] = [];
  function observer(kind: string) {
    return class {
      record: typeof records[number];
      constructor(callback: Function) { this.record = { active: false, kind, callback }; records.push(this.record); }
      observe() { this.record.active = true; }
      unobserve() { this.record.active = false; }
      disconnect() { this.record.active = false; }
    };
  }
  const Resize = observer('resize'), Intersection = observer('intersection');
  Object.defineProperty(dom.window, 'ResizeObserver', { value: Resize });
  Object.defineProperty(dom.window, 'IntersectionObserver', { value: Intersection });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text,
    Window: dom.window.Window, MutationObserver: dom.window.MutationObserver, ResizeObserver: Resize,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  t.after(() => { cleanup.forEach(dispose => dispose()); dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  return { dom, cleanup, host: dom.window.document.querySelector<HTMLElement>('main')!, records };
}
const mixed = '# Section\n\nordinary caret destination\n\n$inline$\n\n$$\ndisplay\n$$\n\n```js\nconst value = 1;\n```\n\n| A | B |\n| --- | --- |\n| first | second |\n\n> [!note] Title\n> Body\n> ![[Nested.png]]\n\n![[Picture.png]]\n\n';

// Count source/tree work under selection transactions instead of timing jsdom.
// Zero-layout shims do not establish native viewport or interaction behavior.
test('ordinary caret movement reuses document structure and mounted renderers', t => {
  const { host, records, cleanup } = setup(t);
  const source = mixed + Array.from({ length: 200 }, (_, index) => `# Heading ${index}\nordinary paragraph ${index}\n\n`).join('');
  let mounts = 0, releases = 0;
  const editor = createEditor(host, { value: source, mode: 'live', paths: () => [], open() {}, onChange() {}, renderEmbed() {
    mounts++; return { dom: host.ownerDocument.createElement('span'), destroy() { releases++; } };
  } });
  cleanup.push(() => editor.destroy());
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  ensureSyntaxTree(view.state, source.length, 50); view.dispatch({});
  view.focus(); view.dispatch({ selection: { anchor: source.indexOf('ordinary') } });
  const tree = syntaxTree(view.state), originalIterate = tree.iterate;
  let fullWalks = 0, flattened = 0;
  t.mock.method(tree, 'iterate', function (options) {
    if ((options.from ?? 0) === 0 && (options.to ?? tree.length) >= tree.length) fullWalks++;
    return originalIterate.call(this, options);
  });
  const doc = view.state.doc, originalString = doc.toString;
  t.mock.method(doc, 'toString', function () { flattened++; return originalString.call(this); });
  assert.ok(mounts > 0 && records.length > 0, 'fixture mounts real renderer resources');
  for (const selector of ['.cm-live-callout', '.cm-live-table', '.cm-live-math-block']) assert.ok(host.querySelector(selector), `fixture contains ${selector}`);
  const baseline = { mounts, releases, observers: records.length };
  for (let step = 0; step < 20; step++) view.dispatch({ selection: { anchor: source.indexOf('ordinary') + step % 12 } });
  assert.equal(fullWalks, 0, 'selection-only transactions must not rediscover all block structure');
  assert.equal(flattened, 0, 'selection-only transactions must not flatten the whole document');
  assert.deepEqual({ mounts, releases, observers: records.length }, baseline, 'stable ownership must reuse mounted renderers and observers');
});

test('repeated Live and Reading renderer teardown releases observers and copy actions', async t => {
  const { host, records, cleanup } = setup(t); let mounts = 0, releases = 0;
  const staleButtons: HTMLButtonElement[] = [];
  for (let pass = 0; pass < 6; pass++) {
    const editor = createEditor(host, { value: mixed, mode: 'live', paths: () => [], open() {}, onChange() {}, renderEmbed() {
      mounts++; return { dom: host.ownerDocument.createElement('span'), destroy() { releases++; } };
    } });
    await Promise.resolve();
    editor.destroy(); host.replaceChildren();
    assert.equal(mounts, releases, 'each Live renderer releases its embedded descendants');
    assert.equal(records.filter(record => record.active).length, 0, 'Live teardown leaves no active tracked render observer');
    renderMarkdown(host, mixed, () => {});
    staleButtons.push(...host.querySelectorAll<HTMLButtonElement>('.zorid-code-copy'));
    destroyMarkdown(host); host.replaceChildren();
    assert.equal(records.filter(record => record.active).length, 0, 'Reading teardown leaves no active tracked render observer');
  }
  assert.ok(records.length > 0); assert.ok(staleButtons.length > 0);
  for (const button of staleButtons) assert.equal(button.onclick, null, 'detached copy controls release their callback');
});
