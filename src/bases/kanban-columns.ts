import { baseExpressionValue, baseValuesEqual, baseValueToString } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import type { BaseValue } from './document.ts';
import type { BaseQueryResult } from './query.ts';
import { normalizeBaseProperty } from './query.ts';
import { baseEditValue } from './view-actions.ts';
import { icon } from '../ui/icons.ts';

export interface BaseKanbanGroupOrderRequest {
  readonly version: BaseQueryResult['version'];
  readonly property: string;
  /** Undefined returns to automatic grouping; [] deliberately hides every column. */
  readonly order: readonly BaseValue[] | undefined;
  readonly direction?: 'ASC' | 'DESC';
}
export interface BaseKanbanColumnsOptions {
  readonly result: BaseQueryResult;
  readonly requestGroupOrder: (request: BaseKanbanGroupOrderRequest) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}
export interface BaseKanbanColumns {
  update(result: BaseQueryResult): void;
  open(anchor: HTMLElement): void;
  hide(key: BaseExpressionValue): Promise<boolean>;
  destroy(): void;
}
interface Row { key: BaseExpressionValue; checked: boolean; count: number; stored?: BaseValue }
function text(key: BaseExpressionValue): string {
  if (key.type === 'null') return 'No value';
  try { return baseValueToString(key); } catch { return key.type; }
}
function propertyOf(result: BaseQueryResult): string | undefined {
  const group = result.view.groupBy;
  return group && !Array.isArray(group) && typeof group === 'object' && 'property' in group && typeof group.property === 'string'
    ? normalizeBaseProperty(group.property) : undefined;
}
const same = (a: BaseExpressionValue, b: BaseExpressionValue) => baseValuesEqual(a, b, true);
/** Persisted matching uses query display text, never the UI's localized null label. */
export function matchesBaseGroupKey(configured: BaseExpressionValue, key: BaseExpressionValue): boolean {
  if (same(configured, key)) return true;
  if (configured.type !== 'string') return false;
  try { return configured.value === (key.type === 'namespace' ? key.name : baseValueToString(key)); } catch { return false; }
}
function matches(stored: BaseValue, key: BaseExpressionValue): boolean {
  return matchesBaseGroupKey(baseExpressionValue(stored), key);
}

/** Snapshot-owned Group popover: only configuration changes, never note writes. */
export function createBaseKanbanColumns(container: HTMLElement, options: BaseKanbanColumnsOptions): BaseKanbanColumns {
  const doc = container.ownerDocument, win = doc.defaultView;
  let result = options.result, disposed = false, pending = false;
  let popover: HTMLElement | undefined, anchor: HTMLElement | undefined;
  let rows: Row[] = [], tail: readonly BaseValue[] = [], selected = 0;
  let operation = 0;
  let removedOrder: readonly BaseValue[] | undefined;
  let rowDrag: { row: Row; token: number } | undefined;
  let errorMessage = '';
  let pendingOrder: readonly BaseValue[] | undefined;
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Reporting must not change configuration state. */ } };
  function close() {
    operation++; rowDrag = undefined; popover?.remove(); popover = undefined;
    removedOrder = undefined; anchor?.setAttribute('aria-expanded', 'false'); anchor = undefined;
  }
  function readRows() {
    const order = Array.isArray(result.view.groupOrder) ? result.view.groupOrder as readonly BaseValue[] : undefined;
    const candidates = result.groupOptions.length ? result.groupOptions.map(group => ({ key: result.groups.find(actual => actual.key && matchesBaseGroupKey(group.key, actual.key))?.key ?? group.key, count: group.count, listed: group.listed }))
      : result.groups.filter(group => group.key !== null).map(group => ({ key: group.key!, count: group.rows.length, listed: true }));
    if (!order) candidates.sort((a, b) => a.key.type === 'null' ? -1 : b.key.type === 'null' ? 1 : 0);
    rows = candidates.filter(group => group.listed).concat(candidates.filter(group => !group.listed).sort((a, b) => text(a.key).localeCompare(text(b.key), undefined, { numeric: true })))
      .map(group => ({ key: group.key, count: group.count, checked: order ? group.listed : true,
        ...(order?.some(value => matches(value, group.key)) ? { stored: order.find(value => matches(value, group.key))! } : {}),
      }));
    tail = order?.filter(value => !rows.some(row => matches(value, row.key))) ?? [];
    selected = Math.min(selected, Math.max(0, rows.length - 1));
  }
  const stored = (row: Row): BaseValue => Object.hasOwn(row, 'stored') ? row.stored! : baseEditValue(row.key);
  const orderOf = () => rows.filter(row => row.checked).map(stored).concat(tail);
  async function save(order: readonly BaseValue[] | undefined, direction?: 'ASC' | 'DESC'): Promise<boolean> {
    const property = propertyOf(result);
    if (disposed || pending || !property) return false;
    const token = ++operation, version = result.version; pending = true; pendingOrder = order; errorMessage = ''; draw();
    try {
      await options.requestGroupOrder({ version, property, order: order === undefined ? undefined : structuredClone(order), ...(direction ? { direction } : {}) });
      return !disposed;
    } catch (error) {
      if (!disposed && token === operation && property === propertyOf(result)) {
        errorMessage = error instanceof Error ? error.message : String(error); report(error); readRows();
      }
      return false;
    } finally {
      if (!disposed) { pending = false; draw(); }
    }
  }
  const attempt = (change: () => void) => {
    if (disposed || pending || !popover) return;
    try { change(); void save(orderOf()); }
    catch (error) { errorMessage = error instanceof Error ? error.message : String(error); report(error); readRows(); draw(); }
  };
  function position() {
    if (!popover || !anchor || !win) return;
    const bounds = anchor.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(bounds.left, win.innerWidth - 328))}px`;
    popover.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, win.innerHeight - Math.min(popover.scrollHeight || 360, 500) - 8))}px`;
  }
  function draw() {
    if (!popover || disposed) return;
    const element = popover;
    const focusedRow = doc.activeElement?.closest('.bases-columns-row');
    const focusedSelect = doc.activeElement?.tagName === 'SELECT' && element.contains(doc.activeElement);
    element.replaceChildren(); element.setAttribute('aria-busy', String(pending));
    const title = doc.createElement('div'); title.className = 'bases-columns-title'; title.textContent = 'Group'; element.append(title);
    const by = doc.createElement('div'); by.className = 'bases-columns-by';
    const property = doc.createElement('span'); property.textContent = `Group by ${propertyOf(result)?.replace(/^note\./, '') ?? ''}`;
    const select = doc.createElement('select'); select.setAttribute('aria-label', 'Group order'); select.disabled = pending;
    for (const [value, label] of [['ASC', 'A to Z'], ['DESC', 'Z to A'], ['MANUAL', 'Manual']]) { const item = doc.createElement('option'); item.value = value; item.textContent = label; select.append(item); }
    const manual = Array.isArray(result.view.groupOrder), group = result.view.groupBy;
    select.value = manual ? 'MANUAL' : group && typeof group === 'object' && !Array.isArray(group) && 'direction' in group && group.direction === 'DESC' ? 'DESC' : 'ASC';
    select.addEventListener('change', () => {
      if (disposed || pending || popover !== element || !element.contains(select)) return;
      if (select.value === 'MANUAL') { const restored = removedOrder ?? []; void save(restored); }
      else { if (Array.isArray(result.view.groupOrder)) removedOrder = result.view.groupOrder as readonly BaseValue[]; void save(undefined, select.value === 'DESC' ? 'DESC' : 'ASC'); }
    });
    by.append(property, select); element.append(by);
    if (manual) {
      const list = doc.createElement('div'); list.className = 'bases-columns-list'; list.setAttribute('role', 'list');
      rows.forEach((row, index) => {
        const line = doc.createElement('div'); line.className = `bases-columns-row${row.checked ? '' : ' mod-hidden'}`;
        line.tabIndex = index === selected ? 0 : -1; line.setAttribute('role', 'listitem'); line.dataset.index = String(index);
        const grip = doc.createElement('span'); grip.className = 'bases-columns-grip'; grip.append(icon('grip-vertical', 16, doc)); grip.draggable = !pending; grip.setAttribute('aria-label', 'Drag to reorder');
        const check = doc.createElement('input'); check.type = 'checkbox'; check.checked = row.checked; check.disabled = pending; check.tabIndex = -1; check.setAttribute('aria-label', `Show ${text(row.key)}`);
        const name = doc.createElement('span'); name.className = 'bases-columns-name'; name.textContent = text(row.key);
        const count = doc.createElement('span'); count.className = 'bases-columns-count'; count.textContent = String(row.count);
        line.append(grip, check, name, count); list.append(line);
        line.addEventListener('click', event => { if (disposed || pending || popover !== element || !element.contains(line) || (event.target as Element).closest('.bases-columns-grip')) return; selected = index; attempt(() => { row.checked = !row.checked; }); });
        line.addEventListener('keydown', event => {
          if (disposed || pending || popover !== element || !element.contains(line)) return;
          if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); selected = index; attempt(() => { row.checked = !row.checked; }); }
          else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault(); const next = Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
            if (event.altKey && row.checked) attempt(() => { rows.splice(index, 1); rows.splice(next, 0, row); selected = next; });
            else { selected = next; draw(); popover?.querySelector<HTMLElement>(`.bases-columns-row[data-index="${next}"]`)?.focus(); }
          }
        });
        let ownedDrag: typeof rowDrag;
        grip.addEventListener('dragstart', event => {
          if (disposed || pending || popover !== element || !element.contains(line) || !event.dataTransfer) { event.preventDefault(); return; }
          rowDrag = ownedDrag = { row, token: operation }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', text(row.key));
        });
        grip.addEventListener('dragend', () => { if (rowDrag === ownedDrag) rowDrag = undefined; });
        line.addEventListener('dragover', event => { if (rowDrag && !pending && popover === element && element.contains(line)) event.preventDefault(); });
        line.addEventListener('drop', event => {
          if (disposed || pending || popover !== element || !element.contains(line)) return;
          const source = rowDrag; rowDrag = undefined;
          if (!source || source.token !== operation) return;
          event.preventDefault(); attempt(() => { const from = rows.indexOf(source.row); if (from < 0) return; rows.splice(from, 1); rows.splice(index, 0, source.row); selected = index; });
        });
      });
      element.append(list);
      const any = rows.some(row => row.checked), toggle = doc.createElement('button'); toggle.type = 'button'; toggle.className = 'bases-columns-toggle'; toggle.disabled = pending;
      toggle.append(icon(any ? 'eye-off' : 'eye', 16, doc), doc.createTextNode(any ? 'Hide all' : 'Show all'));
      toggle.addEventListener('click', () => { if (popover !== element || !element.contains(toggle)) return; attempt(() => { rows.forEach(row => { row.checked = !any; }); }); }); element.append(toggle);
    }
    if (errorMessage) { const error = doc.createElement('div'); error.className = 'bases-columns-error'; error.setAttribute('role', 'alert'); error.textContent = errorMessage; element.append(error); }
    position();
    if (focusedRow) element.querySelector<HTMLElement>(`.bases-columns-row[data-index="${selected}"]`)?.focus();
    else if (focusedSelect) select.focus();
  }
  const outside = (event: Event) => { if (popover && event.target && typeof (event.target as Node).nodeType === 'number' && !popover.contains(event.target as Node) && !anchor?.contains(event.target as Node)) close(); };
  const key = (event: KeyboardEvent) => { if (popover && event.key === 'Escape') { event.preventDefault(); const target = anchor; close(); target?.focus(); } };
  doc.addEventListener('pointerdown', outside); doc.addEventListener('keydown', key);
  win?.addEventListener('resize', position);
  return {
    update(next) {
      if (disposed) return;
      const previousProperty = propertyOf(result);
      const keepRows = !!popover && pending && previousProperty === propertyOf(next) && Array.isArray(result.view.groupOrder) && Array.isArray(next.view.groupOrder) && JSON.stringify(pendingOrder) === JSON.stringify(next.view.groupOrder);
      if (result.version !== next.version) { operation++; errorMessage = ''; }
      result = next;
      if (previousProperty !== propertyOf(next)) { close(); }
      else if (popover) {
        rowDrag = undefined;
        if (keepRows) rows.forEach(row => { row.count = next.groupOptions.find(group => matchesBaseGroupKey(group.key, row.key))?.count ?? 0; });
        else readRows();
        draw();
      }
    },
    open(target) {
      if (disposed || !propertyOf(result)) return;
      if (popover) { close(); return; }
      anchor = target; errorMessage = ''; readRows();
      popover = doc.createElement('div'); popover.className = 'bases-columns-popover'; popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', 'Group');
      target.setAttribute('aria-expanded', 'true'); doc.body.append(popover); draw(); popover.querySelector<HTMLElement>('select')?.focus();
    },
    async hide(key) {
      if (disposed || pending) return false;
      readRows(); rows.forEach(row => { if (same(row.key, key)) row.checked = false; });
      try { return await save(orderOf()); } catch (error) { report(error); return false; }
    },
    destroy() { if (disposed) return; disposed = true; close(); doc.removeEventListener('pointerdown', outside); doc.removeEventListener('keydown', key); win?.removeEventListener('resize', position); },
  };
}
