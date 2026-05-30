import type { EditorState } from '@codemirror/state';
import { type EditorView, WidgetType } from '@codemirror/view';
import { type LivePreviewBlockRenderer, livePreviewBlockRendererToInternalRenderer } from './block-renderers.js';
import {
  type InternalLivePreviewRange,
  type InternalLivePreviewRenderer,
  setInternalLivePreviewFocused,
} from './internal-types.js';
import {
  markdownCalloutRanges,
  markdownCompleteFencedCodeBlockRanges,
  markdownFrontmatterRanges,
  markdownSuppressedPreviewRanges,
} from './markdown-code-context.js';
import { syntaxTreeLivePreviewRenderer } from './syntax-tree-ranges.js';
import { taskMarkerRangesForState } from './task-marker-ranges.js';
import { toggleTaskMarkerAtPosition } from './task-toggle.js';
import type { LivePreviewRange, LivePreviewRenderer } from './types.js';

interface CodeBlockPreviewMatch {
  readonly from: number;
  readonly to: number;
  readonly activationFrom: number;
  readonly activationTo: number;
  readonly className: string;
  readonly source: string;
  readonly info: string;
  readonly code: string;
  readonly activateAt: number;
}

interface CalloutPreviewMatch {
  readonly from: number;
  readonly to: number;
  readonly activationFrom: number;
  readonly activationTo: number;
  readonly className: string;
  readonly source: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly activateAt: number;
}

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

const spaceCode = ' '.charCodeAt(0);
const tabCode = '\t'.charCodeAt(0);
const greaterThanCode = '>'.charCodeAt(0);
const lineFeed = '\n';

interface SourceLine {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

function lineStartBefore(docText: string, position: number): number {
  return docText.lastIndexOf(lineFeed, Math.max(0, position - 1)) + 1;
}

function lineEndAfter(docText: string, position: number): number {
  const lineEnd = docText.indexOf(lineFeed, position);
  return lineEnd === -1 ? docText.length : lineEnd;
}

function sourceLines(docText: string, from: number, to: number): SourceLine[] {
  const lines: SourceLine[] = [];
  let lineFrom = lineStartBefore(docText, from);
  while (lineFrom <= to && lineFrom < docText.length) {
    const lineTo = lineEndAfter(docText, lineFrom);
    lines.push({ from: lineFrom, to: lineTo, text: docText.slice(lineFrom, lineTo) });
    if (lineTo >= docText.length) break;
    lineFrom = lineTo + 1;
  }
  return lines;
}

function quotedContentOffset(line: string): number {
  let index = 0;
  while (index < line.length && index < 4) {
    const code = line.charCodeAt(index);
    if (code !== spaceCode && code !== tabCode) break;
    index += 1;
  }
  if (index > 3 || line.charCodeAt(index) !== greaterThanCode) return -1;
  index += 1;
  if (line.charCodeAt(index) === spaceCode) index += 1;
  return index;
}

function blockquoteLineRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
): InternalLivePreviewRange[] {
  const ranges: InternalLivePreviewRange[] = [];
  for (const line of sourceLines(docText, scanWindow.from, scanWindow.to)) {
    if (quotedContentOffset(line.text) < 0) continue;
    ranges.push({
      rendererId: 'blockquote',
      from: line.from,
      to: line.to,
      activationFrom: line.from,
      activationTo: line.to,
      className: 'z-live-preview-blockquote-line',
      kind: 'line',
    });
  }
  return ranges;
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

class TaskCheckboxPreviewWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly activateAt: number,
  ) {
    super();
  }

  eq(other: TaskCheckboxPreviewWidget): boolean {
    return this.checked === other.checked && this.activateAt === other.activateAt;
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement('span');
    checkbox.className = this.checked
      ? 'z-live-preview-task-checkbox z-live-preview-task-checkbox--checked'
      : 'z-live-preview-task-checkbox';
    checkbox.dataset.livePreviewRenderer = 'task-marker';
    checkbox.setAttribute('role', 'checkbox');
    checkbox.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    checkbox.textContent = this.checked ? '✓' : '';

    checkbox.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.focus();
      view.dispatch({
        effects: setInternalLivePreviewFocused.of(true),
        selection: { anchor: this.activateAt },
        scrollIntoView: true,
      });
      toggleTaskMarkerAtPosition(view, this.activateAt);
    });

    return checkbox;
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
  state: EditorState,
): CodeBlockPreviewMatch[] {
  const suppressedRanges = markdownFrontmatterRanges(docText, scanWindow, state);
  return markdownCompleteFencedCodeBlockRanges(docText, scanWindow, state)
    .filter((range) => !suppressedRanges.some((container) => isInsideRange(range, container)))
    .map((range) => {
      const source = docText.slice(range.from, range.to);
      const code = docText.slice(range.contentFrom, range.contentTo);
      const activateAt = range.contentFrom < range.contentTo ? range.contentFrom : range.from;
      return {
        from: range.from,
        to: range.to,
        activationFrom: range.from,
        activationTo: range.to,
        className: 'z-live-preview-code-block-widget',
        source,
        info: range.info,
        code,
        activateAt,
      };
    });
}

function calloutWidgetRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
  state: EditorState,
): CalloutPreviewMatch[] {
  return markdownCalloutRanges(docText, scanWindow, state).map((range) => ({
    from: range.from,
    to: range.to,
    activationFrom: range.from,
    activationTo: range.to,
    className: 'z-live-preview-callout-widget',
    source: docText.slice(range.from, range.to),
    type: range.type,
    title: range.title,
    body: range.body,
    activateAt: range.from,
  }));
}

function isInsideRange(
  range: Pick<LivePreviewRange, 'from' | 'to'>,
  container: Pick<LivePreviewRange, 'from' | 'to'>,
): boolean {
  return range.from >= container.from && range.to <= container.to;
}

export const headingLivePreviewRenderer: LivePreviewRenderer = syntaxTreeLivePreviewRenderer('heading');

export const inlineCodeLivePreviewRenderer: LivePreviewRenderer = syntaxTreeLivePreviewRenderer('inline-code');

export const inlineCodeDelimiterLivePreviewRenderer: LivePreviewRenderer =
  syntaxTreeLivePreviewRenderer('inline-code-delimiter');

export const strongLivePreviewRenderer: LivePreviewRenderer = syntaxTreeLivePreviewRenderer('strong');

export const emphasisLivePreviewRenderer: LivePreviewRenderer = syntaxTreeLivePreviewRenderer('emphasis');

export const strikethroughLivePreviewRenderer: LivePreviewRenderer = syntaxTreeLivePreviewRenderer('strikethrough');

export const highlightLivePreviewRenderer: LivePreviewRenderer = syntaxTreeLivePreviewRenderer('highlight');

export const markdownLinkLivePreviewRenderer: LivePreviewRenderer = syntaxTreeLivePreviewRenderer('markdown-link');

export const wikiLinkLivePreviewRenderer: LivePreviewRenderer = syntaxTreeLivePreviewRenderer('wiki-link');

export const tagLivePreviewRenderer: LivePreviewRenderer = syntaxTreeLivePreviewRenderer('tag');

export const taskMarkerLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'task-marker',
  match: ({ state, visibleFrom, visibleTo }) =>
    taskMarkerRangesForState(state, visibleFrom, visibleTo).map((range) => ({
      rendererId: 'task-marker',
      from: range.markerFrom,
      to: range.markerTo,
      activationFrom: range.markerFrom,
      activationTo: range.markerTo,
      className: 'z-live-preview-task-checkbox',
      kind: 'replace',
      widget: new TaskCheckboxPreviewWidget(range.checked, range.checkboxFrom),
    })),
};

const blockquoteLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'blockquote',
  match: ({ docText, visibleFrom, visibleTo }) =>
    blockquoteLineRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo)),
};

const codeBlockWidgetBlockRenderer: LivePreviewBlockRenderer<CodeBlockPreviewMatch> = {
  id: 'code-block-widget',
  match: ({ state, docText, visibleFrom, visibleTo }) =>
    codeBlockWidgetRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo), state),
  widget: (match) => new CodeBlockPreviewWidget(match.source, match.info, match.code, match.activateAt),
};

const codeBlockWidgetLivePreviewRenderer: InternalLivePreviewRenderer =
  livePreviewBlockRendererToInternalRenderer(codeBlockWidgetBlockRenderer);

const calloutWidgetBlockRenderer: LivePreviewBlockRenderer<CalloutPreviewMatch> = {
  id: 'callout-widget',
  match: ({ state, docText, visibleFrom, visibleTo }) =>
    calloutWidgetRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo), state),
  widget: (match) => new CalloutPreviewWidget(match.source, match.type, match.title, match.body, match.activateAt),
};

const calloutWidgetLivePreviewRenderer: InternalLivePreviewRenderer =
  livePreviewBlockRendererToInternalRenderer(calloutWidgetBlockRenderer);

export const defaultLivePreviewRenderers: readonly LivePreviewRenderer[] = [
  headingLivePreviewRenderer,
  inlineCodeLivePreviewRenderer,
  inlineCodeDelimiterLivePreviewRenderer,
  strongLivePreviewRenderer,
  emphasisLivePreviewRenderer,
  strikethroughLivePreviewRenderer,
  highlightLivePreviewRenderer,
  markdownLinkLivePreviewRenderer,
  wikiLinkLivePreviewRenderer,
  tagLivePreviewRenderer,
];

export const defaultLivePreviewInternalRenderers: readonly InternalLivePreviewRenderer[] = [
  blockquoteLivePreviewRenderer,
  taskMarkerLivePreviewRenderer,
];

export const defaultLivePreviewWidgetRenderers: readonly InternalLivePreviewRenderer[] = [
  codeBlockWidgetLivePreviewRenderer,
  calloutWidgetLivePreviewRenderer,
];
