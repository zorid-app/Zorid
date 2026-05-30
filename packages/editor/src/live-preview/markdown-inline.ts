import { Transaction, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, type KeyBinding, keymap, WidgetType } from '@codemirror/view';
import type { InternalLivePreviewRange, InternalLivePreviewRenderer } from './internal-types.js';
import { markdownSuppressedCodeRanges } from './markdown-code-context.js';
import { taskMarkerRangesForState, type TaskMarkerRange } from './task-marker-ranges.js';
import type { LivePreviewContext } from './types.js';

export interface SourceRange {
  readonly from: number;
  readonly to: number;
}

export interface SourceSelection extends SourceRange {
  readonly anchor?: number;
  readonly head?: number;
}

export type EditorProjectionAction =
  | { readonly kind: 'dispatch'; readonly transaction: TransactionSpec }
  | { readonly kind: 'reveal-source'; readonly range?: SourceRange }
  | { readonly kind: 'set-selection'; readonly selection: SourceSelection }
  | { readonly kind: 'open-reference'; readonly path: string; readonly fragment?: string }
  | { readonly kind: 'set-ephemeral-state'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'none' };

export type EditorClipboardResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'html'; readonly html: string; readonly text?: string }
  | { readonly kind: 'delegate' };

export type InlineSelectionPolicy =
  | { readonly kind: 'source' }
  | { readonly kind: 'content'; readonly range: SourceRange }
  | { readonly kind: 'token' }
  | { readonly kind: 'custom' };

export type InlineRenderResult =
  | { readonly kind: 'mark'; readonly className: string; readonly attributes?: Readonly<Record<string, string>> }
  | { readonly kind: 'replace'; readonly widget?: WidgetType | HTMLElement }
  | { readonly kind: 'widget'; readonly widget: WidgetType | HTMLElement }
  | { readonly kind: 'none' };

export type MarkdownInlineSyntax =
  | { readonly kind: 'task-marker'; readonly states?: readonly string[] }
  | { readonly kind: 'custom' };

export interface MarkdownInlineMatch {
  readonly id: string;
  readonly type: string;
  readonly from: number;
  readonly to: number;
  readonly activationFrom: number;
  readonly activationTo: number;
  readonly sourceFrom: number;
  readonly sourceTo: number;
  readonly sourceText: string;
  readonly className?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly atomic?: 'none' | 'inline';
  readonly selectionPolicy?: InlineSelectionPolicy;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface MarkdownInlineMatchContext extends LivePreviewContext {}

export interface MarkdownInlineRenderContext extends LivePreviewContext {
  sourceText(match: Pick<MarkdownInlineMatch, 'sourceFrom' | 'sourceTo'>): string;
}

export interface MarkdownInlineInteractionContext extends MarkdownInlineRenderContext {
  readonly view: EditorView;
}

export interface EditorProjectionActionHandlers {
  openReference?(target: { readonly path: string; readonly fragment?: string }): void;
  setEphemeralState?(entry: { readonly key: string; readonly value: unknown }): void;
}

export interface MarkdownProjectionClipboardEvent {
  readonly nativeEvent: ClipboardEvent;
  readonly selection: SourceRange;
}

export type InlineCutResult =
  | EditorClipboardResult
  | { readonly clipboard: EditorClipboardResult; readonly action?: EditorProjectionAction };

export interface MarkdownInlineRegistration<Match extends MarkdownInlineMatch = MarkdownInlineMatch> {
  readonly id: string;
  readonly priority?: number;
  readonly syntax?: readonly MarkdownInlineSyntax[];
  match?(context: MarkdownInlineMatchContext): readonly Match[];
  render(match: Match, context: MarkdownInlineRenderContext): InlineRenderResult;
  onActivate?(event: Event, match: Match, context: MarkdownInlineInteractionContext): EditorProjectionAction;
  onSelect?(event: Event, match: Match, context: MarkdownInlineInteractionContext): EditorProjectionAction;
  onCopy?(event: MarkdownProjectionClipboardEvent, match: Match, context: MarkdownInlineInteractionContext): EditorClipboardResult;
  onCut?(event: MarkdownProjectionClipboardEvent, match: Match, context: MarkdownInlineInteractionContext): InlineCutResult;
  onPaste?(event: ClipboardEvent, match: Match, context: MarkdownInlineInteractionContext): EditorProjectionAction;
  extensions?(): readonly Extension[];
  keybindings?(): readonly KeyBinding[];
}

function inlineSourceText(context: LivePreviewContext, match: Pick<MarkdownInlineMatch, 'sourceFrom' | 'sourceTo'>): string {
  return context.docText.slice(match.sourceFrom, match.sourceTo);
}

function renderContext(context: LivePreviewContext): MarkdownInlineRenderContext {
  return { ...context, sourceText: (match) => inlineSourceText(context, match) };
}

function allDocumentContext(view: EditorView): MarkdownInlineInteractionContext {
  const docText = view.state.doc.toString();
  const base: LivePreviewContext = {
    state: view.state,
    docText,
    visibleFrom: 0,
    visibleTo: docText.length,
    focused: view.hasFocus,
    selectionRanges: view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to })),
  };
  return { ...renderContext(base), view };
}

function applyProjectionAction(
  action: EditorProjectionAction | undefined,
  context: MarkdownInlineInteractionContext,
  handlers: EditorProjectionActionHandlers = {},
): void {
  if (!action || action.kind === 'none') return;
  if (action.kind === 'open-reference') {
    handlers.openReference?.(action.fragment ? { path: action.path, fragment: action.fragment } : { path: action.path });
    return;
  }
  if (action.kind === 'set-ephemeral-state') {
    handlers.setEphemeralState?.({ key: action.key, value: action.value });
    return;
  }
  if (action.kind === 'dispatch') context.view.dispatch(action.transaction);
  if (action.kind === 'reveal-source') {
    const range = action.range ?? context.state.selection.main;
    context.view.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true });
  }
  if (action.kind === 'set-selection') {
    const anchor = action.selection.anchor ?? action.selection.from;
    const head = action.selection.head ?? action.selection.to;
    context.view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
  }
}

function taskMarkerState(context: LivePreviewContext, range: Pick<TaskMarkerRange, 'checkboxFrom' | 'checkboxTo'>): string {
  return context.docText.slice(range.checkboxFrom, range.checkboxTo) || ' ';
}

function isAsciiDigit(charCode: number): boolean {
  return charCode >= 48 && charCode <= 57;
}

function isMarkdownBullet(char: string): boolean {
  return char === '-' || char === '+' || char === '*';
}

function customTaskMarkerLength(lineText: string): number | null {
  let index = 0;
  while (lineText.charAt(index) === ' ' && index < 4) index += 1;
  if (index > 3) return null;

  const markerStart = index;
  const first = lineText.charAt(index);
  if (isMarkdownBullet(first)) {
    index += 1;
  } else if (isAsciiDigit(first.charCodeAt(0))) {
    while (isAsciiDigit(lineText.charCodeAt(index))) index += 1;
    const delimiter = lineText.charAt(index);
    if (delimiter !== '.' && delimiter !== ')') return null;
    index += 1;
  } else {
    return null;
  }

  if (lineText.charAt(index) !== ' ') return null;
  while (lineText.charAt(index) === ' ') index += 1;
  if (lineText.charAt(index) !== '[' || lineText.charAt(index + 2) !== ']') return null;
  if (lineText.charAt(index + 1) === '\n' || lineText.charAt(index + 1) === '') return null;
  return index + 3 - markerStart;
}

function fallbackTaskMarkerRangesForCustomStates(context: LivePreviewContext): TaskMarkerRange[] {
  const suppressedCodeRanges = markdownSuppressedCodeRanges(context.docText, { from: context.visibleFrom, to: context.visibleTo });
  const ranges: TaskMarkerRange[] = [];
  let line = context.state.doc.lineAt(context.visibleFrom);
  for (;;) {
    const lineIsSuppressed = suppressedCodeRanges.some((range) => line.from >= range.from && line.from <= range.to);
    const markerLength = lineIsSuppressed ? null : customTaskMarkerLength(line.text);
    if (markerLength !== null) {
      const checkboxOffset = markerLength - 2;
      const checkbox = line.text.charAt(checkboxOffset);
      ranges.push({
        lineFrom: line.from,
        lineTo: line.to,
        markerFrom: line.from,
        markerTo: line.from + markerLength,
        checkboxFrom: line.from + checkboxOffset,
        checkboxTo: line.from + checkboxOffset + 1,
        checked: checkbox === 'x' || checkbox === 'X',
        marker: context.docText.slice(line.from, line.from + markerLength),
      });
    }
    if (line.to >= context.visibleTo || line.to >= context.state.doc.length) break;
    line = context.state.doc.lineAt(line.to + 1);
  }
  return ranges;
}

function mergeTaskMarkerRanges(primary: readonly TaskMarkerRange[], fallback: readonly TaskMarkerRange[]): TaskMarkerRange[] {
  const keyed = new Map(primary.map((range) => [`${range.markerFrom}:${range.markerTo}`, range]));
  for (const range of fallback) keyed.set(`${range.markerFrom}:${range.markerTo}`, keyed.get(`${range.markerFrom}:${range.markerTo}`) ?? range);
  return [...keyed.values()].sort((left, right) => left.markerFrom - right.markerFrom || left.markerTo - right.markerTo);
}

function matchTaskMarkerSyntax(
  registration: MarkdownInlineRegistration,
  syntax: Extract<MarkdownInlineSyntax, { kind: 'task-marker' }>,
  context: LivePreviewContext,
): MarkdownInlineMatch[] {
  const allowedStates = syntax.states ? new Set(syntax.states) : null;
  const ranges = mergeTaskMarkerRanges(
    taskMarkerRangesForState(context.state, context.visibleFrom, context.visibleTo),
    fallbackTaskMarkerRangesForCustomStates(context),
  );
  return ranges.flatMap((range) => {
    const state = taskMarkerState(context, range);
    if (allowedStates && !allowedStates.has(state)) return [];
    return [
      {
        id: `${registration.id}:${range.markerFrom}:${range.markerTo}`,
        type: 'task-marker',
        from: range.markerFrom,
        to: range.markerTo,
        activationFrom: range.markerFrom,
        activationTo: range.markerTo,
        sourceFrom: range.markerFrom,
        sourceTo: range.markerTo,
        sourceText: context.docText.slice(range.markerFrom, range.markerTo),
        className: `z-live-preview-inline z-live-preview-inline--${registration.id}`,
        atomic: 'none' as const,
        selectionPolicy: { kind: 'token' as const },
        meta: {
          state,
          checked: range.checked,
          checkboxFrom: range.checkboxFrom,
          checkboxTo: range.checkboxTo,
          lineFrom: range.lineFrom,
          lineTo: range.lineTo,
        },
      },
    ];
  });
}

function syntaxMatches(registration: MarkdownInlineRegistration, context: LivePreviewContext): MarkdownInlineMatch[] {
  return (registration.syntax ?? []).flatMap((syntax) => {
    if (syntax.kind === 'task-marker') return matchTaskMarkerSyntax(registration, syntax, context);
    return [];
  });
}

export function matchMarkdownInlineRegistration<Match extends MarkdownInlineMatch = MarkdownInlineMatch>(
  registration: MarkdownInlineRegistration<Match>,
  context: MarkdownInlineMatchContext,
): readonly Match[] {
  const customMatches = registration.match?.(context) ?? [];
  return [...(syntaxMatches(registration, context) as Match[]), ...customMatches];
}

class HTMLElementInlineWidget extends WidgetType {
  constructor(
    readonly registration: MarkdownInlineRegistration,
    readonly match: MarkdownInlineMatch,
    readonly element: HTMLElement,
    readonly handlers: EditorProjectionActionHandlers = {},
  ) {
    super();
  }

  eq(other: HTMLElementInlineWidget): boolean {
    return this.registration.id === other.registration.id && this.element.isEqualNode(other.element);
  }

  toDOM(view: EditorView): HTMLElement {
    this.element.dataset.livePreviewRenderer ??= this.registration.id;
    this.element.addEventListener('mousedown', (event) => {
      if (!this.registration.onActivate) return;
      event.preventDefault();
      const context = allDocumentContext(view);
      applyProjectionAction(this.registration.onActivate(event, this.match, context), context, this.handlers);
    });
    return this.element;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' && Boolean(this.registration.onActivate);
  }
}

function widgetForRendered(
  registration: MarkdownInlineRegistration,
  match: MarkdownInlineMatch,
  rendered: WidgetType | HTMLElement,
  handlers: EditorProjectionActionHandlers,
): WidgetType {
  return rendered instanceof WidgetType ? rendered : new HTMLElementInlineWidget(registration, match, rendered, handlers);
}

function internalRangeForRendered(
  registration: MarkdownInlineRegistration,
  match: MarkdownInlineMatch,
  rendered: InlineRenderResult,
  handlers: EditorProjectionActionHandlers,
): InternalLivePreviewRange | null {
  if (rendered.kind === 'none') return null;
  if (rendered.kind === 'mark') {
    const attributes = rendered.attributes ?? match.attributes;
    return {
      rendererId: registration.id,
      from: match.from,
      to: match.to,
      activationFrom: match.activationFrom,
      activationTo: match.activationTo,
      sourceFrom: match.sourceFrom,
      sourceTo: match.sourceTo,
      clipboardSource: 'document-source',
      atomic: 'none',
      className: rendered.className,
      ...(attributes ? { attributes } : {}),
      kind: 'mark',
    };
  }
  const widget = rendered.widget ? widgetForRendered(registration, match, rendered.widget, handlers) : undefined;
  return {
    rendererId: registration.id,
    from: match.from,
    to: match.to,
    activationFrom: match.activationFrom,
    activationTo: match.activationTo,
    sourceFrom: match.sourceFrom,
    sourceTo: match.sourceTo,
    clipboardSource: 'document-source',
    atomic: match.atomic === 'inline' ? 'widget' : 'none',
    className: match.className ?? `z-live-preview-inline z-live-preview-inline--${registration.id}`,
    ...(match.attributes ? { attributes: match.attributes } : {}),
    kind: 'replace',
    ...(widget ? { widget } : {}),
  };
}

export function markdownInlineRegistrationsToInternalRenderers(
  registrations: readonly MarkdownInlineRegistration[],
  handlers: EditorProjectionActionHandlers = {},
): InternalLivePreviewRenderer[] {
  return [...registrations]
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .map(
      (registration): InternalLivePreviewRenderer => ({
        id: registration.id,
        match: (context) =>
          matchMarkdownInlineRegistration(registration, context).flatMap((match) => {
            const range = internalRangeForRendered(registration, match, registration.render(match, renderContext(context)), handlers);
            return range ? [range] : [];
          }),
      }),
    );
}

function registrationsByPriority(registrations: readonly MarkdownInlineRegistration[]): MarkdownInlineRegistration[] {
  return [...registrations].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
}

function findWholeSelectedInline(
  registrations: readonly MarkdownInlineRegistration[],
  context: MarkdownInlineInteractionContext,
): { registration: MarkdownInlineRegistration; match: MarkdownInlineMatch; selection: SourceRange } | null {
  if (context.state.selection.ranges.length !== 1) return null;
  const selection = context.state.selection.main;
  if (selection.empty) return null;
  for (const registration of registrationsByPriority(registrations)) {
    for (const match of matchMarkdownInlineRegistration(registration, context)) {
      if (selection.from === match.sourceFrom && selection.to === match.sourceTo) {
        return { registration, match, selection: { from: selection.from, to: selection.to } };
      }
    }
  }
  return null;
}

function selectionForPolicy(match: MarkdownInlineMatch): SourceSelection | null {
  const policy = match.selectionPolicy ?? { kind: 'source' as const };
  if (policy.kind === 'source') return { from: match.sourceFrom, to: match.sourceTo };
  if (policy.kind === 'token') return { from: match.from, to: match.to };
  if (policy.kind === 'content') return { from: policy.range.from, to: policy.range.to };
  return null;
}

function findInlineAtSelectionHead(
  registrations: readonly MarkdownInlineRegistration[],
  context: MarkdownInlineInteractionContext,
): { registration: MarkdownInlineRegistration; match: MarkdownInlineMatch } | null {
  const position = context.state.selection.main.head;
  for (const registration of registrationsByPriority(registrations)) {
    for (const match of matchMarkdownInlineRegistration(registration, context)) {
      if (position >= match.activationFrom && position <= match.activationTo) return { registration, match };
    }
  }
  return null;
}

function writeClipboardData(event: ClipboardEvent, result: EditorClipboardResult): boolean {
  if (result.kind === 'delegate') return false;
  event.clipboardData?.clearData();
  if (result.kind === 'text') {
    event.clipboardData?.setData('text/plain', result.text);
  } else {
    event.clipboardData?.setData('text/html', result.html);
    event.clipboardData?.setData('text/plain', result.text ?? result.html);
  }
  event.preventDefault();
  return true;
}

function clipboardResultFromCut(result: InlineCutResult): { clipboard: EditorClipboardResult; action?: EditorProjectionAction } {
  return 'clipboard' in result ? result : { clipboard: result };
}

export function markdownInlineInteractionExtension(
  registrations: readonly MarkdownInlineRegistration[],
  handlers: EditorProjectionActionHandlers = {},
): Extension {
  if (registrations.length === 0) return [];
  return EditorView.domEventHandlers({
    copy(event, view) {
      const context = allDocumentContext(view);
      const found = findWholeSelectedInline(registrations, context);
      if (!found?.registration.onCopy) return false;
      return writeClipboardData(event, found.registration.onCopy({ nativeEvent: event, selection: found.selection }, found.match, context));
    },
    cut(event, view) {
      const context = allDocumentContext(view);
      const found = findWholeSelectedInline(registrations, context);
      if (!found?.registration.onCut) return false;
      const { clipboard, action } = clipboardResultFromCut(
        found.registration.onCut({ nativeEvent: event, selection: found.selection }, found.match, context),
      );
      if (!writeClipboardData(event, clipboard)) return false;
      applyProjectionAction(action, context, handlers);
      if (!action) {
        view.dispatch({
          changes: { from: found.selection.from, to: found.selection.to, insert: '' },
          annotations: Transaction.userEvent.of('delete.cut'),
        });
      }
      return true;
    },

    mouseup(event, view) {
      const context = allDocumentContext(view);
      const found = findInlineAtSelectionHead(registrations, context);
      if (!found) return false;
      if (found.match.selectionPolicy?.kind === 'custom') {
        if (!found.registration.onSelect) return false;
        applyProjectionAction(found.registration.onSelect(event, found.match, context), context, handlers);
        return true;
      }
      const selection = selectionForPolicy(found.match);
      if (!selection) return false;
      const current = view.state.selection.main;
      if (current.from === selection.from && current.to === selection.to) return false;
      applyProjectionAction({ kind: 'set-selection', selection }, context, handlers);
      return true;
    },
    paste(event, view) {
      const context = allDocumentContext(view);
      const found = findInlineAtSelectionHead(registrations, context);
      if (!found?.registration.onPaste) return false;
      applyProjectionAction(found.registration.onPaste(event, found.match, context), context, handlers);
      event.preventDefault();
      return true;
    },
  });
}

export function markdownInlineRegistrationExtensions(registrations: readonly MarkdownInlineRegistration[]): Extension[] {
  return registrations.flatMap((registration) => {
    const keymaps = registration.keybindings?.() ?? [];
    return [...(registration.extensions?.() ?? []), ...(keymaps.length > 0 ? [keymap.of(keymaps)] : [])];
  });
}
