import { type EditorView, WidgetType } from '@codemirror/view';
import {
  type InternalLivePreviewRange,
  type InternalLivePreviewRenderer,
  setInternalLivePreviewFocused,
} from './internal-types.js';
import { markdownCompleteFencedCodeBlockRanges, markdownSuppressedCodeRanges } from './markdown-code-context.js';
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

function blockquoteLineRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
): InternalLivePreviewRange[] {
  const suppressedRanges = markdownSuppressedCodeRanges(docText, scanWindow);
  const scanText = docText.slice(scanWindow.from, scanWindow.to);

  return [...scanText.matchAll(/^ {0,3}> ?.*$/gm)].flatMap((match) => {
    const index = match.index;
    if (index === undefined) return [];

    const from = scanWindow.from + index;
    const to = from + match[0].length;
    if (suppressedRanges.some((container) => isInsideRange({ from, to }, container))) return [];

    return [
      {
        rendererId: 'blockquote',
        from,
        to,
        activationFrom: from,
        activationTo: to,
        className: 'z-live-preview-blockquote-line',
        kind: 'line' as const,
      },
    ];
  });
}

function activateLivePreviewWidgetSource(view: EditorView, activateAt: number): void {
  view.focus();
  view.dispatch({
    effects: setInternalLivePreviewFocused.of(true),
    selection: { anchor: activateAt },
    scrollIntoView: true,
  });
}

class CodeBlockPreviewWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly info: string,
    readonly code: string,
    readonly activateAt: number,
  ) {
    super();
  }

  eq(other: CodeBlockPreviewWidget): boolean {
    return this.source === other.source && this.activateAt === other.activateAt;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'z-live-preview-code-block-widget';
    wrapper.dataset.livePreviewRenderer = 'code-block-widget';
    wrapper.setAttribute('role', 'group');

    const header = document.createElement('div');
    header.className = 'z-live-preview-code-block-widget__header';
    header.textContent = this.info || 'code';
    wrapper.append(header);

    const body = document.createElement('pre');
    body.className = 'z-live-preview-code-block-widget__body';
    const code = document.createElement('code');
    code.textContent = this.code;
    body.append(code);
    wrapper.append(body);

    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault();
      activateLivePreviewWidgetSource(view, this.activateAt);
    });

    return wrapper;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown';
  }
}

class CalloutPreviewWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly type: string,
    readonly title: string,
    readonly body: string,
    readonly activateAt: number,
  ) {
    super();
  }

  eq(other: CalloutPreviewWidget): boolean {
    return this.source === other.source && this.activateAt === other.activateAt;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'z-live-preview-callout-widget';
    wrapper.dataset.livePreviewRenderer = 'callout-widget';
    wrapper.setAttribute('role', 'group');

    const header = document.createElement('div');
    header.className = 'z-live-preview-callout-widget__header';
    header.textContent = this.title || this.type;
    wrapper.append(header);

    if (this.body.trim().length > 0) {
      const body = document.createElement('div');
      body.className = 'z-live-preview-callout-widget__body';
      body.textContent = this.body;
      wrapper.append(body);
    }

    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault();
      activateLivePreviewWidgetSource(view, this.activateAt);
    });

    return wrapper;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown';
  }
}

function codeBlockWidgetRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
): InternalLivePreviewRange[] {
  return markdownCompleteFencedCodeBlockRanges(docText, scanWindow).map((range) => {
    const source = docText.slice(range.from, range.to);
    const code = docText.slice(range.contentFrom, range.contentTo);
    const activateAt = range.contentFrom < range.contentTo ? range.contentFrom : range.from;
    return {
      rendererId: 'code-block-widget',
      from: range.from,
      to: range.to,
      activationFrom: range.from,
      activationTo: range.to,
      className: 'z-live-preview-code-block-widget',
      kind: 'widget' as const,
      widget: new CodeBlockPreviewWidget(source, range.info, code, activateAt),
    };
  });
}

function calloutWidgetRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
): InternalLivePreviewRange[] {
  const ranges: InternalLivePreviewRange[] = [];
  const suppressedRanges = markdownSuppressedCodeRanges(docText, scanWindow);
  const scanText = docText.slice(scanWindow.from, scanWindow.to);
  const lines = [...scanText.matchAll(/^.*$/gm)]
    .map((match) => ({ text: match[0], from: scanWindow.from + (match.index ?? 0) }))
    .filter((line) => line.from <= scanWindow.to);
  const markerPattern = /^( {0,3})> ?\[!([A-Za-z0-9_-]+)\](?:[ \t]+(.*))?$/;
  const quotedLinePattern = /^ {0,3}> ?(.*)$/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const marker = markerPattern.exec(line.text);
    if (!marker) continue;

    const from = line.from;
    const type = (marker[2] ?? '').toLowerCase();
    if (!type || suppressedRanges.some((container) => isInsideRange({ from, to: from + line.text.length }, container)))
      continue;

    let to = from + line.text.length;
    const bodyLines: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const quoted = quotedLinePattern.exec(lines[cursor]?.text ?? '');
      if (!quoted) break;
      const quotedLine = lines[cursor]!;
      const quotedRange = { from: quotedLine.from, to: quotedLine.from + quotedLine.text.length };
      if (suppressedRanges.some((container) => isInsideRange(quotedRange, container))) break;
      bodyLines.push(quoted[1] ?? '');
      to = quotedRange.to;
    }

    const source = docText.slice(from, to);
    ranges.push({
      rendererId: 'callout-widget',
      from,
      to,
      activationFrom: from,
      activationTo: to,
      className: 'z-live-preview-callout-widget',
      kind: 'widget' as const,
      widget: new CalloutPreviewWidget(source, type, marker[3]?.trim() || type, bodyLines.join('\n'), from),
    });
    index = Math.max(index, cursor - 1);
  }

  return ranges;
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

const blockquoteLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'blockquote',
  match: ({ docText, visibleFrom, visibleTo }) =>
    blockquoteLineRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo)),
};

const codeBlockWidgetLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'code-block-widget',
  match: ({ docText, visibleFrom, visibleTo }) =>
    codeBlockWidgetRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo)),
};

const calloutWidgetLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'callout-widget',
  match: ({ docText, visibleFrom, visibleTo }) =>
    calloutWidgetRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo)),
};

export const defaultLivePreviewRenderers: readonly LivePreviewRenderer[] = [
  blockquoteLivePreviewRenderer as LivePreviewRenderer,
  headingLivePreviewRenderer,
  inlineCodeLivePreviewRenderer,
  inlineCodeDelimiterLivePreviewRenderer,
  markdownLinkLivePreviewRenderer,
  wikiLinkLivePreviewRenderer,
  tagLivePreviewRenderer,
  taskMarkerLivePreviewRenderer,
];

export const defaultLivePreviewWidgetRenderers: readonly InternalLivePreviewRenderer[] = [
  codeBlockWidgetLivePreviewRenderer,
  calloutWidgetLivePreviewRenderer,
];
