import { markdownLanguage } from '@codemirror/lang-markdown';
import { appendCodeBlock } from './code-block.ts';
import { createCalloutPresentation, parseCalloutHeader } from './callout-presentation.ts';
import { destroyMarkdown } from './markdown-lifecycle.ts';

type SyntaxNode = ReturnType<typeof markdownLanguage.parser.parse>['topNode'];

type InlineRenderer = (parent: HTMLElement, source: string) => void;
type ListRenderer = (parent: HTMLElement, startLine: number, inline: InlineRenderer,
  taskChange?: (line: number, checked: boolean) => void) => number | null;
const listTypes = new Set(['BulletList', 'OrderedList']);

/** Render one complete top-level list (or a quote containing lists).
 * Source is the entire document; startLine and task callbacks are zero-based
 * original line numbers. Returns consumed lines, or null without changing DOM.
 * Lezer owns indentation, lazy continuations, list boundaries and code gating.
 * Unsupported nested blocks remain safe literal text, rather than parsed HTML.
 */
export function renderMarkdownList(parent: HTMLElement, source: string, startLine: number,
  inline: InlineRenderer, taskChange?: (line: number, checked: boolean) => void): number | null {
  return createMarkdownListRenderer(source)(parent, startLine, inline, taskChange);
}

/** Parse and index one source snapshot once for a complete document render.
 * Create a new renderer when the document changes; returned renderers share no
 * mutable DOM or checkbox state, and may render into different documents.
 */
export function createMarkdownListRenderer(source: string, options: {
  quotes?: boolean;
  renderQuoteBody?: (parent: HTMLElement, source: string, startLine: number) => void;
  /** Return true after mounting a specialized parser-owned fenced renderer. */
  renderFence?: (parent: HTMLElement, from: number, to: number, info: string) => boolean;
} = {}): ListRenderer {
  source = source.replace(/\r\n/g, '\n');
  const starts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') starts.push(index + 1);
  const lineAt = (position: number): number => {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (starts[mid] <= position) low = mid; else high = mid; }
    return low;
  };
  const children = (node: SyntaxNode): SyntaxNode[] => {
    const nodes: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) nodes.push(child);
    return nodes;
  };
  const tree = markdownLanguage.parser.parse(source);
  const roots = new Map(children(tree.topNode).map(node => [lineAt(node.from), node]));
  const hasList = (node: SyntaxNode): boolean => listTypes.has(node.name) || children(node).some(hasList);
  const quoteMarks = new Set<number>();
  const collectQuotes = (node: SyntaxNode): void => {
    if (node.name === 'QuoteMark') quoteMarks.add(node.from);
    for (const child of children(node)) collectQuotes(child);
  };
  collectQuotes(tree.topNode);
  return (parent, startLine, inline, taskChange) => {
    if (!Number.isInteger(startLine) || startLine < 0 || startLine >= starts.length) return null;
    const root = roots.get(startLine);
    if (!root) return null;
    if (!listTypes.has(root.name) && (root.name !== 'Blockquote' || (!options.quotes && !hasList(root)))) return null;
    // Existing callout rendering owns this syntax, including any contained lists.
    if (!options.quotes && root.name === 'Blockquote' && /^\s*>\s*\[!/.test(source.slice(starts[startLine], root.to))) return null;
    const document = parent.ownerDocument;
    const text = (from: number, to: number, code = false): string => {
      const column = from - starts[lineAt(from)];
      const lines = source.slice(from, to).split('\n');
      let offset = from;
      return lines.map((line, index) => {
        let first = 0;
        if (index) {
          // Strip only structural prefixes. Literal > characters are retained.
          while (first < line.length && (!code || first < column)
            && (/[ \t]/.test(line[first]) || quoteMarks.has(offset + first))) first++;
        }
        offset += line.length + 1;
        return line.slice(first);
      }).join('\n');
    };
    const renderBlock = (container: HTMLElement, node: SyntaxNode): void => {
      if (listTypes.has(node.name)) { renderList(container, node); return; }
      if (node.name === 'QuoteMark' || node.name === 'ListMark' || node.name === 'LinkReference') return;
      if (node.name === 'Blockquote') {
        // Remove exactly one parser-owned quote layer. The physical lines and
        // original task offsets survive presentation/title construction.
        const sourceLines = source.slice(node.from, node.to).split('\n').map(line => line.replace(/^[ \t]*>[ \t]?/, ''));
        const header = parseCalloutHeader(sourceLines[0]), presentation = header ? createCalloutPresentation(document, header) : undefined;
        const quote = presentation?.element ?? document.createElement('blockquote'), body = presentation?.content ?? quote;
        container.append(quote);
        try {
          if (presentation) inline(presentation.title, presentation.titleSource);
          if (options.renderQuoteBody) {
            let firstLine = lineAt(node.from);
            if (header) { sourceLines.shift(); firstLine++; }
            options.renderQuoteBody(body, sourceLines.join('\n'), firstLine);
            return;
          }
          let firstParagraph = true;
          for (const child of children(node)) {
            if (header && firstParagraph && child.name === 'Paragraph') {
              firstParagraph = false;
              const value = text(child.from, child.to), newline = value.indexOf('\n');
              if (newline >= 0) { const paragraph = document.createElement('p'); body.append(paragraph); inline(paragraph, value.slice(newline + 1)); }
            } else renderBlock(body, child);
          }
        } catch (error) { destroyMarkdown(quote); throw error; }
        return;
      }
      if (node.name === 'Paragraph' || node.name === 'Task') {
        const paragraph = document.createElement('p'); inline(paragraph, text(node.from, node.to)); container.append(paragraph); return;
      }
      if (node.name === 'CodeBlock' || node.name === 'FencedCode') {
        const info = node.getChild('CodeInfo');
        if (node.name === 'FencedCode' && options.renderFence?.(container, starts[lineAt(node.from)], node.to, info ? source.slice(info.from, info.to) : '')) return;
        const chunks = children(node).filter(child => child.name === 'CodeText');
        const value = chunks.map(child => text(child.from, child.to, true)).join('');
        appendCodeBlock(container, value, info ? source.slice(info.from, info.to) : ''); return;
      }
      const literal = document.createElement('pre');
      literal.className = 'markdown-list-unsupported'; literal.textContent = text(node.from, node.to);
      container.append(literal);
    };
    const renderList = (container: HTMLElement, node: SyntaxNode): void => {
      const ordered = node.name === 'OrderedList';
      const list = document.createElement(ordered ? 'ol' : 'ul');
      const items = children(node).filter(child => child.name === 'ListItem');
      if (ordered) {
        const first = items[0]?.getChild('ListMark');
        if (first) (list as HTMLOListElement).start = Number.parseInt(source.slice(first.from, first.to), 10);
      }
      // Blank lines between siblings or blocks make this list loose. Paragraph
      // wrappers preserve meaningful separation; tight lists omit those wrappers.
      const loose = items.some((item, index) => {
        const blocks = children(item).filter(child => !['ListMark', 'QuoteMark'].includes(child.name));
        return (index > 0 && /\n[ \t>]*\n/.test(source.slice(items[index - 1].to, item.from)))
          || blocks.some((block, blockIndex) => blockIndex > 0
            && /\n[ \t>]*\n/.test(source.slice(blocks[blockIndex - 1].to, block.from)));
      });
      for (const item of items) {
        const li = document.createElement('li'), mark = item.getChild('ListMark');
        const blocks = children(item).filter(child => !['ListMark', 'QuoteMark'].includes(child.name));
        const first = blocks[0];
        const end = mark ? source.indexOf('\n', mark.to) : -1;
        const task = mark && first && ['Task', 'Paragraph'].includes(first.name)
          ? /^[ \t]+\[([^\r\n])\](?=[ \t]|$)[ \t]*/.exec(source.slice(mark.to, end < 0 ? source.length : end)) : null;
        let bodyFrom = first?.from ?? item.to;
        let taskControl: HTMLInputElement | undefined;
        if (task && mark) {
          const status = task[1], checkbox = document.createElement('input');
          const line = lineAt(mark.from);
          li.classList.add('task-item', 'task-list-item'); li.dataset.task = status;
          li.classList.toggle('is-checked', /^[xX]$/.test(status));
          checkbox.type = 'checkbox'; checkbox.className = 'task-list-item-checkbox';
          checkbox.checked = status !== ' '; checkbox.dataset.task = status;
          bodyFrom = mark.to + task[0].length;
          checkbox.setAttribute('aria-label', text(bodyFrom, first.to).trim() || 'Toggle task');
          checkbox.addEventListener('change', () => {
            const checked = checkbox.checked, next = checked ? 'x' : ' ';
            checkbox.dataset.task = next; li.dataset.task = next;
            li.classList.toggle('is-checked', checked);
            taskChange?.(line, checked);
          });
          taskControl = checkbox; list.classList.add('contains-task-list');
        }
        for (const block of blocks) {
          if (block.name === 'Paragraph' || block.name === 'Task') {
            const target = loose ? document.createElement('p') : li;
            if (block === first && taskControl) target.append(taskControl);
            inline(target, text(block === first ? bodyFrom : block.from, block.to));
            if (loose) li.append(target);
          } else renderBlock(li, block);
        }
        list.append(li);
      }
      container.append(list);
    };
    renderBlock(parent, root);
    return lineAt(Math.max(root.from, root.to - 1)) - startLine + 1;
  };
}
