import type { WidgetType } from '@codemirror/view';
import type { InternalLivePreviewRange, InternalLivePreviewRenderer } from './internal-types.js';
import type { LivePreviewContext } from './types.js';

export interface LivePreviewBlockMatch {
  readonly from: number;
  readonly to: number;
  readonly activationFrom?: number;
  readonly activationTo?: number;
  readonly sourceFrom?: number;
  readonly sourceTo?: number;
  readonly clipboardSource?: 'document-source';
  readonly atomic?: 'none';
  readonly className: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface LivePreviewBlockRenderer<Match extends LivePreviewBlockMatch = LivePreviewBlockMatch> {
  readonly id: string;
  match(context: LivePreviewContext): readonly Match[];
  widget(match: Match, context: LivePreviewContext): WidgetType;
}

function livePreviewBlockMatchContract(
  match: LivePreviewBlockMatch,
): Pick<
  InternalLivePreviewRange,
  'activationFrom' | 'activationTo' | 'sourceFrom' | 'sourceTo' | 'clipboardSource' | 'atomic'
> {
  return {
    activationFrom: match.activationFrom ?? match.from,
    activationTo: match.activationTo ?? match.to,
    sourceFrom: match.sourceFrom ?? match.from,
    sourceTo: match.sourceTo ?? match.to,
    clipboardSource: match.clipboardSource ?? 'document-source',
    atomic: match.atomic ?? 'none',
  };
}

// Private first-party adapter for block widgets that should participate in the
// existing internal widget pipeline. This is not a public plugin API: every
// match becomes a widget range and inherits the current positional suppression,
// ordering, scan-window, and dedupe semantics from extension.ts. Its contract
// is intentionally source-first: clipboard text remains the document slice,
// activation defaults to the source range, and widgets do not opt into atomic
// cursor/deletion behavior unless this private adapter is deliberately revised.
export function livePreviewBlockRendererToInternalRenderer<Match extends LivePreviewBlockMatch>(
  renderer: LivePreviewBlockRenderer<Match>,
): InternalLivePreviewRenderer {
  return {
    id: renderer.id,
    match: (context) =>
      renderer.match(context).map((match): InternalLivePreviewRange => {
        const contract = livePreviewBlockMatchContract(match);
        const range: InternalLivePreviewRange = {
          rendererId: renderer.id,
          from: match.from,
          to: match.to,
          ...contract,
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
