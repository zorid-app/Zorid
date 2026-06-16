import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { type EditorView, keymap } from '@codemirror/view';
import { deleteMarkdownTableColumns, deleteMarkdownTableRows, findMarkdownTableAt } from './model.js';

export type MarkdownTableSelectionKind = 'row' | 'column';

export interface MarkdownTableSelection {
  readonly tableFrom: number;
  readonly kind: MarkdownTableSelectionKind;
  readonly from: number;
  readonly to: number;
}

export const setMarkdownTableSelection = StateEffect.define<MarkdownTableSelection | null>();

export const markdownTableSelectionField = StateField.define<MarkdownTableSelection | null>({
  create: () => null,
  update(value, transaction) {
    const selected = transaction.effects.reduce<MarkdownTableSelection | null | undefined>(
      (current, effect) => (effect.is(setMarkdownTableSelection) ? effect.value : current),
      undefined,
    );
    if (selected !== undefined) return selected;
    if (transaction.docChanged) return null;
    return value;
  },
});

function deleteSelectedTableStructure(view: EditorView): boolean {
  const selection = view.state.field(markdownTableSelectionField, false);
  if (!selection) return false;
  const table = findMarkdownTableAt(view.state, selection.tableFrom);
  if (!table) return false;
  const source =
    selection.kind === 'row'
      ? deleteMarkdownTableRows(table, selection.from, selection.to)
      : deleteMarkdownTableColumns(table, selection.from, selection.to);
  if (!source) return true;
  view.dispatch({
    changes: { from: table.from, to: table.to, insert: source },
    effects: setMarkdownTableSelection.of(null),
  });
  return true;
}

export function markdownTableStateExtension(): Extension {
  return [
    markdownTableSelectionField,
    keymap.of([
      { key: 'Backspace', run: deleteSelectedTableStructure },
      { key: 'Delete', run: deleteSelectedTableStructure },
      {
        key: 'Escape',
        run(view) {
          if (!view.state.field(markdownTableSelectionField, false)) return false;
          view.dispatch({ effects: setMarkdownTableSelection.of(null) });
          return true;
        },
      },
    ]),
  ];
}
