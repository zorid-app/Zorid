import type { EditorState } from '@codemirror/state';

export interface RenderRange { from: number; to: number }
export interface RenderExclusionOptions {
  /** Whole-block owners must precede consumers in the editor extensions. */
  excludes?: (state: EditorState) => readonly RenderRange[];
}
const empty: readonly RenderRange[] = [];
const cache = new WeakMap<EditorState, Map<NonNullable<RenderExclusionOptions['excludes']>, readonly RenderRange[]>>();

/** Normalize once per transaction for all decorations sharing an owner. */
export function renderExclusions(state: EditorState, read: RenderExclusionOptions['excludes']): readonly RenderRange[] {
  if (!read) return empty;
  let entries = cache.get(state);
  if (!entries) { entries = new Map(); cache.set(state, entries); }
  const prior = entries.get(read); if (prior) return prior;
  const result: RenderRange[] = [];
  const sorted = read(state).filter(range => Number.isFinite(range.from) && Number.isFinite(range.to) && range.from < range.to)
    .map(range => ({from: Math.max(0, range.from), to: Math.min(state.doc.length, range.to)}))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else if (range.from < range.to) result.push(range);
  }
  entries.set(read, result); return result;
}
export function sameRenderExclusions(a: readonly RenderRange[], b: readonly RenderRange[]): boolean {
  return a === b || a.length === b.length && a.every((range, index) => range.from === b[index].from && range.to === b[index].to);
}
export function intersectsRenderExclusion(ranges: readonly RenderRange[], from: number, to: number): boolean {
  let low = 0, high = ranges.length;
  while (low < high) { const middle = (low + high) >>> 1; if (ranges[middle].to <= from) low = middle + 1; else high = middle; }
  return low < ranges.length && ranges[low].from < to;
}

export function containsRenderExclusion(ranges: readonly RenderRange[], from: number, to: number): boolean {
  let low = 0, high = ranges.length;
  while (low < high) { const middle = (low + high) >>> 1; if (ranges[middle].to <= from) low = middle + 1; else high = middle; }
  return low < ranges.length && ranges[low].from <= from && ranges[low].to >= to;
}
