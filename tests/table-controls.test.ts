import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Compartment, EditorState, StateEffect, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import { retainTableEditor, tableActionsAt, tableMenuAt } from '../src/editor/live-tables.ts';
import type { TableAction, TableMenuItem } from '../src/editor/live-tables.ts';
import { parseTable } from '../src/editor/table-model.ts';

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
  assert.equal(actions.length, 15); assert.ok(actions.every(action => !action.enabled && !action.run()));
  assert.equal(editor.getValue(), source);
});

test('cell menu actions insert relative to that cell and inherit its column alignment', t => {
  const { host, view, editor, active } = setup(t, source);
  const cell = host.querySelector<HTMLElement>('td[data-column="1"]')!;
  const actions = tableActionsAt(view, cell);
  assert.ok(actions.some(action => action.id === 'column-before'));
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

test('new cells inherit read-only state and boundary navigation cannot create rows', t => {
  const { view, activate, active, dom, editor } = setup(t, source);
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  const key = (key: string, shiftKey = false) => active().contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, code: key, shiftKey, bubbles: true, cancelable: true }));
  const last = activate(1, 1);
  assert.equal(last.state.readOnly, true);
  key('Tab'); key('Enter'); key('Enter', true); key('Backspace');
  assert.equal(editor.getValue(), source);
  activate(0, 0); key('Tab', true);
  assert.equal(editor.getValue(), source);
  key('Tab');
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 1, column 2', 'navigation among existing cells remains available');
  assert.equal(active().state.readOnly, true);
});

test('an open cell follows read-only changes for typing and paste but still receives owner snapshots', t => {
  const { view, activate, active, dom, editor, changes } = setup(t, source);
  const mode = new Compartment();
  view.dispatch({ effects: StateEffect.appendConfig.of(mode.of(EditorState.readOnly.of(false))) });
  const child = activate(1, 0);
  view.dispatch({ effects: mode.reconfigure(EditorState.readOnly.of(true)) });
  assert.equal(active(), child); assert.equal(child.state.readOnly, true);
  child.dispatch({ ...child.state.replaceSelection('blocked'), annotations: Transaction.userEvent.of('input.type') });
  assert.equal(child.state.doc.toString(), 'alpha');
  const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: (format: string) => format === 'text/plain' ? 'pasted' : '', types: ['text/plain'], files: [], items: [] } });
  child.contentDOM.dispatchEvent(paste);
  assert.equal(editor.getValue(), source); assert.deepEqual(changes, []);
  editor.setValue(source.replace('alpha', 'external'));
  assert.equal(child.state.doc.toString(), 'external'); assert.deepEqual(changes, []);
  view.dispatch({ effects: mode.reconfigure(EditorState.readOnly.of(false)) });
  assert.equal(child.state.readOnly, false);
  child.dispatch({ selection: { anchor: child.state.doc.length } });
  child.dispatch({ ...child.state.replaceSelection('!'), annotations: Transaction.userEvent.of('input.type') });
  assert.equal(editor.getValue(), source.replace('alpha', 'external!'));
  assert.deepEqual(changes, [source.replace('alpha', 'external!')]);
});

function menuShape(items: TableMenuItem[]): unknown[] {
  return items.map(item => 'submenu' in item ? { label: item.label, submenu: menuShape(item.submenu) }
    : 'id' in item ? item.label : '|');
}
function runCellAction(host: HTMLElement, view: EditorView, id: TableAction['id'], row = 1, column = 1) {
  const cell = host.querySelector<HTMLElement>(`.cm-live-table [data-row="${row}"][data-column="${column}"]`)!;
  const action = tableActionsAt(view, cell).find(action => action.id === id);
  assert.ok(action, `${id} is present`); assert.equal(action.enabled, true);
  assert.equal(action.run(), true);
}
function currentTable(value: string) { const model = parseTable(value.slice(value.indexOf('|'))); assert.ok(model); return model; }

test('single-cell menus expose the observed submenu order and omit unavailable edge moves', t => {
  const { host, view } = setup(t, source);
  const header = host.querySelector<HTMLElement>('th')!;
  assert.deepEqual(menuShape(tableMenuAt(view, header)), [
    { label: 'Row', submenu: ['Add row above', 'Add row below', '|', 'Move row down', '|', 'Duplicate row', 'Delete row'] },
    { label: 'Column', submenu: ['Add column to the left', 'Add column to the right', '|', 'Move column right', '|', 'Align left', 'Align center', 'Align right', '|', 'Duplicate column', 'Delete column'] },
    '|', 'Sort by column (A to Z)', 'Sort by column (Z to A)',
  ]);
  const last = host.querySelector<HTMLElement>('td[data-column="1"]')!;
  const ids = tableActionsAt(view, last).map(item => item.id);
  assert.ok(ids.includes('row-up')); assert.ok(ids.includes('column-left'));
  assert.ok(!ids.includes('row-down')); assert.ok(!ids.includes('column-right'));
  assert.ok(tableActionsAt(view, last).every(item => !('checked' in item)), 'alignment entries have no invented checked state');
});

test('row menu actions move and duplicate headers and focus the source-derived destination', async t => {
  const { host, view, editor, active } = setup(t, source);
  runCellAction(host, view, 'row-up');
  assert.deepEqual(currentTable(editor.getValue()).rows.map(row => row.cells[0].text), ['alpha', 'A']);
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 1, column 2');
  assert.equal(undo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), source);
  runCellAction(host, view, 'row-duplicate', 0, 0);
  assert.deepEqual(currentTable(editor.getValue()).rows.map(row => row.cells[0].text), ['A', 'A', 'alpha']);
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 2, column 1');
  runCellAction(host, view, 'row-delete', 0, 0);
  assert.deepEqual(currentTable(editor.getValue()).rows.map(row => row.cells[0].text), ['A', 'alpha']);
  runCellAction(host, view, 'row-down', 0, 0);
  assert.deepEqual(currentTable(editor.getValue()).rows.map(row => row.cells[0].text), ['alpha', 'A']);
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 2, column 1');
});

test('column menu actions move alignment with cells, duplicate raw data and focus the remaining column', async t => {
  const { host, view, editor, active } = setup(t, source);
  runCellAction(host, view, 'column-left');
  assert.deepEqual(currentTable(editor.getValue()).alignments, ['right', 'left']);
  assert.deepEqual(currentTable(editor.getValue()).rows[1].cells.map(cell => cell.text), ['beta', 'alpha']);
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 2, column 1');
  runCellAction(host, view, 'column-right', 1, 0);
  assert.equal(editor.getValue(), source);
  runCellAction(host, view, 'column-duplicate');
  assert.deepEqual(currentTable(editor.getValue()).alignments, ['left', 'right', 'right']);
  assert.deepEqual(currentTable(editor.getValue()).rows[1].cells.map(cell => cell.text), ['alpha', 'beta', 'beta']);
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 2, column 3');
  runCellAction(host, view, 'column-delete', 1, 2);
  assert.equal(editor.getValue(), source);
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 2, column 2');
  assert.equal(undo(view), true); await Promise.resolve();
  assert.equal(currentTable(editor.getValue()).columnCount, 3);
});

test('deleting a sole row or column removes the table and supports note-level undo', async t => {
  const single = 'Before\n\n| Only |\n| --- |\n\nAfter';
  const { host, view, editor } = setup(t, single);
  for (const id of ['row-delete', 'column-delete'] as const) {
    runCellAction(host, view, id, 0, 0);
    assert.equal(editor.getValue(), 'Before\n\n\n\nAfter');
    assert.equal(host.querySelector('.cm-live-table'), null); assert.equal(view.hasFocus, true);
    assert.equal(view.state.selection.main.head, 'Before\n\n'.length);
    assert.equal(undo(view), true); await Promise.resolve();
    assert.equal(editor.getValue(), single); assert.ok(host.querySelector('.cm-live-table'));
  }
});

test('alignment actions preserve the active cell selection and use logical start/end in RTL', t => {
  const { host, view, editor, activate, active } = setup(t, source);
  const child = activate(1, 1);
  child.dispatch({ selection: { anchor: 1, head: 3 } });
  runCellAction(host, view, 'align-center');
  assert.deepEqual(currentTable(editor.getValue()).alignments, ['left', 'center']);
  assert.equal(active().state.selection.main.anchor, 1); assert.equal(active().state.selection.main.head, 3);
  (host.querySelector('table') as HTMLElement).style.direction = 'rtl';
  runCellAction(host, view, 'align-left');
  assert.deepEqual(currentTable(editor.getValue()).alignments, ['left', 'right']);
  (host.querySelector('table') as HTMLElement).style.direction = 'rtl';
  runCellAction(host, view, 'align-right');
  assert.deepEqual(currentTable(editor.getValue()).alignments, ['left', 'left']);
});

test('sort menu compares rendered text naturally, keeps stable ties and excludes the header', async t => {
  const sortedSource = '| Name | Id |\n| --- | --- |\n| [Item 10](https://example.test) | a |\n| **Item 2** | b |\n| item 2 | c |\n| Item 1 | d |';
  const { host, view, editor, activate, active } = setup(t, sortedSource);
  activate(1, 0); // The active cell contains source punctuation rather than rendered text.
  runCellAction(host, view, 'sort-ascending', 1, 0);
  assert.deepEqual(currentTable(editor.getValue()).rows.map(row => row.cells[1].text), ['Id', 'd', 'b', 'c', 'a']);
  assert.equal(active().contentDOM.getAttribute('aria-label'), 'Table row 2, column 1');
  runCellAction(host, view, 'sort-descending', 1, 0);
  assert.deepEqual(currentTable(editor.getValue()).rows.map(row => row.cells[1].text), ['Id', 'a', 'b', 'c', 'd']);
  assert.equal(undo(view), true); await Promise.resolve();
  assert.deepEqual(currentTable(editor.getValue()).rows.map(row => row.cells[1].text), ['Id', 'd', 'b', 'c', 'a']);
});

test('menu movement and alignment retain an unbordered cell ending in a literal backslash', async t => {
  const value = 'A | B\n--- | ---\nx | tail\\';
  const { host, view, editor } = setup(t, value);
  runCellAction(host, view, 'column-left', 1, 1);
  assert.deepEqual(currentTable(editor.getValue()).rows[1].cells.map(cell => cell.text), ['tail\\', 'x']);
  assert.equal(undo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), value);
  runCellAction(host, view, 'align-center', 1, 1);
  assert.deepEqual(currentTable(editor.getValue()).rows[1].cells.map(cell => cell.text), ['x', 'tail\\']);
});

test('typing a backslash in a compact cell preserves the delimiter, mapped caret and subsequent input', async t => {
  const value = 'A|B\n---|---\nx|y';
  const { editor, view, activate, active, host } = setup(t, value);
  const child = activate(1, 0);
  child.dispatch({ selection: { anchor: 1 } });
  child.dispatch({ ...child.state.replaceSelection('\\'), annotations: Transaction.userEvent.of('input.type') });
  assert.equal(editor.getValue(), 'A|B\n---|---\nx\\ |y');
  assert.equal(active(), child); assert.equal(child.state.doc.toString(), 'x\\');
  assert.equal(child.state.selection.main.head, 2);
  assert.equal(view.state.selection.main.head, editor.getValue().indexOf('x\\') + 2);
  child.dispatch({ ...child.state.replaceSelection('z\\'), annotations: Transaction.userEvent.of('input.type') });
  assert.equal(editor.getValue(), 'A|B\n---|---\nx\\z\\ |y');
  assert.equal(child.state.doc.toString(), 'x\\z\\'); assert.equal(host.querySelectorAll('td').length, 2);
  assert.equal(view.state.selection.main.head, editor.getValue().indexOf('x\\') + 4);
  assert.equal(undo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), value);
  assert.equal(redo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), 'A|B\n---|---\nx\\z\\ |y');
  assert.equal(active().state.doc.toString(), 'x\\z\\');
});

test('replacing a bordered last cell with a backslash keeps source padding outside its editor range', async t => {
  const value = '|A|B|\n|---|---|\n|x|y|';
  const { editor, view, activate, active } = setup(t, value);
  const child = activate(1, 1);
  child.dispatch({ selection: { anchor: 0, head: 1 } });
  child.dispatch({ ...child.state.replaceSelection('tail\\'), annotations: Transaction.userEvent.of('input.paste') });
  assert.equal(editor.getValue(), '|A|B|\n|---|---|\n|x|tail\\ |');
  assert.equal(child.state.doc.toString(), 'tail\\'); assert.equal(child.state.selection.main.head, 5);
  assert.equal(view.state.selection.main.head, editor.getValue().indexOf('tail') + 5);
  child.dispatch({ selection: { anchor: 5, head: 0 } });
  assert.equal(view.state.selection.main.anchor, editor.getValue().indexOf('tail') + 5);
  assert.equal(view.state.selection.main.head, editor.getValue().indexOf('tail'));
  assert.equal(undo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), value);
  assert.equal(redo(view), true); await Promise.resolve();
  assert.equal(editor.getValue(), '|A|B|\n|---|---|\n|x|tail\\ |');
  const restored = active();
  restored.dispatch({ selection: { anchor: restored.state.doc.length } });
  restored.dispatch({ ...restored.state.replaceSelection('!'), annotations: Transaction.userEvent.of('input.type') });
  assert.equal(editor.getValue(), '|A|B|\n|---|---|\n|x|tail\\! |');
});


test('table editor holds survive menu blur until the last idempotent release', async t => {
  const { view, activate, host } = setup(t, source);
  const child = activate(1, 0);
  child.dispatch({ selection: { anchor: 1, head: 4 } });
  const releaseA = retainTableEditor(view, child.contentDOM), releaseB = retainTableEditor(view, child.contentDOM);
  view.focus(); await Promise.resolve();
  assert.equal(child.dom.isConnected, true);
  assert.equal(child.state.sliceDoc(child.state.selection.main.from, child.state.selection.main.to), 'lph');
  releaseA(); releaseA(); await Promise.resolve();
  assert.equal(child.dom.isConnected, true, 'a second menu still owns a hold');
  releaseB();
  assert.equal(host.querySelector('.cm-live-table .cm-editor'), null);
  releaseB();
});

test('releasing a table editor hold preserves refocus and explicit structural actions', async t => {
  const { view, activate, active } = setup(t, source);
  const child = activate(1, 0), release = retainTableEditor(view, child.contentDOM);
  view.focus(); await Promise.resolve(); child.focus(); release(); await Promise.resolve();
  assert.equal(active(), child);
  const releaseAction = retainTableEditor(view, child.contentDOM);
  const action = tableActionsAt(view, child.contentDOM).find(action => action.id === 'row-after')!;
  view.focus(); await Promise.resolve();
  assert.equal(action.run(), true); releaseAction(); await Promise.resolve();
  assert.equal(child.dom.isConnected, false, 'structural changes can replace a held child');
  assert.equal(active().hasFocus, true);
});

test('table holds reject unrelated owners and release safely after destruction', async t => {
  const { view, activate, dom, destroy } = setup(t, source);
  const child = activate(1, 0);
  const unrelated = retainTableEditor(view, dom.window.document.body);
  const wrongOwner = retainTableEditor(child, child.contentDOM);
  view.focus(); await Promise.resolve();
  assert.equal(child.dom.isConnected, false, 'invalid holds do not suppress ordinary blur cleanup');
  unrelated(); wrongOwner();
  const next = activate(1, 1), release = retainTableEditor(view, next.contentDOM);
  destroy(); release(); release(); await Promise.resolve();
  assert.equal(next.dom.isConnected, false);
});
