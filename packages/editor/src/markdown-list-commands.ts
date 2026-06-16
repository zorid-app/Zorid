import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { indentLineText, leadingIndentColumns, outdentLineText } from './indentation.js';
import { findTaskMarkerAtPosition } from './live-preview/task-toggle.js';

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

const listIndent = '  ';

function firstNonSpace(text: string): number {
  let index = 0;
  while (index < text.length && text.charCodeAt(index) === 32) index += 1;
  return index;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function isSpaceOrTab(code: number): boolean {
  return code === 32 || code === 9;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function completeToggleMarkerEnd(text: string): number | null {
  let index = firstNonSpace(text);
  if (index > 3) return null;
  if (text.charAt(index) !== '>' || text.charAt(index + 1) !== '>') return null;
  const sign = text.charAt(index + 2);
  if (sign !== '+' && sign !== '-') return null;
  const afterSign = index + 3;
  if (afterSign >= text.length) return null;
  if (!isSpaceOrTab(text.charCodeAt(afterSign))) return null;
  while (index < text.length && !isSpaceOrTab(text.charCodeAt(index))) index += 1;
  while (index < text.length && isSpaceOrTab(text.charCodeAt(index))) index += 1;
  return index;
}

function shorthandToggleMarkerEnd(text: string): number | null {
  let index = firstNonSpace(text);
  if (index > 3) return null;
  if (text.charAt(index) !== '>' || text.charAt(index + 1) !== '>') return null;
  const afterMarker = index + 2;
  if (afterMarker >= text.length || !isSpaceOrTab(text.charCodeAt(afterMarker))) return null;
  while (index < text.length && !isSpaceOrTab(text.charCodeAt(index))) index += 1;
  while (index < text.length && isSpaceOrTab(text.charCodeAt(index))) index += 1;
  return index;
}

function toggleChildIndent(text: string): boolean {
  return leadingIndentColumns(text) >= 4;
}

function outdentToggleSubtreeLines(view: EditorView, lineInfo: TouchedLine): TouchedLine[] {
  const baseIndent = leadingIndentColumns(lineInfo.text);
  const lines: TouchedLine[] = [lineInfo];
  for (let number = lineInfo.number + 1; number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number);
    if (line.text.trim().length === 0) {
      lines.push({ number, from: line.from, to: line.to, text: line.text });
      continue;
    }
    if (leadingIndentColumns(line.text) <= baseIndent) break;
    lines.push({ number, from: line.from, to: line.to, text: line.text });
  }
  return lines;
}

function unorderedBulletMarkerEnd(text: string): number | null {
  const marker = firstNonSpace(text);
  const code = text.charCodeAt(marker);
  if (code !== 45 && code !== 42 && code !== 43) return null;
  const after = marker + 1;
  if (after >= text.length) return after;
  return isSpaceOrTab(text.charCodeAt(after)) ? after + 1 : null;
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

function stripMarkerSpacing(text: string, markerEnd: number): string {
  let contentFrom = markerEnd;
  while (contentFrom < text.length && isSpaceOrTab(text.charCodeAt(contentFrom))) contentFrom += 1;
  return `${text.slice(0, firstNonSpace(text))}${text.slice(contentFrom)}`;
}

function lineTaskMarkerEnd(view: EditorView, line: TouchedLine): number | null {
  const range = findTaskMarkerAtPosition(view.state, line.from);
  if (!range || range.lineFrom !== line.from) return null;
  return range.markerTo - line.from;
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
): boolean {
  const changes = replacements.filter(
    (replacement) => view.state.doc.sliceString(replacement.from, replacement.to) !== replacement.insert,
  );
  if (changes.length === 0) return false;
  view.dispatch({ changes, annotations: Transaction.userEvent.of(userEvent) });
  return true;
}

function addBullet(text: string): string {
  const indent = firstNonSpace(text);
  return `${text.slice(0, indent)}- ${text.slice(indent)}`;
}

function addTaskMarker(text: string): string {
  const indent = firstNonSpace(text);
  return `${text.slice(0, indent)}- [ ] ${text.slice(indent)}`;
}

function continuedTaskMarker(marker: string): string {
  let index = firstNonSpace(marker);
  const numberStart = index;
  while (index < marker.length && isDigit(marker.charCodeAt(index))) index += 1;
  const markerNumber = marker.slice(numberStart, index);
  const delimiter = marker.charAt(index);
  if (markerNumber.length > 0 && (delimiter === '.' || delimiter === ')')) {
    const spacingStart = index + 1;
    let taskStart = spacingStart;
    while (taskStart < marker.length && isSpaceOrTab(marker.charCodeAt(taskStart))) taskStart += 1;
    if (
      taskStart > spacingStart &&
      marker.charAt(taskStart) === '[' &&
      marker.charAt(taskStart + 2) === ']' &&
      taskStart + 3 === marker.length
    ) {
      const taskState = marker.charAt(taskStart + 1);
      if (taskState === ' ' || taskState === 'x' || taskState === 'X') {
        return `${marker.slice(0, numberStart)}${Number.parseInt(markerNumber, 10) + 1}${delimiter}${marker.slice(
          spacingStart,
          taskStart,
        )}[ ] `;
      }
    }
  }

  const taskMarkerStart = marker.indexOf('[');
  if (taskMarkerStart >= 0 && marker.charAt(taskMarkerStart + 2) === ']') {
    return `${marker.slice(0, taskMarkerStart)}[ ]${marker.slice(taskMarkerStart + 3)} `;
  }
  return `${marker} `;
}

function taskMarkerEditBoundary(
  view: EditorView,
  range: NonNullable<ReturnType<typeof findTaskMarkerAtPosition>>,
): number {
  let boundary = range.markerTo;
  while (boundary < range.lineTo && isSpaceOrTab(view.state.doc.sliceString(boundary, boundary + 1).charCodeAt(0))) {
    boundary += 1;
  }
  return boundary;
}

function exitEmptyTaskListAtSelection(view: EditorView, userEvent: string): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;

  const position = selection.main.head;
  const range = findTaskMarkerAtPosition(view.state, position);
  if (!range) return false;
  if (position < range.lineFrom || position > taskMarkerEditBoundary(view, range)) return false;

  const boundary = taskMarkerEditBoundary(view, range);
  const trailingContent = view.state.doc.sliceString(boundary, range.lineTo);
  if (trailingContent.trim().length > 0) return false;

  view.dispatch({
    changes: { from: range.lineFrom, to: range.lineTo, insert: '' },
    selection: { anchor: range.lineFrom },
    annotations: Transaction.userEvent.of(userEvent),
  });
  return true;
}

function continueTaskListAtSelectionPosition(view: EditorView, insertAtLineEnd: boolean): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;

  const position = selection.main.head;
  const range = findTaskMarkerAtPosition(view.state, position);
  if (!range) return false;
  if (position > taskMarkerEditBoundary(view, range) && position !== range.lineTo) return false;

  const insertAt = insertAtLineEnd ? range.lineTo : position;
  const insert = `\n${continuedTaskMarker(range.marker)}`;
  view.dispatch({
    changes: { from: insertAt, to: insertAt, insert },
    selection: { anchor: insertAt + insert.length },
    annotations: Transaction.userEvent.of('input.list.continue.task'),
  });
  return true;
}

export function continueTaskListAtSelection(view: EditorView): boolean {
  return continueTaskListAtSelectionPosition(view, false);
}

export function handleTaskListEnterAtSelection(view: EditorView): boolean {
  return exitEmptyTaskListAtSelection(view, 'delete.list.task.empty') || continueTaskListAtSelection(view);
}

function toggleTitleRangeAtSelection(view: EditorView): { line: TouchedLine; markerEnd: number } | null {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return null;
  const lineInfo = view.state.doc.lineAt(selection.main.head);
  const line = { number: lineInfo.number, from: lineInfo.from, to: lineInfo.to, text: lineInfo.text };
  const markerEnd = completeToggleMarkerEnd(line.text) ?? shorthandToggleMarkerEnd(line.text);
  if (markerEnd === null) return null;
  return { line, markerEnd };
}

function convertToggleShorthandChange(line: TouchedLine): LineReplacement | null {
  const markerEnd = shorthandToggleMarkerEnd(line.text);
  if (markerEnd === null) return null;
  const indent = firstNonSpace(line.text);
  return { from: line.from, to: line.to, insert: `${line.text.slice(0, indent)}>>+ ${line.text.slice(markerEnd)}` };
}

export function handleToggleEnterAtSelection(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const position = selection.main.head;
  const currentLine = view.state.doc.lineAt(position);
  const current: TouchedLine = {
    number: currentLine.number,
    from: currentLine.from,
    to: currentLine.to,
    text: currentLine.text,
  };

  const title = toggleTitleRangeAtSelection(view);
  if (title && position >= title.line.from + title.markerEnd) {
    const shorthand = convertToggleShorthandChange(title.line);
    const insertAt = position;
    const insert = '\n    ';
    view.dispatch({
      changes: [...(shorthand ? [shorthand] : []), { from: insertAt, to: insertAt, insert }],
      selection: { anchor: insertAt + insert.length + (shorthand ? 1 : 0) },
      annotations: Transaction.userEvent.of(shorthand ? 'input.toggle.expand-shorthand' : 'input.toggle.enter.title'),
    });
    return true;
  }

  if (!toggleChildIndent(current.text)) return false;
  const previousLine = current.number > 1 ? view.state.doc.line(current.number - 1) : null;
  if (!previousLine) return false;
  const previousText = previousLine.text;
  const previousIsToggleTitle = completeToggleMarkerEnd(previousText) !== null;
  const previousIsToggleChild = toggleChildIndent(previousText);
  if (!previousIsToggleTitle && !previousIsToggleChild) return false;
  if (current.text.trim().length === 0) {
    view.dispatch({
      changes: { from: current.from, to: current.to, insert: '' },
      selection: { anchor: current.from },
      annotations: Transaction.userEvent.of('delete.toggle.empty-child'),
    });
    return true;
  }
  const insert = `\n${indentLineText('')}`;
  view.dispatch({
    changes: { from: position, to: position, insert },
    selection: { anchor: position + insert.length },
    annotations: Transaction.userEvent.of('input.toggle.enter.child'),
  });
  return true;
}

export function outdentToggleChildAtSelection(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const position = selection.main.head;
  const lineInfo = view.state.doc.lineAt(position);
  if (!toggleChildIndent(lineInfo.text)) return false;
  const beforeCaret = view.state.doc.sliceString(lineInfo.from, position);
  if (beforeCaret.trim().length > 0) return false;
  const line: TouchedLine = { number: lineInfo.number, from: lineInfo.from, to: lineInfo.to, text: lineInfo.text };
  const subtreeLines = outdentToggleSubtreeLines(view, line);
  view.dispatch({
    changes: subtreeLines.map((line) => ({ from: line.from, to: line.to, insert: outdentLineText(line.text) })),
    selection: { anchor: lineInfo.from },
    annotations: Transaction.userEvent.of('input.toggle.outdent-child'),
  });
  return true;
}

export function deleteEmptyTaskListAtSelection(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;

  const position = selection.main.head;
  const range = findTaskMarkerAtPosition(view.state, position);
  if (!range) return false;

  const boundary = taskMarkerEditBoundary(view, range);
  if (position !== boundary) return false;
  if (boundary <= range.markerTo) return false;

  const trailingContent = view.state.doc.sliceString(boundary, range.lineTo);
  if (trailingContent.trim().length > 0) return false;

  view.dispatch({
    changes: { from: range.lineFrom, to: range.lineTo, insert: '' },
    selection: { anchor: range.lineFrom },
    annotations: Transaction.userEvent.of('delete.list.task.empty'),
  });
  return true;
}

export function continueTaskListAtLineEndSelection(view: EditorView): boolean {
  if (exitEmptyTaskListAtSelection(view, 'delete.list.task.empty')) return true;
  return continueTaskListAtSelectionPosition(view, true);
}

export function toggleBulletListAtSelection(view: EditorView): boolean {
  const lines = touchedLines(view);
  const eligible = lines.filter((line) => {
    if (isBlank(line.text) || isOrderedListLine(line.text)) return false;
    if (lineTaskMarkerEnd(view, line) !== null) return false;
    return true;
  });
  if (eligible.length === 0) return false;

  const allEligibleAreBullets = eligible.every((line) => unorderedBulletMarkerEnd(line.text) !== null);
  const replacements = eligible.map((line) => {
    const markerEnd = unorderedBulletMarkerEnd(line.text);
    return {
      from: line.from,
      to: line.to,
      insert:
        allEligibleAreBullets && markerEnd !== null
          ? stripMarkerSpacing(line.text, markerEnd)
          : markerEnd === null
            ? addBullet(line.text)
            : line.text,
    };
  });

  return dispatchLineReplacements(view, replacements, 'input.list.toggle.bullet');
}

export function toggleTaskListAtSelection(view: EditorView): boolean {
  const lines = touchedLines(view).filter((line) => !isBlank(line.text) && !isOrderedListLine(line.text));
  if (lines.length === 0) return false;

  const allTasks = lines.every((line) => lineTaskMarkerEnd(view, line) !== null);
  const replacements = lines.map((line) => {
    const taskMarkerEnd = lineTaskMarkerEnd(view, line);
    if (allTasks && taskMarkerEnd !== null) {
      return { from: line.from, to: line.to, insert: stripMarkerSpacing(line.text, taskMarkerEnd) };
    }
    if (taskMarkerEnd !== null) return { from: line.from, to: line.to, insert: line.text };
    const bulletEnd = unorderedBulletMarkerEnd(line.text);
    if (bulletEnd !== null) {
      return {
        from: line.from,
        to: line.to,
        insert: `${line.text.slice(0, firstNonSpace(line.text))}- [ ] ${line.text.slice(bulletEnd).trimStart()}`,
      };
    }
    return { from: line.from, to: line.to, insert: addTaskMarker(line.text) };
  });

  return dispatchLineReplacements(view, replacements, 'input.list.toggle.task');
}

function isIndentableListLine(view: EditorView, line: TouchedLine): boolean {
  if (isBlank(line.text) || isOrderedListLine(line.text)) return false;
  return lineTaskMarkerEnd(view, line) !== null || unorderedBulletMarkerEnd(line.text) !== null;
}

export function indentListItemsAtSelection(view: EditorView): boolean {
  const replacements = touchedLines(view)
    .filter((line) => isIndentableListLine(view, line))
    .map((line) => ({ from: line.from, to: line.to, insert: `${listIndent}${line.text}` }));
  return dispatchLineReplacements(view, replacements, 'input.list.indent');
}

export function outdentListItemsAtSelection(view: EditorView): boolean {
  const replacements = touchedLines(view)
    .filter((line) => isIndentableListLine(view, line))
    .map((line) => {
      const remove = line.text.startsWith(listIndent) ? listIndent.length : line.text.startsWith(' ') ? 1 : 0;
      return { from: line.from, to: line.to, insert: line.text.slice(remove) };
    });
  return dispatchLineReplacements(view, replacements, 'input.list.outdent');
}
