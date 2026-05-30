import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
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
  return `${marker.replace(/\[[^\]]\]/u, '[ ]')} `;
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

export function continueTaskListAtSelection(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;

  const position = selection.main.head;
  const range = findTaskMarkerAtPosition(view.state, position);
  if (!range) return false;
  if (position > taskMarkerEditBoundary(view, range)) return false;

  const insert = `\n${continuedTaskMarker(range.marker)}`;
  view.dispatch({
    changes: { from: position, to: position, insert },
    selection: { anchor: position + insert.length },
    annotations: Transaction.userEvent.of('input.list.continue.task'),
  });
  return true;
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
