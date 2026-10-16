import { Annotation, Compartment, EditorSelection, EditorState, Prec, StateField, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, insertNewline, isolateHistory, redo, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { inline } from '../ui/markdown.ts';
import { liveInlineMarkdown } from './live-inline.ts';
import { alignTableCells, clearTableCells, copyTableCells, deleteTableCells, parseTableClipboard, pasteTableCells, serializeTableClipboard, tableCellRange, decodeTableCellText, deleteTableColumn, deleteTableRow, duplicateTableColumn, duplicateTableRow,
  encodeTableCellText, insertTableColumn, insertTableRow, moveTableColumn, moveTableRow, padTableCellBoundary, parseTable,
  setTableColumnAlignment, sortTableRows } from './table-model.ts';
import type { MarkdownTable, TableEdit, TableCellPosition, TableCellRange } from './table-model.ts';

const cellSync = Annotation.define<boolean>();
const controllers = new WeakMap<HTMLElement, TableController>();

/** One child editor at a time. All text changes and history belong to the note. */
class TableController {
  readonly dom = document.createElement('div');
  private grid = document.createElement('table');
  private cells: HTMLElement[][] = [];
  private active: { row: number; column: number; view: EditorView; from: number; to: number; insertion?: { readonly prefix: string; readonly suffix: string } } | null = null;
  private syncing = false;
  private destroyed = false;
  private editorRetainers = 0;
  private selected: { anchor: TableCellPosition; head: TableCellPosition } | null = null;
  private stopGesture: (() => void) | null = null;
  private readOnly = new Compartment();
  readonly owner: EditorView;
  model: MarkdownTable;
  private open: (target: string) => void;
  private cellExtensions: Extension;
  readonly identity: object;

  constructor(owner: EditorView, model: MarkdownTable, open: (target: string) => void, identity: object, cellExtensions: Extension) {
    this.owner = owner; this.model = model; this.open = open; this.identity = identity;
    this.cellExtensions = cellExtensions;
    this.dom.className = 'cm-live-table';
    this.dom.contentEditable = 'false';
    const wrapper = document.createElement('div'); wrapper.className = 'cm-table-wrapper';
    wrapper.append(this.grid);
    const add = (kind: 'row' | 'column', label: string) => {
      const button = document.createElement('button'); button.type = 'button';
      button.className = `cm-table-add cm-table-add-${kind}`;
      button.textContent = '+'; button.title = label; button.setAttribute('aria-label', label);
      button.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (kind === 'row') this.addRow(this.model.rows.length, 0);
        else this.addColumn(0, this.model.columnCount);
      });
      wrapper.append(button);
    };
    add('row', 'Add row below'); add('column', 'Add column to the right');
    this.dom.append(wrapper);
    controllers.set(this.dom, this);
    this.render();
    this.dom.addEventListener('focusout', () => queueMicrotask(() => this.closeIfUnfocused()));
    this.dom.addEventListener('contextmenu', event => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>('th[data-row],td[data-row]');
      if (!cell || (event.target as HTMLElement).closest('.cm-table-grip')) return;
      const row = Number(cell.dataset.row), column = Number(cell.dataset.column);
      if (this.selected && !this.includesCell(row, column)) { this.deselectCells(); this.activate(row, column); }
    });
    for (const type of ['copy', 'cut', 'paste']) this.dom.addEventListener(type, event => this.clipboard(event as ClipboardEvent), true);
  }

  /** Structural edits share the note's history and reacquire the rebuilt widget. */
  private applyStructure(change: TableEdit, row: number, column: number, preserveSelection = false): boolean {
    if (this.destroyed || this.owner.state.readOnly) return false;
    this.deselectCells();
    const from = this.model.from;
    const source = this.model.source.slice(0, change.from - from) + change.insert + this.model.source.slice(change.to - from);
    const next = parseTable(source, from);
    if (!next && source) return false;
    let anchor = 0, head = 0;
    if (preserveSelection) {
      const previous = this.model.rows[row]?.cells[column], range = this.owner.state.selection.main;
      if (previous && range.from >= previous.rawFrom && range.to <= previous.rawTo) {
        const decoded = decodeTableCellText(previous.text);
        anchor = decoded.fromSource(Math.max(0, Math.min(previous.text.length, range.anchor - previous.from)));
        head = decoded.fromSource(Math.max(0, Math.min(previous.text.length, range.head - previous.from)));
      }
    }
    row = next ? Math.max(0, Math.min(row, next.rows.length - 1)) : 0;
    column = next ? Math.max(0, Math.min(column, next.columnCount - 1)) : 0;
    const cell = next?.rows[row]?.cells[column], decoded = cell ? decodeTableCellText(cell.text) : null;
    const position = (offset: number) => cell && decoded ? cell.from + decoded.toSource(Math.min(offset, decoded.text.length)) : from;
    this.close();
    this.owner.dispatch({ changes: change, selection: EditorSelection.single(position(anchor), position(head)),
      annotations: [cellSync.of(true), Transaction.userEvent.of('input'), isolateHistory.of('full')] });
    if (!next) { this.owner.focus(); return true; }
    // Replacing the full table may replace its controller. Never activate the
    // old instance after dispatch or rely on its former DOM positions.
    for (const node of this.owner.dom.querySelectorAll<HTMLElement>('.cm-live-table')) {
      const controller = controllers.get(node);
      if (controller?.model.from === from) {
        controller.activate(row, column, false, anchor);
        if (anchor !== head && controller.active) {
          controller.active.view.dispatch({ selection: EditorSelection.single(anchor, head) });
        }
        break;
      }
    }
    return true;
  }

  addRow(index: number, column: number): boolean {
    if (this.destroyed || this.owner.state.readOnly) return false;
    return this.applyStructure(insertTableRow(this.model, index), index, column);
  }

  addColumn(row: number, index: number, inheritFrom?: number): boolean {
    if (this.destroyed || this.owner.state.readOnly) return false;
    return this.applyStructure(insertTableColumn(this.model, index, [], inheritFrom === undefined ? null : this.model.alignments[inheritFrom]), row, index);
  }

  runAction(id: TableAction['id'], row: number, column: number): boolean {
    if (this.destroyed || this.owner.state.readOnly) return false;
    const model = this.model;
    switch (id) {
      case 'clear-cells': return this.clearSelection();
      case 'delete-cells': return this.deleteSelection(-1);
      case 'row-before': return this.addRow(row, column);
      case 'row-after': return this.addRow(row + 1, column);
      case 'row-up': return this.applyStructure(moveTableRow(model, row, row - 1), row - 1, column);
      case 'row-down': return this.applyStructure(moveTableRow(model, row, row + 1), row + 1, column);
      case 'row-duplicate': return this.applyStructure(duplicateTableRow(model, row), row + 1, column);
      case 'row-delete': return this.applyStructure(deleteTableRow(model, row), row - 1, column);
      case 'column-before': return this.addColumn(row, column, column);
      case 'column-after': return this.addColumn(row, column + 1, column);
      case 'column-left': return this.applyStructure(moveTableColumn(model, column, column - 1), row, column - 1);
      case 'column-right': return this.applyStructure(moveTableColumn(model, column, column + 1), row, column + 1);
      case 'column-duplicate': return this.applyStructure(duplicateTableColumn(model, column), row, column + 1);
      case 'column-delete': return this.applyStructure(deleteTableColumn(model, column), row, column - 1);
      case 'align-left': case 'align-center': case 'align-right': {
        const rtl = this.dom.ownerDocument.defaultView?.getComputedStyle(this.grid).direction === 'rtl';
        const alignment = id === 'align-center' ? 'center' : (id === 'align-left') !== rtl ? 'left' : 'right';
        return this.applyStructure(setTableColumnAlignment(model, column, alignment), row, column, true);
      }
      case 'sort-ascending': case 'sort-descending': {
        const values = model.rows.map((data, index) => {
          // A currently edited cell contains a CM view rather than rendered
          // Markdown. Render its source independently to use the visible label.
          let node = this.cells[index][column];
          if (this.active?.row === index && this.active.column === column) {
            node = this.dom.ownerDocument.createElement('span');
            inline(node, decodeTableCellText(data.cells[column].text).text, this.open);
          }
          return node.innerText ?? node.textContent ?? '';
        });
        return this.applyStructure(sortTableRows(model, column, id === 'sort-ascending' ? 'ascending' : 'descending', values), row, column);
      }
    }
  }

  get selectionRange(): TableCellRange | null { return this.selected ? tableCellRange(this.model, this.selected.anchor, this.selected.head) : null; }
  includesCell(row: number, column: number) {
    const range = this.selectionRange;
    return !!range && row >= range.top && row <= range.bottom && column >= range.left && column <= range.right;
  }
  deselectCells() {
    if (!this.selected) return;
    this.selected = null; this.paintSelection(); this.syncReadOnly();
  }
  selectCells(anchor: TableCellPosition, head: TableCellPosition, wholeAxis = false) {
    if (this.destroyed) return;
    tableCellRange(this.model, anchor, head);
    if (!this.active) this.activate(anchor.row, anchor.column);
    this.selected = wholeAxis || anchor.row !== head.row || anchor.column !== head.column ? { anchor: { ...anchor }, head: { ...head } } : null;
    this.paintSelection(); this.syncReadOnly();
    this.active?.view.focus();
  }
  private paintSelection() {
    this.dom.classList.toggle('has-selection', !!this.selected);
    const range = this.selectionRange;
    this.cells.forEach((row, r) => row.forEach((cell, c) => {
      const selected = !!range && r >= range.top && r <= range.bottom && c >= range.left && c <= range.right;
      cell.classList.toggle('is-selected', selected);
      cell.setAttribute('aria-selected', String(selected));
      for (const [name, edge] of [['top', r === range?.top], ['bottom', r === range?.bottom], ['start', c === range?.left], ['end', c === range?.right]] as const) cell.classList.toggle(`selection-${name}`, selected && edge);
    }));
  }
  private extendSelection(view: EditorView, rowDelta: number, columnDelta: number): boolean {
    if (!this.active || !view.state.selection.main.empty && !this.selected) return false;
    if (!this.selected) {
      const range = view.state.selection.main;
      if (columnDelta && range.head !== (columnDelta < 0 ? 0 : view.state.doc.length)) return false;
      if (rowDelta && view.moveToLineBoundary(range, rowDelta > 0, true).head !== (rowDelta < 0 ? 0 : view.state.doc.length)) return false;
    }
    const anchor = this.selected?.anchor ?? { row: this.active.row, column: this.active.column };
    const previous = this.selected?.head ?? anchor;
    const head = { row: Math.max(0, Math.min(this.model.rows.length - 1, previous.row + rowDelta)), column: Math.max(0, Math.min(this.model.columnCount - 1, previous.column + columnDelta)) };
    this.selectCells(anchor, head);
    this.cells[head.row][head.column].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    return true;
  }
  private collapseSelection(direction: -1 | 1): boolean {
    const range = this.selectionRange; if (!range) return false;
    const row = direction < 0 ? range.top : range.bottom, column = direction < 0 ? range.left : range.right;
    this.activate(row, column, false, direction < 0 ? 0 : decodeTableCellText(this.model.rows[row].cells[column].text).text.length);
    return true;
  }
  private currentController(from = this.model.from): TableController | undefined {
    for (const node of this.owner.dom.querySelectorAll<HTMLElement>('.cm-live-table')) {
      const controller = controllers.get(node); if (controller?.model.from === from) return controller;
    }
  }
  clearSelection(): boolean {
    const range = this.selectionRange;
    return !!range && this.applyStructure(clearTableCells(this.model, range), range.top, range.left);
  }
  deleteSelection(direction: -1 | 1): boolean {
    const range = this.selectionRange; if (!range) return false;
    if (this.owner.state.readOnly) return true;
    const head = this.selected!.head, edit = deleteTableCells(this.model, range);
    const fullWidth = range.left === 0 && range.right === this.model.columnCount - 1;
    const fullHeight = range.top === 0 && range.bottom === this.model.rows.length - 1;
    if (fullWidth && !fullHeight && (range.top === 0 || range.bottom === this.model.rows.length - 1)) {
      const top = range.top === 0, insert = top ? '\n' + edit.insert : edit.insert + '\n';
      this.deselectCells(); this.close();
      this.owner.dispatch({ changes: { ...edit, insert }, selection: { anchor: top ? edit.from : edit.from + insert.length },
        annotations: [cellSync.of(true), Transaction.userEvent.of('delete'), isolateHistory.of('full')] });
      this.owner.focus(); return true;
    }
    const row = fullWidth ? range.top + (direction < 0 ? -1 : 0) : fullHeight ? head.row : direction < 0 ? range.top : range.bottom;
    const column = fullHeight && !fullWidth ? range.left + (direction < 0 ? -1 : 0) : fullWidth ? head.column : direction < 0 ? range.left : range.right;
    return this.applyStructure(edit, row, column);
  }
  alignSelection(alignment: 'left' | 'center' | 'right'): boolean {
    const range = this.selectionRange, selected = this.selected;
    if (!range || !selected || this.owner.state.readOnly) return false;
    const from = this.model.from;
    if (!this.applyStructure(alignTableCells(this.model, range, alignment), selected.anchor.row, selected.anchor.column)) return false;
    this.currentController(from)?.selectCells(selected.anchor, selected.head, true);
    return true;
  }
  clipboard(event: ClipboardEvent): boolean {
    if (event.defaultPrevented || this.destroyed || !event.clipboardData) return false;
    const node = event.target as Node | null;
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
    const editorRoot = element?.closest<HTMLElement>('.cm-editor');
    const editor = editorRoot ? EditorView.findFromDOM(editorRoot) : null;
    if (!element || !editor || editor !== this.active?.view || !editor.contentDOM.contains(element)) return false;
    for (let current: Element | null = element; current && current !== editor.contentDOM; current = current.parentElement) {
      if (current.matches('input, textarea, select, button, [contenteditable="false"]')) return false;
    }
    const range = this.selectionRange;
    if (event.type === 'paste') {
      if (this.owner.state.readOnly) return false;
      const data = parseTableClipboard(event.clipboardData.getData('obsidian/table'));
      if (!data || !this.active) return false;
      const start = range ? { row: range.top, column: range.left } : { row: this.active.row, column: this.active.column };
      event.preventDefault(); event.stopPropagation();
      let edit: TableEdit;
      try { edit = pasteTableCells(this.model, start, data); }
      catch (error) { if (error instanceof RangeError) return true; throw error; }
      return this.applyStructure(edit, start.row + data.rows.length - 1, start.column + data.alignment.length - 1);
    }
    if (!range || event.type !== 'copy' && event.type !== 'cut' || event.type === 'cut' && this.owner.state.readOnly) return false;
    const data = copyTableCells(this.model, range), markdown = serializeTableClipboard(data);
    const table = this.dom.ownerDocument.createElement('table');
    data.rows.forEach((row, r) => {
      const tr = table.insertRow(); row.forEach((value, c) => {
        const cell = this.dom.ownerDocument.createElement(r === 0 ? 'th' : 'td');
        cell.style.textAlign = data.alignment[c] ?? ''; inline(cell, decodeTableCellText(value).text, this.open); tr.append(cell);
      });
    });
    event.clipboardData.setData('text/plain', markdown); event.clipboardData.setData('text/markdown', markdown);
    event.clipboardData.setData('text/html', '<!-- obsidian -->' + table.outerHTML);
    event.clipboardData.setData('obsidian/table', JSON.stringify(data));
    event.preventDefault(); event.stopPropagation();
    if (event.type === 'cut') this.deleteSelection(-1);
    return true;
  }
  private decorateCell(row: number, column: number) {
    const cell = this.cells[row][column];
    const grip = (axis: 'row' | 'column') => {
      const node = this.dom.ownerDocument.createElement('span'); node.className = `cm-table-grip cm-table-grip-${axis}`;
      node.dataset.axis = axis; node.role = 'button'; node.tabIndex = -1;
      node.setAttribute('aria-label', `Select or move ${axis}`);
      node.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); this.startGrip(event, axis, axis === 'row' ? row : column);
      });
      cell.append(node);
    };
    if (row === 0) grip('column');
    if (column === 0) grip('row');
  }
  private nearestCell(event: MouseEvent): TableCellPosition {
    const direct = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('th[data-row],td[data-row]');
    if (direct && this.grid.contains(direct)) return { row: Number(direct.dataset.row), column: Number(direct.dataset.column) };
    let result = { row: 0, column: 0 }, distance = Infinity;
    this.cells.forEach((row, r) => row.forEach((cell, c) => {
      const rect = cell.getBoundingClientRect();
      const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right), dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom);
      const next = dx * dx + dy * dy; if (next < distance) { distance = next; result = { row: r, column: c }; }
    }));
    return result;
  }
  private trackGesture(move: (event: MouseEvent) => void, finish: (cancelled: boolean) => void) {
    this.stopGesture?.();
    const doc = this.dom.ownerDocument, win = doc.defaultView;
    let done = false;
    const stop = (cancelled: boolean) => {
      if (done) return; done = true;
      doc.removeEventListener('mousemove', moving, true); doc.removeEventListener('mouseup', up, true);
      doc.removeEventListener('pointercancel', cancel, true); win?.removeEventListener('blur', cancel);
      this.stopGesture = null; this.dom.classList.remove('mod-dragging');
      for (const cell of this.cells.flat()) cell.classList.remove('drop-before-row', 'drop-after-row', 'drop-before-column', 'drop-after-column');
      finish(cancelled);
    };
    const moving = (event: MouseEvent) => {
      event.preventDefault(); move(event);
      const scroll = this.owner.scrollDOM, rect = scroll.getBoundingClientRect();
      if (rect.height) scroll.scrollTop += event.clientY < rect.top + 20 ? -20 : event.clientY > rect.bottom - 20 ? 20 : 0;
      if (rect.width) scroll.scrollLeft += event.clientX < rect.left + 20 ? -20 : event.clientX > rect.right - 20 ? 20 : 0;
    };
    const up = () => stop(false), cancel = () => stop(true);
    this.stopGesture = cancel; this.dom.classList.add('mod-dragging');
    doc.addEventListener('mousemove', moving, true); doc.addEventListener('mouseup', up, true);
    doc.addEventListener('pointercancel', cancel, true); win?.addEventListener('blur', cancel);
  }
  private cellPointer(event: MouseEvent, row: number, column: number) {
    if (event.button === 2 && this.includesCell(row, column)) { event.preventDefault(); return; }
    if (event.button !== 0 || (event.target as HTMLElement).closest('a, button, input, .cm-table-grip')) return;
    const anchor = event.shiftKey && this.active ? { row: this.active.row, column: this.active.column } : { row, column };
    const sameActive = this.active?.row === row && this.active.column === column;
    if (event.shiftKey) { event.preventDefault(); this.selectCells(anchor, { row, column }); }
    else {
      this.deselectCells();
      if (!sameActive) {
        event.preventDefault(); this.activate(row, column);
        const view = this.active?.view, position = view?.posAtCoords({ x: event.clientX, y: event.clientY });
        if (view && position != null) view.dispatch({ selection: { anchor: position } });
      }
    }
    this.trackGesture(move => { this.selectCells(anchor, this.nearestCell(move)); }, () => { if (!this.destroyed) this.active?.view.focus(); });
  }
  private startGrip(event: MouseEvent, axis: 'row' | 'column', index: number) {
    this.activate(axis === 'row' ? index : 0, axis === 'column' ? index : 0);
    const selectAxis = (controller: TableController, at: number) => controller.selectCells(
      { row: axis === 'row' ? at : 0, column: axis === 'column' ? at : 0 },
      { row: axis === 'row' ? at : controller.model.rows.length - 1, column: axis === 'column' ? at : controller.model.columnCount - 1 }, true);
    selectAxis(this, index);
    let destination = index;
    const source = this.model.source;
    this.trackGesture(move => {
      if (this.owner.state.readOnly) return;
      const cell = this.nearestCell(move), target = axis === 'row' ? cell.row : cell.column;
      const rect = this.cells[cell.row][cell.column].getBoundingClientRect();
      const rtl = this.dom.ownerDocument.defaultView?.getComputedStyle(this.grid).direction === 'rtl';
      const after = axis === 'row' ? move.clientY > (rect.top + rect.bottom) / 2 : rtl ? move.clientX < (rect.left + rect.right) / 2 : move.clientX > (rect.left + rect.right) / 2;
      const boundary = target + (after ? 1 : 0); destination = boundary > index ? boundary - 1 : boundary;
      for (const node of this.cells.flat()) node.classList.remove(`drop-before-${axis}`, `drop-after-${axis}`);
      const nodes = axis === 'row' ? this.cells[target] : this.cells.map(row => row[target]);
      nodes.forEach(node => node.classList.add(`drop-${after ? 'after' : 'before'}-${axis}`));
    }, cancelled => {
      if (cancelled || this.destroyed || this.owner.state.readOnly || this.model.source !== source || destination === index) return;
      const from = this.model.from;
      const edit = axis === 'row' ? moveTableRow(this.model, index, destination) : moveTableColumn(this.model, index, destination);
      if (this.applyStructure(edit, axis === 'row' ? destination : 0, axis === 'column' ? destination : 0)) {
        const controller = this.currentController(from); if (controller) selectAxis(controller, destination);
      }
    });
  }

  private renderCell(row: number, column: number) {
    const node = this.cells[row][column];
    node.replaceChildren();
    node.classList.remove('is-editing');
    // Decode breaks/pipe escapes without ever interpreting arbitrary HTML.
    inline(node, decodeTableCellText(this.model.rows[row].cells[column].text).text, this.open);
    this.decorateCell(row, column);
  }

  private render() {
    this.grid.replaceChildren(); this.cells = [];
    const head = document.createElement('thead'), body = document.createElement('tbody');
    this.grid.append(head, body);
    this.model.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr'); this.cells.push([]);
      row.cells.forEach((_, column) => {
        const td = document.createElement(rowIndex === 0 ? 'th' : 'td');
        td.dataset.row = String(rowIndex); td.dataset.column = String(column);
        td.style.textAlign = this.model.alignments[column] ?? '';
        this.cells[rowIndex].push(td); tr.append(td); this.renderCell(rowIndex, column);
        td.addEventListener('mousedown', event => this.cellPointer(event, rowIndex, column));
        td.addEventListener('click', event => {
          if (event.detail === 4) { event.preventDefault(); this.selectCells({ row: 0, column: 0 }, { row: this.model.rows.length - 1, column: this.model.columnCount - 1 }, true); }
        });
      });
      (rowIndex === 0 ? head : body).append(tr);
    });
  }

  update(model: MarkdownTable) {
    if (model.source === this.model.source) {
      const shift = model.from - this.model.from;
      if (this.active) { this.active.from += shift; this.active.to += shift; }
      this.model = model;
      return;
    }
    const sameShape = model.rows.length === this.model.rows.length && model.columnCount === this.model.columnCount;
    const previous = this.model; this.model = model;
    if (!sameShape) {
      const selection = this.selected; this.close(); this.render();
      if (selection && model.rows[selection.anchor.row]?.cells[selection.anchor.column] && model.rows[selection.head.row]?.cells[selection.head.column]) this.selectCells(selection.anchor, selection.head, true);
      else this.deselectCells();
      return;
    }
    model.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
      this.cells[r][c].style.textAlign = model.alignments[c] ?? '';
      if (this.active?.row === r && this.active.column === c) {
        const active = this.active, view = active.view, old = previous.rows[r].cells[c];
        const sameRaw = model.source.slice(cell.rawFrom - model.from, cell.rawTo - model.from) === previous.source.slice(old.rawFrom - previous.from, old.rawTo - previous.from);
        if (!this.syncing && sameRaw) { const shift = cell.rawFrom - old.rawFrom; active.from += shift; active.to += shift; }
        else if (!this.syncing) { active.from = cell.from; active.to = cell.to; active.insertion = cell.insertion; }
        const value = sameRaw ? view.state.doc.toString() : decodeTableCellText(cell.text).text;
        if (!this.syncing && value !== view.state.doc.toString()) {
          this.syncing = true;
          try {
            const selection = this.owner.state.selection.main;
            const mapping = decodeTableCellText(cell.text);
            const local = (position: number) => mapping.fromSource(Math.max(0, Math.min(cell.text.length, position - cell.from)));
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value },
              selection: EditorSelection.single(local(selection.anchor), local(selection.head)) });
          } finally { this.syncing = false; }
        }
      } else if (cell.text !== previous.rows[r].cells[c].text) this.renderCell(r, c);
    }));
  }

  activate(row: number, column: number, selectAll = false, offset = 0) {
    if (this.destroyed) return;
    this.deselectCells();
    this.close();
    const cell = this.model.rows[row]?.cells[column]; if (!cell) return;
    const host = this.cells[row][column]; host.replaceChildren(); host.classList.add('is-editing');
    const value = decodeTableCellText(cell.text).text;
    const view = new EditorView({ parent: host,
      state: EditorState.create({ doc: value,
        selection: EditorSelection.single(selectAll ? 0 : Math.min(offset, value.length), selectAll ? value.length : Math.min(offset, value.length)),
        extensions: [EditorView.lineWrapping, this.readOnly.of(EditorState.readOnly.of(this.owner.state.readOnly)),
          markdown({ base: markdownLanguage, addKeymap: false, extensions: liveInlineMarkdown }), syntaxHighlighting(defaultHighlightStyle),
          EditorView.contentAttributes.of({ 'aria-label': `Table row ${row + 1}, column ${column + 1}`, spellcheck: 'true' }),
          this.cellExtensions,
          Prec.highest(keymap.of([
            { key: 'Tab', run: () => this.navigate('next'), shift: () => this.navigate('previous') },
            { key: 'Enter', run: () => this.navigate('down'), shift: insertNewline },
            { key: 'Mod-z', run: () => undo(this.owner), shift: () => redo(this.owner) },
            { key: 'Mod-y', run: () => redo(this.owner) },
            { key: 'Escape', run: () => this.exit(1) },
            { key: 'ArrowLeft', run: view => this.collapseSelection(view.textDirection === 1 ? 1 : -1) || this.horizontal(view, -1), shift: view => this.extendSelection(view, 0, view.textDirection === 1 ? 1 : -1) },
            { key: 'ArrowRight', run: view => this.collapseSelection(view.textDirection === 1 ? -1 : 1) || this.horizontal(view, 1), shift: view => this.extendSelection(view, 0, view.textDirection === 1 ? -1 : 1) },
            { key: 'ArrowUp', run: view => this.collapseSelection(-1) || this.vertical(view, -1), shift: view => this.extendSelection(view, -1, 0) },
            { key: 'ArrowDown', run: view => this.collapseSelection(1) || this.vertical(view, 1), shift: view => this.extendSelection(view, 1, 0) },
            { key: 'Backspace', run: () => this.deleteSelection(-1) },
            { key: 'Delete', run: () => this.deleteSelection(1) },
          ])), keymap.of(defaultKeymap),
        ] }),
      dispatchTransactions: (transactions, child) => {
        // Read-only commands normally stop at the child's facet. Also guard
        // programmatic input/paste transactions, while allowing owner snapshots
        // to synchronize the child through update()'s explicit syncing path.
        if (!this.syncing && (this.owner.state.readOnly || this.selected) && transactions.some(t => t.docChanged)) return;
        child.update(transactions);
        if (this.syncing || this.destroyed || !this.active || !transactions.some(t => t.docChanged || t.selection)) return;
        const active = this.active;
        const text = child.state.doc.toString();
        const changed = transactions.some(t => t.docChanged);
        const encoded = encodeTableCellText(text);
        const inserted = (active.insertion?.prefix ?? '') + encoded + (active.insertion?.suffix ?? '');
        const change = { from: active.from, to: active.to,
          insert: padTableCellBoundary(inserted, this.owner.state.doc.sliceString(active.to, active.to + 1) === '|') };
        const selection = child.state.selection.main;
        const start = active.from + (changed ? active.insertion?.prefix.length ?? 0 : 0);
        const map = (position: number) => start + encodeTableCellText(text.slice(0, position)).length;
        // Parent update happens after child.update, avoiding nested CM updates.
        this.syncing = true;
        // Any boundary padding stays outside the child range. This keeps the
        // caret before it and lets later edits reuse it without adding spaces.
        if (changed) { active.from = start; active.to = start + encoded.length; active.insertion = undefined; }
        try { this.owner.dispatch({ ...(changed ? { changes: change } : {}),
          selection: EditorSelection.single(map(selection.anchor), map(selection.head)),
          annotations: [cellSync.of(true), Transaction.userEvent.of(transactions.find(t => t.annotation(Transaction.userEvent))?.annotation(Transaction.userEvent) ?? (changed ? 'input.type' : 'select'))] });
        } finally { this.syncing = false; }
      },
    });
    this.decorateCell(row, column);
    this.active = { row, column, view, from: cell.from, to: cell.to, insertion: cell.insertion };
    const mapping = decodeTableCellText(cell.text);
    this.owner.dispatch({ selection: EditorSelection.single(cell.from + mapping.toSource(view.state.selection.main.anchor), cell.from + mapping.toSource(view.state.selection.main.head)), annotations: cellSync.of(true) });
    view.focus();
  }

  syncReadOnly() {
    const child = this.active?.view;
    const readOnly = this.owner.state.readOnly || !!this.selected;
    if (child && child.state.readOnly !== readOnly) {
      child.dispatch({ effects: this.readOnly.reconfigure(EditorState.readOnly.of(readOnly)) });
    }
  }

  private navigate(direction: 'next' | 'previous' | 'down') {
    if (!this.active) return false;
    let { row, column } = this.active;
    if (direction === 'next') { if (++column === this.model.columnCount) { column = 0; row++; } }
    else if (direction === 'previous') { if (--column < 0) { column = this.model.columnCount - 1; row--; } }
    else row++;
    if (row < 0 || row === this.model.rows.length) {
      if (this.owner.state.readOnly) return true;
      const index = Math.max(0, row), change = insertTableRow(this.model, index);
      this.close();
      this.owner.dispatch({ changes: change, annotations: [cellSync.of(true), Transaction.userEvent.of('input')] });
      row = index;
    }
    this.activate(row, column, true); return true;
  }

  private horizontal(view: EditorView, direction: -1 | 1) {
    if (!this.active || !view.state.selection.main.empty) return false;
    if (view.textDirection === 1) direction = direction === 1 ? -1 : 1;
    const head = view.state.selection.main.head;
    if (head !== (direction < 0 ? 0 : view.state.doc.length)) return false;
    const index = this.active.row * this.model.columnCount + this.active.column + direction;
    if (index < 0 || index >= this.model.rows.length * this.model.columnCount) return this.exit(direction);
    const row = Math.floor(index / this.model.columnCount), column = index % this.model.columnCount;
    this.activate(row, column, false, direction < 0 ? decodeTableCellText(this.model.rows[row].cells[column].text).text.length : 0); return true;
  }

  private vertical(view: EditorView, direction: -1 | 1) {
    if (!this.active || !view.state.selection.main.empty) return false;
    const selection = view.state.selection.main;
    const boundary = view.moveToLineBoundary(selection, direction > 0, true).head;
    // Wrapped visual lines remain inside the cell until its first/last line.
    if (boundary !== (direction < 0 ? 0 : view.state.doc.length)) return false;
    const row = this.active.row + direction;
    if (row < 0 || row >= this.model.rows.length) return this.exit(direction);
    this.activate(row, this.active.column, false, selection.head); return true;
  }

  private exit(direction: -1 | 1) {
    const position = direction < 0 ? Math.max(0, this.model.from - 1) : Math.min(this.owner.state.doc.length, this.model.to + 1);
    this.close(); this.owner.dispatch({ selection: { anchor: position }, annotations: cellSync.of(true) }); this.owner.focus(); return true;
  }

  /** Called after outer transactions, outside CodeMirror's update stack. */
  receiveSelection(restoreFocus = false) {
    if (this.destroyed) return;
    const range = this.owner.state.selection.main;
    if (this.selected) {
      if (range.from >= this.model.from && range.to <= this.model.to) return;
      this.deselectCells();
    }
    if (!restoreFocus && !this.owner.hasFocus && !this.active?.view.hasFocus) return;
    for (let r = 0; r < this.model.rows.length; r++) for (let c = 0; c < this.model.columnCount; c++) {
      const cell = this.model.rows[r].cells[c];
      if (range.from >= cell.rawFrom && range.to <= cell.rawTo) {
        const decoded = decodeTableCellText(cell.text);
        const local = (position: number) => decoded.fromSource(Math.max(0, Math.min(cell.text.length, position - cell.from)));
        if (this.active?.row !== r || this.active.column !== c) this.activate(r, c, false, local(range.anchor));
        const child = this.active?.view;
        if (child) {
          this.syncing = true;
          try {
            const selection = EditorSelection.single(local(range.anchor), local(range.head));
            if (!child.state.selection.eq(selection)) child.dispatch({ selection });
          }
          finally { this.syncing = false; }
          child.focus();
        }
        return;
      }
    }
    const focused = this.active?.view.hasFocus;
    this.close();
    if (focused) this.owner.focus();
  }

  get editor() { return this.active?.view; }
  private closeIfUnfocused() {
    if (!this.destroyed && !this.editorRetainers && !this.dom.contains(this.dom.ownerDocument.activeElement)) this.close();
  }
  /** Menus may temporarily move focus out of the child. Only blur cleanup is
   * retained; explicit navigation, structural changes and teardown still close. */
  retainEditor(): () => void {
    if (this.destroyed || !this.active) return () => {};
    this.editorRetainers++;
    let released = false;
    return () => {
      if (released) return;
      released = true; this.editorRetainers--;
      this.closeIfUnfocused();
    };
  }
  close() {
    const active = this.active; if (!active) return;
    this.active = null; active.view.destroy();
    if (this.cells[active.row]?.[active.column] && this.model.rows[active.row]?.cells[active.column]) this.renderCell(active.row, active.column);
  }
  destroy() { this.destroyed = true; this.stopGesture?.(); this.close(); controllers.delete(this.dom); }
}

class TableWidget extends WidgetType {
  readonly model: MarkdownTable;
  readonly open: (target: string) => void;
  readonly identity: object;
  readonly cellExtensions: Extension;
  constructor(model: MarkdownTable, open: (target: string) => void, identity: object, cellExtensions: Extension) { super(); this.model = model; this.open = open; this.identity = identity; this.cellExtensions = cellExtensions; }
  eq(other: TableWidget) { return this.identity === other.identity && this.model.from === other.model.from && this.model.source === other.model.source; }
  toDOM(view: EditorView) { return new TableController(view, this.model, this.open, this.identity, this.cellExtensions).dom; }
  updateDOM(dom: HTMLElement) { const controller = controllers.get(dom); if (!controller || controller.identity !== this.identity) return false; controller.update(this.model); return true; }
  ignoreEvent() { return true; }
  destroy(dom: HTMLElement) { controllers.get(dom)?.destroy(); }
}

export function activeTableEditor(view: EditorView): EditorView | undefined {
  for (const dom of view.dom.querySelectorAll<HTMLElement>('.cm-live-table')) {
    const editor = controllers.get(dom)?.editor; if (editor?.hasFocus) return editor;
  }
  return undefined;
}

/** Keep the owning table's current child available while an asynchronous menu
 * owns focus. Release in finally after the action/refocus has completed. */
export function retainTableEditor(view: EditorView, target: HTMLElement): () => void {
  const tableDOM = target.closest<HTMLElement>('.cm-live-table');
  if (!tableDOM || !view.dom.contains(tableDOM)) return () => {};
  const controller = controllers.get(tableDOM);
  if (controller?.owner !== view) return () => {};
  const release = controller.retainEditor();
  if (!target.closest('.cm-table-grip')) return release;
  let released = false;
  return () => { if (!released) { released = true; release(); controller.deselectCells(); } };
}

/** Annotate one parent transaction that deliberately operates on selected cells. */
export const tableSelectionAnnotation = cellSync.of(true);

function tableControllerAt(view: EditorView, target: HTMLElement): TableController | undefined {
  const dom = target.closest<HTMLElement>('.cm-live-table');
  const controller = dom && view.dom.contains(dom) ? controllers.get(dom) : undefined;
  return controller?.owner === view ? controller : undefined;
}
export function tableSelectionAt(view: EditorView, target: HTMLElement): boolean {
  const cell = target.closest<HTMLElement>('th[data-row],td[data-row]');
  return !!cell && !target.closest('.cm-table-grip') && !!tableControllerAt(view, target)?.includesCell(Number(cell.dataset.row), Number(cell.dataset.column));
}
export function tableSelectionRanges(view: EditorView, target: HTMLElement): readonly { from: number; to: number }[] {
  if (!tableSelectionAt(view, target)) return [];
  const controller = tableControllerAt(view, target)!, range = controller.selectionRange!;
  return controller.model.rows.slice(range.top, range.bottom + 1).flatMap(row => row.cells.slice(range.left, range.right + 1).map(cell => ({ from: cell.from, to: cell.to })));
}
/** Delegate before generic outer-editor transfer handling, which otherwise sees
 * Markdown text before the table-specific payload. */
export function handleTableClipboard(view: EditorView, event: ClipboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && typeof target.closest === 'function' && !!tableControllerAt(view, target)?.clipboard(event);
}

export interface TableAction {
  id: 'row-before' | 'row-after' | 'row-up' | 'row-down' | 'row-duplicate' | 'row-delete'
    | 'column-before' | 'column-after' | 'column-left' | 'column-right' | 'column-duplicate' | 'column-delete'
    | 'align-left' | 'align-center' | 'align-right' | 'sort-ascending' | 'sort-descending' | 'clear-cells' | 'delete-cells';
  label: string;
  enabled: boolean;
  run(): boolean;
}

export type TableMenuItem = TableAction | { role: 'cut' | 'copy' | 'paste'; label: string; enabled: boolean } | { label: string; submenu: TableMenuItem[] } | { type: 'separator' };

/** Resolve a clicked cell before opening an asynchronous menu. A closure is
 * invalidated by structural/content changes or teardown while the menu is open.
 * The clicked cell, rectangle or grip determines the applicable menu. */
export function tableMenuAt(view: EditorView, target: HTMLElement): TableMenuItem[] {
  const tableDOM = target.closest<HTMLElement>('.cm-live-table'), cell = target.closest<HTMLElement>('th[data-row], td[data-row]');
  if (!tableDOM || !cell || !tableDOM.contains(cell) || !view.dom.contains(tableDOM)) return [];
  const controller = controllers.get(tableDOM);
  if (!controller || controller.owner !== view) return [];
  const row = Number(cell.dataset.row), column = Number(cell.dataset.column), source = controller.model.source;
  if (!controller.model.rows[row]?.cells[column]) return [];
  const grip = target.closest<HTMLElement>('.cm-table-grip');
  const selection = !grip && controller.includesCell(row, column) ? controller.selectionRange : null;
  if (selection) {
    const unchanged = () => tableDOM.isConnected && controllers.get(tableDOM) === controller && controller.model.source === source
      && JSON.stringify(controller.selectionRange) === JSON.stringify(selection);
    const selectedAction = (id: TableAction['id'], label: string, run: () => boolean): TableAction => ({ id, label, enabled: !view.state.readOnly,
      run: () => unchanged() && !view.state.readOnly && run() });
    const align = (value: 'left' | 'center' | 'right') => {
      const rtl = tableDOM.ownerDocument.defaultView?.getComputedStyle(tableDOM.querySelector('table')!).direction === 'rtl';
      return controller.alignSelection(value === 'center' ? value : rtl ? value === 'left' ? 'right' : 'left' : value);
    };
    return [
      { role: 'cut', label: 'Cut', enabled: !view.state.readOnly }, { role: 'copy', label: 'Copy', enabled: true }, { role: 'paste', label: 'Paste', enabled: !view.state.readOnly },
      { type: 'separator' },
      selectedAction('align-left', 'Align left', () => align('left')), selectedAction('align-center', 'Align center', () => align('center')), selectedAction('align-right', 'Align right', () => align('right')),
      { type: 'separator' }, selectedAction('clear-cells', 'Clear cells', () => controller.clearSelection()), selectedAction('delete-cells', 'Delete cells', () => controller.deleteSelection(-1)),
    ];
  }
  const action = (id: TableAction['id'], label: string): TableAction => ({ id, label,
    enabled: !view.state.readOnly,
    run: () => tableDOM.isConnected && tableDOM.contains(cell) && controllers.get(tableDOM) === controller
      && controller.model.source === source && !view.state.readOnly && controller.runAction(id, row, column),
  });
  const groups = (...groups: TableAction[][]): TableMenuItem[] => groups.filter(group => group.length)
    .flatMap((group, index) => index ? [{ type: 'separator' } as TableMenuItem, ...group] : group);
  const rowMoves: TableAction[] = [], columnMoves: TableAction[] = [];
  if (row > 0) rowMoves.push(action('row-up', 'Move row up'));
  if (row < controller.model.rows.length - 1) rowMoves.push(action('row-down', 'Move row down'));
  if (column > 0) columnMoves.push(action('column-left', 'Move column left'));
  if (column < controller.model.columnCount - 1) columnMoves.push(action('column-right', 'Move column right'));
  const menu: TableMenuItem[] = [
    { label: 'Row', submenu: groups(
      [action('row-before', 'Add row above'), action('row-after', 'Add row below')], rowMoves,
      [action('row-duplicate', 'Duplicate row'), action('row-delete', 'Delete row')]) },
    { label: 'Column', submenu: groups(
      [action('column-before', 'Add column to the left'), action('column-after', 'Add column to the right')], columnMoves,
      [action('align-left', 'Align left'), action('align-center', 'Align center'), action('align-right', 'Align right')],
      [action('column-duplicate', 'Duplicate column'), action('column-delete', 'Delete column')]) },
    { type: 'separator' }, action('sort-ascending', 'Sort by column (A to Z)'), action('sort-descending', 'Sort by column (Z to A)'),
  ];
  if (grip?.dataset.axis === 'row') return (menu[0] as { submenu: TableMenuItem[] }).submenu;
  if (grip?.dataset.axis === 'column') return [menu[3], menu[4], { type: 'separator' }, ...(menu[1] as { submenu: TableMenuItem[] }).submenu];
  return menu;
}

/** Flat compatibility/action lookup for callers that render their own menu. */
export function tableActionsAt(view: EditorView, target: HTMLElement): TableAction[] {
  const flatten = (items: TableMenuItem[]): TableAction[] => items.flatMap(item => 'submenu' in item ? flatten(item.submenu) : 'id' in item ? [item] : []);
  return flatten(tableMenuAt(view, target));
}

export function liveTables(open: (target: string) => void, cellExtensions: Extension = []): Extension {
  type CachedTable = { model: MarkdownTable; identity: object; changed: boolean };
  const shiftModel = (model: MarkdownTable, shift: number): MarkdownTable => !shift ? model : {
    ...model, from: model.from + shift, to: model.to + shift,
    separator: { ...model.separator, from: model.separator.from + shift, to: model.separator.to + shift },
    rows: model.rows.map(row => ({ ...row, from: row.from + shift, to: row.to + shift,
      cells: row.cells.map(cell => ({ ...cell, from: cell.from + shift, to: cell.to + shift,
        rawFrom: cell.rawFrom + shift, rawTo: cell.rawTo + shift,
        insertion: cell.insertion ? { at: cell.insertion.at + shift, get prefix() { return cell.insertion!.prefix; }, suffix: cell.insertion.suffix } : undefined })) })),
  };
  const build = (state: EditorState, cached = new Map<number, CachedTable>()) => {
    const decorations: ReturnType<Decoration['range']>[] = [];
    syntaxTree(state).iterate({ enter(node) {
      if (node.name !== 'Table') return;
      const previous = cached.get(node.from);
      const model = previous && !previous.changed && previous.model.to === node.to ? previous.model
        : parseTable(state.doc.sliceString(node.from, node.to), node.from);
      if (model) decorations.push(Decoration.replace({ widget: new TableWidget(model, open, previous?.identity ?? {}, cellExtensions), block: true }).range(node.from, node.to));
      return false;
    } });
    return Decoration.set(decorations, true);
  };
  const field = StateField.define<DecorationSet>({ create: state => build(state),
    update(value, transaction) {
      if (!transaction.docChanged && syntaxTree(transaction.startState) === syntaxTree(transaction.state)) return value;
      const cached = new Map<number, CachedTable>();
      value.between(0, transaction.startState.doc.length, (from, to, decoration) => {
        const start = transaction.changes.mapPos(from, 1), end = transaction.changes.mapPos(to, -1);
        if (start >= end || !(decoration.spec.widget instanceof TableWidget)) return;
        let changed = false;
        transaction.changes.iterChangedRanges((changedFrom, changedTo) => { if (changedFrom <= to && changedTo >= from) changed = true; });
        const widget = decoration.spec.widget;
        cached.set(start, { model: shiftModel(widget.model, start - from), identity: widget.identity, changed });
      });
      return build(transaction.state, cached);
    }, provide: field => EditorView.decorations.from(field) });
  const selection = ViewPlugin.fromClass(class {
    private version = 0;
    update(update: ViewUpdate) {
      if (update.startState.readOnly !== update.state.readOnly) {
        for (const dom of update.view.dom.querySelectorAll<HTMLElement>('.cm-live-table')) controllers.get(dom)?.syncReadOnly();
      }
      if ((!update.selectionSet && !update.docChanged) || update.transactions.some(t => t.annotation(cellSync))) return;
      const version = ++this.version;
      const hadFocus = update.view.hasFocus || !!activeTableEditor(update.view);
      queueMicrotask(() => {
        if (this.version !== version) return;
        const restore = hadFocus && (document.activeElement === document.body || update.view.dom.contains(document.activeElement));
        for (const dom of update.view.dom.querySelectorAll<HTMLElement>('.cm-live-table')) controllers.get(dom)?.receiveSelection(restore);
      });
    }
    destroy() { this.version++; }
  });
  return [field, selection];
}
