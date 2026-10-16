export interface ClipboardHTMLOptions { document?: Document }

/** The exact marker observed in the retained 1.14.4 clipboard writer. */
export function isOwnClipboardHTML(html: string): boolean { return html.includes('<!-- obsidian -->'); }

function parse(html: string, options: ClipboardHTMLOptions): DocumentFragment | null {
  const source = options.document ?? (typeof document === 'undefined' ? undefined : document);
  if (!source || !html.trim()) return null;
  // A template in a detached document stays inert: no script execution, resource
  // fetching, custom element upgrade, or insertion into the receiving editor.
  const inert = source.implementation.createHTMLDocument('');
  const template = inert.createElement('template');
  template.innerHTML = html;
  return template.content;
}

export function isSingleImageHTML(html: string, options: ClipboardHTMLOptions = {}): boolean {
  const fragment = parse(html, options);
  if (!fragment) return false;
  const nodes = Array.from(fragment.childNodes).filter(node => node.nodeType !== 8 && !(node.nodeType === 3 && !node.textContent?.trim()));
  return nodes.length === 1 && nodes[0].nodeType === 1 && (nodes[0] as Element).tagName === 'IMG';
}

const excluded = new Set(['SCRIPT', 'STYLE', 'TITLE', 'HEAD', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH']);
const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'ADDRESS', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD']);
const block = (text: string) => text.trim() ? `\n\n${text.trim()}\n\n` : '';
const literal = (text: string) => text.replace(/([\\`*_[\]<>~|=])/g, '\\$1')
  .replace(/(^|\n)(\s*)([#>+-])(?=\s)/g, '$1$2\\$3')
  .replace(/(^|\n)(\s*\d+)([.)])(?=\s)/g, '$1$2\\$3');
const titleText = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function destination(value: string | null): string | null {
  if (!value) return null;
  const url = value.trim();
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return null;
  const colon = url.indexOf(':'), slash = url.search(/[/?#]/);
  if (colon >= 0 && (slash < 0 || colon < slash) && !/^(?:https?|mailto|tel|ftp|file):/i.test(url)) return null;
  return url.replace(/[ <>"\\]/g, char => encodeURIComponent(char)).replace(/[()]/g, '\\$&');
}

function join(parts: string[]): string {
  return parts.reduce((result, part) => {
    if (!part) return result;
    if (/^[ \t]+$/.test(part) && (!result || result.endsWith('\n'))) return result;
    if (part.startsWith('\n')) result = result.replace(/[ \t]+$/, '');
    if (result.endsWith('\n')) part = part.replace(/^[ \t]+/, '');
    if (result.endsWith(' ') && part.startsWith(' ')) part = part.slice(1);
    const end = /\n+$/.exec(result)?.[0].length ?? 0, start = /^\n+/.exec(part)?.[0].length ?? 0;
    return end && start ? result.slice(0, -end) + '\n'.repeat(Math.max(end, start)) + part.slice(start) : result + part;
  }, '');
}

/** Original bounded DOM conversion; null leaves the transfer's fallback available.
 * This only converts HTML. MIME priority, autoConvertHtml and file imports belong
 * to the transfer controller. No URL is fetched and no parsed node is mounted.
 */
export function htmlToMarkdown(html: string, options: ClipboardHTMLOptions = {}): string | null {
  const fragment = parse(html, options);
  if (!fragment) return null;
  const children = (node: Node): string => join(Array.from(node.childNodes).map(render));
  const wrap = (value: string, marker: string) => {
    const inner = value.trim();
    return inner ? `${/^\s/.test(value) ? ' ' : ''}${marker}${inner}${marker}${/\s$/.test(value) ? ' ' : ''}` : value;
  };
  const codeBlock = (element: Element, language = ''): string => {
    const code = element.textContent?.replace(/\r\n?/g, '\n') ?? '';
    const runs = code.match(/`+/g) ?? [];
    const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return `\n\n${fence}${language}\n${code}${code.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
  };
  const list = (element: Element): string => {
    const ordered = element.tagName === 'OL';
    const start = Number.parseInt(element.getAttribute('start') ?? '1', 10);
    let index = Number.isFinite(start) ? start : 1;
    const items = Array.from(element.children).filter(child => child.tagName === 'LI').map(item => {
      const marker = ordered ? `${index++}. ` : '- ';
      const content = children(item).trim();
      return marker + content.replace(/\n/g, '\n    ');
    });
    return block(items.join('\n'));
  };
  const table = (element: Element): string => {
    const rows = Array.from(element.querySelectorAll('tr')).filter(row => row.closest('table') === element);
    if (!rows.length) return '';
    const cells = rows.map(row => Array.from(row.children).filter(cell => /^(TH|TD)$/.test(cell.tagName)));
    const width = (cell: Element) => Math.min(100, Math.max(1, Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1));
    const content = cells.map(row => row.flatMap(cell => [children(cell).trim().replace(/(?<!\\)\|/g, '\\|').replace(/\r?\n/g, '<br>'), ...Array<string>(width(cell) - 1).fill('')]));
    const columns = Math.max(...content.map(row => row.length));
    if (!columns) return '';
    const header = rows[0].parentElement?.tagName === 'THEAD' || cells[0].every(cell => cell.tagName === 'TH');
    const alignments = cells[0].flatMap(cell => {
      const align = cell.getAttribute('align')?.toLowerCase();
      return Array<string>(width(cell)).fill(align === 'left' ? ':--' : align === 'right' ? '--:' : align === 'center' ? ':-:' : '---');
    });
    const line = (values: string[]) => `|${Array.from({ length: columns }, (_, index) => values[index] ?? '').join('|')}|`;
    const output = [line(header ? content.shift()! : []), line(alignments), ...content.map(line)];
    const caption = element.querySelector(':scope > caption');
    return block((caption ? children(caption).trim() + '\n\n' : '') + output.join('\n'));
  };
  function render(node: Node): string {
    if (node.nodeType === 3) return literal((node.textContent ?? '').replace(/[\t\r\n ]+/g, ' ').replace(/\u00a0/g, ' '));
    if (node.nodeType !== 1) return '';
    const element = node as Element, tag = element.tagName.toUpperCase();
    if (excluded.has(tag) || element.hasAttribute('hidden')) return '';
    if (tag === 'PRE') {
      const language = element.querySelector('code')?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? '';
      return codeBlock(element, language);
    }
    const highlighted = tag === 'DIV' && element.className.match(/(?:^|\s)highlight-(?:text|source)-([a-z0-9]+)/);
    if (highlighted && element.firstElementChild?.tagName === 'PRE') return codeBlock(element.firstElementChild, highlighted[1]);
    if (tag === 'CODE') {
      const content = (element.textContent ?? '').replace(/\r?\n/g, ' ');
      if (!content) return '';
      const ticks = '`'.repeat(Math.max(1, ...(content.match(/`+/g) ?? []).map(run => run.length + 1)));
      const pad = /^`|`$/.test(content) || (/^ .* $/.test(content) && /\S/.test(content)) ? ' ' : '';
      return `${ticks}${pad}${content}${pad}${ticks}`;
    }
    if (tag === 'BR') return '  \n';
    if (tag === 'HR') return block('---');
    if (tag === 'UL' || tag === 'OL') return list(element);
    if (tag === 'TABLE') return table(element);
    if (tag === 'INPUT') return element.getAttribute('type')?.toLowerCase() === 'checkbox' && element.parentElement?.tagName === 'LI' ? (element.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';
    if (tag === 'IMG') {
      const url = destination(element.getAttribute('src'));
      if (!url) return '';
      const title = element.getAttribute('title');
      return `![${literal((element.getAttribute('alt') ?? '').replace(/\s+/g, ' '))}](${url}${title ? ` "${titleText(title)}"` : ''})`;
    }
    const content = children(element);
    if (tag === 'A') {
      const url = destination(element.getAttribute('href')), title = element.getAttribute('title');
      return url ? `[${content.trim()}](${url}${title ? ` "${titleText(title)}"` : ''})` : content;
    }
    if (/^H[1-6]$/.test(tag)) return block(`${'#'.repeat(Number(tag[1]))} ${content.trim()}`);
    if (tag === 'STRONG' || tag === 'B') return wrap(content, '**');
    if (tag === 'EM' || tag === 'I') return wrap(content, '_');
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return wrap(content, '~~');
    if (tag === 'MARK') return wrap(content, '==');
    if (tag === 'BLOCKQUOTE') return block(content.trim().split('\n').map(line => `> ${line}`).join('\n'));
    return blocks.has(tag) ? block(content) : content;
  }
  return children(fragment).trim() || null;
}
