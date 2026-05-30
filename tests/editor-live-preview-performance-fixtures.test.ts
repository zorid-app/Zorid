import { readFile } from 'node:fs/promises';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { LivePreviewVisibleRange } from '../packages/editor/src';
import {
  collectLivePreviewRangesWithWidgetSuppression,
  collectLivePreviewWidgetRangesForVisibleRanges,
} from '../packages/editor/src/live-preview/extension';
import type { InternalLivePreviewRenderer } from '../packages/editor/src/live-preview/internal-types';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

describe('editor Live Preview viewport/performance fixtures', () => {
  it('keeps widget matcher contexts bounded near the visible range in large documents', () => {
    const doc = [
      '```ts',
      'const visible = true;',
      '```',
      ...Array.from({ length: 2000 }, (_, index) => `filler ${index}`),
      '> [!note] distant',
      '> body',
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

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.to).toBeLessThan(doc.indexOf('distant'));
  });

  it('returns only near-visible widgets from a large mixed document', () => {
    const visibleCallout = ['> [!note] Visible', '> body'].join('\n');
    const distantCallout = ['> [!warning] Distant', '> body'].join('\n');
    const doc = [
      '# Heading #tag [link](target.md)',
      visibleCallout,
      ...Array.from({ length: 1500 }, (_, index) => `filler ${index}`),
      distantCallout,
      '```ts',
      'const distant = true;',
      '```',
    ].join('\n');
    const state = EditorState.create({ doc });
    const visibleRange = { from: doc.indexOf('Visible'), to: doc.indexOf('Visible') + 'Visible'.length };

    const ranges = collectLivePreviewWidgetRangesForVisibleRanges(
      defaultLivePreviewWidgetRenderers,
      state,
      [visibleRange],
      false,
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toEqual([
      ['callout-widget', visibleCallout],
    ]);
  });

  it('keeps a large mixed viewport complete for headings, tasks, code blocks, and callouts', () => {
    const visibleCode = ['```ts', 'const visible = true;', '```'].join('\n');
    const visibleCallout = ['> [!note] Visible', '> body'].join('\n');
    const visibleCluster = ['# Visible heading', '- [ ] visible task', visibleCode, visibleCallout].join('\n');
    const doc = [
      visibleCluster,
      ...Array.from({ length: 2400 }, (_, index) => `suffix filler ${index}`),
      '# Distant heading',
      '- [ ] distant task',
      ['```js', 'const distant = true;', '```'].join('\n'),
      ['> [!warning] Distant', '> body'].join('\n'),
    ].join('\n');
    const state = EditorState.create({ doc });
    const visibleRange = {
      from: doc.indexOf('# Visible heading'),
      to: doc.indexOf(visibleCallout) + visibleCallout.length,
    };

    const ranges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      defaultLivePreviewInternalRenderers,
      defaultLivePreviewWidgetRenderers,
      state,
      [visibleRange],
      false,
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toEqual([
      ['heading', '# Visible heading'],
      ['task-marker', '- [ ]'],
      ['code-block-widget', visibleCode],
      ['callout-widget', visibleCallout],
    ]);
  });

  it('keeps task projections limited to the requested visible range in large task lists', () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `- [ ] task ${index}`);
    const doc = lines.join('\n');
    const target = 'task 500';
    const visibleRange = { from: doc.indexOf(target), to: doc.indexOf(target) + target.length };
    const state = EditorState.create({ doc });

    const ranges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      defaultLivePreviewInternalRenderers,
      defaultLivePreviewWidgetRenderers,
      state,
      [visibleRange],
      false,
    );

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['- [ ]']);
  });

  it('keeps far multi-line task-list viewports complete when parser work is bounded', () => {
    const lines = Array.from({ length: 200_000 }, (_, index) => `- [ ] task ${index}`);
    const doc = lines.join('\n');
    const firstTarget = 'task 199990';
    const lastTarget = 'task 199999';
    const visibleRange = { from: doc.indexOf(firstTarget), to: doc.indexOf(lastTarget) + lastTarget.length };
    const state = EditorState.create({ doc });

    const ranges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      defaultLivePreviewInternalRenderers,
      defaultLivePreviewWidgetRenderers,
      state,
      [visibleRange],
      false,
    );

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(Array.from({ length: 10 }, () => '- [ ]'));
  });

  it('does not use the whole document as the initial widget scan range', async () => {
    const source = await readFile('packages/editor/src/live-preview/extension.ts', 'utf8');

    expect(source).toContain('Math.min(state.doc.length, livePreviewWidgetScanMargin)');
    expect(source).not.toContain('return [{ from: 0, to: state.doc.length }]');
  });
});
