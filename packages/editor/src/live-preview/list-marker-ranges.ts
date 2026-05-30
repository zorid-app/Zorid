import type { EditorState } from '@codemirror/state';
import { markdownSuppressedCodeRanges } from './markdown-code-context.js';
import { findTaskMarkerRangeAtPosition } from './task-marker-ranges.js';

export interface ListMarkerRange {
  readonly lineFrom: number;
  readonly lineTo: number;
  readonly markerFrom: number;
  readonly markerTo: number;
  readonly marker: string;
  readonly ordered: boolean;
  readonly orderedIndex?: number;
}

const spaceCode = ' '.charCodeAt(0);
const tabCode = '\t'.charCodeAt(0);
const dashCode = '-'.charCodeAt(0);
const plusCode = '+'.charCodeAt(0);
const starCode = '*'.charCodeAt(0);
const periodCode = '.'.charCodeAt(0);
const rightParenCode = ')'.charCodeAt(0);

function isSpaceOrTab(code: number): boolean {
  return code === spaceCode || code === tabCode;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function taskMarkerFromListPrefix(lineText: string, prefixEnd: number): boolean {
  let index = prefixEnd;
  while (index < lineText.length && isSpaceOrTab(lineText.charCodeAt(index))) index += 1;
  return (
    lineText.charAt(index) === '[' &&
    (lineText.charAt(index + 1) === ' ' || lineText.charAt(index + 1) === 'x' || lineText.charAt(index + 1) === 'X') &&
    lineText.charAt(index + 2) === ']'
  );
}

function listMarkerRangeFromLine(lineFrom: number, lineTo: number, lineText: string): ListMarkerRange | null {
  let index = 0;
  while (index < lineText.length && lineText.charCodeAt(index) === spaceCode) index += 1;
  if (index > 3 || index >= lineText.length) return null;

  const markerStart = index;
  const first = lineText.charCodeAt(index);
  if (first === dashCode || first === plusCode || first === starCode) {
    index += 1;
    if (index >= lineText.length || !isSpaceOrTab(lineText.charCodeAt(index))) return null;
    while (index < lineText.length && isSpaceOrTab(lineText.charCodeAt(index))) index += 1;
    if (taskMarkerFromListPrefix(lineText, index)) return null;
    return {
      lineFrom,
      lineTo,
      markerFrom: lineFrom + markerStart,
      markerTo: lineFrom + index,
      marker: lineText.slice(markerStart, index),
      ordered: false,
    };
  }

  if (!isDigit(first)) return null;
  const numberStart = index;
  while (index < lineText.length && index - numberStart < 9 && isDigit(lineText.charCodeAt(index))) index += 1;
  if (index === numberStart || index >= lineText.length) return null;
  const delimiterIndex = index;
  const delimiter = lineText.charCodeAt(index);
  if (delimiter !== periodCode && delimiter !== rightParenCode) return null;
  index += 1;
  if (index >= lineText.length || !isSpaceOrTab(lineText.charCodeAt(index))) return null;
  while (index < lineText.length && isSpaceOrTab(lineText.charCodeAt(index))) index += 1;
  if (taskMarkerFromListPrefix(lineText, index)) return null;

  const orderedIndex = Number.parseInt(lineText.slice(numberStart, delimiterIndex), 10);
  const base = {
    lineFrom,
    lineTo,
    markerFrom: lineFrom + markerStart,
    markerTo: lineFrom + index,
    marker: lineText.slice(markerStart, index),
    ordered: true,
  } as const;
  return {
    ...base,
    ...(Number.isFinite(orderedIndex) ? { orderedIndex } : {}),
  };
}

export function listMarkerRangesForState(state: EditorState, from = 0, to = state.doc.length): ListMarkerRange[] {
  const docText = state.doc.toString();
  const suppressed = markdownSuppressedCodeRanges(docText, { from, to });
  const ranges: ListMarkerRange[] = [];
  let line = state.doc.lineAt(from);

  for (;;) {
    const lineIsSuppressed = suppressed.some((range) => line.from >= range.from && line.from <= range.to);
    if (!lineIsSuppressed && !findTaskMarkerRangeAtPosition(state, line.from)) {
      const range = listMarkerRangeFromLine(line.from, line.to, line.text);
      if (range) ranges.push(range);
    }

    if (line.to >= to || line.to >= state.doc.length) break;
    line = state.doc.lineAt(line.to + 1);
  }

  return ranges;
}
