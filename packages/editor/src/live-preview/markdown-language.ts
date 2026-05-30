import { markdown } from '@codemirror/lang-markdown';
import { EditorState, type Extension } from '@codemirror/state';
import { type BlockParser, GFM, type InlineContext, type InlineParser, type MarkdownExtension } from '@lezer/markdown';

export interface ZoridMarkdownEditorStateOptions {
  extensions?: readonly Extension[];
}

const dashCode = '-'.charCodeAt(0);
const exclamationCode = '!'.charCodeAt(0);
const leftBracketCode = '['.charCodeAt(0);
const rightBracketCode = ']'.charCodeAt(0);
const numberSignCode = '#'.charCodeAt(0);
const equalsCode = '='.charCodeAt(0);
const spaceCode = ' '.charCodeAt(0);
const tabCode = '\t'.charCodeAt(0);
const lineFeedCode = '\n'.charCodeAt(0);
const carriageReturnCode = '\r'.charCodeAt(0);
const underscoreCode = '_'.charCodeAt(0);
const slashCode = '/'.charCodeAt(0);

interface FrontmatterScanContext {
  readonly absoluteLineEnd: number;
  readonly to: number;
  scanLine(start: number): { readonly text: string; readonly end: number };
}

function isFrontmatterFence(text: string): boolean {
  const start = firstNonSpace(text);
  if (
    text.charCodeAt(start) !== dashCode ||
    text.charCodeAt(start + 1) !== dashCode ||
    text.charCodeAt(start + 2) !== dashCode
  ) {
    return false;
  }

  for (let index = start + 3; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== spaceCode && code !== tabCode) return false;
  }
  return true;
}

function firstNonSpace(text: string): number {
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code !== spaceCode && code !== tabCode) break;
    index += 1;
  }
  return index;
}

function isWhitespace(code: number): boolean {
  return code === spaceCode || code === tabCode || code === lineFeedCode || code === carriageReturnCode || code < 0;
}

function isAlphaNumeric(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagCharacter(code: number): boolean {
  return isAlphaNumeric(code) || code === dashCode || code === underscoreCode || code === slashCode;
}

function isCalloutTypeCharacter(code: number): boolean {
  return isAlphaNumeric(code) || code === dashCode || code === underscoreCode;
}

function isTagBoundary(code: number): boolean {
  return isWhitespace(code) || code === leftBracketCode || code === rightBracketCode || code === equalsCode;
}

function addInlineElement(cx: InlineContext, type: string, from: number, to: number): number {
  return cx.addElement(cx.elt(type, from, to));
}

function hasClosingFrontmatterFence(cx: BlockParserContext): boolean {
  const scanner = cx as unknown as FrontmatterScanContext;
  let nextLineStart = scanner.absoluteLineEnd + 1;
  while (nextLineStart <= scanner.to) {
    const nextLine = scanner.scanLine(nextLineStart);
    if (isFrontmatterFence(nextLine.text)) return true;
    if (nextLine.end >= scanner.to) return false;
    nextLineStart = nextLine.end + 1;
  }
  return false;
}

type BlockParserContext = Parameters<NonNullable<BlockParser['parse']>>[0];

const zoridFrontmatterBlockParser: BlockParser = {
  name: 'ZoridFrontmatter',
  before: 'HorizontalRule',
  parse(cx, line) {
    if (cx.lineStart !== 0 || line.basePos !== 0 || !isFrontmatterFence(line.text) || !hasClosingFrontmatterFence(cx)) {
      return false;
    }

    const from = cx.lineStart;
    let to = cx.lineStart + line.text.length;
    while (cx.nextLine()) {
      to = cx.lineStart + line.text.length;
      if (isFrontmatterFence(line.text)) {
        cx.nextLine();
        break;
      }
    }

    cx.addElement(cx.elt('ZoridFrontmatter', from, to));
    return true;
  },
};

const zoridCalloutInlineParser: InlineParser = {
  name: 'ZoridCallout',
  before: 'Link',
  parse(cx, next, pos) {
    if (next !== leftBracketCode || cx.char(pos + 1) !== exclamationCode) return -1;

    let end = pos + 2;
    while (end < cx.end) {
      const code = cx.char(end);
      if (code === rightBracketCode) return addInlineElement(cx, 'ZoridCallout', pos, end + 1);
      if (!isCalloutTypeCharacter(code)) return -1;
      end += 1;
    }
    return -1;
  },
};

const wikiLinkInlineParser: InlineParser = {
  name: 'WikiLink',
  before: 'Link',
  parse(cx, next, pos) {
    if (next !== leftBracketCode || cx.char(pos + 1) !== leftBracketCode) return -1;

    let end = pos + 2;
    while (end + 1 < cx.end) {
      const code = cx.char(end);
      if (isWhitespace(code) && (code === lineFeedCode || code === carriageReturnCode)) return -1;
      if (code === rightBracketCode && cx.char(end + 1) === rightBracketCode) {
        return addInlineElement(cx, 'WikiLink', pos, end + 2);
      }
      end += 1;
    }
    return -1;
  },
};

const tagInlineParser: InlineParser = {
  name: 'Tag',
  after: 'Link',
  parse(cx, next, pos) {
    if (next !== numberSignCode) return -1;
    const previous = cx.char(pos - 1);
    const first = cx.char(pos + 1);
    const startsInlineSection = pos === cx.offset;
    if ((!startsInlineSection && !isTagBoundary(previous)) || !isTagCharacter(first)) return -1;

    let end = pos + 2;
    while (end < cx.end && isTagCharacter(cx.char(end))) end += 1;
    return addInlineElement(cx, 'Tag', pos, end);
  },
};

const highlightInlineParser: InlineParser = {
  name: 'Highlight',
  before: 'Emphasis',
  parse(cx, next, pos) {
    if (next !== equalsCode || cx.char(pos + 1) !== equalsCode) return -1;

    let end = pos + 2;
    while (end + 1 < cx.end) {
      if (cx.char(end) === equalsCode && cx.char(end + 1) === equalsCode && end > pos + 2) {
        return addInlineElement(cx, 'Highlight', pos, end + 2);
      }
      end += 1;
    }
    return -1;
  },
};

export const zoridMarkdownExtensions: MarkdownExtension = [
  GFM,
  {
    defineNodes: [{ name: 'ZoridFrontmatter', block: true }, 'ZoridCallout', 'WikiLink', 'Tag', 'Highlight'],
    parseBlock: [zoridFrontmatterBlockParser],
    parseInline: [zoridCalloutInlineParser, wikiLinkInlineParser, tagInlineParser, highlightInlineParser],
  },
];

export function zoridMarkdown(): Extension {
  return markdown({ extensions: zoridMarkdownExtensions });
}

export function createZoridMarkdownEditorState(
  text: string,
  options: ZoridMarkdownEditorStateOptions = {},
): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [zoridMarkdown(), ...(options.extensions ?? [])],
  });
}
