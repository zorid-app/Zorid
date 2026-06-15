import { describe, expect, it } from 'vitest';
import { buildOutlineTree, findCurrentOutlineId } from '../apps/desktop/src/renderer/src/outline-tree';

describe('desktop outline tree', () => {
  it('derives nested headings and current section from renderer markdown text', () => {
    const text = [
      '# Project',
      '',
      'Intro',
      '',
      '## Setup',
      'Steps',
      '',
      '### Install',
      'pnpm install',
      '',
      '## Usage',
    ].join('\n');
    const tree = buildOutlineTree(text, 'Guide.md', []);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ heading: 'Project', level: 1, ordinal: 1 });
    expect(tree[0].children.map((item) => item.heading)).toEqual(['Setup', 'Usage']);
    expect(tree[0].children[0].children.map((item) => item.heading)).toEqual(['Install']);

    const installPosition = text.indexOf('pnpm install');
    expect(findCurrentOutlineId(tree, installPosition)).toBe(tree[0].children[0].children[0].id);
  });

  it('falls back to indexed flat outline items when the current text has no headings', () => {
    const tree = buildOutlineTree('plain note', 'Note.md', [
      { path: 'Note.md', heading: 'Indexed', ordinal: 1 },
      { path: 'Note.md', heading: 'Fallback', ordinal: 2 },
    ]);

    expect(tree.map((item) => ({ heading: item.heading, level: item.level, children: item.children }))).toEqual([
      { heading: 'Indexed', level: 1, children: [] },
      { heading: 'Fallback', level: 1, children: [] },
    ]);
  });

  it('scopes parsed and fallback outline ids by document path', () => {
    const firstParsed = buildOutlineTree('# Same', 'First.md', []);
    const secondParsed = buildOutlineTree('# Same', 'Second.md', []);

    expect(firstParsed[0]?.id).not.toBe(secondParsed[0]?.id);

    const firstFallback = buildOutlineTree('plain note', 'First.md', [
      { path: 'First.md', heading: 'Same', ordinal: 1 },
    ]);
    const secondFallback = buildOutlineTree('plain note', 'Second.md', [
      { path: 'Second.md', heading: 'Same', ordinal: 1 },
    ]);

    expect(firstFallback[0]?.id).not.toBe(secondFallback[0]?.id);
  });

  it('ignores headings inside leading YAML frontmatter while preserving document offsets', () => {
    const text = ['---', 'title: Note', '# comment', '---', '', '# Body', 'Body text', '', '## Details', 'More'].join(
      '\n',
    );
    const tree = buildOutlineTree(text, 'Note.md', []);

    expect(tree.map((item) => item.heading)).toEqual(['Body']);
    expect(tree[0]?.children.map((item) => item.heading)).toEqual(['Details']);
    expect(tree[0]?.from).toBe(text.indexOf('# Body'));

    const detailsPosition = text.indexOf('More');
    expect(findCurrentOutlineId(tree, detailsPosition)).toBe(tree[0]?.children[0]?.id);
  });

  it('does not parse unterminated trailing frontmatter as body headings', () => {
    const tree = buildOutlineTree(['---', '# comment', '---'].join('\n'), 'Note.md', []);

    expect(tree).toHaveLength(0);
  });
});
