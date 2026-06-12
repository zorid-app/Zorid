import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  collectLivePreviewRanges,
  collectLivePreviewRangesWithWidgetSuppression,
  createLivePreviewContext,
} from '../packages/editor/src/live-preview/extension';
import { markdownFrontmatterRanges } from '../packages/editor/src/live-preview/markdown-code-context';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

function collectAll(doc: string) {
  const state = EditorState.create({ doc });
  return collectLivePreviewRangesWithWidgetSuppression(
    defaultLivePreviewRenderers,
    defaultLivePreviewInternalRenderers,
    defaultLivePreviewWidgetRenderers,
    state,
    [{ from: 0, to: doc.length }],
    false,
  );
}

describe('editor Live Preview semantic fixtures', () => {
  it('treats complete leading YAML frontmatter as raw source for preview matching', () => {
    const doc = [
      '---',
      'title: "#not-a-heading"',
      'tags: [#not-previewed]',
      'link: "[not](target.md)"',
      'task: "- [ ] not a task"',
      'callout: "> [!note] not a widget"',
      'snippet: |',
      '  ```ts',
      '  #not-a-widget',
      '  ```',
      '---',
      '# Heading',
      'Body #tag [link](target.md)',
      '- [ ] task',
      '> [!note] Title',
      '> body',
    ].join('\n');

    expect(markdownFrontmatterRanges(doc, { from: 0, to: doc.length })).toEqual([
      { from: 0, to: doc.indexOf('\n# Heading') },
    ]);

    const renderedSource = collectAll(doc).map((range) => doc.slice(range.from, range.to));
    expect(renderedSource).not.toContain(['  ```ts', '  #not-a-widget', '  ```'].join('\n'));
    expect(renderedSource).toEqual([
      '# ',
      'Heading',
      '#tag',
      '[',
      'link',
      '](target.md)',
      '- [ ]',
      ['> [!note] Title', '> body'].join('\n'),
    ]);
  });

  it('requires closed frontmatter fences and preserves trailing-space delimiters', () => {
    const spacedFenceDoc = ['---   ', 'title: "#not-a-heading"', '---\t', '# Heading #tag'].join('\n');
    const unclosedDoc = ['---', '# Heading #tag'].join('\n');

    expect(markdownFrontmatterRanges(spacedFenceDoc, { from: 0, to: spacedFenceDoc.length })).toEqual([
      { from: 0, to: spacedFenceDoc.indexOf('\n# Heading') },
    ]);
    expect(collectAll(spacedFenceDoc).map((range) => spacedFenceDoc.slice(range.from, range.to))).toEqual([
      '# ',
      'Heading #tag',
    ]);

    expect(markdownFrontmatterRanges(unclosedDoc, { from: 0, to: unclosedDoc.length })).toEqual([]);
    expect(collectAll(unclosedDoc).map((range) => unclosedDoc.slice(range.from, range.to))).toEqual([
      '# ',
      'Heading #tag',
    ]);
  });

  it('adds conservative inline formatting semantics while suppressing code false positives', () => {
    const doc = [
      '**bold** *em* ~~gone~~ ==mark== __strong__ _italic_',
      '`**raw** *raw* ~~raw~~ ==raw== #raw [raw](x.md)`',
      '```',
      '**fenced** #nope [nope](x.md)',
      '```',
      '    ==indented== #nope',
    ].join('\n');
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toEqual([
      ['strong', '**'],
      ['strong', 'bold'],
      ['strong', '**'],
      ['emphasis', '*'],
      ['emphasis', 'em'],
      ['emphasis', '*'],
      ['strikethrough', '~~'],
      ['strikethrough', 'gone'],
      ['strikethrough', '~~'],
      ['highlight', '=='],
      ['highlight', 'mark'],
      ['highlight', '=='],
      ['strong', '__'],
      ['strong', 'strong'],
      ['strong', '__'],
      ['emphasis', '_'],
      ['emphasis', 'italic'],
      ['emphasis', '_'],
      ['inline-code-delimiter', '`'],
      ['inline-code', '`**raw** *raw* ~~raw~~ ==raw== #raw [raw](x.md)`'],
      ['inline-code-delimiter', '`'],
    ]);
  });

  it('keeps frontmatter and callout parser order explicit for private Lezer extensions', () => {
    const doc = [
      '---',
      'callout: > [!note] frontmatter only',
      'tag: #not-previewed',
      '---',
      '> [!note] Outside',
      '> Body #tag [[Wiki]] ==mark==',
    ].join('\n');

    const renderedSource = collectAll(doc).map((range) => doc.slice(range.from, range.to));

    expect(markdownFrontmatterRanges(doc, { from: 0, to: doc.length })).toEqual([
      { from: 0, to: doc.indexOf('\n> [!note] Outside') },
    ]);
    expect(renderedSource).toEqual([['> [!note] Outside', '> Body #tag [[Wiki]] ==mark=='].join('\n')]);
  });

  it('keeps task, blockquote, callout, and inline previews raw inside fenced code and frontmatter', () => {
    const doc = [
      '---',
      'summary: "- [ ] #tag [link](target.md)"',
      '---',
      '```md',
      '> [!note] #inside',
      '- [ ] inside',
      '[inside](target.md)',
      '```',
      '> quote #outside',
      '- [ ] outside',
    ].join('\n');

    const renderedSource = collectAll(doc).map((range) => doc.slice(range.from, range.to));
    expect(renderedSource).toEqual([
      ['```md', '> [!note] #inside', '- [ ] inside', '[inside](target.md)', '```'].join('\n'),
      '> quote #outside',
      '#outside',
      '- [ ]',
    ]);
  });
});
