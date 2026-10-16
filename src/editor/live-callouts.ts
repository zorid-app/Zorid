import { EditorState, Facet, StateEffect, StateField } from '@codemirror/state';
import type { Extension, Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { Bug, Check, ChevronDown, CircleCheck, CircleHelp, ClipboardList, CodeXml, Flame, Info, List, Pencil, Quote, TriangleAlert, X, Zap } from 'lucide';
import type { IconNode } from 'lucide';
import { inline, renderMarkdown } from '../ui/markdown.ts';
import type { EmbedRequest, LinkHandler } from '../ui/markdown.ts';
import { bodyStart } from './live-properties.ts';

export interface LiveCalloutOptions {
  open?: LinkHandler;
  renderEmbed?: (request: EmbedRequest) => { dom: HTMLElement; destroy(): void };
}
export interface CalloutHeader { type: string; metadata: string; fold: '' | '+' | '-'; title: string }
export function parseCalloutHeader(text: string): CalloutHeader | null {
  const match = /^\[!([^\]]+)\]([+-]?)(?:[ \t]+|$)(.*)$/.exec(text);
  if (!match) return null;
  const divider = match[1].indexOf('|'), raw = divider < 0 ? match[1] : match[1].slice(0, divider);
  const type = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!type) return null;
  return { type, metadata: divider < 0 ? '' : match[1].slice(divider + 1), fold: match[2] as CalloutHeader['fold'], title: match[3] };
}

interface Span { from: number; to: number; source: string; identity: object; folds: Map<string, boolean> }
interface CalloutState { spans: readonly Span[]; decorations: DecorationSet; rendered: readonly { from: number; to: number }[]; focused: boolean; held: boolean; searched: ReadonlySet<object> }
const optionsFacet = Facet.define<LiveCalloutOptions, LiveCalloutOptions>({ combine: values => values[0] ?? {} });
const refresh = StateEffect.define<{ focused?: boolean; held?: boolean }>();
const resources = new WeakMap<HTMLElement, () => void>();
const pendingActivations = new WeakMap<EditorView, Set<() => void>>();
function cancelPendingActivation(view: EditorView): void { pendingActivations.get(view)?.forEach(cancel => cancel()); }
function releaseResources(cleanup: (() => void)[]): void { for (const dispose of cleanup.splice(0).reverse()) { try { dispose(); } catch { /* Continue releasing sibling resources. */ } } }
const ignored = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'LiveInlineComment', 'Table', 'BulletList', 'OrderedList']);
const interactive = 'a,button,input,textarea,select,audio,video,iframe,.interactive-child,[role="button"]';

function discover(state: EditorState, previous: readonly Span[] = [], transaction?: Transaction): Span[] {
  const tree = syntaxTree(state), prefix = bodyStart(state), old = new Map<number, Span>();
  for (const span of previous) {
    const from = transaction ? transaction.changes.mapPos(span.from, 1) : span.from;
    old.set(from, span);
  }
  const spans: Span[] = [];
  tree.iterate({ enter(node) {
    if (ignored.has(node.name)) return false;
    if (node.name !== 'Blockquote') return;
    // Only complete outer quote blocks own block replacements. Their children
    // render recursively; list-owned quotes retain the list editor's geometry.
    const line = state.doc.lineAt(node.from), first = line.text.match(/^ {0,3}>[ \t]?(.*)$/);
    if (node.from < prefix || !first || !parseCalloutHeader(first[1]) || node.to === tree.length && tree.length < state.doc.length) return false;
    const from = line.from, to = node.to, source = state.doc.sliceString(from, to), prior = old.get(from);
    spans.push({ from, to, source, identity: prior?.identity ?? {}, folds: prior?.source === source ? prior.folds : new Map() });
    return false;
  } });
  return spans;
}

const glyphs: Record<string, IconNode> = {
  note: Pencil, abstract: ClipboardList, summary: ClipboardList, tldr: ClipboardList,
  info: Info, todo: CircleCheck, important: Flame, tip: Flame, hint: Flame,
  success: Check, check: Check, done: Check, question: CircleHelp, help: CircleHelp, faq: CircleHelp,
  warning: TriangleAlert, caution: TriangleAlert, attention: TriangleAlert, failure: X, fail: X, missing: X,
  danger: Zap, error: Zap, bug: Bug, example: List, quote: Quote, cite: Quote,
};
function icon(document: Document, glyph: IconNode): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'svg-icon' })) svg.setAttribute(name, value);
  for (const [tag, attrs] of glyph) {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attrs)) if (value !== undefined) node.setAttribute(key, String(value));
    svg.append(node);
  }
  return svg;
}

/** Original safe block renderer. Each quote removes one structural quote layer;
 * Lezer still gates fences, lists and nested blocks before any recursion. */
function renderCallout(view: EditorView, span: Span, options: LiveCalloutOptions, wrapper: HTMLElement, cleanup: (() => void)[]): void {
  const document = wrapper.ownerDocument, open = options.open ?? (() => {});
  const embed = options.renderEmbed ? (request: EmbedRequest) => { const instance = options.renderEmbed!(request); cleanup.push(() => instance.destroy()); return instance.dom; } : undefined;
  const listen = <K extends keyof HTMLElementEventMap>(node: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void) => {
    node.addEventListener(type, handler); cleanup.push(() => node.removeEventListener(type, handler));
  };
  const task = (relativeLine: number) => {
    const current = view.state.field(calloutField, false)?.spans.find(item => item.identity === span.identity);
    if (!current || current.source !== span.source || view.state.readOnly) return;
    const line = view.state.doc.line(view.state.doc.lineAt(current.from).number + relativeLine);
    const marker = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[([^\]])\]/.exec(line.text);
    if (!marker) return;
    const position = line.from + marker[0].lastIndexOf('[') + 1;
    view.dispatch({ changes: { from: position, to: position + 1, insert: marker[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
  };
  type Node = ReturnType<typeof markdownLanguage.parser.parse>['topNode'];
  const children = (node: Node): Node[] => { const result: Node[] = []; for (let child = node.firstChild; child; child = child.nextSibling) result.push(child); return result; };
  let remainingParseUnits = Math.min(1_000_000, Math.max(32_768, span.source.length * 8)), renderDepth = 0;
  const blocks = (parent: HTMLElement, source: string, lineMap: readonly number[], path: string): void => {
    // Bound repeated parsing of nested quoted suffixes; retain every remaining
    // character visibly when unusually deep/large input exceeds the budget.
    if (renderDepth >= 32 || source.length > remainingParseUnits) {
      const literal = document.createElement('pre'); literal.className = 'callout-source-fallback'; literal.textContent = source; parent.append(literal); return;
    }
    remainingParseUnits -= source.length; renderDepth++;
    try {
    const starts = [0]; for (let index = 0; index < source.length; index++) if (source[index] === '\n') starts.push(index + 1);
    const lineAt = (position: number) => { let low = 0, high = starts.length; while (low + 1 < high) { const mid = (low + high) >>> 1; if (starts[mid] <= position) low = mid; else high = mid; } return low; };
    const text = (node: Node) => source.slice(node.from, node.to);
    const render = (into: HTMLElement, node: Node): void => {
      if (node.name === 'Blockquote') {
        const raw = text(node), lines = raw.split('\n').map(line => line.replace(/^[ \t]*>[ \t]?/, ''));
        const maps = lineMap.slice(lineAt(node.from), lineAt(node.from) + lines.length);
        quote(into, lines.join('\n'), maps, `${path}/${node.from}`); return;
      }
      if (node.name === 'BulletList' || node.name === 'OrderedList') {
        const list = document.createElement(node.name === 'BulletList' ? 'ul' : 'ol');
        if (node.name === 'OrderedList') { const marker = node.firstChild?.getChild('ListMark'); if (marker) (list as HTMLOListElement).start = Number.parseInt(text(marker), 10); }
        for (const item of children(node).filter(child => child.name === 'ListItem')) {
          const li = document.createElement('li'); for (const block of children(item)) render(li, block); list.append(li);
        }
        into.append(list); return;
      }
      if (node.name === 'Task') {
        const marker = node.getChild('TaskMarker');
        if (marker) {
          const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'task-list-item-checkbox'; input.checked = text(marker)[1] !== ' '; input.disabled = view.state.readOnly;
          into.classList.add('task-list-item'); into.classList.toggle('is-checked', input.checked); into.dataset.task = text(marker)[1];
          input.setAttribute('aria-label', 'Toggle task'); listen(input, 'click', event => { event.preventDefault(); event.stopPropagation(); task(lineMap[lineAt(marker.from)]); });
          into.append(input); inline(into, source.slice(marker.to, node.to).trimStart(), open, { embed }); return;
        }
      }
      if (node.name === 'Paragraph' || node.name === 'Task') {
        const paragraph = document.createElement('p'); inline(paragraph, text(node), open, { embed }); into.append(paragraph); return;
      }
      if (/^(ATX|Setext)Heading[1-6]$/.test(node.name)) {
        const heading = document.createElement(`h${node.name.slice(-1)}`);
        const marks = children(node).filter(child => child.name === 'HeaderMark');
        const from = node.name.startsWith('ATX') ? marks[0]?.to ?? node.from : node.from;
        const to = node.name.startsWith('Setext') ? marks[0]?.from ?? node.to : marks.length > 1 ? marks.at(-1)!.from : node.to;
        inline(heading, source.slice(from, to).trim(), open, { embed }); into.append(heading); return;
      }
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        const pre = document.createElement('pre'), code = document.createElement('code');
        code.textContent = children(node).filter(child => child.name === 'CodeText').map(text).join('\n');
        const info = node.getChild('CodeInfo'); if (info) code.dataset.language = text(info);
        pre.append(code); into.append(pre); return;
      }
      if (node.name === 'HorizontalRule') { into.append(document.createElement('hr')); return; }
      if (['ListMark', 'QuoteMark', 'LinkReference'].includes(node.name)) return;
      const fragment = document.createElement('div'); renderMarkdown(fragment, text(node), open, undefined, { embed, properties: false });
      into.append(...fragment.childNodes);
    };
    for (const node of children(markdownLanguage.parser.parse(source).topNode)) render(parent, node);
    } finally { renderDepth--; }
  };
  const quote = (parent: HTMLElement, source: string, lineMap: readonly number[], path: string): void => {
    const newline = source.indexOf('\n'), header = parseCalloutHeader(newline < 0 ? source : source.slice(0, newline));
    if (!header) { const node = document.createElement('blockquote'); blocks(node, source, lineMap, path); parent.append(node); return; }
    const callout = document.createElement('div'); callout.className = 'callout';
    callout.dataset.callout = header.type; callout.dataset.calloutMetadata = header.metadata; callout.dataset.calloutFold = header.fold;
    const title = document.createElement('div'); title.className = 'callout-title';
    const glyph = document.createElement('span'); glyph.className = 'callout-icon'; glyph.append(icon(document, Object.hasOwn(glyphs, header.type) ? glyphs[header.type] : Pencil));
    const label = document.createElement('div'); label.className = 'callout-title-inner'; label.dir = 'auto';
    const fallback = header.type.replace(/-/g, ' '); inline(label, header.title || fallback[0].toUpperCase() + fallback.slice(1), open, { embed });
    title.append(glyph, label); callout.append(title);
    const body = document.createElement('div'); body.className = 'callout-content';
    if (newline >= 0) blocks(body, source.slice(newline + 1), lineMap.slice(1), path);
    callout.append(body); parent.append(callout);
    if (header.fold) {
      callout.classList.add('is-collapsible');
      const fold = document.createElement('button'); fold.type = 'button'; fold.className = 'callout-fold'; fold.append(icon(document, ChevronDown)); title.append(fold);
      const key = path + ':' + header.type + header.fold;
      let collapsed = span.folds.get(key) ?? header.fold === '-';
      const apply = () => { callout.classList.toggle('is-collapsed', collapsed); body.hidden = collapsed; fold.setAttribute('aria-expanded', String(!collapsed)); fold.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} callout`); view.requestMeasure(); };
      const toggle = () => { collapsed = !collapsed; span.folds.set(key, collapsed); apply(); };
      listen(fold, 'mousedown', event => event.preventDefault());
      listen(fold, 'click', event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); toggle(); });
      let titleTimer: ReturnType<typeof setTimeout> | undefined;
      cleanup.push(() => clearTimeout(titleTimer));
      listen(title, 'click', event => {
        if (event.button !== 0 || event.defaultPrevented || (event.target as Element).closest(interactive)) return;
        clearTimeout(titleTimer); titleTimer = setTimeout(() => { if (!event.defaultPrevented) { event.preventDefault(); toggle(); } }, 0);
      });
      apply();
    }
  };
  const source = span.source.replace(/\r\n/g, '\n'), lines = source.split('\n');
  quote(wrapper, lines.map(line => line.replace(/^ {0,3}>[ \t]?/, '')).join('\n'), lines.map((_, index) => index), 'root');
}

class CalloutWidget extends WidgetType {
  readonly span: Span; readonly options: LiveCalloutOptions; readonly readOnly: boolean;
  constructor(span: Span, options: LiveCalloutOptions, readOnly: boolean) { super(); this.span = span; this.options = options; this.readOnly = readOnly; }
  eq(other: WidgetType): boolean { return other instanceof CalloutWidget && other.span.identity === this.span.identity && other.span.source === this.span.source && other.options === this.options && other.readOnly === this.readOnly; }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = view.dom.ownerDocument.createElement('div'); wrapper.className = 'cm-live-callout cm-embed-block'; wrapper.contentEditable = 'false'; wrapper.tabIndex = -1;
    const cleanup: (() => void)[] = []; let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    try { renderCallout(view, this.span, this.options, wrapper, cleanup); }
    catch {
      // A later embedded child may fail after earlier children allocated resources.
      // Release every completed mount and retain usable source editing.
      releaseResources(cleanup);
      const literal = wrapper.ownerDocument.createElement('pre'); literal.className = 'callout-source-fallback'; literal.textContent = this.span.source; wrapper.replaceChildren(literal);
    }
    const cancelActivation = () => { clearTimeout(timer); pendingActivations.get(view)?.delete(cancelActivation); };
    const reveal = () => {
      if (disposed) return;
      const current = view.state.field(calloutField, false)?.spans.find(span => span.identity === this.span.identity);
      if (!current) return;
      view.focus(); view.dispatch({ effects: refresh.of({ focused: true, held: false }), selection: { anchor: current.to, head: current.from }, userEvent: 'select.pointer', scrollIntoView: true });
    };
    const edit = view.dom.ownerDocument.createElement('button'); edit.type = 'button'; edit.className = 'edit-block-button cm-callout-edit'; edit.setAttribute('aria-label', 'Edit callout source'); edit.title = 'Edit block'; edit.append(icon(wrapper.ownerDocument, CodeXml)); wrapper.append(edit);
    const editClick = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); reveal(); };
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented || event.detail > 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || (event.target as Element).closest(interactive + ',.is-collapsible > .callout-title')) return;
      const selection = wrapper.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && (wrapper.contains(selection.anchorNode) || wrapper.contains(selection.focusNode))) return;
      let textHit = false;
      for (const child of (event.target as Node).childNodes) if (child.nodeType === 3) {
        const range = wrapper.ownerDocument.createRange(); range.selectNodeContents(child);
        if ([...range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) { textHit = true; break; }
      }
      cancelActivation();
      let pending = pendingActivations.get(view); if (!pending) pendingActivations.set(view, pending = new Set());
      pending.add(cancelActivation);
      timer = setTimeout(() => { cancelActivation(); reveal(); }, textHit ? 150 : 10);
    };
    const down = (event: MouseEvent) => { if (event.detail > 1) cancelActivation(); };
    edit.addEventListener('click', editClick); wrapper.addEventListener('click', click); wrapper.addEventListener('mousedown', down);
    const Observer = view.dom.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    const observer = typeof Observer === 'function' ? new Observer(() => { if (!disposed) view.requestMeasure(); }) : undefined; observer?.observe(wrapper);
    resources.set(wrapper, () => { if (disposed) return; disposed = true; cancelActivation(); observer?.disconnect(); edit.removeEventListener('click', editClick); wrapper.removeEventListener('click', click); wrapper.removeEventListener('mousedown', down); releaseResources(cleanup); });
    return wrapper;
  }
  ignoreEvent(): boolean { return true; }
  destroy(dom: HTMLElement): void { resources.get(dom)?.(); resources.delete(dom); }
  get estimatedHeight(): number { return this.span.source.split('\n').length * 24; }
}

function searches(state: EditorState, spans: readonly Span[]): ReadonlySet<object> {
  const result = new Set<object>(), query = getSearchQuery(state);
  if (!searchPanelOpen(state) || !query.valid || !query.search) return result;
  // Full query ranges matter: a match may begin outside the quote or end after it.
  // This scan is cached until the document/tree/query/panel changes, never on caret motion.
  const cursor = query.getCursor(state); let index = 0;
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    while (index < spans.length && spans[index].to < match.value.from) index++;
    for (let current = index; current < spans.length && spans[current].from <= match.value.to; current++) result.add(spans[current].identity);
  }
  return result;
}
function decorate(state: EditorState, spans: readonly Span[], focused: boolean, searched: ReadonlySet<object>): Pick<CalloutState, 'decorations' | 'rendered'> {
  const rendered: { from: number; to: number }[] = [], decorations: ReturnType<Decoration['range']>[] = [];
  for (const span of spans) {
    if (searched.has(span.identity) || focused && state.selection.ranges.some(range => range.from <= span.to && range.to >= span.from)) continue;
    rendered.push({ from: span.from, to: span.to });
    decorations.push(Decoration.replace({ widget: new CalloutWidget(span, state.facet(optionsFacet), state.readOnly), block: true, inclusive: false }).range(span.from, span.to));
  }
  return { rendered, decorations: Decoration.set(decorations, true) };
}
const calloutField = StateField.define<CalloutState>({
  create(state) { const spans = discover(state), searched = searches(state, spans); return { spans, focused: false, held: false, searched, ...decorate(state, spans, false, searched) }; },
  update(value, transaction) {
    let { focused, held } = value;
    for (const effect of transaction.effects) if (effect.is(refresh)) { focused = effect.value.focused ?? focused; held = effect.value.held ?? held; }
    const changedTree = syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
    const spans = transaction.docChanged || changedTree ? discover(transaction.state, value.spans, transaction) : value.spans;
    const searched = transaction.docChanged || changedTree || getSearchQuery(transaction.startState) !== getSearchQuery(transaction.state) || searchPanelOpen(transaction.startState) !== searchPanelOpen(transaction.state) ? searches(transaction.state, spans) : value.searched;
    if (held) return { spans, focused, held, searched, decorations: value.decorations.map(transaction.changes), rendered: value.rendered.map(range => ({ from: transaction.changes.mapPos(range.from, 1), to: transaction.changes.mapPos(range.to, -1) })).filter(range => range.from < range.to) };
    if (spans === value.spans && searched === value.searched && focused === value.focused && held === value.held && !transaction.selection && transaction.startState.readOnly === transaction.state.readOnly && transaction.startState.facet(optionsFacet) === transaction.state.facet(optionsFacet)) return value;
    return { spans, focused, held, searched, ...decorate(transaction.state, spans, focused, searched) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

/** Optional lookup: overlap consumers need no extension ordering dependency. */
export function renderedCalloutRanges(state: EditorState): readonly { from: number; to: number }[] { return state.field(calloutField, false)?.rendered ?? []; }

/** Install in Live Edit. Root owns stylesheet imports and overlap consumers. */
export function liveCallouts(options: LiveCalloutOptions = {}): Extension {
  const interaction = ViewPlugin.fromClass(class {
    private disposed = false;
    private held = false;
    private timer?: ReturnType<typeof setTimeout>;
    private view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      view.dom.ownerDocument.addEventListener('mousedown', this.down, true);
      view.dom.ownerDocument.addEventListener('mouseup', this.release, true);
      view.dom.ownerDocument.addEventListener('dragend', this.release, true);
      view.dom.ownerDocument.defaultView?.addEventListener('blur', this.release);
      view.contentDOM.addEventListener('compositionstart', this.composeStart, true);
      view.contentDOM.addEventListener('compositionend', this.composeEnd, true);
      view.dom.addEventListener('focusin', this.focusChanged, true); view.dom.addEventListener('focusout', this.focusChanged, true);
    }
    private owns = (event: Event) => (event.target as Element | null)?.closest?.('.cm-editor') === this.view.dom;
    private down = (event: MouseEvent) => { cancelPendingActivation(this.view); if (event.button !== 0 || !this.owns(event)) return; clearTimeout(this.timer); this.held = true; this.view.dispatch({ effects: refresh.of({ held: true }) }); };
    private release = () => { if (!this.held) return; clearTimeout(this.timer); this.timer = setTimeout(() => { if (this.disposed) return; if (this.view.composing) { this.release(); return; } this.held = false; this.view.dispatch({ effects: refresh.of({ held: false, focused: this.view.hasFocus }) }); }, 50); };
    private composeStart = (event: Event) => { if (!this.owns(event)) return; this.held = true; clearTimeout(this.timer); this.view.dispatch({ effects: refresh.of({ held: true }) }); };
    private composeEnd = (event: Event) => { if (this.owns(event)) this.release(); };
    private focusChanged = () => { cancelPendingActivation(this.view); queueMicrotask(() => { if (!this.disposed) this.view.dispatch({ effects: refresh.of({ focused: this.view.hasFocus }) }); }); };
    update(update: ViewUpdate) { if (update.selectionSet) cancelPendingActivation(this.view); if (update.focusChanged) this.focusChanged(); }
    destroy() {
      this.disposed = true; clearTimeout(this.timer); cancelPendingActivation(this.view); pendingActivations.delete(this.view);
      this.view.dom.ownerDocument.removeEventListener('mousedown', this.down, true); this.view.dom.ownerDocument.removeEventListener('mouseup', this.release, true); this.view.dom.ownerDocument.removeEventListener('dragend', this.release, true); this.view.dom.ownerDocument.defaultView?.removeEventListener('blur', this.release);
      this.view.contentDOM.removeEventListener('compositionstart', this.composeStart, true); this.view.contentDOM.removeEventListener('compositionend', this.composeEnd, true);
      this.view.dom.removeEventListener('focusin', this.focusChanged, true); this.view.dom.removeEventListener('focusout', this.focusChanged, true);
    }
  });
  return [optionsFacet.of(options), calloutField, interaction];
}
