// @vitest-environment happy-dom

import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  collectLivePreviewRanges,
  createLivePreviewContext,
  createMountedMarkdownEditor,
  defaultLivePreviewRenderers,
} from '../packages/editor/src/index';

function collectRanges(doc: string, selection = 0, focused = false) {
  const state = EditorState.create({ doc, selection: { anchor: selection } });
  return collectLivePreviewRanges(
    defaultLivePreviewRenderers,
    createLivePreviewContext(state, { from: 0, to: doc.length }, focused),
  );
}

describe('editor Live Preview block renderers', () => {
  it('emits line-level blockquote ranges for normal, blank, and indented blockquote lines', () => {
    const doc = ['> quote', '   > indented quote', '>', '> ', 'paragraph'].join('\n');
    const ranges = collectRanges(doc).filter((range) => range.rendererId === 'blockquote');

    expect(ranges.map((range) => [range.from, range.to, range.className])).toEqual([
      [0, 7, 'z-live-preview-blockquote-line'],
      [8, 27, 'z-live-preview-blockquote-line'],
      [28, 29, 'z-live-preview-blockquote-line'],
      [30, 32, 'z-live-preview-blockquote-line'],
    ]);
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
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
      'tag',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toContain('`code`');
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toContain('[link](target.md)');
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
});
