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
type Item = { row: BaseQueryRow; group?: never } | { group: number; row?: never };
const primitiveTypes = new Set(['null', 'string', 'number', 'boolean']);
function display(value: BaseExpressionValue): string {
  if (value.type === 'null') return '';
  if (value.type === 'namespace') return value.name;
  try { return baseValueToString(value); }
  catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
}

/** Original Table presentation. Query evaluation and all mutations belong to the host. */
export function createBaseTableView(container: HTMLElement, options: BaseTableOptions): BaseTableView {
  const doc = container.ownerDocument, win = doc.defaultView;
  const root = doc.createElement('div'), header = doc.createElement('div'), body = doc.createElement('div');
  const status = doc.createElement('div');
  root.className = 'zorid-bases-table'; root.setAttribute('role', 'grid'); root.setAttribute('aria-label', options.result.view.name);
  header.className = 'zorid-bases-table-header'; header.setAttribute('role', 'row');
  body.className = 'zorid-bases-table-body'; body.setAttribute('role', 'rowgroup');
  status.className = 'zorid-bases-table-status'; status.setAttribute('role', 'status');
  root.append(header, body); container.append(root, status);
  let result = options.result, items: Item[] = [], rowHeight = 30, template = '';
  let destroyed = false, initialized = false, revision = 0, frame: number | undefined;
  let selection: { path: string; property: string } | undefined;
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
      if (!collapsed.has(i)) for (const row of group.rows) items.push({ row });
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
  function focusCell(path: string, property: string) {
    selection = { path, property };
    const index = items.findIndex(item => item.row?.path === path);
    if (index < 0) return;
    const top = index * rowHeight;
    if (top < root.scrollTop) root.scrollTop = top;
    else if (top + rowHeight > root.scrollTop + root.clientHeight - 30) root.scrollTop = top + rowHeight - Math.max(rowHeight, root.clientHeight - 30);
    renderRows();
    for (const cell of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      if (cell.dataset.path === path && cell.dataset.property === property) { cell.focus(); break; }
    }
  }
  function startEdit(cell: HTMLElement, row: BaseQueryRow, property: string, value: BaseExpressionValue, toggle = false) {
    if (destroyed || editing || !editable(row, property, value)) return;
    const token = revision, version = result.version;
    const multiline = value.type === 'string' && /[\r\n]/.test(value.value);
    editing = cell; const input = multiline ? doc.createElement('textarea') : doc.createElement('input');
    input.className = 'zorid-bases-table-input';
    input.setAttribute('aria-label', options.getPropertyLabel?.(property) ?? property);
    // Keep number text uncoerced while editing, so malformed input cannot become null/zero.
    if (!multiline) (input as HTMLInputElement).type = value.type === 'boolean' ? 'checkbox' : 'text';
    if (value.type === 'boolean') (input as HTMLInputElement).checked = toggle ? !value.value : value.value;
    else input.value = value.type === 'null' ? '' : display(value);
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
  function renderCell(row: BaseQueryRow, property: string, index: number) {
    const cell = doc.createElement('div'), value = row.values[property] ?? BASE_NULL, token = revision;
    const current = () => !destroyed && token === revision && body.contains(cell);
    cell.className = 'zorid-bases-table-cell'; cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-colindex', String(index + 1));
    cell.dataset.path = row.path; cell.dataset.property = property;
    cell.tabIndex = selection?.path === row.path && selection.property === property ? 0 : -1;
    cell.setAttribute('aria-readonly', String(!editable(row, property, value)));
    if (property === 'file.name' || property === 'file.file') {
      const link = doc.createElement('a'); link.className = 'internal-link'; link.href = '#'; link.tabIndex = -1;
      link.textContent = display(value) || row.path; link.title = row.path;
      link.addEventListener('click', event => { event.preventDefault(); if (current()) options.openFile(row.path, event); });
      link.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); if (current()) options.openFile(row.path, event); } });
      cell.append(link);
    } else if (value.type === 'boolean') {
      const checkbox = doc.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = value.value; checkbox.disabled = !editable(row, property, value); checkbox.tabIndex = -1;
      checkbox.setAttribute('aria-label', property);
      checkbox.addEventListener('click', event => { event.preventDefault(); if (current()) startEdit(cell, row, property, value, true); });
      cell.append(checkbox);
    } else {
      cell.textContent = display(value); if (value.type === 'error') cell.classList.add('is-error');
    }
    cell.addEventListener('focus', () => {
      selection = { path: row.path, property };
      for (const other of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) other.tabIndex = other === cell ? 0 : -1;
    });
    cell.addEventListener('click', event => { if (event.target === cell && !editing) cell.focus(); });
    cell.addEventListener('dblclick', event => { if (current() && !(event.target as Element).closest('a,input')) startEdit(cell, row, property, value); });
    cell.addEventListener('keydown', event => {
      if (!current() || event.target !== cell || event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (property === 'file.name' || property === 'file.file') options.openFile(row.path, event);
        else startEdit(cell, row, property, value);
      } else if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
        event.preventDefault(); const rowIndex = items.findIndex(item => item.row === row);
        let target = rowIndex, column = index;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const step = event.key === 'ArrowUp' ? -1 : 1; target += step;
          while (target >= 0 && target < items.length && !items[target].row) target += step;
        } else if (event.key === 'ArrowLeft') column--;
        else if (event.key === 'ArrowRight') column++;
        else column = event.key === 'Home' ? 0 : result.properties.length - 1;
        const next = items[target]?.row;
        if (next && column >= 0 && column < result.properties.length) focusCell(next.path, result.properties[column]);
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
      if (item.row) { el.style.gridTemplateColumns = template; result.properties.forEach((property, i) => el.append(renderCell(item.row!, property, i))); }
      else {
        el.classList.add('zorid-bases-table-group'); const button = doc.createElement('button'), group = result.groups[item.group], token = revision;
        button.type = 'button'; button.dataset.groupButton = String(item.group); button.setAttribute('aria-expanded', String(!collapsed.has(item.group)));
        button.textContent = `${collapsed.has(item.group) ? '▸' : '▾'} ${group.key?.type === 'null' ? 'Empty' : display(group.key!)} (${group.rows.length})`;
        button.addEventListener('click', () => { if (destroyed || token !== revision || !body.contains(button) || editing) return; collapsed.has(item.group) ? collapsed.delete(item.group) : collapsed.add(item.group); rebuildItems();
          if (selection && !items.some(item => item.row?.path === selection!.path)) {
            const first = items.find(item => item.row)?.row;
            selection = first && result.properties[0] ? { path: first.path, property: result.properties[0] } : undefined;
          }
          renderRows(); });
        el.append(button);
      }
      body.append(el);
    }
    if (focusedGroup !== undefined) {
      const button = Array.from(body.querySelectorAll<HTMLButtonElement>('[data-group-button]')).find(button => button.dataset.groupButton === focusedGroup);
      button?.focus({ preventScroll: true });
    }
    if (preserveFocus && selection) for (const cell of body.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      if (cell.dataset.path === selection.path && cell.dataset.property === selection.property) { cell.focus({ preventScroll: true }); break; }
    }
  }
  function schedule() { if (frame === undefined && win) frame = win.requestAnimationFrame(() => { frame = undefined; renderRows(); }); }
  root.addEventListener('scroll', schedule);
  const resize = win && 'ResizeObserver' in win ? new win.ResizeObserver(() => { dimensions(); rebuildItems(); schedule(); }) : undefined;
  resize?.observe(root);
  function update(next: BaseQueryResult) {
    if (destroyed || (initialized && next === result)) return;
    const cancelledDraft = !!editing;
    initialized = true; revision++; editing = undefined; result = next; collapsed.clear();
    status.textContent = cancelledDraft ? 'Results changed. The unfinished edit was cancelled.' : '';
    root.setAttribute('aria-label', result.view.name);
    if (!selection || !result.rows.some(row => row.path === selection!.path) || !result.properties.includes(selection.property)) selection = result.rows[0] && result.properties[0] ? { path: result.rows[0].path, property: result.properties[0] } : undefined;
    dimensions(); rebuildItems(); renderHeader(); renderRows();
    if (!result.rows.length) status.textContent += `${status.textContent ? ' ' : ''}No results`;
  }
  update(result);
  return { update, destroy() { if (destroyed) return; destroyed = true; revision++; editing = undefined; if (frame !== undefined) win?.cancelAnimationFrame(frame); resize?.disconnect(); root.removeEventListener('scroll', schedule); root.remove(); status.remove(); } };
}
