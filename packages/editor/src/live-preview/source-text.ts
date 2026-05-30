import type { EditorState } from '@codemirror/state';

export interface LivePreviewSourceRange {
  readonly from: number;
  readonly to: number;
}

export function livePreviewSourceTextForRange(state: EditorState, range: LivePreviewSourceRange): string {
  const from = Math.max(0, Math.min(range.from, state.doc.length));
  const to = Math.max(from, Math.min(range.to, state.doc.length));
  return state.doc.sliceString(from, to);
}
