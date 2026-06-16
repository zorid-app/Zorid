// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createMountedMarkdownEditor } from '../packages/editor/src/index';
import { collectLivePreviewWidgetRangesForVisibleRanges } from '../packages/editor/src/live-preview/extension';
import { zoridMarkdown } from '../packages/editor/src/live-preview/markdown-language';
import { defaultLivePreviewWidgetRenderers } from '../packages/editor/src/live-preview/renderers';
import {
  addMarkdownTableColumn,
  addMarkdownTableRow,
  collectMarkdownTables,
  deleteMarkdownTableColumns,
  deleteMarkdownTableRows,
  replaceMarkdownTableCell,
} from '../packages/editor/src/live-preview/table/model';
import { setMarkdownTableSelection } from '../packages/editor/src/live-preview/table/state';

function tableState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [zoridMarkdown()] });
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function expectNoTableSelectionMarkers(parent: HTMLElement): void {
  expect(parent.querySelectorAll('.z-live-preview-table-handle--selected')).toHaveLength(0);
  expect(parent.querySelectorAll('.z-live-preview-table-cell-box--selected')).toHaveLength(0);
  expect(parent.querySelectorAll('[data-live-preview-table-cell-box][data-selected-row="true"]')).toHaveLength(0);
  expect(parent.querySelectorAll('[data-live-preview-table-cell-box][data-selected-column="true"]')).toHaveLength(0);
}

describe('Markdown table live preview', () => {
  it('discovers GFM table models through the Lezer syntax tree', () => {
    const doc = ['intro', '', '| A | B |', '| - | - |', '| 1 | 2 |', '', 'tail'].join('\n');
    const tables = collectMarkdownTables(tableState(doc), 0, doc.length);

    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ columnCount: 2 });
    expect(tables[0]?.header.cells.map((cell) => cell.value)).toEqual(['A', 'B']);
    expect(tables[0]?.rows[0]?.cells.map((cell) => cell.value)).toEqual(['1', '2']);
  });

  it('does not recognize pipe-looking paragraphs without a Lezer table node', () => {
    const doc = ['| A | B |', 'not a delimiter', '| 1 | 2 |'].join('\n');

    expect(collectMarkdownTables(tableState(doc), 0, doc.length)).toEqual([]);
  });

  it('serializes canonical source edits for cells, rows, columns, and delete guards', () => {
    const doc = ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n');
    const table = collectMarkdownTables(tableState(doc), 0, doc.length)[0]!;

    expect(replaceMarkdownTableCell(table, 1, 1, 'two\nlines')).toBe(
      ['| A | B |', '| --- | --- |', '| 1 | two<br>lines |'].join('\n'),
    );
    expect(addMarkdownTableRow(table, 2)).toBe(['| A | B |', '| --- | --- |', '| 1 | 2 |', '|  |  |'].join('\n'));
    expect(addMarkdownTableColumn(table, 1)).toBe(['| A |  | B |', '| --- | --- | --- |', '| 1 |  | 2 |'].join('\n'));
    expect(deleteMarkdownTableRows(table, 1, 1)).toBe(['| A | B |', '| --- | --- |'].join('\n'));
    expect(deleteMarkdownTableRows(table, 0, 0)).toBeNull();
    expect(deleteMarkdownTableColumns(table, 0, 1)).toBeNull();
  });

  it('discovers canonical blank table rows and cells as editable cells', () => {
    const doc = ['| A | B |', '| - | - |', '|  |  |'].join('\n');
    const table = collectMarkdownTables(tableState(doc), 0, doc.length)[0]!;

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.cells.map((cell) => cell.value)).toEqual(['', '']);
    expect(table.rows[0]?.cells).toHaveLength(2);
  });

  it('collects only visible-window table widgets for long documents', () => {
    const doc = [
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      ...Array.from({ length: 600 }, (_, index) => `filler ${index}`),
      '| C | D |',
      '| - | - |',
      '| 3 | 4 |',
    ].join('\n');
    const state = tableState(doc);
    const first = doc.indexOf('1');

    const ranges = collectLivePreviewWidgetRangesForVisibleRanges(
      defaultLivePreviewWidgetRenderers,
      state,
      [{ from: first, to: first + 1 }],
      false,
    );

    expect(ranges.map((range) => [range.rendererId, state.doc.sliceString(range.from, range.to)])).toEqual([
      ['markdown-table-widget', ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n')],
    ]);
  });

  it('does not expose an editable partial model for tables beyond the row cap', () => {
    const doc = [
      '| A | B |',
      '| - | - |',
      ...Array.from({ length: 251 }, (_, index) => `| ${index} | ${index} |`),
    ].join('\n');
    const state = tableState(doc);
    const deepRow = doc.indexOf('| 250 |');

    expect(collectMarkdownTables(state, 0, doc.length)).toEqual([]);
    expect(
      collectLivePreviewWidgetRangesForVisibleRanges(
        defaultLivePreviewWidgetRenderers,
        state,
        [{ from: deepRow, to: deepRow + 1 }],
        false,
      ),
    ).toEqual([]);
  });

  it('mounts an editable first-party table widget and edits source through CodeMirror transactions', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'),
    });
    const cell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="1"]',
    );

    expect(parent.querySelector('.z-live-preview-table-widget')).toBeTruthy();
    expect(cell).toBeTruthy();
    cell!.value = 'updated';
    cell!.dispatchEvent(new Event('input', { bubbles: true }));

    expect(editor.getText()).toBe(['| A | B |', '| --- | --- |', '| 1 | updated |'].join('\n'));

    editor.destroy();
    parent.remove();
  });

  it('renders subtle accessible edge add controls without visible row or column labels', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'),
    });
    const addRow = parent.querySelector<HTMLButtonElement>('.z-live-preview-table-plus--row');
    const addColumn = parent.querySelector<HTMLButtonElement>('.z-live-preview-table-plus--column');

    expect(addRow?.textContent).toBe('');
    expect(addColumn?.textContent).toBe('');
    expect(addRow?.getAttribute('aria-label')).toBe('Add row');
    expect(addColumn?.getAttribute('aria-label')).toBe('Add column');
    expect(addRow?.title).toBe('Add row');
    expect(addColumn?.title).toBe('Add column');
    expect(parent.textContent).not.toContain('+ row');
    expect(parent.textContent).not.toContain('+ column');

    editor.destroy();
    parent.remove();
  });

  it('renders accessible dot handles without visible row numbers, header labels, or column arrows', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'),
    });
    const rowHandles = parent.querySelectorAll<HTMLElement>('.z-live-preview-table-row-handle');
    const columnHandles = parent.querySelectorAll<HTMLButtonElement>('.z-live-preview-table-column-handle');

    expect(rowHandles).toHaveLength(2);
    expect(columnHandles).toHaveLength(2);
    expect(rowHandles[0]?.textContent).toBe('');
    expect(rowHandles[1]?.textContent).toBe('');
    expect(columnHandles[0]?.textContent).toBe('');
    expect(parent.textContent).not.toContain('H');
    expect(parent.textContent).not.toContain('▾');
    expect(rowHandles[0]?.querySelectorAll('.z-live-preview-table-handle-dots span')).toHaveLength(6);
    expect(columnHandles[0]?.querySelectorAll('.z-live-preview-table-handle-dots span')).toHaveLength(6);
    expect(rowHandles[1]?.getAttribute('aria-label')).toBe('Select row 1');
    expect(columnHandles[1]?.getAttribute('aria-label')).toBe('Select column 2');
    expect(rowHandles[1]?.title).toBe('Select row 1');
    expect(columnHandles[1]?.title).toBe('Select column 2');

    editor.destroy();
    parent.remove();
  });

  it('selects row and column cell boxes from handles without applying selected styling to textareas', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B | C |', '| - | - | - |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |'].join('\n'),
    });
    const firstRowHandle = parent.querySelector<HTMLElement>('[data-row="1"].z-live-preview-table-row-handle');
    const lastRowHandle = parent.querySelector<HTMLElement>('[data-row="2"].z-live-preview-table-row-handle');
    const columnHandle = parent.querySelector<HTMLElement>('[data-column="1"].z-live-preview-table-column-handle');

    firstRowHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    lastRowHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true }));

    expect(parent.querySelectorAll('[data-live-preview-table-cell-box][data-selected-row="true"]')).toHaveLength(6);
    expect(
      parent
        .querySelector('[data-live-preview-table-cell-box][data-row="1"][data-column="0"]')
        ?.classList.contains('z-live-preview-table-cell-box--selected'),
    ).toBe(true);
    expect(
      parent
        .querySelector('[data-live-preview-table-cell][data-row="1"][data-column="0"]')
        ?.classList.contains('z-live-preview-table-cell-box--selected'),
    ).toBe(false);

    columnHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(parent.querySelectorAll('[data-live-preview-table-cell-box][data-selected-row="true"]')).toHaveLength(0);
    expect(parent.querySelectorAll('[data-live-preview-table-cell-box][data-selected-column="true"]')).toHaveLength(3);
    expect(
      parent
        .querySelector('[data-live-preview-table-cell-box][data-row="0"][data-column="1"]')
        ?.classList.contains('z-live-preview-table-cell-box--selected'),
    ).toBe(true);
    expect(
      parent
        .querySelector('[data-live-preview-table-cell][data-row="0"][data-column="1"]')
        ?.classList.contains('z-live-preview-table-cell-box--selected'),
    ).toBe(false);

    editor.destroy();
    parent.remove();
  });

  it('clears selected row and column cell-box markers when cell focus or state clearing removes table selection', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B | C |', '| - | - | - |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |'].join('\n'),
    });
    const firstRowHandle = parent.querySelector<HTMLElement>('[data-row="1"].z-live-preview-table-row-handle');
    const lastRowHandle = parent.querySelector<HTMLElement>('[data-row="2"].z-live-preview-table-row-handle');
    const columnHandle = parent.querySelector<HTMLElement>('[data-column="1"].z-live-preview-table-column-handle');
    const focusedCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="0"]',
    );
    const clickedCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="2"][data-column="2"]',
    );

    firstRowHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    lastRowHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true }));
    expect(parent.querySelectorAll('[data-live-preview-table-cell-box][data-selected-row="true"]')).toHaveLength(6);

    focusedCell!.focus();
    expectNoTableSelectionMarkers(parent);

    columnHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(parent.querySelectorAll('[data-live-preview-table-cell-box][data-selected-column="true"]')).toHaveLength(3);

    clickedCell!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    clickedCell!.focus();
    expectNoTableSelectionMarkers(parent);

    columnHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(parent.querySelectorAll('[data-live-preview-table-cell-box][data-selected-column="true"]')).toHaveLength(3);

    editor.view.dispatch({ effects: setMarkdownTableSelection.of(null) });
    expectNoTableSelectionMarkers(parent);

    editor.destroy();
    parent.remove();
  });

  it('adds a bottom-row blank row that remains rendered and editable', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'),
    });

    parent.querySelector<HTMLButtonElement>('.z-live-preview-table-plus--row')!.click();
    const blankCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="2"][data-column="0"]',
    );

    expect(editor.getText()).toBe(['| A | B |', '| --- | --- |', '| 1 | 2 |', '|  |  |'].join('\n'));
    expect(blankCell).toBeTruthy();
    expect(blankCell?.value).toBe('');
    blankCell!.value = 'new';
    blankCell!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor.getText()).toBe(['| A | B |', '| --- | --- |', '| 1 | 2 |', '| new |  |'].join('\n'));

    editor.destroy();
    parent.remove();
  });

  it('adds a right-edge blank column that remains rendered and editable', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'),
    });

    parent.querySelector<HTMLButtonElement>('.z-live-preview-table-plus--column')!.click();
    const blankCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="2"]',
    );

    expect(editor.getText()).toBe(['| A | B |  |', '| --- | --- | --- |', '| 1 | 2 |  |'].join('\n'));
    expect(blankCell).toBeTruthy();
    expect(blankCell?.value).toBe('');
    blankCell!.value = 'new';
    blankCell!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor.getText()).toBe(['| A | B |  |', '| --- | --- | --- |', '| 1 | 2 | new |'].join('\n'));

    editor.destroy();
    parent.remove();
  });

  it('disables browser resizing for live-preview table cells', () => {
    const styles = readFileSync('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(/\.z-live-preview-table-cell\s*\{[^}]*resize:\s*none;/s);
  });

  it('keeps table overflow horizontal on the widget wrapper', () => {
    const styles = readFileSync('apps/desktop/src/renderer/src/styles.css', 'utf8');

    expect(styles).toMatch(/\.z-live-preview-table-widget\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(styles).toMatch(/\.z-live-preview-table-grid\s*\{[^}]*width:\s*max-content;/s);
  });

  it('refreshes mounted widget DOM after same-bounds table source changes', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'),
    });
    const source = editor.getText();
    const replacementFrom = source.indexOf('| 1 | 2 |');
    const beforeCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="0"]',
    );

    expect(beforeCell?.value).toBe('1');
    editor.view.dispatch({ changes: { from: replacementFrom + 2, to: replacementFrom + 3, insert: '9' } });

    const afterCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="0"]',
    );
    expect(editor.getText()).toBe(['| A | B |', '| - | - |', '| 9 | 2 |'].join('\n'));
    expect(afterCell).not.toBe(beforeCell);
    expect(afterCell?.value).toBe('9');

    editor.destroy();
    parent.remove();
  });

  it('keeps focus and caret on the refreshed table cell so sequential typing appends', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'),
    });
    const firstCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="1"]',
    );

    firstCell!.focus();
    firstCell!.value = 'u';
    firstCell!.setSelectionRange(1, 1);
    firstCell!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();

    const refreshedCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="1"]',
    );
    expect(refreshedCell).not.toBe(firstCell);
    expect(document.activeElement).toBe(refreshedCell);
    expect(refreshedCell!.selectionStart).toBe(1);
    expect(refreshedCell!.selectionEnd).toBe(1);

    refreshedCell!.value = `${refreshedCell!.value.slice(0, refreshedCell!.selectionStart)}p${refreshedCell!.value.slice(
      refreshedCell!.selectionEnd,
    )}`;
    refreshedCell!.setSelectionRange(2, 2);
    refreshedCell!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();

    const secondRefreshedCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="1"]',
    );
    expect(document.activeElement).toBe(secondRefreshedCell);
    expect(secondRefreshedCell!.selectionStart).toBe(2);
    expect(secondRefreshedCell!.selectionEnd).toBe(2);
    expect(editor.getText()).toBe(['| A | B |', '| --- | --- |', '| 1 | up |'].join('\n'));

    editor.destroy();
    parent.remove();
  });

  it('opens a row/column context menu that applies structural actions through transactions', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'),
    });
    const cell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="1"]',
    );

    cell!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 20 }));
    const duplicateColumn = parent.querySelector<HTMLButtonElement>('[data-table-context-action="duplicate-column"]');
    expect(duplicateColumn).toBeTruthy();
    duplicateColumn!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    duplicateColumn!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    duplicateColumn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editor.getText()).toBe(['| A | B | B |', '| --- | --- | --- |', '| 1 | 2 | 2 |'].join('\n'));

    editor.destroy();
    parent.remove();
  });

  it('applies row context-menu actions to the active contiguous row selection', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'].join('\n'),
    });
    const firstRowHandle = parent.querySelector<HTMLElement>('[data-row="1"].z-live-preview-table-row-handle');
    const lastRowHandle = parent.querySelector<HTMLElement>('[data-row="3"].z-live-preview-table-row-handle');
    const selectedCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="2"][data-column="0"]',
    );

    firstRowHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    lastRowHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true }));
    selectedCell!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 20 }));
    parent.querySelector<HTMLButtonElement>('[data-table-context-action="duplicate-row"]')!.click();

    expect(editor.getText()).toBe(
      ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'].join(
        '\n',
      ),
    );

    editor.destroy();
    parent.remove();
  });

  it('applies column context-menu actions to the active contiguous column selection', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createMountedMarkdownEditor({
      parent,
      text: ['| A | B | C | D |', '| - | - | - | - |', '| 1 | 2 | 3 | 4 |'].join('\n'),
    });
    const firstColumnHandle = parent.querySelector<HTMLElement>('[data-column="1"].z-live-preview-table-column-handle');
    const lastColumnHandle = parent.querySelector<HTMLElement>('[data-column="2"].z-live-preview-table-column-handle');
    const selectedCell = parent.querySelector<HTMLTextAreaElement>(
      '[data-live-preview-table-cell][data-row="1"][data-column="2"]',
    );

    firstColumnHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    lastColumnHandle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true }));
    selectedCell!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 20 }));
    parent.querySelector<HTMLButtonElement>('[data-table-context-action="delete-column"]')!.click();

    expect(editor.getText()).toBe(['| A | D |', '| --- | --- |', '| 1 | 4 |'].join('\n'));

    editor.destroy();
    parent.remove();
  });
});
