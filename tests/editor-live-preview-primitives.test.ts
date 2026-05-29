// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  collectLivePreviewRanges,
  createLivePreviewContext,
  createMountedMarkdownEditor,
  defaultLivePreviewRenderers,
  filterLivePreviewRanges,
  type LivePreviewRenderer,
  livePreviewExtension,
  livePreviewRangeIntersectsSelection,
  shouldRenderLivePreviewRange,
} from '../packages/editor/src/index';
import { collectLivePreviewRangesWithWidgetSuppression } from '../packages/editor/src/live-preview/extension';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

describe('editor Live Preview primitives', () => {
  const renderer: LivePreviewRenderer = {
    id: 'test-emphasis',
    match: () => [
      { rendererId: 'test-emphasis', from: 0, to: 4, className: 'z-preview-a' },
      { rendererId: 'test-emphasis', from: 10, to: 14, className: 'z-preview-b' },
    ],
  };

  it('filters preview ranges by visible range deterministically', () => {
    const state = EditorState.create({ doc: '0123456789abcd' });
    const context = createLivePreviewContext(state, { from: 8, to: 12 });

    expect(collectLivePreviewRanges([renderer], context)).toEqual([
      { rendererId: 'test-emphasis', from: 10, to: 14, className: 'z-preview-b' },
    ]);
  });

  it('reveals source when focused selection intersects a preview range', () => {
    const range = { from: 5, to: 10 };

    expect(livePreviewRangeIntersectsSelection(range, [{ from: 7, to: 7 }])).toBe(true);
    expect(shouldRenderLivePreviewRange(range, { focused: true, selectionRanges: [{ from: 7, to: 7 }] })).toBe(false);
    expect(shouldRenderLivePreviewRange(range, { focused: false, selectionRanges: [{ from: 7, to: 7 }] })).toBe(true);
  });

  it('keeps non-intersecting focused ranges previewable', () => {
    expect(
      filterLivePreviewRanges(
        [
          { rendererId: 'a', from: 0, to: 3, className: 'a' },
          { rendererId: 'b', from: 5, to: 8, className: 'b' },
        ],
        { visibleFrom: 0, visibleTo: 10, focused: true, selectionRanges: [{ from: 1, to: 1 }] },
      ),
    ).toEqual([{ rendererId: 'b', from: 5, to: 8, className: 'b' }]);
  });

  it('keeps inactive ranges previewed but reveals active source while focused', () => {
    const doc = '# Heading\n\n`code`';
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('Heading') },
    });

    const inactiveContext = createLivePreviewContext(state, { from: 0, to: doc.length }, false);
    expect(
      collectLivePreviewRanges(defaultLivePreviewRenderers, inactiveContext).map((range) => range.rendererId),
    ).toEqual(['heading', 'inline-code-delimiter', 'inline-code', 'inline-code-delimiter']);

    const focusedContext = createLivePreviewContext(state, { from: 0, to: doc.length }, true);
    expect(
      collectLivePreviewRanges(defaultLivePreviewRenderers, focusedContext).map((range) => range.rendererId),
    ).toEqual(['inline-code-delimiter', 'inline-code', 'inline-code-delimiter']);
  });

  it('adds decorations without changing source text', () => {
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({
      parent,
      text: '# Heading',
      extensionContributions: [{ id: 'live-preview', extension: livePreviewExtension([renderer]) }],
    });

    expect(editor.getText()).toBe('# Heading');
    expect(parent.querySelector('[data-live-preview-renderer="test-emphasis"]')).toBeTruthy();

    editor.destroy();
  });

  it('ships MVP renderers for low-risk Markdown syntax only', () => {
    const doc = [
      '# Heading',
      '',
      'Use `code` with [link](target.md), [[Wiki Link]], and #tag/sub.',
      '- [x] completed task',
      '| table | stays plain |',
      '```',
      '- [ ] fenced code sample stays plain',
      '```',
      '    - [ ] indented code sample stays plain',
    ].join('\n');
    const state = EditorState.create({ doc });
    const context = createLivePreviewContext(state, { from: 0, to: doc.length });

    const ranges = collectLivePreviewRanges(defaultLivePreviewRenderers, context);
    const rendererIds = ranges.map((range) => range.rendererId);

    expect(rendererIds).toEqual([
      'heading',
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
      'markdown-link',
      'wiki-link',
      'tag',
    ]);
    expect(
      doc.slice(
        ranges.find((range) => range.rendererId === 'tag')?.from,
        ranges.find((range) => range.rendererId === 'tag')?.to,
      ),
    ).toBe('#tag/sub');
    expect(rendererIds).not.toContain('table');
    expect(rendererIds).not.toContain('task-marker');
    expect(ranges.map((range) => doc.slice(range.from, range.to))).not.toContain('- [ ]');
    expect(ranges.map((range) => doc.slice(range.from, range.to))).not.toContain('    - [ ]');
  });

  it('keeps fenced-code task markers plain when the visible range starts inside the fence', () => {
    const doc = ['intro', '```', '- [ ] fenced code sample stays plain', '```', '- [ ] real task'].join('\n');
    const visibleFrom = doc.indexOf('fenced code sample');
    const visibleTo = doc.indexOf('```', doc.indexOf('fenced code sample'));
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: visibleFrom, to: visibleTo }),
    );

    expect(ranges.map((range) => range.rendererId)).not.toContain('task-marker');
    expect(ranges.map((range) => doc.slice(range.from, range.to))).not.toContain('- [ ]');
  });

  it('keeps matcher ranges deterministic and avoids simple inline-code false positives', () => {
    const doc = [
      '# Heading',
      'Use `#not-a-tag [not](link.md) [[Nope]]` beside [link](target.md), [[Note|Alias]], and #tag/sub.',
      '- [ ] pending task',
      'https://example.com/#fragment',
      '| table | stays plain |',
    ].join('\n');
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    );

    expect(ranges.map((range) => range.rendererId)).toEqual([
      'heading',
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
      'markdown-link',
      'wiki-link',
      'tag',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([
      '# Heading',
      '`',
      '`#not-a-tag [not](link.md) [[Nope]]`',
      '`',
      '[link](target.md)',
      '[[Note|Alias]]',
      '#tag/sub',
    ]);
    expect(ranges.every((range, index) => index === 0 || ranges[index - 1]!.from <= range.from)).toBe(true);
    expect(ranges.map((range) => range.rendererId)).not.toContain('table');
  });

  it('restores preview decorations after focused selection leaves the range', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: '# Heading\n\n`code`',
    });

    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeTruthy();

    editor.focus();
    editor.view.dispatch({ selection: { anchor: 2 } });
    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeNull();
    expect(parent.querySelector('[data-live-preview-renderer="inline-code"]')).toBeTruthy();

    editor.view.dispatch({ selection: { anchor: editor.getText().length } });
    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeTruthy();

    editor.destroy();
    parent.remove();
  });

  it('keeps public defaults free of private line and widget projection ranges', async () => {
    const doc = ['> quote', '- [ ] pending task', '```ts', 'code', '```'].join('\n');
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    );
    const rendererSource = await readFile('packages/editor/src/live-preview/renderers.ts', 'utf8');
    const rootBarrelSource = await readFile('packages/editor/src/index.ts', 'utf8');
    const livePreviewBarrelSource = await readFile('packages/editor/src/live-preview/index.ts', 'utf8');

    expect(ranges.map((range) => range.rendererId)).toEqual([]);
    expect(defaultLivePreviewRenderers.map((renderer) => renderer.id)).not.toEqual(
      expect.arrayContaining(['blockquote', 'task-marker', 'code-block-widget', 'callout-widget']),
    );
    expect(rendererSource).not.toContain('as LivePreviewRenderer');
    expect(rootBarrelSource).not.toContain('taskMarkerLivePreviewRenderer');
    expect(livePreviewBarrelSource).not.toContain('taskMarkerLivePreviewRenderer');
    expect(state.doc.toString()).toBe(doc);
  });

  it('keeps task marker preview source-preserving as a private visual checkbox projection', () => {
    const doc = '- [ ] pending task';
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      defaultLivePreviewInternalRenderers,
      defaultLivePreviewWidgetRenderers,
      state,
      [{ from: 0, to: doc.length }],
      false,
    );

    expect(ranges).toContainEqual(
      expect.objectContaining({
        rendererId: 'task-marker',
        from: 0,
        to: 5,
        className: 'z-live-preview-task-checkbox',
        kind: 'replace',
      }),
    );
    expect(state.doc.toString()).toBe(doc);
    expect(ranges.find((range) => range.rendererId === 'task-marker')?.attributes).toBeUndefined();
  });

  it('wires public and private first-party preview renderers into mounted default editors', () => {
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['# Heading', '', 'See [[Note]] and #tag.', '', '> quote', '- [ ] task'].join('\n'),
    });

    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeTruthy();
    expect(parent.querySelector('[data-live-preview-renderer="wiki-link"]')).toBeTruthy();
    expect(parent.querySelector('[data-live-preview-renderer="tag"]')).toBeTruthy();
    expect(parent.querySelector('.cm-line.z-live-preview-blockquote-line')).toBeTruthy();
    expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeTruthy();
    expect(editor.getText()).toContain('- [ ] task');

    editor.destroy();
  });

  it('keeps explicit livePreviewRenderers customization on the public renderer path only', () => {
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['# Heading', '> quote', '- [ ] task'].join('\n'),
      livePreviewRenderers: [renderer],
    });

    expect(parent.querySelector('[data-live-preview-renderer="test-emphasis"]')).toBeTruthy();
    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeNull();
    expect(parent.querySelector('.cm-line.z-live-preview-blockquote-line')).toBeNull();
    expect(parent.querySelector('.z-live-preview-task-checkbox')).toBeNull();
    expect(editor.getText()).toBe(['# Heading', '> quote', '- [ ] task'].join('\n'));

    editor.destroy();
  });

  it('hides inactive inline-code delimiters but reveals them when the code span is active', () => {
    const doc = 'Use `code` here';
    const inactiveState = EditorState.create({ doc, selection: { anchor: 0 } });
    const inactiveRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(inactiveState, { from: 0, to: doc.length }, true),
    );
    expect(inactiveRanges.map((range) => [range.rendererId, doc.slice(range.from, range.to), range.kind])).toEqual([
      ['inline-code-delimiter', '`', 'replace'],
      ['inline-code', '`code`', undefined],
      ['inline-code-delimiter', '`', 'replace'],
    ]);
    expect(inactiveState.doc.toString()).toBe(doc);

    const activeState = EditorState.create({ doc, selection: { anchor: doc.indexOf('code') } });
    const activeRanges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(activeState, { from: 0, to: doc.length }, true),
    );
    expect(activeRanges.map((range) => range.rendererId)).toEqual([]);
    expect(activeState.doc.toString()).toBe(doc);
  });

  it('keeps save shortcut wiring inside the mounted editor factory', () => {
    const parent = document.createElement('div');
    let saves = 0;
    const editor = createMountedMarkdownEditor({
      parent,
      text: 'save me',
      onSave: () => {
        saves += 1;
      },
    });

    editor.focus();
    editor.view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(saves).toBe(1);

    editor.destroy();
  });
});
