import type { EditorState } from '@codemirror/state';

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

interface FenceState {
  readonly marker: '`' | '~';
  readonly length: number;
}

interface OpenFence extends FenceState {
  readonly from: number;
}

const fencedCodeBlockPattern = /^\s{0,3}(`{3,}|~{3,})/;

function fencedCodeLine(line: string): (FenceState & { readonly rest: string }) | null {
  const match = fencedCodeBlockPattern.exec(line);
  if (!match?.[1]) return null;

  return {
    marker: match[1][0] as '`' | '~',
    length: match[1].length,
    rest: line.slice(match[0].length),
  };
}

function closesFence(line: string, fence: FenceState): boolean {
  const matched = fencedCodeLine(line);
  return Boolean(
    matched && matched.marker === fence.marker && matched.length >= fence.length && matched.rest.trim() === '',
  );
}

export function markdownFencedCodeRanges(docText: string, scanWindow: MarkdownCodeRange): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  let fence: OpenFence | null = null;

  for (const match of docText.matchAll(/^.*$/gm)) {
    const index = match.index;
    if (index === undefined) continue;
    if (index > scanWindow.to) break;

    const line = match[0];
    const matchedFence = fencedCodeLine(line);
    if (!fence && matchedFence) {
      fence = { marker: matchedFence.marker, length: matchedFence.length, from: index };
    } else if (fence && closesFence(line, fence)) {
      const range = { from: fence.from, to: index + line.length };
      if (range.to >= scanWindow.from && range.from <= scanWindow.to) ranges.push(range);
      fence = null;
    }
  }

  if (fence && scanWindow.to >= fence.from) ranges.push({ from: fence.from, to: scanWindow.to });
  return ranges;
}

export function markdownCompleteFencedCodeBlockRanges(
  docText: string,
  scanWindow: MarkdownCodeRange,
): MarkdownFencedCodeBlockRange[] {
  const ranges: MarkdownFencedCodeBlockRange[] = [];
  let fence: (OpenFence & { readonly info: string; readonly contentFrom: number }) | null = null;

  for (const match of docText.matchAll(/^.*$/gm)) {
    const index = match.index;
    if (index === undefined) continue;
    if (index > scanWindow.to) break;

    const line = match[0];
    const matchedFence = fencedCodeLine(line);
    if (!fence && matchedFence) {
      const lineBreak = docText.indexOf('\n', index);
      fence = {
        marker: matchedFence.marker,
        length: matchedFence.length,
        from: index,
        info: matchedFence.rest.trim(),
        contentFrom: lineBreak === -1 ? index + line.length : lineBreak + 1,
      };
    } else if (fence && closesFence(line, fence)) {
      const range = {
        from: fence.from,
        to: index + line.length,
        marker: fence.marker,
        markerLength: fence.length,
        info: fence.info,
        contentFrom: fence.contentFrom,
        contentTo: Math.max(fence.contentFrom, index === fence.contentFrom - 1 ? fence.contentFrom : index - 1),
      };
      if (range.to >= scanWindow.from && range.from <= scanWindow.to) ranges.push(range);
      fence = null;
    }
  }

  return ranges;
}

export function markdownIndentedCodeRanges(docText: string, scanWindow: MarkdownCodeRange): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  const scanText = docText.slice(scanWindow.from, scanWindow.to);
  for (const match of scanText.matchAll(/^ {4,}.*$/gm)) {
    if (match.index === undefined) continue;
    ranges.push({ from: scanWindow.from + match.index, to: scanWindow.from + match.index + match[0].length });
  }
  return ranges;
}

export function markdownSuppressedCodeRanges(docText: string, scanWindow: MarkdownCodeRange): MarkdownCodeRange[] {
  return [...markdownFencedCodeRanges(docText, scanWindow), ...markdownIndentedCodeRanges(docText, scanWindow)];
}

export function markdownFrontmatterRanges(docText: string, scanWindow: MarkdownCodeRange): MarkdownFrontmatterRange[] {
  const firstLineEnd = docText.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? docText : docText.slice(0, firstLineEnd);
  if (firstLine.trim() !== '---') return [];

  let closingFrom = -1;
  for (const match of docText.matchAll(/^---[ \t]*$/gm)) {
    const index = match.index;
    if (index === undefined || index === 0) continue;
    closingFrom = index;
    break;
  }

  if (closingFrom === -1) return [];
  const closingLineEnd = docText.indexOf('\n', closingFrom);
  const range = { from: 0, to: closingLineEnd === -1 ? docText.length : closingLineEnd };
  return range.to >= scanWindow.from && range.from <= scanWindow.to ? [range] : [];
}

export function markdownSuppressedPreviewRanges(docText: string, scanWindow: MarkdownCodeRange): MarkdownCodeRange[] {
  return [...markdownFrontmatterRanges(docText, scanWindow), ...markdownSuppressedCodeRanges(docText, scanWindow)];
}

export function isMarkdownLineInsideFencedCodeBlock(state: EditorState, lineFrom: number): boolean {
  const priorLines = state.doc.sliceString(0, lineFrom).split('\n');
  let fence: FenceState | null = null;

  for (const priorLine of priorLines) {
    const matchedFence = fencedCodeLine(priorLine);
    if (!fence && matchedFence) {
      fence = { marker: matchedFence.marker, length: matchedFence.length };
    } else if (fence && closesFence(priorLine, fence)) {
      fence = null;
    }
  }

  return Boolean(fence);
}
