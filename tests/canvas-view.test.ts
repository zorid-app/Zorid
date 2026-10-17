import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { CanvasDocument } from '../src/canvas/document.ts';
import { createCanvasView, projectCanvas } from '../src/canvas/view.ts';

const node = (id: string, type = 'text', extra = {}) => ({ id, type, x: 0, y: 0, width: 180, height: 100, text: id, ...extra });
const fixture = JSON.stringify({ plugin: { keep: true }, nodes: [
  node('a'), node('b', 'file', { x: 300, file: 'Notes/B.md', subpath: '#Part' }),
  node('c', 'link', { x: 600, url: 'https://example.test/' }),
  node('g', 'group', { x: -20, y: -20, width: 850, height: 200, label: 'Group' }),
  node('hidden', 'unknown', { config: { retain: true } }),
], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: 'Relationship' }, { id: 'orphan', fromNode: 'a', toNode: 'missing', plugin: true }] }, null, '\t');

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

function setup(source = fixture, onChange?: (source: string) => Promise<void> | void, menuHooks = false) {
  const dom = new JSDOM('<!doctype html><main></main>', { pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() { return {}; } });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const container = dom.window.document.querySelector('main')!, saves: string[] = [], files: string[] = [], links: string[] = [], errors: unknown[] = [], copies: string[] = [], newTabs: string[] = [];
  const document = CanvasDocument.parse(source);
  const view = createCanvasView(container, { document, onChange: async source => { saves.push(source); await onChange?.(source); }, openFile: (path, subpath) => { files.push(path + (subpath ?? '')); }, openLink: url => { links.push(url); }, onError: error => { errors.push(error); }, openFileInNewTab: menuHooks ? path => { newTabs.push(path); } : undefined, copyText: menuHooks ? text => { copies.push(text); } : undefined });
  const viewport = container.querySelector<HTMLElement>('.zorid-canvas-viewport')!;
  const item = (id: string) => [...container.querySelectorAll<HTMLElement>('[data-node-id]')].find(element => element.dataset.nodeId === id)!;
  const pointer = (target: Element, type: string, x: number, y: number, extra = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...extra });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } });
    target.dispatchEvent(event);
  };
  const key = (key: string, extra = {}, target: Element = viewport) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...extra }));
  let closed = false;
  const close = () => { if (closed) return; closed = true; view.destroy(); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  cleanups.push(close);
  return { dom, container, document, view, viewport, item, pointer, key, saves, files, links, errors, copies, newTabs, close };
}

const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
async function liveInput(ui: ReturnType<typeof setup>) {
  await tick();
  const content = ui.container.querySelector<HTMLElement>('.cm-content')!;
  assert.ok(content, 'the card opens the actual shared Live editor'); return content;
}
const cm = (input: HTMLElement) => EditorView.findFromDOM(input)!;
const setText = (input: HTMLElement, text: string) => cm(input).dispatch({ changes: { from: 0, to: cm(input).state.doc.length, insert: text }, annotations: Transaction.userEvent.of('input.type') });
const textOf = (input: HTMLElement) => cm(input).state.doc.toString();

test('actual DOM projects four node types and connected edges without modifying hidden records', () => {
  const ui = setup();
  assert.equal(ui.container.querySelectorAll('[data-node-id]').length, 4);
  assert.equal(ui.container.querySelectorAll('[data-edge-id]').length, 1);
  assert.match(ui.container.textContent!, /Relationship/); assert.match(ui.container.textContent!, /2 unrendered/);
  assert.equal(ui.document.toString(), fixture); assert.equal(ui.saves.length, 0);
  ui.item('b').querySelector<HTMLButtonElement>('button')!.click(); ui.item('c').querySelector<HTMLButtonElement>('button')!.click();
  assert.deepEqual(ui.files, ['Notes/B.md#Part']); assert.deepEqual(ui.links, ['https://example.test/']);
  assert.equal(ui.container.querySelector('iframe'), null); ui.close();
});

test('drag updates existing DOM and connected edge during preview, then saves one atomic transaction', async () => {
  const ui = setup(), beforeNode = ui.item('a'), edge = ui.container.querySelector('.zorid-canvas-edge-line')!, initialPath = edge.getAttribute('d');
  ui.pointer(beforeNode, 'pointerdown', 40, 40); ui.pointer(ui.viewport, 'pointermove', 90, 70);
  assert.equal(ui.item('a'), beforeNode); assert.equal(beforeNode.style.left, '50px'); assert.notEqual(edge.getAttribute('d'), initialPath);
  assert.equal(ui.document.toString(), fixture); assert.equal(ui.saves.length, 0);
  ui.pointer(ui.viewport, 'pointerup', 90, 70); await ui.view.flush();
  assert.equal(ui.document.getNode('a')!.x, 50); assert.equal(ui.document.getNode('a')!.y, 30); assert.equal(ui.saves.length, 1);
  assert.equal(ui.document.getEdge('orphan')!.plugin, true); assert.equal(ui.document.getNode('hidden')!.type, 'unknown');
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), fixture); assert.equal(ui.saves[1], fixture);
  ui.view.redo(); await ui.view.flush(); assert.equal(ui.document.getNode('a')!.x, 50); assert.equal(ui.saves.length, 3); ui.close();
});

test('selection deletion removes incident edges together and keyboard undo restores exact source', async () => {
  const ui = setup(); ui.pointer(ui.item('a'), 'pointerdown', 40, 40); ui.pointer(ui.viewport, 'pointerup', 40, 40);
  ui.key('Delete'); await ui.view.flush(); assert.equal(ui.document.getNode('a'), undefined); assert.deepEqual(ui.document.edges, []);
  assert.equal(ui.document.getNode('hidden')?.type, 'unknown'); assert.equal(ui.saves.length, 1);
  ui.key('z', { ctrlKey: true }); await ui.view.flush(); assert.equal(ui.document.toString(), fixture);
  ui.key('z', { ctrlKey: true, shiftKey: true }); await ui.view.flush(); assert.equal(ui.document.getNode('a'), undefined); ui.close();
});

test('pointer cancellation rolls back preview without saving; multiple selection moves together', async () => {
  const ui = setup(); ui.pointer(ui.item('a'), 'pointerdown', 40, 40); ui.pointer(ui.viewport, 'pointermove', 60, 70); ui.pointer(ui.viewport, 'pointercancel', 60, 70);
  assert.equal(ui.item('a').style.left, '0px'); assert.equal(ui.document.toString(), fixture); assert.equal(ui.saves.length, 0);
  ui.pointer(ui.item('b'), 'pointerdown', 340, 40, { shiftKey: true }); ui.pointer(ui.viewport, 'pointermove', 360, 60); ui.pointer(ui.viewport, 'pointerup', 360, 60); await ui.view.flush();
  assert.equal(ui.document.getNode('a')!.x, 20); assert.equal(ui.document.getNode('b')!.x, 320); assert.equal(ui.saves.length, 1); ui.close();
});

test('pan and zoom are view-only and zoom-scaled drag writes document coordinates', async () => {
  const ui = setup(), world = ui.container.querySelector<HTMLElement>('.zorid-canvas-world')!;
  ui.viewport.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -300, ctrlKey: true }));
  assert.equal(ui.viewport.dataset.zoom, '2');
  ui.pointer(ui.viewport, 'pointerdown', 0, 0, { button: 1 }); ui.pointer(ui.viewport, 'pointermove', 50, 20); ui.pointer(ui.viewport, 'pointerup', 50, 20);
  assert.match(world.style.transform, /scale\(2\)/); assert.equal(ui.document.toString(), fixture);
  ui.pointer(ui.item('a'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 40, 20); ui.pointer(ui.viewport, 'pointerup', 40, 20); await ui.view.flush();
  assert.equal(ui.document.getNode('a')!.x, 20); assert.equal(ui.document.getNode('a')!.y, 10); ui.close();
});

test('text editing handles literal HTML, protects delete/undo from canvas shortcuts and saves on commit', async () => {
  const ui = setup(); ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = await liveInput(ui); assert.ok(input);
  setText(input, '<img src=x onerror=alert(1)>\nnew'); cm(input).dispatch({ selection: { anchor: cm(input).state.doc.length } }); ui.key('Delete', {}, input); assert.ok(ui.document.getNode('a'));
  ui.key('Enter', { ctrlKey: true }, input); await ui.view.flush();
  assert.equal(ui.document.getNode('a')!.text, '<img src=x onerror=alert(1)>\nnew'); assert.equal(ui.item('a').querySelector('img'), null);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), fixture); ui.close();
});

test('duplicate IDs project to one item while untouched records survive edits and undo', async () => {
  const source = JSON.stringify({ nodes: [node('same'), node('same', 'text', { x: 20, text: 'last', unknown: true }), node('hidden', 'plugin')], edges: [{ id: 'e', fromNode: 'same', toNode: 'absent' }] });
  const ui = setup(source); assert.equal(projectCanvas(ui.document).nodes.size, 1); assert.equal(ui.item('same').textContent, 'last');
  ui.pointer(ui.item('same'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 10, 0); ui.pointer(ui.viewport, 'pointerup', 10, 0); await ui.view.flush();
  assert.equal(ui.document.nodes.length, 3); assert.equal(ui.document.nodes[0].x, 0); assert.equal(ui.document.nodes[1].x, 30); assert.equal(ui.document.nodes[1].unknown, true); assert.equal(ui.document.edges.length, 1);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), source); ui.close();
});

test('async saves are ordered and failures remain visible without dropping subsequent changes', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const ui = setup(fixture, async () => { calls++; if (calls === 1) { await gate; throw new Error('disk unavailable'); } });
  ui.pointer(ui.item('a'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 10, 0); ui.pointer(ui.viewport, 'pointerup', 10, 0);
  ui.view.undo(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  release(); await ui.view.flush(); assert.equal(calls, 2); assert.equal(ui.saves[1], fixture); assert.equal(ui.errors.length, 1);
  assert.match(ui.container.textContent!, /disk unavailable/); ui.close();
});

test('external reload resets history and destroy removes surface and pending drag', () => {
  const ui = setup(); ui.view.setDocument(CanvasDocument.parse('{"nodes":[],"edges":[]}'));
  assert.equal(ui.container.querySelectorAll('[data-node-id]').length, 0);
  ui.view.undo(); assert.equal(ui.view.document.nodes.length, 0);
  ui.view.destroy(); assert.equal(ui.container.children.length, 0); ui.close();
});

test('edge-only selection deletion preserves all nodes and unrelated dangling data', async () => {
  const ui = setup(); const path = ui.container.querySelector('[data-edge-id="ab"] path')!;
  ui.pointer(path, 'pointerdown', 220, 50); ui.key('Delete'); await ui.view.flush();
  assert.equal(ui.document.nodes.length, 5); assert.equal(ui.document.getEdge('ab'), undefined); assert.ok(ui.document.getEdge('orphan'));
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), fixture); ui.close();
});

test('background box selection and empty Delete use real event handlers without accidental writes', async () => {
  const ui = setup(); ui.viewport.focus(); ui.key('Delete'); await ui.view.flush(); assert.equal(ui.saves.length, 0);
  ui.pointer(ui.viewport, 'pointerdown', 45, 45); ui.pointer(ui.viewport, 'pointermove', 60, 60); ui.pointer(ui.viewport, 'pointerup', 60, 60);
  assert.equal(ui.item('a').classList.contains('is-selected'), true); assert.equal(ui.item('b').classList.contains('is-selected'), false);
  assert.equal(ui.saves.length, 0); ui.key('Escape'); assert.equal(ui.item('a').classList.contains('is-selected'), false); ui.close();
});

test('add card and blur preserve empty canvas history; Escape leaves Live editing after saving', async () => {
  const ui = setup('');
  ui.container.querySelector<HTMLButtonElement>('[aria-label="Add card"]')!.click();
  const input = await liveInput(ui); setText(input, 'New card'); input.blur(); await ui.view.flush();
  assert.equal(ui.document.nodes.length, 1); assert.equal(ui.document.nodes[0].text, 'New card');
  ui.item(ui.document.nodes[0].id).dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const second = await liveInput(ui); setText(second, 'Saved on Escape'); ui.key('Escape', {}, second); await ui.view.flush();
  assert.equal(ui.document.nodes[0].text, 'Saved on Escape');
  ui.view.undo(); ui.view.undo(); ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), ''); ui.close();
});

test('flush commits active text and waits for its write before teardown without a late blur write', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const ui = setup(fixture, () => gate);
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = await liveInput(ui); setText(input, 'Valuable pending text');
  let settled = false; const flushing = ui.view.flush().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.document.getNode('a')!.text, 'Valuable pending text'); assert.equal(ui.saves.length, 1); assert.equal(settled, false);
  assert.equal(JSON.parse(ui.saves[0]).nodes[0].text, 'Valuable pending text');
  release(); await flushing; ui.view.destroy(); input.dispatchEvent(new ui.dom.window.FocusEvent('focusout', { bubbles: true }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ui.saves.length, 1); ui.close();
});

test('flush rejects failed persistence, retains current source and retries once for concurrent later flushes', async () => {
  let failing = true;
  const ui = setup(fixture, async () => { if (failing) throw new Error('disk unavailable'); });
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  setText(await liveInput(ui), 'Retain unsaved content');
  await assert.rejects(ui.view.flush(), /disk unavailable/);
  const unsaved = ui.document.toString(); assert.equal(ui.document.getNode('a')!.text, 'Retain unsaved content');
  assert.equal(ui.container.querySelectorAll('[data-node-id]').length, 4); assert.match(ui.container.textContent!, /disk unavailable/);
  await assert.rejects(ui.view.flush(), /disk unavailable/); assert.equal(ui.saves.length, 2); assert.equal(ui.document.toString(), unsaved);
  failing = false; await Promise.all([ui.view.flush(), ui.view.flush()]);
  assert.equal(ui.saves.length, 3); assert.equal(ui.saves[2], unsaved);
  await ui.view.flush(); assert.equal(ui.saves.length, 3); ui.close();
});

test('later edits recover a failed save queue without a duplicate retry of older content', async () => {
  let failing = true;
  const ui = setup(fixture, async () => { if (failing) throw new Error('initial failure'); });
  ui.pointer(ui.item('a'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 10, 0); ui.pointer(ui.viewport, 'pointerup', 10, 0);
  await assert.rejects(ui.view.flush(), /initial failure/); failing = false;
  ui.pointer(ui.item('a'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 20, 0); ui.pointer(ui.viewport, 'pointerup', 20, 0);
  await ui.view.flush(); assert.equal(ui.saves.length, 2); assert.equal(JSON.parse(ui.saves[1]).nodes[0].x, 30); ui.close();
});

test('retained controls and editor handlers cannot mutate, open or save after destroy', async () => {
  const ui = setup(), add = ui.container.querySelector<HTMLButtonElement>('[aria-label="Add card"]')!, open = ui.item('b').querySelector<HTMLButtonElement>('button')!, card = ui.item('a');
  card.dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = await liveInput(ui);
  ui.view.destroy(); add.click(); open.click(); input.dispatchEvent(new ui.dom.window.FocusEvent('focusout', { bubbles: true }));
  ui.key('Enter', { ctrlKey: true }, input); ui.pointer(card, 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 10, 0); ui.pointer(ui.viewport, 'pointerup', 10, 0);
  await ui.view.flush(); assert.equal(ui.document.toString(), fixture); assert.equal(ui.saves.length, 0); assert.equal(ui.files.length, 0); ui.close();
});

test('pending changes tracks edited drafts, queued writes and failures until successful retry', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let failing = true;
  const ui = setup(fixture, async () => { await gate; if (failing) throw new Error('pending save failed'); });
  assert.equal(ui.view.hasPendingChanges(), false);
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = await liveInput(ui);
  assert.equal(ui.view.hasPendingChanges(), false); setText(input, 'draft'); assert.equal(ui.view.hasPendingChanges(), true);
  setText(input, 'a'); assert.equal(ui.view.hasPendingChanges(), true, 'accepted input is queued even when it returns to saved text'); setText(input, 'draft');
  const flushing = ui.view.flush(); assert.equal(ui.container.querySelector('textarea'), null); assert.equal(ui.view.hasPendingChanges(), true);
  const rejected = assert.rejects(flushing, /pending save failed/); release(); await rejected;
  assert.equal(ui.view.hasPendingChanges(), true);
  failing = false; const retry = ui.view.flush(); assert.equal(ui.view.hasPendingChanges(), true); await retry;
  assert.equal(ui.view.hasPendingChanges(), false); assert.equal(ui.document.getNode('a')!.text, 'draft');
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const next = await liveInput(ui); setText(next, 'cancel'); assert.equal(ui.view.hasPendingChanges(), true);
  ui.key('Escape', {}, next); await ui.view.flush(); await tick(); assert.equal(ui.view.hasPendingChanges(), false); assert.equal(ui.document.getNode('a')!.text, 'cancel'); ui.close();
});

function menuDriver(ui: ReturnType<typeof setup>) {
  const requests: { items: { id?: string; label?: string; type?: string }[] }[] = [];
  const resolvers: ((id: string | null) => void)[] = [];
  Object.defineProperty(ui.dom.window, 'zorid', { value: { showContextMenu: (request: typeof requests[number]) => { requests.push(request); return new Promise<string | null>(resolve => resolvers.push(resolve)); } } });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    requests,
    async open(target: Element, x = 50, y = 50) {
      const event = new ui.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }); target.dispatchEvent(event); await settle(); return event;
    },
    async choose(id: string | null, index = resolvers.length - 1) { resolvers[index](id); await settle(); },
    labels: () => requests.at(-1)!.items.map(item => item.type === 'separator' ? '---' : item.label),
  };
}

test('browser background menu preserves creation order and creates a card at the document pointer position', async () => {
  const ui = setup();
  ui.viewport.dispatchEvent(new ui.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 190 }));
  await new Promise(resolve => setImmediate(resolve));
  const menu = ui.dom.window.document.querySelector('[role="menu"]')!; assert.ok(menu);
  assert.deepEqual([...menu.querySelectorAll('button')].map(button => button.textContent), ['Add card', 'Add web page', 'Create group']);
  menu.querySelector<HTMLButtonElement>('button')!.click(); await new Promise(resolve => setImmediate(resolve));
  const added = ui.document.nodes.at(-1)!; assert.equal(added.x, 100); assert.equal(added.y, 150); assert.equal(added.type, 'text');
  const input = await liveInput(ui); setText(input, 'Menu card'); await ui.view.flush();
  assert.equal(ui.document.nodes.at(-1)!.text, 'Menu card'); ui.view.undo(); ui.view.undo(); await ui.view.flush();
  assert.equal(ui.document.toString(), fixture); ui.close();
});

test('single-node menus use ordered type actions and conditionally expose host capabilities', async () => {
  const ui = setup(fixture, undefined, true), menu = menuDriver(ui);
  await menu.open(ui.item('a')); assert.deepEqual(menu.labels(), ['Zoom to selection', 'Edit', '---', 'Remove']); await menu.choose(null);
  await menu.open(ui.item('g')); assert.deepEqual(menu.labels(), ['Zoom to selection', 'Edit label', '---', 'Remove']); await menu.choose('edit-label');
  ui.container.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Renamed group'; await ui.view.flush(); assert.equal(ui.document.getNode('g')!.label, 'Renamed group');
  await menu.open(ui.item('b')); assert.deepEqual(menu.labels(), ['Zoom to selection', '---', 'Open in new tab', '---', 'Remove']); await menu.choose('open-new-tab'); assert.deepEqual(ui.newTabs, ['Notes/B.md']);
  await menu.open(ui.item('c')); assert.deepEqual(menu.labels(), ['Zoom to selection', 'Change URL...', 'Open external link', 'Copy URL', '---', 'Remove']); await menu.choose('copy-url'); assert.deepEqual(ui.copies, ['https://example.test/']);
  await menu.open(ui.item('c')); await menu.choose('open-link'); assert.deepEqual(ui.links, ['https://example.test/']); ui.close();
  const limited = setup(), limitedMenu = menuDriver(limited);
  await limitedMenu.open(limited.item('b')); assert.deepEqual(limitedMenu.labels(), ['Zoom to selection', '---', 'Remove']); await limitedMenu.choose(null);
  await limitedMenu.open(limited.item('c')); assert.equal(limitedMenu.labels().includes('Copy URL'), false); await limitedMenu.choose(null); limited.close();
});

test('node menu remove deletes incident edges atomically and background undo restores original bytes', async () => {
  const ui = setup(), menu = menuDriver(ui);
  await menu.open(ui.item('a')); await menu.choose('remove'); await ui.view.flush();
  assert.equal(ui.document.getNode('a'), undefined); assert.deepEqual(ui.document.edges, []); assert.ok(ui.document.getNode('hidden'));
  await menu.open(ui.viewport); assert.deepEqual(menu.labels(), ['Add card', 'Add web page', 'Create group', '---', 'Undo']); await menu.choose('undo'); await ui.view.flush();
  assert.equal(ui.document.toString(), fixture);
  await menu.open(ui.viewport); assert.deepEqual(menu.labels(), ['Add card', 'Add web page', 'Create group', '---', 'Redo']); await menu.choose(null); ui.close();
});

test('edge menu label edits retain metadata and follow connection changes only the viewport', async () => {
  const ui = setup(), menu = menuDriver(ui), edge = () => ui.container.querySelector('[data-edge-id="ab"] path')!;
  await menu.open(edge(), 220, 90); assert.deepEqual(menu.labels(), ['Edit label', 'Follow connection', '---', 'Remove']); await menu.choose('edit-label');
  const input = ui.container.querySelector<HTMLTextAreaElement>('textarea')!; assert.equal(input.getAttribute('aria-label'), 'Edit connection label'); input.value = 'Changed connection'; await ui.view.flush();
  assert.equal(ui.document.getEdge('ab')!.label, 'Changed connection'); assert.equal(ui.document.getEdge('orphan')!.plugin, true);
  const source = ui.document.toString(), writes = ui.saves.length; await menu.open(edge(), 220, 90); await menu.choose('follow-connection'); await ui.view.flush();
  assert.equal(ui.document.toString(), source); assert.equal(ui.saves.length, writes); assert.notEqual(ui.container.querySelector<HTMLElement>('.zorid-canvas-world')!.style.transform, 'translate(40px, 40px) scale(1)');
  await menu.open(edge()); await menu.choose('remove'); await ui.view.flush(); assert.equal(ui.document.getEdge('ab'), undefined); assert.ok(ui.document.getNode('a')); ui.close();
});

test('selected-node context retains multiselection and creates a padded group or deletes the full selection', async () => {
  const ui = setup(), menu = menuDriver(ui);
  ui.pointer(ui.item('a'), 'pointerdown', 40, 40); ui.pointer(ui.viewport, 'pointerup', 40, 40);
  ui.pointer(ui.item('b'), 'pointerdown', 340, 40, { shiftKey: true }); ui.pointer(ui.viewport, 'pointerup', 340, 40);
  await menu.open(ui.item('a')); assert.deepEqual(menu.labels(), ['Zoom to selection', 'Create group', '---', 'Delete']); await menu.choose('create-group'); await ui.view.flush();
  const group = ui.document.nodes.at(-1)!; assert.deepEqual([group.type, group.x, group.y, group.width, group.height], ['group', -20, -20, 520, 140]);
  ui.view.undo(); await ui.view.flush();
  ui.pointer(ui.item('a'), 'pointerdown', 40, 40); ui.pointer(ui.viewport, 'pointerup', 40, 40);
  ui.pointer(ui.item('b'), 'pointerdown', 340, 40, { shiftKey: true }); ui.pointer(ui.viewport, 'pointerup', 340, 40);
  await menu.open(ui.item('b')); await menu.choose('delete'); await ui.view.flush(); assert.equal(ui.document.getNode('a'), undefined); assert.equal(ui.document.getNode('b'), undefined);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), fixture); ui.close();
});

test('web page menu edits and creation use literal URLs without opening or fetching content', async () => {
  const ui = setup(), menu = menuDriver(ui);
  await menu.open(ui.item('c')); await menu.choose('change-url'); ui.container.querySelector<HTMLTextAreaElement>('textarea')!.value = 'https://other.test/a#b'; await ui.view.flush();
  assert.equal(ui.document.getNode('c')!.url, 'https://other.test/a#b'); assert.deepEqual(ui.links, []);
  await menu.open(ui.viewport, 240, 140); await menu.choose('add-web-page'); ui.container.querySelector<HTMLTextAreaElement>('textarea')!.value = 'https://new.test/'; await ui.view.flush();
  const link = ui.document.nodes.at(-1)!; assert.deepEqual([link.type, link.x, link.y, link.url], ['link', 200, 100, 'https://new.test/']); assert.equal(ui.container.querySelector('iframe'), null); ui.close();
});

test('pending menu actions reject changed source, changed selection, replacement documents and destroyed owners', async () => {
  for (const invalidation of ['source', 'selection', 'replace', 'destroy'] as const) {
    const ui = setup(), menu = menuDriver(ui); await menu.open(ui.item('a'));
    if (invalidation === 'source') ui.document.updateNode('a', { text: 'External' });
    if (invalidation === 'selection') { ui.pointer(ui.item('b'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointerup', 0, 0); }
    if (invalidation === 'replace') ui.view.setDocument(CanvasDocument.parse(fixture));
    if (invalidation === 'destroy') ui.view.destroy();
    await menu.choose('remove'); assert.ok(ui.document.getNode('a'), invalidation); assert.equal(ui.saves.length, 0); ui.close();
  }
});

test('shared Live editor owns its context menu and saves text before opening a different Canvas menu', async () => {
  const ui = setup(), menu = menuDriver(ui);
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = await liveInput(ui); setText(input, 'Pending menu text');
  const native = await menu.open(input); assert.equal(native.defaultPrevented, true); assert.equal(menu.requests.length, 1); assert.ok(menu.requests[0].items.some(item => item.id === 'select-all')); assert.ok(!menu.requests[0].items.some(item => item.id === 'remove')); await menu.choose(null); assert.equal(ui.document.getNode('a')!.text, 'Pending menu text');
  await menu.open(ui.item('b')); assert.equal(ui.document.getNode('a')!.text, 'Pending menu text'); assert.equal(ui.saves.length, 1); await menu.choose('remove'); await ui.view.flush();
  assert.equal(ui.document.getNode('a')!.text, 'Pending menu text'); assert.equal(ui.document.getNode('b'), undefined); ui.close();
});

test('save failure blocks the menu without discarding pending text; editor opened while menu waits invalidates action', async () => {
  const failing = setup(fixture, () => { throw new Error('menu save failure'); }), blocked = menuDriver(failing);
  failing.item('a').dispatchEvent(new failing.dom.window.MouseEvent('dblclick', { bubbles: true }));
  setText(await liveInput(failing), 'Retain me');
  await blocked.open(failing.item('b')); assert.equal(blocked.requests.length, 0); assert.equal(failing.document.getNode('a')!.text, 'Retain me'); assert.equal(failing.view.hasPendingChanges(), true); failing.close();
  const ui = setup(), menu = menuDriver(ui); await menu.open(ui.item('a'));
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); const input = await liveInput(ui); setText(input, 'New draft');
  await menu.choose('remove'); assert.ok(ui.document.getNode('a')); assert.equal(textOf(input), 'New draft'); await ui.view.flush(); assert.equal(ui.document.getNode('a')!.text, 'New draft'); ui.close();
});

test('source changes while awaiting an earlier save cancel menu presentation', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const ui = setup(fixture, () => gate), menu = menuDriver(ui);
  ui.pointer(ui.item('a'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 10, 0); ui.pointer(ui.viewport, 'pointerup', 10, 0);
  const opening = menu.open(ui.item('a')); await new Promise(resolve => setImmediate(resolve));
  ui.document.updateNode('a', { text: 'External while saving' }); release(); await opening; await new Promise(resolve => setImmediate(resolve));
  assert.equal(menu.requests.length, 0); assert.equal(ui.document.getNode('a')!.text, 'External while saving'); ui.close();
});

test('menu transport rejection reports the failure without modifying the document', async () => {
  const ui = setup(); Object.defineProperty(ui.dom.window, 'zorid', { value: { showContextMenu: () => Promise.reject(new Error('menu unavailable')) } });
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ui.document.toString(), fixture); assert.equal(ui.saves.length, 0);
  assert.match(ui.container.textContent!, /menu unavailable/); assert.equal(ui.errors.length, 1); ui.close();
});

test('web page creation selects its new node and label edits follow an unchanged record after array insertion', async () => {
  const ui = setup(), menu = menuDriver(ui);
  await menu.open(ui.viewport); await menu.choose('add-web-page'); ui.container.querySelector<HTMLTextAreaElement>('textarea')!.value = 'https://selected.test/'; await ui.view.flush();
  const link = ui.document.nodes.at(-1)!; assert.equal(ui.item(link.id).classList.contains('is-selected'), true);
  await menu.open(ui.container.querySelector('[data-edge-id="ab"] path')!); await menu.choose('edit-label');
  ui.container.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Changed original';
  ui.document.setRoot('edges', [{ id: 'fresh', fromNode: 'a', toNode: 'b', label: 'Keep' }, ...ui.document.edges]); await ui.view.flush();
  assert.equal(ui.document.getEdge('fresh')!.label, 'Keep'); assert.equal(ui.document.getEdge('ab')!.label, 'Changed original'); ui.close();
});

test('changed editor target retains its draft and makes flush reject instead of overwriting another record', async () => {
  const ui = setup(), menu = menuDriver(ui);
  await menu.open(ui.container.querySelector('[data-edge-id="ab"] path')!); await menu.choose('edit-label');
  const input = ui.container.querySelector<HTMLTextAreaElement>('textarea')!; input.value = 'Valuable draft';
  ui.document.updateEdge('ab', { label: 'External revision' });
  await assert.rejects(ui.view.flush(), /changed while editing/);
  assert.equal(ui.document.getEdge('ab')!.label, 'External revision'); assert.equal(input.value, 'Valuable draft'); assert.equal(ui.view.hasPendingChanges(), true); assert.equal(ui.saves.length, 0);
  const source = ui.document.toString(); ui.container.querySelector<HTMLButtonElement>('[aria-label="Add card"]')!.click();
  assert.equal(ui.document.toString(), source); assert.equal(input.isConnected, true); assert.equal(input.value, 'Valuable draft');
  ui.key('Escape', {}, input); await ui.view.flush(); assert.equal(ui.view.hasPendingChanges(), false); ui.close();
});

test('icon controls preserve ordered groups and create a centered default card in document coordinates', async () => {
  const ui = setup();
  Object.defineProperties(ui.viewport, { clientWidth: { value: 1000 }, clientHeight: { value: 700 } });
  const groups = [...ui.container.querySelectorAll('.zorid-canvas-control-group')];
  assert.deepEqual(groups.map(group => [...group.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))), [['Zoom in', 'Reset zoom', 'Fit canvas', 'Zoom out'], ['Undo', 'Redo']]);
  for (const button of ui.container.querySelectorAll('.zorid-canvas-toolbar button, .zorid-canvas-card-menu button')) {
    assert.equal(button.textContent, ''); assert.equal(button.querySelectorAll('svg').length, 1); assert.equal(button.querySelector('svg')!.ownerDocument, ui.dom.window.document);
  }
  ui.container.querySelector<HTMLButtonElement>('[aria-label="Add card"]')!.click();
  const card = ui.document.nodes.at(-1)!; assert.deepEqual([card.x, card.y, card.width, card.height], [335, 280, 250, 60]);
  assert.equal(ui.item(card.id).classList.contains('is-selected'), true); const input = await liveInput(ui); assert.ok(ui.dom.window.document.activeElement === input, 'new card focuses the shared Live editor');
  await ui.view.flush(); ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), fixture); ui.close();
});

test('dot grid stays screen sized and changes spacing with zoom without writing the document', () => {
  const ui = setup(), pattern = ui.container.querySelector('pattern')!, circle = pattern.querySelector('circle')!;
  const wheel = (deltaY: number) => ui.viewport.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY }));
  assert.equal(pattern.getAttribute('width'), '20');
  for (const [delta, zoom, spacing] of [[300, .5, 20], [300, .25, 10], [300, .125, 10], [300, .0625, 10], [300, .0625, 10]]) {
    wheel(delta); assert.equal(Number(ui.viewport.dataset.zoom), zoom); assert.equal(Number(pattern.getAttribute('width')), spacing); assert.equal(circle.getAttribute('r'), '.7');
  }
  assert.equal(ui.view.element.style.getPropertyValue('--zc-zoom-compensation'), '4'); assert.equal(ui.view.element.classList.contains('is-zoomed-out'), true);
  ui.container.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')!.click(); assert.equal(ui.viewport.dataset.zoom, '1'); assert.equal(pattern.getAttribute('width'), '20');
  ui.pointer(ui.viewport, 'pointerdown', 0, 0, { button: 1 }); ui.pointer(ui.viewport, 'pointermove', 13, 7);
  assert.equal(pattern.getAttribute('x'), '13'); assert.equal(pattern.getAttribute('y'), '7'); assert.equal(ui.viewport.classList.contains('is-panning'), true);
  ui.pointer(ui.viewport, 'pointerup', 13, 7); assert.equal(ui.viewport.classList.contains('is-panning'), false);
  assert.equal(ui.document.toString(), fixture); assert.equal(ui.saves.length, 0); ui.close();
});

test('connection paths, arrowheads and HTML labels follow the same geometry during drag', async () => {
  const source = JSON.stringify({ nodes: [node('a'), node('b', 'text', { x: 300 })], edges: [{ id: 'e', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', fromEnd: 'arrow', toEnd: 'arrow', color: '5', label: 'Two\nlines' }] });
  const ui = setup(source), group = ui.container.querySelector<SVGGElement>('[data-edge-id="e"]')!, display = group.querySelector('.zorid-canvas-edge-line')!, hit = group.querySelector('.zorid-canvas-edge-hit')!, label = ui.container.querySelector<HTMLElement>('[data-edge-label-id="e"]')!;
  assert.equal(display.getAttribute('d'), 'M 187 50 C 257 50 223 50 293 50'); assert.equal(hit.getAttribute('d'), display.getAttribute('d'));
  assert.deepEqual([...group.querySelectorAll('[data-end]')].map(arrow => arrow.getAttribute('transform')), ['translate(180 50) rotate(270)', 'translate(300 50) rotate(90)']);
  assert.equal(group.style.getPropertyValue('--canvas-edge-color'), 'var(--zc-color-5)'); assert.equal(label.textContent, 'Two\nlines'); assert.equal(label.style.left, '240px'); assert.equal(label.style.top, '50px');
  ui.pointer(ui.item('a'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 20, 20);
  assert.equal(ui.container.querySelector('[data-edge-label-id="e"]'), label); assert.equal(label.style.top, '60px'); assert.equal(hit.getAttribute('d'), display.getAttribute('d'));
  assert.equal(ui.item('a').classList.contains('is-dragging'), true); ui.pointer(ui.viewport, 'pointercancel', 20, 20);
  assert.equal(label.style.top, '50px'); assert.equal(ui.item('a').classList.contains('is-dragging'), false);
  ui.pointer(label, 'pointerdown', 0, 0); assert.equal(group.classList.contains('is-selected'), true); ui.key('Delete'); await ui.view.flush(); assert.equal(ui.document.edges.length, 0);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), source); ui.close();
});

test('group and file captions remain outside clipped frames and invalid colors remain inert source data', () => {
  const source = JSON.stringify({ nodes: [node('g', 'group', { label: 'Section', color: '#aabbcc' }), node('f', 'file', { file: 'Notes/Example.md', subpath: '#Part' }), node('bad', 'text', { color: '#12345' })], edges: [] });
  const ui = setup(source), group = ui.item('g'), file = ui.item('f');
  assert.equal(group.querySelector('.zorid-canvas-group-label')!.parentElement, group);
  assert.equal(file.querySelector('.zorid-canvas-node-label')!.parentElement, file); assert.equal(file.querySelector('.zorid-canvas-node-label')!.textContent, 'Example › Part');
  assert.equal(group.classList.contains('is-themed'), true); assert.equal(ui.item('bad').classList.contains('is-themed'), false);
  assert.equal(group.querySelector<HTMLElement>('.zorid-canvas-group-label')!.style.getPropertyValue('--zc-label-foreground'), 'var(--text-on-accent-inverted, #000)');
  assert.equal(ui.document.toString(), source); assert.equal(ui.saves.length, 0); ui.close();
});

test('source reordering before opening a projected card cannot redirect its text edit or later drag', async () => {
  const ui = setup();
  ui.document.setRoot('nodes', [node('fresh', 'text', { text: 'Keep', x: 1000 }), ...ui.document.nodes]);
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  setText(await liveInput(ui), 'Edit a'); await ui.view.flush();
  assert.equal(ui.document.getNode('a')!.text, 'Edit a'); assert.equal(ui.document.getNode('fresh')!.text, 'Keep');
  ui.document.setRoot('nodes', [node('another', 'text', { x: 2000 }), ...ui.document.nodes]);
  ui.pointer(ui.item('a'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 20, 30); ui.pointer(ui.viewport, 'pointerup', 20, 30); await ui.view.flush();
  assert.equal(ui.document.getNode('a')!.x, 20); assert.equal(ui.document.getNode('a')!.y, 30); assert.equal(ui.document.getNode('fresh')!.x, 1000); assert.equal(ui.document.getNode('another')!.x, 2000); ui.close();
});

test('changed projected card rejects edits and drag without overwriting current source', async () => {
  const ui = setup(); ui.document.updateNode('a', { text: 'Current source' });
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = await liveInput(ui); setText(input, 'Old view draft');
  await assert.rejects(ui.view.flush(), /changed while editing/); assert.equal(input.isConnected, true); assert.equal(ui.document.getNode('a')!.text, 'Current source');
  ui.key('Escape', {}, input);
  ui.pointer(ui.item('a'), 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 20, 30); ui.pointer(ui.viewport, 'pointerup', 20, 30);
  assert.equal(ui.document.getNode('a')!.x, 0); assert.equal(ui.item('a').style.left, '0px'); assert.equal(ui.saves.length, 0); ui.close();
});

test('identical source acknowledgements preserve the Live editor and drag ownership; genuinely changed source resets history', async () => {
  const ui = setup(), originalCard = ui.item('a');
  originalCard.dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = await liveInput(ui); setText(input, 'Accepted live edit'); await ui.view.flush();
  const originalDocument = ui.view.document, accepted = ui.document.toString();
  ui.view.setDocument(CanvasDocument.parse(accepted));
  assert.equal(ui.view.document, originalDocument); assert.equal(ui.item('a'), originalCard); assert.equal(ui.container.querySelector('.cm-content'), input);
  assert.equal(textOf(input), 'Accepted live edit'); assert.equal(ui.view.hasPendingChanges(), false); assert.equal(ui.saves.length, 1);
  ui.key('Escape', {}, input); await tick();
  ui.pointer(originalCard, 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 25, 10);
  ui.view.setDocument(CanvasDocument.parse(accepted)); assert.equal(ui.item('a'), originalCard); assert.equal(originalCard.style.left, '25px');
  ui.pointer(ui.viewport, 'pointerup', 25, 10); await ui.view.flush(); assert.equal(ui.document.getNode('a')?.x, 25); assert.equal(ui.saves.length, 2);
  const changed = CanvasDocument.parse(ui.document.toString()); changed.setRoot('plugin', { externallyChanged: true });
  ui.view.setDocument(changed); assert.equal(ui.view.document, changed); assert.notEqual(ui.item('a'), originalCard);
  assert.equal(ui.container.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.disabled, true);
  ui.view.undo(); await ui.view.flush(); assert.deepEqual(ui.view.document.getRoot('plugin'), { externallyChanged: true }); assert.equal(ui.saves.length, 2); ui.close();
});

test('reload of an externally mutated model refreshes its stale projection even when model strings match', async () => {
  const ui = setup(), oldCard = ui.item('a');
  ui.document.updateNode('a', { text: '**External rendered change**' });
  assert.equal(oldCard.textContent, 'a');
  const replacement = CanvasDocument.parse(ui.document.toString());
  ui.view.setDocument(replacement);
  assert.equal(ui.view.document, replacement); assert.notEqual(ui.item('a'), oldCard);
  assert.equal(ui.item('a').querySelector('strong')?.textContent, 'External rendered change');
  await ui.view.flush(); assert.equal(ui.saves.length, 0); ui.close();
});
