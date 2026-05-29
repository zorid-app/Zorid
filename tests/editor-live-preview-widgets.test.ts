// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises';
import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
import type { LivePreviewVisibleRange } from '../packages/editor/src';
import {
  createLivePreviewContext,
  createMountedMarkdownEditor,
  defaultLivePreviewRenderers,
  filterLivePreviewRanges,
} from '../packages/editor/src/index';
import {
  collectLivePreviewRangesWithWidgetSuppression,
  collectLivePreviewWidgetRangesForVisibleRanges,
} from '../packages/editor/src/live-preview/extension';
import type {
  InternalLivePreviewRange,
  InternalLivePreviewRenderer,
} from '../packages/editor/src/live-preview/internal-types';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

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

async function waitForFocusEffect(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitForWidgetVisibleRangeEffect(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
}

describe('editor Live Preview structured widgets', () => {
  it('collects widget ranges from bounded visible windows rather than full document context', () => {
    const doc = [
      'intro',
      '```ts',
      'const visible = true;',
      '```',
      ...Array.from({ length: 500 }, (_, index) => `filler ${index}`),
      '```js',
      'const distant = true;',
      '```',
    ].join('\n');
    const state = EditorState.create({ doc });
    const visibleRange = { from: doc.indexOf('visible'), to: doc.indexOf('visible') + 'visible'.length };
    const contexts: LivePreviewVisibleRange[] = [];
    const recordingRenderer: InternalLivePreviewRenderer = {
      id: 'recording-widget',
      match: (context) => {
        contexts.push({ from: context.visibleFrom, to: context.visibleTo });
        return [];
      },
    };

    collectLivePreviewWidgetRangesForVisibleRanges([recordingRenderer], state, [visibleRange], false);

    expect(contexts).not.toEqual([{ from: 0, to: doc.length }]);
    expect(
      contexts.every((context) => context.from < doc.indexOf('distant') && context.to < doc.indexOf('distant')),
    ).toBe(true);
  });

  it('finds a fenced-code widget from bounded semantic-container context when the viewport is inside the block', () => {
    const doc = ['intro', '```ts', 'const visible = true;', '```', '', 'paragraph'].join('\n');
    const state = EditorState.create({ doc });
    const visibleRange = { from: doc.indexOf('visible'), to: doc.indexOf('visible') + 'visible'.length };

    const ranges = collectLivePreviewWidgetRangesForVisibleRanges(
      defaultLivePreviewWidgetRenderers,
      state,
      [visibleRange],
      false,
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toEqual([
      ['code-block-widget', ['```ts', 'const visible = true;', '```'].join('\n')],
    ]);
  });

  it('dedupes widgets collected from overlapping visible windows', () => {
    const doc = ['```ts', 'const visible = true;', '```', '', 'paragraph'].join('\n');
    const state = EditorState.create({ doc });
    const visible = doc.indexOf('visible');

    const ranges = collectLivePreviewWidgetRangesForVisibleRanges(
      defaultLivePreviewWidgetRenderers,
      state,
      [
        { from: visible, to: visible + 3 },
        { from: visible + 2, to: visible + 'visible'.length },
      ],
      false,
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toEqual([
      ['code-block-widget', ['```ts', 'const visible = true;', '```'].join('\n')],
    ]);
  });

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

  it('freezes focused widget activation boundary semantics', () => {
    const doc = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const widgetRange = collectWidgetRanges(doc)[0]!;

    expect(collectAllRanges(doc, widgetRange.from, true).map((range) => range.rendererId)).not.toContain(
      'code-block-widget',
    );
    expect(collectAllRanges(doc, doc.indexOf('value'), true).map((range) => range.rendererId)).not.toContain(
      'code-block-widget',
    );
    expect(collectAllRanges(doc, widgetRange.to, true).map((range) => range.rendererId)).not.toContain(
      'code-block-widget',
    );
    expect(collectAllRanges(doc, widgetRange.to + 1, true).map((range) => range.rendererId)).toContain(
      'code-block-widget',
    );
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

  it('suppresses and restores mounted code-block widget when focused selection enters and leaves the source range', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();
    expect(editor.getText()).toBe(text);

    editor.focus();
    await waitForFocusEffect();
    editor.view.dispatch({ selection: { anchor: text.indexOf('value') } });
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeNull();
    expect(editor.getText()).toBe(text);

    editor.view.dispatch({ selection: { anchor: text.indexOf('paragraph') } });
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeTruthy();
    expect(editor.getText()).toBe(text);

    editor.destroy();
    parent.remove();
  });

  it('updates widget viewport state after CodeMirror update cycle without plugin crashes', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const editor = createMountedMarkdownEditor({ parent, text });

    editor.view.dispatch({ changes: { from: text.length, insert: '\nmore' } });
    await waitForWidgetVisibleRangeEffect();

    expect(consoleError.mock.calls.flat().join('\n')).not.toContain('CodeMirror plugin crashed');

    editor.destroy();
    consoleError.mockRestore();
    parent.remove();
  });

  it('activates mounted code-block widget through pointer selection without changing source', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const text = ['```ts', 'const value = 1;', '```', '', 'paragraph'].join('\n');
    const editor = createMountedMarkdownEditor({ parent, text });

    const widget = parent.querySelector<HTMLElement>('.z-live-preview-code-block-widget');
    expect(widget).toBeTruthy();

    widget?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await waitForFocusEffect();

    expect(editor.view.state.selection.main.head).toBe(text.indexOf('const value'));
    expect(parent.querySelector('.z-live-preview-code-block-widget')).toBeNull();
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

  it('documents the no-atomic-ranges policy with deterministic reveal and restoration coverage', async () => {
    const extensionSource = await readFile('packages/editor/src/live-preview/extension.ts', 'utf8');

    expect(extensionSource).not.toContain('atomicRanges');
  });
});
