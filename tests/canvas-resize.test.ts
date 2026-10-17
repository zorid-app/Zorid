import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { CanvasDocument } from '../src/canvas/document.ts';
import { createCanvasView } from '../src/canvas/view.ts';
import type { CanvasViewOptions } from '../src/canvas/view.ts';

const node = (id: string, extra = {}) => ({ id, type: 'text', x: 100, y: 100, width: 200, height: 100, text: id, custom: { keep: true }, ...extra });
const sourceOf = (nodes = [node('a')], edges: unknown[] = []) => JSON.stringify({ nodes, edges, custom: { bytes: 'retained' } }, null, '\t') + '\n';
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(t: TestContext, source = sourceOf(), options: Partial<CanvasViewOptions> = {}, platform = 'Linux') {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true, url: 'https://zorid.test/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window.navigator, 'platform', { value: platform });
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, toJSON() { return {}; } });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = dom.window.document.querySelector('main')!, model = CanvasDocument.parse(source), saves: string[] = [], errors: unknown[] = [];
  const view = createCanvasView(host, { document: model, onChange: value => { saves.push(value); }, onError: error => errors.push(error), ...options });
  t.after(() => { view.destroy(); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const viewport = host.querySelector<HTMLElement>('.zorid-canvas-viewport')!;
  const item = (id = 'a') => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
  const handle = (direction: string, id = 'a') => item(id).querySelector<HTMLElement>(`[data-resize="${direction}"]`)!;
  const pointer = (target: Element, type: string, x: number, y: number, extra = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...extra });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } }); target.dispatchEvent(event); return event;
  };
  const world = (target: Element, type: string, x: number, y: number, extra: MouseEventInit = { altKey: true }) => pointer(target, type, 40 + x * Number(viewport.dataset.zoom), 40 + y * Number(viewport.dataset.zoom), extra);
  const select = (id: string, additive = false) => { world(item(id), 'pointerdown', 110, 110, { shiftKey: additive }); world(viewport, 'pointerup', 110, 110); };
  return { dom, host, model, view, viewport, item, handle, pointer, world, select, saves, errors, source };
}
const bounds = (value: { x: number; y: number; width: number; height: number }) => [value.x, value.y, value.width, value.height];
const styleBounds = (value: HTMLElement) => [value.style.left, value.style.top, value.style.width, value.style.height].map(parseFloat);

for (const [direction, from, to, expected] of [
  ['top', [200, 100], [200, 70], [100, 70, 200, 130]],
  ['right', [300, 150], [340, 150], [100, 100, 240, 100]],
  ['bottom', [200, 200], [200, 230], [100, 100, 200, 130]],
  ['left', [100, 150], [60, 150], [60, 100, 240, 100]],
  ['top-left', [100, 100], [60, 70], [60, 70, 240, 130]],
  ['top-right', [300, 100], [340, 70], [100, 70, 240, 130]],
  ['bottom-right', [300, 200], [340, 230], [100, 100, 240, 130]],
  ['bottom-left', [100, 200], [60, 230], [60, 100, 240, 130]],
] as const) test(`resize ${direction} previews existing DOM, saves once and restores exact bytes with one undo`, async t => {
  const source = sourceOf([node('a'), node('b', { x: 500 })], [{ id: 'edge', fromNode: 'a', toNode: 'b' }]);
  const ui = setup(t, source), item = ui.item(), edge = ui.host.querySelector('.zorid-canvas-edge-line')!, path = edge.getAttribute('d');
  assert.equal(item.querySelectorAll('[data-resize]').length, 8);
  ui.world(ui.handle(direction), 'pointerdown', ...from); ui.world(ui.viewport, 'pointermove', ...to);
  assert.ok(ui.item() === item); assert.deepEqual(styleBounds(item), expected); assert.equal(ui.model.toString(), source); assert.equal(ui.saves.length, 0);
  assert.ok(ui.host.querySelector('.zorid-canvas-edge-line') === edge);
  if (direction.includes('right')) assert.notEqual(edge.getAttribute('d'), path);
  ui.world(ui.viewport, 'pointerup', ...to); await ui.view.flush();
  assert.deepEqual(bounds(ui.model.getNode('a')!), expected); assert.equal(ui.saves.length, 1); assert.deepEqual(ui.model.getNode('a')!.custom, { keep: true });
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.model.toString(), source); assert.equal(ui.saves.length, 2);
});

test('resize uses zoom-scaled world coordinates and a five-screen-pixel activation threshold', async t => {
  const ui = setup(t);
  ui.viewport.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -300, clientX: 40, clientY: 40 }));
  assert.equal(ui.viewport.dataset.zoom, '2');
  ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 302, 150);
  assert.deepEqual(styleBounds(ui.item()), [100, 100, 200, 100]); ui.world(ui.viewport, 'pointerup', 302, 150); await ui.view.flush(); assert.equal(ui.saves.length, 0);
  ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 330, 150); ui.world(ui.viewport, 'pointerup', 330, 150); await ui.view.flush();
  assert.deepEqual(bounds(ui.model.getNode('a')!), [100, 100, 230, 100]);
});

test('exactly five screen pixels activates resize and opposite-edge minima remain anchored', async t => {
  const ui = setup(t);
  ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 305, 150);
  assert.deepEqual(styleBounds(ui.item()), [100, 100, 205, 100]);
  ui.world(ui.viewport, 'pointerup', 305, 150); await ui.view.flush(); assert.equal(ui.saves.length, 1);
  ui.view.undo(); await ui.view.flush();
  ui.world(ui.handle('top-left'), 'pointerdown', 100, 100); ui.world(ui.viewport, 'pointermove', 290, 190);
  assert.deepEqual(styleBounds(ui.item()), [250, 150, 50, 50]);
  ui.world(ui.viewport, 'pointerup', 290, 190); await ui.view.flush(); assert.deepEqual(bounds(ui.model.getNode('a')!), [250, 150, 50, 50]);
});

for (const reason of ['pointercancel', 'lostpointercapture', 'Escape', 'windowblur']) test(`${reason} cancels resize preview without changing source or history`, async t => {
  const ui = setup(t), item = ui.item(); ui.world(ui.handle('bottom-right'), 'pointerdown', 300, 200); ui.world(ui.viewport, 'pointermove', 350, 250);
  assert.deepEqual(styleBounds(item), [100, 100, 250, 150]);
  if (reason === 'Escape') ui.viewport.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  else if (reason === 'windowblur') ui.dom.window.dispatchEvent(new ui.dom.window.Event('blur'));
  else ui.world(ui.viewport, reason, 350, 250);
  ui.world(ui.viewport, 'pointerup', 350, 250); await ui.view.flush();
  assert.ok(ui.item() === item); assert.deepEqual(styleBounds(item), [100, 100, 200, 100]); assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 0);
  assert.equal(ui.viewport.classList.contains('is-resizing'), false); assert.equal(ui.host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.disabled, true);
});

test('a stale source before or during resize is never overwritten', async t => {
  const ui = setup(t); ui.model.updateNode('a', { text: 'External before gesture' });
  ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 350, 150); ui.world(ui.viewport, 'pointerup', 350, 150);
  assert.deepEqual(bounds(ui.model.getNode('a')!), [100, 100, 200, 100]); assert.equal(ui.errors.length, 1);
  ui.view.setDocument(CanvasDocument.parse(ui.model.toString()));
  ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 350, 150);
  ui.view.document.updateNode('a', { text: 'External during gesture' }); const external = ui.view.document.toString();
  ui.world(ui.viewport, 'pointerup', 350, 150); await ui.view.flush();
  assert.equal(ui.view.document.toString(), external); assert.deepEqual(styleBounds(ui.item()), [100, 100, 200, 100]); assert.equal(ui.saves.length, 0); assert.equal(ui.errors.length, 2);
});

test('resize locates an unchanged duplicate-ID record after insertion and rejects ambiguous duplicates', async t => {
  const first = node('a', { text: 'first', width: 90 }), last = node('a', { text: 'last' }), ui = setup(t, sourceOf([first, last]));
  ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 350, 150);
  ui.model.setRoot('nodes', [node('new', { x: 700 }), ...ui.model.nodes]); ui.world(ui.viewport, 'pointerup', 350, 150); await ui.view.flush();
  assert.equal(ui.model.nodes[1].width, 90); assert.equal(ui.model.nodes[2].width, 250); assert.equal(ui.model.nodes[0].width, 200); assert.equal(ui.saves.length, 1);
  const same = node('same'); ui.view.setDocument(CanvasDocument.parse(sourceOf([same, same])));
  ui.world(ui.handle('right', 'same'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 350, 150); ui.world(ui.viewport, 'pointerup', 350, 150); await ui.view.flush();
  assert.equal(ui.view.document.nodes[0].width, 200); assert.equal(ui.view.document.nodes[1].width, 200); assert.equal(ui.saves.length, 1); assert.ok(ui.errors.length > 0);
});

test('multi-selection scales positions and sizes proportionally, clamps every node to fifty, and undoes atomically', async t => {
  const ui = setup(t, sourceOf([node('a', { x: 0, y: 0, width: 100, height: 100 }), node('b', { x: 200, y: 0, width: 200, height: 200 })]));
  ui.select('a'); ui.select('b', true);
  const outline = ui.host.querySelector<HTMLElement>('.zorid-canvas-resize-outline')!; assert.equal(outline.hidden, false); assert.deepEqual(styleBounds(outline), [0, 0, 400, 200]);
  const handle = outline.querySelector('[data-resize="bottom-right"]')!;
  ui.world(handle, 'pointerdown', 400, 200); ui.world(ui.viewport, 'pointermove', 20, 20);
  assert.deepEqual(styleBounds(ui.item('a')), [0, 0, 50, 50]); assert.deepEqual(styleBounds(ui.item('b')), [100, 0, 100, 100]); assert.equal(ui.saves.length, 0);
  ui.world(ui.viewport, 'pointerup', 20, 20); await ui.view.flush(); assert.equal(ui.saves.length, 1);
  assert.deepEqual(bounds(ui.model.getNode('a')!), [0, 0, 50, 50]); assert.deepEqual(bounds(ui.model.getNode('b')!), [100, 0, 100, 100]);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.model.toString(), ui.source);
});

test('group resizing changes its box without moving or scaling contained cards', async t => {
  const ui = setup(t, sourceOf([node('g', { type: 'group', x: 0, y: 0, width: 500, height: 300, label: 'Group' }), node('a')]));
  ui.world(ui.handle('bottom-right', 'g'), 'pointerdown', 500, 300); ui.world(ui.viewport, 'pointermove', 600, 400); ui.world(ui.viewport, 'pointerup', 600, 400); await ui.view.flush();
  assert.deepEqual(bounds(ui.model.getNode('g')!), [0, 0, 600, 400]); assert.deepEqual(bounds(ui.model.getNode('a')!), [100, 100, 200, 100]); assert.equal(ui.saves.length, 1);
});

for (const [platform, bypass] of [['Linux', { altKey: true }], ['MacIntel', { ctrlKey: true }]] as const) test(`resize snapping prioritizes objects over grid and honors ${platform} bypass`, async t => {
  const ui = setup(t, sourceOf([node('a', { x: 0, y: 0 }), node('b', { x: 235, y: 300, width: 100 })]), {}, platform);
  ui.world(ui.handle('right'), 'pointerdown', 200, 50); ui.world(ui.viewport, 'pointermove', 238, 50, {}); ui.world(ui.viewport, 'pointerup', 238, 50); await ui.view.flush(); assert.equal(ui.model.getNode('a')!.width, 235);
  ui.world(ui.handle('right'), 'pointerdown', 235, 50); ui.world(ui.viewport, 'pointermove', 243, 50, bypass); ui.world(ui.viewport, 'pointerup', 243, 50); await ui.view.flush(); assert.equal(ui.model.getNode('a')!.width, 243);
  ui.world(ui.handle('right'), 'pointerdown', 243, 50); ui.world(ui.viewport, 'pointermove', 283, 50, {}); ui.world(ui.viewport, 'pointerup', 283, 50); await ui.view.flush(); assert.equal(ui.model.getNode('a')!.width, 285, 'object center wins over the nearby grid');
  ui.world(ui.handle('right'), 'pointerdown', 285, 50); ui.world(ui.viewport, 'pointermove', 403, 50, {}); ui.world(ui.viewport, 'pointerup', 403, 50); await ui.view.flush(); assert.equal(ui.model.getNode('a')!.width, 400, 'grid applies outside object snap distance');
});

test('resize retains shared Live editor and media owners across preview, release and undo', async t => {
  let owners = 0, released = 0; const other = new JSDOM('<main></main>'); t.after(() => other.window.close());
  const ui = setup(t, sourceOf([node('a'), node('media', { type: 'file', file: 'picture.png', x: 500 })]), { renderFile() { owners++; const element = other.window.document.createElement('div'); element.append(other.window.document.createElement('img')); return { element, destroy() { released++; } }; } });
  ui.item().dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick();
  const cm = EditorView.findFromDOM(ui.item().querySelector('.cm-editor')!)!; assert.ok(cm);
  const media = ui.item('media').querySelector('img')!;
  ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 350, 150); ui.world(ui.viewport, 'pointerup', 350, 150); await ui.view.flush();
  assert.ok(EditorView.findFromDOM(ui.item().querySelector('.cm-editor')!) === cm); assert.equal(cm.state.doc.toString(), 'a'); assert.ok(ui.item('media').querySelector('img') === media); assert.equal(owners, 1); assert.equal(released, 0);
  ui.view.undo(); await ui.view.flush(); assert.ok(EditorView.findFromDOM(ui.item().querySelector('.cm-editor')!) === cm); assert.equal(owners, 1); assert.equal(released, 0);
  ui.view.destroy(); assert.equal(released, 1);
});

test('failed resize persistence retains accepted geometry, retries the same bytes and undoes to exact original source', async t => {
  let rejectFirst!: (error: Error) => void;
  const firstWrite = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  const attempts: string[] = [];
  const ui = setup(t, sourceOf(), { onChange(source) { attempts.push(source); if (attempts.length === 1) return firstWrite; } });
  ui.world(ui.handle('bottom-right'), 'pointerdown', 300, 200); ui.world(ui.viewport, 'pointermove', 340, 230); ui.world(ui.viewport, 'pointerup', 340, 230);
  const resized = ui.model.toString(); assert.deepEqual(bounds(ui.model.getNode('a')!), [100, 100, 240, 130]); assert.equal(ui.view.hasPendingChanges(), true);
  const flushing = ui.view.flush(), rejected = assert.rejects(flushing, /resize write failed/);
  await tick(); assert.deepEqual(attempts, [resized]); rejectFirst(new Error('resize write failed')); await rejected;
  assert.equal(ui.model.toString(), resized); assert.deepEqual(styleBounds(ui.item()), [100, 100, 240, 130]); assert.equal(ui.view.hasPendingChanges(), true);
  await ui.view.flush(); assert.deepEqual(attempts, [resized, resized]); assert.equal(ui.view.hasPendingChanges(), false);
  await ui.view.flush(); assert.equal(attempts.length, 2);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.model.toString(), ui.source); assert.deepEqual(attempts, [resized, resized, ui.source]);
  assert.deepEqual(styleBounds(ui.item()), [100, 100, 200, 100]); assert.equal(ui.view.hasPendingChanges(), false);
});
