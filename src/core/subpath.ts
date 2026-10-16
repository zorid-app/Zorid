/** A selected source region. Line indices are zero-based; endLine is exclusive. */
export interface MarkdownSubpath {
  content: string;
  startLine: number;
  endLine: number;
}

interface Line { text: string; start: number; end: number }
interface Block {
  start: number;
  end: number;
  kind: 'paragraph' | 'heading' | 'fence' | 'code' | 'list' | 'quote' | 'table' | 'rule';
  heading?: string;
  level?: number;
}

const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const listItem = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/;
const quote = /^ {0,3}>/;
const indented = /^(?: {4}|\t)/;
const standaloneId = /^ {0,3}\^([A-Za-z0-9-]+)[ \t]*$/;
const inlineId = /[ \t]+\^([A-Za-z0-9-]+)[ \t]*$/;
const rule = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const setext = /^ {0,3}(=+|-+)[ \t]*$/;

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) continue;
    lines.push({ text: match[0].replace(/(?:\r\n|\r|\n)$/, ''), start: match.index, end: match.index + match[0].length });
  }
  return lines;
}

function fenceStart(text: string): { marker: string; length: number } | null {
  const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { marker: match[1][0], length: match[1].length };
}

function tableDelimiter(text: string): boolean {
  const cells = text.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length > 0 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function withoutCodeSpans(text: string): string {
  return text.replace(/(`+)([\s\S]*?)\1(?!`)/g, match => ' '.repeat(match.length));
}

function headingKey(text: string): string {
  // This is heading text matching, not a GitHub-style hyphenated slug algorithm.
  return text.replace(/!?(?:\[([^\]]*)\]\([^)]*\))/g, '$1')
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_match, target: string, label?: string) => label ?? target)
    .replace(/<[^>]*>/g, '').replace(/\\([\\`*_{}[\]()#+.!~-])/g, '$1')
    .replace(/[*_~`]/g, '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Select one document's Markdown heading or block reference, without vault I/O.
 *
 * Empty fragments and `#` select the whole source. A leading `#` is optional.
 * Percent escapes are decoded once (malformed escapes are left literal).
 * Headings compare normalized, case-insensitive visible text with collapsed
 * whitespace; duplicate headings resolve to the first occurrence. Block IDs
 * are case-sensitive ASCII letters/digits/hyphens. Selected block IDs are
 * omitted from content; a standalone ID line is outside the returned range.
 * Original source line endings are retained.
 *
 * This is an original bounded block scanner, not exact Obsidian parser parity.
 * It handles top-level ATX/setext headings, paragraphs, fences, indented code,
 * tables, lists and quotes. Nested container heading semantics, HTML blocks,
 * footnotes, escaped table pipes, and all CommonMark lazy-continuation edge
 * cases still need reference fixtures. No source is executed or globally cached.
 */
export function selectMarkdownSubpath(source: string, fragment: string): MarkdownSubpath | null {
  const lines = splitLines(source);
  let target = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  try { target = decodeURIComponent(target); } catch { /* Match malformed escapes literally. */ }
  if (!target) return { content: source, startLine: 0, endLine: lines.length };

  const isBlock = target.startsWith('^');
  if (isBlock && !/^[A-Za-z0-9-]+$/.test(target.slice(1))) return null;
  const key = isBlock ? target.slice(1) : headingKey(target);
  const blocks: Block[] = [];
  const blockIds = new Map<string, { block: Block; markerLine?: number; markerColumn?: number }>();

  // Mask comments but retain every offset. Fenced code is handled independently.
  const masked = source.replace(/<!--[\s\S]*?-->|%%[\s\S]*?%%/g, value => value.replace(/[^\r\n]/g, ' '));
  const visible = lines.map(line => masked.slice(line.start, line.start + line.text.length));
  let cursor = 0;
  if (lines.length && /^\uFEFF?---[ \t]*$/.test(lines[0].text)) {
    const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line.text));
    if (close >= 0) cursor = close + 1;
  }
  const visibleText = (index: number) => visible[index] ?? '';
  const interrupted = (text: string) => atx.test(text) || Boolean(fenceStart(text)) || listItem.test(text) || quote.test(text) || rule.test(text) || standaloneId.test(text);
  const add = (block: Block) => {
    blocks.push(block);
    if (block.kind !== 'paragraph') return;
    const last = block.end - 1;
    const match = withoutCodeSpans(visibleText(last)).match(inlineId);
    if (match && !blockIds.has(match[1])) blockIds.set(match[1], { block, markerLine: last, markerColumn: match.index });
  };

  while (cursor < lines.length) {
    const text = visibleText(cursor);
    if (!text.trim()) { cursor++; continue; }
    const marker = text.match(standaloneId);
    if (marker) {
      const previous = blocks.at(-1);
      if (previous && !['heading', 'rule'].includes(previous.kind) &&
          visible.slice(previous.end, cursor).every(line => !line.trim()) && !blockIds.has(marker[1])) {
        blockIds.set(marker[1], { block: previous });
      }
      cursor++;
      continue;
    }
    const start = cursor;
    const fence = fenceStart(text);
    if (fence) {
      cursor++;
      const closing = new RegExp(`^ {0,3}${fence.marker === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      while (cursor < lines.length) {
        const closed = closing.test(lines[cursor].text);
        cursor++;
        if (closed) break;
      }
      add({ start, end: cursor, kind: 'fence' });
      continue;
    }
    const heading = text.match(atx);
    if (heading) {
      add({ start, end: ++cursor, kind: 'heading', level: heading[1].length, heading: (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim() });
      continue;
    }
    if (rule.test(text)) { add({ start, end: ++cursor, kind: 'rule' }); continue; }
    if (indented.test(text)) {
      cursor++;
      let lastCode = cursor;
      while (cursor < lines.length && (indented.test(lines[cursor].text) || !lines[cursor].text.trim())) {
        if (lines[cursor].text.trim()) lastCode = cursor + 1;
        cursor++;
      }
      add({ start, end: lastCode, kind: 'code' });
      continue;
    }
    if (listItem.test(text) || quote.test(text)) {
      const kind = quote.test(text) ? 'quote' : 'list';
      cursor++;
      let lastContent = cursor;
      while (cursor < lines.length) {
        const next = visibleText(cursor);
        if (!next.trim()) {
          let following = cursor + 1;
          while (following < lines.length && !visibleText(following).trim()) following++;
          const continuation = visibleText(following);
          if (kind === 'list' ? !(listItem.test(continuation) || /^(?: {2,}|\t)/.test(continuation)) : !quote.test(continuation)) break;
          cursor = following;
          continue;
        }
        if (standaloneId.test(next)) break;
        const explicitContinuation = kind === 'list' ? listItem.test(next) || /^(?: {2,}|\t)/.test(next) : quote.test(next);
        if (!explicitContinuation && (interrupted(next) || !visibleText(cursor - 1).trim())) break;
        cursor++;
        lastContent = cursor;
      }
      add({ start, end: lastContent, kind });
      continue;
    }
    if (cursor + 1 < lines.length && text.includes('|') && tableDelimiter(visibleText(cursor + 1))) {
      cursor += 2;
      while (cursor < lines.length && visibleText(cursor).trim() && visibleText(cursor).includes('|') && !interrupted(visibleText(cursor))) cursor++;
      add({ start, end: cursor, kind: 'table' });
      continue;
    }
    cursor++;
    let underline: RegExpMatchArray | null = null;
    while (cursor < lines.length && visibleText(cursor).trim()) {
      underline = visibleText(cursor).match(setext);
      if (underline) break;
      if (interrupted(visibleText(cursor))) break;
      cursor++;
    }
    if (underline) {
      const headingText = visible.slice(start, cursor).join(' ');
      add({ start, end: ++cursor, kind: 'heading', level: underline[1][0] === '=' ? 1 : 2, heading: headingText });
    } else add({ start, end: cursor, kind: 'paragraph' });
  }

  const select = (start: number, end: number): MarkdownSubpath => ({
    content: source.slice(lines[start].start, end < lines.length ? lines[end].start : source.length),
    startLine: start,
    endLine: end,
  });
  if (isBlock) {
    const match = blockIds.get(key);
    if (!match) return null;
    const result = select(match.block.start, match.block.end);
    if (match.markerLine !== undefined && match.markerColumn !== undefined) {
      const line = lines[match.markerLine];
      const from = line.start + match.markerColumn - lines[match.block.start].start;
      const to = line.start + line.text.length - lines[match.block.start].start;
      result.content = result.content.slice(0, from) + result.content.slice(to);
    }
    return result;
  }
  const index = blocks.findIndex(block => block.kind === 'heading' && headingKey(block.heading ?? '') === key);
  if (index < 0) return null;
  const heading = blocks[index];
  const next = blocks.slice(index + 1).find(block => block.kind === 'heading' && block.level! <= heading.level!);
  return select(heading.start, next?.start ?? lines.length);
}
