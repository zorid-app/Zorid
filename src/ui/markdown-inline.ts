import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { EmbedRequest, LinkHandler, MarkdownRenderOptions } from './markdown.ts';
import { mathInlineMarkdown, mathSpan } from '../editor/math-syntax.ts';
import { renderReadingMath } from './reading-math.ts';

const highlight = { resolve: 'ZoridHighlight', mark: 'ZoridHighlightMark' };
// Inline rendering must not reinterpret a list label, heading title, or table
// cell as a document block. Lezer still owns inline precedence and nesting.
const parser = markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false, extensions: [{
  remove: ['LinkReference', 'IndentedCode', 'FencedCode', 'Blockquote', 'HorizontalRule',
    'BulletList', 'OrderedList', 'ATXHeading', 'HTMLBlock', 'SetextHeading', 'Table', 'TaskList'],
  defineNodes: ['ZoridWiki', 'ZoridComment', 'ZoridHighlight', 'ZoridHighlightMark'],
  parseInline: [
    {
      name: 'ZoridWiki', before: 'Link',
      parse(context, next, position) {
        if (context.hasOpenLink || (next !== 91 && next !== 33)) return -1;
        const start = position + (next === 33 ? 1 : 0);
        if (context.slice(start, start + 2) !== '[[') return -1;
        const end = context.text.indexOf(']]', start + 2 - context.offset);
        if (end < 0) return -1;
        const content = context.slice(start + 2, end + context.offset);
        if (!content.trim() || /[\r\n]/.test(content) || content.includes('[[')) return -1;
        return context.addElement(context.elt('ZoridWiki', position, end + context.offset + 2));
      },
    },
    {
      name: 'ZoridComment', before: 'HTMLTag',
      parse(context, next, position) {
        if (next !== 37 || context.char(position + 1) !== 37) return -1;
        const end = context.text.indexOf('%%', position + 2 - context.offset);
        if (end < 0 || /[\r\n]/.test(context.slice(position, end + context.offset))) return -1;
        return context.addElement(context.elt('ZoridComment', position, end + context.offset + 2));
      },
    },
    {
      name: 'ZoridHighlight', before: 'Emphasis',
      parse(context, next, position) {
        if (next !== 61 || context.char(position + 1) !== 61 ||
          context.char(position - 1) === 61 || context.char(position + 2) === 61) return -1;
        const before = context.slice(position - 1, position), after = context.slice(position + 2, position + 3);
        return context.addDelimiter(highlight, position, position + 2,
          !!after && !/\s/u.test(after), !!before && !/\s/u.test(before));
      },
    },
  ],
}, mathInlineMarkdown] }).language.parser;

type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];
const formatting: Record<string, string> = {
  Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 's', ZoridHighlight: 'mark',
};
const punctuation = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\\\]^_`{|}~])/g;
const entityPattern = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi;

/** Safe inline subset. HTML, footnotes and unresolved reference links
 * remain literal; document-level resolution and async processors belong to the
 * block renderer. Appends to the supplied parent using its owning document.
 */
export function renderMarkdownInline(parent: HTMLElement, source: string, open: LinkHandler,
  options: MarkdownRenderOptions = {}): void {
  const document = parent.ownerDocument;
  const tree = parser.parse(source);
  const text = (node: SyntaxNode): string => source.slice(node.from, node.to);
  const children = (node: SyntaxNode): SyntaxNode[] => {
    const result: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
    return result;
  };
  const appendText = (into: HTMLElement, value: string): void => { into.append(document.createTextNode(value)); };
  const decodeEntities = (value: string): string => value.replace(entityPattern, entity => {
    // Only a validated entity token enters this inert text element. Note HTML
    // never enters an HTML parser, and decoded output is always used as text.
    const decoder = document.createElement('textarea');
    decoder.innerHTML = entity;
    return decoder.value;
  });
  const decode = (value: string): string => decodeEntities(value.replace(punctuation, '$1'));
  const codeText = (nodes: SyntaxNode[]): string => {
    let content = source.slice(nodes[0].to, nodes[nodes.length - 1].from).replace(/\r\n?|\n/g, ' ');
    if (content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) content = content.slice(1, -1);
    return content;
  };
  const plainLabel = (nodes: SyntaxNode[], from: number, to: number): string => {
    let result = '', cursor = from;
    for (const node of nodes) {
      if (node.from < from || node.to > to) continue;
      result += source.slice(cursor, node.from);
      const nested = children(node);
      if (formatting[node.name]) result += plainLabel(nested.slice(1, -1), nested[0].to, nested[nested.length - 1].from);
      else if (node.name === 'InlineCode') result += codeText(nested);
      else if (node.name === 'Escape') result += text(node).slice(1);
      else if (node.name === 'Entity') result += decodeEntities(text(node));
      else if (node.name !== 'ZoridComment') result += text(node);
      cursor = node.to;
    }
    return result + source.slice(cursor, to);
  };
  const unsafe = (target: string): boolean => /^(?:javascript|vbscript|data):/i.test(target.replace(/[\s\u0000-\u001f\u007f]/g, ''));
  const link = (target: string, kind: 'wiki' | 'markdown', label: HTMLElement, embed = false): HTMLElement => {
    const anchor = document.createElement('a');
    if (unsafe(target)) { anchor.className = 'unsupported-link'; anchor.append(...label.childNodes); return anchor; }
    if (kind === 'markdown' && /^(?:https?:\/\/|mailto:)/i.test(target)) {
      anchor.className = 'external-link'; anchor.href = target;
      anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    } else {
      anchor.className = embed ? 'internal-link embed-placeholder' : 'internal-link';
      anchor.href = '#'; anchor.dataset.href = target;
      anchor.onclick = event => { event.preventDefault(); open(target, kind); };
    }
    anchor.append(...label.childNodes);
    return anchor;
  };
  const renderRange = (into: HTMLElement, nodes: SyntaxNode[], from: number, to: number): void => {
    let cursor = from;
    for (const node of nodes) {
      if (node.from < from || node.to > to) continue;
      appendText(into, source.slice(cursor, node.from));
      renderNode(into, node);
      cursor = node.to;
    }
    appendText(into, source.slice(cursor, to));
  };
  const embedOrLink = (into: HTMLElement, request: EmbedRequest, label: HTMLElement, embed: boolean): void => {
    if (embed && options.embed && !unsafe(request.target)) into.append(options.embed(request));
    else into.append(link(request.target, request.kind, label, embed));
  };
  const renderNode = (into: HTMLElement, node: SyntaxNode): void => {
    const value = text(node), nodes = children(node);
    if (node.name === 'Document' || node.name === 'Paragraph') {
      renderRange(into, nodes, node.from, node.to);
    } else if (formatting[node.name]) {
      const element = document.createElement(formatting[node.name]);
      renderRange(element, nodes.slice(1, -1), nodes[0].to, nodes[nodes.length - 1].from);
      into.append(element);
    } else if (node.name === 'InlineCode') {
      const code = document.createElement('code');
      code.textContent = codeText(nodes); into.append(code);
    } else if (node.name === 'Escape') {
      appendText(into, value.slice(1));
    } else if (node.name === 'Entity') {
      appendText(into, decodeEntities(value));
    } else if (node.name === 'HardBreak') {
      into.append(document.createElement('br'));
    } else if (node.name === 'ZoridComment') {
      // Comments produce no visible text and cannot invoke nested embeds.
    } else if (node.name === 'ZoridMathInline' || node.name === 'ZoridMathDisplay') {
      const math = mathSpan(node, (from, to) => source.slice(from, to));
      if (!math?.closed) { appendText(into, value); return; }
      const element = document.createElement('span');
      renderReadingMath(element, math.tex, { display: math.display });
      into.append(element);
    } else if (node.name === 'ZoridWiki') {
      const embed = value.startsWith('!'), content = value.slice(embed ? 3 : 2, -2).trim();
      const divider = content.indexOf('|');
      const target = (divider > 0 ? content.slice(0, divider) : content).trim().replace(/\\$/, '').replace(/\u00a0/g, ' ').normalize('NFC');
      const alias = divider > 0 ? content.slice(divider + 1).trim() : undefined;
      const label = document.createElement('span');
      label.textContent = alias ?? target.split('#').filter(Boolean).join(' > ').trim();
      embedOrLink(into, { target, kind: 'wiki', label: alias }, label, embed);
    } else if (node.name === 'Link' || node.name === 'Image') {
      const destination = nodes.find(child => child.name === 'URL');
      // Lezer recognizes reference syntax without a definitions table. Keep it
      // whole instead of silently creating a link to its visible label.
      if (!destination) { appendText(into, value); return; }
      const closing = nodes.find(child => child.name === 'LinkMark' && text(child) === ']');
      if (!closing) { appendText(into, value); return; }
      const rawTarget = text(destination), target = decode(rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget);
      const label = document.createElement('span');
      // Rendering image alt text must never trigger embed callbacks of its own.
      if (node.name === 'Image') label.textContent = plainLabel(nodes, nodes[0].to, closing.from);
      else renderRange(label, nodes, nodes[0].to, closing.from);
      const title = nodes.find(child => child.name === 'LinkTitle');
      if (node.name === 'Image' && options.embed && !unsafe(target)) {
        embedOrLink(into, { target, kind: 'markdown', label: label.textContent ?? '' }, label, true);
      } else {
        const anchor = link(target, 'markdown', label, node.name === 'Image');
        if (title) anchor.title = decode(text(title).slice(1, -1));
        into.append(anchor);
      }
    } else if (node.name === 'Autolink' || node.name === 'URL') {
      const label = document.createElement('span');
      const content = node.name === 'Autolink' ? value.slice(1, -1) : value;
      label.textContent = content;
      const target = content.startsWith('www.') ? `https://${content}` : /^[^:/\s]+@[^/\s]+$/.test(content) ? `mailto:${content}` : content;
      into.append(link(target, 'markdown', label));
    } else {
      // In particular HTMLTag stays literal and never becomes executable DOM.
      appendText(into, value);
    }
  };
  renderNode(parent, tree.topNode);
}
