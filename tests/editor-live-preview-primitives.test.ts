// @vitest-environment happy-dom

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
    ).toEqual(['heading', 'inline-code']);

    const focusedContext = createLivePreviewContext(state, { from: 0, to: doc.length }, true);
    expect(
      collectLivePreviewRanges(defaultLivePreviewRenderers, focusedContext).map((range) => range.rendererId),
    ).toEqual(['inline-code']);
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
    ].join('\n');
    const state = EditorState.create({ doc });
    const context = createLivePreviewContext(state, { from: 0, to: doc.length });

    const ranges = collectLivePreviewRanges(defaultLivePreviewRenderers, context);
    const rendererIds = ranges.map((range) => range.rendererId);

    expect(rendererIds).toEqual(['heading', 'inline-code', 'markdown-link', 'wiki-link', 'tag', 'task-marker']);
    expect(
      doc.slice(
        ranges.find((range) => range.rendererId === 'tag')?.from,
        ranges.find((range) => range.rendererId === 'tag')?.to,
      ),
    ).toBe('#tag/sub');
    expect(rendererIds).not.toContain('table');
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
      'inline-code',
      'markdown-link',
      'wiki-link',
      'tag',
      'task-marker',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([
      '# Heading',
      '`#not-a-tag [not](link.md) [[Nope]]`',
      '[link](target.md)',
      '[[Note|Alias]]',
      '#tag/sub',
      '- [ ]',
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

  it('keeps task markers styling-only until a source-backed toggle command is added', () => {
    const doc = '- [ ] pending task';
    const state = EditorState.create({ doc });
    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }),
    );

    expect(ranges).toContainEqual({
      rendererId: 'task-marker',
      from: 0,
      to: 5,
      className: 'z-live-preview-task-marker',
    });
    expect(state.doc.toString()).toBe(doc);
    expect(ranges.find((range) => range.rendererId === 'task-marker')?.attributes).toBeUndefined();
  });

  it('wires default MVP preview renderers into mounted editors', () => {
    const parent = document.createElement('div');
    const editor = createMountedMarkdownEditor({
      parent,
      text: '# Heading\n\nSee [[Note]] and #tag.',
    });

    expect(parent.querySelector('[data-live-preview-renderer="heading"]')).toBeTruthy();
    expect(parent.querySelector('[data-live-preview-renderer="wiki-link"]')).toBeTruthy();
    expect(parent.querySelector('[data-live-preview-renderer="tag"]')).toBeTruthy();
    expect(editor.getText()).toBe('# Heading\n\nSee [[Note]] and #tag.');

    editor.destroy();
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
