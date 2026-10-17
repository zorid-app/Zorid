import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { undo, redo, undoDepth } from '@codemirror/commands';
import { CanvasDocument } from '../src/canvas/document.ts';
import { createCanvasView } from '../src/canvas/view.ts';
import { createMediaView } from '../src/ui/media-view.ts';

function environment(t: TestContext) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://zorid.test/', pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const rect = () => ({ top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() { return {}; } });
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  t.after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  return { dom, document: dom.window.document, parent: dom.window.document.querySelector('main')! };
}
const tick = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const cm = (parent: HTMLElement) => EditorView.findFromDOM(parent.querySelector('.cm-editor')!)!;
const type = (view: EditorView, value: string) => view.dispatch({ changes: { from: view.state.doc.length, insert: value }, annotations: Transaction.userEvent.of('input.type') });
const textNode = (text = '# Card', id = 'a') => ({ id, type: 'text', text, x: 0, y: 0, width: 400, height: 300 });
function canvas(t: TestContext, nodes: object[] = [textNode()], hooks: Partial<Parameters<typeof createCanvasView>[1]> = {}) {
  const ui = environment(t), saves: string[] = [], errors: unknown[] = [];
  const model = CanvasDocument.parse(JSON.stringify({ nodes, edges: [], extra: { retained: true } }));
  const view = createCanvasView(ui.parent, { document: model, onChange: source => { saves.push(source); }, onError: error => errors.push(error), ...hooks });
  t.after(() => view.destroy());
  return { ...ui, model, view, saves, errors, card: (id = 'a') => ui.parent.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!, viewport: ui.parent.querySelector<HTMLElement>('.zorid-canvas-viewport')! };
}

test('Add card opens shared Live editor; typing saves Canvas text without replacing editor DOM and supports undo after own-save acknowledgement', async t => {
  const ui = canvas(t, []); ui.parent.querySelector<HTMLButtonElement>('[aria-label="Add card"]')!.click(); await tick();
  const editor = cm(ui.parent), id = ui.model.nodes[0].id, card = ui.card(id);
  assert.ok(editor); assert.equal(ui.parent.querySelector('textarea'), null);
  type(editor, '# New card\n\n**Bold**\n\n$x^2$\n\n```js\nconst a = 1;\n```');
  assert.equal(cm(ui.parent), editor); assert.equal(ui.card(id), card); assert.equal(ui.model.getNode(id)!.text, editor.state.doc.toString());
  await ui.view.flush(); const saved = ui.saves.at(-1)!;
  assert.equal(JSON.parse(saved).extra.retained, true); assert.equal(ui.view.hasPendingChanges(), false);
  ui.view.setDocument(CanvasDocument.parse(saved)); assert.equal(cm(ui.parent), editor); assert.equal(undoDepth(editor.state), 1);
  assert.equal(undo(editor), true); await ui.view.flush(); assert.equal(ui.model.getNode(id)!.text, '');
  assert.equal(redo(editor), true); await ui.view.flush(); assert.match(String(ui.model.getNode(id)!.text), /New card/);
});

test('double-click edits an existing text card and no-op activation preserves CRLF source bytes', async t => {
  const ui = canvas(t, [textNode('First\r\n\r\n- item\r\n')]), original = ui.model.toString();
  ui.card().dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick();
  const editor = cm(ui.parent); assert.equal(editor.state.doc.toString(), 'First\n\n- item\n');
  await ui.view.flush(); assert.equal(ui.model.toString(), original); assert.deepEqual(ui.saves, []);
  type(editor, 'More'); await ui.view.flush(); assert.match(String(ui.model.getNode('a')!.text), /More/);
});

test('text CAS detects stale mutable source, retains local CM draft and refuses replacement or save', async t => {
  const ui = canvas(t); ui.card().dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick(); const editor = cm(ui.parent);
  ui.model.setRoot('nodes', [textNode('Newer external')]); type(editor, '\nLocal draft');
  assert.equal(ui.model.getNode('a')!.text, 'Newer external'); assert.match(editor.state.doc.toString(), /Local draft/); assert.equal(ui.view.hasPendingChanges(), true);
  await assert.rejects(ui.view.flush(), /changed while editing/);
  assert.throws(() => ui.view.setDocument(CanvasDocument.parse(ui.model.toString())), /unsaved changes/);
  assert.equal(cm(ui.parent), editor); assert.equal(ui.saves.length, 0);
});

test('failed Canvas text save preserves editor and accepted text and retries without discarding a later edit', async t => {
  let failure = true; const saves: string[] = [];
  const ui = canvas(t, [textNode()], { onChange(source) { if (failure) throw new Error('Disk unavailable'); saves.push(source); } });
  ui.card().dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick(); const editor = cm(ui.parent); type(editor, '\nFirst');
  await assert.rejects(ui.view.flush(), /Disk unavailable/); assert.equal(ui.view.hasPendingChanges(), true);
  assert.throws(() => ui.view.setDocument(CanvasDocument.parse('{"nodes":[],"edges":[]}')), /unsaved changes/);
  type(editor, '\nSecond'); failure = false; await ui.view.flush(); assert.match(JSON.parse(saves.at(-1)!).nodes[0].text, /First\nSecond/); assert.equal(cm(ui.parent), editor);
});

test('text preview tasks and external snapshots share the retained editor without source writes on rendering', async t => {
  const ui = canvas(t, [textNode('- > - [ ] Task')]); assert.equal(ui.saves.length, 0);
  ui.card().querySelector<HTMLInputElement>('input')!.click(); await ui.view.flush(); assert.equal(ui.model.getNode('a')!.text, '- > - [x] Task');
  ui.card().dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick(); const editor = cm(ui.parent);
  ui.view.setDocument(CanvasDocument.parse(JSON.stringify({ nodes: [textNode('External')], edges: [] })));
  assert.equal(cm(ui.parent), editor); assert.equal(editor.state.doc.toString(), 'External'); assert.equal(ui.saves.length, 1);
});

test('Add note picker creates selected file node with one save, and stale or destroyed picker results are inert', async t => {
  let resolve!: (path: string | null) => void; const kinds: unknown[] = [];
  const ui = canvas(t, [], { chooseFile: kind => { kinds.push(kind); return new Promise(done => { resolve = done; }); } });
  const button = ui.parent.querySelector<HTMLButtonElement>('[aria-label="Add note"]')!; button.click(); resolve('Notes/Courses.md'); await tick(); await ui.view.flush();
  assert.equal(ui.model.nodes.length, 1); const node = ui.model.nodes[0]; assert.equal(node.file, 'Notes/Courses.md'); assert.equal(ui.card(node.id).classList.contains('is-selected'), true); assert.equal(ui.saves.length, 1);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.model.nodes.length, 0); ui.view.redo(); await ui.view.flush(); assert.equal(ui.model.nodes.length, 1);
  button.click(); ui.view.setDocument(CanvasDocument.parse('{"nodes":[],"edges":[]}')); resolve('Stale.md'); await tick(); assert.equal(ui.view.document.nodes.length, 0);
  ui.parent.querySelector<HTMLButtonElement>('[aria-label="Add media"]')!.click(); ui.view.destroy(); resolve('Closed.md'); await tick(); assert.equal(ui.view.document.nodes.length, 0); assert.deepEqual(kinds, ['note', 'note', 'media']);
});

test('trusted file drops insert one transaction at world coordinates and leave editor-owned drops alone', async t => {
  const transfer = { dropEffect: 'none', getData: () => '', files: [] } as unknown as DataTransfer;
  const ui = canvas(t, [], { filePathsFromDrop: value => value === transfer ? ['A.md', 'picture.png'] : [] });
  const drag = (target: Element, type: string, data = transfer) => { const event = new ui.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 140, clientY: 240 }); Object.defineProperty(event, 'dataTransfer', { value: data }); target.dispatchEvent(event); return event; };
  assert.equal(drag(ui.viewport, 'dragover').defaultPrevented, true); assert.equal(transfer.dropEffect, 'copy');
  assert.equal(drag(ui.viewport, 'drop').defaultPrevented, true); await ui.view.flush();
  assert.deepEqual(ui.model.nodes.map(node => [node.file, node.x, node.y]), [['A.md', 100, 200], ['picture.png', 124, 224]]); assert.equal(ui.saves.length, 1);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.model.nodes.length, 0);
  ui.parent.querySelector<HTMLButtonElement>('[aria-label="Add card"]')!.click(); await tick(); assert.equal(drag(cm(ui.parent).contentDOM, 'drop').defaultPrevented, false); assert.equal(ui.model.nodes.length, 1);
  assert.equal(drag(ui.viewport, 'drop', {} as DataTransfer).defaultPrevented, false);
});

test('attachment render owners survive geometry, dispose on replacement, preserve interactive viewer input and handle renderer failure', async t => {
  const ui = environment(t), owners: { path: string; element: HTMLElement; destroyed: number }[] = [], saves: string[] = [];
  const file = (path: string, x = 0) => ({ id: 'file', type: 'file', file: path, x, y: 0, width: 400, height: 400 });
  const model = CanvasDocument.parse(JSON.stringify({ nodes: [file('A.pdf')], edges: [] }));
  const view = createCanvasView(ui.parent, { document: model, onChange: source => { saves.push(source); }, renderFile(path) { if (path === 'Broken.pdf') throw new Error('Invalid PDF'); const element = ui.document.createElement('div'); element.className = 'interactive-child'; const owner = { path, element, destroyed: 0 }; owners.push(owner); return { element, destroy() { owner.destroyed++; } }; } }); t.after(() => view.destroy());
  const viewport = ui.parent.querySelector('.zorid-canvas-viewport')!;
  const event = new ui.dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }); owners[0].element.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
  view.setDocument(CanvasDocument.parse(JSON.stringify({ nodes: [file('A.pdf', 80)], edges: [] }))); assert.equal(owners.length, 1); assert.equal(owners[0].destroyed, 0);
  view.setDocument(CanvasDocument.parse(JSON.stringify({ nodes: [file('B.png')], edges: [] }))); assert.equal(owners[0].destroyed, 1); assert.equal(owners.length, 2);
  view.setDocument(CanvasDocument.parse(JSON.stringify({ nodes: [file('Broken.pdf')], edges: [] }))); assert.equal(owners[1].destroyed, 1); assert.match(ui.parent.textContent!, /Unable to display/); assert.deepEqual(saves, []);
  view.destroy(); assert.equal(owners[1].destroyed, 1); assert.equal(viewport.isConnected, false);
});

test('a held Canvas write coalesces subsequent Live typing into one latest pending snapshot', async t => {
  const writes: string[] = []; let release!: () => void;
  const ui = canvas(t, [textNode('')], { onChange(source) { writes.push(source); if (writes.length === 1) return new Promise<void>(resolve => { release = resolve; }); } });
  ui.card().dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick(); const editor = cm(ui.parent);
  type(editor, 'a'); await tick(); assert.equal(writes.length, 1);
  for (let index = 0; index < 100; index++) { type(editor, 'b'); await Promise.resolve(); }
  assert.equal(writes.length, 1); assert.equal(ui.view.hasPendingChanges(), true);
  const flushing = ui.view.flush(); release(); await flushing;
  assert.equal(writes.length, 2); assert.equal(JSON.parse(writes[1]).nodes[0].text, 'a' + 'b'.repeat(100)); assert.equal(ui.view.hasPendingChanges(), false);
});

test('rich Canvas card groups retain real textbox and checkbox semantics and describe selection independently', async t => {
  const ui = canvas(t, [textNode('# Card\n\n- [ ] Task'), textNode('Second', 'b')]);
  const first = ui.card(), second = ui.card('b');
  assert.equal(ui.viewport.getAttribute('role'), 'region'); assert.equal(ui.viewport.getAttribute('aria-label'), 'Canvas');
  for (const card of [first, second]) { assert.equal(card.getAttribute('role'), 'group'); assert.equal(card.getAttribute('aria-roledescription'), 'Canvas card'); assert.equal(card.hasAttribute('aria-selected'), false); }
  const description = (card: HTMLElement) => ui.document.getElementById(card.getAttribute('aria-describedby')!)!.textContent;
  assert.equal(description(first), 'Not selected');
  const checkbox = first.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  assert.equal(checkbox.disabled, false); assert.equal(checkbox.closest('[role="option"],[role="presentation"],[aria-hidden="true"]'), null);
  checkbox.click(); await ui.view.flush(); assert.match(String(ui.model.getNode('a')!.text), /\[x\]/);
  first.dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick();
  const editor = cm(first); assert.equal(editor.contentDOM.getAttribute('role'), 'textbox'); assert.equal(editor.contentDOM.getAttribute('aria-multiline'), 'true'); assert.equal(editor.contentDOM.closest('[role="option"],[role="presentation"],[aria-hidden="true"]'), null);
  assert.equal(description(first), 'Selected'); assert.equal(description(second), 'Not selected');
  assert.equal(ui.parent.querySelector('.zorid-canvas-selection-status')?.textContent, '1 card selected');
  type(editor, '\nWritable'); await ui.view.flush(); assert.match(String(ui.model.getNode('a')!.text), /Writable/);
  ui.viewport.focus(); ui.viewport.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })); await tick();
  assert.equal(description(first), 'Not selected'); assert.equal(ui.parent.querySelector('.zorid-canvas-selection-status')?.textContent, 'No items selected');
});

test('native media controls remain inside a named rich group without presentational ancestors', async t => {
  const ui = environment(t); let released = 0;
  ui.dom.window.HTMLMediaElement.prototype.pause = () => {}; ui.dom.window.HTMLMediaElement.prototype.load = () => {};
  const model = CanvasDocument.parse(JSON.stringify({ nodes: [{ id: 'media', type: 'file', file: 'Clip.mp4', x: 0, y: 0, width: 400, height: 300 }], edges: [] }));
  const view = createCanvasView(ui.parent, { document: model, onChange() {}, renderFile(path) {
    const element = ui.document.createElement('div'); const owner = createMediaView(element, path, { acquire: async () => ({ url: 'blob:clip', type: 'video/mp4', release() { released++; } }) });
    return { element, destroy: () => owner.destroy() };
  } }); t.after(() => view.destroy()); await tick();
  const video = ui.parent.querySelector<HTMLVideoElement>('video')!; assert.ok(video);
  Object.defineProperties(video, { videoWidth: { value: 640 }, videoHeight: { value: 360 } }); video.dispatchEvent(new ui.dom.window.Event('loadedmetadata'));
  assert.equal(video.style.height, ''); assert.equal(video.controls, true); assert.equal(video.getAttribute('aria-label'), 'Clip.mp4');
  assert.equal(video.closest('[data-node-id]')!.getAttribute('role'), 'group'); assert.equal(video.closest('[role="option"],[role="presentation"],[aria-hidden="true"]'), null);
  const pointer = new ui.dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }); video.dispatchEvent(pointer); assert.equal(pointer.defaultPrevented, false);
  view.destroy(); assert.equal(released, 1);
});
