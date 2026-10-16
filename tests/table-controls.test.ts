import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import { tableActionsAt } from '../src/editor/live-tables.ts';

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

const source = 'Before\n\n| A | B |\n| :--- | ---: |\n| alpha | beta |\n\nAfter';

test('tables expose named plus controls alongside the grid', t => {
  const { button, host, editor } = setup(t, source);
  for (const [kind, label] of [['row', 'Add row below'], ['column', 'Add column to the right']] as const) {
    assert.equal(button(kind).tagName, 'BUTTON'); assert.equal(button(kind).type, 'button');
    assert.equal(button(kind).textContent, '+'); assert.equal(button(kind).getAttribute('aria-label'), label);
    assert.equal(button(kind).title, label);
    assert.equal(button(kind).parentElement, host.querySelector('table')!.parentElement);
  }
  assert.equal(editor.getValue(), source);
});

test('bottom plus appends an empty row, focuses its first cell and supports parent undo/redo', async t => {
  const { button, click, editor, active, host, view, changes, dom, activate } = setup(t, source);
  const child = activate(1, 1);
  child.dispatch({ selection: { anchor: child.state.doc.length } });
  child.dispatch(child.state.replaceSelection('!'));
  const edited = source.replace('beta', 'beta!');
  const down = new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
  button('row').dispatchEvent(down);
  assert.equal(down.defaultPrevented, true); assert.equal(child.hasFocus, true);
  click(button('row'));
  const added = edited.replace('| alpha | beta! |', '| alpha | beta! |\n|  |  |');
  assert.equal(editor.getValue(), added); assert.equal(changes.length, 2);
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 3, column 1');
  assert.equal(active().hasFocus, true); assert.equal(active().state.doc.length, 0);
  assert.equal(host.querySelectorAll('tbody tr').length, 2);
  assert.equal(undo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), edited, 'undoing the control retains the preceding cell edit');
  assert.equal(host.querySelectorAll('tbody tr').length, 1);
  assert.equal(redo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), added);
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 3, column 1');
});

test('side plus appends an unaligned column and focuses its header for immediate typing', async t => {
  const { button, click, editor, active, host, view } = setup(t, source);
  click(button('column'));
  assert.equal(editor.getValue(), 'Before\n\n| A | B |  |\n| :--- | ---: | --- |\n| alpha | beta |  |\n\nAfter');
  assert.equal(host.querySelectorAll('th').length, 3);
  assert.equal((host.querySelectorAll('th')[2] as HTMLElement).style.textAlign, '');
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 1, column 3');
  active().dispatch(active().state.replaceSelection('New'));
  assert.match(editor.getValue(), /\| A \| B \| +New *\|/);
  assert.equal(active().state.doc.toString(), 'New');
  assert.equal(undo(view), true); await Promise.resolve();
  assert.ok(editor.getValue().includes('| A | B |  |'), 'typing has its own history entry');
  assert.equal(undo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), source);
});

test('repeated add actions and nearby note edits resolve the current table source range', t => {
  const { button, click, editor, view, host } = setup(t, source);
  view.dispatch({ changes: { from: 0, insert: 'Prefix\n' } });
  click(button('column')); click(button('row')); click(button('column'));
  assert.ok(editor.getValue().startsWith('Prefix\nBefore\n\n'));
  assert.ok(editor.getValue().endsWith('\n\nAfter'));
  assert.equal(host.querySelectorAll('th').length, 4); assert.equal(host.querySelectorAll('tbody tr').length, 2);
  assert.ok(editor.getValue().includes('| :--- | ---: | --- | --- |'));
});

test('removed table controls cannot edit a replacement document', t => {
  const { button, click, editor, destroy } = setup(t, source);
  const row = button('row'), column = button('column');
  editor.setValue('Replacement'); click(row); click(column);
  assert.equal(editor.getValue(), 'Replacement');
  destroy(); click(row); click(column);
  assert.equal(editor.getValue(), 'Replacement');
});

test('table add actions respect a read-only owner', t => {
  const { button, click, editor, view, host } = setup(t, source);
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  click(button('row')); click(button('column'));
  const actions = tableActionsAt(view, host.querySelector('td')!);
  assert.equal(actions.length, 4); assert.ok(actions.every(action => !action.enabled && !action.run()));
  assert.equal(editor.getValue(), source);
});

test('cell menu actions insert relative to that cell and inherit its column alignment', t => {
  const { host, view, editor, active } = setup(t, source);
  const cell = host.querySelector<HTMLElement>('td[data-column="1"]')!;
  const actions = tableActionsAt(view, cell);
  assert.deepEqual(actions.map(action => action.id), ['row-before', 'row-after', 'column-before', 'column-after']);
  assert.equal(actions.find(action => action.id === 'column-before')!.run(), true);
  assert.equal(editor.getValue(), 'Before\n\n| A |  | B |\n| :--- | ---: | ---: |\n| alpha |  | beta |\n\nAfter');
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 2, column 2');
  assert.equal(actions.find(action => action.id === 'row-after')!.run(), false, 'a completed structural action invalidates the old menu');
});

test('menu actions survive normal cell-editor blur but reject edits made while a menu is open', async t => {
  const { host, view, editor, activate, dom } = setup(t, source);
  const child = activate(1, 0);
  const actions = tableActionsAt(view, child.contentDOM);
  view.focus(); await Promise.resolve();
  assert.equal(host.querySelector('.cm-live-table .cm-editor'), null);
  assert.equal(actions.find(action => action.id === 'row-after')!.run(), true);
  const later = tableActionsAt(view, host.querySelector('td')!);
  editor.setValue(editor.getValue().replace('alpha', 'changed'));
  assert.ok(later.every(action => !action.run()));
  assert.deepEqual(tableActionsAt(view, dom.window.document.body), []);
});

test('a pending cell action follows its owning table through edits before the table', t => {
  const { host, view, editor, active } = setup(t, source);
  const actions = tableActionsAt(view, host.querySelector<HTMLElement>('td[data-column="1"]')!);
  editor.setValue('Prefix\n' + source);
  assert.equal(actions.find(action => action.id === 'row-before')!.run(), true);
  assert.equal(editor.getValue(), 'Prefix\n' + source.replace('| alpha | beta |', '|  |  |\n| alpha | beta |'));
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 2, column 2');
});
