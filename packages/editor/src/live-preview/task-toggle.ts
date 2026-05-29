import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { isMarkdownLineInsideFencedCodeBlock } from './markdown-code-context.js';

export interface TaskMarkerRange {
  readonly lineFrom: number;
  readonly lineTo: number;
  readonly markerFrom: number;
  readonly markerTo: number;
  readonly checkboxFrom: number;
  readonly checkboxTo: number;
  readonly checked: boolean;
  readonly marker: string;
}

const taskMarkerPattern = /^(\s{0,3}[-*+]\s+\[)([ xX])(\])/;
export function findTaskMarkerAtPosition(state: EditorState, position: number): TaskMarkerRange | null {
  const line = state.doc.lineAt(position);
  if (isMarkdownLineInsideFencedCodeBlock(state, line.from)) return null;

  const match = taskMarkerPattern.exec(line.text);
  if (!match?.[0] || match.index !== 0) return null;

  const prefix = match[1] ?? '';
  const marker = match[0];
  const checkbox = match[2] ?? ' ';
  const checkboxFrom = line.from + prefix.length;

  return {
    lineFrom: line.from,
    lineTo: line.to,
    markerFrom: line.from,
    markerTo: line.from + marker.length,
    checkboxFrom,
    checkboxTo: checkboxFrom + checkbox.length,
    checked: checkbox === 'x' || checkbox === 'X',
    marker,
  };
}

export function nextTaskMarkerCheckbox(range: Pick<TaskMarkerRange, 'checked'>): string {
  return range.checked ? ' ' : 'x';
}

export function toggleTaskMarkerAtPosition(view: EditorView, position: number): boolean {
  const range = findTaskMarkerAtPosition(view.state, position);
  if (!range) return false;

  view.dispatch({
    changes: {
      from: range.checkboxFrom,
      to: range.checkboxTo,
      insert: nextTaskMarkerCheckbox(range),
    },
    userEvent: 'input.task.toggle',
  });
  return true;
}

export function toggleTaskMarkerAtSelection(view: EditorView): boolean {
  return toggleTaskMarkerAtPosition(view, view.state.selection.main.head);
}
