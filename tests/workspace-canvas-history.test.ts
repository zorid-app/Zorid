import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { Workspace } from '../src/ui/workspace.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';

const path = 'Board.canvas';
const original = JSON.stringify({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 320, height: 200, text: '# Original\n\n- item', custom: 42 }], edges: [], unknown: { keep: true } }, null, '\t') + '\n';
async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function setup(t: TestContext) {
  const dom = new JSDOM('<main></main>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, navigator: dom.window.navigator, Text: dom.window.Text, Window: dom.window.Window, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), matchMedia })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = matchMedia; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() { return {}; } });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const root = dom.window.document.querySelector('main')!, adapter = new MemoryAdapter({ [path]: original });
  // The Canvas creates its real shared card editor; the separate note-tab factory stays unused.
  const workspace = new Workspace(root, () => { throw new Error('Unexpected note editor'); });
  t.after(async () => { try { await workspace.destroy(); } finally { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } });
  await workspace.start({ adapter, label: 'Canvas history', id: 'test:canvas-history' }); await workspace.openNote(path);
  const view = workspace.activePane.canvasView!; assert.ok(view);
  const setDocument = view.setDocument.bind(view); let reloads = 0;
  view.setDocument = next => { setDocument(next); reloads++; };
  const reload = async () => { const before = reloads; await workspace.vault.reload([path]); await until(() => reloads > before, 'Canvas watcher reload'); };
  const key = (target: Element, key: string, extra = {}) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  const edit = async (text: string) => {
    root.querySelector('[data-node-id="a"]')!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
    await until(() => !!root.querySelector('.cm-editor'), 'Canvas shared Live editor');
    const cm = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text }, annotations: Transaction.userEvent.of('input.type') });
    // Move focus as a user would before using Canvas history; the first Escape may close pending completion.
    root.querySelector<HTMLElement>('.zorid-canvas-viewport')!.focus(); await workspace.flush();
    await until(() => !root.querySelector('.zorid-canvas-markdown-card.is-editing'), 'Canvas card preview');
  };
  const historyButton = (label: string) => root.querySelector<HTMLButtonElement>(`.zorid-canvas [aria-label="${label}"]`)!;
  return { dom, root, adapter, workspace, view, reload, edit, key, historyButton };
}

test('own Canvas save and duplicate Vault notifications preserve keyboard undo and toolbar redo through persistence', async t => {
  const ui = await setup(t);
  await ui.edit('# Original\n\n- item\n\nNative save checkpoint.');
  const saved = await ui.adapter.read(path); assert.match(saved, /Native save checkpoint/); assert.equal(ui.historyButton('Undo').disabled, false);
  const card = ui.root.querySelector('[data-node-id="a"]');
  await ui.reload(); await ui.reload();
  assert.equal(ui.historyButton('Undo').disabled, false, 'own-save watcher acknowledgement must retain history');
  assert.equal(ui.root.querySelector('[data-node-id="a"]'), card, 'identical reload must retain rich card renderer');
  const viewport = ui.root.querySelector<HTMLElement>('.zorid-canvas-viewport')!; viewport.focus(); ui.key(viewport, 'z', { metaKey: true }); await ui.workspace.flush();
  assert.equal(await ui.adapter.read(path), original); assert.equal(ui.historyButton('Redo').disabled, false);
  await ui.reload(); assert.equal(ui.historyButton('Redo').disabled, false, 'undo persistence acknowledgement must retain redo');
  ui.historyButton('Redo').click(); await ui.workspace.flush(); assert.equal(await ui.adapter.read(path), saved);
  await ui.reload(); assert.equal(ui.historyButton('Undo').disabled, false); assert.equal(ui.historyButton('Redo').disabled, true);
});

test('genuinely changed Canvas source from Vault replaces a clean view and resets incompatible local history', async t => {
  const ui = await setup(t); await ui.edit('Local saved edit'); assert.equal(ui.historyButton('Undo').disabled, false);
  const external = JSON.parse(original); external.nodes[0].text = '**External edit**'; external.nodes[0].custom = 99;
  const source = JSON.stringify(external); await ui.adapter.write(path, source); await ui.reload();
  assert.equal(ui.root.querySelector('[data-node-id="a"] strong')?.textContent, 'External edit');
  assert.equal(ui.historyButton('Undo').disabled, true); assert.equal(ui.historyButton('Redo').disabled, true);
  const viewport = ui.root.querySelector<HTMLElement>('.zorid-canvas-viewport')!; viewport.focus(); ui.key(viewport, 'z', { metaKey: true }); await ui.workspace.flush();
  assert.equal(await ui.adapter.read(path), source); assert.equal(ui.view.document.getNode('a')?.custom, 99);
});
