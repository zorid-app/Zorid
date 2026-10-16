import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import { formatMenuForEditor } from '../src/editor/format-menu.ts';
import type { FormatMenuItem } from '../src/editor/format-menu.ts';
import { liveTables, activeTableEditor } from '../src/editor/live-tables.ts';

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

test('reference labels, highlight order and disabled cell block submenus are exact', t => {
  const { view } = setup(t, 'text');
  const menu = formatMenuForEditor(view, { inTableCell: true });
  assert.deepEqual(menu.map(item => 'label' in item ? item.label : '|'), ['Add link', 'Add external link', '|', 'Format', 'Paragraph', 'Insert']);
  const format = find(menu, 'format'); assert.ok('submenu' in format);
  assert.deepEqual(format.submenu.map(item => 'label' in item ? item.label : '|'), ['Bold', 'Italic', 'Strikethrough', 'Highlight', '|', 'Code', 'Math', 'Comment', '|', 'Clear formatting']);
  const highlight = find(menu, 'format-highlight'); assert.ok('submenu' in highlight);
  assert.deepEqual(highlight.submenu.map(item => 'label' in item ? item.label : ''), ['Default', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple']);
  for (const id of ['paragraph', 'insert']) { const item = find(menu, id); assert.equal(item.enabled, false); assert.ok('submenu' in item); }
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
