import { StateEffect } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { bodyStart } from './live-properties.ts';
import { codeCopyText, codeTokenColor, codeLanguage, defaultCodeHighlighter, validTokens } from './code-highlight.ts';
import type { CodeHighlightOptions, CodeToken } from './code-highlight.ts';
import { createCodeCopyButton } from '../ui/code-block.ts';

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];
interface Segment { from: number; to: number; codeFrom: number }
interface Fence { from: number; to: number; openingTo: number; closingFrom?: number; info: string; language: string; code: string; segments: Segment[] }
export interface LiveFenceOptions extends CodeHighlightOptions { /** Languages owned by specialized renderers (for example Mermaid). */ handledLanguages?: ReadonlySet<string> }
export const refreshLiveFences = StateEffect.define<void>();

function fenceFromNode(state: EditorState, node: SyntaxNode): Fence {
  const first = node.firstChild!, last = node.lastChild!, openingTo = state.doc.lineAt(first.to).to;
  const infoNode = node.getChild('CodeInfo'), info = infoNode ? state.sliceDoc(infoNode.from, infoNode.to) : '';
  const segments: Segment[] = []; let code = '';
  for (const text of node.getChildren('CodeText')) {
    segments.push({ from: text.from, to: text.to, codeFrom: code.length }); code += state.sliceDoc(text.from, text.to);
  }
  return { from: node.from, to: node.to, openingTo, closingFrom: last.name === 'CodeMark' && last.from !== first.from ? last.from : undefined,
    info, language: codeLanguage(info), code, segments };
}
/** Seek only intersecting syntax branches, including a fence that starts above the viewport. */
function visibleFences(view: EditorView, cache: Map<number, Fence>): Fence[] {
  const found = new Map<number, Fence>(), prefix = bodyStart(view.state);
  const visit = (node: SyntaxNode, from: number, to: number): void => {
    if (node.to < from || node.from > to || node.to < prefix) return;
    if (node.name === 'FencedCode') {
      if (!found.has(node.from)) { let fence = cache.get(node.from); if (!fence || fence.to !== node.to) { fence = fenceFromNode(view.state, node); cache.set(node.from, fence); } found.set(node.from, fence); }
      return;
    }
    // Code, inline syntax and HTML cannot contain Markdown fences.
    if (['CodeBlock', 'HTMLBlock', 'Paragraph', 'Table'].includes(node.name)) return;
    for (let child = node.childAfter(Math.max(node.from, from - 1)); child && child.from <= to; child = child.nextSibling) visit(child, from, to);
  };
  for (const range of view.visibleRanges) visit(syntaxTree(view.state).topNode, range.from, range.to);
  return [...found.values()];
}
function currentFence(view: EditorView, dom: HTMLElement): Fence | null {
  if (!dom.isConnected || !view.dom.contains(dom)) return null;
  let position: number; try { position = view.posAtDOM(dom); } catch { return null; }
  if (!syntaxTreeAvailable(view.state, position)) return null;
  for (const side of [-1, 1] as const) for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(position, side); node; node = node.parent) {
    if (node.name === 'FencedCode') return fenceFromNode(view.state, node);
  }
  return null;
}
const flairCleanup = new WeakMap<HTMLElement, () => void>();
class CopyFlair extends WidgetType {
  readonly language: string;
  readonly options: CodeHighlightOptions;
  constructor(language: string, options: CodeHighlightOptions) { super(); this.language = language; this.options = options; }
  eq(other: CopyFlair): boolean { return other.language === this.language && other.options === this.options; }
  toDOM(view: EditorView): HTMLElement {
    const control = createCodeCopyButton(view.dom.ownerDocument, () => {
      const fence = currentFence(view, control.element); return fence ? codeCopyText(fence.code) : null;
    }, this.options, this.language);
    control.element.classList.add('cm-fence-flair'); flairCleanup.set(control.element, control.destroy); return control.element;
  }
  ignoreEvent(): boolean { return true; }
  destroy(dom: HTMLElement): void { flairCleanup.get(dom)?.(); flairCleanup.delete(dom); }
}
interface HighlightJob { code: string; language: string; controller: AbortController; tokens?: readonly CodeToken[]; failed?: boolean }

/** Ordinary fences remain editable source; only complete fence markers are concealed. */
export function liveFences(options: LiveFenceOptions = {}): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    atomic: DecorationSet = Decoration.none;
    private jobs = new Map<string, HighlightJob>();
    private fenceCache = new Map<number, Fence>();
    private cachedTree?: ReturnType<typeof syntaxTree>;
    private cachedDoc?: EditorState['doc'];
    private pointer = false;
    private settling = false;
    private composition = false;
    private closed = false;
    private timer?: ReturnType<typeof setTimeout>;
    readonly view: EditorView;
    constructor(view: EditorView) {
      this.view = view; this.rebuild();
      view.scrollDOM.addEventListener('mousedown', this.down, true);
      view.dom.ownerDocument.addEventListener('mouseup', this.release, true);
      view.dom.ownerDocument.addEventListener('dragend', this.release, true);
      view.dom.ownerDocument.defaultView?.addEventListener('blur', this.release);
      view.contentDOM.addEventListener('compositionstart', this.compose, true);
      view.contentDOM.addEventListener('compositionend', this.compose, true);
    }
    private owns(target: EventTarget | null): boolean {
      const node = target as Node | null;
      if (!node || !this.view.contentDOM.contains(node)) return false;
      return (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('.cm-editor') === this.view.dom;
    }
    private down = (event: MouseEvent) => { if (event.button === 0 && this.owns(event.target) && !(event.target as Element).closest?.('button')) { this.pointer = true; this.settling = false; clearTimeout(this.timer); } };
    private release = () => { if (this.pointer) { this.pointer = false; this.settling = true; this.schedule(50); } };
    private compose = (event: Event) => { if (!this.owns(event.target)) return; this.composition = event.type === 'compositionstart'; if (this.composition) clearTimeout(this.timer); else this.schedule(10); };
    private schedule(delay = 0): void {
      clearTimeout(this.timer); this.timer = setTimeout(() => {
        if (this.closed || this.pointer || this.composition) return;
        if (this.view.composing) { this.schedule(20); return; }
        this.settling = false; this.view.dispatch({ effects: refreshLiveFences.of() });
      }, delay);
    }
    private tokens(fence: Fence, retained: Set<string>): readonly CodeToken[] {
      if (!fence.language || !fence.code) return [];
      const key = fence.language + '\0' + fence.code; retained.add(key);
      let job = this.jobs.get(key);
      if (!job) {
        job = { code: fence.code, language: fence.language, controller: new AbortController() }; this.jobs.set(key, job);
        const owned = job, highlight = options.highlight ?? defaultCodeHighlighter(this.view.dom.ownerDocument);
        // Promise entry also captures a synchronous host highlighter exception.
        void Promise.resolve().then(() => highlight(owned.code, owned.language, owned.controller.signal)).then(tokens => {
          if (this.closed || owned.controller.signal.aborted || this.jobs.get(key) !== owned) return;
          owned.tokens = validTokens(tokens, owned.code.length);
          if (!this.pointer && !this.settling && !this.composition && !this.view.composing) this.schedule();
        }).catch(error => {
          if (this.closed || owned.controller.signal.aborted || this.jobs.get(key) !== owned) return;
          owned.failed = true; try { options.onError?.(error); } catch { /* Highlight failures leave editable source. */ }
        });
      }
      return job.tokens ?? [];
    }
    private rebuild(): void {
      const view = this.view;
      if (!syntaxTreeAvailable(view.state, view.viewport.to)) return;
      const ranges: ReturnType<Decoration['range']>[] = [], atomic: ReturnType<Decoration['range']>[] = [], retained = new Set<string>(), lines = new Set<number>();
      const query = searchPanelOpen(view.state) ? getSearchQuery(view.state) : null;
      const tree = syntaxTree(view.state);
      if (this.cachedDoc !== view.state.doc || this.cachedTree !== tree) { this.fenceCache.clear(); this.cachedDoc = view.state.doc; this.cachedTree = tree; }
      const visible = visibleFences(view, this.fenceCache);
      const visibleStarts = new Set(visible.map(fence => fence.from));
      for (const from of this.fenceCache.keys()) if (!visibleStarts.has(from)) this.fenceCache.delete(from);
      for (const fence of visible) {
        if (options.handledLanguages?.has(fence.language)) continue;
        let reveal = view.hasFocus && view.state.selection.ranges.some(range => range.from <= fence.to && range.to >= fence.from);
        if (!reveal && query?.valid) { const cursor = query.getCursor(view.state, fence.from, fence.to); reveal = !cursor.next().done; }
        const firstLine = view.state.doc.lineAt(fence.from).number, lastLine = view.state.doc.lineAt(fence.to).number;
        for (const visible of view.visibleRanges) {
          const start = Math.max(firstLine, view.state.doc.lineAt(Math.max(visible.from, fence.from)).number), end = Math.min(lastLine, view.state.doc.lineAt(Math.min(visible.to, fence.to)).number);
          for (let number = start; number <= end; number++) {
            const line = view.state.doc.line(number); if (lines.has(line.from)) continue; lines.add(line.from);
            ranges.push(Decoration.line({ class: `cm-fenced-code${number === firstLine ? ' cm-fence-start' : ''}${number === lastLine ? ' cm-fence-end' : ''}`, attributes: { 'data-code-language': fence.language } }).range(line.from));
          }
        }
        if (fence.closingFrom !== undefined && !reveal) {
          for (const [from, to] of [[fence.from, fence.openingTo], [fence.closingFrom, fence.to]]) if (to > from) {
            const range = Decoration.replace({ inclusive: false }).range(from, to); ranges.push(range); atomic.push(range);
          }
          ranges.push(Decoration.widget({ widget: new CopyFlair(fence.language, options), side: 1 }).range(fence.openingTo));
        }
        let segmentIndex = 0;
        for (const token of this.tokens(fence, retained)) {
          while (segmentIndex < fence.segments.length && fence.segments[segmentIndex].codeFrom + fence.segments[segmentIndex].to - fence.segments[segmentIndex].from <= token.from) segmentIndex++;
          for (let index = segmentIndex; index < fence.segments.length && fence.segments[index].codeFrom < token.to; index++) {
          const segment = fence.segments[index];
          const from = Math.max(token.from, segment.codeFrom), to = Math.min(token.to, segment.codeFrom + segment.to - segment.from);
          if (from >= to) continue;
          const sourceFrom = segment.from + from - segment.codeFrom, sourceTo = segment.from + to - segment.codeFrom;
          if (!view.visibleRanges.some(visible => visible.from <= sourceTo && visible.to >= sourceFrom)) continue;
          ranges.push(Decoration.mark({ class: ['zorid-code-token', ...token.classes.map(name => `token-${name}`)].join(' '), attributes: { style: `color: ${codeTokenColor(token.classes) || 'inherit'}` } }).range(sourceFrom, sourceTo));
          }
        }
      }
      for (const [key, job] of this.jobs) if (!retained.has(key)) { job.controller.abort(); this.jobs.delete(key); }
      this.decorations = Decoration.set(ranges, true); this.atomic = Decoration.set(atomic, true);
    }
    update(update: ViewUpdate): void {
      if (this.pointer || this.settling || this.composition || update.view.composing || !syntaxTreeAvailable(update.state, update.view.viewport.to)) {
        this.decorations = this.decorations.map(update.changes); this.atomic = this.atomic.map(update.changes); return;
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)
        || getSearchQuery(update.startState) !== getSearchQuery(update.state) || searchPanelOpen(update.startState) !== searchPanelOpen(update.state)
        || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshLiveFences)))) this.rebuild();
    }
    destroy(): void {
      this.closed = true; clearTimeout(this.timer); for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear();
      const view = this.view; view.scrollDOM.removeEventListener('mousedown', this.down, true); view.dom.ownerDocument.removeEventListener('mouseup', this.release, true);
      view.dom.ownerDocument.removeEventListener('dragend', this.release, true); view.dom.ownerDocument.defaultView?.removeEventListener('blur', this.release);
      view.contentDOM.removeEventListener('compositionstart', this.compose, true); view.contentDOM.removeEventListener('compositionend', this.compose, true);
    }
  }, { decorations: value => value.decorations, provide: extension => EditorView.atomicRanges.of(view => view.plugin(extension)?.atomic ?? Decoration.none) });
  return plugin;
}
