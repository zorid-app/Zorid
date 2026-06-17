import { Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  type KeyBinding,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { isMarkdownCalloutTitleLine } from './live-preview/markdown-code-context.js';

const indentationUnitColumns = 4;
const indentationUnit = ' '.repeat(indentationUnitColumns);

const addPlainIndentMarker = StateEffect.define<number>({
  map: (position, mapping) => mapping.mapPos(position, -1),
});

const removePlainIndentMarker = StateEffect.define<number>({
  map: (position, mapping) => mapping.mapPos(position, -1),
});

interface TouchedLine {
  readonly number: number;
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

interface LineReplacement {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function firstNonSpace(text: string): number {
  let index = 0;
  while (index < text.length && text.charCodeAt(index) === 32) index += 1;
  return index;
}

function isSpaceOrTab(code: number): boolean {
  return code === 32 || code === 9;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

export function leadingIndentColumns(text: string): number {
  let columns = 0;
  for (const character of text) {
    if (character === ' ') {
      columns += 1;
      continue;
    }
    if (character === '\t') {
      columns += indentationUnitColumns;
      continue;
    }
    break;
  }
  return columns;
}

export function indentationDepth(text: string): number {
  return Math.floor(leadingIndentColumns(text) / indentationUnitColumns);
}

function lineIndentSpaces(text: string): number {
  let index = 0;
  while (index < text.length && text.charCodeAt(index) === 32) index += 1;
  return index;
}

function leadingWhitespaceLength(text: string): number {
  let index = 0;
  while (index < text.length && isSpaceOrTab(text.charCodeAt(index))) index += 1;
  return index;
}

function isHorizontalRuleLine(text: string, marker: string): boolean {
  let markers = 0;
  for (const character of text) {
    if (character === marker) {
      markers += 1;
      continue;
    }
    if (character !== ' ' && character !== '\t') return false;
  }
  return markers >= 3;
}

function isOrderedListLine(text: string): boolean {
  let index = firstNonSpace(text);
  const start = index;
  while (index < text.length && index - start < 9 && isDigit(text.charCodeAt(index))) index += 1;
  if (index === start || isDigit(text.charCodeAt(index))) return false;
  const marker = text.charCodeAt(index);
  if (marker !== 46 && marker !== 41) return false;
  const afterMarker = index + 1;
  return afterMarker >= text.length || isSpaceOrTab(text.charCodeAt(afterMarker));
}

function isStructuredMarkdownLine(text: string): boolean {
  const trimmedStart = firstNonSpace(text);
  const marker = text.charAt(trimmedStart);
  const next = text.charAt(trimmedStart + 1);
  if (marker === '>') return true;
  if (marker === '#') return next === '' || isSpaceOrTab(text.charCodeAt(trimmedStart + 1));
  if (marker === '|' || text.includes('|')) return true;
  if (marker === '`' && next === '`' && text.charAt(trimmedStart + 2) === '`') return true;
  if (marker === '~' && next === '~' && text.charAt(trimmedStart + 2) === '~') return true;
  if ((marker === '-' || marker === '*' || marker === '+') && isSpaceOrTab(text.charCodeAt(trimmedStart + 1))) {
    return true;
  }
  if (isOrderedListLine(text)) return true;
  if ((marker === '-' || marker === '*' || marker === '_') && isHorizontalRuleLine(text.slice(trimmedStart), marker)) {
    return true;
  }
  return isMarkdownCalloutTitleLine(text);
}

function isPlainLineText(text: string): boolean {
  return !isStructuredMarkdownLine(text);
}

export function indentLineText(text: string): string {
  return `${indentationUnit}${text}`;
}

export function outdentLineText(text: string): string {
  if (text.startsWith('\t')) return text.slice(1);

  let remove = 0;
  while (remove < indentationUnitColumns && text.charCodeAt(remove) === 32) remove += 1;
  return text.slice(remove);
}

function touchedLines(view: EditorView): TouchedLine[] {
  const doc = view.state.doc;
  const lineNumbers = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const fromLine = doc.lineAt(range.from);
    const toPosition = range.empty ? range.to : Math.max(range.from, range.to - 1);
    const toLine = doc.lineAt(toPosition);
    for (let number = fromLine.number; number <= toLine.number; number += 1) lineNumbers.add(number);
  }
  return [...lineNumbers]
    .sort((left, right) => left - right)
    .map((number) => {
      const line = doc.line(number);
      return { number, from: line.from, to: line.to, text: line.text };
    });
}

function dispatchLineReplacements(
  view: EditorView,
  replacements: readonly LineReplacement[],
  userEvent: string,
  effects: readonly StateEffect<unknown>[] = [],
): boolean {
  const changes = replacements.filter(
    (replacement) => view.state.doc.sliceString(replacement.from, replacement.to) !== replacement.insert,
  );
  if (changes.length === 0) return false;
  view.dispatch({ changes, effects, annotations: Transaction.userEvent.of(userEvent) });
  return true;
}

function plainIndentMarkerPositions(markers: DecorationSet): Set<number> {
  const positions = new Set<number>();
  markers.between(0, Number.MAX_SAFE_INTEGER, (from) => {
    positions.add(from);
  });
  return positions;
}

function hasPlainIndentMarker(view: EditorView, lineFrom: number): boolean {
  return plainIndentMarkerPositions(view.state.field(plainIndentMarkersField, false) ?? Decoration.none).has(lineFrom);
}

function lineHasOnlySpacesBefore(text: string, offset: number): boolean {
  let index = 0;
  while (index < offset) {
    if (text.charCodeAt(index) !== 32) return false;
    index += 1;
  }
  return true;
}

function isCommandOwnedPlainLine(view: EditorView, line: TouchedLine): boolean {
  if (!isPlainLineText(line.text)) return false;
  const indent = leadingIndentColumns(line.text);
  if (indent === 0) return true;
  return hasPlainIndentMarker(view, line.from);
}

function indentReplacementMarkers(lines: readonly TouchedLine[]): StateEffect<unknown>[] {
  let offset = 0;
  return lines.map((line) => {
    const effect = addPlainIndentMarker.of(line.from + offset);
    offset += indentationUnitColumns;
    return effect;
  });
}

export function indentLinesAtSelection(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length === 1 && selection.main.empty) {
    const lineInfo = view.state.doc.lineAt(selection.main.head);
    const line = { number: lineInfo.number, from: lineInfo.from, to: lineInfo.to, text: lineInfo.text };
    if (isBlank(line.text) && isPlainLineText(line.text)) {
      const insertAt = selection.main.head;
      view.dispatch({
        changes: { from: insertAt, to: insertAt, insert: indentationUnit },
        effects: addPlainIndentMarker.of(line.from),
        selection: { anchor: insertAt + indentationUnitColumns },
        annotations: Transaction.userEvent.of('input.indent'),
      });
      return true;
    }
  }

  const lines = touchedLines(view).filter((line) => !isBlank(line.text) && isCommandOwnedPlainLine(view, line));
  const replacements = lines.map((line) => ({ from: line.from, to: line.to, insert: indentLineText(line.text) }));
  return dispatchLineReplacements(view, replacements, 'input.indent', indentReplacementMarkers(lines));
}

export function outdentLinesAtSelection(view: EditorView): boolean {
  const lines = touchedLines(view).filter(
    (line) =>
      leadingIndentColumns(line.text) > 0 && hasPlainIndentMarker(view, line.from) && isPlainLineText(line.text),
  );
  if (lines.length === 0) {
    const protectedPlainLine = touchedLines(view).some(
      (line) =>
        leadingIndentColumns(line.text) > 0 && !hasPlainIndentMarker(view, line.from) && isPlainLineText(line.text),
    );
    if (protectedPlainLine) return true;
  }
  const replacements = lines.map((line) => ({ from: line.from, to: line.to, insert: outdentLineText(line.text) }));
  const effects = lines.flatMap((line) =>
    indentationDepth(outdentLineText(line.text)) > 0
      ? [addPlainIndentMarker.of(line.from)]
      : [removePlainIndentMarker.of(line.from)],
  );
  return dispatchLineReplacements(view, replacements, 'input.outdent', effects);
}

export function insertPlainIndentedLineAtSelection(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const position = selection.main.head;
  const lineInfo = view.state.doc.lineAt(position);
  const line: TouchedLine = { number: lineInfo.number, from: lineInfo.from, to: lineInfo.to, text: lineInfo.text };
  if (!hasPlainIndentMarker(view, line.from) || !isPlainLineText(line.text)) return false;

  if (isBlank(line.text)) {
    const outdented = outdentLineText(line.text);
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: outdented },
      effects:
        indentationDepth(outdented) > 0 ? addPlainIndentMarker.of(line.from) : removePlainIndentMarker.of(line.from),
      selection: { anchor: line.from + lineIndentSpaces(outdented) },
      annotations: Transaction.userEvent.of('input.indent.enter.empty'),
    });
    return true;
  }

  const indent = ' '.repeat(lineIndentSpaces(line.text));
  const insert = `\n${indent}`;
  view.dispatch({
    changes: { from: position, to: position, insert },
    effects: addPlainIndentMarker.of(position + 1),
    selection: { anchor: position + insert.length },
    annotations: Transaction.userEvent.of('input.indent.enter'),
  });
  return true;
}

export function deletePlainIndentAtSelection(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const position = selection.main.head;
  const lineInfo = view.state.doc.lineAt(position);
  const line: TouchedLine = { number: lineInfo.number, from: lineInfo.from, to: lineInfo.to, text: lineInfo.text };
  if (!isPlainLineText(line.text)) return false;
  const offset = position - line.from;
  if (offset === 0 || offset > lineIndentSpaces(line.text)) return false;
  if (offset % indentationUnitColumns !== 0 || !lineHasOnlySpacesBefore(line.text, offset)) return false;
  if (!hasPlainIndentMarker(view, line.from)) return true;
  const removeFrom = position - indentationUnitColumns;
  if (removeFrom < line.from) return false;
  const outdented = `${line.text.slice(0, offset - indentationUnitColumns)}${line.text.slice(offset)}`;
  view.dispatch({
    changes: { from: removeFrom, to: position, insert: '' },
    effects:
      indentationDepth(outdented) > 0 ? addPlainIndentMarker.of(line.from) : removePlainIndentMarker.of(line.from),
    selection: { anchor: removeFrom },
    annotations: Transaction.userEvent.of('delete.indent'),
  });
  return true;
}

export const markdownIndentKeymap: readonly KeyBinding[] = [
  {
    key: 'Enter',
    run: insertPlainIndentedLineAtSelection,
  },
  {
    key: 'Tab',
    preventDefault: true,
    run: indentLinesAtSelection,
    shift: outdentLinesAtSelection,
  },
  {
    key: 'Backspace',
    run: deletePlainIndentAtSelection,
  },
];

function plainIndentMarkerDecoration(lineText: string): Decoration {
  const depth = indentationDepth(lineText);
  return Decoration.line({
    class: 'z-editor-indent-guide',
    attributes: {
      'data-indent-depth': String(depth),
      style: `--z-indent-depth: ${depth};`,
    },
  });
}

function hasPlainIndentMarkerEffect(transaction: Transaction): boolean {
  return transaction.effects.some((effect) => effect.is(addPlainIndentMarker) || effect.is(removePlainIndentMarker));
}

function insertedTextStartsWithWhitespace(transaction: Transaction, from: number, to: number): boolean {
  return isSpaceOrTab(transaction.newDoc.sliceString(from, to).charCodeAt(0));
}

function changesTouchCommandOwnedLeadingWhitespace(transaction: Transaction, line: TouchedLine): boolean {
  const leadingEnd = line.from + leadingWhitespaceLength(line.text);
  let touchesLeadingWhitespace = false;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (touchesLeadingWhitespace || toA < line.from || fromA > line.to) return;
    if (fromA < leadingEnd && toA >= line.from) {
      touchesLeadingWhitespace = true;
      return;
    }
    if (fromA === leadingEnd && insertedTextStartsWithWhitespace(transaction, fromB, toB)) {
      touchesLeadingWhitespace = true;
    }
  }, true);
  return touchesLeadingWhitespace;
}

function stalePlainIndentMarkerPositions(transaction: Transaction, markers: DecorationSet): Set<number> {
  const positions = new Set<number>();
  if (!transaction.docChanged || hasPlainIndentMarkerEffect(transaction)) return positions;

  for (const position of plainIndentMarkerPositions(markers)) {
    if (position > transaction.startState.doc.length) continue;
    const line = transaction.startState.doc.lineAt(position);
    if (line.from !== position) continue;
    if (changesTouchCommandOwnedLeadingWhitespace(transaction, line)) {
      positions.add(transaction.changes.mapPos(position, -1));
    }
  }
  return positions;
}

function rebuildPlainIndentMarkers(transaction: Transaction, markers: DecorationSet): DecorationSet {
  const positions = plainIndentMarkerPositions(markers.map(transaction.changes));
  for (const position of stalePlainIndentMarkerPositions(transaction, markers)) positions.delete(position);
  for (const effect of transaction.effects) {
    if (effect.is(addPlainIndentMarker)) positions.add(effect.value);
    if (effect.is(removePlainIndentMarker)) positions.delete(effect.value);
  }

  const decorations: ReturnType<Decoration['range']>[] = [];
  for (const position of [...positions].sort((left, right) => left - right)) {
    if (position > transaction.newDoc.length) continue;
    const line = transaction.newDoc.lineAt(position);
    if (line.from !== position || leadingIndentColumns(line.text) <= 0) continue;
    decorations.push(plainIndentMarkerDecoration(line.text).range(line.from));
  }
  return Decoration.set(decorations, true);
}

const plainIndentMarkersField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (markers, transaction) => rebuildPlainIndentMarkers(transaction, markers),
});

function indentationGuideDecorations(view: EditorView): DecorationSet {
  const decorations = [];
  const markerPositions = plainIndentMarkerPositions(
    view.state.field(plainIndentMarkersField, false) ?? Decoration.none,
  );
  for (const visibleRange of view.visibleRanges) {
    let position = visibleRange.from;
    while (position <= visibleRange.to) {
      const line = view.state.doc.lineAt(position);
      if (markerPositions.has(line.from) && indentationDepth(line.text) > 0) {
        decorations.push(plainIndentMarkerDecoration(line.text).range(line.from));
      }
      if (line.to >= visibleRange.to || line.to === view.state.doc.length) break;
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}

export const editorIndentationGuideExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = indentationGuideDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = indentationGuideDecorations(update.view);
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

export const editorIndentationExtension = [
  plainIndentMarkersField,
  editorIndentationGuideExtension,
  Prec.highest(keymap.of(markdownIndentKeymap)),
];
