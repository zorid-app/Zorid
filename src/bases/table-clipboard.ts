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
