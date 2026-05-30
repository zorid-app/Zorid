import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import {
  type InternalLivePreviewRange,
  type InternalLivePreviewRenderer,
  isLivePreviewLineRange,
  isLivePreviewWidgetRange,
  setInternalLivePreviewFocused,
} from './internal-types.js';
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

function collectInternalLivePreviewRanges(
  renderers: readonly InternalLivePreviewRenderer[],
  context: LivePreviewContext,
): InternalLivePreviewRange[] {
  return filterLivePreviewRanges(
    renderers.flatMap((renderer) => renderer.match(context)) as LivePreviewRange[],
    context,
  ) as InternalLivePreviewRange[];
}

const livePreviewWidgetScanMargin = 2000;
const setLivePreviewWidgetVisibleRanges = StateEffect.define<readonly LivePreviewVisibleRange[]>();

function lineStartBefore(docText: string, position: number): number {
  return docText.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
}

function lineEndAfter(docText: string, position: number): number {
  const lineEnd = docText.indexOf('\n', position);
  return lineEnd === -1 ? docText.length : lineEnd;
}

function livePreviewLineScanWindow(docText: string, visibleRange: LivePreviewVisibleRange): LivePreviewVisibleRange {
  return {
    from: lineStartBefore(docText, visibleRange.from),
    to: lineEndAfter(docText, visibleRange.to),
  };
}

function livePreviewWidgetScanWindow(docText: string, visibleRange: LivePreviewVisibleRange): LivePreviewVisibleRange {
  const boundedFrom = Math.max(0, visibleRange.from - livePreviewWidgetScanMargin);
  const boundedTo = Math.min(docText.length, visibleRange.to + livePreviewWidgetScanMargin);
  return {
    from: lineStartBefore(docText, boundedFrom),
    to: lineEndAfter(docText, boundedTo),
  };
}

function livePreviewRangeDedupeKey(range: Pick<LivePreviewRange, 'rendererId' | 'from' | 'to'>): string {
  return `${range.rendererId}:${range.from}:${range.to}`;
}

export function collectLivePreviewWidgetRangesForVisibleRanges(
  renderers: readonly InternalLivePreviewRenderer[],
  state: LivePreviewContext['state'],
  visibleRanges: readonly LivePreviewVisibleRange[],
  focused: boolean,
): InternalLivePreviewRange[] {
  const docText = state.doc.toString();
  const ranges = visibleRanges.flatMap((visibleRange) =>
    collectInternalLivePreviewRanges(
      renderers,
      createLivePreviewContext(state, livePreviewWidgetScanWindow(docText, visibleRange), focused),
    ),
  );
  return [...new Map(ranges.map((range) => [livePreviewRangeDedupeKey(range), range])).values()];
}

function livePreviewRangeIsInsideAnyWidget(
  range: Pick<LivePreviewRange, 'from' | 'to'>,
  widgets: readonly InternalLivePreviewRange[],
): boolean {
  return widgets.some((widget) => range.from >= widget.from && range.to <= widget.to);
}

export function collectLivePreviewRangesWithWidgetSuppression(
  renderers: readonly LivePreviewRenderer[],
  internalRenderers: readonly InternalLivePreviewRenderer[],
  widgetRenderers: readonly InternalLivePreviewRenderer[],
  state: LivePreviewContext['state'],
  visibleRanges: readonly LivePreviewVisibleRange[],
  focused: boolean,
): InternalLivePreviewRange[] {
  const widgetRanges = collectLivePreviewWidgetRangesForVisibleRanges(
    widgetRenderers,
    state,
    visibleRanges,
    focused,
  ).filter(isLivePreviewWidgetRange);
  const publicRanges = visibleRanges.flatMap((visibleRange) =>
    collectLivePreviewRanges(renderers, createLivePreviewContext(state, visibleRange, focused)),
  );
  const docText = state.doc.toString();
  const internalRanges = visibleRanges.flatMap((visibleRange) =>
    collectInternalLivePreviewRanges(
      internalRenderers,
      createLivePreviewContext(state, livePreviewLineScanWindow(docText, visibleRange), focused),
    ),
  );

  return [
    ...widgetRanges,
    ...[...publicRanges, ...internalRanges].filter((range) => !livePreviewRangeIsInsideAnyWidget(range, widgetRanges)),
  ].sort(
    (left, right) => left.from - right.from || left.to - right.to || left.rendererId.localeCompare(right.rendererId),
  );
}

function livePreviewDecorationsForView(
  view: EditorView,
  renderers: readonly LivePreviewRenderer[],
  internalRenderers: readonly InternalLivePreviewRenderer[],
  widgetRenderers: readonly InternalLivePreviewRenderer[],
): DecorationSet {
  const ranges: InternalLivePreviewRange[] = collectLivePreviewRangesWithWidgetSuppression(
    renderers,
    internalRenderers,
    widgetRenderers,
    view.state,
    view.visibleRanges,
    view.hasFocus,
  );
  return Decoration.set(
    ranges.flatMap((range) => {
      if (isLivePreviewWidgetRange(range)) return [];
      if (isLivePreviewLineRange(range)) {
        return [
          Decoration.line({
            class: range.className,
            attributes: {
              'data-live-preview-renderer': range.rendererId,
              ...range.attributes,
            },
          }).range(range.from),
        ];
      }

      if (range.kind === 'replace') {
        return [
          (range.widget ? Decoration.replace({ widget: range.widget }) : Decoration.replace({})).range(
            range.from,
            range.to,
          ),
        ];
      }

      return [
        Decoration.mark({
          class: range.className,
          attributes: {
            'data-live-preview-renderer': range.rendererId,
            ...range.attributes,
          },
        }).range(range.from, range.to),
      ];
    }),
    true,
  );
}

interface LivePreviewWidgetState {
  readonly focused: boolean;
  readonly visibleRanges: readonly LivePreviewVisibleRange[];
  readonly decorations: DecorationSet;
}

function livePreviewWidgetDecorationsForState(
  state: LivePreviewContext['state'],
  renderers: readonly InternalLivePreviewRenderer[],
  focused: boolean,
  visibleRanges: readonly LivePreviewVisibleRange[],
): DecorationSet {
  const ranges = collectLivePreviewWidgetRangesForVisibleRanges(renderers, state, visibleRanges, focused);

  return Decoration.set(
    ranges.flatMap((range) => {
      if (!isLivePreviewWidgetRange(range)) return [];
      return [
        Decoration.replace({
          block: true,
          widget: range.widget,
        }).range(range.from, range.to),
      ];
    }),
    true,
  );
}

function defaultLivePreviewWidgetVisibleRanges(state: LivePreviewContext['state']): readonly LivePreviewVisibleRange[] {
  return [{ from: 0, to: state.doc.length }];
}

function livePreviewVisibleRangeKey(ranges: readonly LivePreviewVisibleRange[]): string {
  return ranges.map((range) => `${range.from}:${range.to}`).join('|');
}

function livePreviewWidgetField(renderers: readonly InternalLivePreviewRenderer[]): Extension {
  return StateField.define<LivePreviewWidgetState>({
    create: (state) => {
      const focused = false;
      const visibleRanges = defaultLivePreviewWidgetVisibleRanges(state);
      return {
        focused,
        visibleRanges,
        decorations: livePreviewWidgetDecorationsForState(state, renderers, focused, visibleRanges),
      };
    },
    update: (value, transaction) => {
      const focusedFromEffect = transaction.effects.reduce<boolean | null>(
        (current, effect) => (effect.is(setInternalLivePreviewFocused) ? effect.value : current),
        null,
      );
      const visibleRangesFromEffect = transaction.effects.reduce<readonly LivePreviewVisibleRange[] | null>(
        (current, effect) => (effect.is(setLivePreviewWidgetVisibleRanges) ? effect.value : current),
        null,
      );
      const focused = focusedFromEffect ?? value.focused;
      const visibleRanges = visibleRangesFromEffect ?? value.visibleRanges;
      if (
        !transaction.docChanged &&
        !transaction.selection &&
        focused === value.focused &&
        visibleRanges === value.visibleRanges
      )
        return value;
      return {
        focused,
        visibleRanges,
        decorations: livePreviewWidgetDecorationsForState(transaction.state, renderers, focused, visibleRanges),
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}

function livePreviewWidgetVisibleRangeUpdater(): Extension {
  return ViewPlugin.fromClass(
    class {
      private queued = false;
      private rangeKey = '';
      private pendingRanges: readonly LivePreviewVisibleRange[] | null = null;

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (!update.viewportChanged && !update.docChanged) return;
        this.schedule(update.view.visibleRanges);
      }

      private schedule(visibleRanges: readonly LivePreviewVisibleRange[]): void {
        const nextRanges = visibleRanges.map((range) => ({ from: range.from, to: range.to }));
        const nextKey = livePreviewVisibleRangeKey(nextRanges);
        if (nextKey === this.rangeKey) return;
        this.rangeKey = nextKey;
        this.pendingRanges = nextRanges;
        if (this.queued) return;

        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          const ranges = this.pendingRanges;
          this.pendingRanges = null;
          if (!ranges) return;
          this.view.dispatch({
            effects: setLivePreviewWidgetVisibleRanges.of(ranges),
          });
        });
      }
    },
  );
}

export function livePreviewExtension(renderers: readonly LivePreviewRenderer[]): Extension {
  return livePreviewExtensionWithInternalRenderers(renderers, [], []);
}

export function livePreviewExtensionWithWidgets(
  renderers: readonly LivePreviewRenderer[],
  widgetRenderers: readonly InternalLivePreviewRenderer[],
): Extension {
  return livePreviewExtensionWithInternalRenderers(renderers, [], widgetRenderers);
}

export function livePreviewExtensionWithInternalRenderers(
  renderers: readonly LivePreviewRenderer[],
  internalRenderers: readonly InternalLivePreviewRenderer[],
  widgetRenderers: readonly InternalLivePreviewRenderer[],
): Extension {
  return [
    livePreviewWidgetField(widgetRenderers),
    livePreviewWidgetVisibleRangeUpdater(),
    EditorView.focusChangeEffect.of((_state, focusing) => setInternalLivePreviewFocused.of(focusing)),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = livePreviewDecorationsForView(view, renderers, internalRenderers, widgetRenderers);
        }

        update(update: ViewUpdate): void {
          if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) {
            this.decorations = livePreviewDecorationsForView(
              update.view,
              renderers,
              internalRenderers,
              widgetRenderers,
            );
          }
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
      },
    ),
  ];
}
