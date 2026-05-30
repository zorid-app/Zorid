import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { findTaskMarkerRangeAtPosition, type TaskMarkerRange } from './task-marker-ranges.js';

export type { TaskMarkerRange } from './task-marker-ranges.js';

export function findTaskMarkerAtPosition(state: EditorState, position: number): TaskMarkerRange | null {
  return findTaskMarkerRangeAtPosition(state, position);
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
