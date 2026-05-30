import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import { markdownSuppressedCodeRanges } from './markdown-code-context.js';
import { createZoridMarkdownEditorState } from './markdown-language.js';
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

function taskMarkerRangesFromBoundedLineParse(docText: string, doc: Text, lineFrom: number): TaskMarkerRange[] {
  const line = doc.lineAt(lineFrom);
  const lineState = createZoridMarkdownEditorState(line.text);
  const ranges: TaskMarkerRange[] = [];
  syntaxTree(lineState).iterate({
    enter: (node) => {
      if (node.name !== 'TaskMarker') return;
      const range = taskMarkerRangeFromNode(docText, doc, node.node, line.from);
      if (range) ranges.push(range);
      return false;
    },
  });
  return ranges;
}

function taskMarkerRangesFromBoundedLinesParse(
  docText: string,
  doc: Text,
  from: number,
  to: number,
): TaskMarkerRange[] {
  const ranges: TaskMarkerRange[] = [];
  let line = doc.lineAt(from);
  for (;;) {
    ranges.push(...taskMarkerRangesFromBoundedLineParse(docText, doc, line.from));
    if (line.to >= to || line.to >= doc.length) break;
    line = doc.lineAt(line.to + 1);
  }
  return ranges;
}

export function taskMarkerRangesForState(state: EditorState, from = 0, to = state.doc.length): TaskMarkerRange[] {
  const docText = state.doc.toString();
  const scanFrom = state.doc.lineAt(Math.min(from, Math.max(0, state.doc.length - 1))).from;
  const scanTo = state.doc.lineAt(Math.min(to, Math.max(0, state.doc.length - 1))).to;
  const parseState = stateWithAvailableZoridSyntaxTree(state, docText, scanTo);
  const ranges: TaskMarkerRange[] = [];

  syntaxTree(parseState).iterate({
    from: scanFrom,
    to: scanTo,
    enter: (node) => {
      if (node.name !== 'TaskMarker') return;
      const range = taskMarkerRangeFromNode(docText, state.doc, node.node);
      if (range) ranges.push(range);
      return false;
    },
  });

  const lineIsSuppressed = markdownSuppressedCodeRanges(docText, { from: scanFrom, to: scanTo }).some(
    (range) => scanFrom >= range.from && scanFrom <= range.to,
  );
  if (
    !lineIsSuppressed &&
    ranges.length === 0 &&
    scanFrom === scanTo - state.doc.sliceString(scanFrom, scanTo).length
  ) {
    ranges.push(...taskMarkerRangesFromBoundedLinesParse(docText, state.doc, scanFrom, scanTo));
  }

  return ranges.filter((range) => range.lineTo >= from && range.lineFrom <= to);
}

export function findTaskMarkerRangeAtPosition(state: EditorState, position: number): TaskMarkerRange | null {
  const line = state.doc.lineAt(position);
  return taskMarkerRangesForState(state, line.from, line.to).find((range) => range.lineFrom === line.from) ?? null;
}
