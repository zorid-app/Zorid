import type { EditorState } from '@codemirror/state';
import { type EditorView, WidgetType } from '@codemirror/view';
import type { InternalLivePreviewRange, InternalLivePreviewRenderer } from '../internal-types.js';
import {
  addMarkdownTableColumn,
  addMarkdownTableRow,
  collectMarkdownTables,
  deleteMarkdownTableColumns,
  deleteMarkdownTableRows,
  findMarkdownTableAt,
  type MarkdownTableModel,
  normalizeMarkdownTableRows,
  replaceMarkdownTableCell,
  serializeMarkdownTable,
} from './model.js';
import { renderMarkdownTableSelection } from './selection-rendering.js';
import { type MarkdownTableSelectionKind, markdownTableSelectionField, setMarkdownTableSelection } from './state.js';

const tableWidgetClassName = 'z-live-preview-table-widget';

interface TableIndexRange {
  readonly from: number;
  readonly to: number;
}

interface TableContextMenuTarget {
  readonly row: TableIndexRange;
  readonly column: TableIndexRange;
}

interface CellSelectionRange {
  readonly start: number;
  readonly end: number;
}

function appendDotHandle(element: HTMLElement, label: string): void {
  element.setAttribute('aria-label', label);
  element.title = label;
  const dots = document.createElement('span');
  dots.className = 'z-live-preview-table-handle-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 6; index += 1) dots.append(document.createElement('span'));
  element.append(dots);
}

function selectedRange(view: EditorView, table: MarkdownTableModel, kind: MarkdownTableSelectionKind, index: number) {
  const current = view.state.field(markdownTableSelectionField, false);
  if (!current || current.tableFrom !== table.from || current.kind !== kind) return { from: index, to: index };
  return { from: Math.min(current.from, index), to: Math.max(current.to, index) };
}

function focusCell(
  view: EditorView,
  tableFrom: number,
  row: number,
  column: number,
  selection?: CellSelectionRange,
): void {
  queueMicrotask(() => {
    const cell = view.dom.querySelector<HTMLTextAreaElement>(
      `[data-live-preview-renderer="markdown-table-widget"][data-table-from="${tableFrom}"] ` +
        `[data-live-preview-table-cell][data-row="${row}"][data-column="${column}"]`,
    );
    cell?.focus();
    if (!cell) return;
    if (selection) {
      cell.setSelectionRange(selection.start, selection.end);
      return;
    }
    cell.select();
  });
}

function currentTable(view: EditorView, table: MarkdownTableModel): MarkdownTableModel | null {
  return findMarkdownTableAt(view.state, table.from);
}

function replaceTable(view: EditorView, table: MarkdownTableModel, source: string): void {
  view.dispatch({ changes: { from: table.from, to: table.to, insert: source } });
}

function rowOperation(
  table: MarkdownTableModel,
  range: TableIndexRange,
  operation: 'duplicate' | 'move-up' | 'move-down',
): string | null {
  if (range.from <= 0) return null;
  const rows = normalizeMarkdownTableRows(table).map((row) => [...row]);
  const clamped = { from: range.from, to: Math.min(range.to, rows.length - 1) };
  if (clamped.from > clamped.to) return null;
  const selected = rows.slice(clamped.from, clamped.to + 1).map((row) => [...row]);
  if (operation === 'duplicate') rows.splice(clamped.to + 1, 0, ...selected);
  if (operation === 'move-up' && clamped.from > 1) {
    rows.splice(clamped.from, selected.length);
    rows.splice(clamped.from - 1, 0, ...selected);
  }
  if (operation === 'move-down' && clamped.to < rows.length - 1) {
    rows.splice(clamped.from, selected.length);
    rows.splice(clamped.from + 1, 0, ...selected);
  }
  return serializeMarkdownTable(rows);
}

function columnOperation(
  table: MarkdownTableModel,
  range: TableIndexRange,
  operation: 'duplicate' | 'move-left' | 'move-right',
): string | null {
  const rows = normalizeMarkdownTableRows(table).map((row) => [...row]);
  const clamped = { from: Math.max(0, range.from), to: Math.min(range.to, table.columnCount - 1) };
  if (clamped.from > clamped.to) return null;
  if (operation === 'duplicate') {
    for (const row of rows) row.splice(clamped.to + 1, 0, ...row.slice(clamped.from, clamped.to + 1));
  }
  if (operation === 'move-left' && clamped.from > 0) {
    for (const row of rows) {
      const selected = row.splice(clamped.from, clamped.to - clamped.from + 1);
      row.splice(clamped.from - 1, 0, ...selected);
    }
  }
  if (operation === 'move-right' && clamped.to < table.columnCount - 1) {
    for (const row of rows) {
      const selected = row.splice(clamped.from, clamped.to - clamped.from + 1);
      row.splice(clamped.from + 1, 0, ...selected);
    }
  }
  return serializeMarkdownTable(rows);
}

function selectedContextRange(
  view: EditorView,
  table: MarkdownTableModel,
  kind: MarkdownTableSelectionKind,
  index: number,
): TableIndexRange | null {
  const current = view.state.field(markdownTableSelectionField, false);
  if (!current || current.tableFrom !== table.from || current.kind !== kind) return null;
  if (index < current.from || index > current.to) return null;
  return { from: current.from, to: current.to };
}

function tableContextMenuAction(
  table: MarkdownTableModel,
  target: TableContextMenuTarget,
  action: string,
): string | null {
  if (action === 'add-row') return addMarkdownTableRow(table, target.row.to + 1);
  if (action === 'add-column') return addMarkdownTableColumn(table, target.column.to + 1);
  if (action === 'duplicate-row') return rowOperation(table, target.row, 'duplicate');
  if (action === 'duplicate-column') return columnOperation(table, target.column, 'duplicate');
  if (action === 'delete-row') return deleteMarkdownTableRows(table, target.row.from, target.row.to);
  if (action === 'delete-column') return deleteMarkdownTableColumns(table, target.column.from, target.column.to);
  if (action === 'move-row-up') return rowOperation(table, target.row, 'move-up');
  if (action === 'move-row-down') return rowOperation(table, target.row, 'move-down');
  if (action === 'move-column-left') return columnOperation(table, target.column, 'move-left');
  if (action === 'move-column-right') return columnOperation(table, target.column, 'move-right');
  return null;
}

function tableContentSignature(table: MarkdownTableModel, source: string): string {
  return JSON.stringify({
    source,
    delimiterFrom: table.delimiterFrom,
    delimiterTo: table.delimiterTo,
    columnCount: table.columnCount,
    rows: [table.header, ...table.rows].map((row) => ({
      from: row.from,
      to: row.to,
      cells: row.cells.map((cell) => ({
        from: cell.from,
        to: cell.to,
        source: cell.source,
        value: cell.value,
      })),
    })),
  });
}

class MarkdownTableWidget extends WidgetType {
  readonly #contentSignature: string;

  constructor(
    readonly table: MarkdownTableModel,
    source: string,
  ) {
    super();
    this.#contentSignature = tableContentSignature(table, source);
  }

  eq(other: MarkdownTableWidget): boolean {
    return (
      this.table.from === other.table.from &&
      this.table.to === other.table.to &&
      this.#contentSignature === other.#contentSignature
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div');
    root.className = tableWidgetClassName;
    root.dataset.livePreviewRenderer = 'markdown-table-widget';
    root.dataset.tableFrom = String(this.table.from);
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Markdown table editor');

    const rows = normalizeMarkdownTableRows(this.table);
    const tableElement = document.createElement('table');
    tableElement.className = 'z-live-preview-table-grid';
    const body = document.createElement('tbody');

    const select = (kind: MarkdownTableSelectionKind, index: number, extend: boolean) => {
      const range = extend ? selectedRange(view, this.table, kind, index) : { from: index, to: index };
      const selection = { tableFrom: this.table.from, kind, ...range };
      view.dispatch({ effects: setMarkdownTableSelection.of(selection) });
      renderMarkdownTableSelection(root, selection);
    };
    const clearSelection = () => {
      if (!view.state.field(markdownTableSelectionField, false)) return;
      view.dispatch({ effects: setMarkdownTableSelection.of(null) });
      renderMarkdownTableSelection(root, null);
    };

    rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      const handle = document.createElement(rowIndex === 0 ? 'th' : 'td');
      handle.className = 'z-live-preview-table-handle z-live-preview-table-row-handle';
      handle.dataset.row = String(rowIndex);
      handle.setAttribute('role', 'button');
      handle.tabIndex = 0;
      appendDotHandle(handle, rowIndex === 0 ? 'Select header row' : `Select row ${rowIndex}`);
      handle.addEventListener('mousedown', (event) => {
        event.preventDefault();
        select('row', rowIndex, event.shiftKey);
      });
      tr.append(handle);

      row.forEach((value, columnIndex) => {
        const cell = document.createElement(rowIndex === 0 ? 'th' : 'td');
        cell.className = 'z-live-preview-table-cell-box';
        cell.dataset.livePreviewTableCellBox = 'true';
        cell.dataset.row = String(rowIndex);
        cell.dataset.column = String(columnIndex);
        const input = document.createElement('textarea');
        input.className = 'z-live-preview-table-cell';
        input.dataset.livePreviewTableCell = 'true';
        input.dataset.row = String(rowIndex);
        input.dataset.column = String(columnIndex);
        input.value = value;
        input.rows = Math.max(1, value.split('\n').length);
        input.addEventListener('mousedown', (event) => {
          if (event.button === 0) clearSelection();
        });
        input.addEventListener('focus', clearSelection);
        input.addEventListener('input', () => {
          const table = currentTable(view, this.table);
          if (!table) return;
          const selection = {
            start: input.selectionStart ?? input.value.length,
            end: input.selectionEnd ?? input.value.length,
          };
          replaceTable(view, table, replaceMarkdownTableCell(table, rowIndex, columnIndex, input.value));
          focusCell(view, table.from, rowIndex, columnIndex, selection);
        });
        input.addEventListener('keydown', (event) => {
          const table = currentTable(view, this.table);
          if (!table) return;
          if (event.key === 'Tab') {
            event.preventDefault();
            const nextColumn = event.shiftKey ? columnIndex - 1 : columnIndex + 1;
            let nextRow = rowIndex;
            let source: string | null = null;
            if (nextColumn >= table.columnCount) {
              nextRow += 1;
              source = nextRow >= rows.length ? addMarkdownTableRow(table, rows.length) : null;
              replaceTable(view, table, source ?? serializeMarkdownTable(normalizeMarkdownTableRows(table)));
              focusCell(view, table.from, nextRow, 0);
              return;
            }
            if (nextColumn < 0) {
              if (rowIndex === 0) {
                source = addMarkdownTableRow(table, 1);
                replaceTable(view, table, source);
                focusCell(view, table.from, 1, 0);
                return;
              }
              focusCell(view, table.from, rowIndex - 1, table.columnCount - 1);
              return;
            }
            focusCell(view, table.from, nextRow, nextColumn);
            return;
          }
          if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? start;
            input.value = `${input.value.slice(0, start)}\n${input.value.slice(end)}`;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (rowIndex >= rows.length - 1) replaceTable(view, table, addMarkdownTableRow(table, rows.length));
            focusCell(view, table.from, rowIndex + 1, columnIndex);
          }
        });
        cell.append(input);
        tr.append(cell);
      });
      body.append(tr);
    });

    const columnHandleRow = document.createElement('tr');
    columnHandleRow.className = 'z-live-preview-table-column-handles';
    columnHandleRow.append(document.createElement('td'));
    for (let columnIndex = 0; columnIndex < this.table.columnCount; columnIndex += 1) {
      const cell = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'z-live-preview-table-handle z-live-preview-table-column-handle';
      button.dataset.column = String(columnIndex);
      appendDotHandle(button, `Select column ${columnIndex + 1}`);
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        select('column', columnIndex, event.shiftKey);
      });
      cell.append(button);
      columnHandleRow.append(cell);
    }
    body.prepend(columnHandleRow);
    tableElement.append(body);
    root.append(tableElement);

    const bottomPlus = document.createElement('button');
    bottomPlus.type = 'button';
    bottomPlus.className = 'z-live-preview-table-plus z-live-preview-table-plus--row';
    bottomPlus.setAttribute('aria-label', 'Add row');
    bottomPlus.title = 'Add row';
    bottomPlus.addEventListener('click', () => {
      const table = currentTable(view, this.table);
      if (table) replaceTable(view, table, addMarkdownTableRow(table, rows.length));
    });
    const rightPlus = document.createElement('button');
    rightPlus.type = 'button';
    rightPlus.className = 'z-live-preview-table-plus z-live-preview-table-plus--column';
    rightPlus.setAttribute('aria-label', 'Add column');
    rightPlus.title = 'Add column';
    rightPlus.addEventListener('click', () => {
      const table = currentTable(view, this.table);
      if (table) replaceTable(view, table, addMarkdownTableColumn(table, table.columnCount));
    });
    root.append(bottomPlus, rightPlus);

    root.addEventListener('contextmenu', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const cell = target?.closest<HTMLTextAreaElement>('[data-live-preview-table-cell]');
      if (!cell) return;
      event.preventDefault();
      const row = Number(cell.dataset.row);
      const column = Number(cell.dataset.column);
      const selectedRows = selectedContextRange(view, this.table, 'row', row);
      const selectedColumns = selectedContextRange(view, this.table, 'column', column);
      const contextTarget = {
        row: selectedRows ?? { from: row, to: row },
        column: selectedColumns ?? { from: column, to: column },
      };
      if (!selectedRows && !selectedColumns && view.state.field(markdownTableSelectionField, false)) {
        view.dispatch({ effects: setMarkdownTableSelection.of(null) });
      }
      root.querySelector('.z-live-preview-table-context-menu')?.remove();
      const menu = document.createElement('div');
      menu.className = 'z-live-preview-table-context-menu';
      menu.setAttribute('role', 'menu');
      menu.style.left = `${event.clientX}px`;
      menu.style.top = `${event.clientY}px`;
      const actions = [
        ['add-row', 'Add row'],
        ['add-column', 'Add column'],
        ['move-row-up', 'Move row up'],
        ['move-row-down', 'Move row down'],
        ['move-column-left', 'Move column left'],
        ['move-column-right', 'Move column right'],
        ['duplicate-row', 'Duplicate row'],
        ['duplicate-column', 'Duplicate column'],
        ['delete-row', 'Delete row'],
        ['delete-column', 'Delete column'],
      ] as const;
      let removeOnOutsideMouseDown: ((mouseDownEvent: MouseEvent) => void) | null = null;
      for (const [action, label] of actions) {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.dataset.tableContextAction = action;
        item.textContent = label;
        item.addEventListener('click', () => {
          const table = currentTable(view, this.table);
          const source = table ? tableContextMenuAction(table, contextTarget, action) : null;
          menu.remove();
          if (removeOnOutsideMouseDown) document.removeEventListener('mousedown', removeOnOutsideMouseDown);
          if (table && source) replaceTable(view, table, source);
        });
        menu.append(item);
      }
      root.append(menu);
      queueMicrotask(() => {
        removeOnOutsideMouseDown = (mouseDownEvent: MouseEvent) => {
          const mouseDownTarget = mouseDownEvent.target instanceof Node ? mouseDownEvent.target : null;
          if (mouseDownTarget && menu.contains(mouseDownTarget)) return;
          menu.remove();
          if (removeOnOutsideMouseDown) document.removeEventListener('mousedown', removeOnOutsideMouseDown);
        };
        document.addEventListener('mousedown', removeOnOutsideMouseDown);
      });
    });

    return root;
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'blur';
  }
}

export const markdownTableLivePreviewRenderer: InternalLivePreviewRenderer = {
  id: 'markdown-table-widget',
  match: ({ state, visibleFrom, visibleTo }): readonly InternalLivePreviewRange[] =>
    collectMarkdownTables(state as EditorState, visibleFrom, visibleTo).map((table) => ({
      rendererId: 'markdown-table-widget',
      from: table.from,
      to: table.to,
      activationFrom: table.from,
      activationTo: table.to,
      revealPolicy: 'never',
      className: tableWidgetClassName,
      kind: 'widget',
      widget: new MarkdownTableWidget(table, state.doc.sliceString(table.from, table.to)),
      sourceFrom: table.from,
      sourceTo: table.to,
      atomic: 'none',
      priority: 50,
    })),
};
