import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range, Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { bodyStart } from './live-properties.ts';
import { mathSpan } from './math-syntax.ts';
import type { MathSpan } from './math-syntax.ts';
import { renderMath } from '../ui/math-renderer.ts';
import type { MathRenderHandle, MathRenderOptions } from '../ui/math-renderer.ts';
export { mathMarkdown as liveMathMarkdown } from './math-syntax.ts';

export interface LiveMathOptions {
  /** Whole-block renderers own math inside these ranges. Install their state
   * fields before this extension so the callback sees the current transaction. */
  excludes?: (state: EditorState) => readonly { from: number; to: number }[];
  render?: (parent: HTMLElement, source: string, options: MathRenderOptions) => MathRenderHandle;
}
interface Span extends MathSpan { identity: object; blockFrom: number; blockTo: number }
interface Exclusion { from: number; to: number }
interface MathState { exclusions: readonly Exclusion[]; spans: readonly Span[]; focused: boolean; frozen: boolean; decorations: DecorationSet }
const excluded = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'Comment',
  'CommentBlock', 'LiveInlineComment', 'LiveInlineWiki', 'LiveInlineWikiEmbed', 'Image', 'Table', 'URL', 'LinkTitle']);

function discover(state: EditorState): Omit<Span, 'identity'>[] {
  const found: Omit<Span, 'identity'>[] = [], prefix = bodyStart(state);
  syntaxTree(state).iterate({ enter(node) {
    if (node.to <= prefix || excluded.has(node.name)) return false;
    const span = mathSpan(node.node, (from, to) => state.doc.sliceString(from, to));
    if (!span) return;
    if (span.closed && span.from >= prefix) {
      const first = state.doc.lineAt(span.from), last = state.doc.lineAt(span.to);
      const block = span.display && !state.doc.sliceString(first.from, span.from).trim()
        && !state.doc.sliceString(span.to, last.to).trim();
      found.push({ ...span, block, blockFrom: block ? first.from : span.from, blockTo: block ? last.to : span.to });
    }
    return false;
  } });
  return found;
}
function mapped(span: Span, transaction: Transaction): Span | null {
  let touched = false;
  transaction.changes.iterChangedRanges((from, to) => { if (from <= span.to && to >= span.from) touched = true; });
  if (touched) return null;
  const map = (position: number) => transaction.changes.mapPos(position, 1);
  return { ...span, from: map(span.from), to: map(span.to), contentFrom: map(span.contentFrom), contentTo: map(span.contentTo),
    blockFrom: map(span.blockFrom), blockTo: map(span.blockTo) };
}

/** Mount in Live Edit with liveMathMarkdown in the document's Markdown parser.
 * Math never rewrites the document. Focused inline math exposes source; display
 * math retains its preview after the source. Reading uses the shared renderer. */
export function liveMath(options: LiveMathOptions = {}): Extension {
  const render = options.render ?? renderMath;
  const exclusions = (state: EditorState): Exclusion[] => {
    const result: Exclusion[] = [];
    const sorted = (options.excludes?.(state) ?? []).filter(range => Number.isFinite(range.from) && Number.isFinite(range.to) && range.from < range.to)
      .map(range => ({ from: Math.max(0, range.from), to: Math.min(state.doc.length, range.to) }))
      .sort((left, right) => left.from - right.from || left.to - right.to);
    for (const range of sorted) {
      const previous = result.at(-1);
      if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
      else if (range.from < range.to) result.push(range);
    }
    return result;
  };
  const interaction = StateEffect.define<Partial<Pick<MathState, 'focused' | 'frozen'>>>();
  const mounted = new WeakMap<HTMLElement, () => void>();
  const edit = (view: EditorView, identity: object) => {
    const span = view.state.field(field, false)?.spans.find(item => item.identity === identity);
    if (!span) return;
    let anchor = span.contentFrom, head = span.contentTo;
    if (span.block && view.state.doc.sliceString(anchor, anchor + 1) === '\n') anchor++;
    if (span.block && head > anchor && view.state.doc.sliceString(head - 1, head) === '\n') head--;
    view.focus();
    view.dispatch({ selection: { anchor, head }, effects: interaction.of({ focused: true, frozen: false }),
      userEvent: 'select.pointer', scrollIntoView: true });
  };
  class MathWidget extends WidgetType {
    readonly span: Span;
    constructor(span: Span) { super(); this.span = span; }
    eq(other: WidgetType): boolean {
      return other instanceof MathWidget && other.span.identity === this.span.identity && other.span.tex === this.span.tex
        && other.span.block === this.span.block && other.span.display === this.span.display;
    }
    toDOM(view: EditorView): HTMLElement {
      const document = view.dom.ownerDocument;
      const wrapper: HTMLElement = document.createElement(this.span.block ? 'div' : 'span');
      wrapper.className = `cm-live-math ${this.span.block ? 'cm-live-math-block' : 'cm-live-math-inline'}`;
      wrapper.contentEditable = 'false';
      const output = document.createElement(this.span.block ? 'div' : 'span'); wrapper.append(output);
      let disposed = false;
      const handle = render(output, this.span.tex, { display: this.span.display, onReady: () => { if (!disposed) view.requestMeasure(); } });
      const control = (event: MouseEvent) => {
        const target = event.target as Element | null;
        const closest = target?.nodeType === 1 ? target.closest('a,button,input,select,textarea,[role="button"],.interactive-child') : null;
        return closest && wrapper.contains(closest);
      };
      const down = (event: MouseEvent) => { if (event.button === 0 && !control(event)) event.preventDefault(); };
      const click = (event: MouseEvent) => {
        if (event.button !== 0 || event.defaultPrevented || control(event)) return;
        event.preventDefault(); edit(view, this.span.identity);
      };
      wrapper.addEventListener('mousedown', down); wrapper.addEventListener('click', click);
      if (this.span.block) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'edit-block-button cm-live-math-edit';
        button.textContent = '</>'; button.title = 'Edit math'; button.setAttribute('aria-label', 'Edit math source');
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); edit(view, this.span.identity); });
        wrapper.append(button);
      }
      const Observer = document.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
      const observer = typeof Observer === 'function' ? new Observer(() => { if (!disposed) view.requestMeasure(); }) : undefined;
      observer?.observe(wrapper);
      mounted.set(wrapper, () => { disposed = true; observer?.disconnect(); handle.dispose(); });
      return wrapper;
    }
    ignoreEvent(): boolean { return true; }
    destroy(dom: HTMLElement): void { mounted.get(dom)?.(); mounted.delete(dom); }
    get estimatedHeight(): number { return this.span.block ? 50 : -1; }
  }
  const decorate = (state: EditorState, spans: readonly Span[], focused: boolean, blocked: readonly Exclusion[]) => {
    const ranges: Range<Decoration>[] = [];
    let blockedIndex = 0;
    for (const span of spans) {
      while (blockedIndex < blocked.length && blocked[blockedIndex].to <= span.blockFrom) blockedIndex++;
      if (blockedIndex < blocked.length && blocked[blockedIndex].from < span.blockTo) continue;
      const active = focused && state.selection.ranges.some(range => range.from <= span.to && range.to >= span.from);
      if (active) {
        ranges.push(Decoration.mark({ class: 'cm-math cm-live-math-source' }).range(span.from, span.to));
        ranges.push(Decoration.mark({ class: 'cm-formatting-math' }).range(span.from, span.contentFrom));
        ranges.push(Decoration.mark({ class: 'cm-formatting-math' }).range(span.contentTo, span.to));
        if (span.display) ranges.push(Decoration.widget({ widget: new MathWidget(span), block: span.block, side: 1 }).range(span.blockTo));
      } else ranges.push(Decoration.replace({ widget: new MathWidget(span), block: span.block, inclusive: false }).range(span.blockFrom, span.blockTo));
    }
    return Decoration.set(ranges, true);
  };
  const field = StateField.define<MathState>({
    create(state) {
      const spans = discover(state).map(span => ({ ...span, identity: {} }));
      const blocked = exclusions(state);
      return { spans, focused: false, frozen: false, exclusions: blocked, decorations: decorate(state, spans, false, blocked) };
    },
    update(previous, transaction) {
      let { focused, frozen, spans } = previous;
      for (const effect of transaction.effects) if (effect.is(interaction)) {
        focused = effect.value.focused ?? focused; frozen = effect.value.frozen ?? frozen;
      }
      const treeChanged = syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
      if (transaction.docChanged || treeChanged) {
        const retained = previous.spans.flatMap(span => { const next = mapped(span, transaction); return next ? [next] : []; });
        const identities = new Map(retained.map(span => [`${span.from}:${span.to}:${span.display}:${span.tex}`, span.identity]));
        const parsed = discover(transaction.state);
        const parsedTo = syntaxTree(transaction.state).length;
        // A time-sliced parser can temporarily lack the unchanged tail. Keep
        // only untouched old spans beyond its known extent, never guess new ones.
        spans = [...parsed.map(span => ({ ...span, identity: identities.get(`${span.from}:${span.to}:${span.display}:${span.tex}`) ?? {} })),
          ...retained.filter(span => span.from >= parsedTo)];
      }
      const blocked = exclusions(transaction.state);
      const exclusionsChanged = blocked.length !== previous.exclusions.length || blocked.some((range, index) =>
        range.from !== previous.exclusions[index].from || range.to !== previous.exclusions[index].to);
      // Whole-block ownership takes precedence if another renderer changes its
      // range during an interaction; overlapping block replacements are invalid.
      if (frozen && !exclusionsChanged) return { spans, focused, frozen, exclusions: blocked, decorations: previous.decorations.map(transaction.changes) };
      if (!exclusionsChanged && spans === previous.spans && focused === previous.focused && frozen === previous.frozen && !transaction.selection) return previous;
      return { spans, focused, frozen, exclusions: blocked, decorations: decorate(transaction.state, spans, focused, blocked) };
    },
    provide: value => EditorView.decorations.from(value, state => state.decorations),
  });
  const events = ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | undefined;
    pointer = false; composing = false; destroyed = false; focusPending = false;
    readonly view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      view.scrollDOM.addEventListener('mousedown', this.down, true);
      view.dom.ownerDocument.addEventListener('mouseup', this.up, true);
      view.dom.ownerDocument.addEventListener('dragend', this.up, true);
      view.contentDOM.addEventListener('compositionstart', this.start, true);
      view.contentDOM.addEventListener('compositionend', this.end, true);
      view.contentDOM.addEventListener('focus', this.focus, true);
      view.contentDOM.addEventListener('blur', this.blur, true);
      view.dom.ownerDocument.defaultView?.addEventListener('blur', this.up);
    }
    owns = (target: EventTarget | null) => !!target && (target as Element).nodeType === 1
      && (target as Element).closest('.cm-editor') === this.view.dom;
    change = (value: Partial<Pick<MathState, 'focused' | 'frozen'>>) => {
      if (this.destroyed) return;
      const current = this.view.state.field(field, false);
      if (!current || (value.focused === undefined || value.focused === current.focused)
        && (value.frozen === undefined || value.frozen === current.frozen)) return;
      this.view.dispatch({ effects: interaction.of(value) });
    };
    down = (event: MouseEvent) => { if (event.button === 0 && this.owns(event.target)) { this.pointer = true; clearTimeout(this.timer); this.change({ frozen: true }); } };
    up = () => { if (this.pointer) { this.pointer = false; this.schedule(50); } };
    start = (event: Event) => { if (this.owns(event.target)) { this.composing = true; clearTimeout(this.timer); this.change({ frozen: true }); } };
    end = (event: Event) => { if (this.owns(event.target)) { this.composing = false; this.schedule(20); } };
    // A panel can move focus while CodeMirror is mounting it during an update.
    // Dispatch after that stack, sampling the latest focus rather than replaying
    // an obsolete blur when another control has already returned focus.
    focus = (event: Event) => {
      if (event.target !== this.view.contentDOM || this.destroyed || this.focusPending) return;
      this.focusPending = true;
      queueMicrotask(() => {
        this.focusPending = false;
        if (!this.destroyed) this.change({ focused: this.view.hasFocus });
      });
    };
    blur = this.focus;
    schedule(delay: number): void {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.destroyed || this.pointer) return;
        if (this.composing || this.view.composing) { this.schedule(20); return; }
        this.change({ frozen: false, focused: this.view.hasFocus });
      }, delay);
    }
    destroy(): void {
      this.destroyed = true; clearTimeout(this.timer);
      this.view.scrollDOM.removeEventListener('mousedown', this.down, true);
      this.view.dom.ownerDocument.removeEventListener('mouseup', this.up, true);
      this.view.dom.ownerDocument.removeEventListener('dragend', this.up, true);
      this.view.contentDOM.removeEventListener('compositionstart', this.start, true);
      this.view.contentDOM.removeEventListener('compositionend', this.end, true);
      this.view.contentDOM.removeEventListener('focus', this.focus, true);
      this.view.contentDOM.removeEventListener('blur', this.blur, true);
      this.view.dom.ownerDocument.defaultView?.removeEventListener('blur', this.up);
    }
  });
  return [field, events];
}
