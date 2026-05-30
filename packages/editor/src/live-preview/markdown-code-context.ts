import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { createZoridMarkdownEditorState } from './markdown-language.js';
import { stateWithAvailableZoridSyntaxTree } from './syntax-tree-ranges.js';

export interface MarkdownCodeRange {
  readonly from: number;
  readonly to: number;
}

export interface MarkdownFencedCodeBlockRange extends MarkdownCodeRange {
  readonly marker: '`' | '~';
  readonly markerLength: number;
  readonly info: string;
  readonly contentFrom: number;
  readonly contentTo: number;
}

export interface MarkdownFrontmatterRange extends MarkdownCodeRange {}

export interface MarkdownCalloutRange extends MarkdownCodeRange {
  readonly type: string;
  readonly title: string;
  readonly body: string;
}

const backtickMarker = '`';
const tildeMarker = '~';
const lineFeed = '\n';
const spaceCode = ' '.charCodeAt(0);
const tabCode = '\t'.charCodeAt(0);
const greaterThanCode = '>'.charCodeAt(0);
const rightBracketCode = ']'.charCodeAt(0);

interface SyntaxNodeLike {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly firstChild: SyntaxNodeLike | null;
  readonly nextSibling: SyntaxNodeLike | null;
}

function overlapsScanWindow(range: MarkdownCodeRange, scanWindow: MarkdownCodeRange): boolean {
  return range.to >= scanWindow.from && range.from <= scanWindow.to;
}

function lineStartBefore(docText: string, position: number): number {
  return docText.lastIndexOf(lineFeed, Math.max(0, position - 1)) + 1;
}

function lineEndAfter(docText: string, position: number): number {
  const lineEnd = docText.indexOf(lineFeed, position);
  return lineEnd === -1 ? docText.length : lineEnd;
}

function syntaxStateForDoc(docText: string, upto: number, state?: EditorState): EditorState {
  return stateWithAvailableZoridSyntaxTree(state ?? createZoridMarkdownEditorState(docText), docText, upto);
}

function rangesForNode(
  docText: string,
  nodeName: string,
  scanWindow: MarkdownCodeRange,
  state?: EditorState,
): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  syntaxTree(syntaxStateForDoc(docText, scanWindow.to, state)).iterate({
    from: scanWindow.from,
    to: scanWindow.to,
    enter: (node) => {
      if (node.name !== nodeName) return;
      const range = { from: node.from, to: node.to };
      if (overlapsScanWindow(range, scanWindow)) ranges.push(range);
      return false;
    },
  });
  return ranges;
}

function childNamed(parent: { firstChild: SyntaxNodeLike | null }, name: string): SyntaxNodeLike | null {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
  }
  return null;
}

function lastChildNamed(parent: { firstChild: SyntaxNodeLike | null }, name: string): SyntaxNodeLike | null {
  let found: SyntaxNodeLike | null = null;
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.name === name) found = child;
  }
  return found;
}

function descendantNamed(parent: { firstChild: SyntaxNodeLike | null }, name: string): SyntaxNodeLike | null {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
    const descendant = descendantNamed(child, name);
    if (descendant) return descendant;
  }
  return null;
}

function codeInfoText(docText: string, parent: { firstChild: SyntaxNodeLike | null }): string {
  const info = childNamed(parent, 'CodeInfo');
  return info ? docText.slice(info.from, info.to).trim() : '';
}

function markerForFence(docText: string, from: number): '`' | '~' {
  return docText.startsWith(tildeMarker, from) ? tildeMarker : backtickMarker;
}

function sourceLines(docText: string, from: number, to: number): MarkdownCodeRange[] {
  const lines: MarkdownCodeRange[] = [];
  let lineFrom = lineStartBefore(docText, from);
  while (lineFrom <= to && lineFrom < docText.length) {
    const lineTo = lineEndAfter(docText, lineFrom);
    lines.push({ from: lineFrom, to: lineTo });
    if (lineTo >= docText.length) break;
    lineFrom = lineTo + 1;
  }
  return lines;
}

function quotedContentOffset(lineText: string): number {
  let index = 0;
  while (index < lineText.length && index < 4) {
    const code = lineText.charCodeAt(index);
    if (code !== spaceCode && code !== tabCode) break;
    index += 1;
  }
  if (index > 3 || lineText.charCodeAt(index) !== greaterThanCode) return -1;
  index += 1;
  if (lineText.charCodeAt(index) === spaceCode) index += 1;
  return index;
}

function calloutTitle(docText: string, marker: SyntaxNodeLike, markerLine: MarkdownCodeRange): string {
  const lineText = docText.slice(markerLine.from, markerLine.to);
  const markerText = docText.slice(marker.from, marker.to);
  const titleFrom = marker.from - markerLine.from + markerText.length;
  let index = titleFrom;
  while (index < lineText.length) {
    const code = lineText.charCodeAt(index);
    if (code !== spaceCode && code !== tabCode) break;
    index += 1;
  }
  const type = markerText.slice(2, -1).toLowerCase();
  return lineText.slice(index).trim() || type;
}

function calloutType(docText: string, marker: SyntaxNodeLike): string {
  return docText.slice(marker.from + 2, Math.max(marker.from + 2, marker.to - 1)).toLowerCase();
}

export function markdownFencedCodeRanges(
  docText: string,
  scanWindow: MarkdownCodeRange,
  state?: EditorState,
): MarkdownCodeRange[] {
  return rangesForNode(docText, 'FencedCode', scanWindow, state);
}

export function markdownCompleteFencedCodeBlockRanges(
  docText: string,
  scanWindow: MarkdownCodeRange,
  state?: EditorState,
): MarkdownFencedCodeBlockRange[] {
  const ranges: MarkdownFencedCodeBlockRange[] = [];
  syntaxTree(syntaxStateForDoc(docText, scanWindow.to, state)).iterate({
    from: scanWindow.from,
    to: scanWindow.to,
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const firstMark = childNamed(node.node, 'CodeMark');
      const closingMark = lastChildNamed(node.node, 'CodeMark');
      if (!firstMark || !closingMark || firstMark.from === closingMark.from) return false;

      const openingLineEnd = lineEndAfter(docText, node.from);
      const closingLineStart = lineStartBefore(docText, closingMark.from);
      const range = {
        from: node.from,
        to: node.to,
        marker: markerForFence(docText, firstMark.from),
        markerLength: firstMark.to - firstMark.from,
        info: codeInfoText(docText, node.node),
        contentFrom: Math.min(openingLineEnd + 1, node.to),
        contentTo: Math.max(
          Math.min(openingLineEnd + 1, node.to),
          closingLineStart > node.from ? closingLineStart - 1 : closingLineStart,
        ),
      };
      if (overlapsScanWindow(range, scanWindow)) ranges.push(range);
      return false;
    },
  });
  return ranges;
}

export function markdownIndentedCodeRanges(
  docText: string,
  scanWindow: MarkdownCodeRange,
  state?: EditorState,
): MarkdownCodeRange[] {
  return rangesForNode(docText, 'CodeBlock', scanWindow, state);
}

export function markdownInlineCodeRanges(
  docText: string,
  scanWindow: MarkdownCodeRange,
  state?: EditorState,
): MarkdownCodeRange[] {
  return rangesForNode(docText, 'InlineCode', scanWindow, state);
}

export function markdownSuppressedCodeRanges(
  docText: string,
  scanWindow: MarkdownCodeRange,
  state?: EditorState,
): MarkdownCodeRange[] {
  return [
    ...markdownFencedCodeRanges(docText, scanWindow, state),
    ...markdownIndentedCodeRanges(docText, scanWindow, state),
  ];
}

export function markdownFrontmatterRanges(
  docText: string,
  scanWindow: MarkdownCodeRange,
  state?: EditorState,
): MarkdownFrontmatterRange[] {
  return rangesForNode(docText, 'ZoridFrontmatter', scanWindow, state);
}

export function markdownCalloutRanges(
  docText: string,
  scanWindow: MarkdownCodeRange,
  state?: EditorState,
): MarkdownCalloutRange[] {
  const ranges: MarkdownCalloutRange[] = [];
  syntaxTree(syntaxStateForDoc(docText, scanWindow.to, state)).iterate({
    from: scanWindow.from,
    to: scanWindow.to,
    enter: (node) => {
      if (node.name !== 'Blockquote') return;
      const marker = descendantNamed(node.node, 'ZoridCallout');
      if (!marker) return false;

      const blockLines = sourceLines(docText, node.from, node.to).filter(
        (line) => line.to > node.from && line.from < node.to,
      );
      const firstLine = blockLines[0];
      if (!firstLine) return false;

      const firstLineText = docText.slice(firstLine.from, firstLine.to);
      const firstContentOffset = quotedContentOffset(firstLineText);
      if (firstContentOffset < 0 || marker.from !== firstLine.from + firstContentOffset) return false;

      const quotedLines: MarkdownCodeRange[] = [firstLine];
      for (const line of blockLines.slice(1)) {
        if (quotedContentOffset(docText.slice(line.from, line.to)) < 0) break;
        quotedLines.push(line);
      }

      const body = quotedLines
        .slice(1)
        .map((line) => {
          const text = docText.slice(line.from, line.to);
          return text.slice(quotedContentOffset(text));
        })
        .join(lineFeed);
      const from = quotedLines[0]!.from;
      const to = quotedLines.at(-1)!.to;
      ranges.push({
        from,
        to,
        type: calloutType(docText, marker),
        title: calloutTitle(docText, marker, firstLine),
        body,
      });
      return false;
    },
  });
  return ranges;
}

export function markdownSuppressedPreviewRanges(
  docText: string,
  scanWindow: MarkdownCodeRange,
  state?: EditorState,
): MarkdownCodeRange[] {
  return [
    ...markdownFrontmatterRanges(docText, scanWindow, state),
    ...markdownSuppressedCodeRanges(docText, scanWindow, state),
  ];
}
