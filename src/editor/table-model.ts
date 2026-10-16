export type TableAlignment = 'left' | 'center' | 'right' | null;
export interface TableEdit { from: number; to: number; insert: string }
export interface MarkdownTableCell {
  readonly row: number;
  readonly column: number;
  /** Absolute UTF-16 document positions of the editable, trimmed raw Markdown. */
  readonly from: number;
  readonly to: number;
  /** Absolute positions including the cell's original space/tab padding. */
  readonly rawFrom: number;
  readonly rawTo: number;
  /** Literal Markdown, including pipe escapes; use decodeTableCellText for a cell editor. */
  readonly text: string;
  readonly virtual: boolean;
  readonly insertion?: { readonly at: number; readonly prefix: string; readonly suffix: string };
}
export interface MarkdownTableRow {
  readonly from: number;
  readonly to: number;
  readonly source: string;
  readonly cells: readonly MarkdownTableCell[];
  readonly actualCellCount: number;
  readonly leadingPipe: boolean;
  readonly trailingPipe: boolean;
}
export interface MarkdownTable {
  readonly from: number;
  readonly to: number;
  readonly source: string;
  /** Header is row 0. The alignment separator is deliberately not a content row. */
  readonly rows: readonly MarkdownTableRow[];
  readonly alignments: readonly TableAlignment[];
  readonly columnCount: number;
  readonly separator: { readonly from: number; readonly to: number; readonly source: string };
  readonly lineEnding: '\n' | '\r\n';
  readonly malformed: boolean;
}

interface Line { from: number; to: number; text: string; newline: '\n' | '\r\n' | '' }
interface RawCell { from: number; to: number }
interface SplitRow { line: Line; cells: RawCell[]; leadingPipe: boolean; trailingPipe: boolean; insertAt: number; pipes: number[] }

function readLines(source: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  while (from < source.length) {
    const lf = source.indexOf('\n', from);
    const end = lf === -1 ? source.length : lf;
    const crlf = lf !== -1 && source[end - 1] === '\r';
    const to = crlf ? end - 1 : end;
    lines.push({ from, to, text: source.slice(from, to), newline: lf === -1 ? '' : crlf ? '\r\n' : '\n' });
    if (lf === -1) break;
    from = lf + 1;
  }
  return lines;
}

function splitRow(line: Line): SplitRow {
  const text = line.text, pipes: number[] = [];
  // Escaping is independent of inline code. A code span must escape its pipes too.
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '\\') at++;
    else if (text[at] === '|') pipes.push(at);
  }
  // Border detection happens before cell padding is trimmed. In particular,
  // " | " has two empty cells; its spaces must not turn it into a border-only row.
  const leadingPipe = pipes[0] === 0, trailingPipe = pipes.at(-1) === text.length - 1;
  let previous = 0;
  const cells = pipes.map(pipe => { const cell = { from: previous, to: pipe }; previous = pipe + 1; return cell; });
  cells.push({ from: previous, to: text.length });
  if (leadingPipe) cells.shift();
  if (trailingPipe) cells.pop();
  return { line, cells, leadingPipe, trailingPipe, insertAt: trailingPipe ? text.length - 1 : text.length, pipes };
}

function rawText(row: SplitRow, cell: RawCell): string { return row.line.text.slice(cell.from, cell.to).trim(); }

function virtualInsertion(at: number, missingBefore: number, trailingPipe: boolean): NonNullable<MarkdownTableCell['insertion']> {
  let prefix: string | undefined;
  return {
    at,
    // Most virtual cells are never edited. Keep only their gap count until a
    // caller needs the insertion string, rather than building every prefix of
    // a wide ragged row. The public enumerable string property stays compatible.
    get prefix() { return prefix ??= trailingPipe ? '|  '.repeat(missingBefore) + '| ' : ' | '.repeat(missingBefore + 1); },
    suffix: trailingPipe ? ' ' : '',
  };
}

/** Parse one table beginning on the first line. Positions use CodeMirror's UTF-16 coordinate system. */
export function parseTable(source: string, offset = 0): MarkdownTable | null {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('Table offset must be a nonnegative integer');
  const lines = readLines(source);
  if (lines.length < 2 || !lines[0].newline || /^(?: {4}|\t)/.test(lines[0].text)) return null;
  const header = splitRow(lines[0]), separator = splitRow(lines[1]);
  // The alignment grammar allows padding after its final pipe, whereas the
  // content-row tokenizer retains that padding as a final empty cell.
  const separatorTail = separator.cells.at(-1);
  if (!separator.trailingPipe && separatorTail && separatorTail.from > 0 && /^[ \t]*$/.test(lines[1].text.slice(separatorTail.from, separatorTail.to))) {
    separator.cells.pop();
  }
  if (!header.cells.length || !separator.cells.length || !header.pipes.some(at => at > 0) || !separator.pipes.some(at => at > 0)
    || header.leadingPipe !== separator.leadingPipe) return null;
  const alignment: TableAlignment[] = [];
  for (const cell of separator.cells) {
    const value = rawText(separator, cell);
    if (!/^:?-+:?$/.test(value)) return null;
    alignment.push(value.startsWith(':') ? value.endsWith(':') ? 'center' : 'left' : value.endsWith(':') ? 'right' : null);
  }
  const parsed = [header];
  let lastLine = lines[1];
  for (let index = 2; index < lines.length; index++) {
    const row = splitRow(lines[index]);
    if (!row.line.text.trim() || !row.pipes.some(at => at > 0) || row.leadingPipe !== header.leadingPipe) break;
    parsed.push(row); lastLine = row.line;
  }
  const columnCount = parsed.reduce((width, row) => Math.max(width, row.cells.length), alignment.length);
  const malformed = alignment.length !== columnCount || parsed.some(row => row.cells.length !== columnCount);
  while (alignment.length < columnCount) alignment.push(null);
  const rows = parsed.map((row, rowIndex): MarkdownTableRow => {
    const cells = row.cells.map((cell, column): MarkdownTableCell => {
      let from = cell.from, to = cell.to;
      while (from < to && /[ \t]/.test(row.line.text[from])) from++;
      while (to > from && /[ \t]/.test(row.line.text[to - 1])) to--;
      return { row: rowIndex, column, from: offset + row.line.from + from, to: offset + row.line.from + to,
        rawFrom: offset + row.line.from + cell.from, rawTo: offset + row.line.from + cell.to,
        text: row.line.text.slice(from, to), virtual: false };
    });
    for (let column = cells.length; column < columnCount; column++) {
      const at = offset + row.line.from + row.insertAt, missingBefore = column - row.cells.length;
      cells.push({ row: rowIndex, column, from: at, to: at, rawFrom: at, rawTo: at, text: '', virtual: true,
        insertion: virtualInsertion(at, missingBefore, row.trailingPipe) });
    }
    return { from: offset + row.line.from, to: offset + row.line.to, source: row.line.text, cells,
      actualCellCount: row.cells.length, leadingPipe: row.leadingPipe, trailingPipe: row.trailingPipe };
  });
  return {
    from: offset, to: offset + lastLine.to, source: source.slice(0, lastLine.to), rows, alignments: alignment, columnCount,
    separator: { from: offset + lines[1].from, to: offset + lines[1].to, source: lines[1].text },
    lineEnding: lines[0].newline || '\n', malformed,
  };
}

/** Cell-editor input encoding: preserve odd pipe escapes, add missing escapes, encode line breaks. */
export function encodeTableCellText(text: string): string {
  let result = '', slashes = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\r' && text[index + 1] === '\n') { result += '<br>'; index++; slashes = 0; }
    else if (char === '\n') { result += '<br>'; slashes = 0; }
    else {
      if (char === '|' && slashes % 2 === 0) result += '\\';
      result += char;
      slashes = char === '\\' ? slashes + 1 : 0;
    }
  }
  return result;
}

export interface DecodedTableCell {
  readonly text: string;
  /** Map a decoded-cell cursor to the raw cell source, both relative to their cell starts. */
  toSource(offset: number): number;
  /** Raw boundaries inside an escape or encoded break map to that decoded character's start. */
  fromSource(offset: number): number;
}

/** Decode the observed pipe/<br> forms, retaining explicit position maps for nested editors. */
export function decodeTableCellText(raw: string): DecodedTableCell {
  // This deliberately models the reference's simple run-backreference heuristic,
  // not full Markdown code parsing: escaped ticks and nonmaximal runs can match.
  const code = [...raw.matchAll(/(`+)[^`]+?\1/g)].map(match => ({ from: match.index!, to: match.index! + match[0].length }));
  const toSource = [0], fromSource = new Array<number>(raw.length + 1);
  let text = '', at = 0, codeIndex = 0, slashes = 0;
  while (at < raw.length) {
    while (codeIndex < code.length && code[codeIndex].to <= at) codeIndex++;
    const insideCode = codeIndex < code.length && code[codeIndex].from <= at && at < code[codeIndex].to;
    let consumed = 1, value = raw[at];
    if (raw[at] === '\\' && raw[at + 1] === '|' && slashes % 2 === 0) { consumed = 2; value = '|'; }
    else if (!insideCode && raw.slice(at, at + 4).toLowerCase() === '<br>') { consumed = 4; value = '\n'; }
    for (let i = 0; i < consumed; i++) fromSource[at + i] = text.length;
    text += value; at += consumed; toSource.push(at); fromSource[at] = text.length;
    slashes = consumed === 1 && value === '\\' ? slashes + 1 : 0;
  }
  fromSource[raw.length] = text.length;
  const checked = (value: number, max: number): number => {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError('Cell position is out of range');
    return value;
  };
  return { text, toSource: offset => toSource[checked(offset, text.length)], fromSource: offset => fromSource[checked(offset, raw.length)] };
}

export function replaceTableCell(table: MarkdownTable, row: number, column: number, newText: string): TableEdit {
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0 || row >= table.rows.length || column >= table.columnCount) {
    throw new RangeError('Table cell is out of range');
  }
  const cell = table.rows[row].cells[column], text = encodeTableCellText(newText);
  return { from: cell.from, to: cell.to, insert: cell.insertion ? cell.insertion.prefix + text + cell.insertion.suffix : text };
}

function serializeRow(table: MarkdownTable, values: readonly string[]): string {
  if (values.length > table.columnCount) throw new RangeError('Too many values for the table row');
  const header = table.rows[0];
  const cells = Array.from({ length: table.columnCount }, (_, column) => encodeTableCellText(values[column] ?? ''));
  // Padding ensures an empty last cell remains present without an outer pipe.
  return (header.leadingPipe ? '| ' : ' ') + cells.join(' | ') + (header.trailingPipe ? ' |' : ' ');
}

/** Raw unbordered last cells may end in a literal backslash. Before adding a
 * delimiter after one, padding prevents an odd slash run from escaping it. */
function serializeRawCells(cells: readonly string[], leading: boolean, trailing: boolean): string {
  const safe = cells.map((cell, index) => {
    if (!trailing && index === cells.length - 1) return cell;
    let slashes = 0;
    for (let at = cell.length - 1; at >= 0 && cell[at] === '\\'; at--) slashes++;
    return slashes % 2 ? cell + ' ' : cell;
  });
  return (leading ? '|' : '') + safe.join('|') + (trailing ? '|' : '');
}

/**
 * Insert a content row. At index 0 the new row becomes the header and the old
 * header moves below the unchanged separator. Reparse before further edits.
 */
export function insertTableRow(table: MarkdownTable, index: number, values: readonly string[] = []): TableEdit {
  if (!Number.isInteger(index) || index < 0 || index > table.rows.length) throw new RangeError('Table row is out of range');
  const line = serializeRow(table, values);
  if (index === table.rows.length) return { from: table.to, to: table.to, insert: table.lineEnding + line };
  if (index === 0) {
    const header = table.rows[0];
    const originalBreak = table.source.slice(header.to - table.from, table.separator.from - table.from);
    return { from: header.from, to: table.separator.to,
      insert: line + originalBreak + table.separator.source + table.lineEnding + header.source };
  }
  const at = table.rows[index].from;
  return { from: at, to: at, insert: line + table.lineEnding };
}

/** Append below the last content row. Callers reparse the changed source before navigating. */
export function appendTableRow(table: MarkdownTable, values: readonly string[] = []): TableEdit {
  return insertTableRow(table, table.rows.length, values);
}

/** Insert a column while retaining existing encoded cells, padding and line breaks.
 * Ragged rows are padded so the new header and separator remain a valid table. */
export function insertTableColumn(table: MarkdownTable, index: number, values: readonly string[] = [], alignment: TableAlignment = null): TableEdit {
  if (!Number.isInteger(index) || index < 0 || index > table.columnCount) throw new RangeError('Table column is out of range');
  if (values.length > table.rows.length) throw new RangeError('Too many values for the table column');
  if (alignment !== null && !['left', 'center', 'right'].includes(alignment)) throw new RangeError('Invalid table alignment');
  const edits = table.rows.map((row, rowIndex): TableEdit => {
    const cells = row.cells.map(cell => cell.virtual ? '  ' : row.source.slice(cell.rawFrom - row.from, cell.rawTo - row.from));
    cells.splice(index, 0, ` ${encodeTableCellText(values[rowIndex] ?? '')} `);
    return { from: row.from, to: row.to, insert: serializeRawCells(cells, row.leadingPipe, row.trailingPipe) };
  });
  const separator = splitRow({ from: table.separator.from, to: table.separator.to, text: table.separator.source, newline: '' });
  const alignmentCells = separator.cells.map(cell => separator.line.text.slice(cell.from, cell.to));
  const trailingPadding = !separator.trailingPipe && /^\s*$/.test(alignmentCells.at(-1) ?? '') ? '|' + alignmentCells.pop() : '';
  while (alignmentCells.length < table.columnCount) alignmentCells.push(' --- ');
  const marker = alignment === 'center' ? ':---:' : alignment === 'left' ? ':---' : alignment === 'right' ? '---:' : '---';
  alignmentCells.splice(index, 0, ` ${marker} `);
  edits.push({ from: table.separator.from, to: table.separator.to,
    insert: serializeRawCells(alignmentCells, separator.leadingPipe, separator.trailingPipe) + trailingPadding });
  const pieces: string[] = [];
  let previous = 0;
  for (const edit of edits.sort((a, b) => a.from - b.from)) {
    pieces.push(table.source.slice(previous, edit.from - table.from), edit.insert);
    previous = edit.to - table.from;
  }
  pieces.push(table.source.slice(previous));
  return { from: table.from, to: table.to, insert: pieces.join('') };
}

function checkedIndex(index: number, length: number, kind: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) throw new RangeError(`Table ${kind} is out of range`);
}

/** Reorder/duplicate/remove existing encoded cells without decoding their data. */
function arrangeTable(table: MarkdownTable, rows: readonly number[], columns: readonly number[]): TableEdit {
  if (!rows.length || !columns.length) return { from: table.from, to: table.to, insert: '' };
  // Structural serialization uses explicit borders, including single-column
  // tables and moved cells whose padding could otherwise look like code indent.
  const rowText = (rowIndex: number) => {
    const row = table.rows[rowIndex];
    const cells = columns.map(column => {
      const cell = row.cells[column];
      return cell.virtual ? '  ' : row.source.slice(cell.rawFrom - row.from, cell.rawTo - row.from);
    });
    return serializeRawCells(cells, true, true);
  };
  const separator = splitRow({ from: 0, to: table.separator.source.length, text: table.separator.source, newline: '' });
  const oldAlignments = separator.cells.map(cell => separator.line.text.slice(cell.from, cell.to));
  const tail = !separator.trailingPipe && /^\s*$/.test(oldAlignments.at(-1) ?? '') ? oldAlignments.pop() : undefined;
  const separatorText = '|' + columns.map(column => oldAlignments[column] ?? ' --- ').join('|') + '|' + (tail ?? '');
  const lines = [rowText(rows[0]), separatorText, ...rows.slice(1).map(rowText)];
  return { from: table.from, to: table.to, insert: lines.join(table.lineEnding) };
}

const indices = (length: number) => Array.from({ length }, (_, index) => index);

export function deleteTableRow(table: MarkdownTable, row: number): TableEdit {
  checkedIndex(row, table.rows.length, 'row');
  return arrangeTable(table, indices(table.rows.length).filter(index => index !== row), indices(table.columnCount));
}

export function duplicateTableRow(table: MarkdownTable, row: number): TableEdit {
  checkedIndex(row, table.rows.length, 'row');
  const rows = indices(table.rows.length); rows.splice(row, 0, row);
  return arrangeTable(table, rows, indices(table.columnCount));
}

export function moveTableRow(table: MarkdownTable, row: number, destination: number): TableEdit {
  checkedIndex(row, table.rows.length, 'row'); checkedIndex(destination, table.rows.length, 'row');
  const rows = indices(table.rows.length); rows.splice(destination, 0, rows.splice(row, 1)[0]);
  return arrangeTable(table, rows, indices(table.columnCount));
}

export function deleteTableColumn(table: MarkdownTable, column: number): TableEdit {
  checkedIndex(column, table.columnCount, 'column');
  return arrangeTable(table, indices(table.rows.length), indices(table.columnCount).filter(index => index !== column));
}

export function duplicateTableColumn(table: MarkdownTable, column: number): TableEdit {
  checkedIndex(column, table.columnCount, 'column');
  const columns = indices(table.columnCount); columns.splice(column, 0, column);
  return arrangeTable(table, indices(table.rows.length), columns);
}

export function moveTableColumn(table: MarkdownTable, column: number, destination: number): TableEdit {
  checkedIndex(column, table.columnCount, 'column'); checkedIndex(destination, table.columnCount, 'column');
  const columns = indices(table.columnCount); columns.splice(destination, 0, columns.splice(column, 1)[0]);
  return arrangeTable(table, indices(table.rows.length), columns);
}

export function setTableColumnAlignment(table: MarkdownTable, column: number, alignment: TableAlignment): TableEdit {
  checkedIndex(column, table.columnCount, 'column');
  if (alignment !== null && !['left', 'center', 'right'].includes(alignment)) throw new RangeError('Invalid table alignment');
  // Materialize malformed rows/alignments before changing their separator.
  const normalized = arrangeTable(table, indices(table.rows.length), indices(table.columnCount));
  const model = parseTable(normalized.insert)!;
  const separator = splitRow({ from: 0, to: model.separator.source.length, text: model.separator.source, newline: '' });
  const cell = separator.cells[column], raw = separator.line.text.slice(cell.from, cell.to);
  const next = raw.replace(/:?-+:?/, marker => {
    const dashes = marker.replace(/:/g, '');
    return (alignment === 'left' || alignment === 'center' ? ':' : '') + dashes + (alignment === 'right' || alignment === 'center' ? ':' : '');
  });
  const at = model.separator.from + cell.from;
  return { from: table.from, to: table.to, insert: normalized.insert.slice(0, at) + next + normalized.insert.slice(at + raw.length) };
}

/** Header stays fixed; caller supplies the rendered text of each row's target cell. */
export function sortTableRows(table: MarkdownTable, column: number, direction: 'ascending' | 'descending', renderedValues: readonly string[]): TableEdit {
  checkedIndex(column, table.columnCount, 'column');
  if (renderedValues.length !== table.rows.length) throw new RangeError('Sort values must cover every table row');
  if (direction !== 'ascending' && direction !== 'descending') throw new RangeError('Invalid table sort direction');
  const compare = new Intl.Collator(undefined, { usage: 'sort', sensitivity: 'base', numeric: true }).compare;
  const rows = indices(table.rows.length).slice(1).sort((a, b) => {
    const order = compare(renderedValues[a], renderedValues[b]);
    return (direction === 'ascending' ? order : -order) || a - b;
  });
  return arrangeTable(table, [0, ...rows], indices(table.columnCount));
}
