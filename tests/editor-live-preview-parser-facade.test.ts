import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';

describe('Zorid Markdown parser facade', () => {
  it('exposes a private Markdown language support wrapper for editor setup and tests', async () => {
    const language = await import('../packages/editor/src/live-preview/markdown-language');

    expect(language.zoridMarkdown).toEqual(expect.any(Function));
    expect(language.createZoridMarkdownEditorState).toEqual(expect.any(Function));
  });

  it('parses current custom syntax as identifiable syntax-tree nodes', async () => {
    const { createZoridMarkdownEditorState } = await import('../packages/editor/src/live-preview/markdown-language');
    const state = createZoridMarkdownEditorState(
      ['---', 'title: note', '---', '> [!note] Title', '> Body with [[Wiki]] #tag ==mark=='].join('\n'),
    );
    const nodeNames = new Set<string>();

    syntaxTree(state).iterate({ enter: (node) => void nodeNames.add(node.name) });

    expect([...nodeNames]).toEqual(
      expect.arrayContaining(['ZoridFrontmatter', 'ZoridCallout', 'WikiLink', 'Tag', 'Highlight']),
    );
  });
});
