import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { CanvasDocument } from '../src/canvas/document.ts';
import { createCanvasView } from '../src/canvas/view.ts';

const initial = JSON.stringify({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 300, height: 200, text: 'Card with a retained embedded draft' }], edges: [] });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(t: TestContext, source = initial) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200, toJSON() { return {}; } });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = dom.window.document.querySelector('main')!, saves: string[] = [], errors: unknown[] = [];
  let pending = false, failure: Error | undefined, flushes = 0;
  const view = createCanvasView(host, { document: CanvasDocument.parse(source), onChange: source => { saves.push(source); }, onError: error => errors.push(error), textEmbedLifecycle: {
    hasPendingChanges: () => pending,
    async flush() { flushes++; if (failure) throw failure; pending = false; },
  } });
  t.after(() => { view.destroy(); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const viewport = host.querySelector<HTMLElement>('.zorid-canvas-viewport')!;
  const item = () => host.querySelector<HTMLElement>('[data-node-id="a"]')!;
  const pointer = (target: Element, type: string, x = 100, y = 100) => { const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } }); target.dispatchEvent(event); };
  const select = () => { pointer(item(), 'pointerdown'); pointer(viewport, 'pointerup'); };
  const key = (key: string, target: Element = viewport) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { dom, host, view, viewport, item, pointer, select, key, saves, errors, dirty(error?: Error) { pending = true; failure = error; }, recover() { failure = undefined; }, flushes: () => flushes };
}

test('pending embedded drafts block text-card deletion and external replacement without changing Canvas source', async t => {
  const ui = setup(t); ui.dirty(new Error('Embedded draft rejected'));
  assert.equal(ui.view.hasPendingChanges(), true); ui.select(); ui.key('Delete');
  assert.equal(ui.view.document.toString(), initial); assert.equal(ui.saves.length, 0); assert.match(String(ui.errors.at(-1)), /unsaved changes/);
  assert.throws(() => ui.view.setDocument(CanvasDocument.parse('{"nodes":[],"edges":[]}')), /unsaved changes/);
  await assert.rejects(ui.view.flush(), /Embedded draft rejected/); assert.equal(ui.view.hasPendingChanges(), true);
  ui.recover(); await ui.view.flush(); assert.equal(ui.view.hasPendingChanges(), false);
  ui.select(); ui.key('Delete'); await ui.view.flush(); assert.equal(ui.view.document.nodes.length, 0); assert.equal(ui.saves.length, 1);
});

test('geometry can change while an embedded draft is dirty, but undo cannot discard its text card', async t => {
  const ui = setup(t, ''); ui.host.querySelector<HTMLButtonElement>('[aria-label="Add card"]')!.click(); await tick(); await ui.view.flush();
  const id = ui.view.document.nodes[0].id, card = ui.host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
  ui.dirty(new Error('Pending Base write'));
  ui.pointer(card, 'pointerdown'); ui.pointer(ui.viewport, 'pointermove', 130, 120); ui.pointer(ui.viewport, 'pointerup', 130, 120); await tick();
  assert.equal(ui.view.document.nodes.length, 1); assert.equal(ui.saves.length, 2, 'geometry is an accepted independent Canvas transaction');
  ui.view.undo(); assert.equal(ui.view.document.nodes.length, 1, 'geometry undo preserves the card');
  const before = ui.view.document.toString(); ui.view.undo(); assert.equal(ui.view.document.toString(), before, 'creation undo cannot remove a retained embedded draft');
  assert.match(String(ui.errors.at(-1)), /unsaved changes/);
  ui.recover(); await ui.view.flush(); ui.view.undo(); await ui.view.flush(); assert.equal(ui.view.document.toString(), '');
});

test('a failed embedded flush keeps the shared Live editor mounted until retry succeeds', async t => {
  const ui = setup(t); ui.item().dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick();
  const content = ui.item().querySelector<HTMLElement>('.cm-content')!, cm = EditorView.findFromDOM(content)!;
  assert.ok(cm); ui.dirty(new Error('Base save failed')); ui.key('Escape', content); await tick();
  assert.equal(ui.item().classList.contains('is-editing'), true); assert.equal(EditorView.findFromDOM(content), cm); assert.equal(ui.view.hasPendingChanges(), true);
  await assert.rejects(ui.view.flush(), /Base save failed/); assert.equal(ui.view.document.toString(), initial); assert.equal(ui.saves.length, 0);
  ui.recover(); ui.key('Escape', content); await tick(); await ui.view.flush();
  assert.equal(ui.item().classList.contains('is-editing'), false); assert.equal(EditorView.findFromDOM(content), cm); assert.equal(ui.view.hasPendingChanges(), false);
});

test('retained pane drafts remain visible to flush and pending checks with no mounted text cards', async t => {
  const ui = setup(t, ''); ui.dirty(new Error('Detached widget draft'));
  assert.equal(ui.view.hasPendingChanges(), true); await assert.rejects(ui.view.flush(), /Detached widget draft/); assert.equal(ui.flushes(), 1);
  ui.recover(); await ui.view.flush(); assert.equal(ui.view.hasPendingChanges(), false); assert.equal(ui.saves.length, 0);
});
