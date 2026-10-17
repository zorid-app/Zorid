import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CanvasDocument } from '../src/canvas/document.ts';
import { createCanvasEmbedPreview } from '../src/canvas/embed-preview.ts';

const node = (id: string, extra: object = {}) => ({ id, type: 'text', text: id, x: 0, y: 0, width: 100, height: 50, ...extra });
const source = JSON.stringify({ custom: { retained: true }, nodes: [node('a', { color: '6' }), node('b', { type: 'file', file: 'A.md', x: 300 }), node('g', { type: 'group', x: -20, y: -20, width: 440, height: 100 })], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', color: '#abc' }, { id: 'dangling', fromNode: 'a', toNode: 'gone' }] }, null, '\t') + '\n';
function setup(text: string | CanvasDocument = source, inline = true) {
  const dom = new JSDOM('<main></main>'), parent = dom.window.document.querySelector('main')!, events: Event[] = [], errors: unknown[] = [];
  const preview = createCanvasEmbedPreview(parent, { path: 'Boards/Courses.canvas', source: text, inline, onOpen: event => { events.push(event); }, onError: error => errors.push(error) });
  return { dom, parent, preview, events, errors, close() { preview.destroy(); dom.window.close(); } };
}

test('static preview preserves document bytes and draws group-edge-node layers with bounded padded viewBox', t => {
  const model = CanvasDocument.parse(source), ui = setup(model); t.after(ui.close);
  assert.equal(model.toString(), source); assert.equal(ui.preview.element.getAttribute('role'), 'link');
  assert.equal(ui.parent.querySelector('.zorid-canvas-embed-title')!.textContent, 'Courses');
  assert.ok(ui.parent.querySelector('.zorid-canvas-embed-title svg rect'), 'dashboard icon comes from shared upstream facade');
  const svg = ui.parent.querySelector<SVGSVGElement>('.zorid-canvas-minimap')!;
  assert.deepEqual([...svg.children].map(child => child.tagName), ['rect', 'path', 'rect', 'rect']);
  assert.equal(svg.getAttribute('viewBox'), '-42 -42 484 144'); assert.equal(svg.querySelectorAll('rect').length, 3); assert.equal(svg.querySelectorAll('path').length, 1);
  assert.equal(svg.firstElementChild!.getAttribute('rx'), '20');
  assert.match(svg.querySelector('[data-node-id="a"]')!.getAttribute('style')!, /canvas-color-6/);
  assert.equal(svg.querySelector('path')!.style.getPropertyValue('--preview-shape-color'), '#abc');
  assert.match(svg.querySelector('path')!.getAttribute('d')!, /^M 100 25 C /);
  assert.equal(ui.parent.querySelector('textarea,.cm-editor,iframe,img'), null); assert.deepEqual(ui.errors, []);
});

test('click and keyboard opening preserve the exact modifier event without claiming source-selection priority', async t => {
  const ui = setup(); t.after(ui.close);
  const click = new ui.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true, shiftKey: true }); ui.parent.querySelector('.zorid-canvas-embed-title')!.dispatchEvent(click);
  const middle = new ui.dom.window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1, ctrlKey: true }); ui.preview.element.dispatchEvent(middle);
  assert.equal(ui.events[0], click); assert.equal(ui.events[1], middle); assert.equal(click.defaultPrevented, false);
  const enter = new ui.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, altKey: true }); ui.preview.element.dispatchEvent(enter); assert.equal(ui.events[2], enter); assert.equal(enter.defaultPrevented, true);
  const prevented = new ui.dom.window.MouseEvent('click', { cancelable: true }); prevented.preventDefault(); ui.preview.element.dispatchEvent(prevented);
  ui.preview.element.dispatchEvent(new ui.dom.window.MouseEvent('click', { button: 2 })); ui.preview.element.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
  assert.equal(ui.events.length, 3);
});

test('malformed and overflowing updates retain the last valid SVG, report errors, and recover atomically', t => {
  const ui = setup(); t.after(ui.close); const original = ui.parent.querySelector('.zorid-canvas-minimap');
  assert.equal(ui.preview.update('{broken'), false); assert.equal(ui.parent.querySelector('.zorid-canvas-minimap'), original); assert.match(ui.parent.textContent!, /last valid preview/);
  for (const geometry of [{ x: 1e308, width: 1e308 }, { x: 1e100, width: 1e99 }, { x: 3e38, width: 1e38 }]) {
    assert.equal(ui.preview.update(JSON.stringify({ nodes: [node('bad', geometry)] })), false); assert.equal(ui.parent.querySelector('.zorid-canvas-minimap'), original);
  }
  assert.equal(ui.errors.length, 4);
  assert.equal(ui.preview.update(source), true); assert.equal(ui.parent.querySelector('.zorid-canvas-minimap'), original); assert.equal(ui.preview.element.classList.contains('has-error'), false);
  assert.equal(ui.preview.update(JSON.stringify({ nodes: [node('next', { text: '<script>alert(1)</script>', color: 'url(https://bad.test)' })], edges: [] })), true);
  assert.notEqual(ui.parent.querySelector('.zorid-canvas-minimap'), original); assert.equal(ui.parent.querySelector('script'), null); assert.equal(ui.parent.querySelector('.zorid-canvas-minimap rect')!.hasAttribute('style'), false);
});

test('initial invalid and empty canvases are safe navigation surfaces without fabricated minimap nodes', t => {
  const ui = setup('null', false); t.after(ui.close);
  assert.equal(ui.parent.querySelector('.zorid-canvas-embed-title'), null); assert.equal(ui.parent.querySelector('.zorid-canvas-minimap'), null); assert.match(ui.parent.textContent!, /Unable to display/);
  assert.equal(ui.preview.update('{"nodes":[],"edges":[]}'), true); assert.equal(ui.parent.querySelector('.zorid-canvas-minimap'), null); assert.match(ui.preview.element.getAttribute('aria-label')!, /empty/);
  ui.preview.element.click(); assert.equal(ui.events.length, 1);
});

test('existing document projection keeps unknown and duplicate records in source while rendering supported connected records', t => {
  const text = JSON.stringify({ nodes: [node('a'), node('a', { x: 50, text: 'Later' }), node('unknown', { type: 'extension-kind' })], edges: [] });
  const model = CanvasDocument.parse(text), ui = setup(model); t.after(ui.close);
  assert.equal(ui.parent.querySelectorAll('.zorid-canvas-minimap rect').length, 1); assert.equal(model.toString(), text); assert.equal(model.nodes.length, 3);
  model.setRoot('nodes', model.nodes.map((record, index) => index === 1 ? { ...record, x: 90 } : record)); assert.equal(ui.preview.update(model), true); assert.equal(ui.parent.querySelector('.zorid-canvas-minimap rect')!.getAttribute('x'), '90');
});

test('destroy owns DOM and handlers, ignores late callback rejection and does not affect other previews', async t => {
  const dom = new JSDOM('<main></main>'), parent = dom.window.document.querySelector('main')!, errors: unknown[] = []; let reject!: (error: unknown) => void, calls = 0;
  const first = createCanvasEmbedPreview(parent, { path: 'A.canvas', source, onOpen() { calls++; return new Promise((_, fail) => { reject = fail; }); }, onError: error => errors.push(error) });
  const second = createCanvasEmbedPreview(parent, { path: 'B.canvas', source, onOpen() { calls++; } }); t.after(() => { first.destroy(); second.destroy(); dom.window.close(); });
  const oldTitle = first.element.querySelector<HTMLElement>('.zorid-canvas-embed-title')!, original = second.element.querySelector('.zorid-canvas-minimap');
  assert.notEqual(first.element.getAttribute('aria-describedby'), second.element.getAttribute('aria-describedby'));
  oldTitle.click(); first.destroy(); first.destroy(); reject(new Error('Late failure')); await Promise.resolve(); await Promise.resolve(); oldTitle.click();
  assert.equal(first.update(source), false); assert.equal(calls, 1); assert.deepEqual(errors, []); assert.equal(second.element.querySelector('.zorid-canvas-minimap'), original); assert.equal(second.element.isConnected, true);
  second.element.click(); assert.equal(calls, 2);
});
