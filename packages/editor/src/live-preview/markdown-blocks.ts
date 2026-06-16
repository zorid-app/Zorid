import { syntaxTree } from '@codemirror/language';
import { type Extension, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, type KeyBinding, keymap, WidgetType } from '@codemirror/view';
import type { InternalLivePreviewRenderer } from './internal-types.js';
import {
  type MarkdownCodeRange,
  markdownCalloutRanges,
  markdownCompleteFencedCodeBlockRanges,
  markdownInlineCodeRanges,
  markdownSuppressedPreviewRanges,
} from './markdown-code-context.js';
import { stateWithAvailableZoridSyntaxTree } from './syntax-tree-ranges.js';
import type { LivePreviewContext, LivePreviewVisibleRange } from './types.js';

export type MarkdownBlockReferenceSyntax = 'wikilink-embed' | 'markdown-link' | string;

export type MarkdownBlockDefinition =
  | {
      readonly kind: 'inline';
      readonly sourceFrom: number;
      readonly sourceTo: number;
      readonly sourceText: string;
    }
  | {
      readonly kind: 'external';
      readonly sourceFrom: number;
      readonly sourceTo: number;
      readonly path: string;
      readonly fragment?: string;
      readonly referenceSyntax: MarkdownBlockReferenceSyntax;
    };

export interface MarkdownBlockMatch {
  readonly id: string;
  readonly type: string;
  readonly from: number;
  readonly to: number;
  readonly activationFrom: number;
  readonly activationTo: number;
  readonly definition: MarkdownBlockDefinition;
  readonly className: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly atomic?: 'none' | 'widget';
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type MarkdownBlockSyntax =
  | { readonly kind: 'fenced-code'; readonly info: string }
  | { readonly kind: 'callout'; readonly type?: string }
  | {
      readonly kind: 'embed-reference';
      readonly extensions?: readonly string[];
      readonly pathMatches?: (path: string) => boolean;
    }
  | { readonly kind: 'custom' };

export interface MarkdownBlockMatchContext extends LivePreviewContext {}

export interface MarkdownBlockRenderContext extends LivePreviewContext {
  sourceText(match: Pick<MarkdownBlockMatch, 'from' | 'to'>): string;
}

export interface MarkdownBlockInteractionContext extends MarkdownBlockRenderContext {
  readonly view: EditorView;
}

export interface BlockActionHandlers {
  openReference?(target: { readonly path: string; readonly fragment?: string }): void;
  setEphemeralState?(entry: { readonly key: string; readonly value: unknown }): void;
}

export interface MarkdownBlockClipboardEvent {
  readonly nativeEvent: ClipboardEvent;
  readonly selection: { readonly from: number; readonly to: number };
}

export type BlockAction =
  | { readonly kind: 'dispatch'; readonly transaction: TransactionSpec }
  | { readonly kind: 'reveal-source'; readonly range?: { readonly from: number; readonly to: number } }
  | { readonly kind: 'open-reference'; readonly path: string; readonly fragment?: string }
  | { readonly kind: 'set-ephemeral-state'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'none' };

export type BlockClipboardResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'html'; readonly html: string; readonly text?: string }
  | { readonly kind: 'delegate' };

export type BlockCutResult =
  | BlockClipboardResult
  | { readonly clipboard: BlockClipboardResult; readonly action?: BlockAction };

export interface MarkdownBlockRegistration<Match extends MarkdownBlockMatch = MarkdownBlockMatch> {
  readonly id: string;
  readonly priority?: number;
  readonly syntax?: readonly MarkdownBlockSyntax[];
  match?(context: MarkdownBlockMatchContext): readonly Match[];
  render(match: Match, context: MarkdownBlockRenderContext): WidgetType | HTMLElement;
  onActivate?(event: Event, match: Match, context: MarkdownBlockInteractionContext): BlockAction;
  onEdit?(event: Event, match: Match, context: MarkdownBlockInteractionContext): BlockAction;
  onCopy?(
    event: MarkdownBlockClipboardEvent,
    match: Match,
    context: MarkdownBlockInteractionContext,
  ): BlockClipboardResult;
  onCut?(event: MarkdownBlockClipboardEvent, match: Match, context: MarkdownBlockInteractionContext): BlockCutResult;
  onPaste?(event: ClipboardEvent, match: Match, context: MarkdownBlockInteractionContext): BlockAction;
  extensions?(): readonly Extension[];
  keybindings?(): readonly KeyBinding[];
  readingViewAdapter?(): unknown;
}

class HTMLElementBlockWidget extends WidgetType {
  private resizeMeasure: HTMLElementBlockResizeMeasure | undefined;

  constructor(
    readonly registration: MarkdownBlockRegistration,
    readonly match: MarkdownBlockMatch,
    readonly element: HTMLElement,
    readonly handlers: BlockActionHandlers = {},
  ) {
    super();
  }

  eq(other: HTMLElementBlockWidget): boolean {
    return this.registration.id === other.registration.id && this.element.isEqualNode(other.element);
  }

  toDOM(view: EditorView): HTMLElement {
    this.resizeMeasure?.destroy();
    this.resizeMeasure = new HTMLElementBlockResizeMeasure(this.element, view);
    this.element.dataset.livePreviewRenderer ??= this.registration.id;
    this.element.addEventListener('mousedown', (event) => {
      if (!this.registration.onActivate) return;
      event.preventDefault();
      const context = allDocumentContext(view);
      applyBlockAction(this.registration.onActivate(event, this.match, context), context, this.handlers);
    });
    this.element.addEventListener('dblclick', (event) => {
      if (!this.registration.onEdit) return;
      event.preventDefault();
      const context = allDocumentContext(view);
      applyBlockAction(this.registration.onEdit(event, this.match, context), context, this.handlers);
    });
    return this.element;
  }

  destroy(_dom: HTMLElement): void {
    this.resizeMeasure?.destroy();
    this.resizeMeasure = undefined;
  }

  ignoreEvent(event: Event): boolean {
    return (
      (event.type === 'mousedown' && Boolean(this.registration.onActivate)) ||
      (event.type === 'dblclick' && Boolean(this.registration.onEdit))
    );
  }
}

class HTMLElementBlockResizeMeasure {
  private readonly observer: ResizeObserver | undefined;
  private pendingAnimationFrame: number | undefined;
  private pendingTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly element: HTMLElement,
    private readonly view: EditorView,
  ) {
    const ResizeObserverConstructor = element.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (!ResizeObserverConstructor) return;

    this.observer = new ResizeObserverConstructor(() => this.scheduleMeasure());
    this.observer.observe(element);
  }

  destroy(): void {
    this.observer?.disconnect();
    if (this.pendingAnimationFrame !== undefined) {
      this.element.ownerDocument.defaultView?.cancelAnimationFrame(this.pendingAnimationFrame);
      this.pendingAnimationFrame = undefined;
    }
    if (this.pendingTimeout !== undefined) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = undefined;
    }
  }

  private scheduleMeasure(): void {
    if (this.pendingAnimationFrame !== undefined || this.pendingTimeout !== undefined) return;

    const viewWindow = this.element.ownerDocument.defaultView;
    if (viewWindow) {
      this.pendingAnimationFrame = viewWindow.requestAnimationFrame(() => {
        this.pendingAnimationFrame = undefined;
        this.view.requestMeasure();
      });
      return;
    }

    this.pendingTimeout = setTimeout(() => {
      this.pendingTimeout = undefined;
      this.view.requestMeasure();
    }, 0);
  }
}

function blockSourceText(context: LivePreviewContext, match: Pick<MarkdownBlockMatch, 'from' | 'to'>): string {
  return context.docText.slice(match.from, match.to);
}

function renderContext(context: LivePreviewContext): MarkdownBlockRenderContext {
  return {
    ...context,
    sourceText: (match) => blockSourceText(context, match),
  };
}

function widgetForRendered(
  registration: MarkdownBlockRegistration,
  match: MarkdownBlockMatch,
  rendered: WidgetType | HTMLElement,
  handlers: BlockActionHandlers,
): WidgetType {
  return rendered instanceof WidgetType
    ? rendered
    : new HTMLElementBlockWidget(registration, match, rendered, handlers);
}

function inlineDefinition(docText: string, from: number, to: number): MarkdownBlockDefinition {
  return { kind: 'inline', sourceFrom: from, sourceTo: to, sourceText: docText.slice(from, to) };
}

function matchFencedCodeSyntax(
  registration: MarkdownBlockRegistration,
  syntax: Extract<MarkdownBlockSyntax, { kind: 'fenced-code' }>,
  context: LivePreviewContext,
): MarkdownBlockMatch[] {
  return markdownCompleteFencedCodeBlockRanges(
    context.docText,
    { from: context.visibleFrom, to: context.visibleTo },
    context.state,
  )
    .filter((range) => range.info === syntax.info)
    .map((range) => ({
      id: `${registration.id}:${range.from}:${range.to}`,
      type: `fenced-code:${syntax.info}`,
      from: range.from,
      to: range.to,
      activationFrom: range.from,
      activationTo: range.to,
      definition: inlineDefinition(context.docText, range.from, range.to),
      className: `z-live-preview-block z-live-preview-block--${registration.id}`,
      atomic: 'none' as const,
      meta: {
        info: range.info,
        marker: range.marker,
        markerLength: range.markerLength,
        code: context.docText.slice(range.contentFrom, range.contentTo),
        contentFrom: range.contentFrom,
        contentTo: range.contentTo,
      },
    }));
}

function matchCalloutSyntax(
  registration: MarkdownBlockRegistration,
  syntax: Extract<MarkdownBlockSyntax, { kind: 'callout' }>,
  context: LivePreviewContext,
): MarkdownBlockMatch[] {
  return markdownCalloutRanges(context.docText, { from: context.visibleFrom, to: context.visibleTo }, context.state)
    .filter((range) => !syntax.type || range.type === syntax.type)
    .map((range) => ({
      id: `${registration.id}:${range.from}:${range.to}`,
      type: `callout:${range.type}`,
      from: range.from,
      to: range.to,
      activationFrom: range.from,
      activationTo: range.to,
      definition: inlineDefinition(context.docText, range.from, range.to),
      className: `z-live-preview-block z-live-preview-block--${registration.id}`,
      atomic: 'none' as const,
      meta: { type: range.type, title: range.title, body: range.body },
    }));
}

function markdownWikiLinkRanges(context: LivePreviewContext): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  const state = stateWithAvailableZoridSyntaxTree(context.state, context.docText, context.visibleTo);
  syntaxTree(state).iterate({
    from: context.visibleFrom,
    to: context.visibleTo,
    enter: (node) => {
      if (node.name !== 'WikiLink') return;
      ranges.push({ from: node.from, to: node.to });
      return false;
    },
  });

  // Embed references are source-level blocks whose trigger includes the leading
  // `!` outside the WikiLink node. Keep this tiny fallback scanner here so an
  // embed registration can still match before the Markdown grammar grows a
  // dedicated block/embed node. The normalized match below remains identical to
  // the syntax-tree path.
  let index = Math.max(0, context.visibleFrom - 1);
  while (index < context.visibleTo) {
    const from = context.docText.indexOf('[[', index);
    if (from === -1 || from > context.visibleTo) break;
    const to = context.docText.indexOf(']]', from + 2);
    if (to === -1) break;
    const range = { from, to: to + 2 };
    if (range.from < context.visibleTo && range.to > context.visibleFrom) ranges.push(range);
    index = range.to;
  }

  return [...new Map(ranges.map((range) => [`${range.from}:${range.to}`, range])).values()];
}

function embedReferenceSuppressedRanges(context: LivePreviewContext): MarkdownCodeRange[] {
  const scanWindow = {
    from: Math.max(0, context.visibleFrom - 1),
    to: context.visibleTo,
  };
  return [
    ...markdownSuppressedPreviewRanges(context.docText, scanWindow, context.state),
    ...markdownInlineCodeRanges(context.docText, scanWindow, context.state),
  ];
}

function isInsideRange(range: MarkdownCodeRange, container: MarkdownCodeRange): boolean {
  return range.from >= container.from && range.to <= container.to;
}

function parseWikilinkEmbedTarget(rawTarget: string): { path: string; fragment?: string } {
  const target = rawTarget.split('|', 1)[0] ?? rawTarget;
  const hashIndex = target.indexOf('#');
  if (hashIndex === -1) return { path: target };
  const fragment = target.slice(hashIndex + 1);
  return fragment ? { path: target.slice(0, hashIndex), fragment } : { path: target.slice(0, hashIndex) };
}

function pathHasAllowedExtension(path: string, extensions?: readonly string[]): boolean {
  if (!extensions || extensions.length === 0) return true;
  const lowerPath = path.toLowerCase();
  return extensions.some((extension) =>
    lowerPath.endsWith(extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`),
  );
}

function matchEmbedReferenceSyntax(
  registration: MarkdownBlockRegistration,
  syntax: Extract<MarkdownBlockSyntax, { kind: 'embed-reference' }>,
  context: LivePreviewContext,
): MarkdownBlockMatch[] {
  const suppressedRanges = embedReferenceSuppressedRanges(context);
  return markdownWikiLinkRanges(context).flatMap((wikiRange) => {
    if (wikiRange.from === 0 || context.docText.charAt(wikiRange.from - 1) !== '!') return [];
    const from = wikiRange.from - 1;
    const to = wikiRange.to;
    if (suppressedRanges.some((range) => isInsideRange({ from, to }, range))) return [];
    const rawTarget = context.docText.slice(wikiRange.from + 2, wikiRange.to - 2).trim();
    if (!rawTarget) return [];
    const { path, fragment } = parseWikilinkEmbedTarget(rawTarget);
    if (!pathHasAllowedExtension(path, syntax.extensions) || (syntax.pathMatches && !syntax.pathMatches(path))) {
      return [];
    }
    const definition: MarkdownBlockDefinition = fragment
      ? { kind: 'external', sourceFrom: from, sourceTo: to, path, fragment, referenceSyntax: 'wikilink-embed' }
      : { kind: 'external', sourceFrom: from, sourceTo: to, path, referenceSyntax: 'wikilink-embed' };
    return [
      {
        id: `${registration.id}:${from}:${to}`,
        type: 'embed-reference',
        from,
        to,
        activationFrom: from,
        activationTo: to,
        definition,
        className: `z-live-preview-block z-live-preview-block--${registration.id}`,
        atomic: 'none' as const,
        meta: { rawTarget },
      },
    ];
  });
}

function syntaxMatches(registration: MarkdownBlockRegistration, context: LivePreviewContext): MarkdownBlockMatch[] {
  return (registration.syntax ?? []).flatMap((syntax) => {
    if (syntax.kind === 'fenced-code') return matchFencedCodeSyntax(registration, syntax, context);
    if (syntax.kind === 'callout') return matchCalloutSyntax(registration, syntax, context);
    if (syntax.kind === 'embed-reference') return matchEmbedReferenceSyntax(registration, syntax, context);
    return [];
  });
}

export function matchMarkdownBlockRegistration<Match extends MarkdownBlockMatch = MarkdownBlockMatch>(
  registration: MarkdownBlockRegistration<Match>,
  context: MarkdownBlockMatchContext,
): readonly Match[] {
  const customMatches = registration.match?.(context) ?? [];
  return [...(syntaxMatches(registration, context) as Match[]), ...customMatches];
}

export function markdownBlockRegistrationsToInternalRenderers(
  registrations: readonly MarkdownBlockRegistration[],
  handlers: BlockActionHandlers = {},
): InternalLivePreviewRenderer[] {
  return [...registrations]
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .map(
      (registration): InternalLivePreviewRenderer => ({
        id: registration.id,
        match: (context) =>
          matchMarkdownBlockRegistration(registration, context).map((match) => {
            const range = {
              rendererId: registration.id,
              from: match.from,
              to: match.to,
              activationFrom: match.activationFrom,
              activationTo: match.activationTo,
              sourceFrom: match.definition.sourceFrom,
              sourceTo: match.definition.sourceTo,
              clipboardSource: 'document-source' as const,
              atomic: match.atomic ?? ('none' as const),
              priority: registration.priority ?? 0,
              className: match.className,
              kind: 'widget' as const,
              widget: widgetForRendered(
                registration,
                match,
                registration.render(match, renderContext(context)),
                handlers,
              ),
            };
            return match.attributes ? { ...range, attributes: match.attributes } : range;
          }),
      }),
    );
}

function allDocumentContext(view: EditorView): MarkdownBlockInteractionContext {
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

function findWholeSelectedBlock(
  registrations: readonly MarkdownBlockRegistration[],
  context: MarkdownBlockInteractionContext,
  hasHandler: (registration: MarkdownBlockRegistration) => boolean = () => true,
): {
  registration: MarkdownBlockRegistration;
  match: MarkdownBlockMatch;
  selection: { from: number; to: number };
} | null {
  if (context.state.selection.ranges.length !== 1) return null;
  const selection = context.state.selection.main;
  if (selection.empty) return null;
  for (const registration of [...registrations].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))) {
    if (!hasHandler(registration)) continue;
    for (const match of matchMarkdownBlockRegistration(registration, context)) {
      if (selection.from === match.definition.sourceFrom && selection.to === match.definition.sourceTo) {
        return { registration, match, selection: { from: selection.from, to: selection.to } };
      }
    }
  }
  return null;
}

function writeClipboardData(event: ClipboardEvent, result: BlockClipboardResult): boolean {
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

function clipboardResultFromCut(result: BlockCutResult): { clipboard: BlockClipboardResult; action?: BlockAction } {
  return 'clipboard' in result ? result : { clipboard: result };
}

function applyBlockAction(
  action: BlockAction | undefined,
  context: MarkdownBlockInteractionContext,
  handlers: BlockActionHandlers = {},
): void {
  if (!action || action.kind === 'none') return;
  if (action.kind === 'open-reference') {
    handlers.openReference?.(
      action.fragment ? { path: action.path, fragment: action.fragment } : { path: action.path },
    );
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
}

function findBlockAtSelectionHead(
  registrations: readonly MarkdownBlockRegistration[],
  context: MarkdownBlockInteractionContext,
  hasHandler: (registration: MarkdownBlockRegistration) => boolean = () => true,
): { registration: MarkdownBlockRegistration; match: MarkdownBlockMatch } | null {
  const position = context.state.selection.main.head;
  for (const registration of [...registrations].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))) {
    if (!hasHandler(registration)) continue;
    for (const match of matchMarkdownBlockRegistration(registration, context)) {
      if (position >= match.activationFrom && position <= match.activationTo) return { registration, match };
    }
  }
  return null;
}

export function markdownBlockInteractionExtension(
  registrations: readonly MarkdownBlockRegistration[],
  handlers: BlockActionHandlers = {},
): Extension {
  if (registrations.length === 0) return [];
  return EditorView.domEventHandlers({
    copy(event, view) {
      const context = allDocumentContext(view);
      const found = findWholeSelectedBlock(registrations, context, (registration) => Boolean(registration.onCopy));
      if (!found?.registration.onCopy) return false;
      const result = found.registration.onCopy(
        { nativeEvent: event, selection: found.selection },
        found.match,
        context,
      );
      return writeClipboardData(event, result);
    },
    cut(event, view) {
      const context = allDocumentContext(view);
      const found = findWholeSelectedBlock(registrations, context, (registration) => Boolean(registration.onCut));
      if (!found?.registration.onCut) return false;
      const { clipboard, action } = clipboardResultFromCut(
        found.registration.onCut({ nativeEvent: event, selection: found.selection }, found.match, context),
      );
      if (!writeClipboardData(event, clipboard)) return false;
      applyBlockAction(action, context, handlers);
      if (!action) {
        view.dispatch({
          changes: { from: found.selection.from, to: found.selection.to, insert: '' },
          annotations: Transaction.userEvent.of('delete.cut'),
        });
      }
      return true;
    },
    paste(event, view) {
      const context = allDocumentContext(view);
      const found = findBlockAtSelectionHead(registrations, context, (registration) => Boolean(registration.onPaste));
      if (!found?.registration.onPaste) return false;
      applyBlockAction(found.registration.onPaste(event, found.match, context), context, handlers);
      event.preventDefault();
      return true;
    },
  });
}

export function markdownBlockRegistrationExtensions(registrations: readonly MarkdownBlockRegistration[]): Extension[] {
  return registrations.flatMap((registration) => {
    const keymaps = registration.keybindings?.() ?? [];
    return [...(registration.extensions?.() ?? []), ...(keymaps.length > 0 ? [keymap.of(keymaps)] : [])];
  });
}
