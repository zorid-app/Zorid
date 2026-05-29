import type { Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type {
  LivePreviewContext,
  LivePreviewRange,
  LivePreviewRenderer,
  LivePreviewSelectionRange,
  LivePreviewVisibleRange,
} from './types.js';

export function livePreviewSelectionRanges(state: LivePreviewContext['state']): LivePreviewSelectionRange[] {
  return state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
}

function livePreviewActivationRange(
  range: Pick<LivePreviewRange, 'from' | 'to' | 'activationFrom' | 'activationTo'>,
): Pick<LivePreviewRange, 'from' | 'to'> {
  return {
    from: range.activationFrom ?? range.from,
    to: range.activationTo ?? range.to,
  };
}

export function livePreviewRangeIntersectsSelection(
  range: Pick<LivePreviewRange, 'from' | 'to' | 'activationFrom' | 'activationTo'>,
  selectionRanges: readonly LivePreviewSelectionRange[],
): boolean {
  const activationRange = livePreviewActivationRange(range);
  return selectionRanges.some((selection) => {
    if (selection.from === selection.to)
      return selection.from >= activationRange.from && selection.from <= activationRange.to;
    return selection.from < activationRange.to && selection.to > activationRange.from;
  });
}

export function shouldRenderLivePreviewRange(
  range: Pick<LivePreviewRange, 'from' | 'to' | 'activationFrom' | 'activationTo'>,
  context: Pick<LivePreviewContext, 'focused' | 'selectionRanges'>,
): boolean {
  return !context.focused || !livePreviewRangeIntersectsSelection(range, context.selectionRanges);
}

export function filterLivePreviewRanges(
  ranges: readonly LivePreviewRange[],
  context: Pick<LivePreviewContext, 'visibleFrom' | 'visibleTo' | 'focused' | 'selectionRanges'>,
): LivePreviewRange[] {
  return ranges
    .filter((range) => range.from < context.visibleTo && range.to > context.visibleFrom)
    .filter((range) => shouldRenderLivePreviewRange(range, context))
    .sort(
      (left, right) => left.from - right.from || left.to - right.to || left.rendererId.localeCompare(right.rendererId),
    );
}

export function createLivePreviewContext(
  state: LivePreviewContext['state'],
  visibleRange: LivePreviewVisibleRange,
  focused = false,
): LivePreviewContext {
  return {
    state,
    docText: state.doc.toString(),
    visibleFrom: visibleRange.from,
    visibleTo: visibleRange.to,
    focused,
    selectionRanges: livePreviewSelectionRanges(state),
  };
}

export function collectLivePreviewRanges(
  renderers: readonly LivePreviewRenderer[],
  context: LivePreviewContext,
): LivePreviewRange[] {
  return filterLivePreviewRanges(
    renderers.flatMap((renderer) => renderer.match(context)),
    context,
  );
}

function livePreviewDecorationsForView(view: EditorView, renderers: readonly LivePreviewRenderer[]): DecorationSet {
  const ranges = view.visibleRanges.flatMap((visibleRange) =>
    collectLivePreviewRanges(renderers, createLivePreviewContext(view.state, visibleRange, view.hasFocus)),
  );
  return Decoration.set(
    ranges.map((range) => {
      if (range.kind === 'replace') {
        return Decoration.replace({}).range(range.from, range.to);
      }

      return Decoration.mark({
        class: range.className,
        attributes: {
          'data-live-preview-renderer': range.rendererId,
          ...range.attributes,
        },
      }).range(range.from, range.to);
    }),
    true,
  );
}

export function livePreviewExtension(renderers: readonly LivePreviewRenderer[]): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = livePreviewDecorationsForView(view, renderers);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) {
          this.decorations = livePreviewDecorationsForView(update.view, renderers);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}
