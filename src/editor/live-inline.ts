import { renderExclusions, sameRenderExclusions, intersectsRenderExclusion } from './render-exclusions.ts';
import type { RenderExclusionOptions } from './render-exclusions.ts';
import { StateEffect } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { bodyStart } from './live-properties.ts';

type MarkdownExtension = NonNullable<NonNullable<Parameters<typeof markdown>[0]>['extensions']>;
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];
const highlight = { resolve: 'LiveInlineHighlight', mark: 'LiveInlineHighlightMark' };

/** Add to the existing markdown({extensions: ...}) configuration. Keeping these
 * nodes in the editor's one incremental tree also gates syntax inside code.
 * Embed renderers must exclude LiveInlineComment, just like HTML comments.
 */
export const liveInlineMarkdown: MarkdownExtension = {
  defineNodes: ['LiveInlineWiki', 'LiveInlineWikiEmbed', 'LiveInlineComment', 'LiveInlineHighlight', 'LiveInlineHighlightMark'],
  parseInline: [
    { name: 'LiveInlineWiki', before: 'Link', parse(context, next, from) {
      if (context.hasOpenLink || (next !== 91 && next !== 33)) return -1;
      const start = from + (next === 33 ? 1 : 0);
      if (context.slice(start, start + 2) !== '[[') return -1;
      const closing = context.text.indexOf(']]', start + 2 - context.offset);
      if (closing < 0) return -1;
      const content = context.slice(start + 2, closing + context.offset);
      if (!content.trim() || /[\r\n]/.test(content) || content.includes('[[')) return -1;
      return context.addElement(context.elt(next === 33 ? 'LiveInlineWikiEmbed' : 'LiveInlineWiki', from, closing + context.offset + 2));
    } },
    { name: 'LiveInlineComment', before: 'HTMLTag', parse(context, next, from) {
      if (next !== 37 || context.char(from + 1) !== 37) return -1;
      const closing = context.text.indexOf('%%', from + 2 - context.offset);
      if (closing < 0 || /[\r\n]/.test(context.slice(from, closing + context.offset))) return -1;
      return context.addElement(context.elt('LiveInlineComment', from, closing + context.offset + 2));
    } },
    { name: 'LiveInlineHighlight', before: 'Emphasis', parse(context, next, from) {
      if (next !== 61 || context.char(from + 1) !== 61 || context.char(from - 1) === 61 || context.char(from + 2) === 61) return -1;
      const before = context.slice(from - 1, from), after = context.slice(from + 2, from + 3);
      return context.addDelimiter(highlight, from, from + 2, !!after && !/\s/u.test(after), !!before && !/\s/u.test(before));
    } },
  ],
};

export interface LiveInlineOptions extends RenderExclusionOptions {
  /** Workspace owns navigation/disposition. The original event preserves
   * Ctrl/Meta/Shift and middle-button information; this module opens no URL. */
  open?: (target: string, kind: 'wiki' | 'markdown', event: MouseEvent) => void;
  /** Called for wiki targets, with source path captured by the workspace.
   * Omit when resolution is unknown; missing files are still navigable. */
  isUnresolved?: (target: string, kind: 'wiki' | 'markdown') => boolean;
  /** Internal-link hover notification; the workspace owns preview policy/UI. */
  onHover?: (target: string, kind: 'wiki' | 'markdown', event: MouseEvent, targetEl: HTMLElement) => void;
}

interface LinkSpan { from: number; to: number; labelFrom: number; labelTo: number; target: string; kind: 'wiki' | 'markdown'; safe: boolean }
const excluded = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'Comment', 'CommentBlock',
  'Table', 'LinkReference', 'Image', 'LiveInlineWikiEmbed', 'ZoridMathInline', 'ZoridMathDisplay', 'ZoridMathBlock']);
const formatClasses: Record<string, string> = { Emphasis: 'cm-live-emphasis', StrongEmphasis: 'cm-strong',
  Strikethrough: 'cm-strike', LiveInlineHighlight: 'cm-highlight' };
/** Dispatch after metadata changes that can affect existing link resolution. */
export const refreshLiveInline = StateEffect.define<void>();

function decodeTarget(value: string, document: Document): string {
  value = value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  return value.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, entity => {
    // Only a validated entity enters an inert text decoder. Note HTML never
    // enters the DOM, and the resulting target is independently checked below.
    const decoder = document.createElement('textarea'); decoder.innerHTML = entity; return decoder.value;
  });
}

function safeTarget(target: string): boolean {
  const compact = target.replace(/[\s\u0000-\u001f\u007f]/gu, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1].toLowerCase();
  return !scheme || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

function linkSpan(state: EditorState, node: SyntaxNode, document: Document): LinkSpan | null {
  let target: string, labelFrom: number, labelTo: number, kind: 'wiki' | 'markdown' = 'markdown';
  if (node.name === 'LiveInlineWiki') {
    const source = state.doc.sliceString(node.from, node.to);
    const content = source.slice(2, -2), divider = content.indexOf('|');
    const rawTarget = divider > 0 ? content.slice(0, divider) : content;
    target = rawTarget.trim().replace(/\\$/, '').replace(/\u00a0/g, ' ').normalize('NFC');
    const label = divider > 0 ? content.slice(divider + 1) : content;
    labelFrom = node.from + 2 + (divider > 0 ? divider + 1 : 0) + label.length - label.trimStart().length;
    labelTo = node.to - 2 - (label.length - label.trimEnd().length);
    if (divider <= 0 && label.trimStart().startsWith('#') && labelTo > labelFrom + 1) labelFrom++;
    kind = 'wiki';
  } else if (node.name === 'Link') {
    // Direct destinations are near the end of a Link. Do not enumerate a
    // potentially long formatted label or unsupported reference-link label.
    const last = node.lastChild;
    if (!last || state.doc.sliceString(last.from, last.to) !== ')') return null;
    let url: SyntaxNode | null = null, closing: SyntaxNode | null = null;
    for (let child: SyntaxNode | null = last; child; child = child.prevSibling) {
      if (child.name === 'URL') url = child;
      if (child.name === 'LinkMark' && state.doc.sliceString(child.from, child.to) === ']') { closing = child; break; }
    }
    if (!url || !closing || state.doc.sliceString(node.from, node.from + 2) === '[^') return null;
    target = decodeTarget(state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, ''), document);
    labelFrom = node.firstChild!.to; labelTo = closing.from;
  } else if (node.name === 'Autolink' || node.name === 'URL') {
    const source = state.doc.sliceString(node.from, node.to);
    target = source;
    labelFrom = node.from; labelTo = node.to;
    if (node.name === 'Autolink') { target = source.slice(1, -1); labelFrom++; labelTo--; }
    if (target.startsWith('www.')) target = `https://${target}`;
    else if (/^[^:/\s]+@[^/\s]+$/.test(target)) target = `mailto:${target}`;
    target = decodeTarget(target, document);
  } else return null;
  if (!target || labelFrom >= labelTo) return null;
  const safe = safeTarget(target);
  if (kind === 'markdown' && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    try { target = decodeURI(target); } catch { /* Keep malformed encoding literal. */ }
  }
  return { from: node.from, to: node.to, labelFrom, labelTo, target, kind, safe: safe && safeTarget(target) };
}

function linkAt(view: EditorView, position: number): LinkSpan | null {
  if (position < bodyStart(view.state)) return null;
  for (const side of [1, -1] as const) {
    const ancestry: SyntaxNode[] = [];
    for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(position, side); node; node = node.parent) ancestry.push(node);
    if (ancestry.some(node => excluded.has(node.name) || node.name === 'InlineCode' || node.name === 'LiveInlineComment')) continue;
    // Prefer the complete Link/Autolink over its URL child (the source target
    // is also clickable with a modifier, but has no independent ownership).
    const owner = ancestry.find(node => ['LiveInlineWiki', 'Link', 'Autolink'].includes(node.name))
      ?? ancestry.find(node => node.name === 'URL');
    if (owner) return linkSpan(view.state, owner, view.dom.ownerDocument);
  }
  return null;
}

function decorate(view: EditorView, options: LiveInlineOptions): { decorations: DecorationSet; atomic: DecorationSet } {
  const ranges: ReturnType<Decoration['range']>[] = [], hidden: ReturnType<Decoration['range']>[] = [];
  const blocked = renderExclusions(view.state, options.excludes);
  const prefix = bodyStart(view.state), tree = syntaxTree(view.state), headingLines = new Set<number>();
  const visibleChildren = (parent: SyntaxNode, callback: (child: SyntaxNode) => void): void => {
    const seen = new Set<number>();
    for (const visible of view.visibleRanges) {
      // childAfter seeks through Lezer's balanced tree, including a child
      // ending at the visible boundary. Starting at the parent keeps outer
      // formatting/heading ownership when only its middle is visible.
      for (let child = parent.childAfter(visible.from - 1); child && child.from <= visible.to; child = child.nextSibling) {
        if (seen.has(child.from)) continue;
        seen.add(child.from); callback(child);
      }
    }
  };
  const matches: { from: number; to: number }[] = [];
  const query = getSearchQuery(view.state);
  if (searchPanelOpen(view.state) && query.valid && query.search) {
    for (const visible of view.visibleRanges) {
      const cursor = query.getCursor(view.state, visible.from, visible.to);
      for (let next = cursor.next(); !next.done; next = cursor.next()) matches.push(next.value);
    }
  }
  const active = (from: number, to: number): boolean =>
    (view.hasFocus && view.state.selection.ranges.some(range => range.from <= to && range.to >= from))
    || matches.some(range => range.from <= to && range.to >= from);
  const replace = (from: number, to: number): void => {
    if (from >= to) return;
    // ViewPlugin replacements cannot consume line breaks. Preserve them as
    // real editable lines, including multiline code and link destinations.
    for (let start = from; start < to;) {
      const line = view.state.doc.lineAt(start), end = Math.min(line.to, to);
      if (start < end) { const range = Decoration.replace({ inclusive: false }).range(start, end); ranges.push(range); hidden.push(range); }
      start = line.to + 1;
    }
  };
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>): void => {
    if (from < to) ranges.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  const visit = (node: SyntaxNode, inheritedReveal = false): void => {
    if (node.to <= prefix || excluded.has(node.name) || intersectsRenderExclusion(blocked, node.from, node.to) && blocked.some(range => range.from <= node.from && range.to >= node.to)
      || !view.visibleRanges.some(range => node.from <= range.to && node.to >= range.from)) return;
    const line = view.state.doc.lineAt(node.from);
    if (/^(ATX|Setext)Heading[1-6]$/.test(node.name)) {
      const level = node.name.slice(-1), reveal = active(line.from, view.state.doc.lineAt(node.to).to);
      if (!headingLines.has(line.from)) {
        headingLines.add(line.from);
        ranges.push(Decoration.line({ class: `cm-heading cm-heading-${level} cm-live-heading` }).range(line.from));
      }
      const markers = [node.firstChild, node.lastChild].filter((child, index, both): child is SyntaxNode =>
        !!child && child.name === 'HeaderMark' && (index === 0 || child.from !== both[0]?.from));
      if (!reveal) for (const marker of markers) {
        const markerLine = view.state.doc.lineAt(marker.from);
        if (marker.from === node.from && node.name.startsWith('ATX')) {
          const after = view.state.doc.sliceString(marker.to, markerLine.to).match(/^[ \t]*/)?.[0].length ?? 0;
          replace(marker.from, marker.to + after);
        } else replace(marker.from, marker.to);
      }
      visibleChildren(node, child => { if (child.name !== 'HeaderMark') visit(child, inheritedReveal || reveal); });
      return;
    }
    const reveal = inheritedReveal || active(node.from, node.to);
    if (formatClasses[node.name] && node.firstChild && node.lastChild && node.firstChild.from !== node.lastChild.from) {
      const first = node.firstChild, last = node.lastChild;
      mark(first.to, last.from, formatClasses[node.name]);
      if (!reveal) { replace(first.from, first.to); replace(last.from, last.to); }
      visibleChildren(node, child => { if (child.from >= first.to && child.to <= last.from) visit(child, reveal); });
      return;
    }
    if (node.name === 'InlineCode' && node.firstChild && node.lastChild && node.firstChild.from !== node.lastChild.from) {
      const first = node.firstChild, last = node.lastChild;
      mark(first.to, last.from, 'cm-live-code');
      if (!reveal) { replace(first.from, first.to); replace(last.from, last.to); }
      return;
    }
    if (node.name === 'Escape') {
      if (!inheritedReveal && !active(line.from, line.to)) replace(node.from, node.from + 1);
      return;
    }
    if (node.name === 'LiveInlineComment') {
      if (!reveal) replace(node.from, node.to);
      else mark(node.from, node.to, 'cm-live-comment-source');
      return;
    }
    const link = linkSpan(view.state, node, view.dom.ownerDocument);
    if (link) {
      if (link.kind === 'wiki') {
        const unresolved = options.isUnresolved?.(link.target, link.kind);
        mark(node.from + 2, node.to - 2, `cm-live-wiki${unresolved ? ' is-unresolved' : ''}`, {
          'data-live-inline-resolution': unresolved === undefined ? 'unknown' : unresolved ? 'unresolved' : 'resolved',
        });
        if (reveal) {
          mark(node.from, node.from + 2, 'cm-live-link-marker');
          mark(node.to - 2, node.to, 'cm-live-link-marker');
          const divider = view.state.doc.sliceString(node.from + 2, node.to - 2).indexOf('|');
          if (divider > 0) mark(node.from + 2 + divider, node.from + 3 + divider, 'cm-live-link-marker');
        }
      }
      mark(link.labelFrom, link.labelTo, `${link.safe ? 'cm-live-inline-link' : 'cm-live-inline-unsafe'}${link.kind === 'markdown' ? ' cm-live-markdown-link' : ''}`, {
        'data-live-inline-rendered': reveal ? 'false' : 'true',
        ...(link.safe ? { role: 'link' } : {}),
      });
      if (!reveal) { replace(node.from, link.labelFrom); replace(link.labelTo, node.to); }
      visibleChildren(node, child => { if (child.from >= link.labelFrom && child.to <= link.labelTo && child.name !== 'URL') visit(child, reveal); });
      return;
    }
    // Reference-style links and footnotes have no document resolution here.
    if (node.name === 'Link') return;
    visibleChildren(node, child => visit(child, inheritedReveal));
  };
  visibleChildren(tree.topNode, node => visit(node));
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(hidden, true) };
}

/** Install only in Live Edit, alongside liveInlineMarkdown and live-inline.css.
 * Markers are decorations, never document edits or a second editable surface.
 */
export function liveInline(options: LiveInlineOptions = {}): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    atomic: DecorationSet = Decoration.none;
    private pointer = false;
    private settling = false;
    private composition = false;
    private destroyed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private view: EditorView;
    private owns(target: EventTarget | null): boolean {
      const node = target as Node | null;
      if (!node || !this.view.contentDOM.contains(node)) return false;
      const element = node.nodeType === 1 ? node as Element : node.parentElement;
      return element?.closest('.cm-editor') === this.view.dom;
    }
    private down = (event: MouseEvent): void => {
      if (event.button !== 0 || !this.owns(event.target)) return;
      this.pointer = true; this.settling = false; clearTimeout(this.timer);
    };
    private release = (): void => {
      if (!this.pointer) return;
      this.pointer = false; this.settling = true; this.schedule(50);
    };
    private compose = (event: Event): void => {
      if (!this.owns(event.target)) return;
      this.composition = event.type === 'compositionstart';
      if (this.composition) clearTimeout(this.timer); else this.schedule(10);
    };
    private schedule(delay: number): void {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.destroyed || this.pointer || this.composition) return;
        if (this.view.composing) { this.schedule(20); return; }
        this.settling = false;
        // Refresh latest state only: delayed work never restores a captured
        // document or selection after another click, edit or external update.
        this.view.dispatch({ effects: refreshLiveInline.of() }); this.view.requestMeasure();
      }, delay);
    }
    constructor(view: EditorView) {
      this.view = view;
      if (syntaxTreeAvailable(view.state, view.viewport.to)) Object.assign(this, decorate(view, options));
      view.scrollDOM.addEventListener('mousedown', this.down, true);
      view.dom.ownerDocument.addEventListener('mouseup', this.release, true);
      view.dom.ownerDocument.addEventListener('dragend', this.release, true);
      view.dom.ownerDocument.defaultView?.addEventListener('blur', this.release);
      view.contentDOM.addEventListener('compositionstart', this.compose, true);
      view.contentDOM.addEventListener('compositionend', this.compose, true);
    }
    update(update: ViewUpdate): void {
      const ownershipChanged = !sameRenderExclusions(renderExclusions(update.startState, options.excludes), renderExclusions(update.state, options.excludes));
      if (!ownershipChanged && (this.pointer || this.settling || this.composition || update.view.composing || !syntaxTreeAvailable(update.state, update.view.viewport.to))) {
        this.decorations = this.decorations.map(update.changes); this.atomic = this.atomic.map(update.changes);
      } else if (ownershipChanged || update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
        || syntaxTree(update.startState) !== syntaxTree(update.state)
        || getSearchQuery(update.startState) !== getSearchQuery(update.state)
        || searchPanelOpen(update.startState) !== searchPanelOpen(update.state)
        || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshLiveInline)))) Object.assign(this, decorate(update.view, options));
    }
    hover(event: MouseEvent): boolean {
      if (!options.onHover || !this.owns(event.target)) return false;
      const node = event.target as Node, element = node.nodeType === 1 ? node as Element : node.parentElement;
      const target = element?.closest<HTMLElement>('.cm-live-wiki');
      const related = event.relatedTarget as Node | null;
      if (!target || (related?.nodeType && target.contains(related))
        || element?.closest('button,input,textarea,select,.interactive-child,.cm-live-embed,[contenteditable="false"]')) return false;
      let position: number;
      try { position = this.view.posAtDOM(target); } catch { return false; }
      const link = linkAt(this.view, position);
      if (link?.safe && link.kind === 'wiki') options.onHover(link.target, link.kind, event, target);
      // A notification must not consume native hover/selection events.
      return false;
    }
    follow(event: MouseEvent, middle = false): boolean {
      if (!options.open || event.defaultPrevented || !this.owns(event.target) || (middle ? event.button !== 1 : event.button !== 0)) return false;
      const target = event.target as Node, element = target.nodeType === 1 ? target as Element : target.parentElement;
      if (!element || element.closest('button,input,textarea,select,audio,video,iframe,.interactive-child,.cm-live-embed,[contenteditable="false"]')) return false;
      const modified = event.ctrlKey || event.metaKey || middle;
      const label = element.closest<HTMLElement>('.cm-live-inline-link,.cm-live-inline-unsafe');
      if (label?.classList.contains('cm-live-inline-unsafe')) return false;
      if (!modified && (event.altKey || event.shiftKey || label?.dataset.liveInlineRendered !== 'true')) return false;
      const selection = this.view.dom.ownerDocument.getSelection();
      if (!modified && selection && !selection.isCollapsed &&
        (label?.contains(selection.anchorNode) || label?.contains(selection.focusNode))) return false;
      let position: number | null = null;
      // Rendered DOM mapping stays valid during the pointer freeze, even if
      // marks moved through a concurrent transaction. Never trust stored URLs.
      try { if (label) position = this.view.posAtDOM(label); } catch { /* Detached DOM falls back to measured coordinates. */ }
      position ??= this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return false;
      const link = linkAt(this.view, position);
      if (!link?.safe) return false;
      if (!modified && this.view.state.selection.ranges.some(range => !range.empty && range.from <= link.to && range.to >= link.from)) return false;
      event.preventDefault(); options.open(link.target, link.kind, event); return true;
    }
    destroy(): void {
      this.destroyed = true; clearTimeout(this.timer);
      this.view.scrollDOM.removeEventListener('mousedown', this.down, true);
      this.view.dom.ownerDocument.removeEventListener('mouseup', this.release, true);
      this.view.dom.ownerDocument.removeEventListener('dragend', this.release, true);
      this.view.dom.ownerDocument.defaultView?.removeEventListener('blur', this.release);
      this.view.contentDOM.removeEventListener('compositionstart', this.compose, true);
      this.view.contentDOM.removeEventListener('compositionend', this.compose, true);
    }
  }, { decorations: value => value.decorations,
    provide: extension => EditorView.atomicRanges.of(view => view.plugin(extension)?.atomic ?? Decoration.none),
    eventHandlers: { click(event) { return this.follow(event); }, mousedown(event) { return event.button === 1 && this.follow(event, true); },
      mouseover(event) { return this.hover(event); } },
  });
  return plugin;
}
