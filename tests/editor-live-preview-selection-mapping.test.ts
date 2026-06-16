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
import { livePreviewSourceRangeForCollapsedSelection } from '../packages/editor/src/live-preview/source-text';

const collapsedToggleFixture = (() => {
  const doc = ['>>- Toggle title', '    Hidden child', '        Hidden grandchild', 'after'].join('\n');
  return {
    doc,
    source: { from: 0, to: doc.indexOf('\nafter') },
    marker: sourceRange(doc, '>>- '),
    title: sourceRange(doc, 'Toggle title'),
    child: sourceRange(doc, '    Hidden child'),
    grandchild: sourceRange(doc, '        Hidden grandchild'),
  };
})();

const collapsedCalloutFixture = (() => {
  const doc = ['> [!note]- Visible title', '> Hidden body', '> - Hidden child', 'after'].join('\n');
  return {
    doc,
    source: { from: 0, to: doc.indexOf('\nafter') },
    marker: sourceRange(doc, '> [!note]- '),
    title: sourceRange(doc, 'Visible title'),
    body: sourceRange(doc, '> Hidden body'),
    child: sourceRange(doc, '> - Hidden child'),
  };
})();

function sourceRange(doc: string, selected: string): { from: number; to: number } {
  const from = doc.indexOf(selected);
  if (from === -1) throw new Error(`Missing selected text: ${selected}`);
  return { from, to: from + selected.length };
}

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
  it('derives title-only collapsed selections from the visible title source only', () => {
    const { source, title, child, grandchild } = collapsedToggleFixture;

    expect(
      livePreviewSourceRangeForCollapsedSelection(
        { source, title, hidden: [child, grandchild] },
        { from: title.from, to: title.to },
      ),
    ).toEqual(title);
  });

  it('promotes selections crossing collapsed hidden children to the canonical subtree source range', () => {
    const { source, title, child, grandchild } = collapsedToggleFixture;

    expect(
      livePreviewSourceRangeForCollapsedSelection(
        { source, title, hidden: [child, grandchild] },
        { from: title.from, to: child.to },
      ),
    ).toEqual(source);
  });

  it('reveals collapsed toggle syntax by structural position while title-only selections keep hidden children collapsed', () => {
    const { doc, marker, title, child } = collapsedToggleFixture;

    expect(
      collectAllRanges(doc, { from: marker.from, to: marker.to }, true).map((range) => doc.slice(range.from, range.to)),
    ).not.toContain('>>- ');
    expect(collectAllRanges(doc, { from: title.from, to: title.to }, true).map((range) => range.rendererId)).toEqual([
      'toggle-structural-marker',
      'toggle-line',
      'toggle-hidden-children',
      'toggle-hidden-children',
    ]);
    expect(collectAllRanges(doc, { from: title.from, to: child.to }, true).map((range) => range.rendererId)).toEqual([
      'toggle-structural-marker',
      'toggle-line',
      'toggle-hidden-children',
      'toggle-hidden-children',
    ]);
  });

  it('maps full collapsed subtree selections to the complete source range', () => {
    const { source, title, child, grandchild } = collapsedToggleFixture;

    expect(livePreviewSourceRangeForCollapsedSelection({ source, title, hidden: [child, grandchild] }, source)).toEqual(
      source,
    );
  });

  it('reveals collapsed callout syntax only when a focused selection touches syntax', () => {
    const { doc, marker, title } = collapsedCalloutFixture;

    expect(
      collectAllRanges(doc, { from: marker.from, to: marker.to }, true).map((range) => doc.slice(range.from, range.to)),
    ).not.toContain('> [!note]- ');
    expect(collectAllRanges(doc, { from: title.from, to: title.to }, true).map((range) => range.rendererId)).toContain(
      'callout-structural-marker',
    );
  });

  it('derives collapsed callout title selections and hidden-body crossings from canonical source ranges', () => {
    const { source, title, body, child } = collapsedCalloutFixture;

    expect(livePreviewSourceRangeForCollapsedSelection({ source, title, hidden: [body, child] }, title)).toEqual(title);
    expect(
      livePreviewSourceRangeForCollapsedSelection(
        { source, title, hidden: [body, child] },
        { from: title.from, to: body.to },
      ),
    ).toEqual(source);
  });

  it('freezes inline-code delimiter activation boundary semantics', () => {
    const doc = 'before `code` after';
    const codeFrom = doc.indexOf('`code`');
    const codeTo = codeFrom + '`code`'.length;

    expect(
      collectAllRanges(doc, { from: codeFrom, to: codeFrom }, true).map((range) => doc.slice(range.from, range.to)),
    ).toEqual(['code', '`']);
    expect(
      collectAllRanges(doc, { from: doc.indexOf('code') + 1, to: doc.indexOf('code') + 1 }, true).map((range) =>
        doc.slice(range.from, range.to),
      ),
    ).toEqual(['`', 'code', '`']);
    expect(
      collectAllRanges(doc, { from: codeTo, to: codeTo }, true).map((range) => doc.slice(range.from, range.to)),
    ).toEqual(['`', 'code']);

    expect(
      collectAllRanges(doc, { from: codeFrom - 1, to: codeFrom - 1 }, true).map((range) => range.rendererId),
    ).toEqual(['inline-code-delimiter', 'inline-code', 'inline-code-delimiter']);
    expect(collectAllRanges(doc, { from: codeTo + 1, to: codeTo + 1 }, true).map((range) => range.rendererId)).toEqual([
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
    ]);
  });

  it('reveals inline-code delimiter replacements while preserving the rendered code mark', () => {
    const doc = 'before `code` after';
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('`code`'), head: doc.indexOf('`code`') + '`code`'.length },
    });

    const ranges = collectLivePreviewRanges(
      defaultLivePreviewRenderers,
      createLivePreviewContext(state, { from: 0, to: doc.length }, true),
    );

    expect(ranges.map((range) => [range.rendererId, doc.slice(range.from, range.to)])).toEqual([
      ['inline-code', 'code'],
    ]);
    expect(state.doc.toString()).toBe(doc);
  });

  it('reveals only the active blockquote line while adjacent public and task ranges stay previewed', () => {
    const doc = ['# Heading', '> quote with `code`', '- [ ] task'].join('\n');
    const selection = { from: doc.indexOf('quote'), to: doc.indexOf('quote') };

    const ranges = collectAllRanges(doc, selection, true);

    expect(ranges.map((range) => range.rendererId)).toEqual([
      'heading',
      'heading',
      'heading',
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
      'task-marker',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).not.toContain('> quote with `code`');
    expect(doc).toBe(['# Heading', '> quote with `code`', '- [ ] task'].join('\n'));
  });

  it('keeps adjacent public ranges previewed while a focused selection reveals a task marker projection', () => {
    const doc = ['# Heading', '- [ ] task', '`code`'].join('\n');
    const markerFrom = doc.indexOf('- [ ]');
    const markerTo = markerFrom + '- [ ]'.length;

    const ranges = collectAllRanges(doc, { from: markerFrom, to: markerTo }, true);

    expect(ranges.map((range) => range.rendererId)).toEqual([
      'heading',
      'heading',
      'heading',
      'inline-code-delimiter',
      'inline-code',
      'inline-code-delimiter',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).not.toContain('- [ ]');
  });

  it('reveals all intersecting mark, replace, line, and widget projections while preserving outside previews', () => {
    const doc = ['# Heading', 'paragraph `code`', '> quoted', '```ts', 'const value = 1;', '```', '- [ ] task'].join(
      '\n',
    );
    const selection = { from: doc.indexOf('code'), to: doc.indexOf('value') };

    const ranges = collectAllRanges(doc, selection, true);

    expect(ranges.map((range) => range.rendererId)).toEqual([
      'heading',
      'heading',
      'heading',
      'inline-code-delimiter',
      'inline-code',
      'task-marker',
    ]);
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(expect.arrayContaining(['`', 'code']));
    expect(ranges.map((range) => range.rendererId)).not.toContain('blockquote');
    expect(ranges.map((range) => range.rendererId)).not.toContain('code-block-widget');
    expect(doc.slice(selection.from, selection.to)).toBe(['code`', '> quoted', '```ts', 'const '].join('\n'));
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
