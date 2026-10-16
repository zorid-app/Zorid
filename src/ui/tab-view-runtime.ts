/** Own one loaded tab's live content independently of pane chrome. This is a
 * same-document lifecycle boundary, not a serializable cross-window handoff. */
export interface TabViewOwner { paneId: string; vaultId: string; vaultGeneration: number }
/** Process-local token issued by one runtime; copied/serialized tokens are not current. */
export interface TabViewOwnership { id: string; revision: number; owner: Readonly<TabViewOwner> }
export type TabViewPhase = 'active' | 'moving' | 'closing' | 'disposed';
export interface TabViewRuntimeOptions {
  id: string;
  element: HTMLElement;
  owner: TabViewOwner;
  /** Settle pending edits before close; failure must leave the view usable. */
  flush(): void | Promise<void>;
  /** Releases owned editor/widgets/leases once, after a successful flush. */
  dispose(): void | Promise<void>;
  focus?(): void;
  /** Optional child-view adapter. Capture before moving; returned callback
   * restores focus after insertion, or after rollback if insertion fails. It
   * must tolerate a second restore call if its first call throws. Lifecycle
   * changes are blocked while capture/restore owns the move transition. */
  captureFocus?(): () => void;
}
export interface TabViewRuntime {
  readonly id: string;
  readonly element: HTMLElement;
  readonly owner: Readonly<TabViewOwner>;
  readonly revision: number;
  readonly phase: TabViewPhase;
  captureOwnership(): TabViewOwnership;
  isCurrent(value: TabViewOwnership): boolean;
  /** Mark a document/view-state mutation. Also invalidates pending close. */
  touch(): void;
  /** Atomic synchronous move. No save, disposal or reconstruction occurs. */
  attach(host: HTMLElement, owner: TabViewOwner, expectedRevision?: number): boolean;
  /** Keep resources alive while detached. Reactivation/focus policy is host-owned. */
  detach(expectedRevision?: number): boolean;
  focus(): void;
  /** Coalesces concurrent close requests. A failed flush can be retried. */
  destroy(expectedRevision?: number): Promise<void>;
}

function copyOwner(owner: TabViewOwner): Readonly<TabViewOwner> {
  if (!owner || typeof owner.paneId !== 'string' || !owner.paneId || typeof owner.vaultId !== 'string' || !owner.vaultId
    || !Number.isSafeInteger(owner.vaultGeneration) || owner.vaultGeneration < 0) throw new Error('Invalid tab view owner');
  return Object.freeze({ paneId: owner.paneId, vaultId: owner.vaultId, vaultGeneration: owner.vaultGeneration });
}
const sameOwner = (a: Readonly<TabViewOwner>, b: Readonly<TabViewOwner>) => a.paneId === b.paneId && a.vaultId === b.vaultId && a.vaultGeneration === b.vaultGeneration;

/** Store immutable endpoints: a cloned DOM Range is live and collapses when its
 * node is removed. This also preserves reversed DOM and text-input selections. */
function captureDOMFocus(element: HTMLElement): () => void {
  const doc = element.ownerDocument, active = doc.activeElement as HTMLElement | null;
  if (!active || !element.contains(active)) return () => {};
  const selection = doc.getSelection(), ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => {
    const range = selection.getRangeAt(index);
    return { start: range.startContainer, from: range.startOffset, end: range.endContainer, to: range.endOffset };
  }) : [];
  const direction = selection?.anchorNode && selection.focusNode ? {
    anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset,
  } : null;
  const input = 'selectionStart' in active ? active as HTMLInputElement : null;
  const inputSelection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null;
  const scroll: [HTMLElement, number, number][] = [];
  for (let node: HTMLElement | null = active; node && element.contains(node); node = node.parentElement) scroll.push([node, node.scrollLeft, node.scrollTop]);
  return () => {
    if (!active.isConnected || !element.contains(active)) return;
    if (doc.activeElement !== active) active.focus({ preventScroll: true });
    if (input && inputSelection && inputSelection[0] !== null && inputSelection[1] !== null) {
      try { input.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2] ?? undefined); } catch { /* Non-text input. */ }
    } else if (selection && ranges.length && ranges.every(range => range.start.isConnected && range.end.isConnected)) {
      try {
        const restored = ranges.map(saved => { const range = doc.createRange(); range.setStart(saved.start, saved.from); range.setEnd(saved.end, saved.to); return range; });
        selection.removeAllRanges(); for (const range of restored) selection.addRange(range);
        if (ranges.length === 1 && direction?.anchor.isConnected && direction.focus.isConnected) {
          selection.setBaseAndExtent(direction.anchor, direction.anchorOffset, direction.focus, direction.focusOffset);
        }
      } catch { /* A focus handler can replace content; editor state remains authoritative. */ }
    }
    for (const [node, left, top] of scroll) { node.scrollLeft = left; node.scrollTop = top; }
  };
}

export function createTabViewRuntime(options: TabViewRuntimeOptions): TabViewRuntime {
  if (typeof options.id !== 'string' || !options.id) throw new Error('Tab view requires a stable ID');
  const { id, element, flush, dispose, focus, captureFocus } = options;
  let owner = copyOwner(options.owner), revision = 0, phase: TabViewPhase = 'active';
  const issued = new WeakSet<TabViewOwnership>();
  let disposal: Promise<void> | undefined;
  const assertActive = (expected = revision) => {
    if (phase !== 'active') throw new Error(`Tab view is ${phase}`);
    if (expected !== revision) throw new Error('Tab view ownership changed');
  };
  const restorePosition = (parent: Node | null, next: Node | null) => {
    if (parent) parent.insertBefore(element, next?.parentNode === parent ? next : null);
    else element.remove();
  };
  return {
    id, element,
    get owner() { return owner; }, get revision() { return revision; }, get phase() { return phase; },
    captureOwnership() { const token = Object.freeze({ id, revision, owner }); issued.add(token); return token; },
    isCurrent(value) { return phase === 'active' && !!value && issued.has(value) && value.id === id && value.revision === revision && !!value.owner && sameOwner(value.owner, owner); },
    touch() { if (phase === 'disposed') throw new Error('Tab view is disposed'); revision++; },
    attach(host, value, expected) {
      assertActive(expected);
      const nextOwner = copyOwner(value);
      if (host.ownerDocument !== element.ownerDocument) throw new Error('Tab views cannot move across documents');
      if (nextOwner.vaultId !== owner.vaultId || nextOwner.vaultGeneration !== owner.vaultGeneration) throw new Error('Tab view vault ownership changed');
      if (host === element || element.contains(host)) throw new Error('Tab view cannot contain its destination');
      if (!host.isConnected) throw new Error('Tab view destination is detached');
      if (element.parentNode === host && sameOwner(owner, nextOwner)) return false;
      const previousOwner = owner, parent = element.parentNode, next = element.nextSibling;
      let restoreFocus = () => {};
      phase = 'moving'; const movingRevision = ++revision;
      try {
        restoreFocus = (captureFocus ?? (() => captureDOMFocus(element)))();
        if (revision !== movingRevision) throw new Error('Tab view changed while capturing its move');
        host.appendChild(element); owner = nextOwner;
        restoreFocus(); phase = 'active'; return true;
      } catch (error) {
        owner = previousOwner; revision++;
        try {
          if (element.parentNode !== parent || element.nextSibling !== next) restorePosition(parent, next);
          restoreFocus();
        }
        catch (rollback) { throw new AggregateError([error, rollback], 'Tab view attachment and rollback failed'); }
        finally { phase = 'active'; }
        throw error;
      }
    },
    detach(expected) {
      assertActive(expected);
      if (!element.parentNode) return false;
      element.remove(); revision++; return true;
    },
    focus() { assertActive(); if (focus) focus(); else element.focus({ preventScroll: true }); },
    destroy(expected) {
      if (disposal) return disposal;
      try { assertActive(expected); } catch (error) { return Promise.reject(error); }
      phase = 'closing'; const closingRevision = ++revision;
      // Publish the promise before invoking host code, so a synchronous
      // reentrant close from flush observes the same pending operation.
      disposal = Promise.resolve().then(async () => {
        try {
          await flush();
          if (revision !== closingRevision) throw new Error('Tab view changed while closing');
        } catch (error) { phase = 'active'; throw error; }
        phase = 'disposed'; revision++;
        try { await dispose(); }
        finally { element.remove(); }
      });
      const current = disposal;
      void current.catch(() => { if (phase === 'active' && disposal === current) disposal = undefined; });
      return current;
    },
  };
}
