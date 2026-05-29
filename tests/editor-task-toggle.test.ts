// @vitest-environment happy-dom

import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  collectLivePreviewRanges,
  createLivePreviewContext,
  createMountedMarkdownEditor,
  defaultLivePreviewRenderers,
  findTaskMarkerAtPosition,
  nextTaskMarkerCheckbox,
  toggleTaskMarkerAtSelection,
} from '../packages/editor/src/index';

describe('editor task marker toggle', () => {
  it('finds task marker ranges without including unrelated line text', () => {
    const state = EditorState.create({ doc: 'intro\n  - [X] nested task\n' });
    const position = state.doc.toString().indexOf('nested');

    expect(findTaskMarkerAtPosition(state, position)).toEqual({
      lineFrom: 6,
      lineTo: 25,
      markerFrom: 6,
      markerTo: 13,
      checkboxFrom: 11,
      checkboxTo: 12,
      checked: true,
      marker: '  - [X]',
    });
  });

  it('rejects non-task lines, table rows, and code examples', () => {
    const state = EditorState.create({
      doc: [
        '- item',
        '| - [ ] table |',
        '[ ] loose',
        '```',
        '- [ ] fenced code sample',
        '```',
        '```',
        '``` not a close',
        '- [ ] still fenced code sample',
        '```',
        '    - [ ] indented code sample',
      ].join('\n'),
    });

    expect(findTaskMarkerAtPosition(state, 0)).toBeNull();
    expect(findTaskMarkerAtPosition(state, state.doc.toString().indexOf('table'))).toBeNull();
    expect(findTaskMarkerAtPosition(state, state.doc.toString().indexOf('loose'))).toBeNull();
    expect(findTaskMarkerAtPosition(state, state.doc.toString().indexOf('fenced code sample'))).toBeNull();
    expect(findTaskMarkerAtPosition(state, state.doc.toString().indexOf('indented code sample'))).toBeNull();
  });

  it('normalizes task checkbox state through a command-first CodeMirror transaction', () => {
    const parent = document.createElement('div');
    const changes: string[] = [];
    const userEvents: Array<string | undefined> = [];
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['- [ ] pending', '- [x] done', '- [X] loud', '- item'].join('\n'),
      onChange: (text, update) => {
        changes.push(text);
        userEvents.push(update.transactions.at(-1)?.annotation(Transaction.userEvent));
      },
    });

    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('pending') } });
    expect(toggleTaskMarkerAtSelection(editor.view)).toBe(true);
    expect(editor.getText().split('\n')[0]).toBe('- [x] pending');

    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('done') } });
    expect(toggleTaskMarkerAtSelection(editor.view)).toBe(true);
    expect(editor.getText().split('\n')[1]).toBe('- [ ] done');

    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('loud') } });
    expect(toggleTaskMarkerAtSelection(editor.view)).toBe(true);
    expect(editor.getText().split('\n')[2]).toBe('- [ ] loud');

    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('item') } });
    expect(toggleTaskMarkerAtSelection(editor.view)).toBe(false);
    expect(editor.getText().split('\n')[3]).toBe('- item');

    expect(changes).toEqual([
      ['- [x] pending', '- [x] done', '- [X] loud', '- item'].join('\n'),
      ['- [x] pending', '- [ ] done', '- [X] loud', '- item'].join('\n'),
      ['- [x] pending', '- [ ] done', '- [ ] loud', '- item'].join('\n'),
    ]);
    expect(userEvents).toEqual(['input.task.toggle', 'input.task.toggle', 'input.task.toggle']);

    editor.destroy();
  });

  it('keeps unrelated text exact and external replacements silent by default', () => {
    const parent = document.createElement('div');
    const changes: string[] = [];
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'before\n- [ ] task text\nafter',
      onChange: (text) => changes.push(text),
    });

    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('task text') } });
    expect(toggleTaskMarkerAtSelection(editor.view)).toBe(true);
    expect(editor.getText()).toBe('before\n- [x] task text\nafter');

    editor.setText('external replacement');
    expect(editor.getText()).toBe('external replacement');
    expect(changes).toEqual(['before\n- [x] task text\nafter']);

    editor.destroy();
  });

  it('records toggle transactions in official undo and redo history', () => {
    const parent = document.createElement('div');
    const transactions: Transaction[] = [];
    const editor = createMountedMarkdownEditor({
      parent,
      text: '- [ ] task',
      onChange: (_text, update) => {
        transactions.push(...update.transactions.filter((transaction) => transaction.docChanged));
      },
    });

    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('task') } });
    expect(toggleTaskMarkerAtSelection(editor.view)).toBe(true);
    const toggleTransaction = transactions.at(-1);
    expect(toggleTransaction).toBeDefined();
    expect(editor.getText()).toBe('- [x] task');
    expect(undoDepth(editor.view.state)).toBe(1);

    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe('- [ ] task');
    expect(redoDepth(editor.view.state)).toBe(1);

    expect(redo(editor.view)).toBe(true);
    expect(editor.getText()).toBe('- [x] task');

    editor.destroy();
  });

  it('keeps task preview source-preserving and reveals the active marker while focused', () => {
    const doc = '- [ ] task\n\n`code`';
    const inactiveState = EditorState.create({ doc, selection: { anchor: 2 } });
    const inactiveRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(inactiveState, { from: 0, to: doc.length }, false),
    );
    expect(inactiveRanges.find((range) => range.rendererId === 'task-marker')).toMatchObject({ from: 0, to: 5 });
    expect(inactiveState.doc.toString()).toBe(doc);

    const focusedRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(inactiveState, { from: 0, to: doc.length }, true),
    );
    expect(focusedRanges.map((range) => range.rendererId)).toEqual([
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
    ]);
  });

  it('documents the checkbox toggle policy', () => {
    expect(nextTaskMarkerCheckbox({ checked: false })).toBe('x');
    expect(nextTaskMarkerCheckbox({ checked: true })).toBe(' ');
  });
});
