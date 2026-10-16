import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Compartment, EditorState, StateEffect, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import { handleTableClipboard, retainTableEditor, tableActionsAt, tableMenuAt, tableSelectionAt, tableSelectionRanges } from '../src/editor/live-tables.ts';
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


const selectionSource = '| A | B | C |\n| :--- | ---: | --- |\n| a | b | c |\n| d | e | f |\n| g | h | i |';
function selectionTools(fixture: ReturnType<typeof setup>) {
  const { host, dom, active } = fixture;
  const cell = (row: number, column: number) => host.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`)!;
  const pointer = (node: Element, type: string, extra: MouseEventInit = {}) => node.dispatchEvent(new dom.window.MouseEvent(type, { button: 0, bubbles: true, cancelable: true, ...extra }));
  const rectangle = (r1: number, c1: number, r2: number, c2: number) => {
    pointer(cell(r1,c1), 'mousedown'); pointer(cell(r2,c2), 'mousemove'); pointer(cell(r2,c2), 'mouseup');
  };
  const selected = () => [...host.querySelectorAll<HTMLElement>('td.is-selected,th.is-selected')].map(cell => [Number(cell.dataset.row),Number(cell.dataset.column)]);
  const key = (key: string, shiftKey = false) => active().contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  const clipboard = (type: string, supplied: Record<string,string> = {}) => {
    const values = { ...supplied }, event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => values[type] ?? '', setData: (type: string, value: string) => { values[type] = value; }, clearData: () => { for (const key of Object.keys(values)) delete values[key]; } } });
    active().contentDOM.dispatchEvent(event); return { values, event };
  };
  return { cell, pointer, rectangle, selected, key, clipboard };
}

test('pointer rectangles normalize reverse drag, suppress editing, and clear on ordinary click', t => {
  const fixture = setup(t, selectionSource), tools = selectionTools(fixture);
  tools.rectangle(3,2,1,1);
  assert.deepEqual(tools.selected(), [[1,1],[1,2],[2,1],[2,2],[3,1],[3,2]]);
  assert.equal(fixture.active().state.readOnly, true);
  fixture.active().dispatch(fixture.active().state.replaceSelection('blocked'));
  assert.equal(fixture.editor.getValue(), selectionSource);
  assert.equal(tableSelectionAt(fixture.view, tools.cell(2,2)), true);
  assert.deepEqual(tableSelectionRanges(fixture.view, tools.cell(2,2)).map(range => fixture.view.state.sliceDoc(range.from,range.to)), ['b','c','e','f','h','i']);
  tools.pointer(tools.cell(2,1),'mousedown'); tools.pointer(tools.cell(2,1),'mouseup');
  assert.deepEqual(tools.selected(), []); assert.equal(fixture.active().state.readOnly, false);
});

test('Shift click and boundary Shift arrows extend from the original cell and plain arrows collapse', t => {
  const fixture = setup(t, selectionSource), tools = selectionTools(fixture), child = fixture.activate(1,1);
  child.dispatch({ selection: { anchor: 1 } }); tools.key('ArrowRight',true); tools.key('ArrowDown',true);
  assert.deepEqual(tools.selected(), [[1,1],[1,2],[2,1],[2,2]]);
  tools.key('ArrowRight',true); assert.equal(tools.selected().length,4,'table edge clamps');
  tools.key('ArrowLeft'); assert.deepEqual(tools.selected(),[]);
  assert.equal(fixture.active().contentDOM.getAttribute('aria-label'),'Table row 2, column 2');
  assert.equal(fixture.active().state.selection.main.head,0);
  tools.pointer(tools.cell(3,0),'mousedown',{shiftKey:true}); tools.pointer(tools.cell(3,0),'mouseup');
  assert.deepEqual(tools.selected(),[[1,0],[1,1],[2,0],[2,1],[3,0],[3,1]]);
});

test('whole-axis grips select rows and columns including degenerate axes; their menus stay distinct', t => {
  const fixture = setup(t, selectionSource), tools = selectionTools(fixture);
  const row = tools.cell(2,0).querySelector('.cm-table-grip-row')!;
  tools.pointer(row,'mousedown'); tools.pointer(tools.cell(2,0),'mouseup');
  assert.deepEqual(tools.selected(),[[2,0],[2,1],[2,2]]);
  const rowMenu = tableMenuAt(fixture.view,tools.cell(2,0).querySelector<HTMLElement>('.cm-table-grip-row')!);
  assert.ok(rowMenu.length); assert.ok(rowMenu.every(item => !('role' in item) && !('submenu' in item)));
  const column = tools.cell(0,1).querySelector('.cm-table-grip-column')!;
  tools.pointer(column,'mousedown'); tools.pointer(tools.cell(0,1),'mouseup');
  assert.deepEqual(tools.selected(),[[0,1],[1,1],[2,1],[3,1]]);
  assert.equal((tableMenuAt(fixture.view,tools.cell(0,1).querySelector<HTMLElement>('.cm-table-grip-column')!)[0] as TableAction).id,'sort-ascending');
});

test('rectangle menu replaces row/column actions and preserves readonly copy capability', t => {
  const fixture = setup(t,selectionSource), tools = selectionTools(fixture); tools.rectangle(1,0,2,1);
  const menu = tableMenuAt(fixture.view,tools.cell(1,0));
  assert.deepEqual(menu.filter(item => 'role' in item).map(item => 'role' in item && item.role),['cut','copy','paste']);
  assert.deepEqual(tableActionsAt(fixture.view,tools.cell(1,0)).map(action => action.id),['align-left','align-center','align-right','clear-cells','delete-cells']);
  const mode = new Compartment(); fixture.view.dispatch({effects:StateEffect.appendConfig.of(mode.of(EditorState.readOnly.of(true)))});
  const readonly = tableMenuAt(fixture.view,tools.cell(1,0));
  assert.equal(readonly.find(item => 'role' in item && item.role === 'copy')!.enabled,true);
  assert.ok(tableActionsAt(fixture.view,tools.cell(1,0)).every(action => !action.enabled && !action.run()));
});

test('partial rectangle Delete clears cells as one parent history operation', async t => {
  const fixture=setup(t,selectionSource),tools=selectionTools(fixture);tools.rectangle(1,1,2,2);tools.key('Delete');
  assert.deepEqual(currentTable(fixture.editor.getValue()).rows.map(row=>row.cells.map(cell=>cell.text)),[['A','B','C'],['a','',''],['d','',''],['g','h','i']]);
  assert.equal(fixture.active().contentDOM.getAttribute('aria-label'),'Table row 3, column 3');
  assert.equal(undo(fixture.view),true);await Promise.resolve();assert.equal(fixture.editor.getValue(),selectionSource);
  assert.equal(redo(fixture.view),true);await Promise.resolve();assert.equal(currentTable(fixture.editor.getValue()).rows[2].cells[2].text,'');
});

test('multiple whole rows and columns delete structurally with directional focus', t => {
  const fixture=setup(t,selectionSource),tools=selectionTools(fixture);tools.rectangle(1,0,2,2);tools.key('Backspace');
  assert.deepEqual(currentTable(fixture.editor.getValue()).rows.map(row=>row.cells.map(cell=>cell.text)),[['A','B','C'],['g','h','i']]);
  assert.equal(fixture.active().contentDOM.getAttribute('aria-label'),'Table row 1, column 3');
  tools.rectangle(0,0,1,1);tools.key('Delete');
  assert.deepEqual(currentTable(fixture.editor.getValue()).rows.map(row=>row.cells.map(cell=>cell.text)),[['C'],['i']]);
});

test('row-edge and entire-table deletion leave source focus and undo cleanly', async t => {
  const fixture=setup(t,selectionSource),tools=selectionTools(fixture);tools.rectangle(0,0,1,2);tools.key('Delete');
  assert.equal(fixture.editor.getValue().startsWith('\n| d | e | f |'),true);assert.equal(fixture.view.state.selection.main.head,0);
  undo(fixture.view);await Promise.resolve();assert.equal(fixture.editor.getValue(),selectionSource);
  tools.rectangle(0,0,3,2);tools.key('Backspace');assert.equal(fixture.editor.getValue(),'');
  undo(fixture.view);await Promise.resolve();assert.equal(fixture.editor.getValue(),selectionSource);
});

test('clipboard copy emits four table formats and cut uses structural rectangle deletion', t => {
  const fixture=setup(t,selectionSource),tools=selectionTools(fixture);tools.rectangle(1,1,2,2);
  const copy=tools.clipboard('copy');assert.equal(copy.event.defaultPrevented,true);
  assert.deepEqual(Object.keys(copy.values).sort(),['obsidian/table','text/html','text/markdown','text/plain']);
  assert.deepEqual(JSON.parse(copy.values['obsidian/table']),{rows:[['b','c'],['e','f']],alignment:['right',null]});
  assert.equal(copy.values['text/plain'],copy.values['text/markdown']);assert.match(copy.values['text/html'],/^<!-- obsidian --><table>/);
  tools.rectangle(1,0,2,2);tools.clipboard('cut');assert.equal(currentTable(fixture.editor.getValue()).rows.length,2);
});

test('structured rectangle paste starts at top-left and expands once, rejecting malformed data', t => {
  const fixture=setup(t,selectionSource),tools=selectionTools(fixture);tools.rectangle(3,2,2,1);
  tools.clipboard('paste',{'obsidian/table':'{}'});assert.equal(fixture.editor.getValue(),selectionSource);
  const data={rows:[['X','Y','Z'],['P','Q','R'],['S','T','U']],alignment:['center','left','right']};
  const pasted=tools.clipboard('paste',{'obsidian/table':JSON.stringify(data)});assert.equal(pasted.event.defaultPrevented,true);
  const model=currentTable(fixture.editor.getValue());assert.equal(model.rows.length,5);assert.equal(model.columnCount,4);
  assert.deepEqual(model.rows[2].cells.map(cell=>cell.text),['d','X','Y','Z']);assert.deepEqual(model.rows[4].cells.map(cell=>cell.text),['','S','T','U']);
  assert.equal(fixture.active().contentDOM.getAttribute('aria-label'),'Table row 5, column 4');
});

test('row grip drag reorders without losing data, keeps axis selected, and can undo', async t => {
  const fixture=setup(t,selectionSource),tools=selectionTools(fixture);
  const grip=tools.cell(1,0).querySelector('.cm-table-grip-row')!;tools.pointer(grip,'mousedown');
  tools.pointer(tools.cell(3,0),'mousemove',{clientY:10});tools.pointer(tools.cell(3,0),'mouseup');
  assert.deepEqual(currentTable(fixture.editor.getValue()).rows.map(row=>row.cells[0].text),['A','d','g','a']);
  assert.deepEqual(tools.selected(),[[3,0],[3,1],[3,2]]);
  undo(fixture.view);await Promise.resolve();assert.equal(fixture.editor.getValue(),selectionSource);
});

test('outside source selection and context click clear rectangles while inside context preserves them', async t => {
  const fixture=setup(t,'Before\n\n'+selectionSource),tools=selectionTools(fixture);tools.rectangle(1,0,2,1);
  tools.pointer(tools.cell(1,1),'mousedown',{button:2});tools.pointer(tools.cell(1,1),'contextmenu',{button:2});assert.equal(tools.selected().length,4);
  tools.pointer(tools.cell(3,2),'contextmenu',{button:2});assert.deepEqual(tools.selected(),[]);
  tools.rectangle(1,0,2,1);fixture.view.dispatch({selection:{anchor:0}});await Promise.resolve();assert.deepEqual(tools.selected(),[]);
});

test('one-cell table grips retain actionable whole-axis selection and grip hide is idempotent', t => {
  const fixture = setup(t, '| A |\n| --- |'), tools = selectionTools(fixture);
  tools.pointer(tools.cell(0,0).querySelector('.cm-table-grip-row')!, 'mousedown');
  tools.pointer(tools.cell(0,0), 'mouseup');
  assert.deepEqual(tools.selected(), [[0,0]]);
  const grip = tools.cell(0,0).querySelector<HTMLElement>('.cm-table-grip-row')!;
  const release = retainTableEditor(fixture.view, grip); release();
  assert.deepEqual(tools.selected(), []);
  tools.pointer(tools.cell(0,0).querySelector('.cm-table-grip-column')!, 'mousedown');
  tools.pointer(tools.cell(0,0), 'mouseup'); release();
  assert.deepEqual(tools.selected(), [[0,0]], 'releasing an old menu twice cannot clear a new range');
  tools.key('Delete'); assert.equal(fixture.editor.getValue(), '');
});

test('Shift horizontal extension leaves mid-cell text selection to CM and honors RTL boundaries', async t => {
  const fixture = setup(t, selectionSource.replace(' b ', ' long ')), tools = selectionTools(fixture);
  const child = fixture.activate(1,1);
  child.dispatch({ selection: { anchor: 2 } }); tools.key('ArrowRight', true);
  assert.deepEqual(tools.selected(), []); assert.equal(child.state.selection.main.empty, false);
  child.contentDOM.style.direction = 'rtl';
  child.dispatch({ selection: { anchor: child.state.doc.length } });
  await new Promise<void>(resolve => child.requestMeasure({ read: () => {}, write: () => resolve() }));
  assert.equal(child.textDirection, 1);
  tools.key('ArrowLeft', true);
  assert.deepEqual(tools.selected(), [[1,1],[1,2]]);
});

test('column grip drag moves alignment and cancel leaves the source untouched', t => {
  const fixture = setup(t, selectionSource), tools = selectionTools(fixture);
  tools.pointer(tools.cell(0,0).querySelector('.cm-table-grip-column')!, 'mousedown');
  tools.pointer(tools.cell(0,2), 'mousemove', { clientX: 10 });
  fixture.dom.window.document.dispatchEvent(new fixture.dom.window.Event('pointercancel', { bubbles: true }));
  assert.equal(fixture.editor.getValue(), selectionSource);
  tools.pointer(tools.cell(0,0).querySelector('.cm-table-grip-column')!, 'mousedown');
  tools.pointer(tools.cell(0,2), 'mousemove', { clientX: 10 }); tools.pointer(tools.cell(0,2), 'mouseup');
  const model = currentTable(fixture.editor.getValue());
  assert.deepEqual(model.rows[0].cells.map(cell => cell.text), ['B','C','A']);
  assert.deepEqual(model.alignments, ['right',null,'left']);
  assert.deepEqual(tools.selected(), [[0,2],[1,2],[2,2],[3,2]]);
});

test('selected alignment preserves range, menu snapshots reject changed selection, and prefix edits map ranges', t => {
  const fixture = setup(t, selectionSource), tools = selectionTools(fixture);
  tools.rectangle(1,0,2,1);
  const stale = tableActionsAt(fixture.view, tools.cell(1,0));
  tools.rectangle(2,1,3,2);
  assert.ok(stale.every(action => !action.run()));
  const align = tableActionsAt(fixture.view, tools.cell(2,1)).find(action => action.id === 'align-center')!;
  assert.equal(align.run(), true);
  assert.deepEqual(tools.selected(), [[2,1],[2,2],[3,1],[3,2]]);
  assert.deepEqual(currentTable(fixture.editor.getValue()).alignments, ['left','center','center']);
  const before = tableSelectionRanges(fixture.view, tools.cell(2,1));
  fixture.editor.setValue('🙂 Prefix\n' + fixture.editor.getValue());
  const after = tableSelectionRanges(fixture.view, tools.cell(2,1));
  assert.deepEqual(after.map((range, index) => range.from - before[index].from), [10,10,10,10]);
});

test('outer capture can delegate structured paste before generic transfers and copying remains read-only', t => {
  const fixture = setup(t, selectionSource), tools = selectionTools(fixture);
  let handled = false;
  fixture.view.dom.addEventListener('paste', event => { handled = handleTableClipboard(fixture.view, event as ClipboardEvent); }, true);
  fixture.activate(1,0);
  tools.clipboard('paste', { 'obsidian/table': JSON.stringify({ rows: [['changed']], alignment: [null] }), 'text/markdown': 'wrong ordinary paste' });
  assert.equal(handled, true); assert.equal(currentTable(fixture.editor.getValue()).rows[1].cells[0].text, 'changed');
  tools.rectangle(1,0,2,1);
  fixture.view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  assert.equal(tools.clipboard('copy').event.defaultPrevented, true);
  const before = fixture.editor.getValue(); tools.clipboard('cut'); tools.key('Delete');
  assert.equal(fixture.editor.getValue(), before);
});


test('oversized structured paste is consumed without allocating an expanded table or changing source', t => {
  const fixture = setup(t, selectionSource), tools = selectionTools(fixture);
  fixture.activate(1,0);
  const payload = { rows: Array.from({ length: 40_000 }, () => ['x']), alignment: [null] };
  const { event } = tools.clipboard('paste', { 'obsidian/table': JSON.stringify(payload) });
  assert.equal(event.defaultPrevented, true);
  assert.equal(fixture.editor.getValue(), selectionSource);
});


test('a pending grip reorder follows prefix edits and reselects the moved axis', t => {
  const fixture = setup(t, selectionSource), tools = selectionTools(fixture);
  tools.pointer(tools.cell(1,0).querySelector('.cm-table-grip-row')!, 'mousedown');
  fixture.view.dispatch({ changes: { from: 0, insert: 'Prefix\n\n' } });
  tools.pointer(tools.cell(3,0), 'mousemove', { clientY: 10 }); tools.pointer(tools.cell(3,0), 'mouseup');
  assert.deepEqual(currentTable(fixture.editor.getValue()).rows.map(row => row.cells[0].text), ['A','d','g','a']);
  assert.deepEqual(tools.selected(), [[3,0],[3,1],[3,2]]);
});
