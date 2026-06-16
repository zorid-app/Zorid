import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

export interface MarkdownTableCell {
  readonly from: number;
  readonly to: number;
  readonly source: string;
  readonly value: string;
}

export interface MarkdownTableRow {
  readonly from: number;
  readonly to: number;
  readonly cells: readonly MarkdownTableCell[];
}

export interface MarkdownTableModel {
  readonly from: number;
  readonly to: number;
  readonly delimiterFrom: number;
  readonly delimiterTo: number;
  readonly columnCount: number;
  readonly header: MarkdownTableRow;
  readonly rows: readonly MarkdownTableRow[];
}

export interface MarkdownTableCollectionOptions {
  readonly maxRows?: number;
}

const tableNodeName = 'Table';
const tableHeaderNodeName = 'TableHeader';
const tableRowNodeName = 'TableRow';
const tableCellNodeName = 'TableCell';
const tableDelimiterNodeName = 'TableDelimiter';
const defaultMaxRows = 250;

function unescapeMarkdownTableCell(value: string): string {
  return value
    .trim()
    .replaceAll('\\|', '|')
    .replaceAll('<br>', '\n')
    .replaceAll('<br/>', '\n')
    .replaceAll('<br />', '\n');
}

function escapeMarkdownTableCell(value: string): string {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', '<br>');
  let escaped = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '|' && normalized[index - 1] !== '\\') escaped += '\\';
    escaped += character;
  }
  return escaped;
}

function lineBounds(state: EditorState, from: number, to: number): { readonly from: number; readonly to: number } {
  return { from: state.doc.lineAt(from).from, to: state.doc.lineAt(Math.max(from, to - 1)).to };
}

function readCells(
  state: EditorState,
  rowNode: { readonly from: number; readonly to: number; readonly firstChild: unknown },
): MarkdownTableCell[] {
  const cells: MarkdownTableCell[] = [];
  for (let child = rowNode.firstChild as SyntaxNodeLike | null; child; child = child.nextSibling) {
    if (child.name !== tableCellNodeName) continue;
    const source = state.doc.sliceString(child.from, child.to);
    cells.push({ from: child.from, to: child.to, source, value: unescapeMarkdownTableCell(source) });
  }
  return cells;
}

interface SyntaxNodeLike {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly firstChild: SyntaxNodeLike | null;
  readonly nextSibling: SyntaxNodeLike | null;
}

function tableModelFromNode(state: EditorState, node: SyntaxNodeLike, maxRows: number): MarkdownTableModel | null {
  let header: MarkdownTableRow | null = null;
  let delimiterFrom = -1;
  let delimiterTo = -1;
  const rows: MarkdownTableRow[] = [];
  let stoppedRows = false;

  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === tableHeaderNodeName) {
      const bounds = lineBounds(state, child.from, child.to);
      header = { ...bounds, cells: readCells(state, child) };
      continue;
    }
    if (child.name === tableDelimiterNodeName && delimiterFrom < 0) {
      const bounds = lineBounds(state, child.from, child.to);
      delimiterFrom = bounds.from;
      delimiterTo = bounds.to;
      continue;
    }
    if (child.name === tableRowNodeName && rows.length >= maxRows) return null;
    if (child.name === tableRowNodeName && !stoppedRows) {
      const bounds = lineBounds(state, child.from, child.to);
      if (!state.doc.sliceString(bounds.from, bounds.to).includes('|')) {
        stoppedRows = true;
        continue;
      }
      const cells = readCells(state, child);
      if (cells.length > 0) rows.push({ ...bounds, cells });
    }
  }

  if (!header || delimiterFrom < 0 || header.cells.length === 0) return null;
  const lastRow = rows.at(-1);
  const bounds = { from: header.from, to: lastRow?.to ?? delimiterTo };
  return {
    ...bounds,
    delimiterFrom,
    delimiterTo,
    columnCount: header.cells.length,
    header,
    rows,
  };
}

export function collectMarkdownTables(
  state: EditorState,
  from: number,
  to: number,
  options: MarkdownTableCollectionOptions = {},
): MarkdownTableModel[] {
  const tree = ensureSyntaxTree(state, to, 50) ?? syntaxTree(state);
  const tables: MarkdownTableModel[] = [];
  const maxRows = options.maxRows ?? defaultMaxRows;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name !== tableNodeName) return;
      const model = tableModelFromNode(state, node.node as SyntaxNodeLike, maxRows);
      if (model) tables.push(model);
    },
  });
  return tables;
}

export function findMarkdownTableAt(state: EditorState, position: number): MarkdownTableModel | null {
  return collectMarkdownTables(state, Math.max(0, position - 1), Math.min(state.doc.length, position + 1))[0] ?? null;
}

export function normalizeMarkdownTableRows(table: MarkdownTableModel): string[][] {
  const rows = [table.header, ...table.rows];
  return rows.map((row) => Array.from({ length: table.columnCount }, (_, index) => row.cells[index]?.value ?? ''));
}

export function serializeMarkdownTable(rows: readonly (readonly string[])[]): string {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const normalizedRows = rows.length > 0 ? rows : [Array.from({ length: columnCount }, () => '')];
  const cells = normalizedRows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ''));
  const serializeRow = (row: readonly string[]) => `| ${row.map(escapeMarkdownTableCell).join(' | ')} |`;
  return [
    serializeRow(cells[0] ?? []),
    `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`,
    ...cells.slice(1).map(serializeRow),
  ].join('\n');
}

export function replaceMarkdownTableCell(
  table: MarkdownTableModel,
  rowIndex: number,
  columnIndex: number,
  value: string,
): string {
  const rows = normalizeMarkdownTableRows(table).map((row) => [...row]);
  const row = rows[rowIndex];
  if (!row) return serializeMarkdownTable(rows);
  row[columnIndex] = value;
  return serializeMarkdownTable(rows);
}

export function addMarkdownTableRow(table: MarkdownTableModel, at: number): string {
  const rows = normalizeMarkdownTableRows(table).map((row) => [...row]);
  rows.splice(
    Math.max(1, Math.min(rows.length, at)),
    0,
    Array.from({ length: table.columnCount }, () => ''),
  );
  return serializeMarkdownTable(rows);
}

export function addMarkdownTableColumn(table: MarkdownTableModel, at: number): string {
  const rows = normalizeMarkdownTableRows(table).map((row) => [...row]);
  const index = Math.max(0, Math.min(table.columnCount, at));
  for (const row of rows) row.splice(index, 0, '');
  return serializeMarkdownTable(rows);
}

export function deleteMarkdownTableRows(table: MarkdownTableModel, fromRow: number, toRow: number): string | null {
  if (fromRow <= 0) return null;
  const rows = normalizeMarkdownTableRows(table).map((row) => [...row]);
  rows.splice(fromRow, toRow - fromRow + 1);
  return serializeMarkdownTable(rows);
}

export function deleteMarkdownTableColumns(
  table: MarkdownTableModel,
  fromColumn: number,
  toColumn: number,
): string | null {
  if (table.columnCount <= toColumn - fromColumn + 1) return null;
  const rows = normalizeMarkdownTableRows(table).map((row) => {
    const next = [...row];
    next.splice(fromColumn, toColumn - fromColumn + 1);
    return next;
  });
  return serializeMarkdownTable(rows);
}
