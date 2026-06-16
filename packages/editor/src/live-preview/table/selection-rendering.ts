import type { MarkdownTableSelection } from './state.js';

export const markdownTableWidgetSelector = '[data-live-preview-renderer="markdown-table-widget"]';

export function renderMarkdownTableSelection(root: HTMLElement, selection: MarkdownTableSelection | null): void {
  root.querySelectorAll('.z-live-preview-table-handle--selected').forEach((element) => {
    element.classList.remove('z-live-preview-table-handle--selected');
  });
  root.querySelectorAll<HTMLElement>('.z-live-preview-table-cell-box--selected').forEach((element) => {
    element.classList.remove('z-live-preview-table-cell-box--selected');
    element.classList.remove(
      'z-live-preview-table-cell-box--selection-top',
      'z-live-preview-table-cell-box--selection-right',
      'z-live-preview-table-cell-box--selection-bottom',
      'z-live-preview-table-cell-box--selection-left',
    );
    delete element.dataset.selectedRow;
    delete element.dataset.selectedColumn;
    delete element.dataset.selectedEdgeTop;
    delete element.dataset.selectedEdgeRight;
    delete element.dataset.selectedEdgeBottom;
    delete element.dataset.selectedEdgeLeft;
  });

  if (!selection || root.dataset.tableFrom !== String(selection.tableFrom)) return;

  const { kind } = selection;
  root.querySelectorAll(`[data-${kind}].z-live-preview-table-handle`).forEach((element) => {
    const value = Number((element as HTMLElement).dataset[kind]);
    if (value >= selection.from && value <= selection.to)
      element.classList.add('z-live-preview-table-handle--selected');
  });
  const selectedCells = Array.from(
    root.querySelectorAll<HTMLElement>(`.z-live-preview-table-cell-box[data-${kind}]`),
  ).filter((element) => {
    const value = Number(element.dataset[kind]);
    return value >= selection.from && value <= selection.to;
  });
  const selectedRows = selectedCells.map((element) => Number(element.dataset.row));
  const selectedColumns = selectedCells.map((element) => Number(element.dataset.column));
  const top = Math.min(...selectedRows);
  const right = Math.max(...selectedColumns);
  const bottom = Math.max(...selectedRows);
  const left = Math.min(...selectedColumns);

  selectedCells.forEach((element) => {
    const value = Number(element.dataset[kind]);
    if (value < selection.from || value > selection.to) return;
    element.classList.add('z-live-preview-table-cell-box--selected');
    if (kind === 'row') element.dataset.selectedRow = 'true';
    if (kind === 'column') element.dataset.selectedColumn = 'true';
    const row = Number(element.dataset.row);
    const column = Number(element.dataset.column);
    if (row === top) {
      element.classList.add('z-live-preview-table-cell-box--selection-top');
      element.dataset.selectedEdgeTop = 'true';
    }
    if (column === right) {
      element.classList.add('z-live-preview-table-cell-box--selection-right');
      element.dataset.selectedEdgeRight = 'true';
    }
    if (row === bottom) {
      element.classList.add('z-live-preview-table-cell-box--selection-bottom');
      element.dataset.selectedEdgeBottom = 'true';
    }
    if (column === left) {
      element.classList.add('z-live-preview-table-cell-box--selection-left');
      element.dataset.selectedEdgeLeft = 'true';
    }
  });
}
