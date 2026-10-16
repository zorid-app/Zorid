import { markdown } from '@codemirror/lang-markdown';
import type { syntaxTree } from '@codemirror/language';

type MarkdownExtension = NonNullable<NonNullable<Parameters<typeof markdown>[0]>['extensions']>;
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

export interface MathSpan {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  tex: string;
  display: boolean;
  block: boolean;
  closed: boolean;
}

/** Source coordinates are unchanged. Incomplete blocks are recognizable for
 * editing, but callers must not replace/render them until closed is true. */
export function mathSpan(node: SyntaxNode, read: (from: number, to: number) => string): MathSpan | null {
  if (!['ZoridMathInline', 'ZoridMathDisplay', 'ZoridMathBlock'].includes(node.name)) return null;
  const opening = node.firstChild, ending = node.lastChild;
  if (!opening || opening.name !== 'ZoridMathMark') return null;
  const closed = !!ending && ending.from !== opening.from && ending.name === 'ZoridMathMark';
  const contentFrom = opening.to, contentTo = closed ? ending!.from : node.to;
  return { from: node.from, to: node.to, contentFrom, contentTo,
    tex: read(contentFrom, contentTo), display: node.name !== 'ZoridMathInline',
    block: node.name === 'ZoridMathBlock', closed };
}

/** An original, source-preserving Markdown extension. Escape, code, HTML tag,
 * wiki and comment parsers consume their tokens before math is considered.
 * Exact standalone $$ fences are supported at document level. Container
 * fences and runs of three or more dollars deliberately remain literal. */
export const mathMarkdown: MarkdownExtension = {
  defineNodes: ['ZoridMathInline', 'ZoridMathDisplay', 'ZoridMathMark', { name: 'ZoridMathBlock', block: true }],
  parseBlock: [{ name: 'ZoridMathBlock', after: 'HTMLBlock',
    parse(context, line) {
      if (context.depth !== 1 || line.indent >= 4 || !/^\$\$[ \t]*$/.test(line.text.slice(line.pos))) return false;
      const from = context.lineStart + line.pos;
      const markers = [context.elt('ZoridMathMark', from, from + 2)];
      let to = context.lineStart + line.text.length;
      while (context.nextLine()) {
        to = context.lineStart + line.text.length;
        if (line.indent < 4 && /^\$\$[ \t]*$/.test(line.text.slice(line.pos))) {
          const closing = context.lineStart + line.pos;
          markers.push(context.elt('ZoridMathMark', closing, closing + 2));
          context.nextLine();
          break;
        }
      }
      context.addElement(context.elt('ZoridMathBlock', from, to, markers));
      return true;
    },
    endLeaf(context, line) {
      return context.depth === 1 && line.indent < 4 && /^\$\$[ \t]*$/.test(line.text.slice(line.pos));
    },
  }],
  parseInline: [{ name: 'ZoridMath', after: 'Image', parse(context, next, from) {
    if (next !== 36 || context.char(from - 1) === 36) return -1;
    const display = context.char(from + 1) === 36, width = display ? 2 : 1;
    if (context.char(from + width) === 36) return -1;
    const start = from + width;
    if (!display && (!context.char(start) || /\s/u.test(context.slice(start, start + 1)))) return -1;
    // Inline ownership never crosses a physical line. Standalone display
    // blocks own their contents before inline Markdown is parsed.
    for (let position = start; position < context.end; position++) {
      const character = context.char(position);
      if (character === 10 || character === 13) return -1;
      if (character === 92) { position++; continue; }
      if (character !== 36) continue;
      let end = position;
      while (context.char(end) === 36) end++;
      if (end - position !== width) { position = end - 1; continue; }
      if (position === start) return -1;
      if (!display && (/\s/u.test(context.slice(position - 1, position)) || /[0-9]/.test(context.slice(end, end + 1)))) return -1;
      return context.addElement(context.elt(display ? 'ZoridMathDisplay' : 'ZoridMathInline', from, end, [
        context.elt('ZoridMathMark', from, start), context.elt('ZoridMathMark', position, end),
      ]));
    }
    return -1;
  } }],
};
