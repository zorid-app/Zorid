import { Annotation, Compartment, EditorSelection, EditorState, Prec, StateField, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, insertNewline, isolateHistory, redo, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { inline } from '../ui/markdown.ts';
import { decodeTableCellText, deleteTableColumn, deleteTableRow, duplicateTableColumn, duplicateTableRow,
  encodeTableCellText, insertTableColumn, insertTableRow, moveTableColumn, moveTableRow, parseTable,
  setTableColumnAlignment, sortTableRows } from './table-model.ts';
import type { MarkdownTable, TableEdit } from './table-model.ts';

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
  private readOnly = new Compartment();
  readonly owner: EditorView;
  model: MarkdownTable;
  private open: (target: string) => void;
  readonly identity: object;

  constructor(owner: EditorView, model: MarkdownTable, open: (target: string) => void, identity: object) {
    this.owner = owner; this.model = model; this.open = open; this.identity = identity;
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
    this.dom.addEventListener('focusout', () => queueMicrotask(() => {
      if (!this.destroyed && !this.dom.contains(document.activeElement)) this.close();
    }));
  }

  /** Structural edits share the note's history and reacquire the rebuilt widget. */
  private applyStructure(change: TableEdit, row: number, column: number, preserveSelection = false): boolean {
    if (this.destroyed || this.owner.state.readOnly) return false;
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

  private renderCell(row: number, column: number) {
    const node = this.cells[row][column];
    node.replaceChildren();
    node.classList.remove('is-editing');
    // Decode breaks/pipe escapes without ever interpreting arbitrary HTML.
    inline(node, decodeTableCellText(this.model.rows[row].cells[column].text).text, this.open);
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
        td.addEventListener('mousedown', event => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('a, button, input')) return;
          if (this.active?.row === rowIndex && this.active.column === column) return;
          event.preventDefault(); this.activate(rowIndex, column);
          const view = this.active?.view;
          const position = view?.posAtCoords({ x: event.clientX, y: event.clientY });
          if (view && position != null) view.dispatch({ selection: { anchor: position } });
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
    if (!sameShape) { this.close(); this.render(); return; }
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
    this.close();
    const cell = this.model.rows[row]?.cells[column]; if (!cell) return;
    const host = this.cells[row][column]; host.replaceChildren(); host.classList.add('is-editing');
    const value = decodeTableCellText(cell.text).text;
    const view = new EditorView({ parent: host,
      state: EditorState.create({ doc: value,
        selection: EditorSelection.single(selectAll ? 0 : Math.min(offset, value.length), selectAll ? value.length : Math.min(offset, value.length)),
        extensions: [EditorView.lineWrapping, this.readOnly.of(EditorState.readOnly.of(this.owner.state.readOnly)),
          markdown({ base: markdownLanguage, addKeymap: false }), syntaxHighlighting(defaultHighlightStyle),
          EditorView.contentAttributes.of({ 'aria-label': `Table row ${row + 1}, column ${column + 1}`, spellcheck: 'true' }),
          Prec.highest(keymap.of([
            { key: 'Tab', run: () => this.navigate('next'), shift: () => this.navigate('previous') },
            { key: 'Enter', run: () => this.navigate('down'), shift: insertNewline },
            { key: 'Mod-z', run: () => undo(this.owner), shift: () => redo(this.owner) },
            { key: 'Mod-y', run: () => redo(this.owner) },
            { key: 'Escape', run: () => this.exit(1) },
            { key: 'ArrowLeft', run: view => this.horizontal(view, -1) },
            { key: 'ArrowRight', run: view => this.horizontal(view, 1) },
            { key: 'ArrowUp', run: view => this.vertical(view, -1) },
            { key: 'ArrowDown', run: view => this.vertical(view, 1) },
          ])), keymap.of(defaultKeymap),
        ] }),
      dispatchTransactions: (transactions, child) => {
        // Read-only commands normally stop at the child's facet. Also guard
        // programmatic input/paste transactions, while allowing owner snapshots
        // to synchronize the child through update()'s explicit syncing path.
        if (!this.syncing && this.owner.state.readOnly && transactions.some(t => t.docChanged)) return;
        child.update(transactions);
        if (this.syncing || this.destroyed || !this.active || !transactions.some(t => t.docChanged || t.selection)) return;
        const active = this.active;
        const text = child.state.doc.toString();
        const changed = transactions.some(t => t.docChanged);
        const encoded = encodeTableCellText(text);
        const change = { from: active.from, to: active.to, insert: (active.insertion?.prefix ?? '') + encoded + (active.insertion?.suffix ?? '') };
        const selection = child.state.selection.main;
        const start = active.from + (changed ? active.insertion?.prefix.length ?? 0 : 0);
        const map = (position: number) => start + encodeTableCellText(text.slice(0, position)).length;
        // Parent update happens after child.update, avoiding nested CM updates.
        this.syncing = true;
        if (changed) { active.from = start; active.to = start + encoded.length; active.insertion = undefined; }
        try { this.owner.dispatch({ ...(changed ? { changes: change } : {}),
          selection: EditorSelection.single(map(selection.anchor), map(selection.head)),
          annotations: [cellSync.of(true), Transaction.userEvent.of(transactions.find(t => t.annotation(Transaction.userEvent))?.annotation(Transaction.userEvent) ?? (changed ? 'input.type' : 'select'))] });
        } finally { this.syncing = false; }
      },
    });
    this.active = { row, column, view, from: cell.from, to: cell.to, insertion: cell.insertion };
    const mapping = decodeTableCellText(cell.text);
    this.owner.dispatch({ selection: EditorSelection.single(cell.from + mapping.toSource(view.state.selection.main.anchor), cell.from + mapping.toSource(view.state.selection.main.head)), annotations: cellSync.of(true) });
    view.focus();
  }

  syncReadOnly() {
    const child = this.active?.view;
    if (child && child.state.readOnly !== this.owner.state.readOnly) {
      child.dispatch({ effects: this.readOnly.reconfigure(EditorState.readOnly.of(this.owner.state.readOnly)) });
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
    if (this.destroyed || (!restoreFocus && !this.owner.hasFocus && !this.active?.view.hasFocus)) return;
    const range = this.owner.state.selection.main;
    for (let r = 0; r < this.model.rows.length; r++) for (let c = 0; c < this.model.columnCount; c++) {
      const cell = this.model.rows[r].cells[c];
      if (range.from >= cell.rawFrom && range.to <= cell.rawTo) {
        const decoded = decodeTableCellText(cell.text);
        const local = (position: number) => decoded.fromSource(Math.max(0, Math.min(cell.text.length, position - cell.from)));
        if (this.active?.row !== r || this.active.column !== c) this.activate(r, c, false, local(range.anchor));
        const child = this.active?.view;
        if (child) {
          this.syncing = true;
          try { child.dispatch({ selection: EditorSelection.single(local(range.anchor), local(range.head)) }); }
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
  close() {
    const active = this.active; if (!active) return;
    this.active = null; active.view.destroy();
    if (this.cells[active.row]?.[active.column] && this.model.rows[active.row]?.cells[active.column]) this.renderCell(active.row, active.column);
  }
  destroy() { this.destroyed = true; this.close(); controllers.delete(this.dom); }
}

class TableWidget extends WidgetType {
  readonly model: MarkdownTable;
  readonly open: (target: string) => void;
  readonly identity: object;
  constructor(model: MarkdownTable, open: (target: string) => void, identity: object) { super(); this.model = model; this.open = open; this.identity = identity; }
  eq(other: TableWidget) { return this.identity === other.identity && this.model.from === other.model.from && this.model.source === other.model.source; }
  toDOM(view: EditorView) { return new TableController(view, this.model, this.open, this.identity).dom; }
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

export interface TableAction {
  id: 'row-before' | 'row-after' | 'row-up' | 'row-down' | 'row-duplicate' | 'row-delete'
    | 'column-before' | 'column-after' | 'column-left' | 'column-right' | 'column-duplicate' | 'column-delete'
    | 'align-left' | 'align-center' | 'align-right' | 'sort-ascending' | 'sort-descending';
  label: string;
  enabled: boolean;
  run(): boolean;
}

export type TableMenuItem = TableAction | { label: string; submenu: TableMenuItem[] } | { type: 'separator' };

/** Resolve a clicked cell before opening an asynchronous menu. A closure is
 * invalidated by structural/content changes or teardown while the menu is open.
 * This is the single-cell menu; rectangular cell selections are not modeled. */
export function tableMenuAt(view: EditorView, target: HTMLElement): TableMenuItem[] {
  const tableDOM = target.closest<HTMLElement>('.cm-live-table'), cell = target.closest<HTMLElement>('th[data-row], td[data-row]');
  if (!tableDOM || !cell || !tableDOM.contains(cell) || !view.dom.contains(tableDOM)) return [];
  const controller = controllers.get(tableDOM);
  if (!controller || controller.owner !== view) return [];
  const row = Number(cell.dataset.row), column = Number(cell.dataset.column), source = controller.model.source;
  if (!controller.model.rows[row]?.cells[column]) return [];
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
  return [
    { label: 'Row', submenu: groups(
      [action('row-before', 'Add row above'), action('row-after', 'Add row below')], rowMoves,
      [action('row-duplicate', 'Duplicate row'), action('row-delete', 'Delete row')]) },
    { label: 'Column', submenu: groups(
      [action('column-before', 'Add column to the left'), action('column-after', 'Add column to the right')], columnMoves,
      [action('align-left', 'Align left'), action('align-center', 'Align center'), action('align-right', 'Align right')],
      [action('column-duplicate', 'Duplicate column'), action('column-delete', 'Delete column')]) },
    { type: 'separator' }, action('sort-ascending', 'Sort by column (A to Z)'), action('sort-descending', 'Sort by column (Z to A)'),
  ];
}

/** Flat compatibility/action lookup for callers that render their own menu. */
export function tableActionsAt(view: EditorView, target: HTMLElement): TableAction[] {
  const flatten = (items: TableMenuItem[]): TableAction[] => items.flatMap(item => 'submenu' in item ? flatten(item.submenu) : 'id' in item ? [item] : []);
  return flatten(tableMenuAt(view, target));
}

export function liveTables(open: (target: string) => void): Extension {
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
      if (model) decorations.push(Decoration.replace({ widget: new TableWidget(model, open, previous?.identity ?? {}), block: true }).range(node.from, node.to));
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
