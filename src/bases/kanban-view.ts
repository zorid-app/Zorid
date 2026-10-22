import { disposePresentationResources, reportPresentationError, mountBaseProperty, propertyValue, displaySharedBaseValue, sameBasePresentationGroup, sharedBaseGroupKeyId } from './presentation-common.ts';
import type { BaseCardsViewOptions } from './cards-view.ts';
import { baseCardsSettings } from './cards-view.ts';
import type { BasePresentationOptions } from './presentation-common.ts';
import { createBaseKanbanColumns, matchesBaseGroupKey } from './kanban-columns.ts';
import type { BaseKanbanGroupOrderRequest } from './kanban-columns.ts';
import { icon } from '../ui/icons.ts';
import { showContextMenu } from '../platform/context-menu.ts';
import { baseValueToString } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import { baseEditValue } from './view-actions.ts';
import { normalizeBaseProperty } from './query.ts';
import type { BaseQueryGroup, BaseQueryResult, BaseQueryRow } from './query.ts';

export interface BaseKanbanMoveRequest {
  readonly path: string;
  readonly version: BaseQueryResult['version'];
  readonly property: string;
  readonly source: BaseExpressionValue;
  readonly destination: BaseExpressionValue;
  /** Required for shared results; opaque authoritative group identities. */
  readonly sourceKeyId?: string;
  readonly destinationKeyId?: string;
}
export interface BaseKanbanCreateRequest {
  readonly version: BaseQueryResult['version'];
  readonly property: string;
  readonly group: BaseExpressionValue;
  readonly groupKeyId?: string;
  readonly anchor?: HTMLElement;
}
export interface BaseKanbanViewOptions extends Omit<BaseCardsViewOptions, 'onError'> {
  /** Host must validate version, perform a real vault transaction, and publish a new query result. */
  readonly requestMove?: (request: BaseKanbanMoveRequest) => Promise<void>;
  readonly onError?: (error: unknown, request: BaseKanbanMoveRequest) => void;
  readonly readOnly?: boolean;
  readonly createItem?: (request: BaseKanbanCreateRequest) => Promise<void>;
  readonly onPresentationError?: (error: unknown) => void;
  /** The shared toolbar supplies Group in full sessions; standalone renderer hosts may expose its fallback. */
  readonly showColumnControls?: boolean;
  readonly requestGroupOrder?: (request: BaseKanbanGroupOrderRequest) => Promise<void>;
}
export interface BaseKanbanView {
  update(result: BaseQueryResult): void;
  move(path: string, destination: BaseExpressionValue): Promise<boolean>;
  hasActiveEdits(): boolean;
  refreshLayout(): void;
  destroy(): void;
}
interface Pending { request: BaseKanbanMoveRequest }
interface ColumnDrag { group: BaseQueryGroup; version: BaseQueryResult['version']; original: readonly BaseQueryGroup[]; preview: readonly BaseQueryGroup[] }
const gap = 8, headerHeight = 40;
function propertyOf(result: BaseQueryResult): string | undefined {
  const group = result.view.groupBy;
  if (!group || typeof group !== 'object' || Array.isArray(group)) return undefined;
  const property = (group as Readonly<Record<string, unknown>>).property;
  return typeof property === 'string' && property ? normalizeBaseProperty(property) : undefined;
}

function label(value: BaseExpressionValue | null, shared = false): string {
  if (!value || value.type === 'null') return 'No value';
  try { return shared ? displaySharedBaseValue(value) : baseValueToString(value); } catch { return value.type; }
}

/** Original snapshot-driven Kanban renderer. It never writes data or treats DOM movement as persistence. */
export function createBaseKanbanView(container: HTMLElement, options: BaseKanbanViewOptions): BaseKanbanView {
  const doc = container.ownerDocument;
  const root = doc.createElement('div'), board = doc.createElement('div'), status = doc.createElement('div');
  root.className = 'bases-kanban-view bases-kanban-container'; root.tabIndex = 0; root.setAttribute('aria-label', options.result.view.name);
  board.className = 'bases-kanban-board'; status.className = 'bases-kanban-status'; status.setAttribute('role', 'status');
  root.append(board, status); container.append(root);
  let result = options.result, destroyed = false, selected: string | undefined;
  let deferredResult: BaseQueryResult | undefined;
  let epoch = 0;
  const rowResources = new Map<HTMLElement, (() => void)[]>();
  const presentation: BasePresentationOptions = { ...options, onError: options.onPresentationError,
    ...(options.readOnly ? { editProperty: undefined } : {}) };
  const hasActiveEdits = () => !!root.querySelector('[data-base-editing]');
  let previousEditing = false;
  const editStateChanged = () => {
    const active = hasActiveEdits();
    if (active !== previousEditing) { previousEditing = active; options.onEditStateChange?.(active); }
    if (!active && deferredResult) { const next = deferredResult; deferredResult = undefined; update(next); }
  };
  const editObserver = doc.defaultView?.MutationObserver ? new doc.defaultView.MutationObserver(editStateChanged) : undefined;
  editObserver?.observe(board, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-base-editing'] });
  const releaseRows = (body?: HTMLElement, except?: HTMLElement) => {
    for (const [item, resources] of rowResources) if (item !== except && (!body || body.contains(item))) {
      disposePresentationResources(resources, presentation); rowResources.delete(item);
    }
  };
  const equal = (a: BaseExpressionValue | null, b: BaseExpressionValue | null) => sameBasePresentationGroup(result, a, b);
  const requestGroupIs = (group: BaseQueryGroup | undefined, request: BaseKanbanMoveRequest, side: 'source' | 'destination'): boolean =>
    !!group && (result.shared !== undefined ? typeof request[`${side}KeyId`] === 'string' && group.sharedKeyId === request[`${side}KeyId`] : equal(group.key, request[side]));
  const columns = !options.readOnly && options.requestGroupOrder ? createBaseKanbanColumns(root, { result, requestGroupOrder: options.requestGroupOrder, onError(error) { if (!destroyed) status.textContent = error instanceof Error ? error.message : String(error); } }) : undefined;
  let editColumns: HTMLButtonElement | undefined;
  if (columns && options.showColumnControls !== false) {
    const controls = doc.createElement('div'); controls.className = 'bases-kanban-controls';
    editColumns = doc.createElement('button'); editColumns.type = 'button'; editColumns.className = 'bases-kanban-edit-columns';
    editColumns.append(icon('stretch-horizontal', 16, doc), doc.createTextNode('Edit columns'));
    editColumns.setAttribute('aria-haspopup', 'dialog'); editColumns.setAttribute('aria-expanded', 'false');
    editColumns.addEventListener('click', () => { if (!destroyed && editColumns && root.contains(editColumns)) columns.open(editColumns); });
    controls.append(editColumns); root.prepend(controls); root.classList.add('has-column-controls');
  }
  let drag: { path: string; version: BaseQueryResult['version'] } | undefined;
  const pending = new Map<string, Pending>();
  let columnDrag: ColumnDrag | undefined;
  let pendingColumnOrder: { snapshot: BaseQueryResult; groups: readonly BaseQueryGroup[] } | undefined;
  const mountedColumns = new Map<HTMLElement, BaseQueryGroup>();
  let groupOrderPending = false;
  const scrolls = new Map<BaseQueryGroup['key'] | string, number>();
  let rowOrder = new Map<string, number>();
  let groups: readonly BaseQueryGroup[] = [], properties: readonly string[] = [], width = 280, rowHeight = 72;
  const columnScroll = (key: BaseQueryGroup['key']) => {
    if (result.shared !== undefined) return scrolls.get(sharedBaseGroupKeyId(result, key) ?? key) ?? 0;
    for (const [stored, top] of scrolls) if (typeof stored !== 'string' && equal(stored, key)) return top;
    return 0;
  };
  const saveScroll = (key: BaseQueryGroup['key'], top: number) => {
    if (result.shared !== undefined) {
      const id = sharedBaseGroupKeyId(result, key);
      if (typeof id !== 'string') return;
      scrolls.delete(id); if (top > 0) scrolls.set(id, top); return;
    }
    for (const stored of scrolls.keys()) if (typeof stored !== 'string' && equal(stored, key)) scrolls.delete(stored);
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
      if (requestGroupIs(group, request, 'source')) rows = rows.filter(row => row.path !== request.path);
      else if (requestGroupIs(group, request, 'destination') && !rows.some(row => row.path === request.path)) {
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
    if (result.shared !== undefined && (typeof source.sharedKeyId !== 'string' || typeof target.sharedKeyId !== 'string')) return false;
    const request: BaseKanbanMoveRequest = Object.freeze({ path, version: result.version, property: propertyOf(result)!, source: source.key, destination: target.key,
      ...(result.shared !== undefined ? { sourceKeyId: source.sharedKeyId!, destinationKeyId: target.sharedKeyId! } : {}) });
    const operation = { request }; pending.set(path, operation); status.textContent = ''; render();
    try {
      await options.requestMove!(request);
      // The preview remains pending until the host publishes an authoritative move.
      return !destroyed && propertyOf(result) === request.property &&
        (pending.get(path) === operation || requestGroupIs(locate(path), request, 'destination'));
    } catch (error) {
      if (!destroyed && pending.get(path) === operation) {
        pending.delete(path); status.textContent = `Could not move ${path}: ${error instanceof Error ? error.message : String(error)}`;
        render(); options.onError?.(error, request);
      }
      return false;
    }
  }
  function paintColumnPreview() {
    const displayed = columnDrag?.preview ?? pendingColumnOrder?.groups ?? groups;
    for (const [element, group] of mountedColumns) element.style.left = `${displayed.indexOf(group) * (width + gap)}px`;
    board.querySelector('.bases-kanban-column-drop-placeholder')?.remove();
    if (columnDrag) {
      const placeholder = doc.createElement('div'); placeholder.className = 'bases-kanban-column-drop-placeholder';
      placeholder.style.left = `${displayed.indexOf(columnDrag.group) * (width + gap)}px`; placeholder.style.width = `${width}px`;
      board.append(placeholder);
    }
  }
  function previewColumnDrop(group: BaseQueryGroup, event: DragEvent) {
    const source = columnDrag;
    if (!source || source.version !== result.version || hasActiveEdits()) return;
    const bounds = board.getBoundingClientRect();
    const target = bounds.width > 0 ? Math.max(0, Math.min(source.original.length - 1, Math.floor((event.clientX - bounds.left) / (width + gap))))
      : source.original.indexOf(group);
    if (target < 0) return;
    const next = source.original.filter(item => item !== source.group); next.splice(target, 0, source.group);
    source.preview = next; paintColumnPreview();
  }
  function commitColumnDrop(group: BaseQueryGroup, event: DragEvent) {
    const source = columnDrag;
    if (destroyed || groupOrderPending || !source || source.version !== result.version || hasActiveEdits()) return;
    event.preventDefault(); event.stopPropagation();
    previewColumnDrop(group, event); columnDrag = undefined;
    const reordered = source.preview;
    if (reordered.every((item, index) => item === groups[index])) { paintColumnPreview(); return; }
    const snapshot = result, storedOrder = Array.isArray(snapshot.view.groupOrder) ? snapshot.view.groupOrder : undefined;
    const listed = snapshot.groupOptions.filter(option => option.listed);
    const savedGroup = (item: BaseQueryGroup) => {
      const ordinals = listed.flatMap((option, index) => (snapshot.shared !== undefined ? option.sharedKeyId === item.sharedKeyId
        : item.key && matchesBaseGroupKey(option.key, item.key)) ? [index] : []);
      return storedOrder && ordinals.length ? ordinals.filter(index => index < storedOrder.length).map(index => storedOrder[index]) : [baseEditValue(item.key!)];
    };
    const operation = { snapshot, groups: reordered }; pendingColumnOrder = operation; groupOrderPending = true;
    paintColumnPreview();
    void (async () => {
      try { await options.requestGroupOrder!({ version: snapshot.version, property: propertyOf(snapshot)!, order: reordered.flatMap(savedGroup) }); }
      catch (error) {
        if (!destroyed && pendingColumnOrder === operation && result === snapshot) {
          pendingColumnOrder = undefined; paintColumnPreview();
          status.textContent = error instanceof Error ? error.message : String(error); reportPresentationError(presentation, error);
        }
      } finally { groupOrderPending = false; }
    })();
  }
  function card(row: BaseQueryRow, index: number): HTMLElement {
    const item = doc.createElement('div'); item.className = 'bases-kanban-card'; item.dataset.path = row.path;
    item.dataset.rowIndex = String(index); item.style.top = `${index * rowHeight}px`; item.style.height = `${rowHeight - gap}px`;
    item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(selected === row.path));
    item.classList.toggle('is-selected', selected === row.path);
    item.classList.toggle('is-pending', pending.has(row.path)); item.setAttribute('aria-busy', String(pending.has(row.path)));
    item.draggable = canMove(row.path) && !pending.has(row.path);
    item.tabIndex = 0;
    const owner = epoch, snapshot = result, resources: (() => void)[] = [];
    rowResources.set(item, resources);
    const current = () => !destroyed && owner === epoch && root.contains(item);
    const settings = baseCardsSettings(snapshot);
    if (settings.image) {
      const cover = doc.createElement('div'); cover.className = 'bases-kanban-card-cover';
      cover.style.height = `${width * (typeof snapshot.view.imageAspectRatio === 'number' && snapshot.view.imageAspectRatio > 0 ? settings.imageAspectRatio : .5)}px`;
      item.append(cover);
      if (options.loadThumbnail) {
        const controller = new AbortController(); resources.push(() => controller.abort());
        Promise.resolve().then(() => current() ? options.loadThumbnail!({ row, property: settings.image!,
          value: propertyValue(row, settings.image!), version: snapshot.version, signal: controller.signal }) : null).then(resource => {
          if (!resource) return;
          if (!current()) { disposePresentationResources([() => resource.dispose()], presentation); return; }
          resources.push(() => resource.dispose());
          const image = doc.createElement('img'); image.alt = ''; image.draggable = false;
          image.style.objectFit = settings.imageFit; image.src = resource.url; cover.append(image);
        }).catch(error => { if (current() && !controller.signal.aborted) reportPresentationError(presentation, error); });
      }
    }
    const values = doc.createElement('div'); values.className = 'bases-kanban-card-properties'; item.append(values);
    properties.forEach((property, index) => {
      const cell = doc.createElement('div'); cell.className = `bases-kanban-card-property${index === 0 ? ' mod-title bases-kanban-card-title' : ''}`;
      cell.dataset.property = property;
      const name = doc.createElement('div'); name.className = 'bases-kanban-card-label';
      name.textContent = options.getPropertyLabel?.(property) ?? property.replace(/^(?:note|file|formula)\./, '');
      const line = doc.createElement('div'); line.className = 'bases-kanban-card-line';
      cell.append(name, line); values.append(cell);
      resources.push(mountBaseProperty(line, row, property, snapshot, presentation, current));
    });
    const activate = (event: MouseEvent) => {
      if (!current() || event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
      if ((event.target as Element | null)?.closest('a,input,textarea,select,button,[contenteditable="true"]')) return;
      const selection = doc.defaultView?.getSelection();
      if (selection && !selection.isCollapsed) for (let index = 0; index < selection.rangeCount; index++) {
        const range = selection.getRangeAt(index);
        if (item.contains(range.startContainer) || item.contains(range.endContainer)) return;
      }
      if (doc.activeElement !== item && item.contains(doc.activeElement)) return;
      event.preventDefault(); select(row.path); options.openFile(row.path, event);
    };
    item.addEventListener('click', activate); item.addEventListener('auxclick', activate);
    item.addEventListener('focus', () => { if (current()) select(row.path); });
    if (options.contextMenu) item.addEventListener('contextmenu', event => {
      if (current() && !event.defaultPrevented) { event.preventDefault(); options.contextMenu!(row, event); }
    });
    if (options.hoverFile) item.addEventListener('mouseenter', event => { if (current() && !drag) options.hoverFile!(row, event); });
    let ownedDrag: typeof drag;
    item.addEventListener('dragstart', event => {
      if (destroyed || !root.contains(item) || !item.draggable || !canMove(row.path) || hasActiveEdits() || !event.dataTransfer) { event.preventDefault(); return; }
      drag = ownedDrag = { path: row.path, version: result.version }; select(row.path);
      item.classList.add('is-being-dragged');
      event.dataTransfer.setDragImage?.(item, Math.min(event.offsetX, width), Math.min(event.offsetY, rowHeight));
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.path);
      options.dragFile?.(row, event);
    });
    item.addEventListener('dragend', () => { if (ownedDrag && drag === ownedDrag) { drag = undefined; clearCardPreview(); render(); } item.classList.remove('is-being-dragged'); ownedDrag = undefined; });
    return item;
  }
  function clearCardPreview() {
    for (const placeholder of board.querySelectorAll('.bases-kanban-card-drop-placeholder')) {
      const space = placeholder.parentElement!; placeholder.remove();
      const originalHeight = space.dataset.previewHeight;
      if (originalHeight !== undefined) { space.style.height = originalHeight; delete space.dataset.previewHeight; }
      for (const card of space.querySelectorAll<HTMLElement>('.bases-kanban-card')) card.style.top = `${Number(card.dataset.rowIndex) * rowHeight}px`;
    }
  }
  function previewCardDrop(column: HTMLElement, group: BaseQueryGroup) {
    clearCardPreview();
    if (!drag || !group.key || locate(drag.path) === group) return;
    const rows = displayedRows(group), sourceIndex = rowOrder.get(drag.path) ?? 0;
    const index = rows.filter(row => (rowOrder.get(row.path) ?? 0) < sourceIndex).length;
    const space = column.querySelector<HTMLElement>('.bases-kanban-column-space'); if (!space) return;
    space.dataset.previewHeight = space.style.height; space.style.height = `${(rows.length + 1) * rowHeight}px`;
    for (const card of space.querySelectorAll<HTMLElement>('.bases-kanban-card')) if (Number(card.dataset.rowIndex) >= index) card.style.top = `${(Number(card.dataset.rowIndex) + 1) * rowHeight}px`;
    const placeholder = doc.createElement('div'); placeholder.className = 'bases-kanban-card-drop-placeholder';
    placeholder.style.top = `${index * rowHeight}px`; placeholder.style.height = `${rowHeight - gap}px`; space.append(placeholder);
  }
  function renderRows(body: HTMLElement, group: BaseQueryGroup, requestedTop = body.scrollTop) {
    if (hasActiveEdits()) return;
    const restoreFocus = body.contains(doc.activeElement) ? selected : undefined;
    const pinned = drag ? [...body.querySelectorAll<HTMLElement>('.bases-kanban-card')].find(item => item.dataset.path === drag!.path && item.classList.contains('is-being-dragged')) : undefined;
    releaseRows(body, pinned);
    const rows = displayedRows(group);
    const height = body.clientHeight || Math.max(100, (root.clientHeight || 600) - headerHeight);
    const space = pinned?.parentElement ?? doc.createElement('div'); space.className = 'bases-kanban-column-space'; space.style.height = `${rows.length * rowHeight}px`;
    if (pinned) { for (const child of [...space.children]) if (child !== pinned) child.remove(); }
    else body.replaceChildren(space);
    body.scrollTop = Math.min(requestedTop, Math.max(0, rows.length * rowHeight - height));
    saveScroll(group.key, body.scrollTop);
    const start = Math.max(0, Math.floor(body.scrollTop / rowHeight) - 2);
    const end = Math.min(rows.length, Math.ceil((body.scrollTop + height) / rowHeight) + 2);
    for (let i = start; i < end; i++) if (rows[i].path !== pinned?.dataset.path) space.append(card(rows[i], i));
    if (restoreFocus) [...space.querySelectorAll<HTMLElement>('.bases-kanban-card')].find(item => item.dataset.path === restoreFocus)?.focus({ preventScroll: true });
  }
  function mountColumn(group: BaseQueryGroup, index: number): HTMLElement {
      const column = doc.createElement('section'); column.className = 'bases-kanban-column';
      mountedColumns.set(column, group); column.style.left = `${index * (width + gap)}px`; column.style.width = `${width}px`;
      const heading = doc.createElement('div'); heading.className = 'bases-kanban-column-header'; heading.textContent = label(group.key, result.shared !== undefined);
      const count = doc.createElement('span'); count.className = 'bases-kanban-column-count'; count.textContent = String(displayedRows(group).length); heading.append(count);
      const body = doc.createElement('div'); body.className = 'bases-kanban-column-body'; body.setAttribute('role', 'listbox'); body.setAttribute('aria-label', label(group.key, result.shared !== undefined));
      column.append(heading, body);
      if (!options.readOnly && options.createItem && group.key) {
        const create = async (button: HTMLButtonElement) => {
          if (destroyed || !root.contains(button) || button.disabled) return;
          button.disabled = true;
          try { await options.createItem!({ version: result.version, property: propertyOf(result)!, group: group.key!,
            ...(group.sharedKeyId ? { groupKeyId: group.sharedKeyId } : {}), anchor: button }); }
          catch (error) { if (!destroyed) { status.textContent = error instanceof Error ? error.message : String(error); reportPresentationError(presentation, error); } }
          finally { button.disabled = false; }
        };
        const plus = doc.createElement('button'); plus.type = 'button'; plus.className = 'bases-kanban-column-create clickable-icon';
        plus.setAttribute('aria-label', 'Create note'); plus.append(icon('plus', 16, doc));
        plus.addEventListener('click', () => void create(plus)); heading.append(plus);
        const footer = doc.createElement('div'); footer.className = 'bases-kanban-column-footer';
        const add = doc.createElement('button'); add.type = 'button'; add.className = 'text-icon-button';
        add.append(icon('plus', 16, doc), doc.createTextNode('New')); add.addEventListener('click', () => void create(add));
        footer.append(add); column.append(footer);
      }
      if (!options.readOnly && options.requestGroupOrder && group.key) {
        heading.draggable = !groupOrderPending;
        let ownedColumnDrag: ColumnDrag | undefined;
        heading.addEventListener('dragstart', event => {
          if (destroyed || groupOrderPending || pendingColumnOrder || hasActiveEdits() || !root.contains(heading) || (event.target as Element)?.closest('button') || !event.dataTransfer) { event.preventDefault(); return; }
          columnDrag = ownedColumnDrag = { group, version: result.version, original: groups, preview: groups };
          paintColumnPreview();
          column.classList.add('is-being-dragged');
          event.dataTransfer.setDragImage?.(column, Math.min(event.offsetX, width), event.offsetY);
          event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', label(group.key));
        });
        heading.addEventListener('dragend', () => {
          if (columnDrag === ownedColumnDrag) { columnDrag = undefined; paintColumnPreview(); render(); }
          column.classList.remove('is-being-dragged');
        });
        heading.addEventListener('dragover', event => {
          if (!destroyed && !groupOrderPending && root.contains(heading) && columnDrag && columnDrag.version === result.version && !hasActiveEdits()) {
            event.preventDefault(); previewColumnDrop(group, event);
          }
        });
        heading.addEventListener('drop', event => { if (root.contains(heading)) commitColumnDrop(group, event); });
      }
      if (columns && group.key && (propertyOf(result)?.startsWith('note.') || propertyOf(result) === 'file.folder')) column.addEventListener('contextmenu', event => {
        if (destroyed || !root.contains(heading) || event.defaultPrevented || (event.target as Element)?.closest('.bases-kanban-card,button')) return;
        event.preventDefault(); const version = result.version;
        const items = [...(options.createItem ? [{ id: 'new', label: 'Add item', icon: 'plus' }] : []), { id: 'hide', label: 'Hide column', icon: 'eye-off' }, { id: 'edit', label: 'Edit columns', icon: 'stretch-horizontal' }];
        void showContextMenu(event, items, { document: doc, isCurrent: () => !destroyed && result.version === version && root.contains(heading) }).then(action => {
          if (destroyed || result.version !== version || !root.contains(heading)) return;
          if (action === 'new') { column.querySelector<HTMLButtonElement>('.bases-kanban-column-create')?.click(); return; }
          if (action === 'hide') return columns.hide(group.key!);
          if (action === 'edit') columns.open(editColumns ?? heading);
        }).catch(error => { if (!destroyed) status.textContent = error instanceof Error ? error.message : String(error); });
      });
      body.addEventListener('scroll', () => { if (destroyed || !root.contains(body)) return; saveScroll(group.key, body.scrollTop); renderRows(body, group); });
      column.addEventListener('dragover', event => {
        if (!destroyed && !groupOrderPending && root.contains(column) && columnDrag && columnDrag.version === result.version && !hasActiveEdits()) { event.preventDefault(); previewColumnDrop(group, event); return; }
        if (!destroyed && root.contains(column) && drag && drag.version === result.version && canMove(drag.path) && group.key) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; previewCardDrop(column, group); }
      });
      column.addEventListener('dragleave', event => { if (!(event.relatedTarget instanceof doc.defaultView!.Node) || !column.contains(event.relatedTarget)) clearCardPreview(); });
      column.addEventListener('drop', event => {
        if (destroyed || !root.contains(column)) return;
        if (columnDrag) { commitColumnDrop(group, event); return; }
        const source = drag; drag = undefined; clearCardPreview();
        if (!source || source.version !== result.version || !group.key) return;
        event.preventDefault(); void move(source.path, group.key);
      });
    return column;
  }
  /** Keep the native drag source attached while virtualizing newly reached columns. */
  function renderDragViewport() {
    const sourceGroup = columnDrag?.group ?? (drag ? locate(drag.path) : undefined);
    if (!sourceGroup || hasActiveEdits()) return;
    const visibleGroups = columnDrag?.preview ?? groups, viewport = root.clientWidth || 900, stride = width + gap;
    root.scrollLeft = Math.min(root.scrollLeft, Math.max(0, visibleGroups.length * stride - gap - viewport));
    const start = Math.max(0, Math.floor(root.scrollLeft / stride) - 1), end = Math.min(visibleGroups.length, Math.ceil((root.scrollLeft + viewport) / stride) + 1);
    const wanted = new Set(visibleGroups.slice(start, end)); wanted.add(sourceGroup);
    for (const [column, group] of mountedColumns) if (!wanted.has(group)) {
      releaseRows(column); mountedColumns.delete(column); column.remove();
    }
    const mounted = new Set(mountedColumns.values());
    for (let index = start; index < end; index++) {
      const group = visibleGroups[index]; if (mounted.has(group)) continue;
      const column = mountColumn(group, index); board.append(column);
      const body = column.querySelector<HTMLElement>('.bases-kanban-column-body');
      if (body) renderRows(body, group, columnScroll(group.key));
    }
    paintColumnPreview();
  }
  function render() {
    if (destroyed || hasActiveEdits()) return;
    if (columnDrag || drag) { renderDragViewport(); return; }
    const visibleGroups = pendingColumnOrder?.groups ?? groups;
    const restoreFocus = root.contains(doc.activeElement) && doc.activeElement?.closest('.bases-kanban-card') ? selected : undefined;
    epoch++; releaseRows(); mountedColumns.clear();
    const viewport = root.clientWidth || 900, stride = width + gap;
    root.scrollLeft = Math.min(root.scrollLeft, Math.max(0, visibleGroups.length * stride - gap - viewport));
    const start = Math.max(0, Math.floor(root.scrollLeft / stride) - 1), end = Math.min(visibleGroups.length, Math.ceil((root.scrollLeft + viewport) / stride) + 1);
    board.style.width = `${Math.max(0, visibleGroups.length * stride - gap)}px`;
    const nodes: HTMLElement[] = [];
    for (let index = start; index < end; index++) nodes.push(mountColumn(visibleGroups[index], index));
    if (!visibleGroups.length) {
      const empty = doc.createElement('div'); empty.className = 'bases-kanban-empty'; empty.textContent = propertyOf(result) ? 'No columns' : 'Group by a property to use Kanban'; nodes.push(empty);
    }
    board.replaceChildren(...nodes);
    // A detached scrolling element may clamp scrollTop; restore only once mounted.
    for (let i = 0; i < nodes.length && start + i < visibleGroups.length; i++) {
      const body = nodes[i].querySelector<HTMLElement>('.bases-kanban-column-body');
      if (body) renderRows(body, visibleGroups[start + i], columnScroll(visibleGroups[start + i].key));
    }
    if (restoreFocus) [...board.querySelectorAll<HTMLElement>('.bases-kanban-card')].find(item => item.dataset.path === restoreFocus)?.focus({ preventScroll: true });
  }
  function update(next: BaseQueryResult) {
    if (destroyed) return;
    if (hasActiveEdits()) { deferredResult = next; return; }
    result = next; columnDrag = undefined; pendingColumnOrder = undefined; drag = undefined; columns?.update(next); if (editColumns) editColumns.disabled = !propertyOf(next); root.setAttribute('aria-label', result.view.name);
    rowOrder = new Map(result.rows.map((row, index) => [row.path, index]));
    const queryGroups = result.groups.filter(group => group.key !== null);
    if (!propertyOf(result)) groups = [];
    else if (Array.isArray(result.view.groupOrder)) {
      if (result.shared !== undefined) {
        const listed = result.groupOptions.filter(option => option.listed), last = new Map<string, number>();
        listed.forEach((option, index) => {
          if (typeof option.sharedKeyId !== 'string') throw new Error('Shared group identity is unavailable.');
          last.set(option.sharedKeyId, index);
        });
        const known = new Set(queryGroups.map(group => group.sharedKeyId));
        const displayed: BaseQueryGroup[] = []; let actual = 0;
        listed.forEach((option, index) => {
          if (last.get(option.sharedKeyId!) !== index) return;
          if (known.has(option.sharedKeyId)) {
            // Rust groups already own row membership and order. Only insert
            // missing listed empty columns around that exact sequence.
            const group = queryGroups[actual++];
            if (group?.sharedKeyId !== option.sharedKeyId) throw new Error('Shared group order does not match its saved configuration.');
            displayed.push(group);
          } else displayed.push({ key: option.key, sharedKeyId: option.sharedKeyId, rows: [] });
        });
        if (actual !== queryGroups.length) throw new Error('Shared group order is incomplete.');
        groups = displayed;
      } else groups = result.groupOptions.filter(option => option.listed).map(option =>
        queryGroups.find(group => group.key && matchesBaseGroupKey(option.key, group.key)) ?? { key: option.key, rows: [] });
    } else groups = result.shared !== undefined ? queryGroups : [...queryGroups.filter(group => group.key?.type === 'null'), ...queryGroups.filter(group => group.key?.type !== 'null')];
    properties = result.properties;
    width = typeof result.view.columnWidth === 'number' && Number.isFinite(result.view.columnWidth) ? Math.max(200, Math.min(500, result.view.columnWidth)) : 280;
    const settings = baseCardsSettings(result);
    const coverHeight = settings.image ? width * (typeof result.view.imageAspectRatio === 'number' && result.view.imageAspectRatio > 0 ? settings.imageAspectRatio : .5) : 0;
    rowHeight = coverHeight + 16 + 24 + Math.max(0, properties.length - 1) * 50 + gap;
    for (const [path, operation] of pending) {
      if (propertyOf(result) !== operation.request.property || !requestGroupIs(locate(path), operation.request, 'source') || !groups.some(group => requestGroupIs(group, operation.request, 'destination'))) pending.delete(path);
    }
    if (selected && !locate(selected)) selected = undefined;
    const retainedScrolls = [...scrolls].filter(([key]) => groups.some(group => result.shared !== undefined ? typeof key === 'string' && group.sharedKeyId === key : typeof key !== 'string' && equal(group.key, key)));
    scrolls.clear(); for (const [key, top] of retainedScrolls) scrolls.set(key, top);
    render();
  }
  const onScroll = () => render(); root.addEventListener('scroll', onScroll);
  const onKey = (event: KeyboardEvent) => {
    if (event.isComposing || event.defaultPrevented || (event.target as Element)?.closest('input,textarea,select,button,[contenteditable="true"],[data-base-editing],a')) return;
    if (event.key === 'Tab') return;
    if (!selected && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const first = groups.flatMap(group => displayedRows(group))[0];
      if (first) { event.preventDefault(); select(first.path); root.querySelector<HTMLElement>('.bases-kanban-card.is-selected')?.focus(); } return;
    }
    if (event.key === 'Escape') { selected = undefined; render(); return; }
    if (!selected) return;
    const group = groups.find(group => displayedRows(group).some(row => row.path === selected)); if (!group) return;
    const rows = displayedRows(group), index = rows.findIndex(row => row.path === selected);
    if (event.key === 'Enter') { event.preventDefault(); options.openFile(selected, event); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const groupIndex = groups.indexOf(group), direction = event.key === 'ArrowLeft' ? -1 : 1;
      const target = groups[groupIndex + direction];
      if (!target) return;
      if (event.altKey && target.key) { void move(selected, target.key); return; }
      const row = displayedRows(target)[Math.min(index, displayedRows(target).length - 1)];
      if (row) { selected = row.path; root.scrollLeft = Math.max(0, (groupIndex + direction) * (width + gap)); render(); root.querySelector<HTMLElement>('.bases-kanban-card.is-selected')?.focus(); }
    }
    else if (event.key === 'ArrowUp'  || event.key === 'ArrowDown') {
      event.preventDefault(); const row = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (row) { selected = row.path; saveScroll(group.key, Math.max(0, rows.indexOf(row) * rowHeight - rowHeight)); render(); root.querySelector<HTMLElement>('.bases-kanban-card.is-selected')?.focus(); }
    }
  };
  root.addEventListener('keydown', onKey);
  const Observer = doc.defaultView?.ResizeObserver;
  const observer = Observer ? new Observer(() => render()) : undefined; observer?.observe(root);
  update(result);
  return { update, move, hasActiveEdits, refreshLayout() { render(); }, destroy() { if (destroyed) return; destroyed = true; epoch++; deferredResult = undefined; editObserver?.disconnect(); releaseRows(); mountedColumns.clear(); columnDrag = undefined; pendingColumnOrder = undefined; columns?.destroy(); pending.clear(); drag = undefined; observer?.disconnect(); root.removeEventListener('scroll', onScroll); root.removeEventListener('keydown', onKey); root.remove(); } };
}
