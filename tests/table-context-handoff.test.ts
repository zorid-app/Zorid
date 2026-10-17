import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import type { ContextMenuItem, ContextMenuRequest } from '../src/platform/context-menu.ts';
// Actual CM widgets and DOM events. Geometry stubs do not establish browser
// hover appearance, hit testing, touch, or reference runtime equivalence.
function setup(t: TestContext, value: string) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, entry] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: entry });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = document.querySelector<HTMLElement>('#host')!, changes: string[] = [];
  const editor = createEditor(host, { value, mode: 'live', paths: () => [], open() {}, onChange: value => changes.push(value) });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  let destroyed = false;
  const destroy = () => { if (!destroyed) { destroyed = true; editor.destroy(); } };
  t.after(() => {
    destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const click = (target: Element) => target.dispatchEvent(new dom.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
  const button = (kind: 'row' | 'column') => host.querySelector<HTMLButtonElement>(`.cm-table-add-${kind}`)!;
  const active = () => {
    const node = host.querySelector('.cm-live-table .cm-editor'); assert.ok(node);
    return EditorView.findFromDOM(node)!;
  };
  const activate = (row: number, column: number) => {
    const cell = host.querySelector<HTMLElement>(`.cm-live-table [data-row="${row}"][data-column="${column}"]`)!;
    assert.ok(cell);
    cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    return active();
  };
  return { dom, host, editor, view, changes, destroy, click, button, active, activate };
}


const source = '| A | B | C |\n| --- | --- | --- |\n| one | two | three |\n| four | **five** | six |';
function menuFixture(t: TestContext) {
  const fixture = setup(t, source), { dom, host } = fixture;
  const requests: ContextMenuRequest[] = [];
  let choose: (id: string | null) => void = () => {};
  Object.defineProperty(dom.window, 'zorid', { value: { showContextMenu(request: ContextMenuRequest) {
    requests.push(request); return new Promise<string | null>(resolve => { choose = resolve; });
  } } });
  const cell = (row: number, column: number) => host.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`)!;
  const mouse = (node: Element, type: string, init: MouseEventInit = {}) => {
    const event = new dom.window.MouseEvent(type, { button: 0, bubbles: true, cancelable: true, ...init }); node.dispatchEvent(event); return event;
  };
  const rectangle = () => { mouse(cell(1, 0), 'mousedown'); mouse(cell(1, 1), 'mousemove'); mouse(cell(1, 1), 'mouseup'); };
  const open = (node: Element) => mouse(node, 'contextmenu', { button: 2, clientX: 30, clientY: 40 });
  const flatten = (items: ContextMenuItem[]): ContextMenuItem[] => items.flatMap(item => 'submenu' in item ? [item, ...flatten(item.submenu)] : [item]);
  return { ...fixture, requests, choose: (id: string | null) => choose(id), cell, mouse, rectangle, open, flatten };
}

for (const nested of [true, false]) test(`right-click outside a rectangle resolves the new cell editor from ${nested ? 'rendered descendants' : 'the cell itself'}`, async t => {
  const f = menuFixture(t); f.rectangle();
  const target = nested ? f.cell(2, 1).querySelector('strong')! : f.cell(2, 1);
  assert.equal(f.host.querySelectorAll('.is-selected').length, 2);
  const event = f.open(target);
  assert.equal(f.requests.length, 1);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.requests[0].x, 30); assert.equal(f.requests[0].y, 40);
  const items = f.requests[0].items;
  assert.ok(items.some(item => 'role' in item && item.role === 'paste'));
  assert.ok(items.some(item => 'label' in item && item.label === 'Format'));
  assert.ok(items.some(item => 'label' in item && item.label === 'Row'));
  assert.ok(items.some(item => 'label' in item && item.label === 'Column'));
  assert.equal(f.host.querySelectorAll('.is-selected').length, 0);
  assert.equal(f.active().state.doc.toString(), '**five**');
  if (nested) assert.equal(target.isConnected, false, 'the original renderer target was replaced');
  f.choose('table-column-delete'); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.editor.getValue(), '| A | C |\n| --- | --- |\n| one | three |\n| four | six |');
  assert.equal(undo(f.view), true); assert.equal(f.editor.getValue(), source);
});

test('a delayed outside-selection menu cannot act after the newly focused cell changes', async t => {
  const f = menuFixture(t); f.rectangle(); f.open(f.cell(2,1).querySelector('strong')!);
  assert.equal(f.requests.length,1);
  f.active().dispatch({ changes: { from: 0, insert: 'changed ' } });
  const edited = f.editor.getValue(); f.choose('table-row-delete'); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.editor.getValue(), edited);
  assert.equal(f.host.querySelectorAll('tbody tr').length, 2);
});

test('right-click inside a rectangle retains selected commands and ignores earlier prevented events', async t => {
  const f = menuFixture(t); f.rectangle();
  f.cell(2,1).addEventListener('contextmenu', event => event.preventDefault(), { once: true });
  f.open(f.cell(2,1).querySelector('strong')!);
  assert.equal(f.requests.length, 0); assert.equal(f.host.querySelectorAll('.is-selected').length, 2);
  f.open(f.cell(1,1)); assert.equal(f.requests.length, 1);
  const items = f.flatten(f.requests[0].items);
  assert.ok(items.some(item => 'id' in item && item.id === 'table-delete-cells'));
  assert.ok(!items.some(item => 'id' in item && item.id === 'table-row-delete'));
  f.choose(null); await Promise.resolve();
});

test('readonly outside-selection menus preserve cell ownership and disable mutations', async t => {
  const f = menuFixture(t); f.rectangle();
  f.view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  f.open(f.cell(2,1).querySelector('strong')!);
  assert.equal(f.requests.length, 1); assert.equal(f.active().state.readOnly, true);
  const items = f.flatten(f.requests[0].items);
  for (const id of ['table-row-delete','table-column-delete','table-row-before','table-column-after']) {
    assert.equal(items.find(item => 'id' in item && item.id === id)?.enabled, false);
  }
  f.choose('table-row-delete'); await Promise.resolve(); assert.equal(f.editor.getValue(), source);
});

for (const [label, startRow, endRow, endColumn, expected] of [
  ['multiple complete rows', 1, 2, 2, '| A | B | C |\n| --- | --- | --- |\n'],
  ['multiple complete columns', 0, 2, 1, '| C |\n| --- |\n| three |\n| six |'],
] as const) test(`selection-dependent menu deletes ${label} and preserves parent undo`, async t => {
  const f = menuFixture(t);
  f.mouse(f.cell(startRow,0), 'mousedown'); f.mouse(f.cell(endRow,endColumn), 'mousemove'); f.mouse(f.cell(endRow,endColumn), 'mouseup');
  f.open(f.cell(endRow,endColumn));
  assert.equal(f.requests.length, 1);
  const items = f.flatten(f.requests[0].items);
  assert.ok(items.some(item => 'id' in item && item.id === 'table-delete-cells'));
  assert.ok(!items.some(item => 'id' in item && item.id === 'table-row-delete'));
  f.choose('table-delete-cells'); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.editor.getValue(), expected);
  assert.equal(undo(f.view), true); assert.equal(f.editor.getValue(), source);
});
