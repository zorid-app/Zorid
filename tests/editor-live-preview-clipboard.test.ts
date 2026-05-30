// @vitest-environment happy-dom

import { redo, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createMountedMarkdownEditor } from '../packages/editor/src';
import { livePreviewSourceTextForRange } from '../packages/editor/src/live-preview/source-text';

function sourceFor(doc: string, selected: string): string {
  const from = doc.indexOf(selected);
  if (from === -1) throw new Error(`Missing selected text: ${selected}`);
  return livePreviewSourceTextForRange(EditorState.create({ doc }), { from, to: from + selected.length });
}

class TestClipboardData {
  readonly values = new Map<string, string>();

  clearData(): void {
    this.values.clear();
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }

  getData(type: string): string {
    return this.values.get(type) ?? '';
  }
}

function clipboardEvent(type: 'copy' | 'cut'): { event: ClipboardEvent; data: TestClipboardData } {
  const data = new TestClipboardData();
  const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: data });
  return { event, data };
}

function exposeDomSelectionToCodeMirror(contentDOM: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) throw new Error('Expected a DOM selection implementation');
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(contentDOM);
  selection.addRange(range);
}

function dispatchClipboardEvent(
  editor: ReturnType<typeof createMountedMarkdownEditor>,
  type: 'copy' | 'cut',
): TestClipboardData {
  exposeDomSelectionToCodeMirror(editor.view.contentDOM);
  const { event, data } = clipboardEvent(type);
  expect(editor.view.contentDOM.dispatchEvent(event)).toBe(false);
  expect(event.defaultPrevented).toBe(true);
  return data;
}

function selectSource(editor: ReturnType<typeof createMountedMarkdownEditor>, from: number, to: number): void {
  editor.view.dispatch({ selection: { anchor: from, head: to } });
}

function sourceRange(doc: string, selected: string): { from: number; to: number } {
  const from = doc.indexOf(selected);
  if (from === -1) throw new Error(`Missing selected text: ${selected}`);
  return { from, to: from + selected.length };
}

describe('editor Live Preview clipboard/source preservation', () => {
  it('extracts inactive inline-code source including Markdown delimiters', () => {
    expect(sourceFor('before `code` after', '`code`')).toBe('`code`');
  });

  it('extracts task checkbox marker source exactly for unchecked and checked tasks', () => {
    const doc = ['- [ ] pending', '- [x] done'].join('\n');

    expect(sourceFor(doc, '- [ ]')).toBe('- [ ]');
    expect(sourceFor(doc, '- [x]')).toBe('- [x]');
  });

  it('extracts complete fenced-code widget source exactly', () => {
    const block = ['```ts', 'code', '```'].join('\n');

    expect(sourceFor(['before', block, 'after'].join('\n'), block)).toBe(block);
  });

  it('extracts complete callout widget source exactly', () => {
    const callout = ['> [!note] Title', '> Body'].join('\n');

    expect(sourceFor(['before', callout, 'after'].join('\n'), callout)).toBe(callout);
  });

  it('extracts mixed paragraph and widget selections as exact contiguous Markdown source', () => {
    const doc = ['intro', '> [!note] Title', '> Body', '', 'after'].join('\n');
    const expected = ['intro', '> [!note] Title', '> Body'].join('\n');

    expect(sourceFor(doc, expected)).toBe(expected);
  });

  it('copies mounted Live Preview selections as canonical Markdown source, not rendered preview text', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const callout = ['> [!note] Title', '> Body'].join('\n');
    const codeBlock = ['```ts', 'const value = 1;', '```'].join('\n');
    const doc = ['before `code`', '- [ ] task', codeBlock, callout, 'after'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text: doc });

    const cases = ['`code`', '- [ ]', codeBlock, callout, ['- [ ] task', codeBlock, callout].join('\n'), 'before'];

    for (const selected of cases) {
      const { from, to } = sourceRange(doc, selected);
      selectSource(editor, from, to);
      expect(dispatchClipboardEvent(editor, 'copy').getData('text/plain')).toBe(selected);
    }
    expect(parent.textContent).toContain('Title');
    expect(parent.textContent).not.toContain('> [!note]');
    expect(editor.getText()).toBe(doc);

    editor.destroy();
    parent.remove();
  });

  it('copies multiple mounted selections in source order with CodeMirror line breaks', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const doc = ['before `code`', '- [x] done', 'plain'].join('\n');
    const editor = createMountedMarkdownEditor({
      parent,
      text: doc,
      extensionContributions: [
        { id: 'test.allow-multiple-selections', extension: EditorState.allowMultipleSelections.of(true) },
      ],
    });
    const inline = sourceRange(doc, '`code`');
    const task = sourceRange(doc, '- [x]');
    editor.view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(inline.from, inline.to),
        EditorSelection.range(task.from, task.to),
      ]),
    });

    expect(dispatchClipboardEvent(editor, 'copy').getData('text/plain')).toBe(['`code`', '- [x]'].join('\n'));
    expect(editor.getText()).toBe(doc);

    editor.destroy();
    parent.remove();
  });

  it('cuts mounted preview selections through undoable source transactions', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const transactions: Transaction[] = [];
    const doc = ['intro', '> [!note] Title', '> Body', '', 'after'].join('\n');
    const selected = ['> [!note] Title', '> Body'].join('\n');
    const editor = createMountedMarkdownEditor({
      parent,
      text: doc,
      onChange: (_text, update) => {
        transactions.push(...update.transactions.filter((transaction) => transaction.docChanged));
      },
    });
    const { from, to } = sourceRange(doc, selected);
    selectSource(editor, from, to);

    expect(dispatchClipboardEvent(editor, 'cut').getData('text/plain')).toBe(selected);
    expect(editor.getText()).toBe(['intro', '', '', 'after'].join('\n'));
    expect(transactions.at(-1)?.annotation(Transaction.userEvent)).toBe('delete.cut');

    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(doc);
    expect(redo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(['intro', '', '', 'after'].join('\n'));

    editor.destroy();
    parent.remove();
  });
});
