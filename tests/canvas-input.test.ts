import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { canScrollCanvasContent, createCanvasFrameQueue } from '../src/canvas/input.ts';
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
  // Capture only frames requested while dispatching a Canvas resize move.
  // Shared CodeMirror and other window/global rAF users retain the real scheduler.
  const requestFrame = dom.window.requestAnimationFrame.bind(dom.window), cancelFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  const resizeFrames = new Map<number, FrameRequestCallback>();
  let dispatchingResizeMove = false, frameId = 0, frameTime = 0;
  dom.window.requestAnimationFrame = callback => {
    if (!dispatchingResizeMove) return requestFrame(callback);
    const id = --frameId; resizeFrames.set(id, callback); return id;
  };
  dom.window.cancelAnimationFrame = id => { if (id < 0) resizeFrames.delete(id); else cancelFrame(id); };
  const advanceFrames = () => {
    const pending = [...resizeFrames]; frameTime += 1000 / 60;
    for (const [id, callback] of pending) if (resizeFrames.delete(id)) callback(frameTime);
  };
  Object.defineProperty(dom.window.navigator, 'platform', { value: platform });
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, toJSON() { return {}; } });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = dom.window.document.querySelector('main')!, model = CanvasDocument.parse(source), saves: string[] = [], errors: unknown[] = [];
  const view = createCanvasView(host, { document: model, onChange: value => { saves.push(value); }, onError: error => errors.push(error), ...options });
  t.after(() => { view.destroy(); resizeFrames.clear(); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const viewport = host.querySelector<HTMLElement>('.zorid-canvas-viewport')!;
  const item = (id = 'a') => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
  const handle = (direction: string, id = 'a') => item(id).querySelector<HTMLElement>(`[data-resize="${direction}"]`)!;
  const pointer = (target: Element, type: string, x: number, y: number, extra = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...extra });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } });
    dispatchingResizeMove = type === 'pointermove' && viewport.classList.contains('is-resizing');
    try { target.dispatchEvent(event); } finally { dispatchingResizeMove = false; }
    return event;
  };
  const world = (target: Element, type: string, x: number, y: number, extra: MouseEventInit = { altKey: true }) => pointer(target, type, 40 + x * Number(viewport.dataset.zoom), 40 + y * Number(viewport.dataset.zoom), extra);
  const select = (id: string, additive = false) => { world(item(id), 'pointerdown', 110, 110, { shiftKey: additive }); world(viewport, 'pointerup', 110, 110); };
  return { dom, host, model, view, viewport, item, handle, pointer, world, select, saves, errors, source, advanceFrames, resizeFrames };
}
const bounds = (value: { x: number; y: number; width: number; height: number }) => [value.x, value.y, value.width, value.height];
const styleBounds = (value: HTMLElement) => [value.style.left, value.style.top, value.style.width, value.style.height].map(parseFloat);


const transform = (ui: ReturnType<typeof setup>) => ui.host.querySelector<HTMLElement>('.zorid-canvas-world')!.style.transform;
const preview = (ui: ReturnType<typeof setup>) => ui.item().querySelector<HTMLElement>('.zorid-canvas-note-preview')!;
const wheel = (ui: ReturnType<typeof setup>, target: Element, init: WheelEventInit = {}) => {
  const event = new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 30, ...init }); target.dispatchEvent(event); return event;
};
function scrolling(item: HTMLElement, { height = 100, content = 300, width = 100, wide = 100, top = 0, left = 0 } = {}) {
  item.style.overflow = 'auto';
  Object.defineProperties(item, { clientHeight: { configurable: true, value: height }, scrollHeight: { configurable: true, value: content }, clientWidth: { configurable: true, value: width }, scrollWidth: { configurable: true, value: wide } });
  item.scrollTop = top; item.scrollLeft = left;
}

test('wheel pans Canvas over a non-scrollable card, without editing source or saving', async t => {
  const ui = setup(t); await tick(); const before = transform(ui);
  assert.equal(wheel(ui, preview(ui)).defaultPrevented, true); assert.notEqual(transform(ui), before);
  await ui.view.flush(); assert.equal(ui.model.toString(), ui.source); assert.deepEqual(ui.saves, []);
});
test('preview scrolls natively while it has space and chains at both vertical boundaries', async t => {
  const ui = setup(t); await tick(); const content = preview(ui); scrolling(content);
  let before = transform(ui); assert.equal(wheel(ui, content).defaultPrevented, false); assert.equal(transform(ui), before);
  content.scrollTop = 200; assert.equal(wheel(ui, content).defaultPrevented, true); assert.notEqual(transform(ui), before);
  before = transform(ui); assert.equal(wheel(ui, content, { deltaY: -30 }).defaultPrevented, false); assert.equal(transform(ui), before);
  content.scrollTop = 0; assert.equal(wheel(ui, content, { deltaY: -30 }).defaultPrevented, true); assert.notEqual(transform(ui), before);
});
test('nested horizontal code scroll and shift-wheel chain only once content is exhausted', async t => {
  const ui = setup(t); await tick(); const code = ui.dom.window.document.createElement('pre'); preview(ui).append(code); scrolling(code, { content: 100, wide: 500 });
  const before = transform(ui); assert.equal(wheel(ui, code, { shiftKey: true }).defaultPrevented, false); assert.equal(transform(ui), before);
  code.scrollLeft = 400; assert.equal(wheel(ui, code, { shiftKey: true }).defaultPrevented, true); assert.ok(Math.abs(Number(transform(ui).match(/translate\(([^p]+)/)![1]) - 12.1) < 1e-9);
});
test('Live editor scrolling hands an exhausted gesture to Canvas without moving focus', async t => {
  const ui = setup(t); await tick(); ui.select('a');
  ui.host.querySelector<HTMLButtonElement>('.zorid-canvas-note-toolbar button')!.click();
  await tick(); const editor = EditorView.findFromDOM(ui.item().querySelector('.cm-editor')!)!;
  scrolling(editor.scrollDOM); const focus = ui.dom.window.document.activeElement, before = transform(ui);
  assert.equal(wheel(ui, editor.contentDOM).defaultPrevented, false); assert.equal(transform(ui), before);
  editor.scrollDOM.scrollTop = 200; assert.equal(wheel(ui, editor.contentDOM).defaultPrevented, true); assert.notEqual(transform(ui), before);
  assert.equal(ui.dom.window.document.activeElement, focus); assert.equal(EditorView.findFromDOM(ui.item().querySelector('.cm-editor')!), editor);
});
test('nested attachment scroll and explicitly handled viewer wheel retain their ownership', t => {
  const ui = setup(t); const child = ui.dom.window.document.createElement('div'); child.className = 'interactive-child'; ui.item().append(child); scrolling(child);
  const before = transform(ui); assert.equal(wheel(ui, child).defaultPrevented, false); assert.equal(transform(ui), before);
  child.scrollTop = 200; assert.equal(wheel(ui, child).defaultPrevented, true);
  const after = transform(ui); child.addEventListener('wheel', event => event.preventDefault()); wheel(ui, child, { ctrlKey: true }); assert.equal(transform(ui), after);
});
test('native value controls keep wheel ownership and pinch zoom remains available over cards', t => {
  const ui = setup(t), control = ui.dom.window.document.createElement('input'); control.type = 'number'; ui.item().append(control);
  const before = transform(ui); assert.equal(wheel(ui, control).defaultPrevented, false); assert.equal(transform(ui), before);
  assert.equal(wheel(ui, preview(ui), { ctrlKey: true, deltaY: -300 }).defaultPrevented, true); assert.equal(ui.viewport.dataset.zoom, '2');
});
test('scroll capacity handles nested containers, fractional bounds and RTL horizontal ranges', t => {
  const ui = setup(t), outer = preview(ui), inner = ui.dom.window.document.createElement('div'); outer.append(inner); scrolling(outer); scrolling(inner, { content: 100, wide: 300 }); inner.style.direction = 'rtl';
  assert.equal(canScrollCanvasContent(inner, ui.viewport, 0, 10), true);
  outer.scrollTop = 199.75; assert.equal(canScrollCanvasContent(inner, ui.viewport, 0, 10), false);
  assert.equal(canScrollCanvasContent(inner, ui.viewport, -10, 0), true); assert.equal(canScrollCanvasContent(inner, ui.viewport, 10, 0), false);
  inner.scrollLeft = -200; assert.equal(canScrollCanvasContent(inner, ui.viewport, -10, 0), false); assert.equal(canScrollCanvasContent(inner, ui.viewport, 10, 0), true);
  scrolling(outer, { content: 100, top: -10 }); assert.equal(canScrollCanvasContent(inner, ui.viewport, 0, 10), false, 'elastic overscroll does not turn an empty card into a scroll owner');
});

test('one hundred resize inputs paint only latest geometry once per frame and keep rich owners', async t => {
  const ui = setup(t, sourceOf([node('a'), node('b', { x: 500 })], [{ id: 'edge', fromNode: 'a', toNode: 'b' }])); await tick();
  const item = ui.item(), paragraph = item.querySelector('p'), path = ui.host.querySelector('.zorid-canvas-edge-line')!;
  ui.world(ui.handle('right'), 'pointerdown', 300, 150);
  let geometryReads = 0; ui.viewport.getBoundingClientRect = () => { geometryReads++; return { left: 0, top: 0, x: 0, y: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {}; } }; };
  const observer = new ui.dom.window.MutationObserver(() => {}); observer.observe(item, { attributes: true, subtree: true });
  for (let i = 1; i <= 100; i++) ui.world(ui.viewport, 'pointermove', 300 + i, 150);
  assert.equal(ui.resizeFrames.size, 1); assert.deepEqual(styleBounds(item), [100, 100, 200, 100]); assert.equal(observer.takeRecords().length, 0); assert.equal(geometryReads, 0);
  ui.advanceFrames(); observer.disconnect();
  assert.deepEqual(styleBounds(item), [100, 100, 300, 100]); assert.equal(geometryReads, 1); assert.equal(ui.item(), item); assert.equal(ui.item().querySelector('p'), paragraph); assert.equal(ui.host.querySelector('.zorid-canvas-edge-line'), path); assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 0);
  ui.world(ui.viewport, 'pointerup', 400, 150); await ui.view.flush(); assert.equal(ui.saves.length, 1);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.model.toString(), ui.source);
});
test('pointerup flushes pending latest resize before one save, and canceled callbacks cannot repaint', async t => {
  const ui = setup(t); ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 355, 150);
  const stale = [...ui.resizeFrames.values()][0]; ui.world(ui.viewport, 'pointerup', 355, 150); await ui.view.flush();
  assert.equal(ui.model.getNode('a')!.width, 255); assert.equal(ui.saves.length, 1); assert.equal(ui.resizeFrames.size, 0);
  stale(0); assert.equal(ui.model.getNode('a')!.width, 255); assert.equal(ui.saves.length, 1);
});
for (const reason of ['pointercancel', 'lostpointercapture', 'Escape', 'windowblur', 'destroy', 'reload']) test(`pending resize ${reason} discards frame without stale writes`, async t => {
  const ui = setup(t); ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 355, 150);
  const stale = [...ui.resizeFrames.values()][0];
  if (reason === 'Escape') ui.viewport.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  else if (reason === 'windowblur') ui.dom.window.dispatchEvent(new ui.dom.window.Event('blur'));
  else if (reason === 'destroy') ui.view.destroy();
  else if (reason === 'reload') ui.view.setDocument(CanvasDocument.parse(sourceOf([node('a', { width: 333 })])));
  else ui.world(ui.viewport, reason, 355, 150);
  stale(0); ui.world(ui.viewport, 'pointerup', 355, 150); await ui.view.flush();
  assert.equal(ui.resizeFrames.size, 0); assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 0);
  if (reason === 'reload') assert.equal(ui.item().style.width, '333px');
  else if (reason !== 'destroy') assert.equal(ui.item().style.width, '200px');
});
test('identical save acknowledgement retains queued resize, while changed record rejects its commit', async t => {
  const ui = setup(t); ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 355, 150);
  ui.view.setDocument(CanvasDocument.parse(ui.source)); assert.equal(ui.resizeFrames.size, 1);
  ui.model.setRoot('nodes', [node('a', { text: 'external change' })]); ui.world(ui.viewport, 'pointerup', 355, 150); await ui.view.flush();
  assert.equal(ui.model.getNode('a')!.text, 'external change'); assert.equal(ui.model.getNode('a')!.width, 200); assert.equal(ui.saves.length, 0); assert.equal(ui.errors.length, 1);
});
test('retired frame cannot flush a newer gesture queue', () => {
  const callbacks: FrameRequestCallback[] = [], applied: number[] = [], canceled: number[] = [];
  const queue = createCanvasFrameQueue<number>({ request: callback => (callbacks.push(callback), callbacks.length), cancel: id => canceled.push(id), apply: value => applied.push(value) });
  queue.push(1); queue.push(2); assert.equal(callbacks.length, 1); queue.discard(); queue.push(3); callbacks[0](0); assert.deepEqual(applied, []); callbacks[1](0); assert.deepEqual(applied, [3]);
  queue.push(4); queue.flush(); callbacks[2](0); assert.deepEqual(applied, [3, 4]); assert.equal(canceled.length, 3);
});
test('edit toolbar has a shared layer above edge, corner and multi-selection hit areas', async t => {
  const ui = setup(t); await tick(); ui.select('a');
  const style = ui.dom.window.document.createElement('style'); style.textContent = readFileSync(new URL('../src/canvas/view.css', import.meta.url), 'utf8'); ui.dom.window.document.head.append(style);
  const css = (element: Element) => ui.dom.window.getComputedStyle(element), toolbar = ui.host.querySelector<HTMLElement>('.zorid-canvas-note-toolbar')!;
  assert.equal(css(ui.item()).zIndex, '2'); assert.equal(toolbar.parentElement, ui.item().parentElement);
  assert.equal(ui.item().getAttribute('aria-owns'), toolbar.id); assert.equal(toolbar.hidden, false);
  assert.ok(Number(css(toolbar).zIndex) > Number(css(ui.handle('top-right')).zIndex)); assert.ok(Number(css(toolbar).zIndex) > Number(css(ui.host.querySelector('.zorid-canvas-resize-outline')!).zIndex));
  const edit = toolbar.querySelector('button')!; const event = ui.pointer(edit, 'pointerdown', 240, 100); assert.equal(event.defaultPrevented, false); edit.click(); await tick();
  assert.ok(ui.item().querySelector('.cm-editor')); assert.equal(ui.viewport.classList.contains('is-resizing'), false); assert.equal(ui.model.toString(), ui.source);
});

test('an exhausted contained scroller does not claim native outer scrolling that cannot occur', async t => {
  const ui = setup(t); await tick(); const outer = preview(ui), inner = ui.dom.window.document.createElement('div'); outer.append(inner);
  scrolling(outer); scrolling(inner, { top: 200 }); inner.style.setProperty('overscroll-behavior', 'contain');
  const before = transform(ui); assert.equal(wheel(ui, inner).defaultPrevented, true); assert.notEqual(transform(ui), before);
  inner.scrollTop = 100; const next = transform(ui); assert.equal(wheel(ui, inner).defaultPrevented, false); assert.equal(transform(ui), next);
});
test('toolbar portal retains owner, selection visibility and geometry while normal cards retain overlap order', async t => {
  const ui = setup(t, sourceOf([node('a'), node('b', { x: 250, y: 50, height: 200 })])); await tick();
  const tools = ui.host.querySelector<HTMLElement>('.zorid-canvas-note-toolbar[data-card-id="a"]')!, other = ui.host.querySelector<HTMLElement>('.zorid-canvas-note-toolbar[data-card-id="b"]')!;
  assert.equal(tools.hidden, true); ui.select('a'); assert.equal(tools.hidden, false); assert.equal(other.hidden, true);
  assert.equal(tools.style.left, '200px'); assert.equal(tools.style.top, '100px'); assert.ok(ui.item('a').contains(ui.handle('right', 'a'))); assert.ok(ui.item('b').contains(ui.handle('right', 'b')));
  assert.ok(ui.item('a').compareDocumentPosition(ui.item('b')) & ui.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  ui.world(ui.handle('right'), 'pointerdown', 300, 150); ui.world(ui.viewport, 'pointermove', 350, 150); ui.advanceFrames(); assert.equal(tools.style.left, '225px');
  ui.world(ui.viewport, 'pointerup', 350, 150); await ui.view.flush(); assert.equal(ui.host.querySelector('.zorid-canvas-note-toolbar[data-card-id="a"]'), tools);
  ui.view.undo(); await ui.view.flush(); assert.equal(tools.style.left, '200px'); ui.view.destroy(); assert.equal(tools.isConnected, false); assert.equal(other.isConnected, false);
});
