import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import type { EditorState } from '@codemirror/state';
import { type EditorView, WidgetType } from '@codemirror/view';
import { continueTaskListAtLineEndSelection } from '../markdown-list-commands.js';
import { insertEmptyTogglePlaceholderChild, toggleCalloutFoldSign, toggleToggleFoldSign } from './block-commands.js';
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
  markdownToggleRanges,
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

const codeBlockWidgetClassName = 'z-live-preview-code-block-widget';
const zbaseEmbedWidgetClassName = 'z-live-preview-zbase-embed-widget';
const horizontalRuleWidgetClassName = 'z-live-preview-horizontal-rule';
const calloutLineClassName = 'z-live-preview-callout-line';
const calloutTitleLineClassName = 'z-live-preview-callout-title-line';
const calloutBodyLineClassName = 'z-live-preview-callout-body-line';
const calloutStructuralClassName = 'z-live-preview-callout-structural-marker';
const calloutFoldChevronClassName = 'z-live-preview-callout-fold-chevron';
const calloutHiddenBodyClassName = 'z-live-preview-callout-hidden-body';
const toggleLineClassName = 'z-live-preview-toggle-line';
const toggleTitleLineClassName = 'z-live-preview-toggle-title-line';
const toggleStructuralClassName = 'z-live-preview-toggle-structural-marker';
const toggleChevronClassName = 'z-live-preview-toggle-chevron';
const togglePlaceholderClassName = 'z-live-preview-toggle-placeholder';
const toggleHiddenChildrenClassName = 'z-live-preview-toggle-hidden-children';

const knownCalloutTypes = new Set([
  'note',
  'abstract',
  'summary',
  'tldr',
  'info',
  'todo',
  'tip',
  'hint',
  'important',
  'success',
  'check',
  'done',
  'question',
  'help',
  'faq',
  'warning',
  'caution',
  'attention',
  'failure',
  'fail',
  'missing',
  'danger',
  'error',
  'bug',
  'example',
  'quote',
  'cite',
]);

function livePreviewScanWindow(
  docText: string,
  visibleFrom: number,
  visibleTo: number,
): Pick<LivePreviewRange, 'from' | 'to'> {
  const visibleLineStart = docText.lastIndexOf('\n', Math.max(0, visibleFrom - 1)) + 1;
  let lineStart = visibleLineStart;
  while (lineStart > 0) {
    const previousLineEnd = lineStart - 1;
    const previousLineStart = docText.lastIndexOf('\n', Math.max(0, previousLineEnd - 1)) + 1;
    const previousLine = docText.slice(previousLineStart, previousLineEnd);
    if (previousLine.trim().length === 0) break;
    lineStart = previousLineStart;
  }
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

function quotedPrefixLength(line: string): number {
  const contentOffset = quotedContentOffset(line);
  if (contentOffset < 0) return -1;
  return contentOffset;
}

function isBareQuoteLine(line: string): boolean {
  let index = 0;
  while (index < line.length && index < 4) {
    const code = line.charCodeAt(index);
    if (code !== spaceCode && code !== tabCode) break;
    index += 1;
  }
  return index <= 3 && line.charCodeAt(index) === greaterThanCode && index + 1 === line.length;
}

function offsetAfterIndentColumns(line: string, columns: number): number {
  let offset = 0;
  let consumedColumns = 0;
  while (offset < line.length && consumedColumns < columns) {
    const code = line.charCodeAt(offset);
    if (code === spaceCode) consumedColumns += 1;
    else if (code === tabCode) consumedColumns += 4;
    else break;
    offset += 1;
  }
  return consumedColumns >= columns ? offset : -1;
}

function toggleChildQuoteContentOffset(line: string): number {
  const childContentOffset = offsetAfterIndentColumns(line, 4);
  if (childContentOffset < 0) return -1;
  const relativeQuoteOffset = quotedContentOffset(line.slice(childContentOffset));
  return relativeQuoteOffset < 0 ? -1 : childContentOffset + relativeQuoteOffset;
}

function isBareToggleChildQuoteLine(line: string): boolean {
  const childContentOffset = offsetAfterIndentColumns(line, 4);
  if (childContentOffset < 0) return false;
  return isBareQuoteLine(line.slice(childContentOffset));
}

function blockquoteLineRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
  state: EditorState,
): InternalLivePreviewRange[] {
  const ranges: InternalLivePreviewRange[] = [];
  const calloutRanges = markdownCalloutRanges(docText, scanWindow, state);
  const toggleRanges = markdownToggleRanges(docText, scanWindow, state);
  for (const line of sourceLines(docText, scanWindow.from, scanWindow.to)) {
    const expandedToggleChild = toggleRanges.some(
      (range) =>
        range.foldSign === '+' &&
        range.childLines.some((childLine) => line.from >= childLine.from && line.to <= childLine.to),
    );
    const quoteOffset = expandedToggleChild ? toggleChildQuoteContentOffset(line.text) : quotedContentOffset(line.text);
    if (quoteOffset < 0) continue;
    if (expandedToggleChild ? isBareToggleChildQuoteLine(line.text) : isBareQuoteLine(line.text)) continue;
    if (calloutRanges.some((range) => line.from >= range.from && line.to <= range.to)) continue;
    if (toggleRanges.some((range) => line.from >= range.titleLineFrom && line.to <= range.titleLineTo)) continue;
    if (
      toggleRanges.some(
        (range) =>
          range.foldSign === '-' &&
          range.childLines.some((childLine) => line.from >= childLine.from && line.to <= childLine.to),
      )
    ) {
      continue;
    }
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

class CalloutStructuralMarkerWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly title: boolean,
    readonly foldSign?: '+' | '-',
    readonly foldSignFrom?: number,
  ) {
    super();
  }

  eq(other: CalloutStructuralMarkerWidget): boolean {
    return (
      this.type === other.type &&
      this.title === other.title &&
      this.foldSign === other.foldSign &&
      this.foldSignFrom === other.foldSignFrom
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const marker = document.createElement('span');
    marker.className = this.title
      ? `${calloutStructuralClassName} ${calloutStructuralClassName}--title`
      : calloutStructuralClassName;
    marker.dataset.livePreviewRenderer = 'callout-structural-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = this.title ? this.type.toUpperCase() : '';
    if (this.title && this.foldSign && this.foldSignFrom !== undefined) {
      const foldSignFrom = this.foldSignFrom;
      const chevron = document.createElement('span');
      chevron.className =
        this.foldSign === '-'
          ? `${calloutFoldChevronClassName} ${calloutFoldChevronClassName}--collapsed`
          : calloutFoldChevronClassName;
      chevron.dataset.livePreviewRenderer = 'callout-fold-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.tabIndex = -1;
      chevron.textContent = '⌄';
      chevron.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        toggleCalloutFoldSign(view, foldSignFrom, this.foldSign!);
      });
      marker.prepend(chevron);
    }
    return marker;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown';
  }
}

class ToggleStructuralMarkerWidget extends WidgetType {
  constructor(
    readonly foldSign: '+' | '-',
    readonly foldSignFrom: number,
  ) {
    super();
  }

  eq(other: ToggleStructuralMarkerWidget): boolean {
    return this.foldSign === other.foldSign && this.foldSignFrom === other.foldSignFrom;
  }

  toDOM(view: EditorView): HTMLElement {
    const marker = document.createElement('span');
    marker.className = toggleStructuralClassName;
    marker.dataset.livePreviewRenderer = 'toggle-structural-marker';
    marker.setAttribute('aria-hidden', 'true');

    const chevron = document.createElement('span');
    chevron.className =
      this.foldSign === '-' ? `${toggleChevronClassName} ${toggleChevronClassName}--collapsed` : toggleChevronClassName;
    chevron.dataset.livePreviewRenderer = 'toggle-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.tabIndex = -1;
    chevron.textContent = '⌄';
    chevron.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      toggleToggleFoldSign(view, this.foldSignFrom, this.foldSign);
    });
    marker.append(chevron);
    return marker;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown';
  }
}

class EmptyTogglePlaceholderWidget extends WidgetType {
  constructor(readonly insertAt: number) {
    super();
  }

  eq(other: EmptyTogglePlaceholderWidget): boolean {
    return this.insertAt === other.insertAt;
  }

  toDOM(view: EditorView): HTMLElement {
    const placeholder = document.createElement('span');
    placeholder.className = togglePlaceholderClassName;
    placeholder.dataset.livePreviewRenderer = 'toggle-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.textContent = 'Add child';
    placeholder.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      insertEmptyTogglePlaceholderChild(view, this.insertAt);
    });
    return placeholder;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown';
  }
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
    marker.textContent = this.ordered ? this.marker.trimEnd() : '•';
    return marker;
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

function calloutKindClass(type: string): string {
  return knownCalloutTypes.has(type) ? `${calloutLineClassName}--${type}` : `${calloutLineClassName}--generic`;
}

function calloutLineRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
  state: EditorState,
): InternalLivePreviewRange[] {
  const ranges: InternalLivePreviewRange[] = [];
  for (const callout of markdownCalloutRanges(docText, scanWindow, state)) {
    const calloutLines = sourceLines(docText, callout.from, callout.to).filter(
      (line) => line.from >= callout.from && line.to <= callout.to,
    );
    const collapsed = callout.foldSign === '-';
    for (const [index, line] of calloutLines.entries()) {
      const prefixLength = quotedPrefixLength(line.text);
      if (prefixLength < 0) continue;

      if (collapsed && index > 0) {
        ranges.push({
          rendererId: 'callout-hidden-body',
          from: line.from,
          to: line.to,
          activationFrom: line.from,
          activationTo: line.to,
          revealPolicy: 'never',
          className: calloutHiddenBodyClassName,
          kind: 'hidden-line',
        });
        continue;
      }

      const lineClassName = [
        calloutLineClassName,
        calloutKindClass(callout.type),
        index === 0 ? calloutTitleLineClassName : calloutBodyLineClassName,
        index === 0 && callout.foldSign ? `${calloutTitleLineClassName}--foldable` : '',
        index === 0 && collapsed ? `${calloutTitleLineClassName}--collapsed` : '',
      ]
        .filter(Boolean)
        .join(' ');
      ranges.push({
        rendererId: 'callout-line',
        from: line.from,
        to: line.to,
        activationFrom: line.from,
        activationTo: line.from + prefixLength,
        className: lineClassName,
        kind: 'line',
        attributes: {
          'data-callout-type': callout.type,
          'data-callout-known': knownCalloutTypes.has(callout.type) ? 'true' : 'false',
          ...(callout.foldSign ? { 'data-callout-fold': callout.foldSign === '-' ? 'collapsed' : 'expanded' } : {}),
        },
      });

      const markerTo = index === 0 ? calloutTitleMarkerEnd(line.text, prefixLength) : prefixLength;
      ranges.push({
        rendererId: 'callout-structural-marker',
        from: line.from,
        to: line.from + markerTo,
        activationFrom: line.from,
        activationTo: line.from + markerTo,
        className: calloutStructuralClassName,
        kind: 'replace',
        widget: new CalloutStructuralMarkerWidget(callout.type, index === 0, callout.foldSign, callout.foldSignFrom),
      });
    }
  }
  return ranges;
}

function calloutTitleMarkerEnd(line: string, contentOffset: number): number {
  const closingBracket = line.indexOf(']', contentOffset);
  if (closingBracket < 0) return contentOffset;
  let index = closingBracket + 1;
  const sign = line.charAt(index);
  const afterSign = line.charCodeAt(index + 1);
  if (
    (sign === '+' || sign === '-') &&
    (index + 1 >= line.length || afterSign === spaceCode || afterSign === tabCode)
  ) {
    index += 1;
  }
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code !== spaceCode && code !== tabCode) break;
    index += 1;
  }
  return index;
}

function headingClassName(level: number): string {
  return `z-live-preview-heading z-live-preview-heading--h${level}`;
}

function toggleLineRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
  state: EditorState,
): InternalLivePreviewRange[] {
  const ranges: InternalLivePreviewRange[] = [];
  for (const toggle of markdownToggleRanges(docText, scanWindow, state)) {
    const titleClassName = [
      toggleLineClassName,
      toggleTitleLineClassName,
      toggle.foldSign === '-' ? `${toggleTitleLineClassName}--collapsed` : '',
      toggle.heading ? headingClassName(toggle.heading.level) : '',
    ]
      .filter(Boolean)
      .join(' ');
    ranges.push({
      rendererId: 'toggle-line',
      from: toggle.titleLineFrom,
      to: toggle.titleLineTo,
      activationFrom: toggle.markerFrom,
      activationTo: toggle.markerTo,
      className: titleClassName,
      kind: 'line',
      attributes: { 'data-toggle-fold': toggle.foldSign === '-' ? 'collapsed' : 'expanded' },
    });
    ranges.push({
      rendererId: 'toggle-structural-marker',
      from: toggle.markerFrom,
      to: toggle.markerTo,
      activationFrom: toggle.markerFrom,
      activationTo: toggle.markerTo,
      className: toggleStructuralClassName,
      kind: 'replace',
      widget: new ToggleStructuralMarkerWidget(toggle.foldSign, toggle.foldSignFrom),
    });

    for (const childLine of toggle.childLines) {
      if (toggle.foldSign === '-') {
        ranges.push({
          rendererId: 'toggle-hidden-children',
          from: childLine.from,
          to: childLine.to,
          activationFrom: childLine.from,
          activationTo: childLine.to,
          revealPolicy: 'never',
          className: toggleHiddenChildrenClassName,
          kind: 'hidden-line',
        });
      }
    }

    if (toggle.foldSign === '+' && toggle.childLines.length === 0) {
      ranges.push({
        rendererId: 'toggle-placeholder',
        from: toggle.titleLineTo,
        to: toggle.titleLineTo,
        activationFrom: toggle.titleLineTo,
        activationTo: toggle.titleLineTo,
        revealPolicy: 'never',
        className: togglePlaceholderClassName,
        kind: 'insert',
        widget: new EmptyTogglePlaceholderWidget(toggle.titleLineTo),
      });
    }
  }
  return ranges;
}

function isInsideRange(
  range: Pick<LivePreviewRange, 'from' | 'to'>,
  container: Pick<LivePreviewRange, 'from' | 'to'>,
): boolean {
  return range.from >= container.from && range.to <= container.to;
}

function isHorizontalRuleLine(lineText: string): boolean {
  let index = 0;
  while (index < lineText.length && index < 4 && lineText.charCodeAt(index) === spaceCode) index += 1;
  if (index > 3) return false;
  const markerCode = lineText.charCodeAt(index);
  if (markerCode !== 45 && markerCode !== 42 && markerCode !== 95) return false;

  let markerCount = 0;
  while (index < lineText.length) {
    const code = lineText.charCodeAt(index);
    if (code === markerCode) {
      markerCount += 1;
      index += 1;
      continue;
    }
    if (code === spaceCode || code === tabCode) {
      index += 1;
      continue;
    }
    return false;
  }
  return markerCount >= 3;
}

function horizontalRuleRanges(
  docText: string,
  scanWindow: Pick<LivePreviewRange, 'from' | 'to'>,
  state: EditorState,
): InternalLivePreviewRange[] {
  const suppressedRanges = markdownSuppressedPreviewRanges(docText, scanWindow, state);
  return sourceLines(docText, scanWindow.from, scanWindow.to)
    .filter((line) => !suppressedRanges.some((container) => isInsideRange(line, container)))
    .filter((line) => isHorizontalRuleLine(line.text))
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
  match: ({ state, docText, visibleFrom, visibleTo }) =>
    blockquoteLineRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo), state),
};

const calloutLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'callout-line',
  match: ({ state, docText, visibleFrom, visibleTo }) =>
    calloutLineRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo), state),
};

const toggleLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'toggle-line',
  match: ({ state, docText, visibleFrom, visibleTo }) =>
    toggleLineRanges(docText, livePreviewScanWindow(docText, visibleFrom, visibleTo), state),
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

export const calloutMarkdownBlockRegistration: MarkdownBlockRegistration = {
  id: 'callout-widget',
  priority: -100,
  match: () => [],
  render: () => document.createElement('div'),
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
  calloutLivePreviewRenderer,
  toggleLivePreviewRenderer,
  blockquoteLivePreviewRenderer,
  listMarkerLivePreviewRenderer,
  taskMarkerLivePreviewRenderer,
];

export const defaultLivePreviewWidgetRenderers: readonly InternalLivePreviewRenderer[] = [
  markdownTableLivePreviewRenderer,
  ...markdownBlockRegistrationsToInternalRenderers(defaultMarkdownBlockRegistrations),
];
