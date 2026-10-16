import { renderExclusions, intersectsRenderExclusion } from './render-exclusions.ts';
import type { RenderExclusionOptions } from './render-exclusions.ts';
import type { Extension, EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { listMarkers, revealListMarker, stableListDecorations } from './live-lists.ts';

function markers(state: EditorState, from: number, to: number) {
  return listMarkers(state, from, to).flatMap(marker => marker.task
    ? [{ ...marker.task, lineFrom: marker.lineFrom, list: marker }] : []);
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

function decorate(view: EditorView, options: RenderExclusionOptions): DecorationSet {
  const blocked = renderExclusions(view.state, options.excludes);
  const decorations = [], seen = new Set<number>();
  for (const range of view.visibleRanges) {
    for (const marker of markers(view.state, range.from, range.to)) {
      if (seen.has(marker.from) || intersectsRenderExclusion(blocked, marker.from, marker.to)) continue;
      seen.add(marker.from);
      decorations.push(Decoration.line({ attributes: { 'data-task': marker.status,
        class: `cm-task-line${/^[xX]$/.test(marker.status) ? ' cm-task-done' : ''}` } }).range(marker.lineFrom));
      const reveal = revealListMarker(view, marker.list);
      if (!reveal) decorations.push(Decoration.replace({ widget: new TaskWidget(marker.status, view.state.readOnly), inclusive: false }).range(marker.from, marker.to));
    }
  }
  return Decoration.set(decorations, true);
}

/** Install in Live Edit only. Source mode keeps literal task markers. The
 * marker-selection reveal boundary is an original bounded approximation of
 * the reference's grouped-formatting reveal behavior; see list-fold-reference. */
export function liveTasks(options: RenderExclusionOptions = {}): Extension {
  return stableListDecorations(view => decorate(view, options), options);
}
