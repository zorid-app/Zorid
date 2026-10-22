import { BASE_NULL } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';

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

/** No evaluation/coercion of rich values here; the property registry owns those. */
export function parsePrimitiveBaseTableInput(raw: string, current: BaseExpressionValue): BaseExpressionValue {
  if (raw === '') return BASE_NULL;
  if (current.type === 'null' || current.type === 'string') return { type: 'string', value: raw };
  if (current.type === 'number') {
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value)) throw new Error('Enter a valid number.');
    return { type: 'number', value };
  }
  if (current.type === 'boolean') {
    if (/^(true|false)$/i.test(raw)) return { type: 'boolean', value: raw.toLowerCase() === 'true' };
    throw new Error('Enter true or false for a checkbox.');
  }
  throw new Error('This property cannot accept plain text.');
}
