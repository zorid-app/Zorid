// @vitest-environment happy-dom

import { deleteCharBackward, deleteCharForward, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
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

async function waitForCalloutWidget(parent: HTMLElement, expected: 'present' | 'absent'): Promise<void> {
  await vi.waitFor(() => {
    const widget = parent.querySelector('.z-live-preview-callout-widget');
    if (expected === 'present') {
      expect(widget).toBeTruthy();
    } else {
      expect(widget).toBeNull();
    }
  });
}

describe('editor Live Preview callout widgets', () => {
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

    const ranges = collectWidgetRanges(doc).filter((range) => range.rendererId === 'callout-widget');

    expect(ranges.map((range) => [range.className, doc.slice(range.from, range.to)])).toEqual([
      ['z-live-preview-callout-widget', ['> [!note]', '> Body', '>', '> More'].join('\n')],
      ['z-live-preview-callout-widget', ['   > [!warning] Custom title', '   > Body'].join('\n')],
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

    const ranges = collectWidgetRanges(doc).filter((range) => range.rendererId === 'callout-widget');

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['> [!note]']);
  });

  it('suppresses public renderers inside inactive callouts while preserving outside ranges', () => {
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
      'callout-widget',
      'tag',
      'markdown-link',
      'markdown-link',
      'markdown-link',
      'wiki-link',
      'task-marker',
      'blockquote',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([
      ['> [!note] #inside [inside](target.md) [[Inside]]', '> - [ ] inside task', '> quoted body'].join('\n'),
      '#outside',
      '[',
      'outside',
      '](target.md)',
      '[[Outside]]',
      '- [ ]',
      '> outside quote',
    ]);
  });

  it('reveals callout source on focused boundary intersections and restores outside the range', () => {
    const doc = ['> [!note] Title', '> Body', '', 'paragraph'].join('\n');
    const range = collectWidgetRanges(doc)[0]!;

    expect(collectAllRanges(doc, range.from, true).map((previewRange) => previewRange.rendererId)).not.toContain(
      'callout-widget',
    );
    expect(
      collectAllRanges(doc, doc.indexOf('Body'), true).map((previewRange) => previewRange.rendererId),
    ).not.toContain('callout-widget');
    expect(collectAllRanges(doc, range.to, true).map((previewRange) => previewRange.rendererId)).not.toContain(
      'callout-widget',
    );
    expect(collectAllRanges(doc, range.to + 1, true).map((previewRange) => previewRange.rendererId)).toContain(
      'callout-widget',
    );
  });

  it('mounts callout widgets and reveals source on focused selection without changing source', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> [!note] Title', '> Body', '', 'paragraph'].join('\n');
    const calloutRange = collectWidgetRanges(text).find((range) => range.rendererId === 'callout-widget')!;
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(parent.querySelector('.z-live-preview-callout-widget')).toBeTruthy();
    expect(editor.getText()).toBe(text);

    editor.focus();
    for (const position of [calloutRange.from, text.indexOf('Title'), text.indexOf('Body'), calloutRange.to]) {
      editor.view.dispatch({ selection: { anchor: position } });
      await waitForCalloutWidget(parent, 'absent');
      expect(editor.getText()).toBe(text);
    }

    editor.view.dispatch({ selection: { anchor: calloutRange.to + 1 } });
    await waitForCalloutWidget(parent, 'present');
    expect(editor.getText()).toBe(text);

    editor.view.dispatch({ selection: { anchor: text.indexOf('paragraph') } });
    await waitForCalloutWidget(parent, 'present');
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('activates mounted callout widgets through pointer selection without changing source', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> [!warning] Custom title', '> Body', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const widget = parent.querySelector<HTMLElement>('.z-live-preview-callout-widget');
    expect(widget).toBeTruthy();

    widget?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(editor.view.state.selection.main.head).toBe(0);
    await waitForCalloutWidget(parent, 'absent');
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('keeps callout edge deletion source-backed under the no-atomic-ranges policy', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> [!note] Title', '> Body', '', 'paragraph'].join('\n');
    const calloutRange = collectWidgetRanges(text).find((range) => range.rendererId === 'callout-widget')!;
    const editor = createMountedMarkdownEditor({ parent, text });

    editor.view.dispatch({ effects: setInternalLivePreviewFocused.of(true) });
    await waitForCalloutWidget(parent, 'absent');

    editor.view.dispatch({ selection: { anchor: calloutRange.from } });
    await waitForCalloutWidget(parent, 'absent');
    expect(deleteCharForward(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text.slice(0, calloutRange.from) + text.slice(calloutRange.from + 1));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text);

    editor.view.dispatch({ selection: { anchor: calloutRange.to } });
    await waitForCalloutWidget(parent, 'absent');
    expect(deleteCharBackward(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text.slice(0, calloutRange.to - 1) + text.slice(calloutRange.to));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text);

    editor.view.dispatch({ selection: { anchor: calloutRange.to + 1 } });
    await waitForCalloutWidget(parent, 'present');
    expect(deleteCharBackward(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text.slice(0, calloutRange.to) + text.slice(calloutRange.to + 1));
    expect(undo(editor.view)).toBe(true);
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('mounts callout widget DOM with safe source-preserving text', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['> [!note] <script>alert("safe title")</script>', '> <script>alert("safe body")</script>'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const widget = parent.querySelector('.z-live-preview-callout-widget');
    expect(widget).toBeTruthy();
    expect(widget?.textContent).toContain('<script>alert("safe title")</script>');
    expect(widget?.textContent).toContain('<script>alert("safe body")</script>');
    expect(widget?.querySelector('script')).toBeNull();
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
