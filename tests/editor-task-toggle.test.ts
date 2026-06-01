// @vitest-environment happy-dom

import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  createLivePreviewContext,
  createMountedMarkdownEditor,
  defaultLivePreviewRenderers,
  findTaskMarkerAtPosition,
  nextTaskMarkerCheckbox,
  toggleTaskMarkerAtSelection,
} from '../packages/editor/src/index';
import { collectLivePreviewRangesWithWidgetSuppression } from '../packages/editor/src/live-preview/extension';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

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

  it('rejects malformed adjacent task marker text without spanning lines', () => {
    const doc = ['intro', '- [ ]f- [ ]a 4- [ ]- [ ]', '- [ ] real task'].join('\n');
    const state = EditorState.create({ doc });
    const malformedLineStart = doc.indexOf('- [ ]f');
    const realTaskStart = doc.indexOf('- [ ] real task');

    for (const offset of [0, 3, 5, 8, 14, 20]) {
      expect(findTaskMarkerAtPosition(state, malformedLineStart + offset)).toBeNull();
    }

    const ranges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      defaultLivePreviewInternalRenderers,
      defaultLivePreviewWidgetRenderers,
      state,
      [{ from: malformedLineStart, to: realTaskStart + '- [ ] real task'.length }],
      false,
    ).filter((range) => range.rendererId === 'task-marker');

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['- [ ]']);
    expect(ranges[0]).toMatchObject({ from: realTaskStart, to: realTaskStart + '- [ ]'.length });
    expect(ranges.every((range) => !doc.slice(range.from, range.to).includes('\n'))).toBe(true);
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

  it('mounts visual task checkboxes without changing Markdown source', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['- [ ] pending', '- [x] done', '- [X] loud'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const checkboxes = [...parent.querySelectorAll<HTMLElement>('.z-live-preview-task-checkbox')];

    expect(checkboxes).toHaveLength(3);
    expect(checkboxes.map((checkbox) => checkbox.getAttribute('aria-checked'))).toEqual(['false', 'true', 'true']);
    expect(checkboxes.map((checkbox) => checkbox.textContent)).toEqual(['', '✓', '✓']);
    expect(checkboxes.map((checkbox) => checkbox.tabIndex)).toEqual([0, 0, 0]);
    expect(checkboxes.map((checkbox) => checkbox.getAttribute('aria-label'))).toEqual([
      'Mark task complete',
      'Mark task incomplete',
      'Mark task incomplete',
    ]);
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('reveals task marker source while focused selection intersects the checkbox marker', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = '- [ ] pending';
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeTruthy();
    editor.focus();

    for (const position of [0, 3, 5]) {
      editor.view.dispatch({ selection: { anchor: position } });
      expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeNull();
      expect(editor.getText()).toBe(text);
    }

    editor.view.dispatch({ selection: { anchor: text.indexOf('pending') } });
    expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeTruthy();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('toggles mounted visual task checkboxes through undoable source transactions', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const userEvents: Array<string | undefined> = [];
    const editor = createMountedMarkdownEditor({
      parent,
      text: '- [ ] pending',
      onChange: (_text, update) => {
        userEvents.push(update.transactions.at(-1)?.annotation(Transaction.userEvent));
      },
    });

    const checkbox = parent.querySelector<HTMLElement>('.z-live-preview-task-checkbox');
    expect(checkbox).toBeTruthy();

    checkbox?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(editor.getText()).toBe('- [x] pending');
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeNull();
    expect(userEvents).toEqual(['input.task.toggle']);
    expect(undoDepth(editor.view.state)).toBe(1);

    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe('- [ ] pending');
    expect(redoDepth(editor.view.state)).toBe(1);

    expect(redo(editor.view)).toBe(true);
    expect(editor.getText()).toBe('- [x] pending');

    editor.destroy();
    parent.remove();
  });

  it('keeps the editor selection in task text after clicking a visual task checkbox', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: '- [ ] asdfa',
    });
    const cursor = editor.getText().length;
    editor.focus();
    editor.view.dispatch({ selection: { anchor: cursor } });

    const checkbox = parent.querySelector<HTMLElement>('.z-live-preview-task-checkbox');
    expect(checkbox).toBeTruthy();

    checkbox?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(editor.getText()).toBe('- [x] asdfa');
    expect(editor.view.state.selection.main.head).toBe(cursor);

    editor.destroy();
    parent.remove();
  });

  it('toggles focused visual task checkboxes from the keyboard', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const userEvents: Array<string | undefined> = [];
    const editor = createMountedMarkdownEditor({
      parent,
      text: '- [ ] pending',
      onChange: (_text, update) => {
        userEvents.push(update.transactions.at(-1)?.annotation(Transaction.userEvent));
      },
    });

    const checkbox = parent.querySelector<HTMLElement>('.z-live-preview-task-checkbox');
    expect(checkbox).toBeTruthy();
    checkbox?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(editor.getText()).toBe('- [x] pending');
    expect(userEvents).toEqual(['input.task.toggle']);

    editor.destroy();
    parent.remove();
  });

  it('does not mount visual task checkboxes for non-task, table, fenced-code, or indented-code samples', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = [
      '- item',
      '| - [ ] table |',
      '[ ] loose',
      '```',
      '- [ ] fenced code sample',
      '```',
      '    - [ ] indented code sample',
      '- [ ] real task',
    ].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const checkboxes = [...parent.querySelectorAll<HTMLElement>('.z-live-preview-task-checkbox')];

    expect(checkboxes).toHaveLength(1);
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
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
    const inactiveRanges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      defaultLivePreviewInternalRenderers,
      defaultLivePreviewWidgetRenderers,
      inactiveState,
      [{ from: 0, to: doc.length }],
      false,
    );
    expect(inactiveRanges.find((range) => range.rendererId === 'task-marker')).toMatchObject({ from: 0, to: 5 });
    expect(inactiveState.doc.toString()).toBe(doc);

    const focusedRanges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      defaultLivePreviewInternalRenderers,
      defaultLivePreviewWidgetRenderers,
      inactiveState,
      [{ from: 0, to: doc.length }],
      true,
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
