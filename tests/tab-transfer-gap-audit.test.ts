import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';
import { Workspace } from '../src/ui/workspace.ts';
import { createEditor } from '../src/ui/editor.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { createTabDocking } from '../src/ui/tab-docking.ts';

// Deliberate baseline characterization, not the desired transfer contract.
// Replace these gap assertions with preservation assertions when host docking
// is integrated. Tests use real Workspace/CodeMirror and synthetic drag events.
async function setup(t: TestContext, seed = { 'A.md': 'alpha text\n# Heading\nbody\n# End\nlast', 'B.md': 'other' }) {
  const dom = new JSDOM('<!doctype html><body><main></main>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia as typeof window.matchMedia;
  const rect = () => ({ top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const root = document.querySelector<HTMLElement>('main')!, adapter = new MemoryAdapter(seed), originalWrite = adapter.write.bind(adapter);
  const workspace = new Workspace(root, createEditor);
  t.after(async () => {
    adapter.write = originalWrite;
    try { await workspace.destroy(); }
    finally { dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
  });
  await workspace.start({ adapter, id: 'test:tab-transfer-gap', label: 'Test' });
  const transfer = { values: new Map<string, string>(), effectAllowed: 'none', dropEffect: 'none', setData(type: string, value: string) { this.values.set(type, value); }, getData(type: string) { return this.values.get(type) ?? ''; } };
  const drag = (type: string, target: Element, x = 100, y = 20) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, buttons: 1, clientX: x, clientY: y });
    Object.defineProperty(event, 'dataTransfer', { value: transfer }); target.dispatchEvent(event); return event;
  };
  const view = (pane = workspace.activePane) => EditorView.findFromDOM(pane.element.querySelector('.cm-editor')!)!;
  return { dom, root, adapter, workspace, transfer, drag, view };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition: () => boolean) { for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await tick(); } assert.ok(condition(), 'asynchronous workspace action settled'); }

test('audit baseline: same-pane tab reorder preserves text/selection/folds but recreates the editor without undo', async t => {
  const { workspace, adapter, drag, view } = await setup(t);
  await workspace.openNote('B.md'); await workspace.openNote('A.md', true);
  const pane = workspace.activePane, tab = pane.tabs.find(tab => tab.path === 'A.md')!, before = view(), handle = pane.editor!;
  before.dispatch({ changes: { from: 0, insert: 'X' }, annotations: Transaction.userEvent.of('input.type') });
  before.dispatch({ selection: EditorSelection.range(8, 2) });
  handle.fold!('foldAll');
  const selection = before.state.selection.toJSON(), folds = handle.getViewState!().folds, text = before.state.doc.toString();
  assert.equal(undoDepth(before.state), 1);
  const nodes = pane.element.querySelectorAll('.tab'); drag('dragstart', nodes[1]); drag('drop', nodes[0]);
  await until(() => !!pane.editor && pane.editor !== handle && pane.viewTabId === tab.id);
  const after = view();
  assert.equal(pane.tabs[0], tab, 'the Tab record keeps identity');
  assert.notEqual(after, before, 'baseline destroys the live editor on reorder');
  assert.equal(after.state.doc.toString(), text); assert.equal(await adapter.read('A.md'), text, 'baseline requires a successful save');
  assert.deepEqual(after.state.selection.toJSON(), selection); assert.deepEqual(pane.editor!.getViewState!().folds, folds);
  assert.equal(undoDepth(after.state), 0, 'known gap: undo is absent from EditorViewState');
});

test('audit baseline: cross-pane drop leaves an empty source pane and does not move navigation history', async t => {
  const { workspace, drag, view } = await setup(t);
  await workspace.openNote('A.md');
  const source = workspace.activePane, sourceEditor = source.editor!, tab = source.tabs[0];
  await (workspace as any).split('right');
  const target = workspace.activePane; await workspace.openNote('B.md'); const targetEditor = target.editor!;
  view(source).dispatch({ changes: { from: 0, insert: 'unsaved ' }, annotations: Transaction.userEvent.of('input.type') });
  drag('dragstart', source.element.querySelector('.tab')!); drag('drop', target.element.querySelector('.tab')!);
  await until(() => target.tabs.includes(tab) && source.editor !== sourceEditor && !!target.editor && target.editor !== targetEditor && target.viewTabId === tab.id);
  assert.equal(workspace.panes.length, 2, 'known gap: source group is filled with a blank tab, not collapsed');
  assert.equal(source.tabs.length, 1); assert.equal(source.tabs[0].path, null);
  assert.equal(target.tabs[0], tab); assert.equal(target.editor!.getValue().startsWith('unsaved '), true);
  assert.deepEqual(source.history, ['A.md']); assert.deepEqual(target.history, ['B.md'], 'history currently belongs to the pane');
});

test('failed pre-drop save keeps source ownership, dirty text, selection and undo intact', async t => {
  const { workspace, adapter, drag, view, root } = await setup(t);
  await workspace.openNote('B.md'); await workspace.openNote('A.md', true);
  const pane = workspace.activePane, tab = pane.tabs[1], handle = pane.editor!, editor = view();
  adapter.write = async () => { throw new Error('audit blocked save'); };
  editor.dispatch({ changes: { from: 0, insert: 'dirty ' }, annotations: Transaction.userEvent.of('input.type') });
  editor.dispatch({ selection: EditorSelection.range(9, 2) });
  const before = editor.state.selection.toJSON(), nodes = pane.element.querySelectorAll('.tab');
  drag('dragstart', nodes[1]); drag('drop', nodes[0]);
  await until(() => document.body.textContent!.includes('audit blocked save'));
  assert.equal(pane.tabs[1], tab); assert.equal(pane.editor, handle); assert.equal(view(), editor);
  assert.equal(editor.state.doc.toString().startsWith('dirty '), true); assert.deepEqual(editor.state.selection.toJSON(), before);
  assert.equal(undoDepth(editor.state), 1); assert.ok(root.querySelector('.cm-editor'));
  assert.match(localStorage.getItem('zorid:draft:test:tab-transfer-gap:A.md')!, /dirty /);
});

test('audit baseline: moving an active table cell preserves source text but loses the focused child view', async t => {
  const { workspace, drag, view, dom } = await setup(t, { 'A.md': '| H |\n| --- |\n| first |', 'B.md': 'other' });
  await workspace.openNote('B.md'); await workspace.openNote('A.md', true);
  const pane = workspace.activePane, handle = pane.editor!, parent = view();
  const cell = pane.element.querySelector<HTMLElement>('td')!;
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  assert.ok(child); child.dispatch({ changes: { from: 0, insert: 'X' }, annotations: Transaction.userEvent.of('input.type') });
  child.dispatch({ selection: EditorSelection.range(4, 1) });
  assert.equal(child.hasFocus, true, 'the pre-move child is actually focused');
  const text = parent.state.doc.toString(), selected = parent.state.selection.toJSON();
  assert.equal(text.includes('Xfirst'), true); assert.equal(undoDepth(parent.state), 1);
  const nodes = pane.element.querySelectorAll('.tab'); drag('dragstart', nodes[1]); drag('drop', nodes[0]);
  await until(() => !!pane.editor && pane.editor !== handle && pane.viewTabId === pane.active); await tick();
  assert.equal(view().state.doc.toString(), text); assert.deepEqual(view().state.selection.toJSON(), selected);
  assert.equal(child.dom.isConnected, false); assert.equal(pane.element.querySelector('.cm-live-table .cm-editor'), null);
  assert.equal(undoDepth(view().state), 0, 'table source undo was part of the discarded parent state');
});

test('synthetic no-drop drag/Escape/end lifecycle leaves actual editor state and dirty recovery untouched', async t => {
  const { workspace, drag, view, adapter, dom } = await setup(t);
  await workspace.openNote('A.md');
  const pane = workspace.activePane, handle = pane.editor!, editor = view(), ids = pane.tabs.map(tab => tab.id);
  editor.dispatch({ changes: { from: 0, insert: 'dirty ' }, annotations: Transaction.userEvent.of('input.type') });
  editor.dispatch({ selection: EditorSelection.range(9, 2) }); const selection = editor.state.selection.toJSON();
  const recovery = localStorage.getItem('zorid:draft:test:tab-transfer-gap:A.md');
  drag('dragstart', pane.element.querySelector('.tab')!);
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  drag('dragend', pane.element.querySelector('.tab')!); await tick();
  assert.equal(pane.editor, handle); assert.equal(view(), editor); assert.deepEqual(pane.tabs.map(tab => tab.id), ids);
  assert.deepEqual(editor.state.selection.toJSON(), selection); assert.equal(undoDepth(editor.state), 1);
  assert.equal(localStorage.getItem('zorid:draft:test:tab-transfer-gap:A.md'), recovery);
  assert.equal((await adapter.read('A.md')).startsWith('dirty '), false, 'cancellation does not force a save');
});

test('docking helper does not treat foreign renderer payloads as authorized local tab sessions', t => {
  const dom = new JSDOM('<!doctype html><body><main><section><header><button>Target</button></header></section></main>');
  const root = dom.window.document.querySelector('main')!, pane = root.querySelector('section')!, bar = root.querySelector('header')!, tab = root.querySelector('button')!;
  let moves = 0, tearOffs = 0;
  const docking = createTabDocking({ root, getPanes: () => [{ id: 'target', element: pane, tabBar: bar, tabs: [{ id: 'one', element: tab }] }], dock: () => { moves++; }, tearOff: () => { tearOffs++; } });
  t.after(() => { docking.destroy(); dom.window.close(); });
  for (const type of ['dragenter', 'dragover', 'drop', 'dragend']) {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 20 });
    Object.defineProperty(event, 'dataTransfer', { value: { getData: () => JSON.stringify({ version: 1, paneId: 'foreign', tabId: 'dirty-tab' }), dropEffect: 'none' } });
    pane.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
  }
  assert.equal(moves, 0); assert.equal(tearOffs, 0); assert.equal(dom.window.document.querySelector('.tab-docking-preview'), null);
});
