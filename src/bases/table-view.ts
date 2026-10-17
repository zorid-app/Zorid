import { displaySharedBaseValue } from './presentation-common.ts';
import { BASE_NULL, baseValueToString } from './expression.ts';
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
}
export interface BaseTableView { update(result: BaseQueryResult): void; destroy(): void }
type Item = { row: BaseQueryRow; groupIndex: number; rowIndex: number; group?: never } | { group: number; row?: never };
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
  const root = doc.createElement('div'), header = doc.createElement('div'), body = doc.createElement('div');
  const status = doc.createElement('div');
  root.className = 'zorid-bases-table'; root.setAttribute('role', 'grid'); root.setAttribute('aria-multiselectable', 'true'); root.setAttribute('aria-label', options.result.view.name);
  header.className = 'zorid-bases-table-header'; header.setAttribute('role', 'row');
  body.className = 'zorid-bases-table-body'; body.setAttribute('role', 'rowgroup');
  status.className = 'zorid-bases-table-status'; status.setAttribute('role', 'status');
  root.append(header, body); container.append(root, status);
  let result = options.result, items: Item[] = [], rowHeight = 30, template = '';
  let destroyed = false, initialized = false, revision = 0, frame: number | undefined;
  let selection: { path: string; property: string; point?: CellPoint } | undefined;
  let range: CellRange | undefined, anchor: CellPoint | undefined;
  let stopDrag: (() => void) | undefined;
  let suppressClick = false;
  let editing: HTMLElement | undefined;
  const collapsed = new Set<number>();

  function report(error: unknown) {
    status.textContent = error instanceof Error ? error.message : String(error);
    options.onError?.(error);
  }
  function editable(row: BaseQueryRow, property: string, value: BaseExpressionValue) {
    return !!options.editProperty && /\.md$/i.test(row.path) && property.startsWith('note.') && primitiveTypes.has(value.type);
  }
  function dimensions() {
    const base = Number.parseFloat(win?.getComputedStyle(root).getPropertyValue('--bases-table-row-height') ?? '') || 30;
    const multiplier = result.view.rowHeight === 'medium' ? 2 : result.view.rowHeight === 'tall' ? 4 : result.view.rowHeight === 'extra' ? 8 : 1;
    rowHeight = Math.max(1, base) * multiplier;
    root.style.setProperty('--zorid-base-row-height', `${rowHeight}px`);
    const sizes = result.view.columnSize;
    template = result.properties.map(property => {
      const size = sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? (sizes as Record<string, unknown>)[property] : undefined;
      return `${typeof size === 'number' && Number.isFinite(size) ? Math.max(40, size) : 180}px`;
    }).join(' ');
    const total = result.properties.reduce((sum, property) => {
      const size = sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? (sizes as Record<string, unknown>)[property] : undefined;
      return sum + (typeof size === 'number' && Number.isFinite(size) ? Math.max(40, size) : 180);
    }, 0);
    header.style.gridTemplateColumns = template; header.style.minWidth = `${total}px`; body.style.minWidth = `${total}px`;
  }
  function rebuildItems() {
    items = [];
    for (let i = 0; i < result.groups.length; i++) {
      const group = result.groups[i];
      if (group.key !== null) items.push({ group: i });
      if (!collapsed.has(i)) group.rows.forEach((row, rowIndex) => items.push({ row, groupIndex: i, rowIndex }));
    }
    body.style.height = `${items.length * rowHeight}px`;
    root.setAttribute('aria-rowcount', String(items.length + 1)); root.setAttribute('aria-colcount', String(result.properties.length));
  }
  function renderHeader() {
    header.replaceChildren();
    for (const [index, property] of result.properties.entries()) {
      const cell = doc.createElement('div'); cell.className = 'zorid-bases-table-column';
      cell.setAttribute('role', 'columnheader'); cell.setAttribute('aria-colindex', String(index + 1));
      cell.textContent = options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, '');
      cell.title = property; header.append(cell);
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
    editing = cell; const input = multiline ? doc.createElement('textarea') : doc.createElement('input');
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
    const cancel = (restoreFocus = true) => { if (editing !== cell) return; editing = undefined; renderRows(); if (restoreFocus) focusCell(row.path, property); };
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
        await options.editProperty!({ version, path: row.path, property, value: next });
        if (destroyed || revision !== token || editing !== cell) return;
        editing = undefined; status.textContent = ''; renderRows(); if (restoreAfterSave) focusCell(row.path, property);
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
    if (property === 'file.name' || property === 'file.file') {
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
    cell.addEventListener('dblclick', event => { if (current() && !(event.target as Element).closest('a,input,textarea')) startEdit(cell, row, property, value); });
    cell.addEventListener('keydown', event => {
      if (!current() || event.target !== cell || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault(); range = undefined; anchor = undefined; paintRange();
      } else if ((event.key === ' ' && (event.ctrlKey || event.shiftKey)) || (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        const bounds = range ?? cellBounds(point), groupRows = result.groups[point.group].rows.length;
        range = event.key.toLowerCase() === 'a' ? { group: point.group, top: 0, bottom: groupRows - 1, start: 0, end: result.properties.length - 1 }
          : event.ctrlKey ? { ...bounds, top: 0, bottom: groupRows - 1 } : { ...bounds, start: 0, end: result.properties.length - 1 };
        anchor = undefined; paintRange();
      } else if (event.key === 'Enter') {
        event.preventDefault(); if (range) return;
        if (property === 'file.name' || property === 'file.file') options.openFile(row.path, event);
        else startEdit(cell, row, property, value);
      } else if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
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
    return cell;
  }
  function renderRows() {
    if (destroyed) return;
    // Keep an active draft mounted during scrolling. Its position stays in the virtual body.
    const activeRow = editing?.parentElement;
    if (activeRow) {
      activeRow.style.top = `${Number(activeRow.dataset.index) * rowHeight}px`;
      activeRow.style.height = `${rowHeight}px`;
      activeRow.style.gridTemplateColumns = template;
    }
    const focused = doc.activeElement as HTMLElement | null;
    const preserveFocus = focused?.getAttribute('role') === 'gridcell' && body.contains(focused);
    const focusedGroup = focused && body.contains(focused) ? focused.dataset.groupButton : undefined;
    for (const child of Array.from(body.children)) if (child !== activeRow) child.remove();
    const visible = Math.ceil((root.clientHeight || 600) / rowHeight);
    const start = Math.max(0, Math.floor(root.scrollTop / rowHeight) - 5), end = Math.min(items.length, start + visible + 10);
    for (let index = start; index < end; index++) {
      const item = items[index]; if (activeRow?.dataset.index === String(index)) continue;
      const el = doc.createElement('div'); el.dataset.index = String(index); el.style.top = `${index * rowHeight}px`; el.style.height = `${rowHeight}px`;
      el.className = 'zorid-bases-table-row'; el.setAttribute('role', 'row'); el.setAttribute('aria-rowindex', String(index + 2));
      if (item.row) { el.style.gridTemplateColumns = template; result.properties.forEach((property, i) => el.append(renderCell(item.row!, property, i, { group: item.groupIndex, row: item.rowIndex, column: i }))); }
      else {
        el.classList.add('zorid-bases-table-group'); const button = doc.createElement('button'), group = result.groups[item.group], token = revision;
        button.type = 'button'; button.dataset.groupButton = String(item.group); button.setAttribute('aria-expanded', String(!collapsed.has(item.group)));
        button.textContent = `${collapsed.has(item.group) ? '▸' : '▾'} ${group.key?.type === 'null' ? 'Empty' : display(group.key!, result.shared !== undefined)} (${group.rows.length})`;
        button.addEventListener('click', () => { if (destroyed || token !== revision || !body.contains(button) || editing) return; collapsed.has(item.group) ? collapsed.delete(item.group) : collapsed.add(item.group); rebuildItems(); range = undefined; anchor = undefined;
          if (selection && !items.some(item => item.row?.path === selection!.path)) {
            const first = items.find(item => item.row)?.row;
            selection = first && result.properties[0] ? { path: first.path, property: result.properties[0] } : undefined;
          }
          renderRows(); });
        el.append(button);
      }
      body.append(el);
    }
    paintRange();
    if (focusedGroup !== undefined) {
      const button = Array.from(body.querySelectorAll<HTMLButtonElement>('[data-group-button]')).find(button => button.dataset.groupButton === focusedGroup);
      button?.focus({ preventScroll: true });
    }
    if (preserveFocus && selection) for (const cell of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      if (cell.dataset.path === selection.path && cell.dataset.property === selection.property && (!selection.point || cell.dataset.group === String(selection.point.group) && cell.dataset.row === String(selection.point.row))) { cell.focus({ preventScroll: true }); break; }
    }
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
  function onCopy(event: ClipboardEvent) {
    if (destroyed || event.defaultPrevented || !event.clipboardData || editing) return;
    const target = event.target as Element | null;
    if (target?.closest?.('input,textarea,[contenteditable="true"]')) return;
    const textSelection = doc.getSelection();
    if (textSelection && !textSelection.isCollapsed && textSelection.anchorNode && root.contains(textSelection.anchorNode)) return;
    const point = selection?.point ?? (() => {
      const index = items.findIndex(item => item.row?.path === selection?.path), item = items[index];
      return item?.row ? { group: item.groupIndex, row: item.rowIndex, column: result.properties.indexOf(selection!.property) } : undefined;
    })();
    if (!point) return;
    const bounds = range ?? cellBounds(point), group = result.groups[bounds.group];
    if (!group || bounds.start < 0 || bounds.end >= result.properties.length) return;
    const properties = result.properties.slice(bounds.start, bounds.end + 1);
    const rows = group.rows.slice(bounds.top, bounds.bottom + 1).map(row => properties.map(property => {
      const value = row.values[property] ?? BASE_NULL;
      if (value.type === 'null' || value.type === 'error') return '';
      if (value.type === 'namespace') return value.name;
      try { return result.shared !== undefined ? displaySharedBaseValue(value) : baseValueToString(value); } catch { return ''; }
    }));
    if (!rows.length) return;
    const header = properties.map(property => options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, ''));
    for (const [type, text] of Object.entries(tableClipboard(header, rows))) event.clipboardData.setData(type, text);
    event.preventDefault();
  }
  function onPointerDown(event: PointerEvent) {
    if (destroyed || editing || event.defaultPrevented || event.button !== 0 || event.pointerType === 'touch') return;
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
  root.addEventListener('copy', onCopy);
  root.addEventListener('pointerdown', onPointerDown);
  function schedule() { if (frame === undefined && win) frame = win.requestAnimationFrame(() => { frame = undefined; renderRows(); }); }
  root.addEventListener('scroll', schedule);
  const resize = win && 'ResizeObserver' in win ? new win.ResizeObserver(() => { dimensions(); rebuildItems(); schedule(); }) : undefined;
  resize?.observe(root);
  function update(next: BaseQueryResult) {
    if (destroyed || (initialized && next === result)) return;
    const cancelledDraft = !!editing;
    initialized = true; revision++; stopDrag?.(); range = undefined; anchor = undefined; if (selection) selection.point = undefined; editing = undefined; result = next; collapsed.clear();
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
  return { update, destroy() { if (destroyed) return; destroyed = true; revision++; stopDrag?.(); root.removeEventListener('copy', onCopy); root.removeEventListener('pointerdown', onPointerDown); editing = undefined; if (frame !== undefined) win?.cancelAnimationFrame(frame); resize?.disconnect(); root.removeEventListener('scroll', schedule); root.remove(); status.remove(); } };
}
