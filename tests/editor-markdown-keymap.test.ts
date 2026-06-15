// @vitest-environment happy-dom

import { deleteCharBackward, deleteCharForward } from '@codemirror/commands';
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdownKeymap } from '@codemirror/lang-markdown';
import { describe, expect, it } from 'vitest';
import {
  createMountedMarkdownEditor,
  markdownTaskKeymap,
  toggleTaskMarkerAtSelection,
} from '../packages/editor/src/index';
import {
  deleteEmptyTaskListAtSelection,
  handleTaskListEnterAtSelection,
} from '../packages/editor/src/markdown-list-commands';

function runMarkdownEnter(text: string): string {
  const parent = document.createElement('div');
  const editor = createMountedMarkdownEditor({ parent, text });
  editor.view.dispatch({ selection: { anchor: text.length } });
  expect(insertNewlineContinueMarkup(editor.view)).toBe(true);
  const result = editor.getText();
  editor.destroy();
  return result;
}

function runMarkdownBackspace(text: string): string {
  const parent = document.createElement('div');
  const editor = createMountedMarkdownEditor({ parent, text });
  editor.view.dispatch({ selection: { anchor: text.length } });
  expect(deleteMarkupBackward(editor.view)).toBe(true);
  const result = editor.getText();
  editor.destroy();
  return result;
}

function pressEditorKey(
  text: string,
  key: 'Enter' | 'Backspace' | 'Delete',
  anchor = text.length,
): { text: string; selectionHead: number } {
  const parent = document.createElement('div');
  const editor = createMountedMarkdownEditor({ parent, text });
  editor.focus();
  editor.view.dispatch({ selection: { anchor } });

  editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  const result = { text: editor.getText(), selectionHead: editor.view.state.selection.main.head };
  editor.destroy();
  return result;
}

function runDeletionWithSourceFallback(
  text: string,
  key: 'Backspace' | 'Delete',
  anchor = text.length,
): { text: string; selectionHead: number } {
  const parent = document.createElement('div');
  const editor = createMountedMarkdownEditor({ parent, text });
  editor.view.dispatch({ selection: { anchor } });

  if (!deleteEmptyTaskListAtSelection(editor.view)) {
    const sourceDeleted = (key === 'Backspace' ? deleteCharBackward : deleteCharForward)(editor.view);
    if (key === 'Backspace' || anchor < text.length) expect(sourceDeleted).toBe(true);
  }

  const result = { text: editor.getText(), selectionHead: editor.view.state.selection.main.head };
  editor.destroy();
  return result;
}

describe('editor Markdown keymap behavior', () => {
  it('keeps the official Markdown Enter and Backspace commands available', () => {
    expect(markdownKeymap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'Enter', run: insertNewlineContinueMarkup }),
        expect.objectContaining({ key: 'Backspace', run: deleteMarkupBackward }),
      ]),
    );
  });

  it('exposes conservative task commands before Markdown fallback behavior', () => {
    expect(markdownTaskKeymap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'Enter', run: handleTaskListEnterAtSelection }),
        expect.objectContaining({ key: 'Backspace', run: deleteEmptyTaskListAtSelection }),
        expect.objectContaining({ key: 'Delete', run: deleteEmptyTaskListAtSelection }),
        expect.objectContaining({ key: 'Mod-Enter', run: toggleTaskMarkerAtSelection }),
      ]),
    );
  });

  it('exits empty task lines with Enter and leaves the cursor at the line start', () => {
    const text = ['before', '- [ ] ', 'after'].join('\n');
    const lineStart = text.indexOf('- [ ] ');

    expect(pressEditorKey(text, 'Enter', lineStart + '- [ ] '.length)).toEqual({
      text: ['before', '', 'after'].join('\n'),
      selectionHead: lineStart,
    });
    expect(pressEditorKey(['before', '1. [ ] ', 'after'].join('\n'), 'Enter', lineStart + '1. [ ] '.length)).toEqual({
      text: ['before', '', 'after'].join('\n'),
      selectionHead: lineStart,
    });
  });

  it('exits empty task lines with Backspace or Delete at the right marker whitespace boundary', () => {
    const text = ['before', '- [x] ', 'after'].join('\n');
    const lineStart = text.indexOf('- [x] ');

    expect(pressEditorKey(text, 'Backspace', lineStart + '- [x] '.length)).toEqual({
      text: ['before', '', 'after'].join('\n'),
      selectionHead: lineStart,
    });
    expect(pressEditorKey(text, 'Delete', lineStart + '- [x] '.length)).toEqual({
      text: ['before', '', 'after'].join('\n'),
      selectionHead: lineStart,
    });
    expect(
      pressEditorKey(['before', '1) [X] ', 'after'].join('\n'), 'Backspace', lineStart + '1) [X] '.length),
    ).toEqual({
      text: ['before', '', 'after'].join('\n'),
      selectionHead: lineStart,
    });
    expect(
      pressEditorKey(['before', '1. [ ]   ', 'after'].join('\n'), 'Delete', lineStart + '1. [ ]   '.length),
    ).toEqual({
      text: ['before', '', 'after'].join('\n'),
      selectionHead: lineStart,
    });
  });

  it('falls through to exact source deletion inside task marker syntax', () => {
    expect(runDeletionWithSourceFallback('- [ ] ', 'Backspace', '- [ '.length)).toEqual({
      text: '- [] ',
      selectionHead: '- ['.length,
    });
    expect(runDeletionWithSourceFallback('- [ ] ', 'Delete', '- ['.length)).toEqual({
      text: '- [] ',
      selectionHead: '- ['.length,
    });
  });

  it('falls through to exact source deletion for raw task markers without marker-following whitespace', () => {
    expect(runDeletionWithSourceFallback('- [ ]', 'Backspace')).toEqual({
      text: '- [ ',
      selectionHead: '- [ '.length,
    });
    expect(runDeletionWithSourceFallback('- [ ]', 'Delete')).toEqual({
      text: '- [ ]',
      selectionHead: '- [ ]'.length,
    });
  });

  it('falls through to exact source deletion before the final marker whitespace boundary', () => {
    expect(runDeletionWithSourceFallback('- [ ]   ', 'Backspace', '- [ ] '.length)).toEqual({
      text: '- [ ]  ',
      selectionHead: '- [ ]'.length,
    });
    expect(runDeletionWithSourceFallback('- [ ]   ', 'Delete', '- [ ] '.length)).toEqual({
      text: '- [ ]  ',
      selectionHead: '- [ ] '.length,
    });
  });

  it('does not exit non-empty task lines with Backspace or Delete', () => {
    expect(runDeletionWithSourceFallback('- [ ] task', 'Backspace')).toEqual({
      text: '- [ ] tas',
      selectionHead: '- [ ] tas'.length,
    });
    expect(runDeletionWithSourceFallback('- [ ] task', 'Delete', '- [ ] '.length)).toEqual({
      text: '- [ ] ask',
      selectionHead: '- [ ] '.length,
    });
  });

  it('preserves non-empty task Enter continuation through Markdown fallback', () => {
    expect(pressEditorKey('- [ ] task', 'Enter')).toEqual({
      text: '- [ ] task\n- [ ] ',
      selectionHead: '- [ ] task\n- [ ] '.length,
    });
  });

  it('falls through for non-task Markdown Enter and Backspace cases', () => {
    expect(pressEditorKey('- item', 'Enter')).toEqual({ text: '- item\n- ', selectionHead: '- item\n- '.length });
    expect(pressEditorKey('- ', 'Backspace')).toEqual({ text: '', selectionHead: 0 });
  });

  it('continues task markers at the caret when Enter is pressed at the marker boundary', () => {
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({ parent, text: '- [ ] task' });
    editor.focus();
    editor.view.dispatch({ selection: { anchor: '- [ ]'.length + 1 } });

    editor.view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    const text = editor.getText();
    expect(text).toBe('- [ ] \n- [ ] task');
    editor.destroy();
  });

  it('continues unordered lists through the official Markdown Enter command', () => {
    expect(runMarkdownEnter('- item')).toBe('- item\n- ');
  });

  it('continues task lists through the official Markdown Enter command', () => {
    expect(runMarkdownEnter('- [ ] task')).toBe('- [ ] task\n- [ ] ');
  });

  it('continues blockquotes through the official Markdown Enter command', () => {
    expect(runMarkdownEnter('> quote')).toBe('> quote\n> ');
  });

  it('removes empty unordered list markup through the official Markdown Backspace command', () => {
    expect(runMarkdownBackspace('- ')).toBe('');
  });

  it('removes empty blockquote markup through the official Markdown Backspace command', () => {
    expect(runMarkdownBackspace('> ')).toBe('');
  });
});
