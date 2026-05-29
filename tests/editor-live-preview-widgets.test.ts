// @vitest-environment happy-dom

import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  createLivePreviewContext,
  createMountedMarkdownEditor,
  defaultLivePreviewRenderers,
  filterLivePreviewRanges,
} from '../packages/editor/src/index';
import type { InternalLivePreviewRange } from '../packages/editor/src/live-preview/internal-types';
import { defaultLivePreviewWidgetRenderers } from '../packages/editor/src/live-preview/renderers';

function collectPublicRanges(doc: string, selection = 0, focused = false) {
  const state = EditorState.create({ doc, selection: { anchor: selection } });
  const context = createLivePreviewContext(state, { from: 0, to: doc.length }, focused);
  return filterLivePreviewRanges(
    defaultLivePreviewRenderers.flatMap((renderer) => renderer.match(context)),
    context,
  );
}

function collectWidgetRanges(doc: string, selection = 0, focused = false): InternalLivePreviewRange[] {
  const state = EditorState.create({ doc, selection: { anchor: selection } });
  const context = createLivePreviewContext(state, { from: 0, to: doc.length }, focused);
  return filterLivePreviewRanges(
    defaultLivePreviewWidgetRenderers.flatMap((renderer) => renderer.match(context)),
    context,
  ) as InternalLivePreviewRange[];
}

function collectAllRanges(doc: string, selection = 0, focused = false) {
  return [...collectWidgetRanges(doc, selection, focused), ...collectPublicRanges(doc, selection, focused)].sort(
    (left, right) => left.from - right.from || left.to - right.to || left.rendererId.localeCompare(right.rendererId),
  );
}

describe('editor Live Preview structured widgets', () => {
  it('keeps the public renderer list free of private widget ranges', () => {
    const doc = ['```ts', 'const value = 1;', '```', '', '#tag'].join('\n');

    const ranges = collectPublicRanges(doc);

    expect(ranges.map((range) => range.rendererId)).toEqual(['tag']);
    expect(ranges.map((range) => range.kind)).not.toContain('widget');
  });

  it('emits private fenced-code widget ranges only for complete backtick and tilde fences', () => {
    const doc = [
      '```ts',
      'const value = 1;',
      '```',
      '',
      '~~~js',
      'console.log(value);',
      '~~~',
      '',
      '```unclosed',
      'raw only',
    ].join('\n');

    const ranges = collectWidgetRanges(doc);

    expect(ranges.map((range) => [range.from, range.to, range.className, range.kind])).toEqual([
      [0, 26, 'z-live-preview-code-block-widget', 'widget'],
      [28, 57, 'z-live-preview-code-block-widget', 'widget'],
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([
      ['```ts', 'const value = 1;', '```'].join('\n'),
      ['~~~js', 'console.log(value);', '~~~'].join('\n'),
    ]);
  });

  it('requires matching complete fences and leaves indented code raw', () => {
    const doc = ['````', '``` nested text', '````', '', '```', 'still raw', '~~~', '', '    ``` indented'].join('\n');
    const ranges = collectWidgetRanges(doc);

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([
      ['````', '``` nested text', '````'].join('\n'),
    ]);
  });

  it('suppresses inline, task, tag, link, and blockquote renderers inside fenced code only', () => {
    const doc = [
      '```md',
      '#tag [link](target.md) [[Wiki]]',
      '- [ ] task',
      '> quote',
      '```',
      '',
      '#tag [link](target.md) [[Wiki]]',
      '- [ ] task',
      '> quote',
    ].join('\n');

    const ranges = collectAllRanges(doc);
    expect(ranges.map((range) => range.rendererId)).toEqual([
      'code-block-widget',
      'tag',
      'markdown-link',
      'wiki-link',
      'task-marker',
      'blockquote',
    ]);
    expect(ranges.filter((range) => range.rendererId === 'code-block-widget')).toHaveLength(1);
  });

  it('reveals raw fenced code while focused selection intersects the widget range', () => {
    const doc = ['```ts', 'const value = 1;', '```', '', '#tag'].join('\n');

    expect(collectAllRanges(doc, 0, false).map((range) => range.rendererId)).toEqual(['code-block-widget', 'tag']);
    expect(collectAllRanges(doc, doc.indexOf('value'), true).map((range) => range.rendererId)).toEqual(['tag']);
    expect(collectAllRanges(doc, doc.length, true).map((range) => range.rendererId)).toEqual(['code-block-widget']);
  });

  it('keeps mounted code-block widget hidden source when an unfocused selection transaction enters the block', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();

    editor.view.dispatch({ selection: { anchor: text.indexOf('value') } });
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('mounts code-block widget DOM with safe source-preserving text', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', '<script>alert("safe text")</script>', '```', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const widget = parent.querySelector('.z-live-preview-code-block-widget');
    expect(widget).toBeTruthy();
    expect(widget?.textContent).toContain('<script>alert("safe text")</script>');
    expect(widget?.querySelector('script')).toBeNull();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });
});
