import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state';
import type { Extension, SelectionRange, StateCommand } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { deleteCharBackward, history, isolateHistory, undo, redo } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { markdownListCommands, markdownListKeymap } from '../src/editor/list-commands.ts';
import type { MarkdownListOptions } from '../src/editor/list-commands.ts';

function setup(doc: string, options: MarkdownListOptions = {}, ranges: SelectionRange[] = [EditorSelection.cursor(doc.length)], extra: Extension = []) {
  let state = EditorState.create({ doc, selection: EditorSelection.create(ranges), extensions: [
    EditorState.allowMultipleSelections.of(true), markdownListKeymap(options), markdown({ base: markdownLanguage }), history(), extra,
  ] });
  const transactions: Transaction[] = [];
  const target = { get state() { return state; }, dispatch(transaction: Transaction) { transactions.push(transaction); state = transaction.state; } };
  return { target, commands: markdownListCommands(options), transactions,
    run(command: StateCommand) { return command(target); },
    get text() { return state.doc.toString(); }, get state() { return state; } };
}

test('defaults use literal tabs; space indentation remains four at another tab width', () => {
  const tabs = setup('- item'); tabs.run(tabs.commands.tab);
  assert.equal(tabs.text, '\t- item'); assert.equal(tabs.state.tabSize, 4); assert.equal(tabs.state.facet(indentUnit), '\t');
  const spaces = setup('- item', { useTab: false, tabSize: 8 }); spaces.run(spaces.commands.tab);
  assert.equal(spaces.text, '    - item'); assert.equal(spaces.state.tabSize, 8); assert.equal(spaces.state.facet(indentUnit), '    ');
  assert.equal(setup('', { tabSize: undefined }).state.tabSize, 4);
  assert.throws(() => markdownListKeymap({ tabSize: 0 }), RangeError);
});

test('forward and reverse selections exclude endpoint at next line start and preserve direction', () => {
  for (const reverse of [false, true]) {
    const source = '- parent\n\t- child\n- end'; const end = source.indexOf('- end');
    const editor = setup(source, {}, [EditorSelection.range(reverse ? end : 0, reverse ? 0 : end)]);
    editor.run(editor.commands.tab);
    assert.equal(editor.text, '\t- parent\n\t\t- child\n- end');
    assert.equal(editor.state.selection.main.anchor > editor.state.selection.main.head, reverse);
    assert.equal(editor.state.selection.main.from, 1); assert.equal(editor.state.selection.main.to, end + 2);
    assert.equal(editor.transactions.at(-1)?.annotation(Transaction.userEvent), 'input.indent');
    editor.run(editor.commands.shiftTab); assert.equal(editor.text, source);
    assert.equal(editor.transactions.at(-1)?.annotation(Transaction.userEvent), 'delete.dedent');
  }
});

test('multiple ranges visit each selected line once and do not include unselected descendants', () => {
  const editor = setup('- first\n\t- nested\n- last', {}, [EditorSelection.cursor(2), EditorSelection.cursor(5), EditorSelection.cursor(24)]);
  editor.run(editor.commands.tab);
  assert.equal(editor.text, '\t- first\n\t- nested\n\t- last');
  assert.deepEqual(editor.state.selection.ranges.map(range => range.head), [3, 6, 26]);
});

test('indent follows last quote; dedent removes pre-quote whitespace first', () => {
  const source = '  > > - one\n>   - two\n>\t- three\n> ';
  const editor = setup(source, {}, [EditorSelection.range(0, source.length)]);
  editor.run(editor.commands.tab);
  assert.equal(editor.text, '  > > \t- one\n> \t  - two\n>\t\t- three\n> \t');
  editor.run(editor.commands.shiftTab);
  assert.equal(editor.text, '> > \t- one\n>   - two\n>\t- three\n> ');
});

test('dedent computes visual width and reconstructs tabs and residual spaces', () => {
  for (const [options, source, expected] of [
    [{ tabSize: 4 }, '      - a', '  - a'],
    [{ tabSize: 2 }, ' \t\t - a', '\t - a'],
    [{ useTab: false, tabSize: 8 }, '\t  - a', '      - a'],
    [{ tabSize: 8 }, '   - a', '- a'],
  ] as const) { const editor = setup(source, options); editor.run(editor.commands.shiftTab); assert.equal(editor.text, expected); }
});

test('Enter preserves bullet or ordered delimiter and resets all task statuses', () => {
  for (const [source, expected] of [
    ['- body', '- body\n- '], ['+ body', '+ body\n+ '], ['* body', '* body\n* '],
    ['9. body', '9. body\n10. '], ['3) body', '3) body\n4) '],
    ...[' ', 'x', 'X', '-', '?'].map(status => [`> \t2) [${status}] body`, `> \t2) [${status}] body\n> \t3) [ ] `]),
  ]) { const editor = setup(source); editor.run(editor.commands.enter); assert.equal(editor.text, expected); assert.equal(editor.transactions.at(-1)?.annotation(Transaction.userEvent), 'input.type'); }
});

test('Enter empty items removes top level and dedents nested tasks by tab or at most four spaces', () => {
  for (const [source, expected] of [
    ['- [ ] ', ''], ['12) ', ''], ['- parent\n\t- [x] ', '- parent\n- [x] '], ['- parent\n      - [?] ', '- parent\n  - [?] '],
    ['> - [ ] ', '> '], ['> > ', '> '],
  ]) { const editor = setup(source, { tabSize: 8 }); editor.run(editor.commands.enter); assert.equal(editor.text, expected); }
});

test('continuation lines find a matching list prefix, including inside quotes', () => {
  for (const [source, expected] of [
    ['- first\n  continued', '- first\n  continued\n- '],
    ['> - first\n>   continued', '> - first\n>   continued\n> - '],
  ]) { const editor = setup(source); editor.run(editor.commands.enter); assert.equal(editor.text, expected); }
});

test('continuation lookup stops at a shorter prefix and multiple cursors continue independently', () => {
  const stopped = setup('- first\nplain\n  continued'); stopped.run(stopped.commands.enter);
  assert.equal(stopped.text, '- first\nplain\n  continued\n  ');
  const source = '- [x] first\n2) second';
  const editor = setup(source, {}, [EditorSelection.cursor(11), EditorSelection.cursor(source.length)]);
  editor.run(editor.commands.enter);
  assert.equal(editor.text, '- [x] first\n- [ ] \n2) second\n3) ');
  assert.deepEqual(editor.state.selection.ranges.map(range => range.head), [18, 32]);
});

test('splitting before existing marker removes following whitespace without duplicate marker', () => {
  const editor = setup('- first   - second', {}, [EditorSelection.cursor(7)]);
  editor.run(editor.commands.enter); assert.equal(editor.text, '- first\n- second'); assert.equal(editor.state.selection.main.head, 8);
});

test('Shift-Enter preserves quote and indentation with spaces replacing the marker', () => {
  const editor = setup('> \t9) [x] body'); editor.run(editor.commands.shiftEnter);
  assert.equal(editor.text, '> \t9) [x] body\n> \t       ');
  const selected = setup('- body', {}, [EditorSelection.range(2, 6)]); selected.run(selected.commands.shiftEnter);
  assert.equal(selected.text, '- \n');
});

test('noncollapsed selection or caret within prefix falls back for the whole Enter operation', () => {
  const source = '- first\n- second';
  const editor = setup(source, {}, [EditorSelection.cursor(7), EditorSelection.range(10, 16)]);
  editor.run(editor.commands.enter); assert.equal(editor.text, '- first\n\n- \n');
  const prefix = setup('- [x] body', {}, [EditorSelection.cursor(3)]); prefix.run(prefix.commands.enter);
  assert.equal(prefix.text, '- [\nx] body');
});

test('fenced code, indented code, tables and math use indentation-only continuation', () => {
  for (const [source, position, expected] of [
    ['```md\n- body\n```', 12, '```md\n- body\n  \n```'],
    ['    - body', 10, '    - body\n      '],
    ['| a | b |\n| - | - |\n| c | d |', 29, '| a | b |\n| - | - |\n| c | d |\n'],
    ['$$\n- body\n$$', 9, '$$\n- body\n  \n$$'],
  ] as const) { const editor = setup(source, {}, [EditorSelection.cursor(position)]); editor.run(editor.commands.enter); assert.equal(editor.text, expected); }
});

test('each command is undoable and redoable in its own history event', () => {
  const editor = setup('- [X] body');
  editor.run(editor.commands.enter); const continued = editor.text;
  editor.target.dispatch(editor.state.update({ annotations: isolateHistory.of('full') }));
  editor.run(editor.commands.tab); const indented = editor.text;
  assert.ok(editor.run(undo)); assert.equal(editor.text, continued);
  assert.ok(editor.run(undo)); assert.equal(editor.text, '- [X] body');
  assert.ok(editor.run(redo)); assert.equal(editor.text, continued);
  assert.ok(editor.run(redo)); assert.equal(editor.text, indented);
});

test('read-only commands never dispatch and smart indentation can be disabled', () => {
  const editor = setup('- [x] body', {}, undefined, EditorState.readOnly.of(true));
  for (const command of Object.values(editor.commands)) assert.equal(editor.run(command), false);
  assert.equal(editor.transactions.length, 0);
  const plain = setup('- body', { smartIndentList: false }); plain.run(plain.commands.enter); assert.equal(plain.text, '- body\n');
});

test('default Backspace matches the bounded whitespace behavior without deleting whole task markers', () => {
  for (const [source, options, expected] of [
    ['      ', {}, '    '], ['\t', {}, ''], ['      ', { tabSize: 2 }, '    '],
    ['      ', { useTab: false, tabSize: 8 }, '    '], ['- [ ] ', {}, '- [ ]'], ['first\n', {}, 'first'],
  ] as const) { const editor = setup(source, options); editor.run(deleteCharBackward); assert.equal(editor.text, expected); }
});

test('custom keymap precedes markdown high precedence while highest table binding remains first', () => {
  const table = () => false;
  const editor = setup('', {}, undefined, Prec.highest(keymap.of([{ key: 'Tab', run: table }])));
  const bindings = editor.state.facet(keymap).flat();
  assert.equal(bindings[0].run, table);
  assert.equal(bindings.filter(binding => binding.key === 'Enter')[0].shift !== undefined, true);
});
