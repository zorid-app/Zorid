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
  let timerId = 0; const timers = new Map<number, () => void>(), scheduled: { callback: () => void; delay: number }[] = [];
  dom.window.setInterval = ((callback: () => void, delay: number) => { scheduled.push({ callback, delay }); timers.set(++timerId, callback); return timerId; }) as typeof dom.window.setInterval;
  dom.window.clearInterval = (id?: number) => { if (id !== undefined) timers.delete(id); };
  const runTimers = (count = 1) => { for (let i = 0; i < count; i++) for (const callback of [...timers.values()]) callback(); };
  const view = createCanvasView(host, { document: model, onChange: value => { saves.push(value); }, onError: error => errors.push(error), ...options });
  t.after(() => { view.destroy(); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const viewport = host.querySelector<HTMLElement>('.zorid-canvas-viewport')!;
  viewport.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {}; } });
  const item = (id = 'a') => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
  const handle = (direction: string, id = 'a') => item(id).querySelector<HTMLElement>(`[data-resize="${direction}"]`)!;
  const pointer = (target: Element, type: string, x: number, y: number, extra = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...extra });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } }); target.dispatchEvent(event); return event;
  };
  const world = (target: Element, type: string, x: number, y: number, extra: MouseEventInit = { altKey: true }) => pointer(target, type, 40 + x * Number(viewport.dataset.zoom), 40 + y * Number(viewport.dataset.zoom), extra);
  const select = (id: string, additive = false) => { world(item(id), 'pointerdown', 110, 110, { shiftKey: additive }); world(viewport, 'pointerup', 110, 110); };
  return { dom, host, model, view, viewport, item, handle, pointer, world, select, saves, errors, source, timers, scheduled, runTimers };
}
const bounds = (value: { x: number; y: number; width: number; height: number }) => [value.x, value.y, value.width, value.height];
const styleBounds = (value: HTMLElement) => [value.style.left, value.style.top, value.style.width, value.style.height].map(parseFloat);


function measure(ui: ReturnType<typeof setup>, id = 'a', contentHeight: number | (() => number) = 160) {
  const preview = ui.item(id).querySelector<HTMLElement>('.zorid-canvas-note-preview')!;
  const readings = { client: 0, scroll: 0 };
  preview.getClientRects = () => Object.assign([preview.getBoundingClientRect()], { item: () => null });
  Object.defineProperties(preview, {
    clientHeight: { configurable: true, get() { readings.client++; return parseFloat(ui.item(id).style.height); } },
    scrollHeight: { configurable: true, get() { readings.scroll++; return typeof contentHeight === 'function' ? contentHeight() : contentHeight; } },
  });
  return { preview, readings };
}
const doubleClick = (ui: ReturnType<typeof setup>, direction: string, id = 'a') => ui.handle(direction, id).dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
const transform = (ui: ReturnType<typeof setup>) => ui.host.querySelector<HTMLElement>('.zorid-canvas-world')!.style.transform;

test('bottom double-click fits visible Markdown in one transaction and restores exact source with undo', async t => {
  const ui = setup(t), item = ui.item(), paragraph = item.querySelector('p')!;
  const { preview, readings } = measure(ui); preview.style.setProperty('height', '7px', 'important');
  doubleClick(ui, 'bottom'); await ui.view.flush();
  assert.deepEqual(bounds(ui.model.getNode('a')!), [100, 100, 200, 161]); assert.equal(ui.saves.length, 1); assert.ok(readings.scroll <= 10);
  assert.ok(ui.item().querySelector('p') === paragraph, 'fitting retains the shared Markdown renderer');
  assert.equal(preview.style.getPropertyValue('height'), '7px'); assert.equal(preview.style.getPropertyPriority('height'), 'important');
  assert.deepEqual(ui.model.getNode('a')!.custom, { keep: true });
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 2);
});

test('right double-click measures wrapping with bounded probes and commits only the fitted width', async t => {
  const ui = setup(t), { preview, readings } = measure(ui, 'a', () => parseFloat(ui.item().style.width) >= 120 ? 160 : 320);
  doubleClick(ui, 'right'); await ui.view.flush();
  assert.deepEqual(bounds(ui.model.getNode('a')!), [100, 100, 120, 100]); assert.equal(ui.saves.length, 1); assert.ok(readings.scroll <= 12, `bounded probes: ${readings.scroll}`); assert.equal(preview.style.height, '');
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.model.toString(), ui.source);
});

test('only bottom/right handles and visible Reading previews can auto-fit; active Live editor remains owned', async t => {
  const ui = setup(t), { preview } = measure(ui);
  for (const direction of ['top', 'left', 'bottom-right']) doubleClick(ui, direction);
  assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 0);
  preview.hidden = true; doubleClick(ui, 'bottom'); preview.hidden = false;
  preview.getClientRects = () => Object.assign([], { item: () => null }); doubleClick(ui, 'right');
  assert.equal(ui.model.toString(), ui.source);
  measure(ui); ui.item().dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick();
  const cm = EditorView.findFromDOM(ui.item().querySelector('.cm-editor')!)!; assert.ok(cm);
  doubleClick(ui, 'bottom'); doubleClick(ui, 'right'); await ui.view.flush();
  assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 0); assert.ok(EditorView.findFromDOM(ui.item().querySelector('.cm-editor')!) === cm);
});

test('multi-selection auto-fit changes eligible cards atomically while retaining group and media geometry', async t => {
  let disposed = 0; const other = new JSDOM('<main></main>'); t.after(() => other.window.close());
  const ui = setup(t, sourceOf([node('a'), node('b', { x: 400, height: 200 }), node('media', { x: 0, type: 'file', file: 'image.png' }), node('group', { type: 'group', label: 'Group', x: 600 })]), { renderFile() { return { element: other.window.document.createElement('img'), destroy() { disposed++; } }; } });
  measure(ui, 'a', 160); measure(ui, 'b', 220); const media = ui.item('media').querySelector('img');
  ui.select('a'); ui.select('b', true); ui.select('media', true); ui.select('group', true);
  ui.host.querySelector('[class="zorid-canvas-resize-outline"] [data-resize="bottom"]')!.dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); await ui.view.flush();
  assert.equal(ui.model.getNode('a')!.height, 161); assert.equal(ui.model.getNode('b')!.height, 221); assert.equal(ui.model.getNode('media')!.height, 100); assert.equal(ui.model.getNode('group')!.height, 100);
  assert.equal(ui.saves.length, 1); assert.ok(ui.item('media').querySelector('img') === media); assert.equal(disposed, 0);
  ui.view.undo(); await ui.view.flush(); assert.equal(ui.model.toString(), ui.source); ui.view.destroy(); assert.equal(disposed, 1);
});

test('measurement failure restores preview styles and geometry without publishing a partial fit', async t => {
  const ui = setup(t); let calls = 0;
  const { preview } = measure(ui, 'a', () => { if (++calls === 2) throw new Error('layout unavailable'); return 160; });
  preview.style.setProperty('height', '9px', 'important'); doubleClick(ui, 'bottom'); await ui.view.flush();
  assert.equal(ui.model.toString(), ui.source); assert.deepEqual(styleBounds(ui.item()), [100, 100, 200, 100]); assert.equal(ui.saves.length, 0); assert.equal(ui.errors.length, 1);
  assert.equal(preview.style.getPropertyValue('height'), '9px'); assert.equal(preview.style.getPropertyPriority('height'), 'important');
});

test('auto-fit rejects source collisions before and during measurement without overwriting changed source', async t => {
  const ui = setup(t); measure(ui); ui.model.updateNode('a', { text: 'External before' }); const before = ui.model.toString();
  doubleClick(ui, 'bottom'); await ui.view.flush(); assert.equal(ui.model.toString(), before); assert.equal(ui.saves.length, 0);
  ui.view.setDocument(CanvasDocument.parse(before)); let changed = false;
  measure(ui, 'a', () => { if (!changed) { changed = true; ui.view.document.updateNode('a', { text: 'External during' }); } return 160; });
  doubleClick(ui, 'bottom'); await ui.view.flush();
  assert.equal(ui.view.document.getNode('a')!.text, 'External during'); assert.equal(ui.view.document.getNode('a')!.height, 100); assert.deepEqual(styleBounds(ui.item()), [100, 100, 200, 100]); assert.equal(ui.saves.length, 0); assert.equal(ui.errors.length, 2);
});

test('pathological measurements stop after ten height probes and publish one final result', async t => {
  const ui = setup(t), { readings } = measure(ui, 'a', () => parseFloat(ui.item().style.height) + 10);
  doubleClick(ui, 'bottom'); await ui.view.flush(); assert.equal(readings.scroll, 10); assert.equal(ui.model.getNode('a')!.height, 210); assert.equal(ui.saves.length, 1);
});

test('edge panning schedules at sixty Hz, changes only viewport until a real move, and stops in the inner region', async t => {
  const ui = setup(t), item = ui.item();
  ui.pointer(ui.handle('right'), 'pointerdown', 340, 190); ui.pointer(ui.viewport, 'pointermove', 790, 190, { altKey: true });
  assert.equal(ui.timers.size, 1); assert.equal(ui.scheduled[0].delay, 1000 / 60); assert.deepEqual(styleBounds(item), [100, 100, 650, 100]);
  ui.runTimers(3); assert.equal(transform(ui), 'translate(10px, 40px) scale(1)'); assert.deepEqual(styleBounds(item), [100, 100, 650, 100]); assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 0);
  ui.pointer(ui.viewport, 'pointermove', 790, 190, { altKey: true }); assert.deepEqual(styleBounds(item), [100, 100, 680, 100]);
  ui.pointer(ui.viewport, 'pointermove', 760, 190, { altKey: true }); assert.equal(ui.timers.size, 0); const stopped = transform(ui); ui.runTimers(); assert.equal(transform(ui), stopped);
  ui.pointer(ui.viewport, 'pointerup', 760, 190); await ui.view.flush(); assert.equal(ui.saves.length, 1); assert.equal(ui.model.getNode('a')!.width, 650);
});

test('edge pan speed uses square-root zoom compensation and the thirty-pixel inset boundary', async t => {
  const ui = setup(t); ui.viewport.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 600, clientX: 40, clientY: 40 })); assert.equal(ui.viewport.dataset.zoom, '0.25');
  ui.pointer(ui.handle('left'), 'pointerdown', 65, 100); ui.pointer(ui.viewport, 'pointermove', 30, 100, { altKey: true }); assert.equal(ui.timers.size, 0);
  ui.pointer(ui.viewport, 'pointermove', 10, 100, { altKey: true }); assert.equal(ui.timers.size, 1); ui.runTimers();
  assert.equal(transform(ui), 'translate(45px, 40px) scale(0.25)', 'twenty-pixel outside inset gives twenty world units or five screen pixels');
  ui.pointer(ui.viewport, 'pointercancel', 10, 100); await ui.view.flush(); assert.equal(ui.saves.length, 0);
});

for (const reason of ['pointercancel', 'lostpointercapture', 'Escape', 'windowblur', 'destroy']) test(`edge pan ${reason} stops retained timer callbacks, restores geometry and keeps completed pan`, async t => {
  const ui = setup(t); ui.pointer(ui.handle('bottom-right'), 'pointerdown', 340, 240); ui.pointer(ui.viewport, 'pointermove', 790, 590, { altKey: true }); ui.runTimers();
  const panned = transform(ui), callback = ui.scheduled[0].callback, item = ui.item();
  if (reason === 'Escape') ui.viewport.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  else if (reason === 'windowblur') ui.dom.window.dispatchEvent(new ui.dom.window.Event('blur'));
  else if (reason === 'destroy') ui.view.destroy();
  else ui.pointer(ui.viewport, reason, 790, 590);
  assert.equal(ui.timers.size, 0); callback(); await ui.view.flush(); assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 0);
  if (reason !== 'destroy') { assert.equal(transform(ui), panned); assert.deepEqual(styleBounds(item), [100, 100, 200, 100]); }
  else assert.equal(ui.host.children.length, 0);
});

test('identical source acknowledgement preserves edge pan while an external reload cancels the old gesture', async t => {
  const ui = setup(t); ui.pointer(ui.handle('right'), 'pointerdown', 340, 190); ui.pointer(ui.viewport, 'pointermove', 790, 190, { altKey: true });
  const item = ui.item(), callback = ui.scheduled[0].callback;
  ui.view.setDocument(CanvasDocument.parse(ui.source)); assert.equal(ui.timers.size, 1); assert.ok(ui.item() === item); ui.runTimers(); assert.equal(transform(ui), 'translate(30px, 40px) scale(1)');
  const next = CanvasDocument.parse(ui.source); next.updateNode('a', { text: 'External' }); ui.view.setDocument(next);
  assert.equal(ui.timers.size, 0); const panned = transform(ui); callback(); ui.pointer(ui.viewport, 'pointerup', 790, 190); await ui.view.flush();
  assert.equal(transform(ui), panned); assert.equal(ui.view.document.toString(), next.toString()); assert.deepEqual(styleBounds(ui.item()), [100, 100, 200, 100]); assert.equal(ui.saves.length, 0);
});

test('edge pan makes newly visible nodes eligible for snapping on the next real pointer move', async t => {
  const ui = setup(t, sourceOf([node('a'), node('offscreen', { x: 783, y: 300, width: 100 })]));
  ui.pointer(ui.handle('right'), 'pointerdown', 340, 190); ui.pointer(ui.viewport, 'pointermove', 790, 190, { altKey: true }); ui.runTimers(3);
  assert.equal(transform(ui), 'translate(10px, 40px) scale(1)');
  ui.pointer(ui.viewport, 'pointermove', 790, 190); ui.pointer(ui.viewport, 'pointerup', 790, 190); await ui.view.flush();
  assert.equal(ui.model.getNode('a')!.width, 683, 'newly visible x=783 object edge wins over x=780 grid'); assert.equal(ui.saves.length, 1);
});

test('linked Markdown fit changes only Canvas geometry and retains its note session', async t => {
  const noteText = '# Linked note\n\nBody'; let destroyed = 0, updates = 0;
  const ui = setup(t, sourceOf([node('note', { type: 'file', file: 'Linked.md' })]), { openMarkdownFile: async () => ({ getText: () => noteText, update() { updates++; }, subscribe: () => () => {}, flush: async () => {}, hasPendingChanges: () => false, destroy() { destroyed++; } }) });
  await tick(); const heading = ui.item('note').querySelector('h1'); assert.ok(heading); measure(ui, 'note', 180);
  doubleClick(ui, 'bottom', 'note'); await ui.view.flush();
  assert.equal(ui.model.getNode('note')!.height, 181); assert.equal(ui.model.getNode('note')!.file, 'Linked.md'); assert.equal(ui.saves.length, 1); assert.equal(updates, 0); assert.equal(destroyed, 0); assert.ok(ui.item('note').querySelector('h1') === heading);
  ui.view.destroy(); assert.equal(destroyed, 1);
});

test('a replacement document during measurement cancels the old fit without writing into the new source', async t => {
  const ui = setup(t), replacement = CanvasDocument.parse(sourceOf([node('a', { text: '**Replacement**', width: 333, height: 222 })])); let replaced = false;
  const { preview } = measure(ui, 'a', () => { if (!replaced) { replaced = true; ui.view.setDocument(replacement); } return 160; });
  preview.style.setProperty('height', '11px', 'important'); doubleClick(ui, 'bottom'); await ui.view.flush();
  assert.ok(ui.view.document === replacement); assert.equal(ui.view.document.toString(), replacement.toString()); assert.deepEqual(bounds(ui.view.document.getNode('a')!), [100, 100, 333, 222]); assert.deepEqual(styleBounds(ui.item()), [100, 100, 333, 222]); assert.equal(ui.saves.length, 0);
  assert.equal(preview.style.getPropertyValue('height'), '11px'); assert.equal(preview.style.getPropertyPriority('height'), 'important');
});

for (const failure of ['getClientRects', 'clientHeight'] as const) test(`initial ${failure} failure reports once without writing and leaves auto-fit available for retry`, async t => {
  const ui = setup(t), { preview } = measure(ui);
  if (failure === 'getClientRects') preview.getClientRects = () => { throw new Error('Initial visibility failed'); };
  else Object.defineProperty(preview, 'clientHeight', { configurable: true, get() { throw new Error('Initial visibility failed'); } });
  doubleClick(ui, 'bottom'); await ui.view.flush();
  assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 0); assert.deepEqual(styleBounds(ui.item()), [100, 100, 200, 100]); assert.equal(ui.errors.length, 1); assert.match(String(ui.errors[0]), /Initial visibility failed/);
  measure(ui); doubleClick(ui, 'bottom'); await ui.view.flush();
  assert.equal(ui.model.getNode('a')!.height, 161); assert.equal(ui.saves.length, 1); assert.equal(ui.errors.length, 1);
});

test('destroy during content measurement restores temporary height, releases owners once and leaves retained events inert', async t => {
  let noteReleased = 0, mediaReleased = 0, measurements = 0;
  const other = new JSDOM('<main></main>'); t.after(() => other.window.close());
  const ui = setup(t, sourceOf([node('note', { type: 'file', file: 'Linked.md' }), node('media', { type: 'file', file: 'image.png', x: 500 })]), {
    openMarkdownFile: async () => ({ getText: () => '# Linked', update() { assert.fail('measurement cannot edit note source'); }, subscribe: () => () => {}, flush: async () => {}, hasPendingChanges: () => false, destroy() { noteReleased++; } }),
    renderFile() { return { element: other.window.document.createElement('img'), destroy() { mediaReleased++; } }; },
  });
  await tick(); const retainedHandle = ui.handle('bottom', 'note');
  const { preview } = measure(ui, 'note', () => { measurements++; ui.view.destroy(); return 160; });
  preview.style.setProperty('height', '13px', 'important'); doubleClick(ui, 'bottom', 'note'); await ui.view.flush();
  assert.equal(ui.host.children.length, 0); assert.equal(ui.model.toString(), ui.source); assert.equal(ui.saves.length, 0); assert.equal(noteReleased, 1); assert.equal(mediaReleased, 1); assert.equal(measurements, 1);
  assert.equal(preview.style.getPropertyValue('height'), '13px'); assert.equal(preview.style.getPropertyPriority('height'), 'important');
  retainedHandle.dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  ui.pointer(retainedHandle, 'pointerdown', 340, 240); ui.pointer(ui.viewport, 'pointermove', 790, 590); ui.runTimers(); ui.view.destroy(); await ui.view.flush();
  assert.equal(measurements, 1); assert.equal(ui.scheduled.length, 0); assert.equal(ui.timers.size, 0); assert.equal(noteReleased, 1); assert.equal(mediaReleased, 1); assert.equal(ui.saves.length, 0);
});

test('replacement during the second height probe clears the already applied fit preview before rendering new source', async t => {
  const ui = setup(t), replacement = CanvasDocument.parse(sourceOf([node('a', { text: '**New source**', width: 333, height: 222 })]));
  const replacementSource = replacement.toString(); let measurements = 0;
  const { preview } = measure(ui, 'a', () => {
    if (++measurements === 2) {
      assert.deepEqual(styleBounds(ui.item()), [100, 100, 200, 161], 'the first probe already applied a temporary fit');
      ui.view.setDocument(replacement);
    }
    return 160;
  });
  preview.style.setProperty('height', '17px', 'important'); doubleClick(ui, 'bottom'); await ui.view.flush();
  assert.equal(measurements, 2); assert.ok(ui.view.document === replacement); assert.equal(ui.view.document.toString(), replacementSource);
  assert.deepEqual(styleBounds(ui.item()), [100, 100, 333, 222]); assert.deepEqual(bounds(ui.view.document.getNode('a')!), [100, 100, 333, 222]); assert.equal(ui.item().querySelector('strong')?.textContent, 'New source'); assert.equal(ui.saves.length, 0);
  assert.equal(preview.style.getPropertyValue('height'), '17px'); assert.equal(preview.style.getPropertyPriority('height'), 'important');
});
