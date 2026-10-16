import { el } from './dom.ts';
import { readProperties } from '../core/properties.ts';
import { decodeTableCellText, parseTable } from '../editor/table-model.ts';
import { createMarkdownListRenderer } from './markdown-lists.ts';

export type LinkHandler = (target: string, kind?: 'wiki' | 'markdown') => void;
export interface EmbedRequest { target: string; kind: 'wiki' | 'markdown'; label?: string }
export interface MarkdownRenderOptions { embed?: (request: EmbedRequest) => HTMLElement; properties?: boolean }

/** Render with DOM APIs: note contents never become executable HTML. */
export function inline(parent: HTMLElement, source: string, open: LinkHandler, options: MarkdownRenderOptions = {}): void {
  const expression = /(!?\[\[([^\]]+)\]\])|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(~~([^~]+)~~)|(==([^=]+)==)|(!?\[([^\]]*)\]\(\s*(<[^>\n]*>|(?:[^\s()\\]|\\.|\([^()]*\))+)(?:\s+["'][^\n]*?["'])?\s*\))/g;
  let cursor = 0;
  for (const match of source.matchAll(expression)) {
    if (match.index! > 0 && source[match.index! - 1] === '\\') continue;
    parent.append(document.createTextNode(source.slice(cursor, match.index)));
    if (match[1]) {
      const divider=match[2].indexOf('|'),target=divider<0?match[2]:match[2].slice(0,divider),alias=divider<0?undefined:match[2].slice(divider+1);
      if (match[1].startsWith('!') && options.embed) parent.append(options.embed({target, kind:'wiki', label:alias}));
      else {
        const link = el('a', match[1].startsWith('!') ? 'internal-link embed-placeholder' : 'internal-link', alias || target);
        link.href = '#'; link.onclick = event => { event.preventDefault(); open(target, 'wiki'); }; parent.append(link);
      }
    } else if (match[3]) parent.append(el('code', '', match[4]));
    else if (match[5]) parent.append(el('strong', '', match[6]));
    else if (match[7]) parent.append(el('em', '', match[8]));
    else if (match[9]) parent.append(el('s', '', match[10]));
    else if (match[11]) parent.append(el('mark', '', match[12]));
    else if (match[13]) {
      const link = el('a', '', match[14]); const target = match[15].replace(/^<|>$/g,'').replace(/\\([\\() ])/g,'$1');
      if (match[13].startsWith('!') && options.embed) {
        parent.append(options.embed({target, kind:'markdown', label:match[14]}));
        cursor = match.index! + match[0].length;
        continue;
      }
      // External navigation is delegated to the platform in a later parity pass.
      if (/^https?:\/\//i.test(target)) { link.href = target; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      else { link.href = '#'; link.onclick = event => { event.preventDefault(); open(target, 'markdown'); }; }
      parent.append(link);
    }
    cursor = match.index! + match[0].length;
  }
  parent.append(document.createTextNode(source.slice(cursor)));
}

export function renderMarkdown(container: HTMLElement, markdown: string, open: LinkHandler, taskChange?: (line: number, checked: boolean) => void, options: MarkdownRenderOptions = {}): void {
  container.replaceChildren();
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let renderList: ReturnType<typeof createMarkdownListRenderer> | undefined;
  let position = 0;
  if (/^\uFEFF?---[ \t]*(?:#.*)?$/.test(lines[0])) {
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
    }
  }
  for (; position < lines.length; position++) {
    const line = lines[position];
    if (!line.trim()) continue;
    const fence = line.match(/^\s*(```+|~~~+)(.*)$/);
    if (fence) {
      const code: string[] = []; position++;
      while (position < lines.length && !lines[position].trimStart().startsWith(fence[1])) code.push(lines[position++]);
      const pre = el('pre'); const block = el('code', '', code.join('\n')); block.dataset.language = fence[2].trim(); pre.append(block); container.append(pre); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const node = document.createElement(`h${heading[1].length}`); node.id = `heading-${position}`;
      inline(node, heading[2], open, options); container.append(node); continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { container.append(el('hr')); continue; }
    if (/^\s*(?:>|[-*+]\s|\d+[.)]\s)/.test(line)) {
      renderList ??= createMarkdownListRenderer(markdown);
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
    const paragraph = el('p'); inline(paragraph, line, open, options); container.append(paragraph);
  }
}
