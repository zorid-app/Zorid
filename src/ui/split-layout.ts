export type SplitDirection = 'vertical' | 'horizontal';
export type SplitEdge = 'left' | 'right' | 'top' | 'bottom';
export type SplitNode = { type: 'leaf'; paneId: string } | SplitBranch;
export interface SplitBranch { type: 'split'; id: string; direction: SplitDirection; children: SplitNode[]; sizes: number[] }
export type SplitChangeReason = 'reconcile' | 'restore' | 'split' | 'move' | 'remove' | 'resize';
export interface SplitLayoutOptions {
  minPaneSize?: number;
  onChange?(tree: SplitNode | null, reason: SplitChangeReason): void;
}
let sequence = 0;
const unique = () => `split-${++sequence}`;
const clone = <T>(value: T): T => structuredClone(value);
const weights = (values: unknown, count: number): number[] => {
  if (!count) return [];
  const source = Array.isArray(values) && values.length === count ? values : [];
  const positive = Array.from({ length: count }, (_, index) => typeof source[index] === 'number' && Number.isFinite(source[index]) && source[index] > 0 ? source[index] : 1);
  const originalTotal = positive.reduce((a, b) => a + b, 0);
  if (Math.abs(originalTotal - 1) < 1e-12) return positive;
  // Scale before summation so even finite but enormous persisted values normalize.
  const max = Math.max(...positive), scaled = positive.map(value => Math.max(1e-9, value / max));
  const sum = scaled.reduce((a, b) => a + b, 0);
  return scaled.map(value => value / sum);
};
const idsOf = (node: SplitNode | null): string[] => !node ? [] : node.type === 'leaf' ? [node.paneId] : node.children.flatMap(idsOf);
const branchIdsOf = (node: SplitNode): string[] => node.type === 'leaf' ? [] : [node.id, ...node.children.flatMap(branchIdsOf)];
const unusedId = (ids: Set<string>): string => { let id = unique(); while (ids.has(id)) id = unique(); return id; };
const branch = (children: SplitNode[], direction: SplitDirection, id = unique(), sizes?: number[]): SplitBranch => ({ type: 'split', id, direction, children, sizes: weights(sizes, children.length) });

/** Restore only registered pane IDs, discard duplicate/unknown leaves, collapse
 * empty/singleton groups, and retain every registered pane through a fallback. */
export function normalizeSplitLayout(value: unknown, paneIds: Iterable<string>): SplitNode | null {
  const available = [...new Set(paneIds)], allowed = new Set(available), seen = new Set<string>(), branchIds = new Set<string>();
  let visited = 0;
  function read(input: unknown, depth: number): SplitNode | null {
    if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 32 || ++visited > 1024) return null;
    const node = input as Record<string, unknown>;
    if (node.type === 'leaf') {
      const paneId = node.paneId;
      if (typeof paneId !== 'string' || !allowed.has(paneId) || seen.has(paneId)) return null;
      seen.add(paneId); return { type: 'leaf', paneId };
    }
    if (node.type !== 'split' || !['vertical', 'horizontal'].includes(String(node.direction)) || !Array.isArray(node.children)) return null;
    const children: SplitNode[] = [], sizes: number[] = [];
    const originalSizes = weights(node.sizes, Math.min(node.children.length, 1024));
    node.children.slice(0, 1024).forEach((child, index) => { const result = read(child, depth + 1); if (result) { children.push(result); sizes.push(originalSizes[index]); } });
    if (children.length < 2) return children[0] || null;
    let id = typeof node.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(node.id) ? node.id : unique();
    while (branchIds.has(id)) id = unique();
    branchIds.add(id);
    return branch(children, node.direction as SplitDirection, id, sizes);
  }
  let root = read(value, 0);
  const missing = available.filter(id => !seen.has(id)).map(paneId => ({ type: 'leaf' as const, paneId }));
  if (missing.length) {
    if (root?.type === 'split' && root.direction === 'vertical') {
      const count = root.children.length + missing.length, share = root.children.length / count;
      root = branch([...root.children, ...missing], 'vertical', root.id, [...root.sizes.map(size => size * share), ...missing.map(() => 1 / count)]);
    } else {
      const children = [...(root ? [root] : []), ...missing];
      root = children.length === 1 ? children[0] : branch(children, 'vertical', unusedId(branchIds));
    }
  }
  return root;
}

function removeNode(node: SplitNode | null, paneId: string): SplitNode | null {
  if (!node || node.type === 'leaf') return node?.paneId === paneId ? null : node;
  const children: SplitNode[] = [], sizes: number[] = [];
  node.children.forEach((child, index) => { const next = removeNode(child, paneId); if (next) { children.push(next); sizes.push(node.sizes[index]); } });
  return children.length < 2 ? children[0] || null : branch(children, node.direction, node.id, sizes);
}

function insertNode(root: SplitNode, target: string, paneId: string, edge: SplitEdge, newBranchId = unusedId(new Set(branchIdsOf(root)))): SplitNode {
  const direction = edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal';
  const before = edge === 'left' || edge === 'top';
  const leaf: SplitNode = { type: 'leaf', paneId };
  if (root.type === 'leaf') return root.paneId === target ? branch(before ? [leaf, root] : [root, leaf], direction, newBranchId) : root;
  const index = root.children.findIndex(child => child.type === 'leaf' && child.paneId === target);
  if (index >= 0 && root.direction === direction) {
    const children = [...root.children], sizes = [...root.sizes];
    sizes[index] /= 2;
    const insertion = index + (before ? 0 : 1);
    children.splice(insertion, 0, leaf); sizes.splice(insertion, 0, sizes[index]);
    return branch(children, root.direction, root.id, sizes);
  }
  return { ...root, children: root.children.map(child => insertNode(child, target, paneId, edge, newBranchId)) };
}

/** Fit requested proportions to minimum sizes without overflowing a small host.
 * When all minimums cannot fit, scale them together rather than hiding panes. */
function fitPixels(sizes: number[], minima: number[], total: number): { pixels: number[]; minima: number[] } {
  const minimumTotal = minima.reduce((a, b) => a + b, 0);
  const lower = minima.map(value => value * Math.min(1, total / minimumTotal));
  const result = sizes.map(() => 0), pending = new Set(sizes.map((_, index) => index));
  let remaining = total;
  while (pending.size) {
    const sum = [...pending].reduce((value, index) => value + sizes[index], 0);
    const limited = [...pending].filter(index => remaining * sizes[index] / sum < lower[index]);
    if (!limited.length) { for (const index of pending) result[index] = remaining * sizes[index] / sum; break; }
    for (const index of limited) { result[index] = lower[index]; remaining -= result[index]; pending.delete(index); }
  }
  return { pixels: result, minima: lower };
}

interface ManagedElement { element: HTMLElement; flex: string; id: string; hadClass: boolean }
interface ResizeSession { cancel(): void }

export class SplitLayout {
  private root: SplitNode | null = null;
  private panes = new Map<string, HTMLElement>();
  private managed = new Map<string, ManagedElement>();
  private branches = new Map<string, HTMLElement>();
  private separators = new Map<string, HTMLElement>();
  private resize: ResizeSession | null = null;
  private destroyed = false;
  private readonly minimum: number;
  private readonly separatorSize = 6;
  private readonly hadClass: boolean;
  private readonly container: HTMLElement;
  private readonly options: SplitLayoutOptions;
  constructor(container: HTMLElement, options: SplitLayoutOptions = {}) {
    this.container = container; this.options = options;
    this.minimum = typeof options.minPaneSize === 'number' && Number.isFinite(options.minPaneSize) && options.minPaneSize > 0 ? options.minPaneSize : 200;
    this.hadClass = container.classList.contains('split-layout');
    container.classList.add('split-layout');
  }

  setPanes(panes: ReadonlyMap<string, HTMLElement>, savedTree?: unknown): void {
    this.assertLive(); this.resize?.cancel();
    const elements = new Set<HTMLElement>();
    for (const [id, element] of panes) {
      if (!id || elements.has(element) || element.ownerDocument !== this.container.ownerDocument || element === this.container || element.contains(this.container)) throw new Error('Invalid split pane registration');
      elements.add(element);
    }
    for (const element of elements) for (const other of elements) if (element !== other && element.contains(other)) throw new Error('Split panes cannot contain each other');
    const preserve = this.captureFocus();
    for (const [id, old] of this.panes) if (panes.get(id) !== old) { this.release(id); old.remove(); }
    this.panes = new Map(panes);
    for (const [id, element] of this.panes) this.manage(id, element);
    this.root = normalizeSplitLayout(savedTree === undefined ? this.root : savedTree, panes.keys());
    this.render(); preserve(); this.changed(savedTree === undefined ? 'reconcile' : 'restore');
  }

  serialize(): SplitNode | null { return clone(this.root); }
  restore(value: unknown): void {
    this.assertLive(); this.resize?.cancel();
    this.root = normalizeSplitLayout(value, this.panes.keys()); this.render(); this.changed('restore');
  }
  split(targetId: string, newId: string, element: HTMLElement, edge: 'right' | 'bottom' = 'right'): boolean {
    this.assertLive();
    if (!this.root || !this.panes.has(targetId) || this.panes.has(newId) || !newId ||
        !['right', 'bottom'].includes(edge) || [...this.panes.values()].includes(element) ||
        element.ownerDocument !== this.container.ownerDocument || element === this.container || element.contains(this.container) ||
        [...this.panes.values()].some(pane => pane.contains(element) || element.contains(pane))) return false;
    this.resize?.cancel(); this.panes.set(newId, element); this.manage(newId, element);
    this.root = insertNode(this.root, targetId, newId, edge); this.render(); this.changed('split'); return true;
  }
  move(paneId: string, targetId: string, edge: SplitEdge): boolean {
    this.assertLive();
    if (!this.root || paneId === targetId || !this.panes.has(paneId) || !this.panes.has(targetId) || !['left', 'right', 'top', 'bottom'].includes(edge)) return false;
    this.resize?.cancel();
    const remaining = removeNode(this.root, paneId)!;
    this.root = insertNode(remaining, targetId, paneId, edge); this.render(); this.changed('move'); return true;
  }
  remove(paneId: string): HTMLElement | null {
    this.assertLive();
    const element = this.panes.get(paneId); if (!element) return null;
    this.resize?.cancel(); this.panes.delete(paneId); this.root = removeNode(this.root, paneId);
    this.release(paneId); element.remove(); this.render(); this.changed('remove'); return element;
  }
  /** Releases layout ownership; leaf elements remain in the host for their owner
   * to dispose. The layout never destroys editors or invokes pane callbacks. */
  destroy(): void {
    if (this.destroyed) return;
    this.resize?.cancel(); const restore = this.captureFocus();
    for (const id of idsOf(this.root)) { const element = this.panes.get(id)!; this.container.append(element); this.release(id); }
    for (const element of this.branches.values()) element.remove();
    for (const element of this.separators.values()) element.remove();
    this.branches.clear(); this.separators.clear(); this.panes.clear(); this.root = null;
    if (!this.hadClass) this.container.classList.remove('split-layout');
    this.destroyed = true; restore();
  }

  private assertLive(): void { if (this.destroyed) throw new Error('Split layout is destroyed'); }
  private changed(reason: SplitChangeReason): void { this.options.onChange?.(this.serialize(), reason); }
  private manage(id: string, element: HTMLElement): void {
    if (!this.managed.has(id)) this.managed.set(id, { element, flex: element.style.flex, id: element.id, hadClass: element.classList.contains('split-layout-leaf') });
    element.classList.add('split-layout-leaf');
    if (!element.id) element.id = `zorid-pane-${unique()}`;
  }
  private release(id: string): void {
    const record = this.managed.get(id); if (!record) return;
    record.element.style.flex = record.flex; record.element.id = record.id;
    if (!record.hadClass) record.element.classList.remove('split-layout-leaf');
    this.managed.delete(id);
  }
  private captureFocus(): () => void {
    const doc = this.container.ownerDocument, active = doc.activeElement as HTMLElement | null;
    if (!active || !this.container.contains(active)) return () => {};
    const selection = doc.getSelection();
    // Range clones remain live: removing their node during reparenting collapses
    // even the clone to the old parent. Store endpoint identities and offsets.
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => {
      const range = selection.getRangeAt(index);
      return { start: range.startContainer, from: range.startOffset, end: range.endContainer, to: range.endOffset };
    }) : [];
    const direction = selection?.anchorNode && selection.focusNode ? {
      anchor: selection.anchorNode, anchorOffset: selection.anchorOffset,
      focus: selection.focusNode, focusOffset: selection.focusOffset,
    } : null;
    const input = 'selectionStart' in active ? active as HTMLInputElement : null;
    const inputSelection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null;
    const scroll: [HTMLElement, number, number][] = [];
    for (let node: HTMLElement | null = active; node && this.container.contains(node); node = node.parentElement) scroll.push([node, node.scrollLeft, node.scrollTop]);
    return () => {
      if (!active.isConnected || !this.container.contains(active)) return;
      if (doc.activeElement !== active) active.focus({ preventScroll: true });
      if (input && inputSelection && inputSelection[0] !== null && inputSelection[1] !== null) {
        try { input.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2] || undefined); } catch { /* Non-text input. */ }
      } else if (selection && ranges.length && ranges.every(range => range.start.isConnected && range.end.isConnected)) {
        try {
          const restored = ranges.map(saved => { const range = doc.createRange(); range.setStart(saved.start, saved.from); range.setEnd(saved.end, saved.to); return range; });
          selection.removeAllRanges(); for (const range of restored) selection.addRange(range);
          if (ranges.length === 1 && direction?.anchor.isConnected && direction.focus.isConnected) {
            selection.setBaseAndExtent(direction.anchor, direction.anchorOffset, direction.focus, direction.focusOffset);
          }
        } catch { /* A focus handler may have replaced content or shortened text. */ }
      }
      for (const [node, left, top] of scroll) { node.scrollLeft = left; node.scrollTop = top; }
    };
  }
  private render(): void {
    const restore = this.captureFocus(), usedBranches = new Set<string>(), usedSeparators = new Set<string>();
    const contents = new Map<HTMLElement, HTMLElement[]>();
    const place = (parent: HTMLElement, element: HTMLElement, index: number) => {
      if (parent.children[index] !== element) parent.insertBefore(element, parent.children[index] || null);
    };
    const build = (node: SplitNode, parent: HTMLElement, index: number): HTMLElement => {
      if (node.type === 'leaf') { const element = this.panes.get(node.paneId)!; place(parent, element, index); return element; }
      let group = this.branches.get(node.id);
      if (!group) { group = parent.ownerDocument.createElement('div'); group.className = 'split-layout-group'; group.id = `zorid-group-${unique()}`; this.branches.set(node.id, group); }
      usedBranches.add(node.id); group.dataset.splitId = node.id; group.dataset.direction = node.direction;
      group.style.flexDirection = node.direction === 'vertical' ? 'row' : 'column'; place(parent, group, index);
      const expected: HTMLElement[] = [];
      node.children.forEach((child, childIndex) => {
        const element = build(child, group!, expected.length); expected.push(element);
        if (childIndex < node.children.length - 1) {
          const key = `${node.id}:${childIndex}`;
          let separator = this.separators.get(key);
          if (!separator) {
            separator = parent.ownerDocument.createElement('div'); separator.className = 'split-layout-separator'; separator.tabIndex = 0; separator.role = 'separator';
            // Resolve current branch/index at invocation, not a stale render object.
            separator.addEventListener('pointerdown', event => this.startResize(event, node.id, childIndex));
            separator.addEventListener('keydown', event => this.resizeKey(event, node.id, childIndex));
            separator.addEventListener('dblclick', event => { event.preventDefault(); this.resetSizes(node.id); });
            this.separators.set(key, separator);
          }
          usedSeparators.add(key); separator.dataset.direction = node.direction;
          separator.style.flex = `0 0 ${this.separatorSize}px`;
          separator.setAttribute('aria-label', node.direction === 'vertical' ? 'Resize panes left and right' : 'Resize panes above and below');
          separator.setAttribute('aria-orientation', node.direction === 'vertical' ? 'vertical' : 'horizontal');
          place(group!, separator, expected.length); expected.push(separator);
        }
      });
      contents.set(group, expected); this.applySizes(node); return group;
    };
    const expected = this.root ? [build(this.root, this.container, 0)] : [];
    if (expected[0]) expected[0].style.flex = '1 1 0px';
    contents.set(this.container, expected);
    // Move every surviving node first. Removing stale wrappers earlier could
    // disconnect a still-needed editor that is moving across split branches.
    for (const [parent, children] of contents) for (const child of Array.from(parent.children)) if (!children.includes(child as HTMLElement)) child.remove();
    for (const [id, element] of this.branches) if (!usedBranches.has(id)) { element.remove(); this.branches.delete(id); }
    for (const [id, element] of this.separators) if (!usedSeparators.has(id)) { element.remove(); this.separators.delete(id); }
    restore();
  }
  private findBranch(id: string, node = this.root): SplitBranch | null {
    if (!node || node.type === 'leaf') return null;
    if (node.id === id) return node;
    for (const child of node.children) { const found = this.findBranch(id, child); if (found) return found; }
    return null;
  }
  private applySizes(node: SplitBranch): void {
    const group = this.branches.get(node.id); if (!group) return;
    node.sizes = weights(node.sizes, node.children.length);
    node.children.forEach((child, index) => {
      const element = child.type === 'leaf' ? this.panes.get(child.paneId) : this.branches.get(child.id);
      if (element) element.style.flex = `${node.sizes[index]} 1 0px`;
      const separator = this.separators.get(`${node.id}:${index}`);
      if (separator) {
        const before = group.children[index * 2], after = group.children[index * 2 + 2];
        if (before && after) separator.setAttribute('aria-controls', `${before.id} ${after.id}`);
        const percent = node.sizes.slice(0, index + 1).reduce((a, b) => a + b, 0) * 100;
        const geometry = this.geometry(node);
        const min = geometry ? geometry.minima.slice(0, index + 1).reduce((a, b) => a + b, 0) / geometry.total * 100 : 0;
        const max = geometry ? 100 - geometry.minima.slice(index + 1).reduce((a, b) => a + b, 0) / geometry.total * 100 : 100;
        separator.setAttribute('aria-valuemin', String(Math.round(min))); separator.setAttribute('aria-valuemax', String(Math.round(max)));
        separator.setAttribute('aria-valuenow', String(Math.round(percent)));
        separator.setAttribute('aria-valuetext', `${Math.round(percent)} percent before divider`);
      }
    });
  }
  private minimumFor(node: SplitNode, axis: SplitDirection): number {
    if (node.type === 'leaf') return this.minimum;
    const sizes = node.children.map(child => this.minimumFor(child, axis));
    return node.direction === axis ? sizes.reduce((a, b) => a + b, 0) + (sizes.length - 1) * this.separatorSize : Math.max(...sizes);
  }
  private geometry(node: SplitBranch): { pixels: number[]; minima: number[]; total: number; sign: number } | null {
    const element = this.branches.get(node.id)!;
    const rect = element.getBoundingClientRect(), total = (node.direction === 'vertical' ? rect.width : rect.height) - (node.children.length - 1) * this.separatorSize;
    if (total <= 0) return null;
    const fitted = fitPixels(node.sizes, node.children.map(child => this.minimumFor(child, node.direction)), total);
    const rtl = node.direction === 'vertical' && element.ownerDocument.defaultView?.getComputedStyle(element).direction === 'rtl';
    return { ...fitted, total, sign: rtl ? -1 : 1 };
  }
  private adjust(node: SplitBranch, divider: number, amount: number, geometry: NonNullable<ReturnType<SplitLayout['geometry']>>): void {
    const pixels = [...geometry.pixels];
    const shrinking = amount > 0 ? pixels.map((_, i) => i).slice(divider + 1) : pixels.map((_, i) => i).slice(0, divider + 1).reverse();
    let remaining = Math.abs(amount), moved = 0;
    for (const index of shrinking) { const take = Math.min(remaining, Math.max(0, pixels[index] - geometry.minima[index])); pixels[index] -= take; moved += take; remaining -= take; }
    pixels[amount > 0 ? divider : divider + 1] += moved;
    node.sizes = weights(pixels, pixels.length); this.applySizes(node);
  }
  private startResize(event: PointerEvent, id: string, divider: number): void {
    if (event.button !== 0 || this.destroyed) return;
    const node = this.findBranch(id); if (!node) return;
    this.resize?.cancel();
    const geometry = this.geometry(node); if (!geometry) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget as HTMLElement, doc = target.ownerDocument, win = doc.defaultView;
    const original = [...node.sizes], start = node.direction === 'vertical' ? event.clientX : event.clientY;
    const pointerId = event.pointerId;
    let finished = false, moved = false;
    const finish = (commit: boolean) => {
      if (finished) return; finished = true; this.resize = null;
      doc.removeEventListener('pointermove', move, true); doc.removeEventListener('pointerup', up, true); doc.removeEventListener('pointercancel', cancel, true); doc.removeEventListener('keydown', key, true);
      target.removeEventListener('lostpointercapture', lost); win?.removeEventListener('blur', cancelAll);
      this.container.classList.remove('is-resizing'); target.classList.remove('is-resizing');
      try { target.releasePointerCapture?.(pointerId); } catch { /* Capture may already be lost. */ }
      if (!commit) { node.sizes = original; this.applySizes(node); }
      else if (node.sizes.some((size, index) => Math.abs(size - original[index]) > 1e-9)) this.changed('resize');
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const position = node.direction === 'vertical' ? next.clientX : next.clientY;
      if (!moved && position === start) return;
      moved = true;
      this.adjust(node, divider, (position - start) * geometry.sign, geometry); next.preventDefault();
    };
    const up = (next: PointerEvent) => { if (next.pointerId === pointerId) { move(next); finish(true); } };
    const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(false); };
    const cancelAll = () => finish(false);
    const lost = () => finish(false);
    const key = (next: KeyboardEvent) => { if (next.key === 'Escape') { next.preventDefault(); next.stopPropagation(); finish(false); } };
    this.resize = { cancel: cancelAll };
    this.container.classList.add('is-resizing'); target.classList.add('is-resizing');
    doc.addEventListener('pointermove', move, true); doc.addEventListener('pointerup', up, true); doc.addEventListener('pointercancel', cancel, true); doc.addEventListener('keydown', key, true);
    target.addEventListener('lostpointercapture', lost); win?.addEventListener('blur', cancelAll);
    try { target.setPointerCapture?.(pointerId); } catch { /* Document listeners remain the fallback. */ }
  }
  private resizeKey(event: KeyboardEvent, id: string, divider: number): void {
    const node = this.findBranch(id); if (!node || this.destroyed) return;
    const keys = node.direction === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (![...keys, 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); this.resize?.cancel();
    if (event.key === 'Enter') { this.resetSizes(id); return; }
    const geometry = this.geometry(node); if (!geometry) return;
    const before = [...node.sizes], step = event.shiftKey ? 50 : 10;
    const amount = event.key === 'Home' ? -geometry.total : event.key === 'End' ? geometry.total : (event.key === keys[0] ? -step : step) * geometry.sign;
    this.adjust(node, divider, amount, geometry);
    if (node.sizes.some((size, index) => Math.abs(size - before[index]) > 1e-9)) this.changed('resize');
  }
  private resetSizes(id: string): void {
    this.resize?.cancel(); const node = this.findBranch(id); if (!node || this.destroyed) return;
    node.sizes = weights([], node.children.length); this.applySizes(node); this.changed('resize');
  }
}
