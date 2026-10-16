import { markdown as markdownLanguageSupport, markdownLanguage } from '@codemirror/lang-markdown';
import { mathMarkdown, mathSpan } from '../editor/math-syntax.ts';
import { appendCodeBlock, readCodeFence } from './code-block.ts';
import { renderReadingMath } from './reading-math.ts';
import { destroyMarkdown } from './markdown-lifecycle.ts';
import { readProperties } from '../core/properties.ts';
import { decodeTableCellText, parseTable } from '../editor/table-model.ts';
import { createMarkdownListRenderer } from './markdown-lists.ts';

export type LinkHandler = (target: string, kind?: 'wiki' | 'markdown') => void;
export interface EmbedRequest { target: string; kind: 'wiki' | 'markdown'; label?: string }
export interface MarkdownRenderOptions { embed?: (request: EmbedRequest) => HTMLElement; properties?: boolean }

/** Parser-owned inline rendering shared by Reading mode and live table cells. */
export { renderMarkdownInline as inline } from './markdown-inline.ts';
import { renderMarkdownInline as inline } from './markdown-inline.ts';

const blockParser = markdownLanguageSupport({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false, extensions: mathMarkdown }).language.parser;

export function renderMarkdown(container: HTMLElement, markdown: string, open: LinkHandler, taskChange?: (line: number, checked: boolean) => void, options: MarkdownRenderOptions = {}): void {
  renderMarkdownBlocks(container, markdown, open, taskChange, options,
    { remaining: Math.min(1_000_000, Math.max(32_768, markdown.length * 8)), depth: 0 }, false);
}

function renderMarkdownBlocks(container: HTMLElement, markdown: string, open: LinkHandler,
  taskChange: ((line: number, checked: boolean) => void) | undefined, options: MarkdownRenderOptions,
  budget: { remaining: number; depth: number }, nested: boolean): void {
  // Nested quotes are new containers and may already hold a callout title.
  if (!nested) { destroyMarkdown(container); container.replaceChildren(); }
  const document = container.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // Bound repeated parsing only; an ordinary large top-level note still uses
  // the normal renderer. Exhausted recursive work remains visible as source.
  if (nested) {
    if (budget.depth >= 32 || markdown.length > budget.remaining) {
      container.append(el('pre', 'markdown-source-fallback', markdown)); return;
    }
    budget.remaining -= markdown.length;
  }
  markdown = markdown.replace(/\r\n/g, '\n');
  const lines = markdown.split('\n');
  const starts = [0];
  for (let index = 0; index < markdown.length; index++) if (markdown[index] === '\n') starts.push(index + 1);
  const lineAt = (offset: number): number => {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle] <= offset) low = middle; else high = middle; }
    return low;
  };
  // Whole-document parser ownership prevents fences and display math inside
  // code, HTML, lists or quotes from becoming unrelated top-level blocks.
  const roots = new Map<number, ReturnType<typeof blockParser.parse>['topNode']>();
  let parsingSource = markdown;
  let renderList: ReturnType<typeof createMarkdownListRenderer> | undefined;
  let position = 0;
  if (!nested && /^\uFEFF?---[ \t]*(?:#.*)?$/.test(lines[0])) {
    const end = lines.findIndex((line,index) => index > 0 && /^(?:---|\.\.\.)[ \t]*(?:#.*)?$/.test(line));
    if (end > 0) {
      const properties = el('details', 'properties'); properties.append(el('summary', '', 'Properties'));
      const table = el('div', 'property-list');
      try {
        for(const property of readProperties(markdown)) {
          const row=el('div','property-row');row.append(el('span','property-key',property.key),el('span','',typeof property.value==='string'?property.value:JSON.stringify(property.value)));table.append(row);
        }
      } catch(error) { table.append(el('span','error-message',error instanceof Error?error.message:String(error))); }
      properties.append(table); if(options.properties !== false)container.append(properties); position = end + 1;
      // YAML belongs to the properties parser. Mask it without shifting body
      // coordinates so YAML fences cannot claim subsequent Markdown blocks.
      const bodyStart = starts[position] ?? markdown.length;
      parsingSource = markdown.slice(0, bodyStart).replace(/[^\n]/g, ' ') + markdown.slice(bodyStart);
    }
  }
  const tree = blockParser.parse(parsingSource);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) roots.set(lineAt(node.from), node);
  for (; position < lines.length; position++) {
    const line = lines[position];
    if (!line.trim()) continue;
    const root = roots.get(position);
    if (root?.name === 'HTMLBlock' || root?.name === 'CodeBlock') {
      const literal = el('pre');
      if (root.name === 'CodeBlock') {
        const chunks: string[] = [];
        for (let child = root.firstChild; child; child = child.nextSibling) {
          if (child.name === 'CodeText') chunks.push(markdown.slice(child.from, child.to));
        }
        literal.append(el('code', '', chunks.join('\n')));
      } else literal.textContent = markdown.slice(root.from, root.to);
      container.append(literal); position = lineAt(Math.max(root.from, root.to - 1)); continue;
    }
    const math = root && mathSpan(root, (from, to) => markdown.slice(from, to));
    if (math?.block) {
      if (math.closed) {
        const block = el('div'); container.append(block); renderReadingMath(block, math.tex, { display: true });
      } else container.append(el('p', '', markdown.slice(root!.from, root!.to)));
      position = lineAt(Math.max(root!.from, root!.to - 1)); continue;
    }
    const fence = root?.name === 'FencedCode' ? readCodeFence(lines, position) : null;
    if (fence) {
      appendCodeBlock(container, fence.code, fence.info); position = fence.endLine; continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const node = document.createElement(`h${heading[1].length}`); node.id = `heading-${position}`;
      inline(node, heading[2], open, options); container.append(node); continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { container.append(el('hr')); continue; }
    if (/^\s*(?:>|[-*+]\s|\d+[.)]\s)/.test(line)) {
      renderList ??= createMarkdownListRenderer(parsingSource, { quotes: true,
        renderQuoteBody(parent, source, startLine) {
          budget.depth++;
          try {
            renderMarkdownBlocks(parent, source, open, taskChange ? (line, checked) => taskChange(startLine + line, checked) : undefined,
              options, budget, true);
          } catch (error) { destroyMarkdown(parent); throw error; }
          finally { budget.depth--; }
        },
      });
      const consumed = renderList(container, position, (parent, source) => inline(parent, source, open, options), taskChange);
      if (consumed !== null) { position += consumed - 1; continue; }
    }
    if (/^>/.test(line)) {
      const quote = el('blockquote');
      const callout = line.match(/^>\s*\[!([^\]]+)\]\s*(.*)/);
      if (callout) { quote.className = 'callout'; quote.append(el('div', 'callout-title', callout[2] || callout[1])); }
      else inline(quote, line.replace(/^>\s?/, ''), open, options);
      while (position + 1 < lines.length && /^>/.test(lines[position + 1])) { const p = el('p'); inline(p, lines[++position].replace(/^>\s?/, ''), open, options); quote.append(p); }
      container.append(quote); continue;
    }
    if (line.includes('|') && position + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[position + 1])) {
      let end = position + 2;
      while (end < lines.length && lines[end].includes('|') && lines[end].trim()) end++;
      const model = parseTable(lines.slice(position, end).join('\n'));
      if (model) {
        const table = el('table'); const head = el('thead'), body = el('tbody'); table.append(head, body);
        model.rows.forEach((sourceRow, index) => {
          const row = el('tr');
          sourceRow.cells.forEach((sourceCell, column) => {
            const cell = el(index === 0 ? 'th' : 'td'); cell.style.textAlign = model.alignments[column] ?? '';
            inline(cell, decodeTableCellText(sourceCell.text).text, open, options); row.append(cell);
          });
          (index === 0 ? head : body).append(row);
        });
        position += model.rows.length; container.append(table); continue;
      }
    }
    const paragraph = el('p');
    const paragraphSource = root?.name === 'Paragraph' ? markdown.slice(root.from, root.to) : line;
    inline(paragraph, paragraphSource, open, options); container.append(paragraph);
    if (root?.name === 'Paragraph') position = lineAt(Math.max(root.from, root.to - 1));
  }
}
