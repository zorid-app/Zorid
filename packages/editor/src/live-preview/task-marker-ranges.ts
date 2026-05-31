import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import { markdownSuppressedCodeRanges } from './markdown-code-context.js';
import { stateWithAvailableZoridSyntaxTree } from './syntax-tree-ranges.js';

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

interface NodeLike {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly parent: NodeLike | null;
}

const lowerX = 'x'.charCodeAt(0);
const upperX = 'X'.charCodeAt(0);
const spaceCode = ' '.charCodeAt(0);
const tabCode = '\t'.charCodeAt(0);
const dashCode = '-'.charCodeAt(0);
const plusCode = '+'.charCodeAt(0);
const starCode = '*'.charCodeAt(0);
const periodCode = '.'.charCodeAt(0);
const rightParenCode = ')'.charCodeAt(0);

function ancestorNamed(node: { readonly parent: NodeLike | null } | null, name: string): NodeLike | null {
  for (let current = node?.parent ?? null; current; current = current.parent) {
    if (current.name === name) return current;
  }
  return null;
}

function taskMarkerRangeFromNode(docText: string, doc: Text, node: NodeLike, offset = 0): TaskMarkerRange | null {
  const task = ancestorNamed(node, 'Task');
  const listItem = ancestorNamed(node, 'ListItem');
  if (!task || !listItem) return null;

  const markerFrom = offset + listItem.from;
  const markerTo = offset + node.to;
  const checkboxFrom = offset + node.from + 1;
  const checkboxCode = docText.charCodeAt(checkboxFrom);
  const line = doc.lineAt(markerFrom);
  return {
    lineFrom: line.from,
    lineTo: line.to,
    markerFrom,
    markerTo,
    checkboxFrom,
    checkboxTo: checkboxFrom + 1,
    checked: checkboxCode === lowerX || checkboxCode === upperX,
    marker: docText.slice(markerFrom, markerTo),
  };
}

function taskMarkerFromListPrefix(lineText: string, prefixEnd: number): boolean {
  let index = prefixEnd;
  while (
    index < lineText.length &&
    (lineText.charCodeAt(index) === spaceCode || lineText.charCodeAt(index) === tabCode)
  )
    index += 1;

  if (index >= lineText.length - 2) return false;
  if (lineText.charCodeAt(index + 1) !== '['.charCodeAt(0)) return false;
  if (lineText.charCodeAt(index + 3) !== ']'.charCodeAt(0)) return false;
  if (lineText.charAt(index + 2) !== ' ' && lineText.charAt(index + 2) !== 'x' && lineText.charAt(index + 2) !== 'X')
    return false;
  return true;
}

function taskMarkerRangeFromLine(lineFrom: number, lineTo: number, lineText: string): TaskMarkerRange | null {
  let index = 0;
  while (
    index < lineText.length &&
    index < 4 &&
    (lineText.charCodeAt(index) === spaceCode || lineText.charCodeAt(index) === tabCode)
  )
    index += 1;
  if (index > 3 || index >= lineText.length) return null;

  const markerStart = index;
  const first = lineText.charCodeAt(index);
  if (first !== dashCode && first !== plusCode && first !== starCode) {
    if (!isDigit(first)) return null;
    const start = index;
    while (index < lineText.length && index - start < 9 && isDigit(lineText.charCodeAt(index))) index += 1;
    if (index === start || (lineText.charCodeAt(index) !== periodCode && lineText.charCodeAt(index) !== rightParenCode))
      return null;
    index += 1;
  } else {
    index += 1;
  }

  if (index >= lineText.length || (lineText.charCodeAt(index) !== spaceCode && lineText.charCodeAt(index) !== tabCode))
    return null;
  while (
    index < lineText.length &&
    (lineText.charCodeAt(index) === spaceCode || lineText.charCodeAt(index) === tabCode)
  )
    index += 1;
  if (!taskMarkerFromListPrefix(lineText, index)) return null;

  return {
    lineFrom,
    lineTo,
    markerFrom: lineFrom + markerStart,
    markerTo: lineFrom + index + 3,
    checkboxFrom: lineFrom + index + 1,
    checkboxTo: lineFrom + index + 2,
    checked: lineText.charCodeAt(index + 2) === lowerX || lineText.charCodeAt(index + 2) === upperX,
    marker: lineText.slice(markerStart, index + 3),
  };
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function taskMarkerRangesFromLineText(lineFrom: number, lineTo: number, lineText: string): TaskMarkerRange[] {
  const range = taskMarkerRangeFromLine(lineFrom, lineTo, lineText);
  return range ? [range] : [];
}

function taskMarkerRangesFromBoundedLinesFallback(
  doc: Text,
  suppressed: readonly { readonly from: number; readonly to: number }[],
  primaryLineStarts: readonly number[],
  from: number,
  to: number,
): TaskMarkerRange[] {
  const ranges: TaskMarkerRange[] = [];
  let line = doc.lineAt(from);
  const primaryLineSet = new Set(primaryLineStarts);
  for (;;) {
    const lineIsSuppressed = suppressed.some((range) => line.from >= range.from && line.from <= range.to);
    if (!lineIsSuppressed && !primaryLineSet.has(line.from)) {
      ranges.push(...taskMarkerRangesFromLineText(line.from, line.to, line.text));
    }
    if (line.to >= to || line.to >= doc.length) break;
    line = doc.lineAt(line.to + 1);
  }
  return ranges;
}

function mergeTaskMarkerRanges(
  primary: readonly TaskMarkerRange[],
  fallback: readonly TaskMarkerRange[],
): TaskMarkerRange[] {
  const keyed = new Map(primary.map((range) => [`${range.markerFrom}:${range.markerTo}`, range]));
  for (const range of fallback) {
    keyed.set(`${range.markerFrom}:${range.markerTo}`, keyed.get(`${range.markerFrom}:${range.markerTo}`) ?? range);
  }
  return [...keyed.values()].sort(
    (left, right) => left.markerFrom - right.markerFrom || left.markerTo - right.markerTo,
  );
}

export function taskMarkerRangesForState(state: EditorState, from = 0, to = state.doc.length): TaskMarkerRange[] {
  const docText = state.doc.toString();
  const scanFrom = state.doc.lineAt(Math.min(from, Math.max(0, state.doc.length - 1))).from;
  const scanTo = state.doc.lineAt(Math.min(to, Math.max(0, state.doc.length - 1))).to;
  const suppressed = markdownSuppressedCodeRanges(docText, { from: scanFrom, to: scanTo });
  const parseState = stateWithAvailableZoridSyntaxTree(state, docText, scanTo);
  const ranges: TaskMarkerRange[] = [];
  const fallbackRanges: TaskMarkerRange[] = [];
  const primaryLineStarts = new Set<number>();

  syntaxTree(parseState).iterate({
    from: scanFrom,
    to: scanTo,
    enter: (node) => {
      if (node.name !== 'TaskMarker') return;
      const range = taskMarkerRangeFromNode(docText, state.doc, node.node);
      if (range) {
        ranges.push(range);
        primaryLineStarts.add(range.lineFrom);
      }
      return false;
    },
  });

  if (scanFrom === scanTo - state.doc.sliceString(scanFrom, scanTo).length) {
    fallbackRanges.push(
      ...taskMarkerRangesFromBoundedLinesFallback(
        state.doc,
        suppressed,
        [...primaryLineStarts.values()],
        scanFrom,
        scanTo,
      ),
    );
  }

  return mergeTaskMarkerRanges(ranges, fallbackRanges).filter((range) => range.lineTo >= from && range.lineFrom <= to);
}

export function findTaskMarkerRangeAtPosition(state: EditorState, position: number): TaskMarkerRange | null {
  const line = state.doc.lineAt(position);
  return taskMarkerRangesForState(state, line.from, line.to).find((range) => range.lineFrom === line.from) ?? null;
}
