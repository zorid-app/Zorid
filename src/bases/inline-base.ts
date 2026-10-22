/** An exact source occurrence, never a path/ordinal search for a similar block.
 * The workspace also validates the containing file incarnation and durable
 * revision before accepting this source through its ordinary NoteBuffer. */
export interface InlineBaseRequest {
  readonly documentText: string;
  readonly from: number;
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly source: string;
}

/** Read a parser-owned fence. Offsets are UTF-16 in the ORIGINAL
 * document, including CRLF; normalized Reading positions must be mapped first.
 * The complete physical lines include quote/list prefixes for exact editing. */
export function inlineBaseRequest(documentText: string, from: number, to: number): InlineBaseRequest | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > documentText.length || to < from) return null;
  if (from && documentText[from - 1] !== '\n') return null;
  const block = documentText.slice(from, to);
  const opening = /^([^\r\n]*?)(`{3,}|~{3,})[ \t]*base[ \t]*(\r?\n)/.exec(block);
  if (!opening) return null;
  if (!/^(?:(?:[ \t]*>[ \t]?)|[ \t]+|(?:[-+*]|\d+[.)])[ \t]+)*$/.test(opening[1])) return null;
  const continuation = opening[1].replace(/(?:[-+*]|\d+[.)])[ \t]+/g, marker => ' '.repeat(marker.length));
  const closing = /(?:^|\n)([^\r\n]*?)(`{3,}|~{3,})[ \t]*\r?$/.exec(block);
  if (!closing || closing[2][0] !== opening[2][0] || closing[2].length < opening[2].length) return null;
  if (closing[1].replace(/[ \t]/g, '') !== continuation.replace(/[ \t]/g, '')) return null;
  const contentFrom = from + opening[0].length;
  const contentTo = from + closing.index + (closing[0].startsWith('\n') ? 1 : 0);
  if (contentTo < contentFrom) return null;
  const body = documentText.slice(contentFrom, contentTo).replace(/\r\n/g, '\n');
  const lines = body.split('\n'), content: string[] = [];
  const quoteCount = [...continuation].filter(character => character === '>').length;
  const padding = quoteCount ? Math.max(0, continuation.length - continuation.lastIndexOf('>') - 2) : continuation.length;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line && index === lines.length - 1) { content.push(''); continue; }
    let remainder = line, quotes = 0;
    while (quotes < quoteCount) {
      const quote = /^[ \t]*>[ \t]?/.exec(remainder);
      if (!quote) break;
      remainder = remainder.slice(quote[0].length); quotes++;
    }
    if (quotes === quoteCount) {
      const spaces = /^[ \t]*/.exec(remainder)![0].length;
      content.push(remainder.slice(Math.min(padding, spaces)));
    }
    else if (/^[ \t>]*$/.test(line)) content.push('');
    else return null;
  }
  const source = content.join('\n');
  return Object.freeze({ documentText, from, to, contentFrom, contentTo, source });
}

/** Preserve marker spelling, surrounding text, indentation and line endings.
 * Requiring the full captured document prevents silently retargeting identical
 * fences after inserts/deletes. The caller can remount a fresh occurrence after
 * an external edit; a retained draft must instead report the conflict. */
export function replaceInlineBaseSource(documentText: string, request: InlineBaseRequest, source: string): string {
  if (documentText !== request.documentText) throw new Error('The note containing this Base changed. Refresh before editing its configuration.');
  const current = inlineBaseRequest(documentText, request.from, request.to);
  if (!current || current.contentFrom !== request.contentFrom || current.contentTo !== request.contentTo || current.source !== request.source) {
    throw new Error('The embedded Base source no longer matches this occurrence.');
  }
  if (source === current.source) return documentText;
  const opening = /^([^\r\n]*?)(`{3,}|~{3,})/.exec(documentText.slice(request.from))!;
  const continuation = opening[1].replace(/(?:[-+*]|\d+[.)])[ \t]+/g, marker => ' '.repeat(marker.length));
  const normalized = source.replace(/\r\n/g, '\n');
  for (const line of normalized.split('\n')) {
    const close = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
    if (close && close[2][0] === opening[2][0] && close[2].length >= opening[2].length) {
      throw new Error('The Base configuration contains a closing fence. Use a longer fence in the note before saving.');
    }
  }
  const eol = documentText.slice(request.from, request.contentFrom).endsWith('\r\n') ? '\r\n' : '\n';
  const lines = normalized.replace(/\n$/, '').split('\n');
  const body = normalized.length ? lines.map(line => continuation + line).join(eol) + eol : '';
  return documentText.slice(0, request.contentFrom) + body + documentText.slice(request.contentTo);
}

/** Full-document source mapping for Reading's newline-normalized parser. */
export function originalMarkdownOffset(source: string, normalizedOffset: number): number {
  let raw = 0, normalized = 0;
  while (raw < source.length && normalized < normalizedOffset) {
    raw += source[raw] === '\r' && source[raw + 1] === '\n' ? 2 : 1;
    normalized++;
  }
  return raw;
}
