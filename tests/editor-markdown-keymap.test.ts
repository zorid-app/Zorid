// @vitest-environment happy-dom

import { deleteMarkupBackward, insertNewlineContinueMarkup, markdownKeymap } from '@codemirror/lang-markdown';
import { describe, expect, it } from 'vitest';
import { createMountedMarkdownEditor } from '../packages/editor/src/index';

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

describe('editor Markdown keymap behavior', () => {
  it('keeps the official Markdown Enter and Backspace commands available', () => {
    expect(markdownKeymap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'Enter', run: insertNewlineContinueMarkup }),
        expect.objectContaining({ key: 'Backspace', run: deleteMarkupBackward }),
      ]),
    );
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
