// @vitest-environment happy-dom

import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  createMountedMarkdownEditor,
  indentListItemsAtSelection,
  outdentListItemsAtSelection,
  toggleBulletListAtSelection,
  toggleTaskListAtSelection,
} from '../packages/editor/src/index';

type Command = (view: ReturnType<typeof createMountedMarkdownEditor>['view']) => boolean;

function runCommand(
  text: string,
  command: Command,
  selection?: { from: number; to?: number },
): { text: string; events: Array<string | undefined>; result: boolean } {
  const parent = document.createElement('div');
  const events: Array<string | undefined> = [];
  const editor = createMountedMarkdownEditor({
    parent,
    text,
    onChange: (_text, update) => events.push(update.transactions.at(-1)?.annotation(Transaction.userEvent)),
  });
  if (selection) editor.view.dispatch({ selection: { anchor: selection.from, head: selection.to ?? selection.from } });
  const result = command(editor.view);
  const nextText = editor.getText();
  editor.destroy();
  return { text: nextText, events, result };
}

function span(text: string, start: string, end: string = start): { from: number; to: number } {
  return { from: text.indexOf(start), to: text.indexOf(end) + end.length };
}

describe('editor Markdown list commands', () => {
  it('toggles a bullet list on the current plain line', () => {
    expect(runCommand('alpha', toggleBulletListAtSelection, { from: 1 })).toMatchObject({
      result: true,
      text: '- alpha',
      events: ['input.list.toggle.bullet'],
    });
    expect(runCommand('- alpha', toggleBulletListAtSelection, { from: 3 })).toMatchObject({
      result: true,
      text: 'alpha',
      events: ['input.list.toggle.bullet'],
    });
  });

  it('toggles bullets across selected eligible lines while skipping blanks', () => {
    const text = ['alpha', '', 'beta'].join('\n');
    expect(runCommand(text, toggleBulletListAtSelection, span(text, 'alpha', 'beta')).text).toBe('- alpha\n\n- beta');
    expect(
      runCommand('- alpha\n\n- beta', toggleBulletListAtSelection, { from: 0, to: '- alpha\n\n- beta'.length }).text,
    ).toBe('alpha\n\nbeta');
  });

  it('leaves task lines unchanged for bullet toggles and returns false for task-only selections', () => {
    expect(runCommand('- [ ] task', toggleBulletListAtSelection, { from: 3 })).toMatchObject({
      result: false,
      text: '- [ ] task',
      events: [],
    });
    const text = ['alpha', '- [x] done', '- beta'].join('\n');
    expect(runCommand(text, toggleBulletListAtSelection, { from: 0, to: text.length }).text).toBe(
      ['- alpha', '- [x] done', '- beta'].join('\n'),
    );
  });

  it('does not transform ordered list lines in the unordered/task command pass', () => {
    expect(runCommand('1. item', toggleBulletListAtSelection, { from: 0 })).toMatchObject({
      result: false,
      text: '1. item',
    });
    expect(runCommand('1. item', toggleTaskListAtSelection, { from: 0 })).toMatchObject({
      result: false,
      text: '1. item',
    });
    expect(runCommand('1) item', toggleBulletListAtSelection, { from: 0 })).toMatchObject({
      result: false,
      text: '1) item',
    });
    expect(runCommand('1) item', toggleTaskListAtSelection, { from: 0 })).toMatchObject({
      result: false,
      text: '1) item',
    });
    expect(runCommand('1) item', indentListItemsAtSelection, { from: 0 })).toMatchObject({
      result: false,
      text: '1) item',
    });
    expect(runCommand('1) item', outdentListItemsAtSelection, { from: 0 })).toMatchObject({
      result: false,
      text: '1) item',
    });
  });

  it('toggles task lists for plain, bullet, and all-task selections', () => {
    expect(runCommand('alpha', toggleTaskListAtSelection, { from: 1 }).text).toBe('- [ ] alpha');
    expect(runCommand('- alpha', toggleTaskListAtSelection, { from: 3 }).text).toBe('- [ ] alpha');
    expect(
      runCommand(['- [ ] alpha', '- [x] beta'].join('\n'), toggleTaskListAtSelection, { from: 0, to: 20 }).text,
    ).toBe('alpha\nbeta');
  });

  it('leaves existing task lines unchanged when converting mixed selections to tasks', () => {
    const text = ['alpha', '- [x] done', '- beta'].join('\n');
    expect(runCommand(text, toggleTaskListAtSelection, { from: 0, to: text.length }).text).toBe(
      ['- [ ] alpha', '- [x] done', '- [ ] beta'].join('\n'),
    );
  });

  it('returns false without dispatch for all-blank selections', () => {
    expect(runCommand('  ', toggleBulletListAtSelection, { from: 0, to: 2 })).toMatchObject({
      result: false,
      text: '  ',
      events: [],
    });
    expect(runCommand('\n', toggleTaskListAtSelection, { from: 0, to: 1 })).toMatchObject({
      result: false,
      text: '\n',
      events: [],
    });
  });

  it('indents and outdents unordered and task lines while skipping plain lines', () => {
    const text = ['plain', '- bullet', '- [ ] task'].join('\n');
    const indented = ['plain', '  - bullet', '  - [ ] task'].join('\n');
    expect(runCommand(text, indentListItemsAtSelection, { from: 0, to: text.length }).text).toBe(indented);
    expect(runCommand(indented, outdentListItemsAtSelection, { from: 0, to: indented.length }).text).toBe(text);
  });

  it('supports multi-range selections as a union of touched lines', () => {
    const text = ['alpha', 'beta', 'gamma'].join('\n');
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({
      parent,
      text,
      extensionContributions: [{ id: 'test.multi-selection', extension: EditorState.allowMultipleSelections.of(true) }],
    });
    editor.view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(text.indexOf('alpha')),
        EditorSelection.cursor(text.indexOf('gamma')),
      ]),
    });

    expect(toggleBulletListAtSelection(editor.view)).toBe(true);
    expect(editor.getText()).toBe(['- alpha', 'beta', '- gamma'].join('\n'));

    editor.destroy();
  });
});
