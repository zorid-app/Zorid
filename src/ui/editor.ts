import { Annotation, Compartment, EditorState, StateEffect, Transaction } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { searchKeymap } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import type { CompletionContext } from '@codemirror/autocomplete';
import { activeTableEditor, liveTables } from '../editor/live-tables.ts';
import { bodyStart, liveProperties, propertyUpdate } from '../editor/live-properties.ts';
import { liveEmbeds } from '../editor/live-embeds.ts';
import { editorTransfers } from '../editor/transfers.ts';
import type { TransferOptions } from '../editor/transfers.ts';
import type { EmbedRequest } from './markdown.ts';
import { liveTasks } from '../editor/live-tasks.ts';
import { markdownListKeymap } from '../editor/list-commands.ts';
import type { MarkdownListOptions } from '../editor/list-commands.ts';

export interface EditorHandle {
  getValue(): string;
  /** Apply an external snapshot without recording it as a user edit. Existing undo entries are mapped through the change, not conflict-merged. */
  setValue(value: string): void;
  focus(): void;
  destroy(): void;
  insert(text: string): void;
  configureLists?(options: MarkdownListOptions): void;
}
export interface EditorOptions {
  value: string; mode: 'live' | 'source'; paths: () => string[];
  onChange: (value: string) => void; open: (target: string) => void;
  transfers?: TransferOptions;
  listOptions?: MarkdownListOptions;
  renderEmbed?: (request: EmbedRequest) => { dom: HTMLElement; destroy(): void };
}

const externalChange = Annotation.define<boolean>();
const refreshPreview = StateEffect.define<null>();
// CodeMirror's generic default underlines headings; Markdown headings use weight/size.
const markdownHighlightStyle = HighlightStyle.define(defaultHighlightStyle.specs.map(spec =>
  spec.tag === tags.heading ? { ...spec, textDecoration: 'none' } : spec));

/** Live preview covers headings, strong emphasis, strikethrough and highlights.
 * This is a bounded preview implementation, not complete Obsidian rendering.
 */
function decorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<ReturnType<typeof Decoration.mark>['range']>[] = [];
  const tree = syntaxTree(view.state);
  const active = (from: number, to: number) => view.state.selection.ranges.some(range => range.from <= to && range.to >= from);
  const inside = (from: number, to: number, names: string[]) => {
    let found = false;
    tree.iterate({ from, to, enter(node) {
      if (node.from < to && node.to > from && names.includes(node.name)) { found = true; return false; }
    } });
    return found;
  };
  const codeNodes = ['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'Comment'];
  for (const visible of view.visibleRanges) {
    for (let position = visible.from; position <= visible.to;) {
      const line = view.state.doc.lineAt(position); const heading = line.text.match(/^(#{1,6})\s/);
      const syntaxNode = tree.resolveInner(line.from, 1);
      let insideCode = false;
      for (let node: typeof syntaxNode | null = syntaxNode; node; node = node.parent) {
        if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'Table') { insideCode = true; break; }
      }
      if (insideCode) { if (line.to >= view.state.doc.length) break; position = line.to + 1; continue; }
      const reveal = active(line.from, line.to);
      if (heading && inside(line.from, line.to, [`ATXHeading${heading[1].length}`])) {
        ranges.push(Decoration.line({class: `cm-heading cm-heading-${heading[1].length}`}).range(line.from));
        if (!reveal) ranges.push(Decoration.replace({}).range(line.from, line.from + heading[0].length));
      }
      if (!reveal) {
        for (const match of line.text.matchAll(/(\*\*|~~|==)(.+?)\1/g)) {
          const from = line.from + match.index!; const marker = match[1]; const to = from + match[0].length;
          if (inside(from, to, codeNodes)) continue;
          if (marker !== '==') {
            // Only hide actual Markdown syntax, not escaped or unmatched markers.
            const expected = marker === '**' ? 'StrongEmphasis' : 'Strikethrough';
            let node = tree.resolveInner(from + marker.length, 1);
            while (node && !(node.name === expected && node.from === from && node.to === to)) {
              if (!node.parent) break;
              node = node.parent;
            }
            if (node.name !== expected || node.from !== from || node.to !== to) continue;
          } else {
            let escapes = 0;
            for (let index = from - 1; index >= line.from && view.state.doc.sliceString(index, index + 1) === '\\'; index--) escapes++;
            if (escapes % 2) continue;
          }
          ranges.push(Decoration.replace({}).range(from, from + marker.length));
          ranges.push(Decoration.mark({class: marker === '**' ? 'cm-strong' : marker === '~~' ? 'cm-strike' : 'cm-highlight'}).range(from + marker.length, to - marker.length));
          ranges.push(Decoration.replace({}).range(to - marker.length, to));
        }
      }
      if (line.to >= view.state.doc.length) break;
      position = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorHandle {
  const listConfiguration = new Compartment();
  const completion = (context: CompletionContext) => {
    const match = context.matchBefore(/\[\[[^\]\n]*/); if (!match) return null;
    return { from: match.from + 2, options: options.paths().filter(p => p.endsWith('.md')).map(path => ({ label: path.replace(/\.md$/, ''), type: 'text', apply: `${path.replace(/\.md$/, '')}]]` })) };
  };
  const preview = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    private view: EditorView;
    private pointerDown = false;
    private timer?: ReturnType<typeof setTimeout>;
    private destroyed = false;
    private down = (event: MouseEvent) => {
      if (event.button !== 0 || !this.view.contentDOM.contains(event.target as Node)) return;
      this.pointerDown = true;
      clearTimeout(this.timer);
    };
    private release = () => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      this.schedule(50);
    };
    private compositionEnd = () => this.schedule(10);
    private schedule(delay: number) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.destroyed || this.pointerDown) return;
        // An effect refreshes the latest state; never replay a captured selection.
        this.view.dispatch({ effects: refreshPreview.of(null) });
        this.view.requestMeasure();
      }, delay);
    }
    constructor(view: EditorView) {
      this.view = view; this.decorations = decorations(view);
      // Capture runs before CM's pointer hit test and selection transaction.
      view.scrollDOM.addEventListener('mousedown', this.down, true);
      view.dom.ownerDocument.addEventListener('mouseup', this.release, true);
      view.dom.ownerDocument.addEventListener('dragend', this.release, true);
      view.dom.ownerDocument.defaultView?.addEventListener('blur', this.release);
      view.contentDOM.addEventListener('compositionend', this.compositionEnd);
    }
    update(update: ViewUpdate) {
      if (this.pointerDown || update.view.composing) {
        this.decorations = this.decorations.map(update.changes);
      } else if (update.docChanged || update.selectionSet || update.viewportChanged
        || syntaxTree(update.startState) !== syntaxTree(update.state)
        || update.transactions.some(t => t.effects.some(effect => effect.is(refreshPreview)))) {
        this.decorations = decorations(update.view);
      }
    }
    destroy() {
      this.destroyed = true; clearTimeout(this.timer);
      this.view.scrollDOM.removeEventListener('mousedown', this.down, true);
      this.view.dom.ownerDocument.removeEventListener('mouseup', this.release, true);
      this.view.dom.ownerDocument.removeEventListener('dragend', this.release, true);
      this.view.dom.ownerDocument.defaultView?.removeEventListener('blur', this.release);
      this.view.contentDOM.removeEventListener('compositionend', this.compositionEnd);
    }
  }, {decorations: value => value.decorations});
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.value, extensions: [
      EditorState.allowMultipleSelections.of(true),
      history(), listConfiguration.of(markdownListKeymap(options.listOptions)), markdown({base: markdownLanguage,addKeymap:false}), syntaxHighlighting(markdownHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.lineWrapping, autocompletion({override: [completion]}),
      EditorView.contentAttributes.of({'aria-label': 'Note editor', spellcheck: 'true'}),
      EditorView.updateListener.of(update => { if (update.transactions.some(transaction => transaction.docChanged && !transaction.annotation(externalChange))) options.onChange(update.state.doc.toString()); }),
      EditorView.domEventHandlers({click(event, view) {
        if (!event.metaKey && !event.ctrlKey) return false;
        const position = view.posAtCoords({x:event.clientX, y:event.clientY}); if (position === null) return false;
        const line = view.state.doc.lineAt(position);
        for (const match of line.text.matchAll(/\[\[([^\]]+)\]\]/g)) {
          if (position >= line.from + match.index! && position <= line.from + match.index! + match[0].length) { options.open(match[1].split('|')[0]); return true; }
        }
        return false;
      }}),
      ...(options.transfers ? [editorTransfers(options.transfers)] : []),
      ...(options.mode === 'live' ? [liveProperties(), liveTables(options.open), liveTasks(), ...(options.renderEmbed ? [liveEmbeds(options.renderEmbed)] : []), preview] : []),
    ]}),
  });
  if (options.mode === 'live' && bodyStart(view.state)) view.dispatch({ selection: { anchor: bodyStart(view.state) } });
  return {
    getValue: () => view.state.doc.toString(),
    configureLists(listOptions) { view.dispatch({ effects: listConfiguration.reconfigure(markdownListKeymap(listOptions)) }); },
    setValue(value) {
      const previous = view.state.doc.toString();
      if (value === previous) return;
      // A small replacement preserves unaffected cursor positions and lets CM
      // map prior user history through external edits. This is not a merge.
      let from = 0;
      while (from < previous.length && from < value.length && previous[from] === value[from]) from++;
      let oldEnd = previous.length, newEnd = value.length;
      while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
      view.dispatch({ changes: { from, to: oldEnd, insert: value.slice(from, newEnd) },
        annotations: [externalChange.of(true), propertyUpdate.of(true), Transaction.addToHistory.of(false), isolateHistory.of('full')] });
    },
    focus: () => (activeTableEditor(view) ?? view).focus(), destroy: () => view.destroy(),
    insert(text) { const target = activeTableEditor(view) ?? view; target.dispatch({ ...target.state.replaceSelection(text), annotations: Transaction.userEvent.of('input') }); target.focus(); },
  };
}
