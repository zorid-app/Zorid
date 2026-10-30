import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { inlineBaseRequest } from '../bases/inline-base.ts';
import type { InlineBaseRequest } from '../bases/inline-base.ts';
import { bodyStart } from './live-properties.ts';
import { intersectsRenderExclusion, renderExclusions, sameRenderExclusions } from './render-exclusions.ts';
import type { RenderExclusionOptions } from './render-exclusions.ts';
import { icon } from '../ui/icons.ts';

export type InlineBaseRenderer = (request: InlineBaseRequest, context?: { occurrence: object }) => { dom: HTMLElement; destroy(): void };
interface Span { request: InlineBaseRequest; occurrence: object }

/** Parser-owned fenced Bases use the same renderer as Reading/file embeds.
 * A source selection reveals the original fence, with no hidden backing file. */
export function liveBases(render: InlineBaseRenderer, options: RenderExclusionOptions = {}): Extension {
  const owners = new WeakMap<HTMLElement, () => void>();
  const focus = StateEffect.define<boolean>();
  class BaseWidget extends WidgetType {
    readonly span: Span;
    constructor(span: Span) { super(); this.span = span; }
    eq(other: WidgetType): boolean {
      return other instanceof BaseWidget && other.span.occurrence === this.span.occurrence
        && other.span.request.documentText === this.span.request.documentText;
    }
    toDOM(view: EditorView): HTMLElement {
      const wrapper = view.dom.ownerDocument.createElement('div');
      wrapper.className = 'cm-live-base cm-live-embed cm-live-embed-block'; wrapper.contentEditable = 'false';
      const instance = render(this.span.request, { occurrence: this.span.occurrence });
      const edit = view.dom.ownerDocument.createElement('button');
      edit.type = 'button'; edit.className = 'clickable-icon edit-block-button';
      edit.setAttribute('aria-label', 'Edit Base source'); edit.setAttribute('title', 'Edit Base source');
      edit.append(icon('code'));
      edit.onmousedown = event => event.preventDefault();
      edit.onclick = event => {
        event.preventDefault(); event.stopPropagation();
        const current = view.state.field(field).spans.find(span => span.occurrence === this.span.occurrence);
        if (!current) return;
        view.focus(); view.dispatch({ effects: focus.of(true), selection: { anchor: current.request.contentFrom }, scrollIntoView: true, userEvent: 'select.pointer' });
      };
      wrapper.append(instance.dom, edit);
      owners.set(wrapper, () => { edit.onclick = null; edit.onmousedown = null; instance.destroy(); });
      return wrapper;
    }
    ignoreEvent(): boolean { return true; }
    destroy(dom: HTMLElement): void { owners.get(dom)?.(); owners.delete(dom); }
  }
  function collect(state: EditorState, previous: readonly Span[], map: (position: number) => number, excluded: ReturnType<typeof renderExclusions>): Span[] {
    const prefix = bodyStart(state), spans: Span[] = [];
    let source: string | undefined;
    syntaxTree(state).iterate({ enter(node) {
      if (node.name === 'FencedCode') {
        if (node.from < prefix || intersectsRenderExclusion(excluded, node.from, node.to)) return false;
        const info = node.node.getChild('CodeInfo'), closing = node.node.lastChild;
        if (!info || !/^[ \t]*base[ \t]*$/.test(state.sliceDoc(info.from, info.to))
          || closing?.name !== 'CodeMark' || closing.from <= info.to) return false;
        const from = state.doc.lineAt(node.from).from;
        const request = inlineBaseRequest(source ??= state.doc.toString(), from, node.to);
        if (request) {
          const retained = previous.find(({request:before}) => {
            if(map(before.from)!==from)return false;
            if(before.source===request.source)return true;
            // A configuration-only rewrite is still this logical fence. This
            // token is not source authority: the session manager separately
            // requires its own successful saved-source acknowledgement.
            const delta=request.documentText.length-before.documentText.length;
            return request.from===before.from&&request.contentFrom===before.contentFrom
              &&request.contentTo===before.contentTo+delta&&request.to===before.to+delta
              &&request.documentText.slice(0,request.contentFrom)===before.documentText.slice(0,before.contentFrom)
              &&request.documentText.slice(request.contentTo)===before.documentText.slice(before.contentTo);
          });
          spans.push({ request, occurrence: retained?.occurrence ?? {} });
        }
        return false;
      }
      if (['CodeBlock', 'HTMLBlock', 'Paragraph', 'Table', 'ZoridFrontmatter'].includes(node.name)) return false;
    } });
    return spans;
  }
  const decorations = (state: EditorState, spans: readonly Span[], focused: boolean): DecorationSet => Decoration.set(spans
    .filter(({ request }) => !focused || !state.selection.ranges.some(range => range.from <= request.to && range.to >= request.from))
    .map(span => Decoration.replace({ widget: new BaseWidget(span), block: true }).range(span.request.from, span.request.to)), true);
  const field = StateField.define<{ spans: readonly Span[]; decorations: DecorationSet; focused: boolean; exclusions: ReturnType<typeof renderExclusions> }>({
    create(state) { const exclusions = renderExclusions(state, options.excludes), spans = collect(state, [], value => value, exclusions); return { spans, exclusions, focused: false, decorations: decorations(state, spans, false) }; },
    update(value, transaction) {
      const exclusions = renderExclusions(transaction.state, options.excludes);
      const changed = transaction.docChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
        || !sameRenderExclusions(value.exclusions, exclusions);
      const spans = changed ? collect(transaction.state, value.spans, position => transaction.changes.mapPos(position), exclusions) : value.spans;
      let focused = value.focused;
      for (const effect of transaction.effects) if (effect.is(focus)) focused = effect.value;
      return { spans, exclusions, focused, decorations: decorations(transaction.state, spans, focused) };
    },
    provide: value => EditorView.decorations.from(value, state => state.decorations),
  });
  const interaction = ViewPlugin.fromClass(class {
    view: EditorView; closed = false; queued = false;
    constructor(view: EditorView) {
      this.view = view;
      view.dom.addEventListener('focusin', this.changed); view.dom.addEventListener('focusout', this.changed);
    }
    changed = () => {
      if (this.queued || this.closed) return; this.queued = true;
      queueMicrotask(() => {
        this.queued = false;
        if (!this.closed) this.view.dispatch({ effects: focus.of(this.view.hasFocus) });
      });
    };
    destroy() {
      this.closed = true;
      this.view.dom.removeEventListener('focusin', this.changed); this.view.dom.removeEventListener('focusout', this.changed);
    }
  });
  return [field, interaction, EditorView.baseTheme({
    '.cm-live-base': { position: 'relative' },
    '.cm-live-base > .edit-block-button': { position: 'absolute', left: '-28px', right: 'auto', top: '6px', width: '24px', padding: '4px', zIndex: '1', opacity: '0' },
    '.cm-live-base:hover > .edit-block-button, .cm-live-base:focus-within > .edit-block-button': { opacity: '1' },
  })];
}
