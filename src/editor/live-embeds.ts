import { renderExclusions, sameRenderExclusions, intersectsRenderExclusion } from './render-exclusions.ts';
import type { RenderExclusionOptions } from './render-exclusions.ts';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { EmbedRequest } from '../ui/markdown.ts';
import { bodyStart } from './live-properties.ts';
import { icon } from '../ui/icons.ts';

interface EmbedSpan {
  from: number;
  to: number;
  blockFrom: number;
  blockTo: number;
  block: boolean;
  request: EmbedRequest;
  identity: object;
}
interface EmbedState { exclusions: ReturnType<typeof renderExclusions>; spans: readonly EmbedSpan[]; revealed: object | null; decorations: DecorationSet }
type Renderer = (request: EmbedRequest) => { dom: HTMLElement; destroy: () => void };

const excludedNodes = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'Comment', 'CommentBlock', 'LiveInlineComment', 'Table', 'LinkReference', 'URL', 'LinkTitle', 'ZoridFrontmatter', 'ZoridMathInline', 'ZoridMathDisplay', 'ZoridMathBlock']);
const interactive = 'a, button, input, select, textarea, audio, video, iframe, object, embed, summary, .cm-editor, .interactive-child, [contenteditable]:not([contenteditable="false"]), [role="button"]';

type EmbedControlKind = 'loading' | 'unavailable' | 'unknown' | 'image' | 'audio' | 'video' | 'note' | 'pdf' | 'base' | 'canvas';
/** The renderer owns resolution. A filename alone must not advertise a viewer
 * that is unavailable (notably .base/.canvas until their renderer is mounted). */
function embedControlKind(root: HTMLElement): EmbedControlKind {
  if (root.querySelector(':scope > .embed-loading')) return 'loading';
  if (root.querySelector(':scope > .embed-error')) return 'unavailable';
  for (const [name, selector] of [
    ['image', '.image-embed'], ['audio', '.audio-embed'], ['video', '.video-embed'],
    ['pdf', '.pdf-embed'], ['base', '.bases-embed'], ['canvas', '.canvas-embed'],
  ] as const) if (root.matches(selector)) return name;
  if (root.matches('.markdown-embed')) return 'note';
  return 'unknown';
}

function unescape(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~ ])/g, '$1');
}

/** Discover syntax in this document only. Reference-style/multiline images are
 * intentionally left as source until their definition/offset handling exists. */
function findEmbeds(state: EditorState): Omit<EmbedSpan, 'identity'>[] {
  const tree = syntaxTree(state), prefix = bodyStart(state);
  const blocked: { from: number; to: number }[] = [];
  const found: { from: number; to: number; request: EmbedRequest }[] = [];
  tree.iterate({ enter(node) {
    if (excludedNodes.has(node.name)) { blocked.push({ from: node.from, to: node.to }); return false; }
    if (node.name !== 'Image') return;
    const source = state.doc.sliceString(node.from, node.to);
    if (source.startsWith('![[')) return false; // Wiki syntax is parsed below.
    const url = node.node.getChild('URL');
    const close = node.node.getChildren('LinkMark').find(mark => state.doc.sliceString(mark.from, mark.to) === ']');
    if (url && close && !source.includes('\n')) {
      const target = unescape(state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, ''));
      if (target) found.push({ from: node.from, to: node.to,
        request: { kind: 'markdown', target, label: unescape(state.doc.sliceString(node.from + 2, close.from)) } });
    } else blocked.push({ from: node.from, to: node.to });
    return false;
  } });
  // Wiki embeds aren't a native CommonMark node. Limit the lexical pass to the
  // parsed document, then exclude language-owned code/table/property regions.
  const source = state.doc.sliceString(0, tree.length);
  for (const match of source.matchAll(/!\[\[([^\]\r\n]+)\]\]/g)) {
    const from = match.index!, to = from + match[0].length;
    let slashes = 0;
    for (let index = from - 1; index >= 0 && source[index] === '\\'; index--) slashes++;
    if (slashes % 2) continue;
    const separator = match[1].indexOf('|');
    const target = (separator < 0 ? match[1] : match[1].slice(0, separator)).trim();
    if (target) found.push({ from, to, request: { kind: 'wiki', target,
      ...(separator < 0 ? {} : { label: match[1].slice(separator + 1).trim() }) } });
  }
  found.sort((left, right) => left.from - right.from || right.to - left.to);
  blocked.sort((left, right) => left.from - right.from);
  const result: Omit<EmbedSpan, 'identity'>[] = [];
  let previousEnd = -1, blockedIndex = 0;
  for (const span of found) {
    while (blockedIndex < blocked.length && blocked[blockedIndex].to <= span.from) blockedIndex++;
    if (span.from < prefix || span.from < previousEnd || (blockedIndex < blocked.length && blocked[blockedIndex].from < span.to)) continue;
    const line = state.doc.lineAt(span.from);
    const block = span.to <= line.to && !state.doc.sliceString(line.from, span.from).trim() && !state.doc.sliceString(span.to, line.to).trim();
    result.push({ ...span, block, blockFrom: block ? line.from : span.from, blockTo: block ? line.to : span.to });
    previousEnd = span.to;
  }
  return result;
}

/**
 * Persistent rendered wiki embeds and inline Markdown images for Live Edit.
 * Mount only in live mode. Render owns resources for one DOM instance and must
 * release them in destroy. Source editing keeps the rendered child mounted
 * after its editable syntax. Obsidian's separate image tooltip/selection/resize
 * keyboard model isn't implemented by this shared embed extension.
 */
export function liveEmbeds(render: Renderer, options: RenderExclusionOptions = {}): Extension {
  const reveal = StateEffect.define<object>();
  const mounted = new WeakMap<HTMLElement, () => void>();
  const editSource = (view: EditorView, identity: object) => {
    const span = view.state.field(field, false)?.spans.find(item => item.identity === identity);
    if (!span) return;
    view.focus();
    view.dispatch({ effects: reveal.of(identity), selection: { anchor: span.from, head: span.to },
      userEvent: 'select.pointer', scrollIntoView: true });
  };
  class EmbedWidget extends WidgetType {
    readonly span: EmbedSpan;
    constructor(span: EmbedSpan) { super(); this.span = span; }
    eq(other: WidgetType): boolean {
      if (!(other instanceof EmbedWidget)) return false;
      const left = this.span, right = other.span;
      return left.identity === right.identity && left.block === right.block && left.request.kind === right.request.kind
        && left.request.target === right.request.target && left.request.label === right.request.label;
    }
    toDOM(view: EditorView): HTMLElement {
      const wrapper: HTMLElement = view.dom.ownerDocument.createElement(this.span.block ? 'div' : 'span');
      wrapper.className = `cm-live-embed ${this.span.block ? 'cm-live-embed-block' : 'cm-live-embed-inline'}`;
      wrapper.contentEditable = 'false';
      const instance = render(this.span.request);
      wrapper.append(instance.dom);
      let disposed = false, action: HTMLButtonElement | undefined, noteLink: HTMLAnchorElement | undefined;
      const edit = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); if (!disposed) editSource(view, this.span.identity); };
      const links = new WeakMap<HTMLAnchorElement, { navigate: HTMLAnchorElement['onclick']; children: ChildNode[]; title: string; label: string | null; styled: boolean }>();
      // Retired anchors keep a guarded handler: nulling onclick would reenable
      // the browser's default href navigation on a retained detached element.
      const releaseNoteLink = () => { noteLink = undefined; };
      const updateControls = () => {
        if (disposed) return;
        const kind = embedControlKind(instance.dom);
        wrapper.dataset.embedType = kind;
        const needsSource = ['image', 'pdf', 'base', 'unknown', 'unavailable'].includes(kind);
        if (needsSource && !action) {
          action = view.dom.ownerDocument.createElement('button');
          action.type = 'button'; action.className = 'edit-block-button cm-live-embed-edit';
          action.append(icon('code', 16, view.dom.ownerDocument));
          action.title = 'Edit embed'; action.setAttribute('aria-label', 'Edit embed source');
          action.addEventListener('click', edit); wrapper.append(action);
        } else if (!needsSource && action) {
          action.removeEventListener('click', edit); action.remove(); action = undefined;
        }
        const link = kind === 'note' || kind === 'unavailable'
          ? instance.dom.querySelector<HTMLAnchorElement>(':scope > a.embed-open') : null;
        if (link !== noteLink) {
          releaseNoteLink();
          if (link) {
            noteLink = link;
            let saved = links.get(link);
            if (!saved) {
              saved = { navigate: link.onclick, children: [...link.childNodes], title: link.title, label: link.getAttribute('aria-label'), styled: false };
              links.set(link, saved);
              const capability = saved;
              link.onclick = event => {
                event.stopPropagation();
                if (disposed || noteLink !== link || !instance.dom.contains(link)) { event.preventDefault(); return; }
                return capability.navigate?.call(link, event);
              };
            }
          }
        }
        if (link) {
          const saved = links.get(link)!;
          if (kind === 'note' && !saved.styled) {
            link.classList.add('cm-live-embed-open');
            link.title = 'Open link'; link.setAttribute('aria-label', 'Open link');
            link.replaceChildren(icon('maximize', 16, view.dom.ownerDocument)); saved.styled = true;
          } else if (kind !== 'note' && saved.styled) {
            link.classList.remove('cm-live-embed-open'); link.title = saved.title;
            if (saved.label === null) link.removeAttribute('aria-label'); else link.setAttribute('aria-label', saved.label);
            link.replaceChildren(...saved.children); saved.styled = false;
          }
        }
      };
      updateControls();
      // Resolution may happen after a lazy renderer is attached. Observe only
      // its root, not nested content or the controls we own outside that root.
      const Mutation = view.dom.ownerDocument.defaultView?.MutationObserver;
      const controlsObserver = Mutation ? new Mutation(updateControls) : undefined;
      controlsObserver?.observe(instance.dom, { attributes: true, attributeFilter: ['class'], childList: true });
      const isInteractive = (event: Event) => {
        const target = event.target;
        if (!(target instanceof view.dom.ownerDocument.defaultView!.Element)) return false;
        // Images supplied by the shared renderer may already open a lightbox.
        const control = target.closest(interactive);
        return (!!control && wrapper.contains(control)) || (target.tagName === 'IMG' && typeof (target as HTMLElement).onclick === 'function');
      };
      const down = (event: MouseEvent) => { if (event.button === 0 && !isInteractive(event)) event.preventDefault(); };
      const click = (event: MouseEvent) => {
        if (event.defaultPrevented || event.button !== 0 || isInteractive(event)) return;
        event.preventDefault(); editSource(view, this.span.identity);
      };
      wrapper.addEventListener('mousedown', down); wrapper.addEventListener('click', click);
      const Observer = view.dom.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
      const observer = typeof Observer === 'function' ? new Observer(() => { if (!disposed) view.requestMeasure(); }) : undefined;
      observer?.observe(wrapper);
      mounted.set(wrapper, () => {
        if (disposed) return;
        disposed = true; observer?.disconnect(); controlsObserver?.disconnect(); releaseNoteLink();
        wrapper.removeEventListener('mousedown', down); wrapper.removeEventListener('click', click); action?.removeEventListener('click', edit);
        instance.destroy();
      });
      return wrapper;
    }
    ignoreEvent(): boolean { return true; }
    destroy(dom: HTMLElement): void { const dispose = mounted.get(dom); mounted.delete(dom); dispose?.(); }
    get estimatedHeight(): number { return this.span.block ? 100 : -1; }
  }
  const decorate = (spans: readonly EmbedSpan[], revealed: object | null, exclusions: ReturnType<typeof renderExclusions>) => Decoration.set(spans
    .filter(span => !intersectsRenderExclusion(exclusions, span.blockFrom, span.blockTo))
    .map(span => span.identity === revealed
      // A point widget leaves the source editable. Keeping the same widget
      // identity lets CodeMirror reuse its DOM, resources and embedded view
      // state when toggling between hidden and exposed source.
      ? Decoration.widget({ widget: new EmbedWidget(span), block: span.block, side: 1 }).range(span.blockTo)
      : Decoration.replace({ widget: new EmbedWidget(span), block: span.block, inclusive: false })
        .range(span.blockFrom, span.blockTo)), true);
  const field = StateField.define<EmbedState>({
    create(state) {
      const spans = findEmbeds(state).map(span => ({ ...span, identity: {} }));
      const exclusions = renderExclusions(state, options.excludes);
      return { spans, revealed: null, exclusions, decorations: decorate(spans, null, exclusions) };
    },
    update(previous, transaction) {
      let spans = previous.spans;
      const changed = transaction.docChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
      if (changed) {
        const cache = new Map<string, EmbedSpan>();
        for (const span of previous.spans) {
          const from = transaction.changes.mapPos(span.from, 1), to = transaction.changes.mapPos(span.to, -1);
          if (from < to) cache.set(`${from}:${to}`, span);
        }
        spans = findEmbeds(transaction.state).map(span => ({ ...span,
          // Both mapped boundaries must survive: a merge/split must not inherit
          // another embed's revealed state or mounted renderer ownership.
          identity: cache.get(`${span.from}:${span.to}`)?.identity ?? {} }));
      }
      let revealed = previous.revealed;
      for (const effect of transaction.effects) if (effect.is(reveal)) revealed = effect.value;
      if (revealed) {
        const active = spans.find(span => span.identity === revealed);
        if (!active || !transaction.newSelection.ranges.some(range => range.from <= active.to && range.to >= active.from)) revealed = null;
      }
      const exclusions = renderExclusions(transaction.state, options.excludes);
      return !changed && revealed === previous.revealed && sameRenderExclusions(exclusions, previous.exclusions) ? previous
        : { spans, revealed, exclusions, decorations: decorate(spans, revealed, exclusions) };
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  });
  return field;
}
