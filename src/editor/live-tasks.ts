import type { Extension, EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { bodyStart } from './live-properties.ts';

interface TaskMarker { from: number; to: number; lineFrom: number; status: string }
const excluded = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'Comment', 'Table', 'LinkReference']);

/** Syntax owns list membership; the lexical check only extends status support
 * beyond the parser's built-in space/x task recognition. */
function markers(state: EditorState, from: number, to: number): TaskMarker[] {
  const found: TaskMarker[] = [], prefix = bodyStart(state);
  syntaxTree(state).iterate({ from, to, enter(node) {
    if (excluded.has(node.name)) return false;
    if (node.name !== 'ListItem') return;
    const mark = node.node.getChild('ListMark');
    if (!mark || mark.from < prefix) return;
    const line = state.doc.lineAt(mark.from);
    const match = /^[ \t]+\[([^\r\n])\](?=[ \t]|$)/.exec(state.doc.sliceString(mark.to, line.to));
    if (!match) return;
    const start = mark.to + match[0].length - 3;
    if (start + 3 < from || start > to) return;
    found.push({ from: start, to: start + 3, lineFrom: line.from, status: match[1] });
  } });
  return found;
}

class TaskWidget extends WidgetType {
  readonly status: string;
  readonly readOnly: boolean;
  constructor(status: string, readOnly: boolean) { super(); this.status = status; this.readOnly = readOnly; }
  eq(other: TaskWidget): boolean { return this.status === other.status && this.readOnly === other.readOnly; }
  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const label = document.createElement('label');
    label.className = 'task-list-label cm-task-label';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.className = 'task-list-item-checkbox';
    input.dataset.task = this.status; input.checked = this.status !== ' ';
    input.disabled = view.state.readOnly;
    input.setAttribute('aria-label', 'Toggle task');
    label.append(input);
    label.addEventListener('mousedown', event => event.preventDefault());
    input.addEventListener('input', () => {
      // Never retain an absolute source offset in a reusable widget. Resolve
      // its current mounted position after external edits/undo/viewport moves.
      if (!view.contentDOM.contains(label)) return;
      const position = view.posAtDOM(label);
      const line = view.state.doc.lineAt(position);
      const marker = markers(view.state, line.from, line.to).find(item => item.from === position);
      if (!marker) return;
      if (view.state.readOnly) { input.checked = marker.status !== ' '; return; }
      view.dispatch({ changes: { from: marker.from + 1, to: marker.from + 2,
        insert: marker.status === ' ' ? 'x' : ' ' } });
    });
    return label;
  }
  ignoreEvent(): boolean { return true; }
}

function decorate(view: EditorView): DecorationSet {
  const decorations = [], seen = new Set<number>();
  for (const range of view.visibleRanges) {
    for (const marker of markers(view.state, range.from, range.to)) {
      if (seen.has(marker.from)) continue;
      seen.add(marker.from);
      decorations.push(Decoration.line({ attributes: { 'data-task': marker.status,
        class: `cm-task-line${/^[xX]$/.test(marker.status) ? ' cm-task-done' : ''}` } }).range(marker.lineFrom));
      const reveal = view.hasFocus && view.state.selection.ranges.some(selection =>
        selection.from <= marker.to && selection.to >= marker.from);
      if (!reveal) decorations.push(Decoration.replace({ widget: new TaskWidget(marker.status, view.state.readOnly), inclusive: false }).range(marker.from, marker.to));
    }
  }
  return Decoration.set(decorations, true);
}

/** Install in Live Edit only. Source mode keeps literal task markers. The
 * marker-selection reveal boundary is an original bounded approximation of
 * the reference's grouped-formatting reveal behavior; see list-fold-reference. */
export function liveTasks(): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorate(view); }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
        || syntaxTree(update.startState) !== syntaxTree(update.state) || update.startState.readOnly !== update.state.readOnly) {
        this.decorations = decorate(update.view);
      }
    }
  }, { decorations: plugin => plugin.decorations });
}
