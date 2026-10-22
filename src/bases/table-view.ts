import { parseBaseTableTSV, parsePrimitiveBaseTableInput } from './table-clipboard.ts';
import type { BaseViewPatch, BaseValue } from './document.ts';
import type { BasePropertyPresentation } from './presentation-common.ts';
import { displaySharedBaseValue } from './presentation-common.ts';
import { BASE_NULL, baseValueToString, baseExpressionValue } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import type { BaseQueryResult, BaseQueryRow } from './query.ts';

export interface BaseTableEdit {
  readonly version: BaseQueryResult['version'];
  readonly path: string;
  readonly property: string;
  readonly value: BaseExpressionValue;
}
export interface BaseTableOptions {
  readonly result: BaseQueryResult;
  readonly openFile: (path: string, event: MouseEvent | KeyboardEvent) => void;
  /** Host must revalidate version/path/property and publish a new result after saving. */
  readonly editProperty?: (edit: BaseTableEdit) => Promise<void>;
  readonly getPropertyLabel?: (property: string) => string;
  readonly onError?: (error: unknown) => void;
  readonly editProperties?: (edits: readonly BaseTableEdit[]) => Promise<void>;
  readonly parsePropertyInput?: (raw: string, property: string, row: BaseQueryRow) => BaseExpressionValue;
  readonly renderProperty?: (element: HTMLElement, property: BasePropertyPresentation) => void | (() => void);
  readonly patchView?: (patch: BaseViewPatch) => Promise<void>;
  readonly deleteFiles?: (rows: readonly BaseQueryRow[]) => Promise<void>;
  readonly contextMenu?: (row: BaseQueryRow, event: MouseEvent) => void;
  readonly hoverFile?: (row: BaseQueryRow, event: MouseEvent) => void;
  readonly dragFile?: (row: BaseQueryRow, event: DragEvent) => void;
  readonly requestEditProperty?: (property: string, anchor: HTMLElement) => void;
  readonly summaryOptions?: readonly { id: string; label: string }[];
  readonly requestSummary?: (property: string, id: string) => void | Promise<void>;
  readonly undo?: () => void | Promise<void>;
  readonly redo?: () => void | Promise<void>;
  /** Precomputed Rust summary; null selects the overall scope. Never aggregate DOM rows. */
  readonly getSummary?: (property: string, groupIndex: number | null) => { value: BaseExpressionValue; label?: string } | undefined;
  readonly onEditStateChange?: (active: boolean) => void;
}
export interface BaseTableView { update(result: BaseQueryResult): void; refreshLayout(): void; hasActiveEdits(): boolean; destroy(): void }
type Item = { row: BaseQueryRow; groupIndex: number; rowIndex: number; group?: never; summary?: never } | { group: number; row?: never; summary?: never } | { summary: number | null; row?: never; group?: never };
type CellPoint = { group: number; row: number; column: number };
type CellRange = { group: number; top: number; bottom: number; start: number; end: number };
function cellBounds(a: CellPoint, b = a): CellRange {
  return { group: a.group, top: Math.min(a.row, b.row), bottom: Math.max(a.row, b.row), start: Math.min(a.column, b.column), end: Math.max(a.column, b.column) };
}
function extendRange(previous: CellRange | undefined, active: CellPoint, target: CellPoint): CellRange {
  const current = previous ?? cellBounds(active);
  const edge = (low: number, high: number, from: number, to: number): [number, number] => {
    // Move the active boundary inward, retaining the opposite edge; otherwise expand.
    if (to >= low && to <= high) {
      if (from === low && to > from) return [to, high];
      if (from === high && to < from) return [low, to];
    }
    return [Math.min(low, to), Math.max(high, to)];
  };
  const [top, bottom] = edge(current.top, current.bottom, active.row, target.row);
  const [start, end] = edge(current.start, current.end, active.column, target.column);
  return { group: current.group, top, bottom, start, end };
}
function tableClipboard(header: string[], rows: string[][]): Record<string, string> {
  const quote = (value: string) => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const escaped = [header, ...rows].map(row => row.map(value => value.replace(/\|/g, '\\|')));
  const widths = header.map((_, index) => escaped.reduce((width, row) => Math.max(width, row[index].length), 0) + 2);
  const markdownRow = (row: string[]) => '|' + row.map((value, i) => {
    const padding = widths[i] - value.length, left = Math.floor(padding / 2);
    return ' '.repeat(left) + value + ' '.repeat(padding - left);
  }).join('|') + '|';
  return {
    'text/plain': rows.map(row => row.map(quote).join('\t')).join('\n'),
    'text/markdown': [markdownRow(escaped[0]), '|' + widths.map(width => ' ' + '-'.repeat(width - 2) + ' ').join('|') + '|', ...escaped.slice(1).map(markdownRow)].join('\n'),
    'obsidian/table': JSON.stringify({ header, rows, alignment: header.map(() => null) }),
  };
}
const primitiveTypes = new Set(['null', 'string', 'number', 'boolean']);
function display(value: BaseExpressionValue, shared = false): string {
  if (value.type === 'null') return '';
  if (value.type === 'namespace') return value.name;
  try { return shared ? displaySharedBaseValue(value) : baseValueToString(value); }
  catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
}

/** Original Table presentation. Query evaluation and all mutations belong to the host. */
export function createBaseTableView(container: HTMLElement, options: BaseTableOptions): BaseTableView {
  const doc = container.ownerDocument, win = doc.defaultView;
  const root = doc.createElement('div'), header = doc.createElement('div'), body = doc.createElement('div'), footer = doc.createElement('div');
  const status = doc.createElement('div');
  root.className = 'zorid-bases-table'; root.setAttribute('role', 'grid'); root.setAttribute('aria-multiselectable', 'true'); root.setAttribute('aria-label', options.result.view.name);
  header.className = 'zorid-bases-table-header'; header.setAttribute('role', 'row');
  body.className = 'zorid-bases-table-body'; body.setAttribute('role', 'rowgroup');
  status.className = 'zorid-bases-table-status'; status.setAttribute('role', 'status');
  footer.className = 'zorid-bases-table-footer zorid-bases-table-summary'; footer.setAttribute('role', 'row');
  root.append(header, body, footer); container.append(root, status);
  let result = options.result, items: Item[] = [], rowHeight = 30, template = '';
  let destroyed = false, initialized = false, revision = 0, frame: number | undefined;
  let selection: { path: string; property: string; point?: CellPoint } | undefined;
  let range: CellRange | undefined, anchor: CellPoint | undefined;
  let stopDrag: (() => void) | undefined;
  let suppressClick = false;
  let editing: HTMLElement | undefined;
  const collapsed = new Set<number>();
  const widgetDisposers = new Map<HTMLElement, () => void>();
  let bulkPending = false, configPending = false;
  let menu: HTMLElement | undefined, closeMenu: (() => void) | undefined;
  let widths = new Map<string, number>(), resizeWidths = new Map<string, number>();
  const measuredWidths = new Map<string, number>();
  let stopResize: (() => void) | undefined, draggedColumn: string | undefined;
  const hasActiveEdits = () => !destroyed && (!!editing || bulkPending || configPending || !!root.querySelector('[data-base-editing]'));
  function releaseCell(cell: HTMLElement) {
    const dispose = widgetDisposers.get(cell); widgetDisposers.delete(cell);
    try { dispose?.(); } catch (error) { report(error); }
  }
  function releaseRow(row: Element) { for (const cell of row.querySelectorAll<HTMLElement>('[role=gridcell]')) releaseCell(cell); }
  async function patch(patch: BaseViewPatch) {
    if (!options.patchView || destroyed || hasActiveEdits()) return;
    configPending = true;
    try { await options.patchView(patch); } catch (error) { if (!destroyed) report(error); }
    finally { configPending = false; if (!destroyed) { try { options.onEditStateChange?.(hasActiveEdits()); } catch (error) { report(error); } } }
  }

  function report(error: unknown) {
    status.textContent = error instanceof Error ? error.message : String(error);
    try { options.onError?.(error); } catch { /* Reporting cannot interrupt disposal or sibling commands. */ }
  }
  function editable(row: BaseQueryRow, property: string, value: BaseExpressionValue) {
    return !!(options.editProperty || options.editProperties) && /\.md$/i.test(row.path) && property.startsWith('note.') && (primitiveTypes.has(value.type) || !!options.renderProperty);
  }
  function dimensions() {
    const base = Number.parseFloat(win?.getComputedStyle(root).getPropertyValue('--bases-table-row-height') ?? '') || 30;
    const multiplier = result.view.rowHeight === 'medium' ? 2 : result.view.rowHeight === 'tall' ? 4 : result.view.rowHeight === 'extra' ? 8 : 1;
    rowHeight = Math.max(1, base) * multiplier;
    root.style.setProperty('--zorid-base-row-height', `${rowHeight}px`);
    const sizes = result.view.columnSize;
    widths = new Map(result.properties.map(property => {
      const size = sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? (sizes as Record<string, unknown>)[property] : undefined;
      const automatic = measuredWidths.get(property) ?? autoWidth(property);
      return [property, resizeWidths.get(property) ?? (typeof size === 'number' && Number.isFinite(size) && size > 0 ? Math.max(40, size) : automatic)];
    }));
    template = [...widths.values()].map(size => `${size}px`).join(' ');
    const total = [...widths.values()].reduce((sum, width) => sum + width, 0);
    footer.style.gridTemplateColumns = template; footer.style.minWidth = `${total}px`;
    header.style.gridTemplateColumns = template; header.style.minWidth = `${total}px`; body.style.minWidth = `${total}px`;
    for (const row of body.children) if (row instanceof doc.defaultView!.HTMLElement) row.style.gridTemplateColumns = template;
  }

  function rebuildItems() {
    items = [];
    for (let i = 0; i < result.groups.length; i++) {
      const group = result.groups[i];
      if (group.key !== null) items.push({ group: i });
      if (!collapsed.has(i)) {
        group.rows.forEach((row, rowIndex) => items.push({ row, groupIndex: i, rowIndex }));
        if (group.key !== null && result.properties.some(property => options.getSummary?.(property, i))) items.push({ summary: i });
      }
    }
    body.style.height = `${items.length * rowHeight}px`;
    root.setAttribute('aria-rowcount', String(items.length + 1)); root.setAttribute('aria-colcount', String(result.properties.length));
  }
  function showMenu(event: MouseEvent, entries: { label: string; action: () => void; disabled?: boolean }[], returnFocus: HTMLElement) {
    event.preventDefault(); event.stopPropagation(); closeMenu?.();
    const token = revision;
    menu = doc.createElement('div'); const ownedMenu = menu; menu.className = 'zorid-bases-table-menu context-menu'; menu.setAttribute('role', 'menu');
    const rect = root.getBoundingClientRect();
    menu.style.left = `${Math.max(rect.left, Math.min(event.clientX || returnFocus.getBoundingClientRect().left, (win?.innerWidth ?? 1000) - 230))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY || returnFocus.getBoundingClientRect().bottom, (win?.innerHeight ?? 800) - entries.length * 30 - 12))}px`;
    for (const entry of entries) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'context-menu-item'; button.textContent = entry.label; button.setAttribute('role', 'menuitem'); button.disabled = !!entry.disabled;
      button.addEventListener('click', () => { if (destroyed || token !== revision || menu !== ownedMenu || !button.isConnected || button.disabled) return; closeMenu?.(); entry.action(); }); menu.append(button);
    }
    const outside = (event: Event) => { if (!menu?.contains(event.target as Node)) closeMenu?.(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu?.(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); const buttons = [...menu!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(doc.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    closeMenu = () => { menu?.remove(); menu = undefined; doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key, true); closeMenu = undefined; if (returnFocus.isConnected) returnFocus.focus({ preventScroll: true }); };
    doc.body.append(menu); doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', key, true);
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  function selectColumn(index: number) {
    const group = selection?.point?.group ?? 0;
    if (!result.groups[group]?.rows.length) return;
    range = { group, top: 0, bottom: result.groups[group].rows.length - 1, start: index, end: index };
    focusCell(result.groups[group].rows[0].path, result.properties[index], { group, row: 0, column: index }); paintRange();
  }
  function setColumnWidth(property: string, width?: number) {
    const sizes = result.view.columnSize;
    const next: Record<string, BaseValue> = { ...(sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? sizes as Record<string, BaseValue> : {}) };
    if (width === undefined) { delete next[property]; measuredWidths.delete(property); } else next[property] = Math.round(Math.max(40, Math.min(2000, width)));
    resizeWidths.clear(); void patch({ columnSize: next }); dimensions(); renderRows();
  }
  function autoWidth(property: string): number {
    const probe = doc.createElement('span'); probe.className = 'zorid-bases-table-measure'; probe.style.font = win?.getComputedStyle(root).font ?? ''; doc.body.append(probe);
    const min = Number.parseFloat(win?.getComputedStyle(root).getPropertyValue('--bases-table-column-min-width') ?? '') || 40;
    const max = Number.parseFloat(win?.getComputedStyle(root).getPropertyValue('--bases-table-column-max-width') ?? '') || 300;
    let width = min;
    for (const text of [options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, ''), ...result.rows.map(row => display(row.values[property] ?? BASE_NULL, result.shared !== undefined))]) {
      probe.textContent = text; width = Math.max(width, Math.min(max, probe.getBoundingClientRect().width + 32));
      if (width >= max) break;
    }
    probe.remove(); measuredWidths.set(property, width); return width;
  }
  function columnMenu(event: MouseEvent, property: string, index: number, cell: HTMLElement) {
    const sort = Array.isArray(result.view.sort) ? result.view.sort.filter(item => !!item && typeof item === 'object' && !Array.isArray(item) && item.property !== property) : [];
    const disabled = !options.patchView || hasActiveEdits();
    const sorted = Array.isArray(result.view.sort) ? result.view.sort.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.property === property) : undefined;
    showMenu(event, [
      { label: 'Hide column', disabled, action: () => { void patch({ order: result.properties.filter(item => item !== property) }); } },
      { label: 'Summarize', disabled: !options.requestSummary || !options.summaryOptions?.length, action: () => showMenu(event, options.summaryOptions!.map(option => ({ label: option.label, action: () => { Promise.resolve(options.requestSummary?.(property, option.id)).catch(report); } })), cell) },
      { label: 'Group by', disabled, action: () => { void patch({ groupBy: { property, direction: 'ASC' } }); } },
      { label: 'Sort A to Z', disabled, action: () => { void patch({ sort: [{ property, direction: 'ASC' }, ...sort] }); } },
      { label: 'Sort Z to A', disabled, action: () => { void patch({ sort: [{ property, direction: 'DESC' }, ...sort] }); } },
      ...(sorted ? [{ label: 'Remove sort', disabled, action: () => { void patch({ sort }); } }] : []),
      { label: property.startsWith('formula.') ? 'Edit formula' : 'Edit property', disabled: !options.requestEditProperty || hasActiveEdits(), action: () => options.requestEditProperty?.(property, cell) },
    ], cell);
  }
  function renderHeader() {
    header.replaceChildren();
    for (const [index, property] of result.properties.entries()) {
      const cell = doc.createElement('div'); cell.className = 'zorid-bases-table-column';
      cell.setAttribute('role', 'columnheader'); cell.setAttribute('aria-colindex', String(index + 1)); cell.tabIndex = -1;
      cell.textContent = options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, '');
      cell.title = property;
      const label = doc.createElement('span'); label.className = 'zorid-bases-table-header-name'; label.textContent = cell.textContent; cell.replaceChildren(label);
      const sorted = Array.isArray(result.view.sort) ? result.view.sort.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.property === property) : undefined;
      if (sorted && typeof sorted === 'object' && !Array.isArray(sorted)) { const indicator = doc.createElement('span'); indicator.className = 'zorid-bases-table-sort-indicator'; indicator.setAttribute('aria-label', sorted.direction === 'DESC' ? 'Sorted descending' : 'Sorted ascending'); indicator.textContent = sorted.direction === 'DESC' ? '↓' : '↑'; cell.setAttribute('aria-sort', sorted.direction === 'DESC' ? 'descending' : 'ascending'); cell.append(indicator); }
      const token = revision, current = () => !destroyed && token === revision && header.contains(cell);
      cell.addEventListener('contextmenu', event => { if (current()) columnMenu(event, property, index, cell); });
      const toggleSort = () => {
        const sort = Array.isArray(result.view.sort) ? result.view.sort.filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.property !== property) : [];
        const previous = Array.isArray(result.view.sort) ? result.view.sort.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.property === property) : undefined;
        const direction = previous && typeof previous === 'object' && !Array.isArray(previous) && previous.direction === 'ASC' ? 'DESC' : 'ASC';
        void patch({ sort: [{ property, direction }, ...sort] });
      };
      cell.addEventListener('click', event => { if (current() && !event.defaultPrevented && !(event.target as Element).closest('.zorid-bases-table-resize')) { event.preventDefault(); toggleSort(); } });
      cell.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && current()) { event.preventDefault(); toggleSort(); } });
      if (options.patchView) {
        cell.draggable = true;
        cell.addEventListener('dragstart', event => { if (!current() || hasActiveEdits()) { event.preventDefault(); return; } draggedColumn = property; event.dataTransfer?.setData('application/x-zorid-base-column', property); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; });
        cell.addEventListener('dragover', event => { if (current() && draggedColumn && draggedColumn !== property) { event.preventDefault(); cell.classList.add('is-drop-target'); } });
        cell.addEventListener('dragleave', () => cell.classList.remove('is-drop-target'));
        cell.addEventListener('drop', event => { event.preventDefault(); cell.classList.remove('is-drop-target'); if (!current() || !draggedColumn || draggedColumn === property) return; const order = result.properties.filter(item => item !== draggedColumn); order.splice(order.indexOf(property), 0, draggedColumn); draggedColumn = undefined; void patch({ order }); });
        cell.addEventListener('dragend', () => { draggedColumn = undefined; for (const cell of header.children) cell.classList.remove('is-drop-target'); });
        const handle = doc.createElement('span'); handle.className = 'zorid-bases-table-resize'; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-label', `Resize ${options.getPropertyLabel?.(property) ?? property}`); handle.setAttribute('aria-orientation', 'vertical'); handle.tabIndex = 0;
        handle.addEventListener('click', event => event.stopPropagation());
        handle.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); if (current()) setColumnWidth(property); });
        handle.addEventListener('keydown', event => { if (!current() || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); setColumnWidth(property, event.key === 'Home' ? undefined : (widths.get(property) ?? 180) + (event.key === 'ArrowLeft' ? -10 : 10)); });
        handle.addEventListener('pointerdown', event => {
          if (!current() || event.button !== 0 || hasActiveEdits()) return;
          event.preventDefault(); event.stopPropagation(); stopResize?.();
          const start = event.clientX, initial = widths.get(property) ?? 180;
          let changed = false;
          const move = (next: PointerEvent) => { if (!current() || next.pointerId !== event.pointerId) return; changed = true; resizeWidths.set(property, Math.max(40, Math.min(2000, initial + next.clientX - start))); dimensions(); };
          const finish = (next: PointerEvent) => { if (next.pointerId !== event.pointerId) return; const width = resizeWidths.get(property); stopResize?.(); if (changed && next.type !== 'pointercancel' && current()) setColumnWidth(property, width); else { resizeWidths.clear(); dimensions(); } };
          const blur = () => { stopResize?.(); resizeWidths.clear(); dimensions(); };
          stopResize = () => { win?.removeEventListener('pointermove', move); win?.removeEventListener('pointerup', finish); win?.removeEventListener('pointercancel', finish); win?.removeEventListener('blur', blur); stopResize = undefined; };
          win?.addEventListener('pointermove', move); win?.addEventListener('pointerup', finish); win?.addEventListener('pointercancel', finish); win?.addEventListener('blur', blur);
        });
        cell.append(handle);
      }
      header.append(cell);
    }
  }
  function focusCell(path: string, property: string, point?: CellPoint) {
    const index = items.findIndex(item => item.row && item.row.path === path && (!point || item.groupIndex === point.group && item.rowIndex === point.row));
    const item = items[index];
    selection = { path, property, point: item?.row ? { group: item.groupIndex, row: item.rowIndex, column: result.properties.indexOf(property) } : point };
    if (index < 0) return;
    const top = index * rowHeight;
    if (top < root.scrollTop) root.scrollTop = top;
    else if (top + rowHeight > root.scrollTop + root.clientHeight - 30) root.scrollTop = top + rowHeight - Math.max(rowHeight, root.clientHeight - 30);
    renderRows();
    for (const cell of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      if (cell.dataset.path === path && cell.dataset.property === property && (!point || cell.dataset.group === String(point.group) && cell.dataset.row === String(point.row))) { cell.focus(); break; }
    }
  }
  function startEdit(cell: HTMLElement, row: BaseQueryRow, property: string, value: BaseExpressionValue, toggle = false) {
    if (destroyed || editing || range || !editable(row, property, value)) return;
    const token = revision, version = result.version;
    const multiline = value.type === 'string' && /[\r\n]/.test(value.value);
    editing = cell; cell.dataset.baseEditing = 'draft'; options.onEditStateChange?.(true); const input = multiline ? doc.createElement('textarea') : doc.createElement('input');
    input.className = 'zorid-bases-table-input';
    input.setAttribute('aria-label', options.getPropertyLabel?.(property) ?? property);
    // Keep number text uncoerced while editing, so malformed input cannot become null/zero.
    if (!multiline) (input as HTMLInputElement).type = value.type === 'boolean' ? 'checkbox' : 'text';
    if (value.type === 'boolean') (input as HTMLInputElement).checked = toggle ? !value.value : value.value;
    else input.value = value.type === 'null' ? '' : display(value, result.shared !== undefined);
    // Compare the control baseline, so untouched CRLF values survive textarea normalization.
    const originalText = input.value;
    cell.replaceChildren(input); input.focus(); if (value.type !== 'boolean') input.select();
    let saving = false, restoreAfterSave = true;
    const cancel = (restoreFocus = true) => { if (editing !== cell) return; editing = undefined; cell.removeAttribute('data-base-editing'); options.onEditStateChange?.(false); renderRows(); if (restoreFocus) focusCell(row.path, property); };
    async function save(restoreFocus = true) {
      if (!restoreFocus) restoreAfterSave = false;
      if (saving || destroyed || revision !== token || editing !== cell) return;
      if (value.type !== 'boolean' && input.value === originalText) { cancel(restoreFocus); return; }
      let next: BaseExpressionValue;
      if (value.type === 'boolean') next = { type: 'boolean', value: (input as HTMLInputElement).checked };
      else if (!input.value) next = BASE_NULL;
      else if (value.type === 'number') {
        const n = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(n)) {
          input.setAttribute('aria-invalid', 'true'); report(new Error('Enter a valid number.')); return;
        }
        next = { type: 'number', value: n };
      } else next = { type: 'string', value: input.value };
      saving = true; input.disabled = true; cell.setAttribute('aria-busy', 'true');
      try {
        if (options.editProperty) await options.editProperty({ version, path: row.path, property, value: next });
        else await options.editProperties?.([{ version, path: row.path, property, value: next }]);
        if (destroyed || revision !== token || editing !== cell) return;
        editing = undefined; cell.removeAttribute('data-base-editing'); options.onEditStateChange?.(false); status.textContent = ''; renderRows(); if (restoreAfterSave) focusCell(row.path, property);
      } catch (error) {
        if (destroyed || revision !== token || editing !== cell) return;
        saving = false; input.disabled = false; cell.removeAttribute('aria-busy'); input.setAttribute('aria-invalid', 'true'); report(error); if (restoreAfterSave) input.focus();
      }
    }
    input.addEventListener('keydown', rawEvent => {
      const event = rawEvent as KeyboardEvent;
      if (event.isComposing || (multiline && event.key === 'Enter' && event.shiftKey)) return;
      if (event.key === 'Escape' && !saving) { event.preventDefault(); event.stopPropagation(); cancel(); }
      else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save(); }
    });
    input.addEventListener('change', () => { if (value.type === 'boolean') void save(); });
    input.addEventListener('blur', () => { void save(false); });
    if (toggle) void save();
  }
  function renderCell(row: BaseQueryRow, property: string, index: number, point: CellPoint) {
    const cell = doc.createElement('div'), value = row.values[property] ?? BASE_NULL, token = revision;
    const current = () => !destroyed && token === revision && body.contains(cell);
    cell.className = 'zorid-bases-table-cell'; cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-colindex', String(index + 1));
    cell.dataset.path = row.path; cell.dataset.property = property; cell.dataset.group = String(point.group); cell.dataset.row = String(point.row); cell.dataset.column = String(index);
    cell.tabIndex = selection?.path === row.path && selection.property === property && (!selection.point || selection.point.group === point.group && selection.point.row === point.row) ? 0 : -1;
    cell.setAttribute('aria-readonly', String(!editable(row, property, value)));
    if (options.renderProperty && property.startsWith('note.')) {
      try { const dispose = options.renderProperty(cell, { row, property, value, version: result.version }); if (dispose) widgetDisposers.set(cell, dispose); } catch (error) { report(error); cell.textContent = display(value, result.shared !== undefined); }
    } else if (property === 'file.name' || property === 'file.file') {
      const link = doc.createElement('a'); link.className = 'internal-link'; link.href = '#'; link.tabIndex = -1;
      link.textContent = display(value, result.shared !== undefined) || row.path; link.title = row.path;
      link.addEventListener('click', event => { event.preventDefault(); if (current() && !suppressClick && (!event.shiftKey || event.metaKey || event.ctrlKey)) options.openFile(row.path, event); });
      link.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); if (current() && !suppressClick && (!event.shiftKey || event.metaKey || event.ctrlKey)) options.openFile(row.path, event); } });
      cell.append(link);
    } else if (value.type === 'boolean') {
      const checkbox = doc.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = value.value; checkbox.disabled = !editable(row, property, value); checkbox.tabIndex = -1;
      checkbox.setAttribute('aria-label', property);
      checkbox.addEventListener('click', event => { event.preventDefault(); if (current()) startEdit(cell, row, property, value, true); });
      cell.append(checkbox);
    } else {
      cell.textContent = display(value, result.shared !== undefined); if (value.type === 'error') cell.classList.add('is-error');
    }
    cell.addEventListener('focus', () => {
      selection = { path: row.path, property, point };
      for (const other of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) other.tabIndex = other === cell ? 0 : -1;
    });
    cell.addEventListener('click', event => {
      if (!current() || editing) return;
      if (suppressClick) { event.preventDefault(); suppressClick = false; return; }
      if (event.shiftKey && !event.metaKey && !event.ctrlKey && selection?.point?.group === point.group) {
        const active = selection.point; anchor = active; range = cellBounds(active, point);
        event.preventDefault();
        const activeRow = result.groups[active.group].rows[active.row];
        focusCell(activeRow.path, result.properties[active.column], active); paintRange();
      } else if (event.target === cell) { range = undefined; anchor = undefined; cell.focus(); paintRange(); }
    });
    cell.addEventListener('dblclick', event => { if (!options.renderProperty && current() && !(event.target as Element).closest('a,input,textarea')) startEdit(cell, row, property, value); });
    cell.addEventListener('keydown', event => {
      if (!current() || event.defaultPrevented || event.target !== cell || event.isComposing || cell.hasAttribute('data-base-editing')) return;
      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
        event.preventDefault(); cell.dispatchEvent(new win!.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      } else if (event.key === 'Escape') {
        event.preventDefault(); range = undefined; anchor = undefined; paintRange();
      } else if ((event.key === ' ' && (event.ctrlKey || event.shiftKey)) || (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        const bounds = range ?? cellBounds(point), groupRows = result.groups[point.group].rows.length;
        range = event.key.toLowerCase() === 'a' ? { group: point.group, top: 0, bottom: groupRows - 1, start: 0, end: result.properties.length - 1 }
          : event.ctrlKey ? { ...bounds, top: 0, bottom: groupRows - 1 } : { ...bounds, start: 0, end: result.properties.length - 1 };
        anchor = undefined; paintRange();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (options.editProperties) { event.preventDefault(); void clearSelection(); }
      } else if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault(); if (range) return;
        if (property === 'file.name' || property === 'file.file') options.openFile(row.path, event);
        else if (!options.renderProperty) startEdit(cell, row, property, value);
      } else if (event.key === 'Tab') {
        event.preventDefault(); const step = event.shiftKey ? -1 : 1; let column = index + step, target = point.row;
        if (column < 0) { column = result.properties.length - 1; target--; } else if (column >= result.properties.length) { column = 0; target++; }
        let group = point.group; if (target < 0 && group > 0) { group--; target = result.groups[group].rows.length - 1; } else if (target >= result.groups[group].rows.length && group + 1 < result.groups.length) { group++; target = 0; }
        const next = result.groups[group]?.rows[target]; if (next) { range = undefined; focusCell(next.path, result.properties[column], { group, row: target, column }); }
      } else if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)) {
        if ((event.metaKey || event.ctrlKey) && (event.key === 'Home' || event.key === 'End')) {
          event.preventDefault(); const candidates = items.filter(item => !!item.row), item = event.key === 'Home' ? candidates[0] : candidates.at(-1);
          if (item?.row) { range = undefined; const column = event.key === 'Home' ? 0 : result.properties.length - 1; focusCell(item.row.path, result.properties[column], { group: item.groupIndex, row: item.rowIndex, column }); } return;
        }
        if (event.metaKey || event.ctrlKey) {
          if (!event.shiftKey || !event.key.startsWith('Arrow')) return;
          event.preventDefault(); const bounds = range ?? cellBounds(point);
          range = event.key === 'ArrowUp' ? { ...bounds, top: 0, bottom: point.row }
            : event.key === 'ArrowDown' ? { ...bounds, top: point.row, bottom: result.groups[point.group].rows.length - 1 }
            : event.key === 'ArrowLeft' ? { ...bounds, start: 0, end: point.column }
            : { ...bounds, start: point.column, end: result.properties.length - 1 };
          anchor = undefined; paintRange(); return;
        }
        event.preventDefault(); const rowIndex = items.findIndex(item => item.row === row && item.groupIndex === point.group && item.rowIndex === point.row);
        let target = rowIndex, column = index;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const step = event.key === 'ArrowUp' ? -1 : 1; target += step;
          while (target >= 0 && target < items.length && !items[target].row) target += step;
        } else if (event.key === 'PageUp' || event.key === 'PageDown') {
          target = Math.max(0, Math.min(items.length - 1, target + (event.key === 'PageUp' ? -1 : 1) * Math.max(1, Math.floor((root.clientHeight || 600) / rowHeight))));
          while (target >= 0 && target < items.length && !items[target].row) target += event.key === 'PageUp' ? -1 : 1;
        } else if (event.key === 'ArrowLeft') column--;
        else if (event.key === 'ArrowRight') column++;
        else column = event.key === 'Home' ? 0 : result.properties.length - 1;
        const targetItem = items[target], next = targetItem?.row;
        if (next && column >= 0 && column < result.properties.length) {
          const nextPoint = { group: targetItem.groupIndex, row: targetItem.rowIndex, column };
          if (event.shiftKey && nextPoint.group !== point.group) return;
          if (event.shiftKey) { range = extendRange(range, point, nextPoint); anchor = undefined; }
          else { range = undefined; anchor = undefined; }
          focusCell(next.path, result.properties[column], nextPoint); paintRange();
        }
      }
    });
    cell.addEventListener('contextmenu', event => {
      if (!current() || hasActiveEdits()) return;
      if (!range || point.group !== range.group || point.row < range.top || point.row > range.bottom || point.column < range.start || point.column > range.end) { range = undefined; cell.focus(); }
      const bounds = range ?? cellBounds(point);
      if (!range && (property === 'file.name' || property === 'file.file')) { if (options.contextMenu) { event.preventDefault(); options.contextMenu(row, event); } return; }
      showMenu(event, [
        { label: 'Copy', action: () => { void copySelection(); } },
        { label: 'Paste', disabled: !options.editProperties || !win?.navigator.clipboard?.readText, action: () => { void pasteFromClipboard(); } },
        { label: 'Clear selection', disabled: !options.editProperties, action: () => { void clearSelection(); } },
        { label: 'Delete', disabled: !options.deleteFiles, action: () => { const rows = result.groups[bounds.group].rows.slice(bounds.top, bounds.bottom + 1); void options.deleteFiles?.(rows).catch(report); } },
        { label: 'Select row', action: () => { range = { ...bounds, start: 0, end: result.properties.length - 1 }; paintRange(); } },
        { label: 'Select column', action: () => selectColumn(index) },
      ], cell);
    });
    cell.addEventListener('mouseover', event => { if (current() && (property === 'file.name' || property === 'file.file')) options.hoverFile?.(row, event); });
    if ((property === 'file.name' || property === 'file.file') && options.dragFile) { cell.draggable = true; cell.addEventListener('dragstart', event => { if (current()) options.dragFile?.(row, event); else event.preventDefault(); }); }
    return cell;
  }
  function renderRows() {
    if (destroyed) return;
    // Keep an active draft mounted during scrolling. Its position stays in the virtual body.
    const activeRows = new Set<HTMLElement>();
    if (editing?.parentElement) activeRows.add(editing.parentElement);
    for (const draft of root.querySelectorAll<HTMLElement>('[data-base-editing]')) { const row = draft.closest<HTMLElement>('.zorid-bases-table-row'); if (row) activeRows.add(row); }
    for (const activeRow of activeRows) {
      activeRow.style.top = `${Number(activeRow.dataset.index) * rowHeight}px`;
      activeRow.style.height = `${rowHeight}px`;
      activeRow.style.gridTemplateColumns = template;
    }
    const focused = doc.activeElement as HTMLElement | null;
    const preserveFocus = focused?.getAttribute('role') === 'gridcell' && body.contains(focused);
    const focusedGroup = focused && body.contains(focused) ? focused.dataset.groupButton : undefined;
    for (const child of Array.from(body.children)) if (!activeRows.has(child as HTMLElement)) { releaseRow(child); child.remove(); }
    const visible = Math.ceil((root.clientHeight || 600) / rowHeight);
    const start = Math.max(0, Math.floor(root.scrollTop / rowHeight) - 5), end = Math.min(items.length, start + visible + 10);
    for (let index = start; index < end; index++) {
      const item = items[index]; if ([...activeRows].some(row => row.dataset.index === String(index))) continue;
      const el = doc.createElement('div'); el.dataset.index = String(index); el.style.top = `${index * rowHeight}px`; el.style.height = `${rowHeight}px`;
      el.className = 'zorid-bases-table-row'; el.setAttribute('role', 'row'); el.setAttribute('aria-rowindex', String(index + 2));
      if (item.row) { el.style.gridTemplateColumns = template; result.properties.forEach((property, i) => el.append(renderCell(item.row!, property, i, { group: item.groupIndex, row: item.rowIndex, column: i }))); }
      else if ('summary' in item) {
        el.classList.add('zorid-bases-table-summary'); el.style.gridTemplateColumns = template;
        for (const property of result.properties) { const cell = doc.createElement('div'); cell.className = 'zorid-bases-table-summary-cell'; cell.setAttribute('role', 'gridcell'); cell.dataset.property = property; const summary = options.getSummary?.(property, item.summary!); if (summary) { cell.textContent = display(summary.value, result.shared !== undefined); if (summary.label) cell.title = summary.label; } el.append(cell); }
      } else {
        el.classList.add('zorid-bases-table-group'); const button = doc.createElement('button'), group = result.groups[item.group], token = revision;
        button.type = 'button'; button.dataset.groupButton = String(item.group); button.setAttribute('aria-expanded', String(!collapsed.has(item.group)));
        button.textContent = `${collapsed.has(item.group) ? '▸' : '▾'} ${group.key?.type === 'null' ? 'Empty' : display(group.key!, result.shared !== undefined)} (${group.rows.length})`;
        button.addEventListener('click', () => { if (destroyed || token !== revision || !body.contains(button) || hasActiveEdits()) return; collapsed.has(item.group) ? collapsed.delete(item.group) : collapsed.add(item.group); rebuildItems(); range = undefined; anchor = undefined;
          if (selection && !items.some(item => item.row?.path === selection!.path)) {
            const first = items.find(item => item.row)?.row;
            selection = first && result.properties[0] ? { path: first.path, property: result.properties[0] } : undefined;
          }
          renderRows(); });
        el.append(button);
      }
      body.append(el);
    }
    renderFooter();
    paintRange();
    if (focusedGroup !== undefined) {
      const button = Array.from(body.querySelectorAll<HTMLButtonElement>('[data-group-button]')).find(button => button.dataset.groupButton === focusedGroup);
      button?.focus({ preventScroll: true });
    }
    if (preserveFocus && selection) for (const cell of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      if (cell.dataset.path === selection.path && cell.dataset.property === selection.property && (!selection.point || cell.dataset.group === String(selection.point.group) && cell.dataset.row === String(selection.point.row))) { cell.focus({ preventScroll: true }); break; }
    }
  }
  function renderFooter() {
    const focused = footer.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.summaryProperty : undefined;
    footer.replaceChildren(); footer.style.height = `${Number.parseFloat(win?.getComputedStyle(root).getPropertyValue('--bases-table-row-height') ?? '') || 30}px`;
    const visible = !!options.requestSummary || result.properties.some(property => options.getSummary?.(property, null));
    footer.hidden = !visible; root.setAttribute('aria-rowcount', String(items.length + 1 + (visible ? 1 : 0))); if (!visible) return;
    footer.setAttribute('aria-rowindex', String(items.length + 2));
    for (const property of result.properties) {
      const cell = doc.createElement('div'); cell.className = 'zorid-bases-table-summary-cell'; cell.setAttribute('role', 'gridcell'); cell.dataset.summaryProperty = property;
      const summary = options.getSummary?.(property, null);
      if (summary) { cell.textContent = display(summary.value, result.shared !== undefined); if (summary.label) cell.title = summary.label; }
      else { const placeholder = doc.createElement('span'); placeholder.className = 'placeholder'; placeholder.textContent = 'Summarize'; cell.append(placeholder); }
      if (options.requestSummary && options.summaryOptions?.length) {
        cell.tabIndex = 0; const token = revision;
        const open = (event: MouseEvent) => { if (destroyed || token !== revision || hasActiveEdits()) return; showMenu(event, options.summaryOptions!.map(option => ({ label: option.label, action: () => { Promise.resolve(options.requestSummary?.(property, option.id)).catch(report); } })), cell); };
        cell.addEventListener('click', open); cell.addEventListener('contextmenu', open);
        cell.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(new win!.MouseEvent('click')); } });
      }
      footer.append(cell);
    }
    if (focused) for (const cell of footer.querySelectorAll<HTMLElement>('[data-summary-property]')) if (cell.dataset.summaryProperty === focused) cell.focus({ preventScroll: true });
  }
  function pointOf(cell: HTMLElement): CellPoint {
    return { group: Number(cell.dataset.group), row: Number(cell.dataset.row), column: Number(cell.dataset.column) };
  }
  function paintRange() {
    for (const cell of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      const point = pointOf(cell), selected = !!range && point.group === range.group && point.row >= range.top && point.row <= range.bottom && point.column >= range.start && point.column <= range.end;
      cell.classList.toggle('is-selected', selected); cell.setAttribute('aria-selected', String(selected));
    }
  }
  function selectedBounds(): CellRange | undefined {
    if (range) return range;
    const point = selection?.point;
    return point ? cellBounds(point) : undefined;
  }
  function selectionClipboard(): Record<string, string> | undefined {
    const bounds = selectedBounds(), group = bounds && result.groups[bounds.group];
    if (!bounds || !group || bounds.start < 0 || bounds.end >= result.properties.length) return;
    const properties = result.properties.slice(bounds.start, bounds.end + 1);
    const rows = group.rows.slice(bounds.top, bounds.bottom + 1).map(row => properties.map(property => {
      const value = row.values[property] ?? BASE_NULL;
      return value.type === 'null' || value.type === 'error' ? '' : display(value, result.shared !== undefined);
    }));
    if (!rows.length) return;
    const header = properties.map(property => options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, ''));
    const formats = tableClipboard(header, rows);
    const raw = (value: BaseExpressionValue, depth = 0): unknown => {
      if (depth > 64) throw new Error('The value is too deeply nested to copy.');
      if (value.type === 'null') return null;
      if (value.type === 'string' || value.type === 'number' || value.type === 'boolean') return value.value;
      if (value.type === 'list') return value.value.map(value => raw(value, depth + 1));
      if (value.type === 'object') return Object.fromEntries(Object.entries(value.value).map(([key, value]) => [key, raw(value, depth + 1)]));
      return display(value, result.shared !== undefined);
    };
    formats['obsidian/bases-cells'] = JSON.stringify(group.rows.slice(bounds.top, bounds.bottom + 1).map(row => properties.map(property => {
      const type = property.startsWith('note.') ? 'note' : property.startsWith('formula.') ? 'formula' : 'file';
      return { type, ...(type === 'note' ? { data: raw(row.values[property] ?? BASE_NULL) } : {}) };
    })));
    return formats;
  }
  function textOwnsClipboard(event: Event): boolean {
    const target = event.target as Element | null;
    if (target?.closest?.('input,textarea,[contenteditable="true"]')) return true;
    const selected = doc.getSelection();
    return !!selected && !selected.isCollapsed && !!selected.anchorNode && root.contains(selected.anchorNode);
  }
  async function copySelection() {
    const data = selectionClipboard(); if (!data) return;
    try { if (!win?.navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Use the copy keyboard shortcut.'); await win.navigator.clipboard.writeText(data['text/plain']); }
    catch (error) { if (!destroyed) report(error); }
  }
  async function pasteFromClipboard() {
    const token = revision, bounds = selectedBounds(); if (!bounds || !win?.navigator.clipboard?.readText) return;
    try {
      const text = await win.navigator.clipboard.readText();
      if (destroyed || token !== revision || hasActiveEdits()) return;
      // Keep the original selection: focus changes while clipboard permission is pending must not retarget a paste.
      if (JSON.stringify(selectedBounds()) !== JSON.stringify(bounds)) return;
      pasteValues({ getData: type => type === 'text/plain' ? text : '' });
    } catch (error) { if (!destroyed && token === revision) report(error); }
  }
  function onCopy(event: ClipboardEvent) {
    if (destroyed || event.defaultPrevented || !event.clipboardData || hasActiveEdits() || textOwnsClipboard(event)) return;
    const formats = selectionClipboard(); if (!formats) return;
    for (const [type, text] of Object.entries(formats)) event.clipboardData.setData(type, text);
    event.preventDefault();
  }
  async function commitBatch(edits: readonly BaseTableEdit[]) {
    if (!edits.length || !options.editProperties || hasActiveEdits()) return;
    const token = revision; bulkPending = true; root.setAttribute('aria-busy', 'true'); options.onEditStateChange?.(true);
    try { await options.editProperties(edits); if (!destroyed && token === revision) status.textContent = ''; }
    catch (error) { if (!destroyed && token === revision) report(error); }
    finally { bulkPending = false; root.removeAttribute('aria-busy'); if (!destroyed) options.onEditStateChange?.(hasActiveEdits()); }
  }
  async function clearSelection() {
    const bounds = selectedBounds(); if (!bounds || hasActiveEdits() || !options.editProperties) return;
    const edits: BaseTableEdit[] = [];
    for (let r = bounds.top; r <= bounds.bottom; r++) {
      const row = result.groups[bounds.group]?.rows[r]; if (!row) continue;
      for (let c = bounds.start; c <= bounds.end; c++) {
        const property = result.properties[c], value = row.values[property] ?? BASE_NULL;
        if (/\.md$/i.test(row.path) && property.startsWith('note.') && value.type !== 'null') edits.push({ version: result.version, path: row.path, property, value: BASE_NULL });
      }
    }
    await commitBatch(edits);
  }
  function onPaste(event: ClipboardEvent) {
    if (destroyed || event.defaultPrevented || !event.clipboardData || !options.editProperties || hasActiveEdits() || textOwnsClipboard(event)) return;
    const bounds = selectedBounds(); if (!bounds) return;
    event.preventDefault();
    pasteValues(event.clipboardData);
  }
  function pasteValues(clipboard: Pick<DataTransfer, 'getData'>) {
    try {
      const bounds = selectedBounds(); if (!bounds || hasActiveEdits() || !options.editProperties) return;
      let rows: string[][], rawRows: { type: string; data?: unknown }[][] | undefined;
      const cells = clipboard.getData('obsidian/bases-cells');
      if (cells) {
        if (cells.length > 8_000_000) throw new Error('The pasted table is too large.');
        const parsed: unknown = JSON.parse(cells);
        if (!Array.isArray(parsed) || !parsed.length || parsed.some(row => !Array.isArray(row) || !row.length || row.some(cell => !cell || typeof cell !== 'object' || typeof cell.type !== 'string')) || parsed.some(row => row.length !== parsed[0].length)) throw new Error('Invalid Bases clipboard.');
        rawRows = parsed;
      }
      const table = clipboard.getData('obsidian/table');
      if (rawRows) rows = rawRows.map(row => row.map(cell => cell.type === 'note' ? String(cell.data ?? '') : ''));
      else if (table) {
        if (table.length > 8_000_000) throw new Error('The pasted table is too large.');
        const parsed: unknown = JSON.parse(table);
        if (!parsed || typeof parsed !== 'object' || !('rows' in parsed) || !Array.isArray(parsed.rows) || !parsed.rows.length || parsed.rows.some(row => !Array.isArray(row) || row.some(cell => typeof cell !== 'string'))) throw new Error('Invalid table clipboard.');
        rows = parsed.rows;
        if (rows.some(row => row.length !== rows[0].length)) throw new Error('Paste a rectangular table.');
      } else rows = parseBaseTableTSV(clipboard.getData('text/plain'));
      if (rows.length > 100_000 || (rows[0]?.length ?? 0) > 10_000) throw new Error('The pasted table is too large.');
      const sourceHeight = rows.length, sourceWidth = rows[0]?.length ?? 0;
      if (!sourceWidth) return;
      const selectedHeight = bounds.bottom - bounds.top + 1, selectedWidth = bounds.end - bounds.start + 1;
      const repeat = selectedHeight % sourceHeight === 0 && selectedWidth % sourceWidth === 0;
      const height = repeat ? selectedHeight : sourceHeight, width = repeat ? selectedWidth : sourceWidth;
      const group = result.groups[bounds.group];
      if (!group || bounds.top + height > group.rows.length || bounds.start + width > result.properties.length) throw new Error('The pasted table exceeds the available rows or columns.');
      const edits: BaseTableEdit[] = [];
      for (let r = 0; r < height; r++) {
        const row = group.rows[bounds.top + r];
        for (let c = 0; c < width; c++) {
          const property = result.properties[bounds.start + c], current = row.values[property] ?? BASE_NULL;
          if (!editable(row, property, current)) continue;
          const raw = rows[r % sourceHeight][c % sourceWidth];
          const rawCell = rawRows?.[r % sourceHeight]?.[c % sourceWidth];
          if (rawCell && (rawCell.type !== 'note' || !Object.hasOwn(rawCell, 'data'))) continue;
          const value = rawCell ? baseExpressionValue(rawCell.data) : options.parsePropertyInput ? options.parsePropertyInput(raw, property, row) : parsePrimitiveBaseTableInput(raw, current);
          edits.push({ version: result.version, path: row.path, property, value });
        }
      }
      // Complete validation precedes the host command. The host owns CAS, undo and partial failure reporting.
      void commitBatch(edits);
    } catch (error) { report(error); }
  }
  function onHistory(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || hasActiveEdits() || textOwnsClipboard(event) || !(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase(), callback = key === 'z' ? event.shiftKey ? options.redo : options.undo : key === 'y' ? options.redo : undefined;
    if (!callback) return;
    event.preventDefault(); Promise.resolve().then(callback).catch(report);
  }
  function onPointerDown(event: PointerEvent) {
    if (destroyed || hasActiveEdits() || event.defaultPrevented || event.button !== 0 || event.pointerType === 'touch') return;
    suppressClick = false;
    const target = event.target as Element, cell = target.closest<HTMLElement>('[role="gridcell"]');
    if (!cell || !body.contains(cell) || ((!event.shiftKey || event.metaKey || event.ctrlKey) && target.closest('a,textarea,input:not([type="checkbox"]),[draggable="true"]'))) return;
    stopDrag?.(); suppressClick = false;
    const start = pointOf(cell), token = revision;
    if (event.shiftKey && selection?.point?.group === start.group) {
      anchor = selection.point; range = cellBounds(anchor, start); event.preventDefault();
    } else {
      anchor = start; range = undefined;
      selection = { path: cell.dataset.path!, property: cell.dataset.property!, point: start };
      cell.focus({ preventScroll: true });
    }
    paintRange();
    const dragAnchor = anchor;
    let moved = false;
    const move = (moveEvent: PointerEvent) => {
      if (destroyed || token !== revision || moveEvent.pointerId !== event.pointerId) return;
      const hit = doc.elementFromPoint?.(moveEvent.clientX, moveEvent.clientY) ?? moveEvent.target as Element | null;
      const candidate = hit && typeof hit.closest === 'function' ? hit.closest<HTMLElement>('[role="gridcell"]') : null;
      if (!candidate || !body.contains(candidate)) return;
      const point = pointOf(candidate);
      if (point.group !== dragAnchor.group) return;
      if (!moved && point.row === start.row && point.column === start.column) return;
      if (!moved) doc.getSelection()?.removeAllRanges();
      moved = true; suppressClick = true; range = cellBounds(dragAnchor, point);
      paintRange(); moveEvent.preventDefault();
    };
    const finish = (end: PointerEvent) => { if (end.pointerId === event.pointerId) { if (end.type === 'pointercancel') suppressClick = false; stopDrag?.(); } };
    const blur = () => { suppressClick = false; stopDrag?.(); };
    stopDrag = () => { win?.removeEventListener('blur', blur); win?.removeEventListener('pointermove', move); win?.removeEventListener('pointerup', finish); win?.removeEventListener('pointercancel', finish); stopDrag = undefined; };
    win?.addEventListener('blur', blur); win?.addEventListener('pointermove', move); win?.addEventListener('pointerup', finish); win?.addEventListener('pointercancel', finish);
  }
  let reportedEditState = false;
  const editObserver = win?.MutationObserver ? new win.MutationObserver(() => {
    if (destroyed) return;
    const active = hasActiveEdits();
    if (active !== reportedEditState) { reportedEditState = active; try { options.onEditStateChange?.(active); } catch (error) { report(error); } }
  }) : undefined;
  editObserver?.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-base-editing'] });
  root.addEventListener('copy', onCopy);
  root.addEventListener('paste', onPaste); root.addEventListener('keydown', onHistory);
  root.addEventListener('pointerdown', onPointerDown);
  function schedule() { if (frame === undefined && win) frame = win.requestAnimationFrame(() => { frame = undefined; renderRows(); }); }
  root.addEventListener('scroll', schedule);
  const resize = win && 'ResizeObserver' in win ? new win.ResizeObserver(() => { dimensions(); rebuildItems(); schedule(); }) : undefined;
  resize?.observe(root);
  function update(next: BaseQueryResult) {
    if (destroyed || (initialized && next === result)) return;
    const cancelledDraft = !!editing;
    initialized = true; revision++; stopDrag?.(); stopResize?.(); closeMenu?.(); resizeWidths.clear(); measuredWidths.clear(); for (const cell of [...widgetDisposers.keys()]) releaseCell(cell); for (const cell of root.querySelectorAll('[data-base-editing]')) cell.removeAttribute('data-base-editing'); range = undefined; anchor = undefined; if (selection) selection.point = undefined; editing = undefined; result = next; collapsed.clear();
    status.textContent = cancelledDraft ? 'Results changed. The unfinished edit was cancelled.' : '';
    root.setAttribute('aria-label', result.view.name);
    if (!selection || !result.rows.some(row => row.path === selection!.path) || !result.properties.includes(selection.property)) selection = result.rows[0] && result.properties[0] ? { path: result.rows[0].path, property: result.properties[0] } : undefined;
    dimensions(); rebuildItems();
    const selectedItem = items.find(item => item.row?.path === selection?.path);
    if (selection && selectedItem?.row) selection.point = { group: selectedItem.groupIndex, row: selectedItem.rowIndex, column: result.properties.indexOf(selection.property) };
    renderHeader(); renderRows();
    if (!result.rows.length) status.textContent += `${status.textContent ? ' ' : ''}No results`;
  }
  update(result);
  return { update, refreshLayout() { if (!destroyed) { dimensions(); rebuildItems(); renderRows(); } }, hasActiveEdits, destroy() { if (destroyed) return; destroyed = true; revision++; stopDrag?.(); stopResize?.(); closeMenu?.(); editObserver?.disconnect(); for (const cell of [...widgetDisposers.keys()]) releaseCell(cell); root.removeEventListener('paste', onPaste); root.removeEventListener('keydown', onHistory); root.removeEventListener('copy', onCopy); root.removeEventListener('pointerdown', onPointerDown); editing = undefined; if (frame !== undefined) win?.cancelAnimationFrame(frame); resize?.disconnect(); root.removeEventListener('scroll', schedule); root.remove(); status.remove(); } };
}
