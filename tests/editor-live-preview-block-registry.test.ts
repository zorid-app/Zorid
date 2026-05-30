// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises';
import { EditorState } from '@codemirror/state';
import { WidgetType } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import type { LivePreviewBlockRenderer } from '../packages/editor/src/live-preview/block-renderers';
import {
  livePreviewBlockRenderersToInternalRenderers,
  livePreviewBlockRendererToInternalRenderer,
} from '../packages/editor/src/live-preview/block-renderers';
import {
  collectLivePreviewRangesWithWidgetSuppression,
  collectLivePreviewWidgetRangesForVisibleRanges,
} from '../packages/editor/src/live-preview/extension';
import { defaultLivePreviewRenderers } from '../packages/editor/src/live-preview/renderers';

class TestBlockWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  toDOM(): HTMLElement {
    const element = document.createElement('div');
    element.textContent = this.label;
    return element;
  }
}

function testBlockRenderer(): LivePreviewBlockRenderer {
  return {
    id: 'test-block-widget',
    match: ({ docText, visibleFrom, visibleTo }) => {
      const ranges = [];
      for (const match of docText.matchAll(/^:::test\n([\s\S]*?)\n:::$/gm)) {
        const index = match.index;
        if (index === undefined) continue;
        const from = index;
        const to = index + match[0].length;
        if (from < visibleTo && to > visibleFrom) {
          ranges.push({ from, to, className: 'z-live-preview-test-block-widget' });
        }
      }
      return ranges;
    },
    widget: (match, { docText }) => new TestBlockWidget(docText.slice(match.from, match.to)),
  };
}

describe('editor Live Preview private block renderer registry', () => {
  it('adapts a private block renderer into the existing internal widget renderer shape', () => {
    const doc = ['intro', ':::test', 'body', ':::', 'after'].join('\n');
    const state = EditorState.create({ doc });
    const renderer = livePreviewBlockRendererToInternalRenderer(testBlockRenderer());

    const ranges = collectLivePreviewWidgetRangesForVisibleRanges(
      [renderer],
      state,
      [{ from: 0, to: doc.length }],
      false,
    );

    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      rendererId: 'test-block-widget',
      from: doc.indexOf(':::test'),
      to: doc.indexOf('after') - 1,
      activationFrom: doc.indexOf(':::test'),
      activationTo: doc.indexOf('after') - 1,
      sourceFrom: doc.indexOf(':::test'),
      sourceTo: doc.indexOf('after') - 1,
      clipboardSource: 'document-source',
      atomic: 'none',
      className: 'z-live-preview-test-block-widget',
      kind: 'widget',
    });
  });

  it('keeps first-party block widgets on the same private source and activation contract', async () => {
    const { defaultLivePreviewWidgetRenderers } = await import('../packages/editor/src/live-preview/renderers');
    const doc = ['```ts', 'const value = 1;', '```', '', '> [!note] Title', '> Body', '', 'after'].join('\n');
    const state = EditorState.create({ doc });

    const ranges = collectLivePreviewWidgetRangesForVisibleRanges(
      defaultLivePreviewWidgetRenderers,
      state,
      [{ from: 0, to: doc.length }],
      false,
    );

    expect(
      ranges.map((range) => ({
        id: range.rendererId,
        source: doc.slice(range.sourceFrom ?? -1, range.sourceTo ?? -1),
        activation: doc.slice(range.activationFrom ?? -1, range.activationTo ?? -1),
        clipboardSource: range.clipboardSource,
        atomic: range.atomic,
      })),
    ).toEqual([
      {
        id: 'code-block-widget',
        source: ['```ts', 'const value = 1;', '```'].join('\n'),
        activation: ['```ts', 'const value = 1;', '```'].join('\n'),
        clipboardSource: 'document-source',
        atomic: 'none',
      },
      {
        id: 'callout-widget',
        source: ['> [!note] Title', '> Body'].join('\n'),
        activation: ['> [!note] Title', '> Body'].join('\n'),
        clipboardSource: 'document-source',
        atomic: 'none',
      },
    ]);
  });

  it('inherits visible scan-window collection and dedupe behavior from the existing widget pipeline', () => {
    const doc = [
      ':::test',
      'visible',
      ':::',
      ...Array.from({ length: 3000 }, (_, index) => `filler ${index}`),
      ':::test',
      'distant',
      ':::',
    ].join('\n');
    const state = EditorState.create({ doc });
    const visible = doc.indexOf('visible');
    const renderers = livePreviewBlockRenderersToInternalRenderers([testBlockRenderer()]);

    const ranges = collectLivePreviewWidgetRangesForVisibleRanges(
      renderers,
      state,
      [
        { from: visible, to: visible + 2 },
        { from: visible + 1, to: visible + 'visible'.length },
      ],
      false,
    );

    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual([[':::test', 'visible', ':::'].join('\n')]);
  });

  it('suppresses public inline renderers inside adapted private block widgets', () => {
    const doc = [':::test', '#inside [inside](target.md)', ':::', '', '#outside [outside](target.md)'].join('\n');
    const state = EditorState.create({ doc });
    const blockRenderers = livePreviewBlockRenderersToInternalRenderers([testBlockRenderer()]);

    const ranges = collectLivePreviewRangesWithWidgetSuppression(
      defaultLivePreviewRenderers,
      [],
      blockRenderers,
      state,
      [{ from: 0, to: doc.length }],
      false,
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toEqual([
      ['test-block-widget', [':::test', '#inside [inside](target.md)', ':::'].join('\n')],
      ['tag', '#outside'],
      ['markdown-link', '[outside](target.md)'],
    ]);
  });

  it('keeps private block helpers out of public package and live-preview barrels', async () => {
    const rootBarrel = await readFile('packages/editor/src/index.ts', 'utf8');
    const livePreviewBarrel = await readFile('packages/editor/src/live-preview/index.ts', 'utf8');
    const platformApi = await readFile('packages/platform-api/src/index.ts', 'utf8');
    const packageManifest = JSON.parse(await readFile('packages/editor/package.json', 'utf8')) as {
      exports: Record<string, unknown>;
    };

    for (const source of [rootBarrel, livePreviewBarrel, platformApi]) {
      expect(source).not.toContain('LivePreviewBlockRenderer');
      expect(source).not.toContain('livePreviewBlockRendererToInternalRenderer');
      expect(source).not.toContain('block-renderers');
    }
    expect(Object.keys(packageManifest.exports)).toEqual(['.']);
  });
});
