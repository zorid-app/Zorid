// @vitest-environment happy-dom

import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { livePreviewSourceTextForRange } from '../packages/editor/src/live-preview/source-text';

function sourceFor(doc: string, selected: string): string {
  const from = doc.indexOf(selected);
  if (from === -1) throw new Error(`Missing selected text: ${selected}`);
  return livePreviewSourceTextForRange(EditorState.create({ doc }), { from, to: from + selected.length });
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
});
