import type { EditorState } from '@codemirror/state';

export interface LivePreviewSourceRange {
  readonly from: number;
  readonly to: number;
}

export interface LivePreviewCollapsedSourceProjection {
  readonly source: LivePreviewSourceRange;
  readonly title: LivePreviewSourceRange;
  readonly hidden: readonly LivePreviewSourceRange[];
}

export interface LivePreviewCollapsedSourceCut {
  readonly from: number;
  readonly to: number;
  readonly insert: '';
  readonly text: string;
}

function normalizeLivePreviewSourceRange(range: LivePreviewSourceRange): LivePreviewSourceRange {
  return range.from <= range.to ? range : { from: range.to, to: range.from };
}

function livePreviewSourceRangeIntersects(left: LivePreviewSourceRange, right: LivePreviewSourceRange): boolean {
  return left.from < right.to && left.to > right.from;
}

function livePreviewSourceRangeContains(outer: LivePreviewSourceRange, inner: LivePreviewSourceRange): boolean {
  return outer.from <= inner.from && outer.to >= inner.to;
}

export function livePreviewSourceTextForRange(state: EditorState, range: LivePreviewSourceRange): string {
  const from = Math.max(0, Math.min(range.from, state.doc.length));
  const to = Math.max(from, Math.min(range.to, state.doc.length));
  return state.doc.sliceString(from, to);
}

export function livePreviewSourceRangeForCollapsedSelection(
  projection: LivePreviewCollapsedSourceProjection,
  selection: LivePreviewSourceRange,
): LivePreviewSourceRange | null {
  const source = normalizeLivePreviewSourceRange(projection.source);
  const title = normalizeLivePreviewSourceRange(projection.title);
  const selected = normalizeLivePreviewSourceRange(selection);
  if (selected.from === selected.to || !livePreviewSourceRangeIntersects(selected, source)) return null;

  const touchesHiddenSource = projection.hidden
    .map((range) => normalizeLivePreviewSourceRange(range))
    .some((range) => livePreviewSourceRangeIntersects(selected, range));
  if (touchesHiddenSource || livePreviewSourceRangeContains(selected, source)) return source;

  const from = Math.max(selected.from, title.from);
  const to = Math.min(selected.to, title.to);
  return from < to ? { from, to } : null;
}

export function livePreviewSourceTextForCollapsedSelection(
  state: EditorState,
  projection: LivePreviewCollapsedSourceProjection,
  selection: LivePreviewSourceRange,
): string | null {
  const range = livePreviewSourceRangeForCollapsedSelection(projection, selection);
  return range ? livePreviewSourceTextForRange(state, range) : null;
}

export function livePreviewCutForCollapsedSelection(
  state: EditorState,
  projection: LivePreviewCollapsedSourceProjection,
  selection: LivePreviewSourceRange,
): LivePreviewCollapsedSourceCut | null {
  const range = livePreviewSourceRangeForCollapsedSelection(projection, selection);
  if (!range) return null;
  return { ...range, insert: '', text: livePreviewSourceTextForRange(state, range) };
}
