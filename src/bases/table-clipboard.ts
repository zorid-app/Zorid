/** Quoted TSV preserves tabs, line breaks, quotes and trailing empty cells. */
export function parseBaseTableTSV(source: string): string[][] {
  if (source.length > 8_000_000) throw new Error('The pasted table is too large.');
  const rows: string[][] = [], row: string[] = [];
  let value = '', quoted = false, closed = false;
  const field = () => { row.push(value); value = ''; closed = false; };
  const line = () => { field(); rows.push(row.splice(0)); };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') { if (source[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } }
      else value += c;
    } else if (c === '"' && !value && !closed) quoted = true;
    else if (c === '\t') field();
    else if (c === '\n' || c === '\r') { if (c === '\r' && source[i + 1] === '\n') i++; line(); }
    else { if (closed) throw new Error('Invalid quoted table clipboard.'); value += c; }
    if (rows.length > 100_000 || row.length > 10_000) throw new Error('The pasted table is too large.');
  }
  if (quoted) throw new Error('Unclosed quote in table clipboard.');
  if (value || row.length || !rows.length || !/[\r\n]$/.test(source)) line();
  const width = rows[0]?.length ?? 0;
  if (rows.some(row => row.length !== width)) throw new Error('Paste a rectangular table.');
  return rows;
}

export const BASE_TABLE_CLIPBOARD_LIMIT = 8_000_000;
const ownMarker = 'data-zorid-bases-clipboard', ownCells = 'data-zorid-bases-cells';

function checkedCells(source: string): unknown[][] {
  if (source.length > BASE_TABLE_CLIPBOARD_LIMIT) throw new Error('The pasted table is too large.');
  const cells: unknown = JSON.parse(source);
  if (!Array.isArray(cells) || !cells.length || cells.length > 100_000 || !Array.isArray(cells[0]) || !cells[0].length || cells[0].length > 10_000) throw new Error('Invalid Bases clipboard.');
  const width = cells[0].length;
  let budget = 500_000;
  const value = (input: unknown, depth = 0): boolean => {
    if (--budget < 0 || depth > 64) return false;
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return true;
    if (typeof input === 'number') return Number.isFinite(input);
    if (Array.isArray(input)) return input.every(item => value(item, depth + 1));
    return !!input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype
      && Object.values(input).every(item => value(item, depth + 1));
  };
  for (const row of cells) {
    if (!Array.isArray(row) || row.length !== width) throw new Error('Invalid Bases clipboard.');
    for (const cell of row) {
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)
        || Object.keys(cell).some(key => key !== 'type' && key !== 'data')
        || !['note', 'file', 'formula'].includes(cell.type)
        || Object.hasOwn(cell, 'data') && (cell.type !== 'note' || !value(cell.data))) throw new Error('Invalid Bases clipboard.');
    }
  }
  return cells;
}

/** Standard sanitized HTML carries typed cells without a custom-format API.
 * Only textContent/attribute setters serialize data; no source HTML is inserted. */
export function baseTableClipboardHTML(document: Document, header: readonly string[], rows: readonly string[][], cells: string): string {
  const raw = checkedCells(cells);
  if (rows.length !== raw.length || rows.some(row => row.length !== header.length) || raw[0].length !== header.length) throw new Error('Invalid Bases clipboard.');
  const inert = document.implementation.createHTMLDocument(''), table = inert.createElement('table');
  table.setAttribute(ownMarker, '1'); table.setAttribute(ownCells, cells);
  // Public HTML matches the selected data rectangle, like text/plain. Labels
  // remain in the existing application table envelope, never an extra row.
  const body = table.createTBody();
  for (const row of rows) { const line = body.insertRow(); for (const text of row) line.insertCell().textContent = text; }
  const html = table.outerHTML;
  if (html.length > BASE_TABLE_CLIPBOARD_LIMIT) throw new Error('The copied table is too large.');
  return html;
}

/** Absence permits ordinary external text fallback. A recognized but damaged
 * payload must fail, never silently become a differently typed clipboard edit. */
export function baseTableCellsFromHTML(document: Document, html: string): string | undefined {
  if (html.length > BASE_TABLE_CLIPBOARD_LIMIT) throw new Error('The pasted table is too large.');
  if (!html) return;
  const inert = document.implementation.createHTMLDocument(''), template = inert.createElement('template');
  // Detached-document template parsing cannot execute or fetch resources. Its
  // nodes are never adopted into the receiving document.
  template.innerHTML = html;
  const marked = template.content.querySelectorAll(`[${ownMarker}],[${ownCells}]`);
  if (!marked.length) return;
  if (marked.length !== 1) throw new Error('Invalid Bases clipboard.');
  const table = marked[0];
  if (table.tagName !== 'TABLE' || table.getAttribute(ownMarker) !== '1' || !table.hasAttribute(ownCells)) throw new Error('Invalid Bases clipboard.');
  const source = table.getAttribute(ownCells)!, cells = checkedCells(source);
  const bodies = [...table.children].filter(element => element.tagName === 'TBODY');
  if (bodies.length !== 1 || bodies[0].children.length !== cells.length
    || [...bodies[0].children].some(row => row.tagName !== 'TR' || row.children.length !== cells[0].length || [...row.children].some(cell => cell.tagName !== 'TD'))) throw new Error('Invalid Bases clipboard.');
  return source;
}
