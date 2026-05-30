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
  extra?: Pick<LivePreviewRange, 'kind' | 'activationFrom' | 'activationTo'>,
): LivePreviewRange | null {
  const className = rendererClassNames[rendererId];
  if (!className || to <= from) return null;
  return { rendererId, from, to, className, ...extra };
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
        pushRange(ranges, previewRange('heading', node.from, node.to));
        return false;
      }

      if (node.name === 'InlineCode') {
        ranges.push(...inlineCodeRanges(context.docText, node.from, node.to));
        return false;
      }

      if (node.name === 'Link') {
        if (hasChildNamed(node.node, 'URL')) {
          pushRange(ranges, previewRange('markdown-link', node.from, node.to));
        }
        return false;
      }

      const rendererId = nodeRendererIds[node.name];
      if (rendererId) {
        pushRange(ranges, previewRange(rendererId, node.from, node.to));
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
