// @vitest-environment happy-dom

import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createMountedMarkdownEditor, defaultLivePreviewRenderers } from '../packages/editor/src/index';
import { collectLivePreviewRangesWithWidgetSuppression } from '../packages/editor/src/live-preview/extension';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

function collectRanges(doc: string, selection = 0, focused = false) {
  const state = EditorState.create({ doc, selection: { anchor: selection } });
  return collectLivePreviewRangesWithWidgetSuppression(
    defaultLivePreviewRenderers,
    defaultLivePreviewInternalRenderers,
    defaultLivePreviewWidgetRenderers,
    state,
    [{ from: 0, to: doc.length }],
    focused,
  );
}

describe('editor Live Preview block renderers', () => {
  it('renders inactive horizontal rules as source-preserving separators outside frontmatter', () => {
    const doc = ['intro', '---', '', 'content', '', '---'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'horizontal-rule');

    expect(ranges.map((range) => [doc.slice(range.from, range.to), range.kind, range.className])).toEqual([
      ['---', 'replace', 'z-live-preview-horizontal-rule'],
      ['---', 'replace', 'z-live-preview-horizontal-rule'],
    ]);
  });

  it('does not render frontmatter fences as horizontal rules', () => {
    const doc = ['---', 'title: Test', '---', '', '---'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'horizontal-rule');

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['---']);
  });

  it('does not render fenced code markers as horizontal rules', () => {
    const doc = ['intro', '```md', '---', '```', '', '---'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'horizontal-rule');

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['---']);
    expect(ranges[0]?.from).toBe(doc.lastIndexOf('---'));
  });

  it('does not render incomplete fenced code markers as horizontal rules', () => {
    const doc = ['intro', '```md', '---'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'horizontal-rule');

    expect(ranges).toEqual([]);
  });

  it('requires horizontal rule marker lines to use one marker character', () => {
    const doc = ['---', '-_*', '***', '* * *', '_ _ _'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'horizontal-rule');

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['---', '***', '* * *', '_ _ _']);
  });

  it('keeps incomplete and escaped horizontal rule markers plain', () => {
    const doc = ['---', '***', '___', '--', '**', '__', '\\---', 'text ---'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'horizontal-rule');

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['---', '***', '___']);
  });

  it('emits line-level blockquote ranges for normal, spaced blank, and indented blockquote lines', () => {
    const doc = ['> quote', '   > indented quote', '>', '> ', 'paragraph'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'blockquote');

    expect(ranges.map((range) => [range.from, range.to, range.className])).toEqual([
      [0, 7, 'z-live-preview-blockquote-line'],
      [8, 27, 'z-live-preview-blockquote-line'],
      [30, 32, 'z-live-preview-blockquote-line'],
    ]);
  });

  it('keeps a bare greater-than line plain while rendering a spaced blank quote line', () => {
    const doc = ['>', '> ', '> quote'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'blockquote');

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['> ', '> quote']);
  });

  it('keeps blockquote matching out of tables and code examples', () => {
    const doc = ['| > table text |', '```', '> fenced quote', '```', '    > indented code', '> real quote'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'blockquote');

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['> real quote']);
  });

  it('suppresses only the active blockquote line while focused', () => {
    const doc = ['> first', '> second', 'paragraph'].join('\n');
    const secondLineFrom = doc.indexOf('> second');
    const activeRanges = collectRanges(doc, secondLineFrom + 2, true).filter(
      (range) => range.rendererId === 'blockquote',
    );

    expect(activeRanges.map((range) => doc.slice(range.from, range.to))).toEqual(['> first']);

    const inactiveRanges = collectRanges(doc, doc.indexOf('paragraph'), true).filter(
      (range) => range.rendererId === 'blockquote',
    );
    expect(inactiveRanges.map((range) => doc.slice(range.from, range.to))).toEqual(['> first', '> second']);
  });

  it('freezes cursor boundary semantics at blockquote line edges', () => {
    const doc = '> quote\nparagraph';
    const lineFrom = 0;
    const lineTo = doc.indexOf('\n');

    expect(collectRanges(doc, lineFrom, true).map((range) => range.rendererId)).not.toContain('blockquote');
    expect(collectRanges(doc, lineTo, true).map((range) => range.rendererId)).not.toContain('blockquote');
    expect(collectRanges(doc, lineTo + 1, true).map((range) => range.rendererId)).toContain('blockquote');
  });

  it('coexists with inline renderers on and around blockquote lines', () => {
    const doc = ['> quote with `code` and [link](target.md)', 'Use `outside` and #tag.'].join('\n');
    const ranges = collectRanges(doc);

    expect(ranges.map((range) => range.rendererId)).toEqual([
      'blockquote',
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
      'markdown-link',
      'markdown-link',
      'markdown-link',
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
      'tag',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toContain('code');
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(
      expect.arrayContaining(['[', 'link', '](target.md)']),
    );
  });

  it('reveals horizontal rule source when focused caret or selection touches the rule line', () => {
    const doc = ['intro', '---', 'paragraph'].join('\n');
    const ruleFrom = doc.indexOf('---');
    const ruleTo = ruleFrom + '---'.length;

    expect(collectRanges(doc, 0, false).map((range) => range.rendererId)).toContain('horizontal-rule');
    expect(collectRanges(doc, ruleFrom + 1, true).map((range) => range.rendererId)).not.toContain('horizontal-rule');

    const state = EditorState.create({ doc, selection: { anchor: ruleFrom - 1, head: ruleTo } });
    const selectedRanges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      defaultLivePreviewInternalRenderers,
      defaultLivePreviewWidgetRenderers,
      state,
      [{ from: 0, to: doc.length }],
      true,
    );
    expect(selectedRanges.map((range) => range.rendererId)).not.toContain('horizontal-rule');
    expect(state.doc.toString()).toBe(doc);
  });

  it('mounts blockquote line decorations and restores them after source reveal', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: '> quote\n\nparagraph',
    });

    expect(parent.querySelector('.cm-line.z-live-preview-blockquote-line')).toBeTruthy();
    expect(editor.getText()).toBe('> quote\n\nparagraph');

    editor.focus();
    editor.view.dispatch({ selection: { anchor: 2 } });
    expect(parent.querySelector('.cm-line.z-live-preview-blockquote-line')).toBeNull();
    expect(editor.getText()).toBe('> quote\n\nparagraph');

    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('paragraph') } });
    expect(parent.querySelector('.cm-line.z-live-preview-blockquote-line')).toBeTruthy();

    editor.destroy();
    parent.remove();
  });

  it('mounts horizontal rule widgets and restores source when active', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: '---\n\nparagraph',
    });

    expect(parent.querySelector('.z-live-preview-horizontal-rule')).toBeTruthy();
    expect(editor.getText()).toBe('---\n\nparagraph');

    editor.focus();
    editor.view.dispatch({ selection: { anchor: 1 } });
    expect(parent.querySelector('.z-live-preview-horizontal-rule')).toBeNull();
    expect(editor.getText()).toBe('---\n\nparagraph');

    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('paragraph') } });
    expect(parent.querySelector('.z-live-preview-horizontal-rule')).toBeTruthy();

    editor.destroy();
    parent.remove();
  });
});
