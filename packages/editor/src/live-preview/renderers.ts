import { markdownSuppressedCodeRanges } from './markdown-code-context.js';
import type { LivePreviewRange, LivePreviewRenderer } from './types.js';

const inlineCodePattern = /`[^`\n]+`/g;

function livePreviewScanWindow(
  docText: string,
  visibleFrom: number,
  visibleTo: number,
): Pick<LivePreviewRange, 'from' | 'to'> {
  const lineStart = docText.lastIndexOf('\n', Math.max(0, visibleFrom - 1)) + 1;
  const nextLineBreak = docText.indexOf('\n', visibleTo);
  return {
    from: Math.max(0, lineStart),
    to: nextLineBreak === -1 ? docText.length : nextLineBreak,
  };
}

function inlineCodeRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
): Array<Pick<LivePreviewRange, 'from' | 'to'>> {
  const scanText = docText.slice(scanWindow.from, scanWindow.to);
  return [...scanText.matchAll(inlineCodePattern)].flatMap((match) => {
    if (match.index === undefined) return [];
    return [{ from: scanWindow.from + match.index, to: scanWindow.from + match.index + match[0].length }];
  });
}

function inlineCodeDelimiterRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
): LivePreviewRange[] {
  const suppressedRanges = markdownSuppressedCodeRanges(docText, scanWindow);
  return inlineCodeRanges(docText, scanWindow)
    .filter((range) => !suppressedRanges.some((container) => isInsideRange(range, container)))
    .flatMap((range) => [
      {
        rendererId: 'inline-code-delimiter',
        from: range.from,
        to: range.from + 1,
        activationFrom: range.from,
        activationTo: range.to,
        className: 'z-live-preview-inline-code-delimiter',
        kind: 'replace' as const,
      },
      {
        rendererId: 'inline-code-delimiter',
        from: range.to - 1,
        to: range.to,
        activationFrom: range.from,
        activationTo: range.to,
        className: 'z-live-preview-inline-code-delimiter',
        kind: 'replace' as const,
      },
    ]);
}

function isInsideRange(
  range: Pick<LivePreviewRange, 'from' | 'to'>,
  container: Pick<LivePreviewRange, 'from' | 'to'>,
): boolean {
  return range.from >= container.from && range.to <= container.to;
}

function regexLivePreviewRenderer(
  id: string,
  className: string,
  pattern: RegExp,
  rangeForMatch: (match: RegExpExecArray) => { fromOffset: number; toOffset: number },
): LivePreviewRenderer {
  return {
    id,
    match: ({ docText, visibleFrom, visibleTo }) => {
      const ranges: LivePreviewRange[] = [];
      const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      const scanWindow = livePreviewScanWindow(docText, visibleFrom, visibleTo);
      const scanText = docText.slice(scanWindow.from, scanWindow.to);
      const excludedInlineCodeRanges = id === 'inline-code' ? [] : inlineCodeRanges(docText, scanWindow);
      const suppressedRanges = markdownSuppressedCodeRanges(docText, scanWindow);
      for (const match of scanText.matchAll(matcher)) {
        const index = match.index;
        if (index === undefined) continue;
        const { fromOffset, toOffset } = rangeForMatch(match);
        const from = scanWindow.from + index + fromOffset;
        const to = scanWindow.from + index + toOffset;
        if (excludedInlineCodeRanges.some((container) => isInsideRange({ from, to }, container))) continue;
        if (suppressedRanges.some((container) => isInsideRange({ from, to }, container))) continue;
        if (to > from) ranges.push({ rendererId: id, from, to, className });
      }
      return ranges;
    },
  };
}

export const headingLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'heading',
  'z-live-preview-heading',
  /^#{1,6}\s+.+$/gm,
  (match) => ({ fromOffset: 0, toOffset: match[0].length }),
);

export const inlineCodeLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'inline-code',
  'z-live-preview-inline-code',
  inlineCodePattern,
  (match) => ({ fromOffset: 0, toOffset: match[0].length }),
);

export const inlineCodeDelimiterLivePreviewRenderer: LivePreviewRenderer = {
  id: 'inline-code-delimiter',
  match: ({ docText, visibleFrom, visibleTo }) =>
    inlineCodeDelimiterRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo)),
};

export const markdownLinkLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'markdown-link',
  'z-live-preview-link',
  /\[[^\]\n]+\]\([^) \n][^)\n]*\)/g,
  (match) => ({ fromOffset: 0, toOffset: match[0].length }),
);

export const wikiLinkLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'wiki-link',
  'z-live-preview-wiki-link',
  /\[\[[^\]\n]+\]\]/g,
  (match) => ({ fromOffset: 0, toOffset: match[0].length }),
);

export const tagLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'tag',
  'z-live-preview-tag',
  /(^|[\s([{])#[A-Za-z0-9_/-]+/gm,
  (match) => {
    const leading = match[1]?.length ?? 0;
    return { fromOffset: leading, toOffset: match[0].length };
  },
);

export const taskMarkerLivePreviewRenderer: LivePreviewRenderer = regexLivePreviewRenderer(
  'task-marker',
  'z-live-preview-task-marker',
  /^(\s{0,3}[-*+]\s+\[[ xX]\])/gm,
  (match) => ({ fromOffset: 0, toOffset: match[1]?.length ?? match[0].length }),
);

export const defaultLivePreviewRenderers: readonly LivePreviewRenderer[] = [
  headingLivePreviewRenderer,
  inlineCodeLivePreviewRenderer,
  inlineCodeDelimiterLivePreviewRenderer,
  markdownLinkLivePreviewRenderer,
  wikiLinkLivePreviewRenderer,
  tagLivePreviewRenderer,
  taskMarkerLivePreviewRenderer,
];
