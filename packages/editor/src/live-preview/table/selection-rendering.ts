import type { MarkdownTableSelection } from './state.js';

export const markdownTableWidgetSelector = '[data-live-preview-renderer="markdown-table-widget"]';

export function renderMarkdownTableSelection(root: HTMLElement, selection: MarkdownTableSelection | null): void {
  root.querySelectorAll('.z-live-preview-table-handle--selected').forEach((element) => {
    element.classList.remove('z-live-preview-table-handle--selected');
  });
  root.querySelectorAll<HTMLElement>('.z-live-preview-table-cell-box--selected').forEach((element) => {
    element.classList.remove('z-live-preview-table-cell-box--selected');
    delete element.dataset.selectedRow;
    delete element.dataset.selectedColumn;
  });

  if (!selection || root.dataset.tableFrom !== String(selection.tableFrom)) return;

  const { kind } = selection;
  root.querySelectorAll(`[data-${kind}].z-live-preview-table-handle`).forEach((element) => {
    const value = Number((element as HTMLElement).dataset[kind]);
    if (value >= selection.from && value <= selection.to)
      element.classList.add('z-live-preview-table-handle--selected');
  });
  root.querySelectorAll<HTMLElement>(`.z-live-preview-table-cell-box[data-${kind}]`).forEach((element) => {
    const value = Number(element.dataset[kind]);
    if (value < selection.from || value > selection.to) return;
    element.classList.add('z-live-preview-table-cell-box--selected');
    if (kind === 'row') element.dataset.selectedRow = 'true';
    if (kind === 'column') element.dataset.selectedColumn = 'true';
  });
}
