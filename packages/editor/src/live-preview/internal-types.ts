import type { WidgetType } from '@codemirror/view';
import type { LivePreviewDecorationKind, LivePreviewRange, LivePreviewRenderer } from './types.js';

export type InternalLivePreviewDecorationKind = LivePreviewDecorationKind | 'line' | 'widget';

export type InternalLivePreviewRange = Omit<LivePreviewRange, 'kind'> & {
  readonly kind?: InternalLivePreviewDecorationKind;
  readonly widget?: WidgetType;
};

export interface InternalLivePreviewRenderer extends Omit<LivePreviewRenderer, 'match'> {
  match(...parameters: Parameters<LivePreviewRenderer['match']>): readonly InternalLivePreviewRange[];
}

export function isLivePreviewLineRange(
  range: InternalLivePreviewRange,
): range is InternalLivePreviewRange & { readonly kind: 'line' } {
  return range.kind === 'line';
}

export function isLivePreviewWidgetRange(
  range: InternalLivePreviewRange,
): range is InternalLivePreviewRange & { readonly kind: 'widget'; readonly widget: WidgetType } {
  return range.kind === 'widget' && Boolean(range.widget);
}
