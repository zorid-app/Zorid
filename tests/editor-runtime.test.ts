import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState, StateEffect, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { redo, undo, undoDepth } from '@codemirror/commands';
import { createEditor } from '../src/ui/editor.ts';
import type { EditorOptions } from '../src/ui/editor.ts';
import { completionStatus, currentCompletions, selectedCompletionIndex, startCompletion } from '@codemirror/autocomplete';
import { editorTransfers } from '../src/editor/transfers.ts';
import { tableSelectionRanges } from '../src/editor/live-tables.ts';
import { renderMarkdown } from '../src/ui/markdown.ts';

// Real CM6 state, transactions, plugins and DOM, under jsdom. Zero geometry
// shims only satisfy CM's measurement scheduler; they prove no pixel, native
// selection, OS keyboard, IME or clipboard parity.
function setup(t: TestContext, value: string, mode: 'live' | 'source' = 'live', completion: Partial<Pick<EditorOptions, 'paths' | 'wiki'>> = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
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
  const emptyRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  dom.window.Range.prototype.getBoundingClientRect = emptyRect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const host = document.querySelector<HTMLElement>('#host')!;
  const changes: string[] = [];
  const opened: string[] = [];
  const editor = createEditor(host, { value, mode, paths: () => ['Note.md'], onChange: text => changes.push(text), open: target => opened.push(target), ...completion });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  assert.ok(view, 'find real CodeMirror instance from its DOM');
  view.focus();
  view.dispatch({ selection: view.state.selection });
  let destroyed = false;
  const destroy = () => { if (!destroyed) { editor.destroy(); destroyed = true; } };
  t.after(() => {
    destroy();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const line = (index: number) => [...host.querySelectorAll<HTMLElement>('.cm-line')][index];
  const cursor = (position: number) => view.dispatch({ selection: { anchor: position } });
  return { editor, view, host, changes, opened, line, cursor, dom, destroy };
}

for (const mode of ['live', 'source'] as const) test(`${mode} external separated edits preserve the unchanged middle caret and undo`, t => {
  const { editor, view, changes, cursor } = setup(t, 'aaa\nKEEP\nzzz', mode);
  cursor(5);
  editor.setValue('!aaa\nKEEP\nzzz!');
  assert.equal(view.state.selection.main.head, 6, 'original separated-edit regression');
  assert.deepEqual(changes, []);
  editor.insert('?');
  editor.setValue('!!aaa\nK?EEP\nzzz!!');
  assert.equal(view.state.selection.main.head, 8);
  assert.equal(changes.length, 1, 'external snapshots never publish user edits');
  assert.equal(undoDepth(view.state), 1);
  assert.ok(undo(view));
  assert.equal(editor.getValue(), '!!aaa\nKEEP\nzzz!!');
  assert.ok(redo(view));
  assert.equal(editor.getValue(), '!!aaa\nK?EEP\nzzz!!');
});

test('source mode retains modifier-click wiki navigation without hiding source', t => {
  const { view, dom, opened, line } = setup(t, '[[Note|Alias]]', 'source');
  t.mock.method(view, 'posAtCoords', () => 8);
  view.contentDOM.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  assert.deepEqual(opened, ['Note']);
  assert.equal(line(0).textContent, '[[Note|Alias]]');
  assert.equal(view.state.doc.toString(), '[[Note|Alias]]');
});

test('creating and refreshing an unfocused live editor preserves title focus and renders the initial heading', t => {
  setup(t, 'existing');
  const title = document.createElement('input'), host = document.createElement('div');
  document.body.append(title, host); title.focus();
  const changes: string[] = [];
  const editor = createEditor(host, { value: '# Heading\n**bold**', mode: 'live', paths: () => [], open() {}, onChange: text => changes.push(text) });
  try {
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
    assert.equal(document.activeElement, title);
    assert.equal(host.querySelector('.cm-line')?.textContent, 'Heading');
    editor.restoreViewState!({ selection: { ranges: [{ anchor: 2, head: 2 }], mainIndex: 0 }, scrollTop: 0, scrollLeft: 0 });
    editor.refreshLinks!(); editor.setValue('# Heading\n**changed**');
    assert.equal(document.activeElement, title);
    assert.equal(host.querySelector('.cm-line')?.textContent, 'Heading');
    assert.deepEqual(changes, []); assert.equal(undoDepth(view.state), 0);
    editor.focus(); view.dispatch({ selection: view.state.selection });
    assert.equal(host.querySelector('.cm-line')?.textContent, '# Heading');
  } finally { editor.destroy(); }
});

test('real source editor retains literal syntax; live editor hides only inactive markup', t => {
  const { editor, line, cursor } = setup(t, '# Heading\n**bold** ~~gone~~ ==marked==\nplain');
  assert.equal(line(0).textContent, '# Heading');
  assert.equal(line(1).textContent, 'bold gone marked');
  assert.equal(line(1).querySelector('.cm-strong')?.textContent, 'bold');
  cursor(editor.getValue().length);
  assert.equal(line(0).textContent, 'Heading');
  cursor('# Heading\n'.length);
  assert.equal(line(1).textContent, '**bold** gone marked');
  assert.equal(editor.getValue(), '# Heading\n**bold** ~~gone~~ ==marked==\nplain');
});

test('source mode never replaces Markdown punctuation', t => {
  const { line, cursor, editor } = setup(t, '# Heading\n**bold** ~~gone~~ ==mark==\nplain', 'source');
  cursor(editor.getValue().length);
  assert.equal(line(0).textContent, '# Heading');
  assert.equal(line(1).textContent, '**bold** ~~gone~~ ==mark==');
  assert.equal(line(1).querySelector('.cm-strong'), null);
});

test('live preview renders inline code and escapes while preserving literal code contents', t => {
  const value = 'plain\n`**literal** ~~code~~ ==code==` **real**\n```md\n# code\n**fenced** ==fenced==\n```\n\\**escaped** \\==escaped==\nplain';
  const { line } = setup(t, value);
  assert.equal(line(1).textContent, '**literal** ~~code~~ ==code== real');
  assert.equal(line(3).textContent, '# code');
  assert.equal(line(4).textContent, '**fenced** ==fenced==');
  assert.equal(line(6).textContent, '*escaped* ==escaped==');
});

test('all cursors and full selected ranges reveal their intersecting lines', t => {
  const value = 'plain\n**first**\n**second**\n**third**\nplain';
  const { view, line } = setup(t, value);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(value.indexOf('second'))], 0) });
  assert.equal(view.state.selection.ranges.length, 2);
  assert.equal(line(1).textContent, 'first');
  assert.equal(line(2).textContent, '**second**');
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(value.indexOf('first'), value.indexOf('third') + 2)]) });
  assert.equal(line(1).textContent, '**first**');
  assert.equal(line(2).textContent, '**second**');
  assert.equal(line(3).textContent, '**third**');
});

test('external snapshots suppress autosave callbacks, preserve unaffected selection and stay outside history', t => {
  const { editor, view, changes, cursor } = setup(t, 'alpha\nbeta', 'source');
  cursor(2);
  editor.setValue('alpha\nbeta\nexternal');
  assert.equal(view.state.selection.main.head, 2);
  assert.deepEqual(changes, []);
  assert.equal(undoDepth(view.state), 0);
  editor.setValue(editor.getValue());
  assert.deepEqual(changes, []);
  editor.insert('!');
  assert.deepEqual(changes, ['al!pha\nbeta\nexternal']);
  assert.ok(undo(view));
  assert.equal(editor.getValue(), 'alpha\nbeta\nexternal');
  assert.ok(redo(view));
  assert.equal(editor.getValue(), 'al!pha\nbeta\nexternal');
});

test('user undo maps through a separate external edit without reverting that edit', t => {
  const { editor, view, cursor } = setup(t, 'middle', 'source');
  cursor(6);
  editor.insert('!');
  editor.setValue('external middle!');
  assert.equal(undoDepth(view.state), 1);
  assert.ok(undo(view));
  assert.equal(editor.getValue(), 'external middle');
});

test('programmatic multi-line insertion replaces all selections and is undoable', t => {
  const { editor, view, changes } = setup(t, 'left\nright', 'source');
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 4), EditorSelection.range(5, 10)]) });
  editor.insert('one\ntwo');
  assert.equal(editor.getValue(), 'one\ntwo\none\ntwo');
  assert.equal(changes.length, 1);
  assert.equal(view.state.selection.ranges.length, 2);
  assert.ok(undo(view));
  assert.equal(editor.getValue(), 'left\nright');
});

test('installed Markdown keymap continues lists on a real editor Enter event', t => {
  const { editor, view, cursor, dom } = setup(t, '- item', 'source');
  cursor(6);
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  assert.ok(event.defaultPrevented);
  assert.equal(editor.getValue(), '- item\n- ');
});

test('a paste transaction updates actual editor state and callbacks once', t => {
  const { editor, view, changes, cursor } = setup(t, 'before after', 'source');
  cursor(7);
  view.dispatch({ ...view.state.replaceSelection('first\nsecond\n'), annotations: Transaction.userEvent.of('input.paste') });
  assert.equal(editor.getValue(), 'before first\nsecond\nafter');
  assert.deepEqual(changes, ['before first\nsecond\nafter']);
});

test('destroy removes the actual editor DOM', t => {
  const { host, destroy } = setup(t, 'text');
  assert.ok(host.querySelector('.cm-editor'));
  destroy();
  assert.equal(host.querySelector('.cm-editor'), null);
});

const tableNote = 'Before\n\n| Name | Value |\n| --- | ---: |\n| alpha | beta |\n\nAfter';
function activateCell(host: HTMLElement, dom: JSDOM, row: number, column: number) {
  const cell = host.querySelector<HTMLElement>(`.cm-live-table [data-row="${row}"][data-column="${column}"]`)!;
  assert.ok(cell, 'rendered table cell exists');
  cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const editor = EditorView.findFromDOM(cell.querySelector('.cm-editor')!)!;
  assert.ok(editor, 'active cell has its own real CM editor');
  return editor;
}

test('live table renders structure and retains one cell editor across typing, with parent undo', t => {
  const { host, dom, view, editor, changes } = setup(t, tableNote);
  const widget = host.querySelector('.cm-live-table');
  assert.equal(widget?.querySelectorAll('th').length, 2);
  assert.equal(widget?.querySelectorAll('td').length, 2);
  assert.equal(widget?.querySelector('td')?.textContent, 'alpha');
  const child = activateCell(host, dom, 1, 0);
  child.dispatch({ selection: { anchor: child.state.doc.length } });
  child.dispatch({ ...child.state.replaceSelection('!'), annotations: Transaction.userEvent.of('input.type') });
  assert.equal(editor.getValue(), tableNote.replace('alpha', 'alpha!'));
  assert.equal(host.querySelector('.cm-live-table'), widget, 'table DOM is reused');
  assert.equal(EditorView.findFromDOM(widget!.querySelector('.cm-editor')!), child, 'active editor survives parent updates');
  assert.equal(changes.length, 1);
  assert.equal(undoDepth(view.state), 1);
  assert.equal(undoDepth(child.state), 0, 'cell has no separate history');
  assert.ok(undo(view));
  assert.equal(editor.getValue(), tableNote);
  assert.equal(child.state.doc.toString(), 'alpha');
  assert.ok(redo(view));
  assert.equal(child.state.doc.toString(), 'alpha!');
});

test('cell paste escapes pipes and encodes line breaks without splitting the table', t => {
  const { host, dom, editor, view } = setup(t, tableNote);
  const child = activateCell(host, dom, 1, 1);
  child.dispatch({ selection: EditorSelection.single(0, child.state.doc.length) });
  child.dispatch({ ...child.state.replaceSelection('left|right\nnext'), annotations: Transaction.userEvent.of('input.paste') });
  assert.ok(editor.getValue().includes('| alpha | left\\|right<br>next |'));
  assert.equal(host.querySelectorAll('.cm-live-table td').length, 2);
  assert.equal(child.state.doc.toString(), 'left|right\nnext');
  assert.equal(view.state.selection.main.head, editor.getValue().indexOf('next') + 4);
  assert.ok(undo(view));
  assert.equal(child.state.doc.toString(), 'beta');
});

test('table Tab navigation selects cells and creates a row at the end; Shift-Tab creates a header', t => {
  const { host, dom, editor } = setup(t, tableNote);
  const key = (view: EditorView, shiftKey = false) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event); assert.ok(event.defaultPrevented);
  };
  let child = activateCell(host, dom, 0, 0);
  key(child);
  child = EditorView.findFromDOM(host.querySelector('.cm-live-table .cm-editor')!)!;
  assert.equal(child.state.doc.toString(), 'Value');
  assert.equal(child.state.selection.main.to, 5);
  assert.equal(child.state.selection.main.from, 0);
  child = activateCell(host, dom, 1, 1); key(child);
  assert.equal(host.querySelectorAll('.cm-live-table tbody tr').length, 2);
  assert.match(editor.getValue(), /\| alpha \| beta \|\n\|  \|  \|/);
  child = activateCell(host, dom, 0, 0); key(child, true);
  assert.match(editor.getValue(), /\|  \|  \|\n\| --- \| ---: \|\n\| Name \| Value \|/);
});

test('cell Enter advances down and Shift-Enter stays in the cell as an encoded break', t => {
  const { host, dom, editor } = setup(t, tableNote);
  let child = activateCell(host, dom, 0, 1);
  const enter = (shiftKey = false) => child.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey, bubbles: true, cancelable: true }));
  enter();
  child = EditorView.findFromDOM(host.querySelector('.cm-live-table .cm-editor')!)!;
  assert.equal(child.state.doc.toString(), 'beta');
  child.dispatch({ selection: { anchor: 4 } });
  enter(true);
  assert.equal(child.state.doc.toString(), 'beta\n');
  assert.ok(editor.getValue().includes('beta<br>'));
  assert.equal(host.querySelectorAll('.cm-live-table tbody tr').length, 1);
});

test('external snapshots update an active cell without a second save and remove deleted widgets', t => {
  const { host, dom, editor, changes, view } = setup(t, tableNote);
  const child = activateCell(host, dom, 1, 0);
  editor.setValue(tableNote.replace('alpha', 'external'));
  assert.equal(child.state.doc.toString(), 'external');
  assert.deepEqual(changes, []);
  assert.equal(undoDepth(view.state), 0);
  editor.setValue('Just text');
  assert.equal(host.querySelector('.cm-live-table'), null);
  assert.equal(child.dom.isConnected, false);
});

test('two-ended external updates preserve table-cell ownership, literal inline source and parent undo', async t => {
  const value = tableNote.replace('alpha', '**alpha**');
  const { host, dom, editor, view, changes, opened } = setup(t, value);
  let child = activateCell(host, dom, 1, 0);
  child.dispatch({ selection: { anchor: 4 } });
  assert.equal(child.contentDOM.textContent, '**alpha**');
  assert.equal(child.dom.querySelector('.cm-strong,.cm-live-inline-link'), null, 'parent inline decorations must not enter the cell editor');
  t.mock.method(view, 'posAtCoords', () => 0);
  child.contentDOM.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  assert.deepEqual(opened, []);
  const external = `before\n\n${value}\n\nafter`;
  editor.setValue(external); await Promise.resolve();
  const active = host.querySelector('.cm-live-table .cm-editor');
  assert.ok(active, 'active cell survives changes on both sides of its table');
  child = EditorView.findFromDOM(active)!;
  assert.equal(child.state.doc.toString(), '**alpha**');
  assert.equal(child.state.selection.main.head, 4);
  editor.focus(); assert.equal(child.hasFocus, true);
  child.dispatch({ ...child.state.replaceSelection('!'), annotations: Transaction.userEvent.of('input.type') });
  assert.equal(editor.getValue(), external.replace('**alpha**', '**al!pha**'));
  assert.equal(changes.length, 1);
  assert.ok(undo(view));
  assert.equal(editor.getValue(), external);
});

test('source mode and fenced table examples retain literal table Markdown', t => {
  const { host } = setup(t, '```md\n| A | B |\n| --- | --- |\n| x | y |\n```');
  assert.equal(host.querySelector('.cm-live-table'), null);
});

test('mouse selection preserves rendered geometry until release and refreshes the latest selection', async t => {
  const { host, dom, view, cursor, line } = setup(t, 'plain\n**first**\n**second**');
  // Capture-only event avoids asking jsdom to provide browser hit-test geometry.
  host.querySelectorAll('.cm-line')[1].dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: false }));
  cursor(9);
  assert.equal(line(1).textContent, 'first', 'markers do not move text during pointer selection');
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('mouseup', { button: 0 }));
  cursor(view.state.doc.length);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(view.state.selection.main.head, view.state.doc.length, 'deferred refresh never restores an old selection');
  assert.equal(line(1).textContent, 'first');
  assert.equal(line(2).textContent, '**second**');
});

test('typing repeated spaces in a table cell does not duplicate existing input padding', t => {
  const { host, dom, editor } = setup(t, tableNote);
  const child = activateCell(host, dom, 1, 0);
  for (let i = 0; i < 3; i++) child.dispatch(child.state.replaceSelection(' '));
  child.dispatch(child.state.replaceSelection('Z'));
  assert.equal(child.state.doc.toString(), '   Zalpha');
  assert.ok(editor.getValue().includes('|    Zalpha | beta |'));
  assert.ok(!editor.getValue().includes('|     Zalpha'));
});

test('selection in a missing cell stays in range and first typing materializes the cell', t => {
  const { host, dom, editor, view } = setup(t, '| A | B |\n| --- | --- |\n| x |');
  const child = activateCell(host, dom, 1, 1);
  child.dispatch({ selection: { anchor: 0 } });
  assert.ok(view.state.selection.main.head <= view.state.doc.length);
  child.dispatch(child.state.replaceSelection('new'));
  assert.match(editor.getValue(), /\| x \| new \|$/);
});

test('undo from a different cell restores the history target before subsequent typing', async t => {
  const { host, dom, view, editor } = setup(t, tableNote);
  const first = activateCell(host, dom, 1, 0);
  first.dispatch({ selection: { anchor: 5 } });
  first.dispatch(first.state.replaceSelection('!'));
  activateCell(host, dom, 1, 1);
  undo(view); await Promise.resolve();
  const active = EditorView.findFromDOM(host.querySelector('.cm-live-table .cm-editor')!)!;
  assert.equal(active.state.doc.toString(), 'alpha');
  active.dispatch(active.state.replaceSelection('?'));
  assert.ok(editor.getValue().includes('alpha? | beta'));
});

test('inserting another table before an active cell cannot redirect typing into the new table', async t => {
  const value = '| A | B |\n| --- | --- |\n| x | y |';
  const { host, dom, view, editor } = setup(t, value);
  const child = activateCell(host, dom, 1, 0);
  child.dispatch({ selection: { anchor: 1 } });
  const prefix = '| N | M |\n| --- | --- |\n| new | row |\n\n';
  editor.setValue(prefix + value); await Promise.resolve();
  const activeNode = host.querySelector('.cm-live-table .cm-editor');
  assert.ok(activeNode, 'cell focus restored after table position changes');
  const active = EditorView.findFromDOM(activeNode)!;
  assert.equal(active.state.doc.toString(), 'x');
  active.dispatch(active.state.replaceSelection('!'));
  assert.equal(editor.getValue(), prefix + value.replace('| x |', '| x! |'));
  assert.ok(view.state.selection.main.head > prefix.length);
});

test('valid properties are hidden in Live Edit while body input preserves the exact YAML', t => {
  const prefix = '---\ntitle: Example\nstatus: ready\n---\n';
  const { host, editor, view } = setup(t, prefix + '# Heading\nbody');
  assert.ok(!host.textContent!.includes('title: Example'));
  assert.ok(!host.textContent!.includes('status: ready'));
  assert.equal(view.state.selection.main.head, prefix.length);
  editor.insert('Inserted ');
  assert.equal(editor.getValue(), prefix + 'Inserted # Heading\nbody');
  editor.setValue('---\ntitle: Changed\n---\n# Heading\nbody');
  assert.ok(!host.textContent!.includes('title: Changed'));
  editor.setValue('---\ntitle: [broken\n---\nbody');
  assert.ok(host.textContent!.includes('title: [broken'), 'invalid YAML remains repairable');
});

test('Reading mode uses escaped-pipe boundaries, cell breaks, alignment and ragged padding', t => {
  const { host } = setup(t, '');
  const reading = document.createElement('div'); host.append(reading);
  renderMarkdown(reading, '| Name | Detail |\n| :--- | ---: |\n| left\\|right | first<br>second |\n| short |\n\nAfter', () => {});
  assert.equal(reading.querySelectorAll('td').length, 4);
  assert.equal(reading.querySelector('td')?.textContent, 'left|right');
  assert.equal(reading.querySelectorAll('td')[1].textContent, 'first\nsecond');
  assert.equal((reading.querySelectorAll('td')[1] as HTMLElement).style.textAlign, 'right');
  assert.equal(reading.querySelector('p')?.textContent, 'After');
});

test('live list preference changes retain selection, history and editor instance', t => {
  const {editor,view,dom,cursor}=setup(t,'- item','source');
  cursor(6);editor.insert('!');
  const selection=view.state.selection.toJSON(),depth=undoDepth(view.state);
  editor.configureLists!({useTab:false,tabSize:8,smartIndentList:true});
  assert.equal(view.state.tabSize,8);assert.equal(undoDepth(view.state),depth);
  assert.deepEqual(view.state.selection.toJSON(),selection);
  const tab=new dom.window.KeyboardEvent('keydown',{key:'Tab',code:'Tab',bubbles:true,cancelable:true});
  view.contentDOM.dispatchEvent(tab);
  assert.ok(tab.defaultPrevented);assert.equal(editor.getValue(),'    - item!');
  assert.ok(undo(view));assert.equal(editor.getValue(),'- item!');
  assert.ok(undo(view));assert.equal(editor.getValue(),'- item');
});

test('rendered table context menu offers nested table commands without applying dismissed actions', async t => {
  const {view,host,dom,editor}=setup(t,'| One | Two |\n| --- | --- |\n| a | b |\nend');
  type MenuEntry={id?:string;role?:string;label?:string;submenu?:MenuEntry[]};
  let request: {items:MenuEntry[]}|undefined;
  let select!: (id:string|null)=>void;
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:(value:typeof request)=>{request=value;return new Promise<string|null>(resolve=>select=resolve);}}});
  const cell=host.querySelector<HTMLElement>('td')!;
  const event=new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:12,clientY:20});
  cell.dispatchEvent(event);
  assert.ok(event.defaultPrevented);assert.ok(request);
  assert.equal(request.items.some(item=>item.role),false);
  assert.deepEqual(request.items.filter(item=>item.label).map(item=>item.label),['Row','Column','Sort by column (A to Z)','Sort by column (Z to A)']);
  assert.ok(request.items.find(item=>item.label==='Column')?.submenu?.some(item=>item.id==='table-column-after'));
  assert.ok(request.items.find(item=>item.label==='Row')?.submenu?.some(item=>item.id==='table-row-delete'));
  const before=editor.getValue();select(null);await Promise.resolve();
  assert.equal(editor.getValue(),before);
  cell.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  select('table-column-after');await Promise.resolve();
  assert.equal(host.querySelectorAll('th').length,3);
  assert.ok(undo(view));assert.equal(editor.getValue(),before);
});

test('closed editors ignore late context menu command results', async t => {
  const {view,dom,destroy}=setup(t,'hello');
  let finish!: (id:string|null)=>void;
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:()=>new Promise<string|null>(resolve=>finish=resolve)}});
  view.contentDOM.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  assert.ok(finish);destroy();finish('select-all');await Promise.resolve();
  assert.equal(view.state.selection.main.empty,true);
});

test('editor view snapshots restore multiple reversed selections and scroll without editing history', t => {
  const {editor,view,changes}=setup(t,'0123456789\nabcdefghij');
  view.dispatch({selection:EditorSelection.create([EditorSelection.range(5,2),EditorSelection.range(12,16)],1)});
  view.scrollDOM.scrollTop=83;view.scrollDOM.scrollLeft=12;
  const snapshot=editor.getViewState!();
  view.dispatch({selection:{anchor:0}});view.scrollDOM.scrollTop=0;view.scrollDOM.scrollLeft=0;
  editor.restoreViewState!(snapshot);
  assert.equal(view.state.selection.mainIndex,1);
  assert.deepEqual(view.state.selection.ranges.map(range=>[range.anchor,range.head]),[[5,2],[12,16]]);
  assert.equal(view.scrollDOM.scrollTop,83);assert.equal(view.scrollDOM.scrollLeft,12);
  assert.equal(undoDepth(view.state),0);assert.deepEqual(changes,[]);
  editor.setValue('short');editor.restoreViewState!(snapshot);
  assert.ok(view.state.selection.ranges.every(range=>range.to<=5));
  assert.doesNotThrow(()=>editor.restoreViewState!({selection:{ranges:[{anchor:NaN,head:Infinity}],mainIndex:99},scrollTop:-3,scrollLeft:NaN}));
});

test('active table-cell context menu includes editor clipboard roles before table submenus', async t => {
  const {view,host,dom,editor}=setup(t,'| One | Two |\n| --- | --- |\n| a | b |\nend');
  type Entry={id?:string;role?:string;label?:string;enabled?:boolean;submenu?:Entry[]};
  let items:Entry[]=[];let choose!:(id:string|null)=>void;
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:(request:{items:Entry[]})=>{items=request.items;return new Promise<string|null>(resolve=>choose=resolve);}}});
  host.querySelector('td')!.dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));
  const child=EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
  child.dispatch({selection:EditorSelection.single(0,1)});
  child.contentDOM.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  assert.ok(items.find(item=>item.role==='copy')?.enabled);
  assert.equal(items.find(item=>item.role==='pasteAndMatchStyle')?.label,'Paste as plain text');
  assert.ok(items.findIndex(item=>item.role==='paste')<items.findIndex(item=>item.label==='Row'));
  assert.ok(!items.some(item=>item.id==='undo'||item.id==='redo'));
  const before=editor.getValue();choose('table-row-duplicate');await Promise.resolve();
  assert.equal(host.querySelectorAll('tbody tr').length,2);
  assert.ok(undo(view));assert.equal(editor.getValue(),before);
});

test('browser table menus retain the active child through formatting, structural actions and dismissal', async t => {
  const {view,host,dom,editor}=setup(t,'| A | B |\n| --- | --- |\n| one | two |');
  host.querySelector('td')!.dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));
  const child=EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
  child.dispatch({selection:EditorSelection.range(3,0)});child.focus();
  const open=()=>child.contentDOM.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  const item=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(node=>node.textContent===label)!;
  open();await Promise.resolve();
  assert.equal(child.dom.isConnected,true,'menu focus must not dispose its clipboard/format target');
  item('Format').click();item('Bold').click();await Promise.resolve();
  assert.match(editor.getValue(),/\*\*one\*\*/);
  assert.equal(child.hasFocus,true);
  assert.equal(undo(view),true);await Promise.resolve();
  open();await Promise.resolve();
  item('Row').click();item('Duplicate row').click();await Promise.resolve();
  assert.equal(host.querySelectorAll('tbody tr').length,2);
  const next=EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
  next.contentDOM.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  await Promise.resolve();
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await Promise.resolve();assert.equal(next.hasFocus,true);
  view.focus();await Promise.resolve();
  assert.equal(next.dom.isConnected,false,'dismissal must release its temporary blur hold');
});

test('clipboard menu availability includes nonempty secondary selections', t => {
  const {view,dom}=setup(t,'abcdef');
  view.dispatch({selection:EditorSelection.create([EditorSelection.cursor(0),EditorSelection.range(2,4)],0)});
  let items:Array<{role?:string;enabled?:boolean}>=[];
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:(request:{items:typeof items})=>{items=request.items;return Promise.resolve(null);}}});
  view.contentDOM.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  assert.equal(items.find(item=>item.role==='copy')?.enabled,true);
  assert.equal(items.find(item=>item.role==='cut')?.enabled,true);
});

test('late formatting menu results cannot apply to changed text or selections', async t => {
  const {view,dom,editor}=setup(t,'abcdef');
  let choose!:(id:string|null)=>void;
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:()=>new Promise<string|null>(resolve=>choose=resolve)}});
  for(const changeDocument of [false,true]){
    view.dispatch({selection:EditorSelection.range(0,2)});
    view.contentDOM.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    if(changeDocument)view.dispatch({changes:{from:0,insert:'X'}});
    else view.dispatch({selection:EditorSelection.range(3,5)});
    const before=editor.getValue();choose('format-format-bold');await Promise.resolve();
    assert.equal(editor.getValue(),before);
  }
});

test('menu bridge failures release a held table editor on synchronous and asynchronous errors', async t => {
  const reported:unknown[]=[];t.mock.method(console,'error',(error:unknown)=>reported.push(error));
  const {view,host,dom}=setup(t,'| A | B |\n| --- | --- |\n| one | two |');
  let asynchronous=false;
  Object.defineProperty(dom.window,'zorid',{value:{showContextMenu:()=>{
    view.focus();const error=new Error('menu unavailable');
    if(asynchronous)return Promise.reject(error);throw error;
  }}});
  for(const mode of [false,true]){
    asynchronous=mode;
    host.querySelector('td')!.dispatchEvent(new dom.window.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));
    const child=EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;child.focus();
    child.contentDOM.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(child.dom.isConnected,false,'failed popup must not leave a persistent blur hold');
  }
  assert.equal(reported.length,2);
});


const rectangleSource = '| A | B | C |\n| --- | --- | --- |\n| one | two | three |\n| four | five | six |';
function rectangleTools(fixture: ReturnType<typeof setup>) {
  const { host, dom, view } = fixture;
  const cell = (row: number, column: number) => host.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`)!;
  const pointer = (node: HTMLElement, type: string) => node.dispatchEvent(new dom.window.MouseEvent(type, {button:0,bubbles:true,cancelable:true}));
  const select = (r1:number,c1:number,r2:number,c2:number) => {
    pointer(cell(r1,c1),'mousedown');pointer(cell(r2,c2),'mousemove');pointer(cell(r2,c2),'mouseup');
  };
  const child = () => EditorView.findFromDOM(host.querySelector('td .cm-editor,th .cm-editor')!)!;
  const open = (target:HTMLElement=child().contentDOM) => target.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  const clipboard = (target:HTMLElement,type:string, supplied:Record<string,string>={}) => {
    const values={...supplied},event=new dom.window.Event(type,{bubbles:true,cancelable:true});
    Object.defineProperty(event,'clipboardData',{value:{getData:(type:string)=>values[type]??'',setData:(type:string,value:string)=>{values[type]=value;},clearData:()=>{for(const key of Object.keys(values))delete values[key];},items:[],files:[]}});
    target.dispatchEvent(event);return {event,values};
  };
  const text = (target:HTMLElement) => tableSelectionRanges(view,target).map(range=>view.state.sliceDoc(range.from,range.to));
  return {cell,select,child,open,clipboard,text};
}

test('rectangle native menu exposes only selected-cell clipboard roles and one parent formatting history entry',async t=>{
  const fixture=setup(t,rectangleSource),tools=rectangleTools(fixture);
  type Entry={id?:string;role?:string;label?:string;enabled?:boolean;submenu?:Entry[]};
  let items:Entry[]=[];let choose!:(id:string|null)=>void;
  Object.defineProperty(fixture.dom.window,'zorid',{value:{showContextMenu:(request:{items:Entry[]})=>{items=request.items;return new Promise<string|null>(resolve=>choose=resolve);}}});
  tools.select(1,0,2,1);assert.equal(tools.child().state.readOnly,true);tools.open();
  assert.deepEqual(items.slice(0,3).map(item=>[item.role,item.enabled]),[['cut',true],['copy',true],['paste',true]]);
  assert.equal(items[3].label,'Format');assert.ok(items[3].submenu?.some(item=>item.label==='Highlight'));
  assert.equal(items.some(item=>item.role==='pasteAndMatchStyle'||item.label==='Row'||item.label==='Column'),false);
  const depth=undoDepth(fixture.view.state);choose('format-format-highlight-default');await Promise.resolve();
  assert.deepEqual(tools.text(tools.cell(1,0)),['==one==','==two==','==four==','==five==']);
  assert.match(fixture.editor.getValue(),/three/);assert.match(fixture.editor.getValue(),/six/);
  assert.equal(undoDepth(fixture.view.state),depth+1);assert.equal(undo(fixture.view),true);
  assert.equal(fixture.editor.getValue(),rectangleSource);
});

test('browser rectangle formatting retains selected child and releases its blur lease after dismissal',async t=>{
  const fixture=setup(t,rectangleSource),tools=rectangleTools(fixture);tools.select(1,0,2,1);
  const child=tools.child();tools.open();await Promise.resolve();assert.equal(child.dom.isConnected,true);
  const item=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(node=>node.textContent===label)!;
  item('Format').click();item('Highlight').click();item('Default').click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(child.hasFocus,true);assert.deepEqual(tools.text(tools.cell(1,0)),['==one==','==two==','==four==','==five==']);
  tools.open();await Promise.resolve();document.dispatchEvent(new fixture.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await Promise.resolve();assert.equal(child.hasFocus,true);
  fixture.view.focus();await Promise.resolve();assert.equal(child.dom.isConnected,false);
});

test('rectangle menu rejects changed range and keeps Copy available for a read-only parent',async t=>{
  const fixture=setup(t,rectangleSource),tools=rectangleTools(fixture);
  let items:Array<{role?:string;enabled?:boolean;label?:string}>=[];let choose!:(id:string|null)=>void;
  Object.defineProperty(fixture.dom.window,'zorid',{value:{showContextMenu:(request:{items:typeof items})=>{items=request.items;return new Promise<string|null>(resolve=>choose=resolve);}}});
  tools.select(1,0,2,1);tools.open();tools.select(1,1,2,2);choose('format-format-highlight-default');await Promise.resolve();
  assert.equal(fixture.editor.getValue(),rectangleSource);
  fixture.view.dispatch({effects:StateEffect.appendConfig.of(EditorState.readOnly.of(true))});tools.open();
  assert.equal(items.find(item=>item.role==='copy')?.enabled,true);
  assert.equal(items.find(item=>item.role==='cut')?.enabled,false);assert.equal(items.find(item=>item.role==='paste')?.enabled,false);
  assert.equal(items.find(item=>item.label==='Format')?.enabled,false);
  choose(null);await Promise.resolve();
  const copied=tools.clipboard(tools.child().contentDOM,'copy');assert.equal(copied.event.defaultPrevented,true);
  assert.deepEqual(JSON.parse(copied.values['obsidian/table']).rows,[['two','three'],['five','six']]);
  assert.equal(fixture.editor.getValue(),rectangleSource);
});

test('structured table paste wins over generic transfer text while unrelated controls retain ownership',t=>{
  const fixture=setup(t,rectangleSource),tools=rectangleTools(fixture);
  fixture.view.dispatch({effects:StateEffect.appendConfig.of(editorTransfers({importFile:async()=>{throw new Error('unexpected import');}}))});
  tools.select(1,0,2,1);
  const data={'obsidian/table':JSON.stringify({rows:[['new']],alignment:[null]}),'text/markdown':'WRONG MARKDOWN','text/plain':'WRONG PLAIN'};
  const pasted=tools.clipboard(tools.child().contentDOM,'paste',data);assert.equal(pasted.event.defaultPrevented,true);
  assert.match(fixture.editor.getValue(),/\| new \| two \| three \|/);assert.doesNotMatch(fixture.editor.getValue(),/WRONG/);
  assert.equal(undoDepth(fixture.view.state),1);assert.equal(undo(fixture.view),true);assert.equal(fixture.editor.getValue(),rectangleSource);
  tools.select(1,0,2,1);
  const input=document.createElement('input');tools.child().dom.append(input);input.focus();
  const controlPaste=tools.clipboard(input,'paste',data);
  assert.equal(controlPaste.event.defaultPrevented,false,'a table child search/input control owns its clipboard event');
  assert.equal(fixture.editor.getValue(),rectangleSource);
});

test('table clipboard listeners leave native controls alone without transfers installed',t=>{
  const fixture=setup(t,rectangleSource),tools=rectangleTools(fixture);tools.select(1,0,2,1);
  const child=tools.child(), input=document.createElement('input');
  child.dom.append(input);input.focus();
  for(const target of [input])for(const type of ['copy','cut','paste']){
    const result=tools.clipboard(target,type,{'obsidian/table':JSON.stringify({rows:[['wrong']],alignment:[null]})});
    assert.equal(result.event.defaultPrevented,false,`${type} must preserve control ownership`);
    assert.equal(fixture.editor.getValue(),rectangleSource);
  }
});


async function awaitWiki(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'wiki completion did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function wikiKey(view: EditorView, dom: JSDOM, key: string, shiftKey = false) {
  const event = new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

test('createEditor wiki Tab preserves a suffix alias with custom grammar, host link policy and parent undo', async t => {
  const calls: string[] = [];
  const initial = '[[Fi|Already written]]';
  const { editor, view, cursor, dom, changes } = setup(t, initial, 'live', {
    paths: () => ['A/Alpha.md', 'B/Alpha.md'],
    wiki: { sourcePath: () => 'Folder/Source.md',
      metadata: path => ({ aliases: path === 'A/Alpha.md' ? ['First'] : [], mtime: 3 }),
      linkText: (path, source) => { calls.push(source); return path.replace(/\.md$/, ''); } },
  });
  cursor(4); assert.equal(startCompletion(view), true);
  await awaitWiki(() => completionStatus(view.state) === 'active' && selectedCompletionIndex(view.state) === 0);
  assert.equal(currentCompletions(view.state)[0]?.label, 'First');
  assert.ok(wikiKey(view, dom, 'Tab'));
  assert.equal(editor.getValue(), '[[A/Alpha|Already written]]');
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'Already written');
  assert.deepEqual(changes, ['[[A/Alpha|Already written]]']);
  assert.ok(calls.length > 0 && calls.every(source => source === 'Folder/Source.md'));
  assert.equal(undoDepth(view.state), 1); assert.ok(undo(view)); assert.equal(editor.getValue(), initial);
});

test('createEditor wiki Enter outranks list continuation and heading continuation uses host resolver', async t => {
  const resolved: [string, string][] = [];
  const { editor, view, cursor, dom } = setup(t, '- [[No]]', 'live', {
    wiki: { sourcePath: () => 'Source.md',
      metadata: () => ({ headings: [{ heading: 'Overview', level: 1 }] }),
      resolvePath: (target, source) => { resolved.push([target, source]); return target === 'Note' ? 'Note.md' : null; } },
  });
  cursor(6); startCompletion(view);
  await awaitWiki(() => completionStatus(view.state) === 'active' && selectedCompletionIndex(view.state) === 0);
  assert.ok(wikiKey(view, dom, '#'));
  assert.equal(editor.getValue(), '- [[Note#]]'); assert.equal(view.state.selection.main.head, 9);
  await awaitWiki(() => completionStatus(view.state) === 'active' && currentCompletions(view.state)[0]?.label === 'Overview');
  // Empty heading query is intentionally unselected; arrow chooses its candidate.
  assert.ok(wikiKey(view, dom, 'ArrowDown')); assert.ok(wikiKey(view, dom, 'Enter'));
  assert.equal(editor.getValue(), '- [[Note#Overview]]');
  assert.equal(view.state.selection.main.head, editor.getValue().length);
  assert.ok(resolved.some(([target, source]) => target === 'Note' && source === 'Source.md'));
  assert.equal(editor.getValue().includes('\n'), false, 'popup Enter does not continue the list');
});

test('createEditor wiki source rejects custom inline comments and late fenced-code context', async t => {
  const { editor, view, cursor } = setup(t, '%% [[No]] %%');
  cursor(7); startCompletion(view);
  await awaitWiki(() => completionStatus(view.state) !== 'pending');
  assert.equal(completionStatus(view.state), null);
  assert.deepEqual(currentCompletions(view.state), []);
  const prefix = 'plain\n\n'.repeat(2000);
  editor.setValue(prefix + '```\n[[No]]\n```'); cursor(prefix.length + 8); startCompletion(view);
  await awaitWiki(() => completionStatus(view.state) !== 'pending');
  assert.equal(completionStatus(view.state), null);
  assert.deepEqual(currentCompletions(view.state), []);
});

test('createEditor nested table wiki popup accepts alias before cell Tab navigation and shares parent undo', async t => {
  const initial = '| A | B |\n| --- | --- |\n| [[Fi]] | stay |';
  const { editor, view, host, dom, changes } = setup(t, initial, 'live', {
    paths: () => ['Alpha.md'], wiki: { metadata: () => ({ aliases: ['First'] }) },
  });
  const child = activateCell(host, dom, 1, 0);
  child.dispatch({ selection: { anchor: 4 } });
  assert.equal(startCompletion(child), true, 'nested table editor installs wiki completion');
  await awaitWiki(() => completionStatus(child.state) === 'active' && selectedCompletionIndex(child.state) === 0);
  assert.equal(currentCompletions(child.state)[0]?.label, 'First');
  assert.ok(wikiKey(child, dom, 'Tab'));
  assert.equal(child.state.doc.toString(), '[[Alpha|First]]');
  assert.equal(child.state.sliceDoc(child.state.selection.main.from, child.state.selection.main.to), 'First');
  assert.equal(EditorView.findFromDOM(host.querySelector('.cm-live-table .cm-editor')!), child, 'popup Tab keeps ownership in the same cell');
  assert.equal(editor.getValue(), initial.replace('[[Fi]]', '[[Alpha\\|First]]'));
  assert.equal(changes.length, 1); assert.equal(undoDepth(view.state), 1); assert.equal(undoDepth(child.state), 0);
  assert.ok(undo(view)); assert.equal(editor.getValue(), initial);
});

test('nested wiki popup survives a table source shift without stale selection or target ownership', async t => {
  const initial = 'Before\n\n| A | B |\n| --- | --- |\n| [[No]] | stay |';
  const { editor, view, host, dom } = setup(t, initial);
  const child = activateCell(host, dom, 1, 0);
  child.dispatch({ selection: { anchor: 4 } }); startCompletion(child);
  await awaitWiki(() => completionStatus(child.state) === 'active' && selectedCompletionIndex(child.state) === 0);
  editor.setValue('Intro\n' + initial);
  await Promise.resolve();
  assert.equal(EditorView.findFromDOM(host.querySelector('.cm-live-table .cm-editor')!), child);
  assert.equal(child.state.selection.main.head, 4);
  assert.equal(completionStatus(child.state), 'active', 'equivalent mapped selection does not cancel popup');
  assert.ok(wikiKey(child, dom, 'Enter'));
  assert.equal(editor.getValue(), 'Intro\n' + initial.replace('[[No]]', '[[Note]]'));
  assert.equal(undoDepth(view.state), 1); assert.ok(undo(view));
  assert.equal(editor.getValue(), 'Intro\n' + initial, 'completion undo preserves unrelated external prefix');
});

test('changing parent selection destroys the old table popup and stale clicks cannot edit a new cell', async t => {
  const initial = '| A | B |\n| --- | --- |\n| [[No]] | stay |';
  const { editor, host, dom, cursor } = setup(t, initial);
  const child = activateCell(host, dom, 1, 0);
  child.dispatch({ selection: { anchor: 4 } }); startCompletion(child);
  await awaitWiki(() => completionStatus(child.state) === 'active');
  const staleRow = child.dom.querySelector('[role="option"]')!; assert.ok(staleRow);
  cursor(initial.indexOf('stay') + 4); await Promise.resolve();
  const next = EditorView.findFromDOM(host.querySelector('.cm-live-table .cm-editor')!)!;
  assert.notEqual(next, child); assert.equal(next.state.doc.toString(), 'stay');
  staleRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(editor.getValue(), initial);
  next.dispatch({ ...next.state.replaceSelection('!'), annotations: Transaction.userEvent.of('input.type') });
  assert.equal(editor.getValue(), initial.replace('stay', 'stay!'));
});

test('nested table wiki completion uses the same custom-comment exclusion as its owning editor', async t => {
  const initial = '| A | B |\n| --- | --- |\n| %% [[No]] %% | stay |';
  const { host, dom } = setup(t, initial);
  const child = activateCell(host, dom, 1, 0);
  child.dispatch({ selection: { anchor: 7 } }); startCompletion(child);
  await awaitWiki(() => completionStatus(child.state) !== 'pending');
  assert.equal(completionStatus(child.state), null);
  assert.deepEqual(currentCompletions(child.state), []);
});
