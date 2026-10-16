import { icon } from '../ui/icons.ts';
import { BASE_NULL, baseValueToString } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import type { BaseQueryGroup, BaseQueryResult, BaseQueryRow } from './query.ts';

export interface BasePropertyPresentation {
  readonly row: BaseQueryRow;
  readonly property: string;
  readonly value: BaseExpressionValue;
  readonly version: BaseQueryResult['version'];
}
export interface BasePresentationOptions {
  readonly result: BaseQueryResult;
  readonly openFile: (path: string, event: MouseEvent | KeyboardEvent) => void;
  readonly getPropertyLabel?: (property: string) => string;
  readonly editProperty?: (edit: { version: BaseQueryResult['version']; path: string; property: string; value: BaseExpressionValue }) => void | Promise<void>;
  /** Custom widgets own their content and must return a disposer for every acquired resource. */
  readonly renderProperty?: (element: HTMLElement, property: BasePropertyPresentation) => void | (() => void);
  readonly contextMenu?: (row: BaseQueryRow, event: MouseEvent) => void;
  readonly hoverFile?: (row: BaseQueryRow, event: MouseEvent) => void;
  readonly dragFile?: (row: BaseQueryRow, event: DragEvent) => void;
  readonly onError?: (error: unknown) => void;
}
export interface BasePresentationHandle {
  update(result: BaseQueryResult): void;
  refreshLayout(): void;
  destroy(): void;
}
export function propertyValue(row: BaseQueryRow, property: string): BaseExpressionValue {
  return Object.hasOwn(row.values, property) ? row.values[property] : BASE_NULL;
}
export function emptyListValue(value: BaseExpressionValue): boolean {
  return value.type === 'null' || (value.type === 'string' && !value.value) || (value.type === 'list' && !value.value.length);
}
export function reportPresentationError(options: BasePresentationOptions, error: unknown): void {
  try { options.onError?.(error); } catch { /* A reporting callback must not interrupt sibling resource cleanup. */ }
}

export function disposePresentationResources(disposers: (() => void)[], options: BasePresentationOptions): void {
  for (const dispose of disposers.splice(0)) {
    try { dispose(); } catch (error) { reportPresentationError(options, error); }
  }
}

/** A single visible property. This default is intentionally not the complete metadata widget registry. */
export function mountBaseProperty(element: HTMLElement, row: BaseQueryRow, property: string,
  result: BaseQueryResult, options: BasePresentationOptions, isCurrent: () => boolean): () => void {
  let value = propertyValue(row, property);
  element.classList.add('bases-rendered-value');
  element.dataset.property = property;
  if (options.renderProperty) {
    try { return options.renderProperty(element, { row, property, value, version: result.version }) || (() => {}); }
    catch (error) { reportPresentationError(options, error); element.textContent = 'Error'; return () => {}; }
  }
  let disposed = false;
  let pending = false;
  const editable = !!options.editProperty && property.startsWith('note.') && /\.md$/i.test(row.path);
  const commit = async (next: BaseExpressionValue): Promise<boolean> => {
    if (disposed || pending || !isCurrent()) return false;
    pending = true;
    try {
      await options.editProperty?.({ version: result.version, path: row.path, property, value: next });
      return !disposed && isCurrent();
    } catch (error) { if (!disposed && isCurrent()) reportPresentationError(options, error); return false; }
    finally { pending = false; }
  };
  const draw = (current: BaseExpressionValue) => {
    element.replaceChildren();
    if (property === 'file.name' || property === 'file.file') {
      const link = element.ownerDocument.createElement('a');
      link.className = 'internal-link';
      link.href = '#';
      link.textContent = baseValueToString(current);
      const open = (event: MouseEvent) => {
        if (event.defaultPrevented || (event.button !== 0 && event.button !== 1) || disposed || !isCurrent()) return;
        event.preventDefault(); options.openFile(row.path, event);
      };
      link.addEventListener('click', open); link.addEventListener('auxclick', open);
      element.append(link);
    } else if (current.type === 'boolean') {
      const input = element.ownerDocument.createElement('input');
      input.type = 'checkbox'; input.checked = current.value; input.disabled = !editable;
      input.setAttribute('aria-label', options.getPropertyLabel?.(property) ?? property.replace(/^note\./, ''));
      input.addEventListener('change', async () => {
        if (pending || disposed || !isCurrent()) return;
        const next = input.checked; input.disabled = true;
        const accepted = await commit({ type: 'boolean', value: next });
        if (!disposed && isCurrent()) {
          if (accepted) value = { type: 'boolean', value: next };
          input.checked = value.type === 'boolean' ? value.value : current.value;
          input.disabled = !editable;
        }
      });
      element.append(input);
    } else {
      element.textContent = baseValueToString(current);
      if (current.type === 'error') { element.classList.add('mod-error'); element.title = current.error.message; }
    }
  };
  draw(value);
  const beginEdit = (event: MouseEvent) => {
    if (!editable || disposed || pending || !isCurrent() || (value.type !== 'string' && value.type !== 'number' && value.type !== 'null')) return;
    if (element.querySelector('input')) return;
    event.preventDefault(); event.stopPropagation();
    const input = element.ownerDocument.createElement('input');
    input.type = value.type === 'number' ? 'number' : 'text'; input.value = baseValueToString(value);
    input.setAttribute('aria-label', options.getPropertyLabel?.(property) ?? property.replace(/^note\./, ''));
    element.replaceChildren(input); input.focus(); input.select();
    let ended = false;
    const finish = async () => {
      if (ended) return; ended = true;
      const raw = input.value;
      const next: BaseExpressionValue = raw === '' ? BASE_NULL : value.type === 'number'
        ? { type: 'number', value: Number(raw) } : { type: 'string', value: raw };
      if (next.type === 'number' && !Number.isFinite(next.value)) { draw(value); return; }
      input.disabled = true;
      const accepted = await commit(next);
      if (!disposed && isCurrent()) {
        if (accepted) { value = next; draw(value); }
        else {
          // Keep the failed draft available for correction/retry; Escape restores the accepted value.
          ended = false; input.disabled = false; input.setAttribute('aria-invalid', 'true');
        }
      }
    };
    input.addEventListener('blur', () => { void finish(); });
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); ended = true; draw(value); }
      else if (event.key === 'Enter') { event.preventDefault(); void finish(); }
    });
  };
  element.addEventListener('click', beginEdit);
  element.addEventListener('dblclick', beginEdit);
  return () => { disposed = true; element.removeEventListener('click', beginEdit); element.removeEventListener('dblclick', beginEdit); };
}

export interface VirtualUnit {
  readonly key: string;
  readonly height: number;
  mount(): { element: HTMLElement; dispose(): void };
}

/** Fenwick sums keep measured-height changes and visible-index lookup logarithmic. */
class HeightIndex {
  private tree: number[] = [];
  private values: number[] = [];
  reset(units: readonly VirtualUnit[]) {
    this.values = units.map(unit => Math.max(1, unit.height)); this.tree = new Array(units.length + 1).fill(0);
    for (let i = 0; i < units.length; i++) {
      this.tree[i + 1] += this.values[i];
      const parent = i + 1 + ((i + 1) & -(i + 1));
      if (parent < this.tree.length) this.tree[parent] += this.tree[i + 1];
    }
  }
  sum(end: number): number { let sum = 0; for (let i = end; i > 0; i -= i & -i) sum += this.tree[i]; return sum; }
  set(index: number, value: number): boolean {
    if (Math.abs(this.values[index] - value) < 0.5) return false;
    const delta = value - this.values[index]; this.values[index] = value;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += delta;
    return true;
  }
  find(offset: number): number {
    let index = 0; let sum = 0; let bit = 1;
    while (bit * 2 < this.tree.length) bit *= 2;
    for (; bit; bit >>= 1) {
      const next = index + bit;
      if (next < this.tree.length && sum + this.tree[next] <= offset) { index = next; sum += this.tree[next]; }
    }
    return Math.min(index, Math.max(0, this.values.length - 1));
  }
}

/** Owns one scroller, visible units plus the focused unit, and one bounded ResizeObserver. */
export function createBaseVirtualSurface(container: HTMLElement, className: string, layout: (width: number) => readonly VirtualUnit[], onError?: (error: unknown) => void) {
  const document = container.ownerDocument;
  const scroller = document.createElement('div'); scroller.className = `bases-virtual-scroll ${className}`;
  scroller.style.cssText = 'overflow:auto;overflow-anchor:none;position:relative;height:100%;min-height:100px';
  const content = document.createElement('div'); content.className = 'bases-virtual-content'; content.style.position = 'relative';
  scroller.append(content); container.append(scroller);
  let units: readonly VirtualUnit[] = []; let destroyed = false; let width = -1; let frame: number | undefined;
  const heights = new HeightIndex();
  const mounted = new Map<number, ReturnType<VirtualUnit['mount']>>();
  const win = document.defaultView;
  const release = (index: number) => {
    const item = mounted.get(index); if (!item) return;
    observer?.unobserve(item.element);
    try { item.dispose(); } catch (error) { try { onError?.(error); } catch {} }
    finally { item.element.remove(); mounted.delete(index); }
  };
  const render = () => {
    if (destroyed) return;
    const top = Math.max(0, scroller.scrollTop - 300);
    const bottom = scroller.scrollTop + (scroller.clientHeight || 600) + 300;
    const start = heights.find(top); const end = units.length ? heights.find(bottom) + 1 : 0;
    for (const [index, item] of mounted) {
      if ((index < start || index >= end) && !item.element.contains(document.activeElement)) release(index);
    }
    for (let i = start; i < end; i++) if (!mounted.has(i)) {
      const item = units[i].mount(); mounted.set(i, item);
      item.element.style.position = 'absolute'; item.element.style.insetInline = '0';
      item.element.dataset.virtualIndex = String(i); content.append(item.element); observer?.observe(item.element);
    }
    for (const [index, item] of mounted) item.element.style.top = `${heights.sum(index)}px`;
    content.style.height = `${heights.sum(units.length)}px`;
  };
  const schedule = () => {
    if (destroyed || frame !== undefined) return;
    if (win?.requestAnimationFrame) frame = win.requestAnimationFrame(() => { frame = undefined; render(); });
    else render();
  };
  const observer = win?.ResizeObserver ? new win.ResizeObserver(entries => {
    let changed = false;
    const anchor = heights.find(scroller.scrollTop); const previousTop = heights.sum(anchor);
    for (const entry of entries) {
      if (entry.target === scroller) { if (scroller.clientWidth !== width) refresh(); else schedule(); continue; }
      const index = Number((entry.target as HTMLElement).dataset.virtualIndex);
      if (mounted.get(index)?.element !== entry.target) continue;
      const measured = (entry.target as HTMLElement).getBoundingClientRect().height;
      if (measured > 0) changed = heights.set(index, measured) || changed;
    }
    if (changed) { scroller.scrollTop += heights.sum(anchor) - previousTop; schedule(); }
  }) : undefined;
  const refresh = () => {
    if (destroyed) return;
    for (const index of [...mounted.keys()]) release(index);
    width = scroller.clientWidth; units = layout(width || 800); heights.reset(units); render();
  };
  scroller.addEventListener('scroll', schedule, { passive: true });
  scroller.addEventListener('focusout', schedule);
  win?.addEventListener('resize', refresh); observer?.observe(scroller);
  return {
    element: scroller, refresh,
    destroy() {
      if (destroyed) return; destroyed = true;
      if (frame !== undefined) win?.cancelAnimationFrame(frame);
      observer?.disconnect(); win?.removeEventListener('resize', refresh);
      for (const index of [...mounted.keys()]) release(index);
      scroller.remove();
    },
  };
}

export function groupIdentity(group: BaseQueryGroup): string {
  return group.key === null ? 'ungrouped' : JSON.stringify(group.key, (_key, value) => value instanceof RegExp ? { regexp: value.source, flags: value.flags } : value);
}
export function createGroupUnit(document: Document, group: BaseQueryGroup, index: number, collapsed: boolean, toggle: () => void): VirtualUnit {
  return { key: `group:${index}`, height: 36, mount() {
    const button = document.createElement('button'); button.className = 'bases-group-heading';
    button.type = 'button'; button.setAttribute('aria-expanded', String(!collapsed));
    const indicator = document.createElement('span'); indicator.className = 'bases-group-collapse'; indicator.setAttribute('aria-hidden', 'true');
    indicator.append(icon(collapsed ? 'right' : 'down', 16, document));
    const label = document.createElement('span'); label.textContent = group.key?.type === 'null' ? 'No value' : group.key ? baseValueToString(group.key) : '';
    button.append(indicator, label); button.addEventListener('click', toggle);
    return { element: button, dispose() { button.removeEventListener('click', toggle); } };
  } };
}
