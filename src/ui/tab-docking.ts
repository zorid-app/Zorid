/** Original tab docking controller. Static reference evidence and host responsibilities:
 * docs/tab-docking-reference.md. This module never removes a tab or serializes an editor. */
export type DockEdge = 'center' | 'left' | 'right' | 'top' | 'bottom';
export interface DockRect { x: number; y: number; width: number; height: number }
export interface DockPoint { x: number; y: number }
export interface DockPane {
  id: string;
  element: HTMLElement;
  tabBar: HTMLElement;
  tabs: readonly { id: string; element: HTMLElement }[];
  stacked?: boolean;
  disabledEdges?: readonly Exclude<DockEdge, 'center'>[];
}
export interface DockIntent {
  sourcePaneId: string;
  tabId: string;
  targetPaneId: string;
  edge: DockEdge;
  /** Center insertion index AFTER removing the source from the same pane. */
  index: number;
}
export interface TearOffIntent {
  sourcePaneId: string;
  tabId: string;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
}
export interface TabDockingOptions {
  root: HTMLElement;
  getPanes: () => readonly DockPane[];
  dock: (intent: DockIntent) => void | Promise<void>;
  tearOff?: (intent: TearOffIntent) => void | Promise<void>;
  enabled?: () => boolean;
  onError?: (error: unknown) => void;
}
const inside = (p: DockPoint, r: DockRect) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;

/** Reference edge priority is top, left, right, bottom; its threshold is strictly .33. */
export function dockZone(point: DockPoint, rect: DockRect, options: {
  headerRect?: DockRect; stacked?: boolean; disabledEdges?: readonly Exclude<DockEdge, 'center'>[];
} = {}): { edge: DockEdge; rect: DockRect } | null {
  if (rect.width <= 0 || rect.height <= 0 || !inside(point, rect)) return null;
  const disabled = new Set(options.disabledEdges);
  const header = options.headerRect;
  const inHeader = !!header && inside(point, header);
  if (options.stacked && !inHeader) { disabled.add('left'); disabled.add('right'); }
  let edge: DockEdge = 'center', best = 1;
  const top = Math.abs(point.y - rect.y) / rect.height;
  if (top < .33 && !disabled.has('top')) {
    best = top;
    if (header) {
      if (!options.stacked && inHeader) best = 0;
      if (point.y - rect.y <= header.height / 3) edge = 'top';
      else { edge = 'center'; if (options.stacked) best = 1; }
    } else edge = 'top';
  }
  const distances: [Exclude<DockEdge, 'center' | 'top'>, number][] = [
    ['left', Math.abs(point.x - rect.x) / rect.width],
    ['right', Math.abs(point.x - rect.x - rect.width) / rect.width],
    ['bottom', Math.abs(point.y - rect.y - rect.height) / rect.height],
  ];
  for (const [candidate, distance] of distances) {
    if (distance < .33 && distance < best && !disabled.has(candidate)) { edge = candidate; best = distance; }
  }
  const preview = { ...rect };
  if (edge === 'left' || edge === 'right') {
    preview.width = Math.max(rect.width / 3, 40);
    if (edge === 'right') preview.x += rect.width - preview.width;
  } else if (edge === 'top' || edge === 'bottom') {
    preview.height = Math.max(rect.height / 3, 40);
    if (edge === 'bottom') preview.y += rect.height - preview.height;
  }
  return { edge, rect: preview };
}

export function tabInsertion(clientX: number, tabs: readonly DockRect[], header: DockRect): { index: number; rect: DockRect } {
  let index = tabs.length, x = header.x, y = header.y, height = header.height;
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    if (clientX <= tab.x + tab.width || i === tabs.length - 1) {
      const after = clientX > tab.x + tab.width / 2;
      index = i + Number(after); x = tab.x + (after ? tab.width : 0); y = tab.y; height = tab.height;
      break;
    }
  }
  return { index, rect: { x: x - 5, y, width: 10, height } };
}

export function createTabDocking(options: TabDockingOptions): { destroy(): void; cancel(): void } {
  const { root } = options, doc = root.ownerDocument, win = doc.defaultView;
  if (!win) throw new Error('Tab docking requires a window');
  const preview = doc.createElement('div');
  preview.className = 'tab-docking-preview'; preview.hidden = true;
  preview.setAttribute('aria-hidden', 'true');
  let destroyed = false, pending = false;
  let session: { sourcePaneId: string; tabId: string; start: DockPoint; size: DockRect; active: boolean; outside: boolean } | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const clearLeave = () => { if (leaveTimer !== undefined) clearTimeout(leaveTimer); leaveTimer = undefined; };
  const hide = () => { preview.hidden = true; };
  const cancel = () => { clearLeave(); session = null; hide(); root.classList.remove('is-tab-dragging'); };
  const apply = (action: () => void | Promise<void>) => {
    pending = true;
    // Call synchronously so native host activation is retained, but always settle failures.
    try {
      Promise.resolve(action()).catch(error => {
        if (options.onError) options.onError(error); else console.error('Tab docking failed', error);
      }).finally(() => { pending = false; });
    } catch (error) {
      pending = false;
      if (options.onError) options.onError(error); else console.error('Tab docking failed', error);
    }
  };
  const activate = (event: DragEvent) => {
    if (!session) return false;
    const dx = event.clientX - session.start.x, dy = event.clientY - session.start.y;
    if (dx * dx + dy * dy >= 25) session.active = true;
    if (session.active) root.classList.add('is-tab-dragging');
    return session.active;
  };
  const targetAt = (event: DragEvent): { intent: DockIntent; rect: DockRect } | null => {
    if (!session || !activate(event)) return null;
    const panes = options.getPanes();
    const source = panes.find(p => p.id === session!.sourcePaneId);
    const sourceIndex = source?.tabs.findIndex(t => t.id === session!.tabId) ?? -1;
    if (!source || sourceIndex < 0) return null;
    const point = { x: event.clientX, y: event.clientY };
    // Hosts expose leaf panes only. Reverse order agrees with painting for overlaps.
    for (const pane of [...panes].reverse()) {
      if (!pane.element.isConnected) continue;
      const zone = dockZone(point, pane.element.getBoundingClientRect(), {
        headerRect: pane.tabBar.getBoundingClientRect(), stacked: pane.stacked, disabledEdges: pane.disabledEdges,
      });
      if (!zone) continue;
      let index = 0, rect = zone.rect;
      if (zone.edge === 'center') {
        const insertion = tabInsertion(point.x, pane.tabs.map(t => t.element.getBoundingClientRect()), pane.tabBar.getBoundingClientRect());
        index = insertion.index; rect = insertion.rect;
        if (pane.id === source.id) {
          if (index > sourceIndex) index--;
          if (index === sourceIndex) return null;
        }
      } else if (pane.id === source.id && source.tabs.length === 1) return null;
      return { intent: { sourcePaneId: source.id, tabId: session.tabId, targetPaneId: pane.id, edge: zone.edge, index }, rect };
    }
    return null;
  };
  const start = (event: DragEvent) => {
    if (destroyed || pending || options.enabled?.() === false || !event.target || !root.contains(event.target as Node)) return;
    const found = options.getPanes().flatMap(p => p.tabs.map(t => ({ p, t }))).find(({ t }) => t.element.contains(event.target as Node));
    if (!found) return;
    cancel();
    // Capture intercepts the previous per-tab handlers; host should remove those handlers.
    event.stopPropagation();
    session = { sourcePaneId: found.p.id, tabId: found.t.id, start: { x: event.clientX, y: event.clientY }, size: found.p.element.getBoundingClientRect(), active: false, outside: false };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-zorid-tab-docking', JSON.stringify({ version: 1, paneId: found.p.id, tabId: found.t.id }));
      event.dataTransfer.setData('text/plain', '');
    }
  };
  const over = (event: DragEvent) => {
    if (!session) return;
    event.stopPropagation();
    const target = targetAt(event);
    if (!target) { hide(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return; }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (!preview.isConnected) doc.body.append(preview);
    preview.hidden = false;
    const r = target.rect;
    preview.style.transform = `translate(${r.x}px, ${r.y}px)`;
    preview.style.width = `${r.width}px`; preview.style.height = `${r.height}px`;
    preview.dataset.edge = target.intent.edge;
  };
  const enter = (event: DragEvent) => {
    if (!session) return;
    clearLeave(); session.outside = false; over(event);
  };
  const leave = (event: DragEvent) => {
    if (!session || event.relatedTarget !== null || event.buttons === 0) return;
    hide(); clearLeave();
    leaveTimer = setTimeout(() => { if (session) session.outside = true; }, 10);
  };
  const drop = (event: DragEvent) => {
    if (!session) return;
    event.stopPropagation();
    const target = targetAt(event);
    cancel();
    if (target) { event.preventDefault(); apply(() => options.dock(target.intent)); }
  };
  const end = (event: DragEvent) => {
    if (!session) return;
    const current = session;
    // External successful drops belong to their recipient, not a new window.
    const external = current.outside && activate(event) && (!event.dataTransfer || event.dataTransfer.dropEffect === 'none');
    cancel();
    const source = external ? options.getPanes().find(pane => pane.id === current.sourcePaneId) : undefined;
    const tab = source?.tabs.find(tab => tab.id === current.tabId);
    // The source may have closed or moved while the pointer was outside this
    // window. Only current, connected ownership may request a native handoff.
    if (external && source?.element.isConnected && root.contains(source.element)
      && tab?.element.isConnected && source.element.contains(tab.element) && options.tearOff) apply(() => options.tearOff!({ sourcePaneId: current.sourcePaneId, tabId: current.tabId,
      screenX: event.screenX, screenY: event.screenY, width: current.size.width, height: current.size.height }));
  };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
  const handlers = { dragstart: start, dragover: over, dragenter: enter, dragleave: leave, drop, dragend: end };
  for (const [type, handler] of Object.entries(handlers)) win.addEventListener(type, handler as EventListener, true);
  win.addEventListener('keydown', key, true);
  return { cancel, destroy() {
    if (destroyed) return;
    destroyed = true; cancel(); preview.remove();
    for (const [type, handler] of Object.entries(handlers)) win.removeEventListener(type, handler as EventListener, true);
    win.removeEventListener('keydown', key, true);
  } };
}
