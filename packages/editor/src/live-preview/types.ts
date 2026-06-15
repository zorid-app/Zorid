import type { EditorState } from '@codemirror/state';

export interface LivePreviewSelectionRange {
  readonly from: number;
  readonly to: number;
}

export interface LivePreviewVisibleRange {
  readonly from: number;
  readonly to: number;
}

export interface LivePreviewContext {
  readonly state: EditorState;
  readonly docText: string;
  readonly visibleFrom: number;
  readonly visibleTo: number;
  readonly focused: boolean;
  readonly selectionRanges: readonly LivePreviewSelectionRange[];
}

export type LivePreviewDecorationKind = 'mark' | 'replace';

export type LivePreviewRevealPolicy = 'caret-or-selection' | 'caret' | 'never';

export interface LivePreviewRange {
  readonly rendererId: string;
  readonly from: number;
  readonly to: number;
  readonly className: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly kind?: LivePreviewDecorationKind;
  readonly activationFrom?: number;
  readonly activationTo?: number;
  readonly revealPolicy?: LivePreviewRevealPolicy;
}

/**
 * Internal, experimental renderer seam for first-party Live Preview marks.
 * Keep this compatible with future match -> activation -> build pipelines;
 * do not treat it as a stable third-party plugin API yet.
 */
export interface LivePreviewRenderer {
  readonly id: string;
  match(context: LivePreviewContext): readonly LivePreviewRange[];
}
