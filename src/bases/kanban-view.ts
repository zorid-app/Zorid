import { createBaseKanbanColumns } from './kanban-columns.ts';
import type { BaseKanbanGroupOrderRequest } from './kanban-columns.ts';
import { icon } from '../ui/icons.ts';
import { showContextMenu } from '../platform/context-menu.ts';
import { baseValuesEqual, baseValueToString } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import { normalizeBaseProperty } from './query.ts';
import type { BaseQueryGroup, BaseQueryResult, BaseQueryRow } from './query.ts';

export interface BaseKanbanMoveRequest {
  readonly path: string;
  readonly version: BaseQueryResult['version'];
  readonly property: string;
  readonly source: BaseExpressionValue;
  readonly destination: BaseExpressionValue;
}
export interface BaseKanbanViewOptions {
  readonly result: BaseQueryResult;
  readonly openFile: (path: string, event: MouseEvent | KeyboardEvent) => void;
  /** Host must validate version, perform a real vault transaction, and publish a new query result. */
  readonly requestMove?: (request: BaseKanbanMoveRequest) => Promise<void>;
  readonly onError?: (error: unknown, request: BaseKanbanMoveRequest) => void;
  readonly readOnly?: boolean;
  readonly requestGroupOrder?: (request: BaseKanbanGroupOrderRequest) => Promise<void>;
}
export interface BaseKanbanView {
  update(result: BaseQueryResult): void;
  move(path: string, destination: BaseExpressionValue): Promise<boolean>;
  destroy(): void;
}
interface Pending { request: BaseKanbanMoveRequest }
const gap = 8, headerHeight = 40;
function propertyOf(result: BaseQueryResult): string | undefined {
  const group = result.view.groupBy;
  if (!group || typeof group !== 'object' || Array.isArray(group)) return undefined;
  const property = (group as Readonly<Record<string, unknown>>).property;
  return typeof property === 'string' && property ? normalizeBaseProperty(property) : undefined;
}
function equal(a: BaseExpressionValue | null, b: BaseExpressionValue | null): boolean {
  return a === null || b === null ? a === b : baseValuesEqual(a, b, true);
}
function label(value: BaseExpressionValue | null): string {
  if (!value || value.type === 'null') return 'No value';
  try { return baseValueToString(value); } catch { return value.type; }
}

/** Original snapshot-driven Kanban renderer. It never writes data or treats DOM movement as persistence. */
export function createBaseKanbanView(container: HTMLElement, options: BaseKanbanViewOptions): BaseKanbanView {
  const doc = container.ownerDocument;
  const root = doc.createElement('div'), board = doc.createElement('div'), status = doc.createElement('div');
  root.className = 'bases-kanban-view'; root.tabIndex = 0; root.setAttribute('aria-label', options.result.view.name);
  board.className = 'bases-kanban-board'; status.className = 'bases-kanban-status'; status.setAttribute('role', 'status');
  root.append(board, status); container.append(root);
  let result = options.result, destroyed = false, selected: string | undefined;
  const columns = !options.readOnly && options.requestGroupOrder ? createBaseKanbanColumns(root, { result, requestGroupOrder: options.requestGroupOrder, onError(error) { if (!destroyed) status.textContent = error instanceof Error ? error.message : String(error); } }) : undefined;
  let editColumns: HTMLButtonElement | undefined;
  if (columns) {
    const controls = doc.createElement('div'); controls.className = 'bases-kanban-controls';
    editColumns = doc.createElement('button'); editColumns.type = 'button'; editColumns.className = 'bases-kanban-edit-columns';
    editColumns.append(icon('stretch-horizontal', 16, doc), doc.createTextNode('Edit columns'));
    editColumns.setAttribute('aria-haspopup', 'dialog'); editColumns.setAttribute('aria-expanded', 'false');
    editColumns.addEventListener('click', () => { if (!destroyed && editColumns && root.contains(editColumns)) columns.open(editColumns); });
    controls.append(editColumns); root.prepend(controls); root.classList.add('has-column-controls');
  }
  let drag: { path: string; version: BaseQueryResult['version'] } | undefined;
  const pending = new Map<string, Pending>();
  const scrolls = new Map<BaseQueryGroup['key'], number>();
  let rowOrder = new Map<string, number>();
  let groups: readonly BaseQueryGroup[] = [], properties: readonly string[] = [], width = 280, rowHeight = 72;
  const columnScroll = (key: BaseQueryGroup['key']) => {
    for (const [stored, top] of scrolls) if (equal(stored, key)) return top;
    return 0;
  };
  const saveScroll = (key: BaseQueryGroup['key'], top: number) => {
    for (const stored of scrolls.keys()) if (equal(stored, key)) scrolls.delete(stored);
    if (top > 0) scrolls.set(key, top);
  };
  const canMove = (path: string) => {
    const property = propertyOf(result);
    return !!options.requestMove && !options.readOnly && !!property && !property.startsWith('formula.') &&
      (!property.startsWith('file.') || property === 'file.folder') && (property === 'file.folder' || path.endsWith('.md'));
  };
  const locate = (path: string) => groups.find(group => group.rows.some(row => row.path === path));
  function displayedRows(group: BaseQueryGroup): readonly BaseQueryRow[] {
    let rows = group.rows;
    for (const { request } of pending.values()) {
      if (equal(group.key, request.source)) rows = rows.filter(row => row.path !== request.path);
      else if (equal(group.key, request.destination) && !rows.some(row => row.path === request.path)) {
        const row = locate(request.path)?.rows.find(row => row.path === request.path);
        if (!row) continue;
        const index = rows.filter(other => (rowOrder.get(other.path) ?? 0) < (rowOrder.get(row.path) ?? 0)).length;
        rows = [...rows.slice(0, index), row, ...rows.slice(index)];
      }
    }
    return rows;
  }
  const select = (path: string) => {
    selected = path;
    for (const card of board.querySelectorAll<HTMLElement>('.bases-kanban-card')) {
      card.classList.toggle('is-selected', card.dataset.path === path);
      card.setAttribute('aria-selected', String(card.dataset.path === path));
    }
  };
  async function move(path: string, destination: BaseExpressionValue): Promise<boolean> {
    if (destroyed || pending.has(path) || !canMove(path)) return false;
    const source = locate(path), target = groups.find(group => equal(group.key, destination));
    if (!source?.key || !target?.key || equal(source.key, target.key)) return false;
    if (propertyOf(result) === 'file.folder' && target.key.type !== 'string') return false;
    const request: BaseKanbanMoveRequest = Object.freeze({ path, version: result.version, property: propertyOf(result)!, source: source.key, destination: target.key });
    const operation = { request }; pending.set(path, operation); status.textContent = ''; render();
    try {
      await options.requestMove!(request);
      // The preview remains pending until the host publishes an authoritative move.
      return !destroyed && propertyOf(result) === request.property &&
        (pending.get(path) === operation || equal(locate(path)?.key ?? null, request.destination));
    } catch (error) {
      if (!destroyed && pending.get(path) === operation) {
        pending.delete(path); status.textContent = `Could not move ${path}: ${error instanceof Error ? error.message : String(error)}`;
        render(); options.onError?.(error, request);
      }
      return false;
    }
  }
  function card(row: BaseQueryRow, index: number): HTMLElement {
    const item = doc.createElement('div'); item.className = 'bases-kanban-card'; item.dataset.path = row.path;
    item.style.top = `${index * rowHeight}px`; item.style.height = `${rowHeight - gap}px`;
    item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(selected === row.path));
    item.classList.toggle('is-selected', selected === row.path);
    item.classList.toggle('is-pending', pending.has(row.path)); item.setAttribute('aria-busy', String(pending.has(row.path)));
    item.draggable = canMove(row.path) && !pending.has(row.path);
    const title = doc.createElement('div'); title.className = 'bases-kanban-card-title';
    title.textContent = row.path.split('/').pop()?.replace(/\.md$/, '') ?? row.path; item.append(title);
    for (const property of properties) {
      const value = doc.createElement('div'); value.className = 'bases-kanban-card-property';
      value.dataset.property = property; value.textContent = label(row.values[property] ?? null); value.title = `${property}: ${value.textContent}`; item.append(value);
    }
    item.addEventListener('click', event => { if (destroyed || !root.contains(item)) return; select(row.path); options.openFile(row.path, event); });
    item.addEventListener('auxclick', event => { if (!destroyed && root.contains(item) && event.button === 1) { event.preventDefault(); select(row.path); options.openFile(row.path, event); } });
    let ownedDrag: typeof drag;
    item.addEventListener('dragstart', event => {
      if (destroyed || !root.contains(item) || !item.draggable || !event.dataTransfer) { event.preventDefault(); return; }
      drag = ownedDrag = { path: row.path, version: result.version }; select(row.path);
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.path);
    });
    item.addEventListener('dragend', () => { if (ownedDrag && drag === ownedDrag) drag = undefined; ownedDrag = undefined; });
    return item;
  }
  function renderRows(body: HTMLElement, group: BaseQueryGroup, requestedTop = body.scrollTop) {
    const rows = displayedRows(group);
    const height = body.clientHeight || Math.max(100, (root.clientHeight || 600) - headerHeight);
    const space = doc.createElement('div'); space.className = 'bases-kanban-column-space'; space.style.height = `${rows.length * rowHeight}px`;
    body.replaceChildren(space);
    body.scrollTop = Math.min(requestedTop, Math.max(0, rows.length * rowHeight - height));
    saveScroll(group.key, body.scrollTop);
    const start = Math.max(0, Math.floor(body.scrollTop / rowHeight) - 2);
    const end = Math.min(rows.length, Math.ceil((body.scrollTop + height) / rowHeight) + 2);
    for (let i = start; i < end; i++) space.append(card(rows[i], i));
  }
  function render() {
    if (destroyed) return;
    const viewport = root.clientWidth || 900, stride = width + gap;
    root.scrollLeft = Math.min(root.scrollLeft, Math.max(0, groups.length * stride - gap - viewport));
    const start = Math.max(0, Math.floor(root.scrollLeft / stride) - 1), end = Math.min(groups.length, Math.ceil((root.scrollLeft + viewport) / stride) + 1);
    board.style.width = `${Math.max(0, groups.length * stride - gap)}px`;
    const nodes: HTMLElement[] = [];
    for (let index = start; index < end; index++) {
      const group = groups[index], column = doc.createElement('section'); column.className = 'bases-kanban-column';
      column.style.left = `${index * stride}px`; column.style.width = `${width}px`;
      const heading = doc.createElement('div'); heading.className = 'bases-kanban-column-header'; heading.textContent = label(group.key);
      const count = doc.createElement('span'); count.className = 'bases-kanban-column-count'; count.textContent = String(group.rows.length); heading.append(count);
      const body = doc.createElement('div'); body.className = 'bases-kanban-column-body'; body.setAttribute('role', 'listbox'); body.setAttribute('aria-label', label(group.key));
      column.append(heading, body); nodes.push(column);
      if (columns && group.key && (propertyOf(result)?.startsWith('note.') || propertyOf(result) === 'file.folder')) heading.addEventListener('contextmenu', event => {
        if (destroyed || !root.contains(heading)) return;
        event.preventDefault(); const version = result.version;
        void showContextMenu(event, [{ id: 'hide', label: 'Hide column' }, { id: 'edit', label: 'Edit columns' }], { document: doc }).then(action => {
          if (destroyed || result.version !== version || !root.contains(heading)) return;
          if (action === 'hide') return columns.hide(group.key!);
          if (action === 'edit' && editColumns) columns.open(editColumns);
        }).catch(error => { if (!destroyed) status.textContent = error instanceof Error ? error.message : String(error); });
      });
      body.addEventListener('scroll', () => { if (destroyed || !root.contains(body)) return; saveScroll(group.key, body.scrollTop); renderRows(body, group); });
      column.addEventListener('dragover', event => {
        if (!destroyed && root.contains(column) && drag && drag.version === result.version && canMove(drag.path) && group.key) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }
      });
      column.addEventListener('drop', event => {
        if (destroyed || !root.contains(column)) return;
        const source = drag; drag = undefined;
        if (!source || source.version !== result.version || !group.key) return;
        event.preventDefault(); void move(source.path, group.key);
      });
    }
    if (!groups.length) {
      const empty = doc.createElement('div'); empty.className = 'bases-kanban-empty'; empty.textContent = propertyOf(result) ? 'No columns' : 'Group by a property to use Kanban'; nodes.push(empty);
    }
    board.replaceChildren(...nodes);
    // A detached scrolling element may clamp scrollTop; restore only once mounted.
    for (let i = 0; i < nodes.length && start + i < groups.length; i++) {
      const body = nodes[i].querySelector<HTMLElement>('.bases-kanban-column-body');
      if (body) renderRows(body, groups[start + i], columnScroll(groups[start + i].key));
    }
  }
  function update(next: BaseQueryResult) {
    if (destroyed) return;
    result = next; drag = undefined; columns?.update(next); if (editColumns) editColumns.disabled = !propertyOf(next); root.setAttribute('aria-label', result.view.name);
    rowOrder = new Map(result.rows.map((row, index) => [row.path, index]));
    const queryGroups = result.groups.filter(group => group.key !== null);
    if (!propertyOf(result)) groups = [];
    else if (Array.isArray(result.view.groupOrder)) {
      groups = result.groupOptions.filter(option => option.listed).map(option =>
        queryGroups.find(group => equal(group.key, option.key) || (option.key.type === 'string' && option.key.value === label(group.key))) ?? { key: option.key, rows: [] });
    } else groups = [...queryGroups.filter(group => group.key?.type === 'null'), ...queryGroups.filter(group => group.key?.type !== 'null')];
    properties = result.properties.filter(property => property !== 'file.name');
    width = typeof result.view.columnWidth === 'number' && Number.isFinite(result.view.columnWidth) ? Math.max(200, Math.min(500, result.view.columnWidth)) : 280;
    rowHeight = 48 + properties.length * 24 + gap;
    for (const [path, operation] of pending) {
      if (propertyOf(result) !== operation.request.property || !equal(locate(path)?.key ?? null, operation.request.source) || !groups.some(group => equal(group.key, operation.request.destination))) pending.delete(path);
    }
    if (selected && !locate(selected)) selected = undefined;
    const retainedScrolls = [...scrolls].filter(([key]) => groups.some(group => equal(group.key, key)));
    scrolls.clear(); for (const [key, top] of retainedScrolls) scrolls.set(key, top);
    render();
  }
  const onScroll = () => render(); root.addEventListener('scroll', onScroll);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { selected = undefined; render(); return; }
    if (!selected) return;
    const group = groups.find(group => displayedRows(group).some(row => row.path === selected)); if (!group) return;
    const rows = displayedRows(group), index = rows.findIndex(row => row.path === selected);
    if (event.key === 'Enter') { event.preventDefault(); options.openFile(selected, event); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault(); const row = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (row) { selected = row.path; saveScroll(group.key, Math.max(0, rows.indexOf(row) * rowHeight - rowHeight)); render(); }
    }
  };
  root.addEventListener('keydown', onKey);
  const Observer = doc.defaultView?.ResizeObserver;
  const observer = Observer ? new Observer(() => render()) : undefined; observer?.observe(root);
  update(result);
  return { update, move, destroy() { if (destroyed) return; destroyed = true; columns?.destroy(); pending.clear(); drag = undefined; observer?.disconnect(); root.removeEventListener('scroll', onScroll); root.removeEventListener('keydown', onKey); root.remove(); } };
}
