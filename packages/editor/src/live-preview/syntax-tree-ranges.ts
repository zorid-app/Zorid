import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { createZoridMarkdownEditorState } from './markdown-language.js';
import type { LivePreviewContext, LivePreviewRange } from './types.js';

const syntaxTreeParseTimeoutMs = 25;
const backtickCode = '`'.charCodeAt(0);
const syntaxRangeCache = new WeakMap<LivePreviewContext, readonly LivePreviewRange[]>();

const rendererClassNames: Readonly<Record<string, string>> = {
  heading: 'z-live-preview-heading',
  'inline-code': 'z-live-preview-inline-code',
  'inline-code-delimiter': 'z-live-preview-inline-code-delimiter',
  strong: 'z-live-preview-strong',
  emphasis: 'z-live-preview-emphasis',
  strikethrough: 'z-live-preview-strikethrough',
  highlight: 'z-live-preview-highlight',
  'markdown-link': 'z-live-preview-link',
  'wiki-link': 'z-live-preview-wiki-link',
  tag: 'z-live-preview-tag',
};

const headingLevelClassNames: Readonly<Record<number, string>> = {
  1: 'z-live-preview-heading z-live-preview-heading--h1',
  2: 'z-live-preview-heading z-live-preview-heading--h2',
  3: 'z-live-preview-heading z-live-preview-heading--h3',
  4: 'z-live-preview-heading z-live-preview-heading--h4',
  5: 'z-live-preview-heading z-live-preview-heading--h5',
  6: 'z-live-preview-heading z-live-preview-heading--h6',
};

const nodeRendererIds: Readonly<Record<string, string>> = {
  StrongEmphasis: 'strong',
  Emphasis: 'emphasis',
  Strikethrough: 'strikethrough',
  Highlight: 'highlight',
  WikiLink: 'wiki-link',
  Tag: 'tag',
};

export function stateWithAvailableZoridSyntaxTree(state: EditorState, docText: string, upto: number): EditorState {
  if (syntaxTreeAvailable(state, upto) || ensureSyntaxTree(state, upto, syntaxTreeParseTimeoutMs)) return state;

  const parserState = createZoridMarkdownEditorState(docText);
  ensureSyntaxTree(parserState, upto, syntaxTreeParseTimeoutMs);
  return parserState;
}

function previewRange(
  rendererId: string,
  from: number,
  to: number,
  extra?: Pick<LivePreviewRange, 'kind' | 'activationFrom' | 'activationTo' | 'attributes' | 'revealPolicy'> & {
    readonly className?: string;
  },
): LivePreviewRange | null {
  const className = extra?.className ?? rendererClassNames[rendererId];
  if (!className || to <= from) return null;
  const { className: _className, ...rest } = extra ?? {};
  return { rendererId, from, to, className, ...rest };
}

function pushRange(ranges: LivePreviewRange[], range: LivePreviewRange | null): void {
  if (range) ranges.push(range);
}

function hasChildNamed(parent: { readonly firstChild: SyntaxNodeLike | null }, name: string): boolean {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return true;
  }
  return false;
}

interface SyntaxNodeLike {
  readonly name: string;
  readonly firstChild: SyntaxNodeLike | null;
  readonly nextSibling: SyntaxNodeLike | null;
}

function backtickRunLengthAt(docText: string, from: number, to: number): number {
  let length = 0;
  while (from + length < to && docText.charCodeAt(from + length) === backtickCode) length += 1;
  return length;
}

function closingBacktickRunLength(docText: string, from: number, to: number): number {
  let length = 0;
  while (to - length - 1 >= from && docText.charCodeAt(to - length - 1) === backtickCode) length += 1;
  return length;
}

function inlineCodeRanges(docText: string, from: number, to: number): LivePreviewRange[] {
  const openingLength = backtickRunLengthAt(docText, from, to);
  const closingLength = closingBacktickRunLength(docText, from + openingLength, to);
  return [
    previewRange('inline-code-delimiter', from, from + openingLength, {
      activationFrom: from,
      activationTo: to,
      kind: 'replace',
    }),
    previewRange('inline-code', from, to),
    previewRange('inline-code-delimiter', to - closingLength, to, {
      activationFrom: from,
      activationTo: to,
      kind: 'replace',
    }),
  ].filter((range): range is LivePreviewRange => range !== null);
}

function headingRanges(docText: string, from: number, to: number): LivePreviewRange[] {
  let markerLength = 0;
  while (markerLength < 6 && docText.charAt(from + markerLength) === '#') markerLength += 1;
  if (markerLength === 0) return [];
  if (from + markerLength >= to || docText.charAt(from + markerLength) !== ' ') return [];

  let contentFrom = from + markerLength;
  while (contentFrom < to && docText.charAt(contentFrom) === ' ') contentFrom += 1;
  const className = headingLevelClassNames[markerLength] ?? 'z-live-preview-heading';

  return [
    previewRange('heading', from, contentFrom, {
      activationFrom: from,
      activationTo: to,
      kind: 'replace',
      revealPolicy: 'caret',
    }),
    previewRange('heading', from, contentFrom, {
      activationFrom: from,
      activationTo: to,
      className,
      revealPolicy: 'never',
    }),
    previewRange('heading', contentFrom, to, {
      activationFrom: from,
      activationTo: to,
      className,
      revealPolicy: 'never',
    }),
  ].filter((range): range is LivePreviewRange => range !== null);
}

function delimiterRanges(
  rendererId: string,
  from: number,
  to: number,
  openingLength: number,
  closingLength = openingLength,
): LivePreviewRange[] {
  return [
    previewRange(rendererId, from, from + openingLength, {
      activationFrom: from,
      activationTo: to,
      kind: 'replace',
    }),
    previewRange(rendererId, from + openingLength, to - closingLength, {
      activationFrom: from,
      activationTo: to,
    }),
    previewRange(rendererId, to - closingLength, to, {
      activationFrom: from,
      activationTo: to,
      kind: 'replace',
    }),
  ].filter((range): range is LivePreviewRange => range !== null);
}

function markdownLinkRanges(docText: string, from: number, to: number): LivePreviewRange[] {
  const source = docText.slice(from, to);
  const labelEnd = source.indexOf('](');
  if (!source.startsWith('[') || labelEnd < 0 || !source.endsWith(')')) return [];

  const labelFrom = from + 1;
  const labelTo = from + labelEnd;
  const url = source.slice(labelEnd + 2, -1);
  const webUrl = isWebUrl(url) ? url : undefined;
  return [
    previewRange('markdown-link', from, labelFrom, {
      activationFrom: from,
      activationTo: to,
      kind: 'replace',
    }),
    previewRange('markdown-link', labelFrom, labelTo, {
      activationFrom: from,
      activationTo: to,
      ...(webUrl ? { attributes: { 'data-live-preview-url': webUrl } } : {}),
    }),
    previewRange('markdown-link', labelTo, to, {
      activationFrom: from,
      activationTo: to,
      kind: 'replace',
    }),
  ].filter((range): range is LivePreviewRange => range !== null);
}

function wikiLinkTarget(source: string): { readonly path: string; readonly fragment?: string } {
  const fragmentStart = source.indexOf('#');
  if (fragmentStart < 0) return { path: source };
  const path = source.slice(0, fragmentStart);
  const fragment = source.slice(fragmentStart + 1);
  return fragment ? { path, fragment } : { path };
}

function wikiLinkAttributes(source: string): Readonly<Record<string, string>> {
  const target = wikiLinkTarget(source);
  return {
    'data-live-preview-reference': target.path,
    ...(target.fragment ? { 'data-live-preview-reference-fragment': target.fragment } : {}),
  };
}

function wikiLinkRanges(docText: string, from: number, to: number): LivePreviewRange[] {
  const source = docText.slice(from, to);
  if (!source.startsWith('[[') || !source.endsWith(']]')) return [];

  const body = source.slice(2, -2);
  if (!body) return [];
  const aliasSeparator = body.indexOf('|');
  const targetSource = aliasSeparator < 0 ? body : body.slice(0, aliasSeparator);
  const labelFrom = aliasSeparator < 0 ? from + 2 : from + 2 + aliasSeparator + 1;
  const labelTo = to - 2;
  if (!targetSource || labelTo <= labelFrom) return [];

  return [
    previewRange('wiki-link', from, labelFrom, {
      activationFrom: from,
      activationTo: to,
      kind: 'replace',
    }),
    previewRange('wiki-link', labelFrom, labelTo, {
      activationFrom: from,
      activationTo: to,
      attributes: wikiLinkAttributes(targetSource),
    }),
    previewRange('wiki-link', labelTo, to, {
      activationFrom: from,
      activationTo: to,
      kind: 'replace',
    }),
  ].filter((range): range is LivePreviewRange => range !== null);
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function collectSyntaxTreeLivePreviewRanges(context: LivePreviewContext): readonly LivePreviewRange[] {
  const cached = syntaxRangeCache.get(context);
  if (cached) return cached;

  const parseTo = Math.min(context.docText.length, context.visibleTo);
  const parseState = stateWithAvailableZoridSyntaxTree(context.state, context.docText, parseTo);
  const tree = syntaxTree(parseState);
  const ranges: LivePreviewRange[] = [];

  tree.iterate({
    from: Math.max(0, context.visibleFrom - 1),
    to: Math.min(context.docText.length, context.visibleTo + 1),
    enter: (node) => {
      if (node.to <= context.visibleFrom || node.from >= context.visibleTo) return;

      if (node.name.startsWith('ATXHeading')) {
        ranges.push(...headingRanges(context.docText, node.from, node.to));
        return false;
      }

      if (node.name === 'InlineCode') {
        ranges.push(...inlineCodeRanges(context.docText, node.from, node.to));
        return false;
      }

      if (node.name === 'Link') {
        if (hasChildNamed(node.node, 'URL')) {
          ranges.push(...markdownLinkRanges(context.docText, node.from, node.to));
        }
        return false;
      }

      if (node.name === 'WikiLink') {
        ranges.push(...wikiLinkRanges(context.docText, node.from, node.to));
        return false;
      }

      const rendererId = nodeRendererIds[node.name];
      if (rendererId) {
        if (rendererId === 'strong') ranges.push(...delimiterRanges(rendererId, node.from, node.to, 2));
        else if (rendererId === 'strikethrough' || rendererId === 'highlight') {
          ranges.push(...delimiterRanges(rendererId, node.from, node.to, 2));
        } else if (rendererId === 'emphasis') {
          ranges.push(...delimiterRanges(rendererId, node.from, node.to, 1));
        } else pushRange(ranges, previewRange(rendererId, node.from, node.to));
        return false;
      }
    },
  });

  syntaxRangeCache.set(context, ranges);
  return ranges;
}

export function syntaxTreeLivePreviewRenderer(rendererId: string): {
  readonly id: string;
  match(context: LivePreviewContext): readonly LivePreviewRange[];
} {
  return {
    id: rendererId,
    match: (context) => collectSyntaxTreeLivePreviewRanges(context).filter((range) => range.rendererId === rendererId),
  };
}
