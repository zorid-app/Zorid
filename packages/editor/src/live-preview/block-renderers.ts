import type { WidgetType } from '@codemirror/view';
import type { InternalLivePreviewRange, InternalLivePreviewRenderer } from './internal-types.js';
import type { LivePreviewContext } from './types.js';

export interface LivePreviewBlockMatch {
  readonly from: number;
  readonly to: number;
  readonly activationFrom?: number;
  readonly activationTo?: number;
  readonly className: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface LivePreviewBlockRenderer<Match extends LivePreviewBlockMatch = LivePreviewBlockMatch> {
  readonly id: string;
  match(context: LivePreviewContext): readonly Match[];
  widget(match: Match, context: LivePreviewContext): WidgetType;
}

// Private first-party adapter for block widgets that should participate in the
// existing internal widget pipeline. This is not a public plugin API: every
// match becomes a widget range and inherits the current positional suppression,
// ordering, scan-window, and dedupe semantics from extension.ts.
export function livePreviewBlockRendererToInternalRenderer<Match extends LivePreviewBlockMatch>(
  renderer: LivePreviewBlockRenderer<Match>,
): InternalLivePreviewRenderer {
  return {
    id: renderer.id,
    match: (context) =>
      renderer.match(context).map((match): InternalLivePreviewRange => {
        const range: InternalLivePreviewRange = {
          rendererId: renderer.id,
          from: match.from,
          to: match.to,
          activationFrom: match.activationFrom ?? match.from,
          activationTo: match.activationTo ?? match.to,
          className: match.className,
          kind: 'widget',
          widget: renderer.widget(match, context),
        };

        return match.attributes ? { ...range, attributes: match.attributes } : range;
      }),
  };
}

export function livePreviewBlockRenderersToInternalRenderers(
  renderers: readonly LivePreviewBlockRenderer[],
): InternalLivePreviewRenderer[] {
  return renderers.map((renderer) => livePreviewBlockRendererToInternalRenderer(renderer));
}
