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

export type LivePreviewErrorReporter = (
  error: unknown,
  context: { readonly rendererId: string; readonly phase: 'match' | 'decorations' },
) => void;

export interface LivePreviewActionHandlers {
  openReference?(target: { readonly path: string; readonly fragment?: string }): void;
}

export function livePreviewSelectionRanges(state: LivePreviewContext['state']): LivePreviewSelectionRange[] {
  return state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
}

function livePreviewActivationRange(
  range: Pick<LivePreviewRange, 'from' | 'to' | 'activationFrom' | 'activationTo' | 'revealPolicy'>,
): Pick<LivePreviewRange, 'from' | 'to'> {
  return {
    from: range.activationFrom ?? range.from,
    to: range.activationTo ?? range.to,
  };
}

export function livePreviewRangeIntersectsSelection(
  range: Pick<LivePreviewRange, 'from' | 'to' | 'activationFrom' | 'activationTo' | 'revealPolicy'>,
  selectionRanges: readonly LivePreviewSelectionRange[],
): boolean {
  if (range.revealPolicy === 'never') return false;
  const activationRange = livePreviewActivationRange(range);
  return selectionRanges.some((selection) => {
    if (selection.from === selection.to)
      return selection.from >= activationRange.from && selection.from <= activationRange.to;
    if (range.revealPolicy === 'caret') return false;
    return selection.from < activationRange.to && selection.to > activationRange.from;
  });
}

export function shouldRenderLivePreviewRange(
  range: Pick<LivePreviewRange, 'from' | 'to' | 'activationFrom' | 'activationTo' | 'revealPolicy'>,
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

function safeLivePreviewRendererMatch<T>(
  renderer: { readonly id: string; match(context: LivePreviewContext): readonly T[] },
  context: LivePreviewContext,
  reportError?: LivePreviewErrorReporter,
): readonly T[] {
  try {
    return renderer.match(context);
  } catch (error) {
    reportError?.(error, { rendererId: renderer.id, phase: 'match' });
    return [];
  }
}

export function collectLivePreviewRanges(
  renderers: readonly LivePreviewRenderer[],
  context: LivePreviewContext,
  reportError?: LivePreviewErrorReporter,
): LivePreviewRange[] {
  return filterLivePreviewRanges(
    renderers.flatMap((renderer) => safeLivePreviewRendererMatch(renderer, context, reportError)),
    context,
  );
}

function collectInternalLivePreviewRanges(
  renderers: readonly InternalLivePreviewRenderer[],
  context: LivePreviewContext,
  reportError?: LivePreviewErrorReporter,
): InternalLivePreviewRange[] {
  return filterLivePreviewRanges(
    renderers.flatMap((renderer) => safeLivePreviewRendererMatch(renderer, context, reportError)) as LivePreviewRange[],
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

function livePreviewWidgetOwnershipKey(
  range: Pick<InternalLivePreviewRange, 'from' | 'to' | 'sourceFrom' | 'sourceTo'>,
): string {
  return `${range.sourceFrom ?? range.from}:${range.sourceTo ?? range.to}`;
}

function resolveLivePreviewWidgetOwnership(ranges: readonly InternalLivePreviewRange[]): InternalLivePreviewRange[] {
  const winners = new Map<string, InternalLivePreviewRange>();
  for (const range of ranges) {
    const key = livePreviewWidgetOwnershipKey(range);
    const winner = winners.get(key);
    if (!winner || (range.priority ?? 0) > (winner.priority ?? 0)) {
      winners.set(key, range);
    }
  }
  return [...winners.values()];
}

export function collectLivePreviewWidgetRangesForVisibleRanges(
  renderers: readonly InternalLivePreviewRenderer[],
  state: LivePreviewContext['state'],
  visibleRanges: readonly LivePreviewVisibleRange[],
  focused: boolean,
  reportError?: LivePreviewErrorReporter,
): InternalLivePreviewRange[] {
  const docText = state.doc.toString();
  const ranges = visibleRanges.flatMap((visibleRange) =>
    collectInternalLivePreviewRanges(
      renderers,
      createLivePreviewContext(state, livePreviewWidgetScanWindow(docText, visibleRange), focused),
      reportError,
    ),
  );
  const deduped = [...new Map(ranges.map((range) => [livePreviewRangeDedupeKey(range), range])).values()];
  return resolveLivePreviewWidgetOwnership(deduped);
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
  reportError?: LivePreviewErrorReporter,
): InternalLivePreviewRange[] {
  const widgetRanges = collectLivePreviewWidgetRangesForVisibleRanges(
    widgetRenderers,
    state,
    visibleRanges,
    focused,
    reportError,
  ).filter(isLivePreviewWidgetRange);
  const publicRanges = visibleRanges.flatMap((visibleRange) =>
    collectLivePreviewRanges(renderers, createLivePreviewContext(state, visibleRange, focused), reportError),
  );
  const docText = state.doc.toString();
  const internalRanges = visibleRanges.flatMap((visibleRange) =>
    collectInternalLivePreviewRanges(
      internalRenderers,
      createLivePreviewContext(state, livePreviewLineScanWindow(docText, visibleRange), focused),
      reportError,
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
  reportError?: LivePreviewErrorReporter,
): DecorationSet {
  const ranges: InternalLivePreviewRange[] = collectLivePreviewRangesWithWidgetSuppression(
    renderers,
    internalRenderers,
    widgetRenderers,
    view.state,
    view.visibleRanges,
    view.hasFocus,
    reportError,
  );
  try {
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
  } catch (error) {
    reportError?.(error, { rendererId: 'live-preview', phase: 'decorations' });
    return Decoration.none;
  }
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
  reportError?: LivePreviewErrorReporter,
): DecorationSet {
  const ranges = collectLivePreviewWidgetRangesForVisibleRanges(renderers, state, visibleRanges, focused, reportError);

  try {
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
  } catch (error) {
    reportError?.(error, { rendererId: 'live-preview-widget', phase: 'decorations' });
    return Decoration.none;
  }
}

function defaultLivePreviewWidgetVisibleRanges(state: LivePreviewContext['state']): readonly LivePreviewVisibleRange[] {
  return [{ from: 0, to: Math.min(state.doc.length, livePreviewWidgetScanMargin) }];
}

function livePreviewReferenceTarget(element: Element): { readonly path: string; readonly fragment?: string } | null {
  const reference = element.closest('[data-live-preview-reference]');
  if (!reference) return null;
  const path = reference.getAttribute('data-live-preview-reference');
  if (!path) return null;
  const fragment = reference.getAttribute('data-live-preview-reference-fragment') ?? undefined;
  return fragment ? { path, fragment } : { path };
}

function livePreviewUrlTarget(element: Element): { readonly path: string } | null {
  const link = element.closest('[data-live-preview-url]');
  const url = link?.getAttribute('data-live-preview-url');
  return url ? { path: url } : null;
}

function livePreviewVisibleRangeKey(ranges: readonly LivePreviewVisibleRange[]): string {
  return ranges.map((range) => `${range.from}:${range.to}`).join('|');
}

function livePreviewWidgetField(
  renderers: readonly InternalLivePreviewRenderer[],
  reportError?: LivePreviewErrorReporter,
): Extension {
  return StateField.define<LivePreviewWidgetState>({
    create: (state) => {
      const focused = false;
      const visibleRanges = defaultLivePreviewWidgetVisibleRanges(state);
      return {
        focused,
        visibleRanges,
        decorations: livePreviewWidgetDecorationsForState(state, renderers, focused, visibleRanges, reportError),
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
        decorations: livePreviewWidgetDecorationsForState(
          transaction.state,
          renderers,
          focused,
          visibleRanges,
          reportError,
        ),
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

export function livePreviewExtensionWithInternalRenderers(
  renderers: readonly LivePreviewRenderer[],
  internalRenderers: readonly InternalLivePreviewRenderer[],
  widgetRenderers: readonly InternalLivePreviewRenderer[],
  reportError?: LivePreviewErrorReporter,
  handlers: LivePreviewActionHandlers = {},
): Extension {
  return [
    livePreviewWidgetField(widgetRenderers, reportError),
    livePreviewWidgetVisibleRangeUpdater(),
    EditorView.focusChangeEffect.of((_state, focusing) => setInternalLivePreviewFocused.of(focusing)),
    EditorView.domEventHandlers({
      mousedown(event) {
        if (event.button !== 0) return false;
        if (!(event.target instanceof Element)) return false;
        const target = livePreviewUrlTarget(event.target) ?? livePreviewReferenceTarget(event.target);
        if (!target) return false;
        event.preventDefault();
        handlers.openReference?.(target);
        return true;
      },
    }),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = livePreviewDecorationsForView(
            view,
            renderers,
            internalRenderers,
            widgetRenderers,
            reportError,
          );
        }

        update(update: ViewUpdate): void {
          if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) {
            this.decorations = livePreviewDecorationsForView(
              update.view,
              renderers,
              internalRenderers,
              widgetRenderers,
              reportError,
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
