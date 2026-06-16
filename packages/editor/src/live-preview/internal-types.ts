import { StateEffect } from '@codemirror/state';
import type { WidgetType } from '@codemirror/view';
import type { LivePreviewDecorationKind, LivePreviewRange, LivePreviewRenderer } from './types.js';

export type InternalLivePreviewDecorationKind =
  | LivePreviewDecorationKind
  | 'line'
  | 'hidden-line'
  | 'widget'
  | 'insert';

export type InternalLivePreviewRange = Omit<LivePreviewRange, 'kind'> & {
  readonly kind?: InternalLivePreviewDecorationKind;
  readonly widget?: WidgetType;
  readonly sourceFrom?: number;
  readonly sourceTo?: number;
  readonly clipboardSource?: 'document-source';
  readonly atomic?: 'none' | 'widget';
  readonly priority?: number;
};

export interface InternalLivePreviewRenderer extends Omit<LivePreviewRenderer, 'match'> {
  match(...parameters: Parameters<LivePreviewRenderer['match']>): readonly InternalLivePreviewRange[];
}

export function isLivePreviewLineRange(
  range: InternalLivePreviewRange,
): range is InternalLivePreviewRange & { readonly kind: 'line' } {
  return range.kind === 'line';
}

export function isLivePreviewHiddenLineRange(
  range: InternalLivePreviewRange,
): range is InternalLivePreviewRange & { readonly kind: 'hidden-line' } {
  return range.kind === 'hidden-line';
}

export function isLivePreviewWidgetRange(
  range: InternalLivePreviewRange,
): range is InternalLivePreviewRange & { readonly kind: 'widget'; readonly widget: WidgetType } {
  return range.kind === 'widget' && Boolean(range.widget);
}

export const setInternalLivePreviewFocused = StateEffect.define<boolean>();
