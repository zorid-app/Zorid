// @vitest-environment happy-dom

import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  collectLivePreviewRanges,
  createLivePreviewContext,
  defaultLivePreviewRenderers,
} from '../packages/editor/src';
import { collectLivePreviewRangesWithWidgetSuppression } from '../packages/editor/src/live-preview/extension';
import {
  defaultLivePreviewInternalRenderers,
  defaultLivePreviewWidgetRenderers,
} from '../packages/editor/src/live-preview/renderers';

function collectAllRanges(doc: string, selection: { from: number; to: number }, focused = true) {
  const state = EditorState.create({ doc, selection: { anchor: selection.from, head: selection.to } });
  return collectLivePreviewRangesWithWidgetSuppression(
    defaultLivePreviewRenderers,
    defaultLivePreviewInternalRenderers,
    defaultLivePreviewWidgetRenderers,
    state,
    [{ from: 0, to: doc.length }],
    focused,
  );
}

describe('editor Live Preview selection and mapping hardening', () => {
  it('reveals inline-code delimiter replacements when a focused selection spans the code source', () => {
    const doc = 'before `code` after';
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('`code`'), head: doc.indexOf('`code`') + '`code`'.length },
    });

    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }, true),
    );

    expect(ranges.map((range) => range.rendererId)).toEqual([]);
    expect(state.doc.toString()).toBe(doc);
  });

  it('keeps adjacent public ranges previewed while a focused selection reveals a task marker projection', () => {
    const doc = ['# Heading', '- [ ] task', '`code`'].join('\n');
    const markerFrom = doc.indexOf('- [ ]');
    const markerTo = markerFrom + '- [ ]'.length;

    const ranges = collectAllRanges(doc, { from: markerFrom, to: markerTo }, true);

    expect(ranges.map((range) => range.rendererId)).toEqual([
      'heading',
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).not.toContain('- [ ]');
  });

  it('reveals a code-block widget when focused selection spans from paragraph text into the fenced block', () => {
    const doc = ['intro', '```ts', 'const value = 1;', '```', 'after'].join('\n');
    const selection = { from: doc.indexOf('intro'), to: doc.indexOf('value') };

    const ranges = collectAllRanges(doc, selection, true);

    expect(ranges.map((range) => range.rendererId)).not.toContain('code-block-widget');
    expect(doc.slice(selection.from, selection.to)).toBe(['intro', '```ts', 'const '].join('\n'));
  });

  it('reveals a callout widget when focused selection spans from callout source into following text', () => {
    const doc = ['> [!note] Title', '> Body', '', 'after'].join('\n');
    const selection = { from: doc.indexOf('Title'), to: doc.indexOf('after') };

    const ranges = collectAllRanges(doc, selection, true);

    expect(ranges.map((range) => range.rendererId)).not.toContain('callout-widget');
    expect(doc.slice(selection.from, selection.to)).toContain('> Body');
  });
});
