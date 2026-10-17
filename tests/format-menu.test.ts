import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import { formatMenuForEditor } from '../src/editor/format-menu.ts';
import type { FormatMenuItem } from '../src/editor/format-menu.ts';
import { liveTables, activeTableEditor } from '../src/editor/live-tables.ts';
import { parseTable } from '../src/editor/table-model.ts';

function setup(t: TestContext, doc: string, tables = false) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Text: dom.window.Text, Window: dom.window.Window, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const rect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  const readonly = new Compartment(), transactions: Transaction[] = [];
  const view = new EditorView({ parent: document.querySelector('main')!, state: EditorState.create({ doc,
    extensions: [markdown({base:markdownLanguage}), ...(tables ? [liveTables(() => {})] : []), history(), EditorState.allowMultipleSelections.of(true),
      readonly.of(EditorState.readOnly.of(false)), EditorView.updateListener.of(update => transactions.push(...update.transactions))] }) });
  t.after(() => {
    view.destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const inputs = () => [...view.dom.querySelectorAll<HTMLInputElement>('.task-list-item-checkbox')];
  const toggle = (input: HTMLInputElement) => { input.checked = !input.checked; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  return { view, inputs, toggle, dom, readonly, transactions };
}

function find(items: FormatMenuItem[], id: string): Exclude<FormatMenuItem, { type: 'separator' }> {
  for (const item of items) {
    if ('id' in item && item.id === id) return item;
    if ('submenu' in item) { const found = search(item.submenu, id); if (found) return found; }
  }
  throw new Error(`Missing menu action ${id}`);
}
function search(items: FormatMenuItem[], id: string): ReturnType<typeof find> | undefined {
  for (const item of items) { if ('id' in item && item.id === id) return item; if ('submenu' in item) { const result = search(item.submenu, id); if (result) return result; } }
}
function run(view: EditorView, id: string) {
  const item = find(formatMenuForEditor(view), id);
  assert.ok('run' in item); return item.run();
}
function select(view: EditorView, from: number, to = from) { view.dispatch({ selection: EditorSelection.single(from, to) }); }

test('format labels remain stable and cell insertion enables only inline actions', t => {
  const { view } = setup(t, 'text');
  const menu = formatMenuForEditor(view, { inTableCell: true });
  assert.deepEqual(menu.map(item => 'label' in item ? item.label : '|'), ['Add link', 'Add external link', '|', 'Format', 'Paragraph', 'Insert']);
  const format = find(menu, 'format'); assert.ok('submenu' in format);
  assert.deepEqual(format.submenu.map(item => 'label' in item ? item.label : '|'), ['Bold', 'Italic', 'Strikethrough', 'Highlight', '|', 'Code', 'Math', 'Comment', '|', 'Clear formatting']);
  const highlight = find(menu, 'format-highlight'); assert.ok('submenu' in highlight);
  assert.deepEqual(highlight.submenu.map(item => 'label' in item ? item.label : ''), ['Default', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple']);
  const paragraph = find(menu, 'paragraph'); assert.equal(paragraph.enabled, false);
  const insertion = find(menu, 'insert'); assert.equal(insertion.enabled, true); assert.ok('submenu' in insertion);
  for (const item of insertion.submenu) if ('id' in item) assert.equal(item.enabled, ['insert-markdown-link', 'insert-image'].includes(item.id));
  assert.equal(find(menu, 'paragraph-heading-6').label, 'Heading 6');
  const disabled = find(menu, 'insert-table'); assert.ok('run' in disabled); assert.equal(disabled.run(), false);
  assert.equal(view.state.doc.toString(), 'text');
});

test('link insertion preserves selected text and places the caret at reference locations', t => {
  const { view } = setup(t, 'hello world');
  select(view, 0, 5); run(view, 'insert-link');
  assert.equal(view.state.doc.toString(), '[[hello]] world'); assert.equal(view.state.selection.main.head, 7);
  assert.ok(undo(view)); select(view, 0, 5); run(view, 'insert-external-link');
  assert.equal(view.state.doc.toString(), '[hello]() world'); assert.equal(view.state.selection.main.head, 8);
  assert.ok(undo(view)); select(view, 0); run(view, 'insert-external-link');
  assert.equal(view.state.doc.toString(), '[]()hello world'); assert.equal(view.state.selection.main.head, 1);
});

test('link menu disables multiline selection; captured actions recheck current read-only state', t => {
  const { view, readonly } = setup(t, 'one\ntwo');
  select(view, 0, view.state.doc.length);
  assert.equal(find(formatMenuForEditor(view), 'insert-link').enabled, false);
  assert.equal(run(view, 'insert-link'), false);
  const action = find(formatMenuForEditor(view), 'format-bold'); assert.ok('run' in action);
  view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(true)) });
  assert.equal(action.run(), false); assert.equal(view.state.doc.toString(), 'one\ntwo');
  assert.equal(find(formatMenuForEditor(view), 'format').enabled, false);
});

test('bold trims whitespace, preserves reversed selection and toggles alternate underscore syntax', t => {
  const { view, transactions } = setup(t, '  word  ');
  select(view, 8, 0); run(view, 'format-bold');
  assert.equal(view.state.doc.toString(), '  **word**  ');
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'word');
  assert.ok(view.state.selection.main.anchor > view.state.selection.main.head);
  assert.equal(transactions.at(-1)!.annotation(Transaction.userEvent), 'input.type');
  assert.equal(find(formatMenuForEditor(view), 'format-bold').checked, true);
  run(view, 'format-bold'); assert.equal(view.state.doc.toString(), '  word  ');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '__word__' }, selection: { anchor: 3 } });
  assert.equal(find(formatMenuForEditor(view), 'format-bold').checked, true);
  run(view, 'format-bold'); assert.equal(view.state.doc.toString(), 'word');
});

test('collapsed formatting uses current word, inserts empty delimiters, and skips an existing closing marker', t => {
  const { view } = setup(t, 'word ');
  select(view, 2); run(view, 'format-italic');
  assert.equal(view.state.doc.toString(), '*word* '); assert.equal(view.state.selection.main.head, 3);
  select(view, 5); run(view, 'format-italic');
  assert.equal(view.state.doc.toString(), '*word* '); assert.equal(view.state.selection.main.head, 6);
  select(view, view.state.doc.length); run(view, 'format-math');
  assert.equal(view.state.doc.toString(), '*word* $$'); assert.equal(view.state.selection.main.head, 8);
});

test('multiline formatting preserves list/task/heading/quote prefixes and skips fenced code', t => {
  const source = '# title\n- [ ] task\n> quote\n\n```md\nliteral\n```\nend';
  const { view } = setup(t, source);
  select(view, 0, source.length); run(view, 'format-bold');
  assert.equal(view.state.doc.toString(), '# **title**\n- [ ] **task**\n> **quote**\n\n```md\nliteral\n```\n**end**');
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), source);
  assert.ok(redo(view)); assert.ok(view.state.doc.toString().includes('**title**'));
});

test('multiple selections format independently and use the first range toggle mode', t => {
  const { view } = setup(t, 'one two');
  view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(7, 4)], 1) });
  run(view, 'format-strikethrough');
  assert.equal(view.state.doc.toString(), '~~one~~ ~~two~~');
  assert.deepEqual(view.state.selection.ranges.map(range => view.state.sliceDoc(range.from, range.to)), ['one', 'two']);
  assert.equal(view.state.selection.mainIndex, 1);
  run(view, 'format-strikethrough'); assert.equal(view.state.doc.toString(), 'one two');
});

test('comment keeps multiline selection and whitespace; code/math preserve other formatting', t => {
  const { view } = setup(t, ' first\n second ');
  select(view, 0, view.state.doc.length); run(view, 'format-comment');
  assert.equal(view.state.doc.toString(), '%% first\n second %%');
  assert.equal(find(formatMenuForEditor(view), 'format-comment').checked, true);
  run(view, 'format-comment'); assert.equal(view.state.doc.toString(), ' first\n second ');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '**word**' }, selection: EditorSelection.single(0, 8) });
  run(view, 'format-code'); assert.equal(view.state.doc.toString(), '`**word**`');
  assert.equal(find(formatMenuForEditor(view), 'format-code').checked, true);
  run(view, 'format-code'); assert.equal(view.state.doc.toString(), '**word**');
});

test('highlight colors recolor, split and remove while preserving existing aliases outside selection', t => {
  const { view } = setup(t, 'alpha beta gamma');
  select(view, 0, view.state.doc.length); run(view, 'format-highlight-red');
  assert.equal(view.state.doc.toString(), '==🔴alpha beta gamma==');
  assert.equal(find(formatMenuForEditor(view), 'format-highlight-red').checked, true);
  select(view, 10, 14); run(view, 'format-highlight-blue');
  assert.equal(view.state.doc.toString(), '==🔴alpha== ==🔵beta== ==🔴gamma==');
  const beta = view.state.doc.toString().indexOf('beta'); select(view, beta + 1); run(view, 'format-highlight-blue');
  assert.equal(view.state.doc.toString(), '==🔴alpha== beta ==🔴gamma==');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '==🟥one two==' }, selection: EditorSelection.single(8, 11) });
  run(view, 'format-highlight-blue');
  assert.equal(view.state.doc.toString(), '==🟥one== ==🔵two==');
});

test('empty colored highlight places caret after the emoji and clear formatting removes syntax only', t => {
  const { view } = setup(t, ' ');
  select(view, 1); run(view, 'format-highlight-green');
  assert.equal(view.state.doc.toString(), ' ==🟢=='); assert.equal(view.state.selection.main.head, 5);
  const source = '# **bold** and _italic_ ==🔴red== [label](url)';
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source }, selection: EditorSelection.single(0, source.length), annotations: isolateHistory.of('full') });
  run(view, 'format-clear'); assert.equal(view.state.doc.toString(), ' bold and italic red labelurl');
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), source);
});

test('formatting inside an active table child updates parent source and parent undo', t => {
  const source = '| Name |\n| --- |\n| a\\|b |';
  const { view, dom } = setup(t, source, true);
  const cell = view.dom.querySelector('tbody td')!;
  assert.ok(cell); cell.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  const child = activeTableEditor(view)!; assert.ok(child);
  select(child, 0, child.state.doc.length); run(child, 'format-bold');
  assert.equal(child.state.doc.toString(), '**a|b**');
  assert.ok(view.state.doc.toString().includes('**a\\|b**'));
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), source);
});

test('comment and inline math contents are opaque to nested Markdown formatting state', t => {
  const { view } = setup(t, '%%**literal**%% and $*math*$');
  select(view, 5);
  assert.equal(find(formatMenuForEditor(view), 'format-comment').checked, true);
  assert.equal(find(formatMenuForEditor(view), 'format-bold').checked, false);
  select(view, view.state.doc.length - 4);
  assert.equal(find(formatMenuForEditor(view), 'format-math').checked, true);
  assert.equal(find(formatMenuForEditor(view), 'format-italic').checked, false);
  select(view, 0, view.state.doc.length); run(view, 'format-clear');
  assert.equal(view.state.doc.toString(), '**literal** and *math*');
});

test('captured actions apply to current selections and reject a destroyed editor', t => {
  const { view } = setup(t, 'one two');
  const action = find(formatMenuForEditor(view), 'format-bold'); assert.ok('run' in action);
  select(view, 4, 7); action.run();
  assert.equal(view.state.doc.toString(), 'one **two**');
  view.destroy();
  assert.equal(action.run(), false);
});

test('large comment-dense menu inspection avoids repeated all-span membership scans', t => {
  const sizes = [1000, 10000];
  const states = sizes.map(size => {
    const doc = '%%comment%% '.repeat(size);
    return EditorState.create({ doc, selection: { anchor: doc.length - 5 } });
  });
  // Count predicate visits rather than relying on machine-dependent latency.
  // The previous lexical-exclusion/opacity .some scans made over 100 million
  // visits at 10k comments; indexed inspection needs no growing linear probes.
  const original = Array.prototype.some;
  let visits = 0;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'some')!;
  Object.defineProperty(Array.prototype, 'some', { ...descriptor, value: function(predicate, thisArg) {
    return original.call(this, (value, index, array) => { visits++; return predicate.call(thisArg, value, index, array); });
  } });
  try {
    for (const state of states) {
      const menu = formatMenuForEditor({ state } as EditorView);
      assert.equal(find(menu, 'format-comment').checked, true);
      assert.equal(find(menu, 'format-bold').checked, false);
    }
  } finally { Object.defineProperty(Array.prototype, 'some', descriptor); }
  assert.ok(visits < sizes.reduce((sum, size) => sum + size, 0) * 5, `unexpected repeated membership visits: ${visits}`);
});

test('highlight closing delimiters inside inline code stay literal during toggle and clear', t => {
  const source = '==a `x==y` z==';
  const { view } = setup(t, source);
  select(view, 0, source.length);
  assert.equal(find(formatMenuForEditor(view), 'format-highlight-default').checked, true);
  run(view, 'format-highlight-default');
  assert.equal(view.state.doc.toString(), 'a `x==y` z');
  assert.ok(undo(view));
  select(view, 0, source.length); run(view, 'format-clear');
  assert.equal(view.state.doc.toString(), 'a x==y z');
});


test('provided table cell ranges use first-cell state, skip empty cells and annotate one transaction', t => {
  const source = '| A | B |\n| --- | --- |\n| **one** | two |\n|  | three |';
  const { view, transactions } = setup(t, source);
  const preserve = Annotation.define<boolean>();
  const ranges = () => parseTable(view.state.doc.toString())!.rows.slice(1).flatMap(row => row.cells.map(cell => ({ from: cell.from, to: cell.to })));
  const options = { ranges, annotations: [preserve.of(true)] };
  const before = transactions.length, menu = formatMenuForEditor(view, options);
  assert.equal(transactions.length, before, 'menu construction dispatches no temporary selection');
  const action = find(menu, 'format-bold'); assert.ok('run' in action);
  assert.equal(action.checked, true);
  action.run();
  assert.equal(transactions.length, before + 1);
  assert.equal(transactions.at(-1)!.annotation(preserve), true);
  assert.equal(view.state.doc.toString(), '| A | B |\n| --- | --- |\n| one | two |\n|  | three |');
  const add = find(formatMenuForEditor(view, options), 'format-bold'); assert.ok('run' in add); add.run();
  assert.equal(view.state.doc.toString(), '| A | B |\n| --- | --- |\n| **one** | **two** |\n|  | **three** |');
  assert.equal(view.state.selection.ranges.length, 4);
});

test('range providers resolve positions at action time and reject vanished or invalid rectangles', t => {
  const source = '| A | B |\n| --- | --- |\n| a\\|b | word |';
  const { view } = setup(t, source);
  let active = true;
  const ranges = () => {
    if (!active) return [];
    const text = view.state.doc.toString(), start = text.indexOf('| A |');
    return parseTable(text.slice(start), start)!.rows[1].cells.map(cell => ({ from: cell.from, to: cell.to }));
  };
  const action = find(formatMenuForEditor(view, { ranges }), 'format-italic'); assert.ok('run' in action);
  view.dispatch({ changes: { from: 0, insert: 'prefix\n\n' }, annotations: isolateHistory.of('full') });
  action.run();
  assert.equal(view.state.doc.toString(), 'prefix\n\n| A | B |\n| --- | --- |\n| *a\\|b* | *word* |');
  assert.ok(undo(view)); assert.equal(view.state.doc.toString(), 'prefix\n\n' + source);
  active = false;
  assert.equal(action.run(), false);
  assert.equal(find(formatMenuForEditor(view, { ranges }), 'format').enabled, false);
  const invalid = find(formatMenuForEditor(view, { ranges: () => [{ from: 0, to: 999999 }] }), 'format-bold');
  assert.ok('run' in invalid); assert.equal(invalid.run(), false);
});

test('rectangular highlight and clear target only selected encoded cell spans', t => {
  const source = '| A | B |\n| --- | --- |\n| one | two |\n|  | three |';
  const { view, transactions } = setup(t, source);
  const preserve = Annotation.define<boolean>();
  const ranges = () => parseTable(view.state.doc.toString())!.rows.slice(1).map(row => ({ from: row.cells[0].from, to: row.cells[0].to }));
  const options = { ranges, annotations: [preserve.of(true)] };
  const highlight = find(formatMenuForEditor(view, options), 'format-highlight-blue'); assert.ok('run' in highlight); highlight.run();
  assert.equal(view.state.doc.toString(), '| A | B |\n| --- | --- |\n| ==🔵one== | two |\n|  | three |');
  assert.equal(transactions.at(-1)!.annotation(preserve), true);
  const clear = find(formatMenuForEditor(view, options), 'format-clear'); assert.ok('run' in clear); clear.run();
  assert.equal(view.state.doc.toString(), source);
  assert.equal(transactions.at(-1)!.annotation(preserve), true);
});

test('rectangle custom syntax never pairs delimiters across cells, rows or table boundaries', t => {
  const { view } = setup(t, '');
  for (const [marker, id] of [['==', 'format-highlight-default'], ['%%', 'format-comment'], ['$', 'format-math']]) {
    for (const source of [
      `| A | B |\n| --- | --- |\n| ${marker}one | two${marker} |`,
      `| ${marker}A | B |\n| --- | --- |\n| one | two${marker} |`,
      `${marker}outside\n\n| A | B |\n| --- | --- |\n| one | two${marker} |`,
    ]) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
      const ranges = () => {
        const text = view.state.doc.toString(), start = text.indexOf('|');
        const cell = parseTable(text.slice(start), start)!.rows[1].cells[0];
        return [{ from: cell.from, to: cell.to }];
      };
      const options = { ranges }, action = find(formatMenuForEditor(view, options), id);
      assert.equal(action.checked, false, source);
      const clear = find(formatMenuForEditor(view, options), 'format-clear'); assert.ok('run' in clear); clear.run();
      assert.equal(view.state.doc.toString(), source, 'unmatched custom delimiters are literal');
      assert.ok('run' in action); action.run();
      const selected = ranges()[0], text = view.state.doc.toString();
      assert.equal(text.slice(0, selected.from), source.slice(0, source.indexOf('one') - (source.includes(`${marker}one`) ? marker.length : 0)));
      assert.ok(text.endsWith(` | two${marker} |`), 'unselected cell source stays intact');
    }
  }
});

test('cell-local custom syntax preserves encoded breaks and escaped pipes when removing wrappers', t => {
  const { view } = setup(t, '');
  for (const [marker, id] of [['==', 'format-highlight-default'], ['%%', 'format-comment'], ['$', 'format-math']]) {
    const source = `| A | B |\n| --- | --- |\n| ${marker}a\\|b<br>c${marker} | ${marker}other${marker} |`;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
    const ranges = () => {
      const cell = parseTable(view.state.doc.toString())!.rows[1].cells[0];
      return [{ from: cell.from, to: cell.to }];
    };
    const action = find(formatMenuForEditor(view, { ranges }), id); assert.ok('run' in action);
    assert.equal(action.checked, true); action.run();
    assert.equal(view.state.doc.toString(), `| A | B |\n| --- | --- |\n| a\\|b<br>c | ${marker}other${marker} |`);
  }
});


test('late table cells stay independent when the initial Markdown syntax tree is partial', t => {
  t.mock.method(Date, 'now', () => 0);
  const prefix = 'plain\n\n'.repeat(2000);
  for (const [body, id, expected] of [
    ['==one | two==', 'format-highlight-default', '====one== | two=='],
    ['%%one | two%%', 'format-comment', '%%%%one%% | two%%'],
    ['$one | two$', 'format-math', '$$one$ | two$'],
    ['==a `x==y` z== | other', 'format-highlight-default', 'a `x==y` z | other'],
    ['**one** | other', 'format-bold', 'one | other'],
  ]) {
    const table = `| A | B |\n| --- | --- |\n| ${body} |`;
    let state = EditorState.create({ doc: prefix + table, extensions: [markdown({ base: markdownLanguage }), EditorState.allowMultipleSelections.of(true)] });
    assert.ok(syntaxTree(state).length < state.doc.length, 'fixture begins with a partial parser tree');
    const view = { get state() { return state; }, dom: { isConnected: true }, focus() {}, dispatch(spec) { state = state.update(spec).state; } } as unknown as EditorView;
    const ranges = () => {
      const cell = parseTable(state.sliceDoc(prefix.length), prefix.length)!.rows[1].cells[0];
      return [{ from: cell.from, to: cell.to }];
    };
    const action = find(formatMenuForEditor(view, { ranges }), id); assert.ok('run' in action); assert.equal(action.run(), true);
    assert.equal(state.doc.toString(), prefix + `| A | B |\n| --- | --- |\n| ${expected} |`);
  }
});

// Keep parser budgets deterministic without sleeping or changing production
// limits. The real Markdown parser still stops at CM's initial 3,000-character
// viewport; freezing only its clock lets the explicit ensure complete in tests.
const partialPrefix = 'plain\n\n'.repeat(600);
function partialFormattingFixture(text: string) {
  let state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage }), EditorState.allowMultipleSelections.of(true)] });
  const transactions: Transaction[] = [];
  const view = { get state() { return state; }, dom: { isConnected: true }, focus() {}, dispatch(spec) {
    const transaction = state.update(spec); transactions.push(transaction); state = transaction.state;
  } } as unknown as EditorView;
  const replace = (text: string) => { state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage }), EditorState.allowMultipleSelections.of(true)] }); };
  const ranges = () => {
    const from = state.doc.toString().lastIndexOf('| A | B |');
    const cell = parseTable(state.sliceDoc(from), from)!.rows[1].cells[0];
    return [{ from: cell.from, to: cell.to }];
  };
  return { view, transactions, replace, ranges };
}

test('first table formatting inspection uses the ensured tree without publishing a selection transaction', t => {
  t.mock.method(Date, 'now', () => 0);
  const table = '| A | B |\n| --- | --- |\n| **one** | other |';
  const f = partialFormattingFixture(partialPrefix + table), snapshot = syntaxTree(f.view.state);
  assert.ok(snapshot.length < partialPrefix.length, 'real initial viewport stops before the table');
  const menu = formatMenuForEditor(f.view, { ranges: f.ranges });
  assert.equal(find(menu, 'format-bold').checked, true);
  assert.equal(find(menu, 'format-italic').checked, false);
  assert.equal(find(menu, 'format-bold').enabled, true);
  assert.equal(syntaxTree(f.view.state), snapshot, 'ensuring the mutable parse context does not publish a new state tree');
  assert.equal(f.transactions.length, 0, 'inspection preserves rectangle ownership');
});

for (const [id, marked] of [
  ['format-bold', '**one**'], ['format-italic', '*one*'],
  ['format-strikethrough', '~~one~~'], ['format-code', '`one`'],
  ['format-clear', '**one**'],
]) test(`captured ${id} uses a cold ensured table tree at action time`, t => {
  t.mock.method(Date, 'now', () => 0);
  const table = `| A | B |\n| --- | --- |\n| ${marked} | other |`;
  const f = partialFormattingFixture(table);
  const action = find(formatMenuForEditor(f.view, { ranges: f.ranges }), id); assert.ok('run' in action);
  f.replace(partialPrefix + table);
  assert.ok(syntaxTree(f.view.state).length < partialPrefix.length);
  assert.equal(action.run(), true);
  assert.equal(f.view.state.doc.toString(), partialPrefix + '| A | B |\n| --- | --- |\n| one | other |');
  assert.equal(f.transactions.length, 1, 'no preliminary parse/selection dispatch');
});

test('ensured content-line markers keep late heading syntax outside formatting wrappers', t => {
  t.mock.method(Date, 'now', () => 0);
  const f = partialFormattingFixture(partialPrefix + '# title');
  assert.ok(syntaxTree(f.view.state).length < partialPrefix.length);
  const ranges = () => [{ from: partialPrefix.length, to: f.view.state.doc.length }];
  const action = find(formatMenuForEditor(f.view, { ranges }), 'format-bold'); assert.ok('run' in action);
  // Replacing with a fresh state prevents menu inspection from warming the
  // action's parse context and hiding stale contentLine lookups.
  f.replace(partialPrefix + '# title');
  assert.equal(action.run(), true);
  assert.equal(f.view.state.doc.toString(), partialPrefix + '# **title**');
  assert.equal(f.transactions.length, 1);
});

test('exhausted parser budget makes no edit and a later completed ensure uses its returned tree', t => {
  let exhausted = false, clock = 0;
  t.mock.method(Date, 'now', () => exhausted ? clock += 1000 : clock);
  const table = '| A | B |\n| --- | --- |\n| **one** | other |';
  const f = partialFormattingFixture(table);
  const action = find(formatMenuForEditor(f.view, { ranges: f.ranges }), 'format-bold'); assert.ok('run' in action);
  f.replace(partialPrefix + table);
  exhausted = true;
  const unavailable = find(formatMenuForEditor(f.view, { ranges: f.ranges }), 'format-bold');
  assert.equal(unavailable.enabled, false);
  assert.equal(action.run(), false); assert.equal(f.transactions.length, 0);
  assert.equal(f.view.state.doc.toString(), partialPrefix + table);
  exhausted = false;
  assert.equal(action.run(), true);
  assert.equal(f.view.state.doc.toString(), partialPrefix + '| A | B |\n| --- | --- |\n| one | other |');
  assert.equal(f.transactions.length, 1);
});
