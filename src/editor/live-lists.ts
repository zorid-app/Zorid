import { StateEffect } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { bodyStart } from './live-properties.ts';

export interface ListMarker {
  from: number; to: number; lineFrom: number; itemTo: number; ordered: boolean;
  task?: { from: number; to: number; status: string };
}
const excluded = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'Comment', 'Table', 'LinkReference']);

/** One syntax owner for list prefixes and checkboxes. A lexical status extension
 * supports custom tasks without treating task-like code or prose as a task. */
export function listMarkers(state: EditorState, from: number, to: number): ListMarker[] {
  const found: ListMarker[] = [], prefix = bodyStart(state);
  syntaxTree(state).iterate({ from, to, enter(node) {
    if (excluded.has(node.name)) return false;
    if (node.name !== 'ListItem') return;
    const mark = node.node.getChild('ListMark');
    if (!mark || mark.from < prefix) return;
    const line = state.doc.lineAt(mark.from);
    const marker: ListMarker = { from: mark.from, to: mark.to, lineFrom: line.from,
      itemTo: node.to, ordered: node.node.parent?.name === 'OrderedList' };
    const match = /^[ \t]+\[([^\r\n])\](?=[ \t]|$)/.exec(state.doc.sliceString(mark.to, line.to));
    if (match) {
      const start = mark.to + match[0].length - 3;
      const content = node.node.getChild('Task') ?? node.node.getChild('Paragraph');
      if (content?.from === start) marker.task = { from: start, to: start + 3, status: match[1] };
    }
    found.push(marker);
  } });
  return found;
}

/** Bounded grouping: list prefix and task status reveal together. Full HyperMD
 * token grouping/search highlights remain outside this original parser adapter. */
export function revealListMarker(view: EditorView, marker: ListMarker): boolean {
  return view.hasFocus && view.state.selection.ranges.some(range =>
    range.from <= (marker.task?.to ?? marker.to) && range.to >= marker.from);
}

const refreshLists = StateEffect.define<null>();
const interaction = ViewPlugin.fromClass(class {
  pointer = false;
  composition = false;
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private view: EditorView;
  private owns(target: EventTarget | null): boolean {
    const element = target as Element | null;
    return Boolean(element && this.view.contentDOM.contains(element)
      && (element.nodeType !== 1 || element.closest('.cm-editor') === this.view.dom));
  }
  private down = (event: MouseEvent) => {
    if (event.button !== 0 || !this.owns(event.target)) return;
    this.pointer = true; clearTimeout(this.timer);
  };
  private release = () => {
    if (!this.pointer) return;
    this.pointer = false; this.schedule(50);
  };
  private compose = (event: Event) => {
    if (!this.owns(event.target)) return;
    this.composition = event.type === 'compositionstart';
    if (this.composition) clearTimeout(this.timer); else this.schedule(10);
  };
  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.destroyed || this.pointer || this.composition) return;
      // Refresh current state; never replay a captured selection or document.
      this.view.dispatch({ effects: refreshLists.of(null) });
    }, delay);
  }
  constructor(view: EditorView) {
    this.view = view;
    view.scrollDOM.addEventListener('mousedown', this.down, true);
    view.dom.ownerDocument.addEventListener('mouseup', this.release, true);
    view.dom.ownerDocument.addEventListener('dragend', this.release, true);
    view.dom.ownerDocument.defaultView?.addEventListener('blur', this.release);
    view.contentDOM.addEventListener('compositionstart', this.compose, true);
    view.contentDOM.addEventListener('compositionend', this.compose, true);
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
});

/** Shared interaction controller is deduplicated by CodeMirror when both list
 * and task extensions install it. Mapping preserves pointer/IME geometry. */
export function stableListDecorations(build: (view: EditorView) => DecorationSet): Extension {
  return [interaction, ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(update: ViewUpdate): void {
      const activity = update.view.plugin(interaction);
      if (activity?.pointer || activity?.composition || update.view.composing) {
        this.decorations = this.decorations.map(update.changes);
      } else if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
        || syntaxTree(update.startState) !== syntaxTree(update.state)
        || update.startState.readOnly !== update.state.readOnly
        || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshLists)))) {
        this.decorations = build(update.view);
      }
    }
  }, { decorations: plugin => plugin.decorations })];
}

export interface LiveListOptions { showIndentGuide?: boolean }

function decorate(view: EditorView, options: LiveListOptions): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  const markers = new Map<number, ListMarker>(), lines = new Set<number>();
  for (const visible of view.visibleRanges) {
    for (const marker of listMarkers(view.state, visible.from, visible.to)) {
      if (marker.from >= visible.from && marker.from <= visible.to) markers.set(marker.from, marker);
      // Continuation lines share their containing list, including nested items.
      const end = Math.min(marker.itemTo, visible.to);
      for (let position = Math.max(marker.lineFrom, view.state.doc.lineAt(visible.from).from); position <= end;) {
        const line = view.state.doc.lineAt(position);
        let isCode = false;
        syntaxTree(view.state).iterate({ from: line.from, to: line.to, enter(node) {
          if (excluded.has(node.name) && node.name !== 'InlineCode' && node.from <= line.to && node.to >= line.from) { isCode = true; return false; }
        } });
        if (!isCode) lines.add(line.from);
        if (line.to >= end) break;
        position = line.to + 1;
      }
    }
  }
  for (const marker of markers.values()) {
    lines.add(marker.lineFrom);
    const reveal = revealListMarker(view, marker);
    if (!reveal && marker.task && !marker.ordered) {
      // Adjacent to, never overlapping, the task widget's [status] range.
      ranges.push(Decoration.replace({ inclusive: false }).range(marker.from, marker.task.from));
    } else {
      ranges.push(Decoration.mark({ class: `cm-list-prefix${marker.ordered ? ' cm-list-number' : reveal ? '' : ' cm-list-bullet'}` })
        .range(marker.from, marker.to));
    }
  }
  for (const from of lines) {
    const line = view.state.doc.lineAt(from), marker = markers.get(from + line.text.search(/[^ \t>]/));
    ranges.push(Decoration.line({ class: `cm-list-line${marker?.task && !marker.ordered ? ' cm-list-unordered-task' : ''}` }).range(from));
    if (options.showIndentGuide === false) continue;
    // Static reference consumes tabs or four ASCII spaces, independently of
    // configured visual tab width; quote prefixes do not draw guide segments.
    const prefix = /^[ \t>]*/.exec(line.text)![0];
    for (let index = 0; index < prefix.length;) {
      if (prefix[index] === '>') { index += prefix[index + 1] === ' ' ? 2 : 1; continue; }
      const width = prefix[index] === '\t' ? 1 : prefix.slice(index, index + 4) === '    ' ? 4 : 0;
      if (!width) { index++; continue; }
      ranges.push(Decoration.mark({ class: 'cm-list-indent' }).range(from + index, from + index + width));
      index += width;
    }
  }
  return Decoration.set(ranges, true);
}

/** Install with liveTasks in Live Edit and load live-lists.css for presentation. */
export function liveLists(options: LiveListOptions = {}): Extension {
  return stableListDecorations(view => decorate(view, options));
}
