import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import type { EditorState } from '@codemirror/state';
import { type EditorView, WidgetType } from '@codemirror/view';
import { continueTaskListAtLineEndSelection } from '../markdown-list-commands.js';
import {
  type InternalLivePreviewRange,
  type InternalLivePreviewRenderer,
  setInternalLivePreviewFocused,
} from './internal-types.js';
import { listMarkerRangesForState } from './list-marker-ranges.js';
import {
  type MarkdownBlockMatch,
  type MarkdownBlockRegistration,
  markdownBlockRegistrationsToInternalRenderers,
} from './markdown-blocks.js';
import {
  markdownCalloutRanges,
  markdownCompleteFencedCodeBlockRanges,
  markdownFrontmatterRanges,
  markdownSuppressedPreviewRanges,
} from './markdown-code-context.js';
import { syntaxTreeLivePreviewRenderer } from './syntax-tree-ranges.js';
import { markdownTableLivePreviewRenderer } from './table/renderer.js';
import { taskMarkerRangesForState } from './task-marker-ranges.js';
import { toggleTaskMarkerAtPosition } from './task-toggle.js';
import type { LivePreviewRange, LivePreviewRenderer } from './types.js';

interface CodeBlockPreviewMatch extends MarkdownBlockMatch {
  readonly source: string;
  readonly info: string;
  readonly code: string;
  readonly activateAt: number;
}

interface CalloutPreviewMatch extends MarkdownBlockMatch {
  readonly source: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly activateAt: number;
}

const codeBlockWidgetClassName = 'z-live-preview-code-block-widget';
const calloutWidgetClassName = 'z-live-preview-callout-widget';
const zbaseEmbedWidgetClassName = 'z-live-preview-zbase-embed-widget';
const horizontalRuleWidgetClassName = 'z-live-preview-horizontal-rule';

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
    wrapper.className = codeBlockWidgetClassName;
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
    checkbox.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete');
    checkbox.setAttribute('aria-keyshortcuts', 'Space Enter');
    checkbox.setAttribute('aria-description', 'Press Space to toggle the task or Enter to continue the task list.');
    checkbox.title = 'Space toggles task; Enter continues task list';
    checkbox.tabIndex = 0;
    checkbox.textContent = this.checked ? '✓' : '';

    const toggle = () => {
      toggleTaskMarkerAtPosition(view, this.activateAt);
    };

    const continueTask = (): boolean => {
      view.focus();
      view.dispatch({
        effects: setInternalLivePreviewFocused.of(true),
        selection: { anchor: this.activateAt },
        scrollIntoView: true,
      });
      if (continueTaskListAtLineEndSelection(view)) return true;
      view.dispatch({ selection: { anchor: view.state.doc.lineAt(this.activateAt).to }, scrollIntoView: true });
      return insertNewlineContinueMarkup(view);
    };

    checkbox.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        if (continueTask()) event.preventDefault();
        return;
      }
      if (event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });

    checkbox.addEventListener('mousedown', (event) => {
      event.preventDefault();
      toggle();
    });

    return checkbox;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown';
  }
}

class HorizontalRulePreviewWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const rule = document.createElement('span');
    rule.className = horizontalRuleWidgetClassName;
    rule.dataset.livePreviewRenderer = 'horizontal-rule';
    rule.setAttribute('role', 'separator');
    rule.setAttribute('aria-orientation', 'horizontal');
    return rule;
  }
}

class ListMarkerPreviewWidget extends WidgetType {
  constructor(
    readonly marker: string,
    readonly ordered: boolean,
    readonly orderedIndex?: number,
  ) {
    super();
  }

  eq(other: ListMarkerPreviewWidget): boolean {
    return this.marker === other.marker && this.ordered === other.ordered && this.orderedIndex === other.orderedIndex;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = this.ordered
      ? 'z-live-preview-list-marker z-live-preview-list-marker--ordered'
      : 'z-live-preview-list-marker';
    marker.dataset.livePreviewRenderer = 'list-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = this.ordered ? `${this.orderedIndex ?? ''}.` : '•';
    return marker;
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
    wrapper.className = calloutWidgetClassName;
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
      const code = docText.slice(range.contentFrom, range.contentTo);
      const activateAt = range.contentFrom < range.contentTo ? range.contentFrom : range.from;
      return {
        id: `code-block-widget:${range.from}:${range.to}`,
        type: `fenced-code:${range.info}`,
        from: range.from,
        to: range.to,
        activationFrom: range.from,
        activationTo: range.to,
        definition: {
          kind: 'inline' as const,
          sourceFrom: range.from,
          sourceTo: range.to,
          sourceText: docText.slice(range.from, range.to),
        },
        className: codeBlockWidgetClassName,
        atomic: 'none' as const,
        source: docText.slice(range.from, range.to),
        info: range.info,
        code,
        activateAt,
        meta: {
          info: range.info,
          marker: range.marker,
          markerLength: range.markerLength,
          code,
          contentFrom: range.contentFrom,
          contentTo: range.contentTo,
        },
      };
    });
}

function calloutWidgetRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
  state: EditorState,
): CalloutPreviewMatch[] {
  return markdownCalloutRanges(docText, scanWindow, state).map((range) => ({
    id: `callout-widget:${range.from}:${range.to}`,
    type: range.type,
    from: range.from,
    to: range.to,
    activationFrom: range.from,
    activationTo: range.to,
    definition: {
      kind: 'inline' as const,
      sourceFrom: range.from,
      sourceTo: range.to,
      sourceText: docText.slice(range.from, range.to),
    },
    className: calloutWidgetClassName,
    atomic: 'none' as const,
    source: docText.slice(range.from, range.to),
    title: range.title,
    body: range.body,
    activateAt: range.from,
    meta: { type: range.type, title: range.title, body: range.body },
  }));
}

function isInsideRange(
  range: Pick<LivePreviewRange, 'from' | 'to'>,
  container: Pick<LivePreviewRange, 'from' | 'to'>,
): boolean {
  return range.from >= container.from && range.to <= container.to;
}

function horizontalRuleRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
  state: EditorState,
): InternalLivePreviewRange[] {
  const suppressedRanges = markdownSuppressedPreviewRanges(docText, scanWindow, state);
  return sourceLines(docText, scanWindow.from, scanWindow.to)
    .filter((line) => !suppressedRanges.some((container) => isInsideRange(line, container)))
    .filter((line) => /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line.text))
    .map((line) => ({
      rendererId: 'horizontal-rule',
      from: line.from,
      to: line.to,
      activationFrom: line.from,
      activationTo: line.to,
      className: horizontalRuleWidgetClassName,
      kind: 'replace',
      widget: new HorizontalRulePreviewWidget(),
    }));
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

const listMarkerLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'list-marker',
  match: ({ state, visibleFrom, visibleTo }) =>
    listMarkerRangesForState(state, visibleFrom, visibleTo).map((range) => ({
      rendererId: 'list-marker',
      from: range.markerFrom,
      to: range.markerTo,
      activationFrom: range.markerFrom,
      activationTo: range.markerTo,
      className: 'z-live-preview-list-marker',
      kind: 'replace',
      widget: new ListMarkerPreviewWidget(range.marker, range.ordered, range.orderedIndex),
    })),
};

const blockquoteLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'blockquote',
  match: ({ docText, visibleFrom, visibleTo }) =>
    blockquoteLineRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo)),
};

const horizontalRuleLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'horizontal-rule',
  match: ({ state, docText, visibleFrom, visibleTo }) =>
    horizontalRuleRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo), state),
};

export const codeBlockMarkdownBlockRegistration: MarkdownBlockRegistration<CodeBlockPreviewMatch> = {
  id: 'code-block-widget',
  priority: -100,
  match: ({ state, docText, visibleFrom, visibleTo }) =>
    codeBlockWidgetRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo), state),
  render: (match) => new CodeBlockPreviewWidget(match.source, match.info, match.code, match.activateAt),
};

export const calloutMarkdownBlockRegistration: MarkdownBlockRegistration<CalloutPreviewMatch> = {
  id: 'callout-widget',
  priority: -100,
  match: ({ state, docText, visibleFrom, visibleTo }) =>
    calloutWidgetRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo), state),
  render: (match) => new CalloutPreviewWidget(match.source, match.type, match.title, match.body, match.activateAt),
};

export const zbaseEmbedMarkdownBlockRegistration: MarkdownBlockRegistration = {
  id: 'zbase-embed-widget',
  priority: -100,
  syntax: [{ kind: 'embed-reference', extensions: ['.zbase'] }],
  render(match) {
    const wrapper = document.createElement('div');
    wrapper.className = zbaseEmbedWidgetClassName;
    wrapper.setAttribute('role', 'group');

    const label = document.createElement('div');
    label.className = 'z-live-preview-zbase-embed-widget__label';
    label.textContent = 'Data view';
    wrapper.append(label);

    const target = document.createElement('div');
    target.className = 'z-live-preview-zbase-embed-widget__target';
    if (match.definition.kind === 'external') {
      target.textContent = match.definition.fragment
        ? `${match.definition.path}#${match.definition.fragment}`
        : match.definition.path;
    } else {
      target.textContent = match.definition.sourceText;
    }
    wrapper.append(target);

    return wrapper;
  },
  onActivate(_event, match) {
    if (match.definition.kind !== 'external') {
      return { kind: 'reveal-source', range: { from: match.from, to: match.to } };
    }
    return match.definition.fragment
      ? { kind: 'open-reference', path: match.definition.path, fragment: match.definition.fragment }
      : { kind: 'open-reference', path: match.definition.path };
  },
  onEdit(_event, match) {
    if (match.definition.kind !== 'external') {
      return { kind: 'reveal-source', range: { from: match.from, to: match.to } };
    }
    return match.definition.fragment
      ? { kind: 'open-reference', path: match.definition.path, fragment: match.definition.fragment }
      : { kind: 'open-reference', path: match.definition.path };
  },
};

export const defaultMarkdownBlockRegistrations: readonly MarkdownBlockRegistration[] = [
  codeBlockMarkdownBlockRegistration,
  calloutMarkdownBlockRegistration,
  zbaseEmbedMarkdownBlockRegistration,
];

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
  horizontalRuleLivePreviewRenderer,
  blockquoteLivePreviewRenderer,
  listMarkerLivePreviewRenderer,
  taskMarkerLivePreviewRenderer,
];

export const defaultLivePreviewWidgetRenderers: readonly InternalLivePreviewRenderer[] = [
  markdownTableLivePreviewRenderer,
  ...markdownBlockRegistrationsToInternalRenderers(defaultMarkdownBlockRegistrations),
];
