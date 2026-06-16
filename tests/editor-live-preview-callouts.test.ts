// @vitest-environment happy-dom

import { deleteCharBackward, deleteCharForward, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createMountedMarkdownEditor, defaultLivePreviewRenderers } from '../packages/editor/src/index';
import {
  collectLivePreviewRangesWithWidgetSuppression,
  collectLivePreviewWidgetRangesForVisibleRanges,
} from '../packages/editor/src/live-preview/extension';
import {
  type InternalLivePreviewRange,
  setInternalLivePreviewFocused,
} from '../packages/editor/src/live-preview/internal-types';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

function collectWidgetRanges(doc: string, selection = 0, focused = false): InternalLivePreviewRange[] {
  const state = EditorState.create({ doc, selection: { anchor: selection } });
  return collectLivePreviewWidgetRangesForVisibleRanges(
    defaultLivePreviewWidgetRenderers,
    state,
    [{ from: 0, to: doc.length }],
    focused,
  );
}

function collectAllRanges(doc: string, selection = 0, focused = false): InternalLivePreviewRange[] {
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

describe('editor Live Preview callout projections', () => {
  it('matches conservative complete callout groups and preserves ordinary blockquotes', () => {
    const doc = [
      '> [!note]',
      '> Body',
      '>',
      '> More',
      '',
      '> ordinary quote',
      '',
      '   > [!warning] Custom title',
      '   > Body',
    ].join('\n');

    const ranges = collectAllRanges(doc).filter((range) => range.rendererId === 'callout-line');

    expect(ranges.map((range) => [range.className, doc.slice(range.from, range.to)])).toEqual([
      ['z-live-preview-callout-line z-live-preview-callout-line--note z-live-preview-callout-title-line', '> [!note]'],
      ['z-live-preview-callout-line z-live-preview-callout-line--note z-live-preview-callout-body-line', '> Body'],
      ['z-live-preview-callout-line z-live-preview-callout-line--note z-live-preview-callout-body-line', '>'],
      ['z-live-preview-callout-line z-live-preview-callout-line--note z-live-preview-callout-body-line', '> More'],
      [
        'z-live-preview-callout-line z-live-preview-callout-line--warning z-live-preview-callout-title-line',
        '   > [!warning] Custom title',
      ],
      [
        'z-live-preview-callout-line z-live-preview-callout-line--warning z-live-preview-callout-body-line',
        '   > Body',
      ],
    ]);
    expect(collectAllRanges(doc).map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toContainEqual([
      'blockquote',
      '> ordinary quote',
    ]);
  });

  it('keeps unsupported, lazy-continuation, nested, and code-contained callouts raw', () => {
    const doc = [
      '> [!bad/type]',
      '> raw unsupported',
      '',
      '> [!note]',
      'lazy continuation stays outside',
      '',
      '>> [!note]',
      '>> nested raw',
      '',
      '```md',
      '> [!note]',
      '> fenced raw',
      '```',
    ].join('\n');

    const ranges = collectAllRanges(doc).filter((range) => range.rendererId === 'callout-line');

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['> [!note]']);
  });

  it('parses existing fold markers while leaving normal and incomplete fold syntax literal', () => {
    const doc = [
      '> [!note]+ Expanded title',
      '> Expanded body',
      '',
      '> [!warning]- Collapsed title',
      '> Collapsed body',
      '',
      '> [!tip] Normal title',
      '> Normal body',
      '',
      '> [!quote]-Literal title',
      '> Literal body',
      '',
      '> [!info]++ Literal title',
      '> Literal body',
    ].join('\n');

    const ranges = collectAllRanges(doc);
    const titleLines = ranges.filter(
      (range) => range.rendererId === 'callout-line' && range.from === lineStart(doc, 0),
    );
    const collapsedTitle = ranges.find(
      (range) => range.rendererId === 'callout-line' && doc.slice(range.from, range.to).includes('Collapsed title'),
    );
    const hiddenBody = ranges.find((range) => range.rendererId === 'callout-hidden-body');
    const literalDash = ranges.find(
      (range) => range.rendererId === 'callout-line' && doc.slice(range.from, range.to).includes('-Literal title'),
    );
    const literalPlus = ranges.find(
      (range) => range.rendererId === 'callout-line' && doc.slice(range.from, range.to).includes('++ Literal title'),
    );

    expect(titleLines[0]?.attributes?.['data-callout-fold']).toBe('expanded');
    expect(collapsedTitle?.attributes?.['data-callout-fold']).toBe('collapsed');
    expect(doc.slice(hiddenBody!.from, hiddenBody!.to)).toBe('> Collapsed body');
    expect(literalDash?.attributes?.['data-callout-fold']).toBeUndefined();
    expect(literalPlus?.attributes?.['data-callout-fold']).toBeUndefined();
  });

  it('mutates only existing callout fold markers from pointer chevrons', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> [!note]- Collapsed title', '> Hidden body', '', '> [!tip] Normal title'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const chevron = parent.querySelector<HTMLElement>('.z-live-preview-callout-fold-chevron');
    expect(chevron).toBeTruthy();
    expect(chevron?.tabIndex).toBe(-1);
    expect(parent.textContent).not.toContain('Hidden body');

    chevron!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 }));
    expect(editor.getText()).toBe(text);

    chevron!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(editor.getText()).toBe(
      ['> [!note]+ Collapsed title', '> Hidden body', '', '> [!tip] Normal title'].join('\n'),
    );
    expect(parent.querySelectorAll('.z-live-preview-callout-fold-chevron')).toHaveLength(1);

    editor.destroy();
    parent.remove();
  });

  it('folds collapsed multi-line callout bodies without rendering blank body rows', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> [!note]- Title', '> first body', '> second body', 'after'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const hiddenRows = [...parent.querySelectorAll<HTMLElement>('.cm-line.z-live-preview-callout-hidden-body')];
    expect(hiddenRows).toHaveLength(2);
    expect(hiddenRows.map((row) => row.getAttribute('style'))).toEqual(['display: none;', 'display: none;']);
    expect(parent.textContent).not.toContain('first body');
    expect(parent.textContent).not.toContain('second body');
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('keeps callout title/body editable while preserving nested and outside ranges', () => {
    const doc = [
      '> [!note] #inside [inside](target.md) [[Inside]]',
      '> - [ ] inside task',
      '> quoted body',
      '',
      '#outside [outside](target.md) [[Outside]]',
      '- [ ] outside task',
      '> outside quote',
    ].join('\n');

    const ranges = collectAllRanges(doc);

    expect(ranges.map((range) => range.rendererId)).toEqual([
      'callout-structural-marker',
      'callout-line',
      'tag',
      'markdown-link',
      'markdown-link',
      'markdown-link',
      'wiki-link',
      'wiki-link',
      'wiki-link',
      'callout-structural-marker',
      'callout-line',
      'task-marker',
      'callout-structural-marker',
      'callout-line',
      'tag',
      'markdown-link',
      'markdown-link',
      'markdown-link',
      'wiki-link',
      'wiki-link',
      'wiki-link',
      'task-marker',
      'blockquote',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([
      '> [!note] ',
      '> [!note] #inside [inside](target.md) [[Inside]]',
      '#inside',
      '[',
      'inside',
      '](target.md)',
      '[[',
      'Inside',
      ']]',
      '> ',
      '> - [ ] inside task',
      '- [ ]',
      '> ',
      '> quoted body',
      '#outside',
      '[',
      'outside',
      '](target.md)',
      '[[',
      'Outside',
      ']]',
      '- [ ]',
      '> outside quote',
    ]);
  });

  it('reveals only callout structural syntax while title and body selections stay rendered', () => {
    const doc = ['> [!note] Title', '> Body', '', 'paragraph'].join('\n');
    const structuralRanges = collectAllRanges(doc).filter((range) => range.rendererId === 'callout-structural-marker');

    expect(
      collectAllRanges(doc, structuralRanges[0]!.from, true).map((range) => doc.slice(range.from, range.to)),
    ).not.toContain('> [!note] ');
    expect(collectAllRanges(doc, doc.indexOf('Title'), true).map((previewRange) => previewRange.rendererId)).toContain(
      'callout-structural-marker',
    );
    expect(collectAllRanges(doc, doc.indexOf('Body'), true).map((previewRange) => previewRange.rendererId)).toContain(
      'callout-structural-marker',
    );
    expect(
      collectAllRanges(doc, structuralRanges[1]!.from + 1, true).map((range) => doc.slice(range.from, range.to)),
    ).not.toContain('> ');
  });

  it('mounts source-backed callout line projections without whole-block widgets or source changes', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> [!note] Title', '> Body', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(parent.querySelector('.z-live-preview-callout-widget')).toBeNull();
    expect(parent.querySelectorAll('.cm-line.z-live-preview-callout-line')).toHaveLength(2);
    expect(parent.textContent).toContain('Title');
    expect(parent.textContent).toContain('Body');
    expect(parent.textContent).not.toContain('[!note]');
    expect(editor.getText()).toBe(text);

    editor.focus();
    editor.view.dispatch({ selection: { anchor: text.indexOf('Title') } });
    expect(parent.querySelectorAll('.cm-line.z-live-preview-callout-line')).toHaveLength(2);
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('keeps callout edge deletion source-backed under the no-atomic-ranges policy', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> [!note] Title', '> Body', '', 'paragraph'].join('\n');
    const calloutRange = collectAllRanges(text).find((range) => range.rendererId === 'callout-line')!;
    const editor = createMountedMarkdownEditor({ parent, text });

    editor.view.dispatch({ effects: setInternalLivePreviewFocused.of(true) });
    expect(parent.querySelector('.z-live-preview-callout-widget')).toBeNull();

    editor.view.dispatch({ selection: { anchor: calloutRange.from } });
    expect(deleteCharForward(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text.slice(0, calloutRange.from) + text.slice(calloutRange.from + 1));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text);

    editor.view.dispatch({ selection: { anchor: calloutRange.to } });
    expect(deleteCharBackward(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text.slice(0, calloutRange.to - 1) + text.slice(calloutRange.to));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text);

    editor.view.dispatch({ selection: { anchor: calloutRange.to + 1 } });
    expect(deleteCharBackward(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text.slice(0, calloutRange.to) + text.slice(calloutRange.to + 1));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('mounts callout projection DOM with safe source-preserving text', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> [!note] <script>alert("safe title")</script>', '> <script>alert("safe body")</script>'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(parent.querySelector('.z-live-preview-callout-widget')).toBeNull();
    expect(parent.textContent).toContain('<script>alert("safe title")</script>');
    expect(parent.textContent).toContain('<script>alert("safe body")</script>');
    expect(parent.querySelector('script')).toBeNull();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('mounts ordinary blockquotes as line decorations instead of callout widgets', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> ordinary quote', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(parent.querySelector('.z-live-preview-callout-widget')).toBeNull();
    expect(parent.querySelector('.cm-line.z-live-preview-blockquote-line')).toBeTruthy();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });
});

function lineStart(doc: string, lineIndex: number): number {
  let from = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    from = doc.indexOf('\n', from) + 1;
  }
  return from;
}
