import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
// Actual CM widgets and DOM events. Geometry stubs do not establish browser
// hover appearance, hit testing, touch, or reference runtime equivalence.
function setup(t: TestContext, value: string) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { pretendToBeVisual: true, url: 'https://app.local/index.html' });
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



const table = '| A | B |\n| --- | --- |\n| alpha | beta |';
const source = `Before\n\n${table}\n\nBetween\n\n${table}\n\nAfter`;

test('multiple parent ranges reveal only intersected tables and preserve source selection through undo', async t => {
  const { view, host, editor } = setup(t, source);
  view.focus();
  const second = host.querySelectorAll('.cm-live-table')[1];
  const start = source.indexOf('alpha'), end = source.indexOf('beta');
  const selection = EditorSelection.create([EditorSelection.range(start + 2, start), EditorSelection.cursor(end + 1)], 1);
  view.dispatch({ selection }); await Promise.resolve();
  assert.deepEqual(view.state.selection.toJSON(), selection.toJSON());
  assert.equal(host.querySelectorAll('.cm-live-table').length, 1);
  assert.equal(host.querySelector('.cm-live-table'), second);
  assert.ok(host.querySelector('.cm-content')!.textContent!.includes('| alpha | beta |'), 'intersected table source is available to parent selections');
  editor.insert('!');
  assert.equal(editor.getValue(), source.slice(0, start) + '!' + source.slice(start + 2, end + 1) + '!' + source.slice(end + 1));
  assert.equal(undo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), source); assert.deepEqual(view.state.selection.toJSON(), selection.toJSON());
  view.dispatch({ selection: { anchor: 0 } }); await Promise.resolve();
  assert.equal(host.querySelectorAll('.cm-live-table').length, 2);
  assert.equal(host.querySelectorAll('.cm-live-table')[1], second);
});

test('adding a parent caret while a table child is focused retains editable source focus', async t => {
  const { view, host, editor, activate } = setup(t, source);
  const child = activate(1, 0); assert.equal(child.hasFocus, true);
  const position = source.indexOf('alpha') + 2;
  const selection = EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(position)], 1);
  view.dispatch({ selection }); await Promise.resolve();
  assert.deepEqual(view.state.selection.toJSON(), selection.toJSON());
  assert.equal(host.querySelectorAll('.cm-live-table').length, 1);
  assert.equal(view.hasFocus, true);
  editor.insert('!'); assert.equal(editor.getValue(), source.slice(0, 2) + '!' + source.slice(2, position) + '!' + source.slice(position));
});

test('non-main ranges can reveal different tables and leaving them restores widgets', async t => {
  const { view, host } = setup(t, source + '\n\n' + table);
  view.focus();
  const third = host.querySelectorAll('.cm-live-table')[2];
  const first = source.indexOf('alpha'), second = source.lastIndexOf('beta');
  const selection = EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(first), EditorSelection.range(second + 2, second)], 0);
  view.dispatch({ selection }); await Promise.resolve();
  assert.deepEqual(view.state.selection.toJSON(), selection.toJSON());
  assert.equal(host.querySelectorAll('.cm-live-table').length, 1);
  assert.equal(host.querySelector('.cm-live-table'), third);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(4)], 0) }); await Promise.resolve();
  assert.equal(host.querySelectorAll('.cm-live-table').length, 3);
  assert.equal(host.querySelectorAll('.cm-live-table')[2], third);
  assert.equal(view.hasFocus, true);
});

test('deferred child focus transfer does not override an intervening control focus', async t => {
  const { view, activate } = setup(t, source);
  activate(1, 0);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(source.indexOf('alpha'))], 1) });
  const button = document.createElement('button'); document.body.append(button); button.focus();
  await Promise.resolve();
  assert.equal(document.activeElement, button);
  assert.equal(view.state.selection.ranges.length, 2);
});
