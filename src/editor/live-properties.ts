import { Annotation, ChangeSet, EditorSelection, EditorState, StateField } from '@codemirror/state';
import type { Extension, Text } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { readProperties } from '../core/properties.ts';

/** Authoritative property-panel/external snapshots may replace the hidden prefix. */
export const propertyUpdate = Annotation.define<boolean>();

interface PropertyRegion { readonly start: number; readonly decorations: DecorationSet }

function findBodyStart(doc: Text): number {
  if (!/^\uFEFF?---[ \t]*(?:#[^\r\n]*)?$/.test(doc.line(1).text)) return 0;
  for (let number = 2; number <= doc.lines; number++) {
    const line = doc.line(number);
    if (!/^(?:---|\.\.\.)[ \t]*(?:#[^\r\n]*)?$/.test(line.text)) continue;
    const start = Math.min(line.to + 1, doc.length);
    try { readProperties(doc.sliceString(0, start)); }
    catch { return 0; }
    return start;
  }
  return 0;
}

function region(doc: Text): PropertyRegion {
  const start = findBodyStart(doc);
  return { start, decorations: start ? Decoration.set([Decoration.replace({ block: true, inclusive: false }).range(0, start)]) : Decoration.none };
}

const propertyRegion = StateField.define<PropertyRegion>({
  create(state) { return region(state.doc); },
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    let prefixChanged = value.start === 0 || value.start === transaction.startState.doc.length;
    transaction.changes.iterChangedRanges(from => { if (from < value.start) prefixChanged = true; });
    // Ordinary body typing never reparses YAML or rebuilds its decoration.
    return prefixChanged ? region(transaction.newDoc) : value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

/** First editable body position, or zero when no supported frontmatter exists. */
export function bodyStart(state: EditorState): number {
  return state.field(propertyRegion, false)?.start ?? findBodyStart(state.doc);
}

function clampSelection(selection: EditorSelection, start: number): EditorSelection {
  return EditorSelection.create(selection.ranges.map(range =>
    EditorSelection.range(Math.max(start, range.anchor), Math.max(start, range.head), range.goalColumn, range.bidiLevel ?? undefined, range.assoc)),
  selection.mainIndex);
}

/**
 * The separate properties panel owns valid YAML while Live Edit owns its body.
 * This extension changes presentation/interaction only; it never rewrites YAML.
 * Initialize a new editor's selection at bodyStart(state); filters apply only
 * to subsequent transactions, not EditorState.create's initial selection.
 */
export function liveProperties(): Extension {
  return [propertyRegion, EditorState.transactionFilter.of(transaction => {
    const external = transaction.annotation(propertyUpdate);
    const start = bodyStart(transaction.startState);
    if (!external && start && transaction.docChanged && (transaction.isUserEvent('input') || transaction.isUserEvent('delete'))) {
      let touchesProperties = false;
      transaction.changes.iterChangedRanges(from => { if (from < start) touchesProperties = true; });
      // Reject atomically, including effects and selection: partial application
      // could leave a multicursor edit or its resulting positions inconsistent.
      if (touchesProperties) return [];
    }
    // A delimiter at EOF without a newline needs a separate body line when the
    // user first types. Preserve the supplied source until that actual edit.
    if (!external && start && start === transaction.startState.doc.length && transaction.docChanged && transaction.isUserEvent('input')
      && transaction.startState.doc.sliceString(start - 1, start) !== '\n' && transaction.newDoc.sliceString(start, start + 1) !== '\n') {
      const changes = ChangeSet.of({ from: start, insert: '\n' }, transaction.newDoc.length);
      return [transaction, { changes, selection: clampSelection(transaction.newSelection.map(changes), start + 1), sequential: true }];
    }
    const nextStart = transaction.docChanged ? bodyStart(transaction.state) : start;
    if (!nextStart || transaction.newSelection.ranges.every(range => range.from >= nextStart)) return transaction;
    const selection = clampSelection(transaction.newSelection, nextStart);
    return [transaction, { selection, sequential: true }];
  })];
}
