import type {BaseQueryRow} from '../bases/query.ts';
import type {NoteBuffer} from './note-buffer.ts';

export interface BaseFileHoverTarget { readonly path: string; readonly entryId: string; readonly revision: string }
export interface BaseFileHoverContent {
  /** The Workspace factory initially renders Markdown; clicking enters its normal shared-buffer editor. */
  flush(): Promise<void>;
  hasPendingChanges(): boolean;
  /** Same file identity/editor lifetime, allowing this editor's own successful save revisions. */
  isCurrent(): boolean;
  /** Property pickers, context menus and nested embeds belonging to this preview. */
  owns?(node: Node): boolean;
  /** Release only this view after nested close succeeds; never dispose its shared NoteBuffer. */
  dispose(): void | Promise<void>;
}
export interface BaseFileHoverOptions {
  readonly parent: HTMLElement;
  readonly isMac: boolean;
  readonly requiresModifier?: boolean | (() => boolean);
  readonly isCurrent: (target: BaseFileHoverTarget) => boolean;
  readonly getBuffer: (target: BaseFileHoverTarget, validate: () => void) => Promise<NoteBuffer | undefined>;
  readonly mount: (host: HTMLElement, context: {
    readonly target: BaseFileHoverTarget; readonly buffer?: NoteBuffer; readonly signal: AbortSignal;
    readonly validate: () => void; readonly onStateChange: () => void;
  }) => Promise<BaseFileHoverContent>;
  readonly onError: (error: unknown) => void;
}
export interface BaseFileHover {
  hover(row: BaseQueryRow, event: MouseEvent, anchor?: HTMLElement): void;
  hasPendingChanges(): boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
  destroy(): Promise<void>;
}
interface Slot {
  target: BaseFileHoverTarget; anchor: HTMLElement; root: HTMLElement; host: HTMLElement; error: HTMLElement;
  pointer: {x: number; y: number}; onTarget: boolean; onPopup: boolean; shown: boolean; waiting: boolean; retired: boolean;
  admitted: boolean; problem: boolean; abort: AbortController; resize?: ResizeObserver; buffer?: NoteBuffer; content?: BaseFileHoverContent;
  loading?: Promise<void>; mounting?: Promise<void>; closing?: Promise<void>; flushing?: Promise<void>;
  timers: Set<number>; showTimer?: number; preloadTimer?: number; hideTimer?: number; opportunityTimer?: number; pollTimer?: number;
  removeListeners: (() => void)[];
}

/** Base-only preview lifecycle. Workspace owns rendering, editing, buffers and durable save admission. */
export function createBaseFileHover(options: BaseFileHoverOptions): BaseFileHover {
  const document = options.parent.ownerDocument, view = document.defaultView;
  if (!view) throw new Error('A file preview requires a live document.');
  const win = view;
  let current: Slot | undefined, destroyed = false, intent = 0;
  const report = (slot: Slot | undefined, error: unknown) => {
    if (slot && !slot.retired) { slot.problem = true; slot.error.textContent = error instanceof Error ? error.message : String(error); slot.error.hidden = false; }
    try { options.onError(error); } catch { /* Error reporting must preserve retained content. */ }
  };
  const timer = (slot: Slot, delay: number, run: () => void) => { const id = win.setTimeout(() => { slot.timers.delete(id); if (!slot.retired) run(); }, delay); slot.timers.add(id); return id; };
  const clear = (slot: Slot, id: number | undefined) => { if (id !== undefined) { win.clearTimeout(id); slot.timers.delete(id); } };
  const owns = (slot: Slot, node: Node | null) => !!node && (slot.root.contains(node) || !!slot.content?.owns?.(node));
  const pending = (slot: Slot) => !!slot.mounting || !!slot.closing || !!slot.flushing || !!slot.content?.hasPendingChanges() || !!slot.content && slot.problem;
  const retained = (slot: Slot) => slot.onTarget || slot.onPopup || owns(slot, document.activeElement) || !!slot.content?.hasPendingChanges();
  const live = (slot: Slot) => !destroyed && !slot.retired && current === slot;
  const admission = (slot: Slot) => {
    if (!live(slot) || !options.parent.isConnected || !slot.anchor.isConnected || !options.parent.contains(slot.anchor) || !options.isCurrent(slot.target)) throw new Error('The file preview target changed before opening.');
  };
  const validate = (slot: Slot) => {
    if (!live(slot) || !options.parent.isConnected || !slot.root.isConnected || (slot.buffer ? slot.buffer.path !== slot.target.path || slot.buffer.savedDurableWitness?.entryId !== slot.target.entryId : !options.isCurrent(slot.target)) || slot.content && !slot.content.isCurrent()) throw new Error('The previewed file changed; its draft is retained.');
  };
  const position = (slot: Slot) => {
    if (!slot.shown || slot.retired) return;
    const r = slot.anchor.getBoundingClientRect(), gap = 10, margin = 8;
    const width = Math.min(slot.root.offsetWidth || 450, Math.max(0, win.innerWidth - margin * 2));
    const height = Math.min(slot.root.offsetHeight || 200, Math.max(0, win.innerHeight - margin * 2));
    const tall = r.height > 300, top = tall ? slot.pointer.y + gap : r.bottom + gap, above = tall ? slot.pointer.y - gap : r.top - gap;
    const rtl = win.getComputedStyle(slot.anchor).direction === 'rtl';
    const left = tall ? slot.pointer.x : rtl ? r.right - width : r.left;
    const y = top + height <= win.innerHeight - margin ? top : above - height >= margin ? above - height : Math.max(margin, win.innerHeight - height - margin);
    slot.root.style.left = `${Math.max(margin, Math.min(left, win.innerWidth - width - margin))}px`;
    slot.root.style.top = `${Math.max(margin, y)}px`;
  };
  const listen = (slot: Slot, node: EventTarget, type: string, listener: EventListener, capture = false) => {
    node.addEventListener(type, listener, capture); slot.removeListeners.push(() => node.removeEventListener(type, listener, capture));
  };
  function retire(slot: Slot) {
    if (slot.retired) return;
    slot.retired = true; slot.abort.abort(); slot.resize?.disconnect(); for (const id of slot.timers) win.clearTimeout(id); slot.timers.clear();
    for (const remove of slot.removeListeners.splice(0)) remove();
    slot.root.remove(); if (current === slot) current = undefined;
  }
  async function flushSlot(slot: Slot) {
    if (slot.flushing) return slot.flushing;
    const operation = Promise.resolve().then(async () => { await slot.mounting; if (slot.content) await slot.content.flush(); slot.problem = false; slot.error.hidden = true; });
    slot.flushing = operation;
    try { await operation; } finally { if (slot.flushing === operation) slot.flushing = undefined; }
  }
  function closeSlot(slot: Slot): Promise<void> {
    if (slot.closing) return slot.closing;
    if (slot.retired) return Promise.resolve();
    // A pending read has no editable surface and must not hold navigation open.
    if (!slot.shown && !slot.mounting && !slot.content) { retire(slot); return Promise.resolve(); }
    const operation = Promise.resolve().then(async () => {
      const inert = slot.root.inert;
      try {
        await slot.mounting;
        if (slot.content) {
          if (slot.content.hasPendingChanges() || options.parent.isConnected && slot.content.isCurrent()) await flushSlot(slot);
          if (slot.content.hasPendingChanges()) throw new Error('Finish the file preview edit before closing.');
          slot.root.inert = true;
          await slot.content.dispose();
        }
        retire(slot);
      } catch (error) { slot.root.inert = inert; report(slot, error); throw error; }
    });
    slot.closing = operation;
    void operation.then(() => { if (slot.closing === operation) slot.closing = undefined; }, () => { if (slot.closing === operation) slot.closing = undefined; });
    return operation;
  }
  function reconcile(slot: Slot) {
    if (!live(slot)) return;
    if (!slot.anchor.isConnected || !options.parent.isConnected || slot.content && !slot.content.isCurrent()) {
      if (!retained(slot) || !slot.anchor.isConnected && !owns(slot, document.activeElement) && !slot.content?.hasPendingChanges()) void closeSlot(slot).catch(() => {});
      return;
    }
    if (retained(slot)) { clear(slot, slot.hideTimer); slot.hideTimer = undefined; }
    else if (!slot.shown) retire(slot);
    else if (slot.hideTimer === undefined) slot.hideTimer = timer(slot, 300, () => { slot.hideTimer = undefined; if (!retained(slot)) void closeSlot(slot).catch(() => {}); });
  }
  function mount(slot: Slot) {
    if (!live(slot) || !slot.shown || !slot.admitted || slot.content || slot.mounting) return;
    const operation = Promise.resolve().then(async () => {
      admission(slot);
      const content = await options.mount(slot.host, {target: slot.target, buffer: slot.buffer, signal: slot.abort.signal, validate: () => validate(slot), onStateChange: () => { if (live(slot)) { position(slot); reconcile(slot); } }});
      slot.content = content;
      if (!live(slot)) { await content.dispose(); return; }
      validate(slot); slot.root.classList.remove('is-loading'); slot.root.removeAttribute('aria-busy');
      slot.host.removeAttribute('aria-label'); position(slot); reconcile(slot);
    });
    slot.mounting = operation;
    void operation.catch(error => { if (live(slot)) report(slot, error); }).finally(() => { if (slot.mounting === operation) slot.mounting = undefined; });
  }
  function preload(slot: Slot) {
    if (slot.loading || slot.retired) return;
    const operation = Promise.resolve().then(async () => {
      admission(slot); const buffer = await options.getBuffer(slot.target, () => admission(slot)); admission(slot);
      if (buffer) {
        await buffer.load(slot.target.entryId, () => admission(slot)); admission(slot);
        const witness = buffer.savedDurableWitness;
        if (buffer.path !== slot.target.path || witness?.entryId !== slot.target.entryId || witness.revision !== slot.target.revision) throw new Error('The file preview revision changed before opening.');
      }
      slot.buffer = buffer; slot.admitted = true; mount(slot);
    });
    slot.loading = operation;
    void operation.catch(error => {
      if (!live(slot)) return;
      if (!options.isCurrent(slot.target) || !slot.anchor.isConnected) { retire(slot); return; }
      report(slot, error);
    });
  }
  function poll(slot: Slot) { slot.pollTimer = timer(slot, 500, () => { reconcile(slot); if (live(slot)) { position(slot); poll(slot); } }); }
  function arm(slot: Slot) {
    if (!live(slot) || !slot.waiting) return;
    slot.waiting = false; clear(slot, slot.opportunityTimer);
    slot.preloadTimer = timer(slot, 200, () => preload(slot));
    slot.showTimer = timer(slot, 300, () => {
      try { admission(slot); slot.shown = true; document.body.append(slot.root); if (win.ResizeObserver) { slot.resize = new win.ResizeObserver(() => position(slot)); slot.resize.observe(slot.root); } position(slot); mount(slot); poll(slot); }
      catch { retire(slot); }
    });
  }
  function start(target: BaseFileHoverTarget, anchor: HTMLElement, event: MouseEvent) {
    if (destroyed || !options.parent.isConnected || !anchor.isConnected || !options.parent.contains(anchor) || !options.isCurrent(target)) return;
    const root = document.createElement('div'); root.className = 'popover hover-popover bases-file-hover is-loading'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'File preview'); root.setAttribute('aria-busy', 'true');
    Object.assign(root.style, {position: 'fixed', zIndex: 'var(--layer-popover, 1000)', boxSizing: 'border-box', width: 'min(var(--popover-width, 450px), calc(100vw - 16px))', maxHeight: 'min(var(--popover-height, 400px), calc(100vh - 16px))', overflow: 'auto', border: '1px solid var(--background-modifier-border, #ddd)', borderRadius: 'var(--radius-m, 8px)', background: 'var(--background-primary, white)', color: 'var(--text-normal, #222)', boxShadow: 'var(--shadow-l, 0 8px 24px #0004)'});
    const host = document.createElement('div'); host.className = 'bases-file-hover-content'; host.setAttribute('aria-label', 'Loading file preview');
    const error = document.createElement('div'); error.className = 'bases-file-hover-error'; error.setAttribute('role', 'alert'); error.hidden = true; root.append(host, error);
    const slot: Slot = {target, anchor, root, host, error, pointer: {x: event.clientX, y: event.clientY}, onTarget: true, onPopup: false, shown: false, waiting: true, retired: false, admitted: false, problem: false, abort: new AbortController(), timers: new Set(), removeListeners: []}; current = slot;
    const mod = (event: MouseEvent | KeyboardEvent) => options.isMac ? event.metaKey : event.ctrlKey;
    const contains = (element: HTMLElement, event: Event) => { const related = (event as MouseEvent).relatedTarget as Node | null; return !!related && element.contains(related); };
    listen(slot, anchor, 'mouseover', event => { if (!contains(anchor, event)) { slot.onTarget = true; reconcile(slot); } });
    listen(slot, anchor, 'mouseout', event => { if (!contains(anchor, event)) { slot.onTarget = false; reconcile(slot); } });
    listen(slot, root, 'mouseover', event => { if (!contains(root, event)) { slot.onPopup = true; reconcile(slot); } });
    listen(slot, root, 'mouseout', event => { if (!contains(root, event)) { slot.onPopup = false; reconcile(slot); } });
    listen(slot, root, 'focusin', () => reconcile(slot)); listen(slot, root, 'focusout', () => { queueMicrotask(() => reconcile(slot)); });
    listen(slot, document, 'keydown', event => {
      if (!slot.waiting) return; const key = event as KeyboardEvent;
      if (key.isComposing) return;
      if (key.key.startsWith('Arrow') || key.key.length === 1) retire(slot); else if (mod(key)) arm(slot);
    });
    listen(slot, document, 'mousemove', () => { if (slot.waiting) { clear(slot, slot.opportunityTimer); slot.opportunityTimer = timer(slot, 2000, () => retire(slot)); } });
    listen(slot, document, 'mouseleave', () => { slot.onTarget = false; reconcile(slot); });
    const outside = (event: Event) => { if (!live(slot) || owns(slot, event.target as Node)) return; if (!slot.shown) retire(slot); else timer(slot, 5, () => { if (!retained(slot)) void closeSlot(slot).catch(() => {}); }); };
    listen(slot, document, 'pointerdown', outside, true); listen(slot, document, 'contextmenu', outside, true);
    listen(slot, win, 'resize', () => position(slot)); listen(slot, win, 'scroll', () => position(slot), true);
    const required = typeof options.requiresModifier === 'function' ? options.requiresModifier() : options.requiresModifier ?? true;
    if (!required || mod(event)) arm(slot);
  }
  const observer = new win.MutationObserver(() => { if (current && !options.parent.isConnected) void closeSlot(current).catch(() => {}); else if (current?.shown && !current.anchor.isConnected) reconcile(current); });
  observer.observe(document.body, {subtree: true, childList: true});
  return {
    hover(row, event, explicitAnchor) {
      if (destroyed || event.defaultPrevented || !row.entryId || !row.revision || document.body.classList.contains('is-grabbing')) return;
      const candidate = explicitAnchor ?? event.currentTarget ?? event.target;
      if (!(candidate instanceof win.HTMLElement)) return;
      const target = Object.freeze({path: row.path, entryId: row.entryId, revision: row.revision}), anchor = candidate;
      if (current?.anchor === anchor && current.target.entryId === target.entryId && current.target.path === target.path && (current.shown || current.target.revision === target.revision)) return;
      const serial = ++intent, previous = current;
      if (!previous) start(target, anchor, event);
      else void closeSlot(previous).then(() => { if (!destroyed && serial === intent) start(target, anchor, event); }).catch(() => {});
    },
    hasPendingChanges() { return !!current && pending(current); },
    async flush() { if (!current) return; if (!current.shown) { retire(current); return; } await flushSlot(current); },
    close() { intent++; return current ? closeSlot(current) : Promise.resolve(); },
    async destroy() { intent++; if (current) await closeSlot(current); destroyed = true; observer.disconnect(); },
  };
}
