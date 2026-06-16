import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { setInternalLivePreviewFocused } from './internal-types.js';

export function toggleCalloutFoldSign(view: EditorView, foldSignFrom: number, foldSign: '+' | '-'): boolean {
  view.dispatch({
    changes: { from: foldSignFrom, to: foldSignFrom + 1, insert: foldSign === '-' ? '+' : '-' },
    annotations: Transaction.userEvent.of('input.callout.fold.toggle'),
  });
  return true;
}

export function toggleToggleFoldSign(view: EditorView, foldSignFrom: number, foldSign: '+' | '-'): boolean {
  view.dispatch({
    changes: { from: foldSignFrom, to: foldSignFrom + 1, insert: foldSign === '-' ? '+' : '-' },
    annotations: Transaction.userEvent.of('input.toggle.fold.toggle'),
  });
  return true;
}

export function insertEmptyTogglePlaceholderChild(view: EditorView, insertAt: number): boolean {
  const insert = '\n    ';
  view.focus();
  view.dispatch({
    changes: { from: insertAt, to: insertAt, insert },
    selection: { anchor: insertAt + insert.length },
    effects: setInternalLivePreviewFocused.of(true),
    annotations: Transaction.userEvent.of('input.toggle.placeholder.child'),
  });
  return true;
}
