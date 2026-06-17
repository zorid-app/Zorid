// @vitest-environment happy-dom

import { deleteCharBackward, deleteCharForward } from '@codemirror/commands';
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdownKeymap } from '@codemirror/lang-markdown';
import { describe, expect, it } from 'vitest';
import { deletePlainIndentAtSelection, outdentLinesAtSelection } from '../packages/editor/src/indentation';
import {
  createMountedMarkdownEditor,
  markdownTaskKeymap,
  toggleTaskMarkerAtSelection,
} from '../packages/editor/src/index';
import {
  deleteEmptyTaskListAtSelection,
  handleTaskListEnterAtSelection,
  handleToggleEnterAtSelection,
  outdentToggleChildAtSelection,
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

function pressEditorIndentKey(
  text: string,
  key: 'Tab',
  selection: { readonly anchor: number; readonly head?: number },
  shiftKey = false,
): { text: string; selectionHead: number } {
  const parent = document.createElement('div');
  const editor = createMountedMarkdownEditor({ parent, text });
  editor.focus();
  editor.view.dispatch({ selection: { anchor: selection.anchor, head: selection.head ?? selection.anchor } });

  editor.view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
  );

  const result = { text: editor.getText(), selectionHead: editor.view.state.selection.main.head };
  editor.destroy();
  return result;
}

function createFocusedEditor(text: string) {
  const parent = document.createElement('div');
  const editor = createMountedMarkdownEditor({ parent, text });
  editor.focus();
  return { parent, editor };
}

function dispatchKey(
  editor: ReturnType<typeof createMountedMarkdownEditor>,
  key: 'Enter' | 'Backspace' | 'Tab',
  shiftKey = false,
): void {
  editor.view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
  );
}

function insertSourceTextAtSelection(editor: ReturnType<typeof createMountedMarkdownEditor>, text: string): void {
  const head = editor.view.state.selection.main.head;
  editor.view.dispatch({ changes: { from: head, to: head, insert: text }, selection: { anchor: head + text.length } });
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
        expect.objectContaining({ key: 'Enter', run: expect.any(Function) }),
        expect.objectContaining({ key: 'Shift-Tab', run: outdentToggleChildAtSelection }),
        expect.objectContaining({ key: 'Backspace', run: deleteEmptyTaskListAtSelection }),
        expect.objectContaining({ key: 'Backspace', run: outdentToggleChildAtSelection }),
        expect.objectContaining({ key: 'Delete', run: deleteEmptyTaskListAtSelection }),
        expect.objectContaining({ key: 'Mod-Enter', run: toggleTaskMarkerAtSelection }),
      ]),
    );
    expect(handleTaskListEnterAtSelection).toEqual(expect.any(Function));
    expect(handleToggleEnterAtSelection).toEqual(expect.any(Function));
  });

  it('indents blank and plain paragraph lines with command-owned four-space Tab commands', () => {
    const { parent, editor } = createFocusedEditor('\nparagraph');
    editor.view.dispatch({ selection: { anchor: 0 } });

    dispatchKey(editor, 'Tab');
    expect(editor.getText()).toBe('    \nparagraph');
    expect(editor.view.state.selection.main.head).toBe(4);
    expect(parent.querySelector('.z-editor-indent-guide')).not.toBeNull();

    editor.view.dispatch({ selection: { anchor: editor.getText().length } });
    dispatchKey(editor, 'Tab');
    expect(editor.getText()).toBe('    \n    paragraph');
    expect(editor.view.state.selection.main.head).toBe('    \n    paragraph'.length);
    editor.destroy();
  });

  it('keeps typing after a blank-line Tab at the source caret column without a horizontal jump', () => {
    const { editor } = createFocusedEditor('');
    dispatchKey(editor, 'Tab');
    insertSourceTextAtSelection(editor, 'x');

    expect(editor.getText()).toBe('    x');
    expect(editor.view.state.selection.main.head).toBe(5);
    editor.destroy();
  });

  it('indents selected nonblank plain lines and outdents at most one four-column command-owned unit', () => {
    const text = ['alpha', '', '  beta', '\tgamma'].join('\n');
    const rootText = ['alpha', '', 'beta', 'gamma'].join('\n');
    const indented = ['    alpha', '', '    beta', '    gamma'].join('\n');

    expect(pressEditorIndentKey(text, 'Tab', { anchor: 0, head: text.length }).text).toBe(
      '    alpha\n\n  beta\n\tgamma',
    );

    const { editor } = createFocusedEditor(rootText);
    editor.view.dispatch({ selection: { anchor: 0, head: rootText.length } });
    dispatchKey(editor, 'Tab');
    expect(editor.getText()).toBe(indented);

    editor.view.dispatch({ selection: { anchor: 0, head: editor.getText().length } });
    dispatchKey(editor, 'Tab', true);
    expect(editor.getText()).toBe(rootText);
    editor.destroy();
  });

  it('inherits command-owned plain indentation on Enter and places the caret at the inherited column', () => {
    const { editor } = createFocusedEditor('paragraph');
    editor.view.dispatch({ selection: { anchor: 'paragraph'.length } });
    dispatchKey(editor, 'Tab');
    dispatchKey(editor, 'Enter');

    expect(editor.getText()).toBe('    paragraph\n    ');
    expect(editor.view.state.selection.main.head).toBe('    paragraph\n    '.length);
    editor.destroy();
  });

  it('outdents command-owned empty plain lines by one unit per Enter until root', () => {
    const { parent, editor } = createFocusedEditor('');
    dispatchKey(editor, 'Tab');
    dispatchKey(editor, 'Tab');
    expect(editor.getText()).toBe('        ');
    expect(parent.querySelector('.z-editor-indent-guide')).not.toBeNull();

    dispatchKey(editor, 'Enter');
    expect(editor.getText()).toBe('    ');
    expect(editor.view.state.selection.main.head).toBe(4);
    expect(parent.querySelector('.z-editor-indent-guide')).not.toBeNull();

    dispatchKey(editor, 'Enter');
    expect(editor.getText()).toBe('');
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(parent.querySelector('.z-editor-indent-guide')).toBeNull();
    editor.destroy();
  });

  it('outdents command-owned plain paragraphs with Shift-Tab and Backspace at indentation boundaries', () => {
    const { editor } = createFocusedEditor('paragraph');
    editor.view.dispatch({ selection: { anchor: 'paragraph'.length } });
    dispatchKey(editor, 'Tab');
    dispatchKey(editor, 'Tab');
    expect(editor.getText()).toBe('        paragraph');

    dispatchKey(editor, 'Tab', true);
    expect(editor.getText()).toBe('    paragraph');
    expect(editor.view.state.selection.main.head).toBe('    paragraph'.length);

    editor.view.dispatch({ selection: { anchor: 4 } });
    dispatchKey(editor, 'Backspace');
    expect(editor.getText()).toBe('paragraph');
    expect(editor.view.state.selection.main.head).toBe(0);
    editor.destroy();
  });

  it('protects pre-existing, pasted, and manually typed leading four-space indentation from plain commands', () => {
    expect(pressEditorIndentKey('    paragraph', 'Tab', { anchor: '    paragraph'.length }, true)).toEqual({
      text: '    paragraph',
      selectionHead: '    paragraph'.length,
    });

    const { editor } = createFocusedEditor('paragraph');
    editor.view.dispatch({ selection: { anchor: 0 } });
    insertSourceTextAtSelection(editor, '    ');
    expect(outdentLinesAtSelection(editor.view)).toBe(true);
    expect(editor.getText()).toBe('    paragraph');
    editor.view.dispatch({ selection: { anchor: 4 } });
    expect(deletePlainIndentAtSelection(editor.view)).toBe(true);
    expect(editor.getText()).toBe('    paragraph');
    editor.destroy();
  });

  it('drops command-owned markers when paste or manual edits replace marked leading indentation', () => {
    const { parent, editor } = createFocusedEditor('');
    dispatchKey(editor, 'Tab');
    expect(parent.querySelector('.z-editor-indent-guide')).not.toBeNull();

    editor.view.dispatch({ changes: { from: 0, to: editor.getText().length, insert: '    pasted' } });
    expect(parent.querySelector('.z-editor-indent-guide')).toBeNull();
    editor.view.dispatch({ selection: { anchor: editor.getText().length } });
    dispatchKey(editor, 'Tab', true);
    expect(editor.getText()).toBe('    pasted');
    editor.view.dispatch({ selection: { anchor: 4 } });
    expect(deletePlainIndentAtSelection(editor.view)).toBe(true);
    expect(editor.getText()).toBe('    pasted');

    editor.view.dispatch({ changes: { from: 0, to: editor.getText().length, insert: 'paragraph' } });
    editor.view.dispatch({ selection: { anchor: editor.getText().length } });
    dispatchKey(editor, 'Tab');
    expect(parent.querySelector('.z-editor-indent-guide')).not.toBeNull();
    editor.view.dispatch({ changes: { from: 0, to: 0, insert: '    ' } });
    expect(parent.querySelector('.z-editor-indent-guide')).toBeNull();
    editor.view.dispatch({ selection: { anchor: editor.getText().length } });
    dispatchKey(editor, 'Tab', true);
    expect(editor.getText()).toBe('        paragraph');

    editor.view.dispatch({ changes: { from: 0, to: editor.getText().length, insert: 'paragraph' } });
    editor.view.dispatch({ selection: { anchor: editor.getText().length } });
    dispatchKey(editor, 'Tab');
    expect(editor.getText()).toBe('    paragraph');
    expect(parent.querySelector('.z-editor-indent-guide')).not.toBeNull();
    editor.view.dispatch({ changes: { from: 4, to: editor.getText().length, insert: '    pasted' } });
    expect(editor.getText()).toBe('        pasted');
    expect(parent.querySelector('.z-editor-indent-guide')).toBeNull();
    editor.view.dispatch({ selection: { anchor: editor.getText().length } });
    dispatchKey(editor, 'Tab', true);
    expect(editor.getText()).toBe('        pasted');
    editor.destroy();
  });

  it('does not indent or outdent callout title lines with editor-wide Tab commands', () => {
    const title = '> [!note] Title';
    expect(pressEditorIndentKey(title, 'Tab', { anchor: title.indexOf('Title') }).text).toBe(title);
    expect(pressEditorIndentKey(`  ${title}`, 'Tab', { anchor: 2 }, true).text).toBe(`  ${title}`);
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
    expect(pressEditorKey('* [x] task', 'Enter')).toEqual({
      text: '* [x] task\n* [ ] ',
      selectionHead: '* [x] task\n* [ ] '.length,
    });
    expect(pressEditorKey('+ [X] task', 'Enter')).toEqual({
      text: '+ [X] task\n+ [ ] ',
      selectionHead: '+ [X] task\n+ [ ] '.length,
    });
    expect(pressEditorKey('3. [ ] task', 'Enter')).toEqual({
      text: '3. [ ] task\n4. [ ] ',
      selectionHead: '3. [ ] task\n4. [ ] '.length,
    });
    expect(pressEditorKey('9) [x] task', 'Enter')).toEqual({
      text: '9) [x] task\n10) [ ] ',
      selectionHead: '9) [x] task\n10) [ ] '.length,
    });
  });

  it('falls through for non-task Markdown Enter and Backspace cases', () => {
    expect(pressEditorKey('- item', 'Enter')).toEqual({ text: '- item\n- ', selectionHead: '- item\n- '.length });
    expect(pressEditorKey('- ', 'Backspace')).toEqual({ text: '', selectionHead: 0 });
  });

  it('converts toggle shorthand and creates four-space child lines with Enter', () => {
    expect(pressEditorKey('>> Toggle title', 'Enter')).toEqual({
      text: '>>+ Toggle title\n    ',
      selectionHead: '>>+ Toggle title\n    '.length,
    });
    expect(pressEditorKey('>> # Heading', 'Enter')).toEqual({
      text: '>>+ # Heading\n    ',
      selectionHead: '>>+ # Heading\n    '.length,
    });
    expect(pressEditorKey('>>+ Toggle title', 'Enter')).toEqual({
      text: '>>+ Toggle title\n    ',
      selectionHead: '>>+ Toggle title\n    '.length,
    });
  });

  it('continues and exits expanded toggle child content', () => {
    expect(pressEditorKey(['>>+ Toggle title', '    child'].join('\n'), 'Enter')).toEqual({
      text: ['>>+ Toggle title', '    child', '    '].join('\n'),
      selectionHead: ['>>+ Toggle title', '    child', '    '].join('\n').length,
    });
    expect(pressEditorKey(['>>+ Toggle title', '    '].join('\n'), 'Enter')).toEqual({
      text: ['>>+ Toggle title', ''].join('\n'),
      selectionHead: '>>+ Toggle title\n'.length,
    });
  });

  it('outdents toggle child lines with Shift+Tab or Backspace at indentation boundary', () => {
    const text = ['>>+ Toggle title', '    child'].join('\n');
    const childStart = text.indexOf('    child');

    expect(pressEditorIndentKey(text, 'Tab', { anchor: childStart }, true)).toEqual({
      text: ['>>+ Toggle title', 'child'].join('\n'),
      selectionHead: childStart,
    });
    expect(pressEditorKey(text, 'Backspace', childStart)).toEqual({
      text: ['>>+ Toggle title', 'child'].join('\n'),
      selectionHead: childStart,
    });
  });

  it('outdents only the selected toggle child subtree without crossing sibling boundaries', () => {
    const text = ['>>+ Toggle title', '    child a', '        grandchild a', '    child b', 'after'].join('\n');
    const childAStart = text.indexOf('    child a');

    expect(pressEditorIndentKey(text, 'Tab', { anchor: childAStart }, true)).toEqual({
      text: ['>>+ Toggle title', 'child a', '    grandchild a', '    child b', 'after'].join('\n'),
      selectionHead: childAStart,
    });
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
