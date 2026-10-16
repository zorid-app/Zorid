import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CanvasDocument } from '../src/canvas/document.ts';
import { createCanvasView, projectCanvas } from '../src/canvas/view.ts';

const node = (id: string, type = 'text', extra = {}) => ({ id, type, x: 0, y: 0, width: 180, height: 100, text: id, ...extra });
const fixture = JSON.stringify({ plugin: { keep: true }, nodes: [
  node('a'), node('b', 'file', { x: 300, file: 'Notes/B.md', subpath: '#Part' }),
  node('c', 'link', { x: 600, url: 'https://example.test/' }),
  node('g', 'group', { x: -20, y: -20, width: 850, height: 200, label: 'Group' }),
  node('hidden', 'unknown', { config: { retain: true } }),
], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: 'Relationship' }, { id: 'orphan', fromNode: 'a', toNode: 'missing', plugin: true }] }, null, '\t');

function setup(source = fixture, onChange?: (source: string) => Promise<void> | void) {
  const dom = new JSDOM('<!doctype html><main></main>', { pretendToBeVisual: true });
  const container = dom.window.document.querySelector('main')!, saves: string[] = [], files: string[] = [], links: string[] = [], errors: unknown[] = [];
  const document = CanvasDocument.parse(source);
  const view = createCanvasView(container, { document, onChange: async source => { saves.push(source); await onChange?.(source); }, openFile: (path, subpath) => { files.push(path + (subpath ?? '')); }, openLink: url => { links.push(url); }, onError: error => { errors.push(error); } });
  const viewport = container.querySelector<HTMLElement>('.zorid-canvas-viewport')!;
  const item = (id: string) => [...container.querySelectorAll<HTMLElement>('[data-node-id]')].find(element => element.dataset.nodeId === id)!;
  const pointer = (target: Element, type: string, x: number, y: number, extra = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...extra });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } });
    target.dispatchEvent(event);
  };
  const key = (key: string, extra = {}, target: Element = viewport) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...extra }));
  const close = () => { view.destroy(); dom.window.close(); };
  return { dom, container, document, view, viewport, item, pointer, key, saves, files, links, errors, close };
}

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
  const ui = setup(), beforeNode = ui.item('a'), edge = ui.container.querySelector('path[marker-end]')!, initialPath = edge.getAttribute('d');
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
  const input = ui.container.querySelector<HTMLTextAreaElement>('textarea')!; assert.ok(input);
  input.value = '<img src=x onerror=alert(1)>\nnew'; ui.key('Delete', {}, input); assert.ok(ui.document.getNode('a'));
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
  assert.equal(ui.item('a').getAttribute('aria-selected'), 'true'); assert.equal(ui.item('b').getAttribute('aria-selected'), 'false');
  assert.equal(ui.saves.length, 0); ui.key('Escape'); assert.equal(ui.item('a').getAttribute('aria-selected'), 'false'); ui.close();
});

test('add card and blur commit preserve empty canvas and support undo; Escape cancels text edits', async () => {
  const ui = setup('');
  [...ui.container.querySelectorAll('button')].find(button => button.textContent === 'Add card')!.click();
  const input = ui.container.querySelector<HTMLTextAreaElement>('textarea')!; input.value = 'New card'; input.blur(); await ui.view.flush();
  assert.equal(ui.document.nodes.length, 1); assert.equal(ui.document.nodes[0].text, 'New card');
  ui.item(ui.document.nodes[0].id).dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const second = ui.container.querySelector<HTMLTextAreaElement>('textarea')!; second.value = 'Discarded'; ui.key('Escape', {}, second); await ui.view.flush();
  assert.equal(ui.document.nodes[0].text, 'New card');
  ui.view.undo(); ui.view.undo(); await ui.view.flush(); assert.equal(ui.document.toString(), ''); ui.close();
});

test('flush commits active text and waits for its write before teardown without a late blur write', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const ui = setup(fixture, () => gate);
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = ui.container.querySelector<HTMLTextAreaElement>('textarea')!; input.value = 'Valuable pending text';
  let settled = false; const flushing = ui.view.flush().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.document.getNode('a')!.text, 'Valuable pending text'); assert.equal(ui.saves.length, 1); assert.equal(settled, false);
  assert.equal(JSON.parse(ui.saves[0]).nodes[0].text, 'Valuable pending text');
  release(); await flushing; ui.view.destroy(); input.dispatchEvent(new ui.dom.window.FocusEvent('blur'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ui.saves.length, 1); ui.close();
});

test('flush rejects failed persistence, retains current source and retries once for concurrent later flushes', async () => {
  let failing = true;
  const ui = setup(fixture, async () => { if (failing) throw new Error('disk unavailable'); });
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  ui.container.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Retain unsaved content';
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
  const input = ui.container.querySelector<HTMLTextAreaElement>('textarea')!; input.value = 'Unflushed teardown draft';
  ui.view.destroy(); add.click(); open.click(); input.dispatchEvent(new ui.dom.window.FocusEvent('blur'));
  ui.key('Enter', { ctrlKey: true }, input); ui.pointer(card, 'pointerdown', 0, 0); ui.pointer(ui.viewport, 'pointermove', 10, 0); ui.pointer(ui.viewport, 'pointerup', 10, 0);
  await ui.view.flush(); assert.equal(ui.document.toString(), fixture); assert.equal(ui.saves.length, 0); assert.equal(ui.files.length, 0); ui.close();
});

test('pending changes tracks edited drafts, queued writes and failures until successful retry', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let failing = true;
  const ui = setup(fixture, async () => { await gate; if (failing) throw new Error('pending save failed'); });
  assert.equal(ui.view.hasPendingChanges(), false);
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = ui.container.querySelector<HTMLTextAreaElement>('textarea')!;
  assert.equal(ui.view.hasPendingChanges(), false); input.value = 'draft'; assert.equal(ui.view.hasPendingChanges(), true);
  input.value = 'a'; assert.equal(ui.view.hasPendingChanges(), false); input.value = 'draft';
  const flushing = ui.view.flush(); assert.equal(ui.container.querySelector('textarea'), null); assert.equal(ui.view.hasPendingChanges(), true);
  const rejected = assert.rejects(flushing, /pending save failed/); release(); await rejected;
  assert.equal(ui.view.hasPendingChanges(), true);
  failing = false; const retry = ui.view.flush(); assert.equal(ui.view.hasPendingChanges(), true); await retry;
  assert.equal(ui.view.hasPendingChanges(), false); assert.equal(ui.document.getNode('a')!.text, 'draft');
  ui.item('a').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true }));
  const next = ui.container.querySelector<HTMLTextAreaElement>('textarea')!; next.value = 'cancel'; assert.equal(ui.view.hasPendingChanges(), true);
  ui.key('Escape', {}, next); assert.equal(ui.view.hasPendingChanges(), false); ui.close();
});
