import type { LivePreviewDecorationKind, LivePreviewRange, LivePreviewRenderer } from './types.js';

export type InternalLivePreviewDecorationKind = LivePreviewDecorationKind | 'line';

export type InternalLivePreviewRange = Omit<LivePreviewRange, 'kind'> & {
  readonly kind?: InternalLivePreviewDecorationKind;
};

export interface InternalLivePreviewRenderer extends Omit<LivePreviewRenderer, 'match'> {
  match(...parameters: Parameters<LivePreviewRenderer['match']>): readonly InternalLivePreviewRange[];
}

export function isLivePreviewLineRange(
  range: InternalLivePreviewRange,
): range is InternalLivePreviewRange & { readonly kind: 'line' } {
  return range.kind === 'line';
}
