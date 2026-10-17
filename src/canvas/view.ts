import { CANVAS_NODE_TYPES, CanvasDocument } from './document.ts';
import type { CanvasEdge, CanvasNode, CanvasValue } from './document.ts';
import { showContextMenu } from '../platform/context-menu.ts';
import type { ContextMenuItem } from '../platform/context-menu.ts';
import { icon } from '../ui/dom.ts';
import type { EditorOptions } from '../ui/editor.ts';
import type { EmbedRequest } from '../ui/markdown.ts';
import { createCanvasMarkdownCard } from './markdown-card.ts';
import type { CanvasMarkdownCard, CanvasMarkdownSession } from './markdown-card.ts';

export interface CanvasViewOptions {
  document: CanvasDocument;
  onChange(source: string, document: CanvasDocument): void | Promise<void>;
  openFile?(path: string, subpath?: string): void | Promise<void>;
  openLink?(url: string): void | Promise<void>;
  /** Resolve Markdown targets relative to the containing Canvas file. */
  openMarkdownLink?(target: string, kind: 'wiki' | 'markdown'): void | Promise<void>;
  /** Each returned owner is destroyed once when its card refreshes or closes. */
  renderMarkdownEmbed?(request: EmbedRequest, nodeId: string): { element: HTMLElement; destroy(): void };
  /** Shared NoteBuffer lease for an existing Markdown file, never Canvas JSON. */
  openMarkdownFile?(path: string): Promise<CanvasMarkdownSession>;
  textEditorOptions?: Omit<EditorOptions, 'value' | 'mode' | 'onChange'>;
  /** Pane-owned embedded drafts outlive individual text-card renderer widgets.
   * The host coalesces concurrent flushes and retains drafts after teardown. */
  textEmbedLifecycle?: { flush(): Promise<void>; hasPendingChanges(): boolean };
  chooseFile?(kind?: 'note' | 'media'): Promise<string | null>;
  filePathsFromDrop?(transfer: DataTransfer): readonly string[];
  renderFile?(path: string, subpath?: string): { element: HTMLElement; destroy(): void };
  openFileInNewTab?(path: string): void | Promise<void>;
  copyText?(text: string): void | Promise<void>;
  onError?(error: unknown): void;
}
export interface CanvasView {
  readonly element: HTMLElement;
  readonly document: CanvasDocument;
  /** Identical source is a reload acknowledgement; changed source resets local history. */
  setDocument(document: CanvasDocument): void;
  undo(): void;
  redo(): void;
  /** Commit the active editor and await persistence; rejects on failure, retries on a later call. */
  flush(): Promise<void>;
  /** True for an edited card draft, queued persistence or the latest failed write. */
  hasPendingChanges(): boolean;
  destroy(): void;
}
interface ProjectedNode { data: CanvasNode; original: CanvasNode }
interface Projection { nodes: Map<string, ProjectedNode>; edges: Map<string, CanvasEdge>; hidden: number }

/** The view's map projection never deletes or normalizes the source records. */
export function projectCanvas(document: CanvasDocument): Projection {
  const nodes = new Map<string, ProjectedNode>(), edges = new Map<string, CanvasEdge>();
  document.nodes.forEach(node => {
    const previous = nodes.get(node.id);
    if (!previous && !(CANVAS_NODE_TYPES as readonly string[]).includes(node.type)) return;
    const data = { ...previous?.data, ...node, type: previous?.data.type ?? node.type } as CanvasNode;
    nodes.set(node.id, { data: { ...data, x: Math.round(data.x), y: Math.round(data.y), width: Math.round(data.width), height: Math.round(data.height) }, original: node });
  });
  for (const edge of document.edges) {
    if (nodes.has(edge.fromNode) && nodes.has(edge.toNode)) edges.set(edge.id, edge);
    else edges.delete(edge.id);
  }
  return { nodes, edges, hidden: document.nodes.length - nodes.size + document.edges.length - edges.size };
}

const svgNS = 'http://www.w3.org/2000/svg';
let viewSequence = 0;

/** Original interactive Canvas surface. Source transactions and viewport state are independent. */
export function createCanvasView(parent: HTMLElement, options: CanvasViewOptions): CanvasView {
  const dom = parent.ownerDocument, win = dom.defaultView!;
  const element = dom.createElement('section'); element.className = 'zorid-canvas';
  const toolbar = dom.createElement('div'); toolbar.className = 'zorid-canvas-toolbar'; toolbar.setAttribute('aria-label', 'Canvas controls');
  const cardMenu = dom.createElement('div'); cardMenu.className = 'zorid-canvas-card-menu'; cardMenu.setAttribute('aria-label', 'Canvas creation');
  const viewport = dom.createElement('div'); viewport.className = 'zorid-canvas-viewport'; viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Canvas');
  const world = dom.createElement('div'); world.className = 'zorid-canvas-world';
  const svg = dom.createElementNS(svgNS, 'svg'); svg.classList.add('zorid-canvas-edges');
  const background = dom.createElementNS(svgNS, 'svg'); background.classList.add('zorid-canvas-background'); background.setAttribute('aria-hidden', 'true');
  const pattern = dom.createElementNS(svgNS, 'pattern'), dot = dom.createElementNS(svgNS, 'circle'), fill = dom.createElementNS(svgNS, 'rect');
  pattern.id = `zorid-canvas-dots-${++viewSequence}`; pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  dot.setAttribute('cx', '.7'); dot.setAttribute('cy', '.7'); dot.setAttribute('r', '.7'); pattern.append(dot);
  fill.setAttribute('width', '100%'); fill.setAttribute('height', '100%'); fill.setAttribute('fill', `url(#${pattern.id})`); background.append(pattern, fill);
  world.append(svg); viewport.append(background, world);
  const status = dom.createElement('div'); status.className = 'zorid-canvas-status'; status.setAttribute('role', 'status');
  const selectedDescription = dom.createElement('span'), unselectedDescription = dom.createElement('span');
  selectedDescription.id = `zorid-canvas-selected-${viewSequence}`; selectedDescription.hidden = true; selectedDescription.textContent = 'Selected';
  unselectedDescription.id = `zorid-canvas-unselected-${viewSequence}`; unselectedDescription.hidden = true; unselectedDescription.textContent = 'Not selected';
  const selectionStatus = dom.createElement('div'); selectionStatus.className = 'zorid-canvas-selection-status'; selectionStatus.setAttribute('role', 'status'); selectionStatus.setAttribute('aria-live', 'polite'); selectionStatus.setAttribute('aria-atomic', 'true');
  Object.assign(selectionStatus.style, { position: 'absolute', width: '1px', height: '1px', padding: '0', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' });
  element.append(viewport, toolbar, cardMenu, status, selectedDescription, unselectedDescription, selectionStatus); parent.append(element);
  let document = options.document, projection = projectCanvas(document), closed = false;
  let renderedSource = document.toString();
  let tx = 40, ty = 40, scale = 1, space = false, saveQueue = Promise.resolve();
  const undoStack: string[] = [], redoStack: string[] = [], selectedNodes = new Set<string>(), selectedEdges = new Set<string>();
  const nodeEls = new Map<string, HTMLElement>(), edgeEls = new Map<string, { group: SVGGElement; path: SVGPathElement; hit: SVGPathElement; label: HTMLDivElement; arrows: SVGGElement[] }>();
  const textCards = new Map<string, { original: CanvasNode; text: string; card: CanvasMarkdownCard; listeners: Set<(text: string) => void> }>();
  const attachments = new Map<string, { file: string; subpath: string; owner: { element: HTMLElement; destroy(): void } }>();
  const fileCards = new Map<string, { file: string; subpath: string; card: CanvasMarkdownCard }>();
  let drag: { id: number; mode: 'move' | 'pan' | 'select'; startX: number; startY: number; x: number; y: number; dx: number; dy: number; positions: Map<string, { x: number; y: number }>; prior: Set<string> } | undefined;
  let editor: HTMLTextAreaElement | undefined;
  let editorOriginal = '';
  let editorFailure: unknown;
  let finishEditing: ((save: boolean) => void) | undefined;
  let saveVersion = 0, completedSaveVersion = 0;
  let failedSave: { error: unknown; version: number } | undefined;
  let pendingTextSave: { source: string; version: number } | undefined;
  let menuVersion = 0, announcedSelection = '';
  const box = dom.createElement('div'); box.className = 'zorid-canvas-selection-box';
  const report = (error: unknown) => {
    if (!closed) status.textContent = `Unable to save Canvas: ${error instanceof Error ? error.message : String(error)}`;
    try { options.onError?.(error); } catch { /* Error observers must not interrupt the persistence queue. */ }
  };
  const invoke = (action: (() => void | Promise<void>) | undefined) => { if (!closed && action) try { Promise.resolve(action()).catch(report); } catch (error) { report(error); } };
  const button = (host: HTMLElement, name: string, glyph: string, action: () => void, size = 16) => {
    const button = dom.createElement('button'); button.type = 'button'; button.title = name; button.setAttribute('aria-label', name);
    button.append(icon(glyph, size, dom)); button.onclick = () => { if (!closed && !editor) action(); }; host.append(button); return button;
  };
  const controlGroup = () => { const group = dom.createElement('div'); group.className = 'zorid-canvas-control-group'; toolbar.append(group); return group; };
  const zoomControls = controlGroup();
  button(zoomControls, 'Zoom in', 'plus', () => zoom(scale * Math.SQRT2));
  button(zoomControls, 'Reset zoom', 'rotate-cw', () => zoom(1));
  button(zoomControls, 'Fit canvas', 'maximize', () => fit());
  button(zoomControls, 'Zoom out', 'minus', () => zoom(scale / Math.SQRT2));
  const historyControls = controlGroup();
  const undoButton = button(historyControls, 'Undo', 'undo-2', () => undo()), redoButton = button(historyControls, 'Redo', 'redo-2', () => redo());
  button(cardMenu, 'Add card', 'sticky-note', () => {
    let id = `node-${Date.now().toString(36)}`; let suffix = 0; while (document.getNode(id)) id = `node-${Date.now().toString(36)}-${++suffix}`;
    commit(draft => draft.addNode({ id, type: 'text', x: Math.round(((viewport.clientWidth || 800) / 2 - tx) / scale - 125), y: Math.round(((viewport.clientHeight || 600) / 2 - ty) / scale - 30), width: 250, height: 60, text: '' }));
    selectedNodes.clear(); selectedNodes.add(id); paintSelection(); startEditing(id);
  }, 32);
  if (options.chooseFile) {
    button(cardMenu, 'Add note', 'file', () => { void chooseFile(undefined, 'note').catch(report); }, 32);
    button(cardMenu, 'Add media', 'file', () => { void chooseFile(undefined, 'media').catch(report); }, 32);
  }
  const position = (node: CanvasNode) => {
    const preview = drag?.positions.get(node.id);
    return preview ? { ...node, x: preview.x + drag!.dx, y: preview.y + drag!.dy } : node;
  };
  function color(value: CanvasValue | undefined): string {
    if (typeof value !== 'string') return '';
    return /^[1-6]$/.test(value) ? `var(--zc-color-${value})` : /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : '';
  }
  function groupForeground(value: CanvasValue | undefined): string {
    if (typeof value !== 'string' || !color(value)) return '';
    if (/^[1-6]$/.test(value)) return `var(--zc-label-${value})`;
    const hex = value.slice(1), rgb = hex.length <= 4 ? hex.slice(0, 3).split('').map(digit => parseInt(digit + digit, 16)) : [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
    const brightness = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114;
    return brightness >= 150 ? 'var(--text-on-accent-inverted, #000)' : 'var(--text-on-accent, #fff)';
  }
  function drawNode(id: string): void {
    const node = position(projection.nodes.get(id)!.data), item = nodeEls.get(id)!;
    item.style.left = `${node.x}px`; item.style.top = `${node.y}px`; item.style.width = `${Math.max(1, node.width)}px`; item.style.height = `${Math.max(1, node.height)}px`;
    item.classList.toggle('is-dragging', !!drag?.positions.has(id) && !!(drag.dx || drag.dy));
  }
  function endpoint(node: CanvasNode, side: CanvasValue | undefined, other: CanvasNode) {
    if (!['left', 'right', 'top', 'bottom'].includes(String(side))) {
      const dx = other.x + other.width / 2 - node.x - node.width / 2, dy = other.y + other.height / 2 - node.y - node.height / 2;
      side = Math.abs(dy) * node.width > Math.abs(dx) * node.height ? dy >= 0 ? 'bottom' : 'top' : dx >= 0 ? 'right' : 'left';
    }
    return { x: node.x + (side === 'left' ? 0 : side === 'right' ? node.width : node.width / 2), y: node.y + (side === 'top' ? 0 : side === 'bottom' ? node.height : node.height / 2), side: side as 'top' | 'right' | 'bottom' | 'left' };
  }
  function drawEdge(id: string): void {
    const edge = projection.edges.get(id)!, item = edgeEls.get(id)!, from = position(projection.nodes.get(edge.fromNode)!.data), to = position(projection.nodes.get(edge.toNode)!.data);
    const a = endpoint(from, edge.fromSide, to), b = endpoint(to, edge.toSide, from);
    const outward = (point: typeof a, distance: number) => ({ ...point, x: point.x + (point.side === 'right' ? distance : point.side === 'left' ? -distance : 0), y: point.y + (point.side === 'bottom' ? distance : point.side === 'top' ? -distance : 0) });
    const start = outward(a, 7), end = outward(b, 7), reach = Math.min(150, Math.max(70, Math.hypot(end.x - start.x, end.y - start.y) / 2));
    const first = outward(start, reach), second = outward(end, reach);
    let path = `M ${start.x} ${start.y} C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`;
    if ((edge.fromEnd ?? 'none') !== 'arrow') path = `M ${a.x} ${a.y} L ${start.x} ${start.y} ${path}`;
    if ((edge.toEnd ?? 'arrow') !== 'arrow') path += ` M ${end.x} ${end.y} L ${b.x} ${b.y}`;
    item.path.setAttribute('d', path); item.hit.setAttribute('d', path);
    for (const arrow of item.arrows) {
      const point = arrow.dataset.end === 'from' ? a : b, degrees = { top: 180, right: 270, bottom: 0, left: 90 }[point.side];
      arrow.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${degrees})`);
    }
    item.label.style.left = `${(start.x + 3 * first.x + 3 * second.x + end.x) / 8}px`;
    item.label.style.top = `${(start.y + 3 * first.y + 3 * second.y + end.y) / 8}px`;
  }
  function transform(): void {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; viewport.dataset.zoom = String(scale);
    const zoomLevel = Math.log2(scale), spacing = (zoomLevel < -3.3 ? 160 : zoomLevel < -2.16 ? 80 : zoomLevel < -.91 ? 40 : 20) * scale;
    pattern.setAttribute('x', String(tx % spacing)); pattern.setAttribute('y', String(ty % spacing)); pattern.setAttribute('width', String(spacing)); pattern.setAttribute('height', String(spacing));
    const compensation = Math.sqrt(1 / scale); element.style.setProperty('--zc-zoom-compensation', String(compensation)); element.classList.toggle('is-zoomed-out', zoomLevel <= -1.7);
  }
  function zoom(next: number, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2): void {
    next = Math.max(1 / 16, Math.min(2, next)); const ratio = next / scale;
    tx = x - (x - tx) * ratio; ty = y - (y - ty) * ratio; scale = next; transform();
  }
  function fit(nodes = [...projection.nodes.values()].map(node => node.data)): void {
    if (!nodes.length) { tx = ty = 40; scale = 1; transform(); return; }
    const minX = Math.min(...nodes.map(n => n.x)), minY = Math.min(...nodes.map(n => n.y));
    const width = Math.max(...nodes.map(n => n.x + n.width)) - minX, height = Math.max(...nodes.map(n => n.y + n.height)) - minY;
    const vw = viewport.clientWidth || 800, vh = viewport.clientHeight || 600;
    scale = Math.max(1 / 16, Math.min(1, (vw - 80) / Math.max(1, width), (vh - 80) / Math.max(1, height))); tx = (vw - width * scale) / 2 - minX * scale; ty = (vh - height * scale) / 2 - minY * scale; transform();
  }
  function paintSelection(): void {
    for (const [id, item] of nodeEls) { item.classList.toggle('is-selected', selectedNodes.has(id)); item.setAttribute('aria-describedby', selectedNodes.has(id) ? selectedDescription.id : unselectedDescription.id); }
    for (const [id, item] of edgeEls) item.group.classList.toggle('is-selected', selectedEdges.has(id));
    const parts = [selectedNodes.size ? `${selectedNodes.size} ${selectedNodes.size === 1 ? 'card' : 'cards'}` : '', selectedEdges.size ? `${selectedEdges.size} ${selectedEdges.size === 1 ? 'connection' : 'connections'}` : ''].filter(Boolean);
    const announcement = parts.length ? `${parts.join(' and ')} selected` : 'No items selected';
    const selection = JSON.stringify([[...selectedNodes].sort(), [...selectedEdges].sort()]);
    if (selection !== announcedSelection) { announcedSelection = selection; selectionStatus.textContent = announcement; }
    for (const [id, entry] of [...fileCards, ...textCards]) if (!selectedNodes.has(id)) void entry.card.deactivate().catch(report);
  }
  function markdownFile(node: CanvasNode): boolean { return node.type === 'file' && /\.md$/i.test(String(node.file)) && !!options.openMarkdownFile; }
  function assertCanReplaceCards(next: CanvasDocument, allowQueuedText = false): void {
    const projected = projectCanvas(next);
    for (const [id, entry] of textCards) {
      const node = projected.nodes.get(id)?.data;
      if ((!node || node.type !== 'text' || String(node.text ?? '') !== entry.text) && (entry.card.hasUnacceptedChanges() || !!failedSave || !!options.textEmbedLifecycle?.hasPendingChanges() || !allowQueuedText && saveVersion > completedSaveVersion)) throw new Error('The text card has unsaved changes. Save it before removing or replacing the card.');
    }
    for (const [id, entry] of fileCards) {
      const node = projected.nodes.get(id)?.data;
      if ((!node || !markdownFile(node) || node.file !== entry.file || String(node.subpath ?? '') !== entry.subpath) && entry.card.hasPendingChanges()) {
        throw new Error('The note card has unsaved changes. Save it before removing or replacing the card.');
      }
    }
  }
  function fileCard(node: CanvasNode): CanvasMarkdownCard {
    const file = String(node.file), subpath = String(node.subpath ?? '');
    const previous = fileCards.get(node.id);
    if (previous?.file === file && previous.subpath === subpath) return previous.card;
    previous?.card.destroy();
    const entry = { file, subpath, card: undefined as unknown as CanvasMarkdownCard };
    entry.card = createCanvasMarkdownCard(dom, {
      load: () => options.openMarkdownFile!(file), subpath,
      isCurrent: () => !closed && fileCards.get(node.id) === entry,
      onError: report,
      onEditingChange(editing) {
        if (closed || fileCards.get(node.id) !== entry) return;
        menuVersion++; nodeEls.get(node.id)?.classList.toggle('is-editing', editing);
        if (editing) { selectedNodes.clear(); selectedEdges.clear(); selectedNodes.add(node.id); paintSelection(); }
      },
    });
    fileCards.set(node.id, entry); return entry.card;
  }
  function ownsInput(target: Element): boolean {
    return !!target.closest('button,input,textarea,select,a,video,audio,.interactive-child,.zorid-canvas-note-editor') || hasEditableOwner(target);
  }
  function hasEditableOwner(target: Element): boolean {
    // Resolve inherited editable state, including plaintext-only and explicit
    // false islands, without relying on globals from the main window.
    for (let owner: Element | null = target; owner && owner !== viewport; owner = owner.parentElement) {
      const editable = owner.getAttribute('contenteditable')?.toLowerCase();
      if (editable === 'false') return false;
      if (editable === '' || editable === 'true' || editable === 'plaintext-only') return true;
    }
    return false;
  }
  function textCard(node: CanvasNode): CanvasMarkdownCard {
    const previous = textCards.get(node.id);
    if (previous) return previous.card;
    const entry = { original: projection.nodes.get(node.id)!.original, text: String(node.text ?? ''), card: undefined as unknown as CanvasMarkdownCard, listeners: new Set<(text: string) => void>() };
    let released = false;
    const current = () => !closed && !released && textCards.get(node.id) === entry;
    const sourceCurrent = () => { try { recordIndex(document.nodes, entry.original); return current(); } catch { return false; } };
    const session: CanvasMarkdownSession = {
      getText: () => entry.text,
      update(next, expected) {
        if (!current() || expected !== entry.text) throw new Error('Canvas text changed while editing. Keep this draft and reopen the item.');
        const index = recordIndex(document.nodes, entry.original);
        if (next === entry.text) return;
        const before = document.toString();
        document.transaction(draft => draft.setRoot('nodes', draft.nodes.map((raw, i) => i === index ? { ...raw, text: next } : raw)));
        entry.original = document.nodes[index]; entry.text = next;
        // CodeMirror owns this DOM update. Do not reparent or dispatch into its
        // editor synchronously from the onChange listener.
        projection = projectCanvas(document); renderedSource = document.toString(); menuVersion++;
        undoStack.push(before); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0;
        undoButton.disabled = false; redoButton.disabled = true; publish(true);
      },
      subscribe(listener) { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; },
      async flush() { await options.textEmbedLifecycle?.flush(); await flushPersistence(); },
      hasPendingChanges: () => saveVersion > completedSaveVersion || !!failedSave || !!options.textEmbedLifecycle?.hasPendingChanges(),
      editorOptions: {
        paths: () => [], ...options.textEditorOptions,
        open(target, kind = 'markdown', event) {
          if (!sourceCurrent()) return;
          if (options.textEditorOptions) options.textEditorOptions.open(target, kind, event);
          else if (options.openMarkdownLink) invoke(() => options.openMarkdownLink!(target, kind));
          else if (options.openFile) { const at = target.indexOf('#'); invoke(() => options.openFile!(at < 0 ? target : target.slice(0, at), at < 0 ? undefined : target.slice(at))); }
        },
        renderEmbed: options.renderMarkdownEmbed ? request => { const owner = options.renderMarkdownEmbed!(request, node.id); return { dom: owner.element, destroy: () => owner.destroy() }; } : options.textEditorOptions?.renderEmbed,
      },
      destroy() { released = true; entry.listeners.clear(); },
    };
    entry.card = createCanvasMarkdownCard(dom, {
      load: () => session, editLabel: 'Edit card text', isCurrent: current, isPreviewCurrent: sourceCurrent, onError: report,
      onEditingChange(editing) {
        if (!current()) return;
        menuVersion++; nodeEls.get(node.id)?.classList.toggle('is-editing', editing);
        if (editing) { selectedNodes.clear(); selectedEdges.clear(); selectedNodes.add(node.id); paintSelection(); }
      },
    });
    entry.card.element.addEventListener('click', event => {
      const anchor = (event.target as Element).closest<HTMLAnchorElement>('a.external-link');
      if (anchor && sourceCurrent() && options.openLink) { event.preventDefault(); event.stopPropagation(); invoke(() => options.openLink!(anchor.href)); }
    });
    textCards.set(node.id, entry); return entry.card;
  }
  function render(refreshTextPreviews = false): void {
    menuVersion++;
    const focused = dom.activeElement instanceof win.HTMLElement && world.contains(dom.activeElement) ? dom.activeElement : undefined;
    finishEditing?.(false); projection = projectCanvas(document); renderedSource = document.toString();
    for (const [id, entry] of textCards) {
      const projected = projection.nodes.get(id);
      if (!projected || projected.data.type !== 'text') { entry.card.destroy(); textCards.delete(id); }
      else {
        entry.original = projected.original;
        const text = String(projected.data.text ?? '');
        if (text !== entry.text) { entry.text = text; for (const listener of entry.listeners) listener(text); }
        else if (refreshTextPreviews) entry.card.refreshPreview();
      }
    }
    for (const [id, entry] of attachments) {
      const node = projection.nodes.get(id)?.data;
      if (!node || node.type !== 'file' || node.file !== entry.file || String(node.subpath ?? '') !== entry.subpath) { try { entry.owner.destroy(); } catch (error) { report(error); } attachments.delete(id); }
    }
    for (const [id, entry] of fileCards) {
      const node = projection.nodes.get(id)?.data;
      if (!node || !markdownFile(node) || node.file !== entry.file || String(node.subpath ?? '') !== entry.subpath) { entry.card.destroy(); fileCards.delete(id); }
    }
    for (const item of nodeEls.values()) item.remove(); for (const item of edgeEls.values()) { item.group.remove(); item.label.remove(); } nodeEls.clear(); edgeEls.clear();
    for (const id of selectedNodes) if (!projection.nodes.has(id)) selectedNodes.delete(id);
    for (const id of selectedEdges) if (!projection.edges.has(id)) selectedEdges.delete(id);
    for (const [id, { data: node }] of projection.nodes) {
      const item = dom.createElement('div'); item.className = `zorid-canvas-node is-${node.type}`; item.dataset.nodeId = id; item.setAttribute('role', 'group'); item.setAttribute('aria-roledescription', 'Canvas card');
      item.style.setProperty('--canvas-node-color', color(node.color) || 'var(--zc-border)'); item.classList.toggle('is-themed', !!color(node.color));
      const frame = dom.createElement('div'); frame.className = 'zorid-canvas-node-frame';
      const content = dom.createElement('div'); content.className = 'zorid-canvas-node-content';
      if (node.type === 'text') { const card = textCard(node); content.append(card.element); item.append(card.toolbar); item.classList.toggle('is-editing', card.isEditing()); item.setAttribute('aria-label', 'Text card'); }
      else if (node.type === 'group') {
        const label = dom.createElement('div'); label.className = 'zorid-canvas-group-label'; label.textContent = String(node.label ?? ''); label.hidden = !label.textContent;
        label.style.setProperty('--zc-label-foreground', groupForeground(node.color));
        item.append(label); item.setAttribute('aria-label', `Group: ${label.textContent}`);
      }
      else if (markdownFile(node)) {
        const card = fileCard(node); content.append(card.element); item.append(card.toolbar); item.classList.toggle('is-editing', card.isEditing());
        item.setAttribute('aria-label', `Note: ${String(node.file)}`);
        const label = dom.createElement('div'); label.className = 'zorid-canvas-node-label';
        label.textContent = String(node.file).split('/').at(-1)!.replace(/\.md$/i, '') + (node.subpath ? ` › ${String(node.subpath).replace(/^#/, '')}` : '');
        label.ondblclick = event => { event.preventDefault(); event.stopPropagation(); invoke(options.openFile ? () => options.openFile!(String(node.file), typeof node.subpath === 'string' ? node.subpath : undefined) : undefined); };
        item.append(label);
      } else if (node.type === 'file' && options.renderFile) {
        const file = String(node.file), subpath = String(node.subpath ?? '');
        let entry = attachments.get(id);
        if (!entry) {
          try { entry = { file, subpath, owner: options.renderFile(file, subpath || undefined) }; attachments.set(id, entry); }
          catch (error) { content.textContent = `Unable to display ${file}`; report(error); }
        }
        content.classList.add('zorid-canvas-attachment'); if (entry) content.append(entry.owner.element);
        item.setAttribute('aria-label', `File: ${file}`);
        const label = dom.createElement('div'); label.className = 'zorid-canvas-node-label'; label.textContent = file.split('/').at(-1)!; item.append(label);
        label.ondblclick = event => { event.preventDefault(); event.stopPropagation(); invoke(options.openFile ? () => options.openFile!(file, subpath || undefined) : undefined); };
      } else {
        const open = dom.createElement('button'); open.type = 'button'; open.className = 'zorid-canvas-open';
        open.textContent = String(node.type === 'file' ? node.file ?? '' : node.url ?? ''); open.title = open.textContent;
        open.onclick = () => node.type === 'file' ? invoke(options.openFile ? () => options.openFile!(String(node.file), typeof node.subpath === 'string' ? node.subpath : undefined) : undefined) : invoke(options.openLink ? () => options.openLink!(String(node.url)) : undefined);
        content.append(open); item.setAttribute('aria-label', `${node.type === 'file' ? 'File' : 'Link'}: ${open.textContent}`);
        const label = dom.createElement('div'); label.className = 'zorid-canvas-node-label';
        label.textContent = node.type === 'link' ? String(node.url ?? '') : String(node.file ?? '').split('/').at(-1)!.replace(/\.md$/i, '') + (node.subpath ? ` › ${String(node.subpath).replace(/^#/, '')}` : '');
        item.append(label);
      }
      frame.append(content); item.append(frame); world.append(item); nodeEls.set(id, item); drawNode(id);
      item.ondblclick = event => {
        if (event.defaultPrevented || nodeEls.get(id) !== item || ownsInput(event.target as Element)) return;
        if (markdownFile(node)) { event.preventDefault(); selectedNodes.clear(); selectedEdges.clear(); selectedNodes.add(id); paintSelection(); invoke(() => fileCards.get(id)!.card.activate({ x: event.clientX, y: event.clientY })); }
        else if (node.type === 'text') { event.preventDefault(); startEditing(id, 'text', { x: event.clientX, y: event.clientY }); }
      };
    }
    for (const [id, edge] of projection.edges) {
      const group = dom.createElementNS(svgNS, 'g'), path = dom.createElementNS(svgNS, 'path'), hit = dom.createElementNS(svgNS, 'path'), label = dom.createElement('div'), arrows: SVGGElement[] = [];
      group.dataset.edgeId = id; group.classList.add('zorid-canvas-edge'); group.style.setProperty('--canvas-edge-color', color(edge.color) || 'var(--zc-border)');
      path.classList.add('zorid-canvas-edge-line'); hit.classList.add('zorid-canvas-edge-hit'); group.append(hit, path);
      for (const [end, marker] of [['from', edge.fromEnd ?? 'none'], ['to', edge.toEnd ?? 'arrow']]) if (marker === 'arrow') {
        const wrapper = dom.createElementNS(svgNS, 'g'), triangle = dom.createElementNS(svgNS, 'polygon'); wrapper.dataset.end = String(end);
        triangle.classList.add('zorid-canvas-arrow'); triangle.setAttribute('points', '0,0 6.5,10.4 -6.5,10.4'); wrapper.append(triangle); arrows.push(wrapper); group.append(wrapper);
      }
      label.className = 'zorid-canvas-edge-label'; label.dataset.edgeLabelId = id; label.textContent = typeof edge.label === 'string' ? edge.label : ''; label.hidden = !label.textContent;
      svg.append(group); world.append(label); edgeEls.set(id, { group, path, hit, label, arrows }); drawEdge(id);
    }
    status.textContent = projection.hidden ? `${projection.hidden} unrendered or duplicate records retained in the file` : '';
    undoButton.disabled = !undoStack.length; redoButton.disabled = !redoStack.length; transform(); paintSelection();
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  }
  function publish(coalesceText = false): void {
    if (closed) return;
    const source = document.toString(), version = ++saveVersion;
    if (coalesceText && pendingTextSave) { pendingTextSave.source = source; pendingTextSave.version = version; return; }
    const save = { source, version };
    // Text changes replace only a not-yet-started text snapshot. Geometry/scalar
    // writes remain ordering barriers. A held adapter cannot build a per-key
    // queue of full Canvas writes; at most one following text write is pending.
    pendingTextSave = coalesceText ? save : undefined;
    saveQueue = saveQueue.then(async () => {
      if (pendingTextSave === save) pendingTextSave = undefined;
      try {
        await options.onChange(save.source, CanvasDocument.parse(save.source));
        failedSave = undefined;
      } catch (error) {
        failedSave = { error, version: save.version };
        report(error);
      } finally { completedSaveVersion = save.version; }
    });
  }
  async function flush(): Promise<void> {
    if (!closed) {
      finishEditing?.(true);
      if (editorFailure) throw editorFailure;
      for (const entry of [...fileCards.values(), ...textCards.values()]) await entry.card.flush();
      // Also cover retained host drafts whose source embed was removed while
      // editing, including the case with no currently mounted text card.
      await options.textEmbedLifecycle?.flush();
    }
    await flushPersistence();
  }
  async function flushPersistence(): Promise<void> {
    if (!closed) {
      // Retry only a failure already known on entry, not a first failure that
      // occurs while this flush waits. Concurrent flushes share that retry.
      if (failedSave && completedSaveVersion === saveVersion) publish();
    }
    let tail: Promise<void>;
    do { tail = saveQueue; await tail; } while (tail !== saveQueue);
    if (failedSave?.version === saveVersion) throw failedSave.error;
  }
  function commit(operation: (draft: CanvasDocument) => void): void {
    if (closed) return;
    const before = document.toString();
    try { document.transaction(draft => { operation(draft); assertCanReplaceCards(draft, true); }); } catch (error) { report(error); return; }
    if (before === document.toString()) return;
    undoStack.push(before); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; render(); publish();
  }
  function undo(): void {
    if (closed || editor || drag || !undoStack.length) return;
    try { assertCanReplaceCards(CanvasDocument.parse(undoStack.at(-1)!), true); } catch (error) { report(error); return; }
    redoStack.push(document.toString()); document.replaceSource(undoStack.pop()!); render(); publish();
  }
  function redo(): void {
    if (closed || editor || drag || !redoStack.length) return;
    try { assertCanReplaceCards(CanvasDocument.parse(redoStack.at(-1)!), true); } catch (error) { report(error); return; }
    undoStack.push(document.toString()); document.replaceSource(redoStack.pop()!); render(); publish();
  }
  function openValueEditor(host: HTMLElement, label: string, value: string, change: (draft: CanvasDocument, value: string) => void, cleanup?: () => void, afterSave?: () => void): void {
    if (editor || closed) return;
    menuVersion++;
    const input = dom.createElement('textarea'); input.className = 'zorid-canvas-text-editor'; input.setAttribute('aria-label', label); input.value = value;
    const initialValue = input.value; // Native textarea normalizes CRLF/CR on assignment.
    input.title = 'Ctrl/⌘ Enter to save; Escape to cancel';
    host.append(input); editor = input; editorOriginal = input.value; editorFailure = undefined; input.focus();
    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      let next: CanvasDocument | undefined;
      if (save && !closed && input.value !== initialValue) {
        try { next = CanvasDocument.parse(document.toString()); change(next, input.value); }
        catch (error) { editorFailure = error; report(error); return; }
      }
      finished = true; editor = undefined; editorFailure = undefined; finishEditing = undefined;
      input.onblur = null; input.onkeydown = null; input.remove(); cleanup?.();
      if (next) { commit(draft => draft.replaceSource(next!.toString())); afterSave?.(); }
      if (!closed) viewport.focus();
    };
    finishEditing = finish;
    input.onblur = () => finish(true);
    input.onkeydown = event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); finish(false); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(true); } };
  }
  function startEditing(id: string, field: 'text' | 'label' | 'url' = 'text', point?: { x: number; y: number }): void {
    const node = projection.nodes.get(id), host = nodeEls.get(id);
    if (!node || !host || field === 'text' && node.data.type !== 'text') return;
    if (field === 'text') { invoke(() => textCards.get(id)!.card.activate(point)); return; }
    const label = field === 'label' ? 'Edit group label' : 'Change URL';
    const original = node.original;
    openValueEditor(host, label, String(node.data[field] ?? ''), (draft, value) => {
      const index = recordIndex(draft.nodes, original);
      draft.setRoot('nodes', draft.nodes.map((raw, i) => i === index ? { ...raw, [field]: value } : raw));
    });
  }
  function recordIndex(records: readonly (CanvasNode | CanvasEdge)[], original: CanvasNode | CanvasEdge): number {
    const matches = records.map((record, index) => ({ record, index })).filter(({ record }) => record.id === original.id && JSON.stringify(record) === JSON.stringify(original));
    if (matches.length !== 1) throw new Error('Canvas item changed while editing. Keep this draft or cancel and reopen the item.');
    return matches[0].index;
  }
  function popupEditor(label: string, value: string, change: (draft: CanvasDocument, value: string) => void, afterSave?: () => void): void {
    if (closed || editor) return;
    const host = dom.createElement('div'); host.setAttribute('role', 'dialog'); host.setAttribute('aria-label', label);
    Object.assign(host.style, { position: 'absolute', left: '20px', top: '20px', width: 'min(320px, calc(100% - 40px))', height: '100px', zIndex: '6' });
    viewport.append(host); openValueEditor(host, label, value, change, () => host.remove(), afterSave);
  }
  function clearDrag(): void { drag = undefined; box.remove(); viewport.classList.remove('is-panning'); }
  const pointerDown = (event: PointerEvent) => {
    if (closed || editor || event.defaultPrevented || event.isPrimary === false) return;
    menuVersion++;
    const target = event.target as Element;
    if (ownsInput(target)) return;
    const node = target.closest<HTMLElement>('[data-node-id]'), edge = target.closest<HTMLElement | SVGElement>('[data-edge-id],[data-edge-label-id]');
    const pan = event.button === 1 || (event.button === 0 && space); if (!pan && event.button !== 0) return;
    event.preventDefault(); viewport.focus();
    const prior = new Set(selectedNodes);
    if (!pan) {
      if (node) {
        const id = node.dataset.nodeId!;
        if (event.shiftKey) { if (selectedNodes.has(id)) selectedNodes.delete(id); else selectedNodes.add(id); }
        else if (!selectedNodes.has(id)) { selectedNodes.clear(); selectedEdges.clear(); selectedNodes.add(id); }
      } else if (edge) {
        const id = (edge.dataset.edgeId ?? edge.dataset.edgeLabelId)!; if (!event.shiftKey) { selectedNodes.clear(); selectedEdges.clear(); }
        if (selectedEdges.has(id)) selectedEdges.delete(id); else selectedEdges.add(id);
      } else if (!event.shiftKey) { selectedNodes.clear(); selectedEdges.clear(); }
      paintSelection();
    }
    if (edge && !pan) return;
    const positions = new Map<string, { x: number; y: number }>();
    if (!pan && node && selectedNodes.has(node.dataset.nodeId!)) for (const id of selectedNodes) { const data = projection.nodes.get(id)!.data; positions.set(id, { x: data.x, y: data.y }); }
    drag = { id: event.pointerId, mode: pan ? 'pan' : node ? 'move' : 'select', startX: event.clientX, startY: event.clientY, x: tx, y: ty, dx: 0, dy: 0, positions, prior: event.shiftKey ? prior : new Set() };
    viewport.classList.toggle('is-panning', pan);
    if (drag.mode === 'select') viewport.append(box);
    viewport.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event: PointerEvent) => {
    if (closed || !drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (drag.mode === 'pan') { tx = drag.x + dx; ty = drag.y + dy; transform(); return; }
    drag.dx = Math.round(dx / scale); drag.dy = Math.round(dy / scale);
    if (drag.mode === 'move') {
      for (const id of drag.positions.keys()) drawNode(id);
      for (const [id, edge] of projection.edges) if (drag.positions.has(edge.fromNode) || drag.positions.has(edge.toNode)) drawEdge(id);
    } else {
      const rect = viewport.getBoundingClientRect(), x1 = Math.min(drag.startX, event.clientX) - rect.left, y1 = Math.min(drag.startY, event.clientY) - rect.top, x2 = x1 + Math.abs(dx), y2 = y1 + Math.abs(dy);
      Object.assign(box.style, { left: `${x1}px`, top: `${y1}px`, width: `${Math.abs(dx)}px`, height: `${Math.abs(dy)}px` });
      selectedNodes.clear(); for (const id of drag.prior) selectedNodes.add(id);
      for (const [id, { data: node }] of projection.nodes) if (node.x * scale + tx <= x2 && (node.x + node.width) * scale + tx >= x1 && node.y * scale + ty <= y2 && (node.y + node.height) * scale + ty >= y1) selectedNodes.add(id);
      paintSelection();
    }
  };
  const finishDrag = (event: PointerEvent, cancelled = false) => {
    if (closed || !drag || drag.id !== event.pointerId) return;
    const ended = drag; clearDrag();
    if (ended.mode === 'move' && !cancelled && (ended.dx || ended.dy)) {
      commit(draft => {
        const indices = new Map([...ended.positions].map(([id, point]) => [recordIndex(draft.nodes, projection.nodes.get(id)!.original), point]));
        draft.setRoot('nodes', draft.nodes.map((node, index) => { const point = indices.get(index); return point ? { ...node, x: point.x + ended.dx, y: point.y + ended.dy } : node; }));
      });
      // A rejected transaction must also restore the preview to source geometry.
      for (const id of ended.positions.keys()) drawNode(id); for (const id of projection.edges.keys()) drawEdge(id);
    } else if (ended.mode === 'move') { for (const id of ended.positions.keys()) drawNode(id); for (const id of projection.edges.keys()) drawEdge(id); }
    if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener('pointerdown', pointerDown); viewport.addEventListener('pointermove', pointerMove);
  viewport.addEventListener('pointerup', event => finishDrag(event)); viewport.addEventListener('pointercancel', event => finishDrag(event, true)); viewport.addEventListener('lostpointercapture', event => finishDrag(event, true));
  viewport.addEventListener('wheel', event => {
    if (closed || editor || drag || event.defaultPrevented || ownsInput(event.target as Element)) return;
    if ((event.target as Element).closest('.zorid-canvas-markdown-card,.zorid-canvas-attachment') && !event.ctrlKey && !event.metaKey && !space) return;
    event.preventDefault();
    const factor = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    if (event.ctrlKey || event.metaKey || space) { const rect = viewport.getBoundingClientRect(); zoom(scale * Math.pow(2, -event.deltaY * factor / 300), event.clientX - rect.left, event.clientY - rect.top); }
    else { tx -= (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * factor * 0.93; if (!event.shiftKey || event.deltaX) ty -= event.deltaY * factor * 0.93; transform(); }
  }, { passive: false });
  viewport.onkeydown = event => {
    if (closed || editor || event.defaultPrevented || ownsInput(event.target as Element)) return;
    if (event.key === ' ') { event.preventDefault(); space = true; }
    else if (event.key === 'Escape') { if (drag) finishDrag({ pointerId: drag.id } as PointerEvent, true); selectedNodes.clear(); selectedEdges.clear(); paintSelection(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) redo(); else undo(); }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && !event.repeat && !drag && dom.activeElement === viewport) {
      event.preventDefault(); event.stopPropagation();
      if (!selectedNodes.size && !selectedEdges.size) return;
      commit(draft => {
        draft.setRoot('edges', draft.edges.filter(edge => !selectedEdges.has(edge.id) && !selectedNodes.has(edge.fromNode) && !selectedNodes.has(edge.toNode)));
        draft.setRoot('nodes', draft.nodes.filter(node => !selectedNodes.has(node.id)));
      });
    }
  };
  viewport.onkeyup = event => { if (event.key === ' ') space = false; };
  viewport.onblur = () => { space = false; };
  const selectionKey = () => JSON.stringify([[...selectedNodes].sort(), [...selectedEdges].sort()]);
  function selectionNodes(): CanvasNode[] {
    const ids = new Set(selectedNodes);
    for (const id of selectedEdges) {
      const edge = projection.edges.get(id); if (edge) { ids.add(edge.fromNode); ids.add(edge.toNode); }
    }
    return [...ids].map(id => projection.nodes.get(id)?.data).filter((node): node is CanvasNode => !!node);
  }
  function uniqueNodeId(): string {
    let id = `node-${Date.now().toString(36)}`, suffix = 0;
    while (document.getNode(id)) id = `node-${Date.now().toString(36)}-${++suffix}`;
    return id;
  }
  let fileRequest = 0;
  function insertFiles(paths: readonly string[], point?: { x: number; y: number }): void {
    if (closed || !paths.length) return;
    const origin = point ?? { x: Math.round(((viewport.clientWidth || 800) / 2 - tx) / scale - 200), y: Math.round(((viewport.clientHeight || 600) / 2 - ty) / scale - 200) };
    const ids: string[] = [];
    commit(draft => {
      for (const [index, file] of paths.entries()) {
        if (typeof file !== 'string' || !file) continue;
        let id = uniqueNodeId(); while (draft.getNode(id)) id += '-copy';
        draft.addNode({ id, type: 'file', file, x: origin.x + index * 24, y: origin.y + index * 24, width: 400, height: 400 }); ids.push(id);
      }
    });
    selectedNodes.clear(); selectedEdges.clear(); for (const id of ids) if (projection.nodes.has(id)) selectedNodes.add(id); paintSelection();
  }
  async function chooseFile(point?: { x: number; y: number }, kind?: 'note' | 'media'): Promise<void> {
    if (closed || !options.chooseFile) return;
    const request = ++fileRequest, owner = document, source = document.toString();
    const file = await options.chooseFile(kind);
    if (closed || request !== fileRequest || owner !== document || source !== document.toString()) return;
    if (file) insertFiles([file], point);
  }
  viewport.addEventListener('dragover', event => {
    if (closed || event.defaultPrevented || !event.dataTransfer || ownsInput(event.target as Element)) return;
    try { if (options.filePathsFromDrop?.(event.dataTransfer).length) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } } catch (error) { report(error); }
  });
  viewport.addEventListener('drop', event => {
    if (closed || event.defaultPrevented || !event.dataTransfer || ownsInput(event.target as Element)) return;
    try {
      const paths = options.filePathsFromDrop?.(event.dataTransfer); if (!paths?.length) return;
      event.preventDefault(); event.stopPropagation(); const rect = viewport.getBoundingClientRect();
      insertFiles(paths, { x: Math.round((event.clientX - rect.left - tx) / scale), y: Math.round((event.clientY - rect.top - ty) / scale) });
    } catch (error) { report(error); }
  });
  function removeSelection(): void {
    if (!selectedNodes.size && !selectedEdges.size) return;
    commit(draft => {
      draft.setRoot('edges', draft.edges.filter(edge => !selectedEdges.has(edge.id) && !selectedNodes.has(edge.fromNode) && !selectedNodes.has(edge.toNode)));
      draft.setRoot('nodes', draft.nodes.filter(node => !selectedNodes.has(node.id)));
    });
  }
  async function contextMenu(event: MouseEvent): Promise<void> {
    if (closed || drag || event.defaultPrevented) return;
    const target = event.target as Element;
    // Active text editors keep the platform's spelling/selection/clipboard menu.
    if (target.closest('textarea,input,select') || hasEditableOwner(target)) return;
    event.preventDefault(); event.stopPropagation();
    const nodeId = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
    const edgeTarget = target.closest<HTMLElement | SVGElement>('[data-edge-id],[data-edge-label-id]');
    const edgeId = edgeTarget?.dataset.edgeId ?? edgeTarget?.dataset.edgeLabelId;
    const owner = document;
    finishEditing?.(true);
    const openingVersion = ++menuVersion, openingSource = document.toString();
    try {
      await flush();
      if (closed || editor || owner !== document || openingVersion !== menuVersion || openingSource !== document.toString() || !element.isConnected) return;
      const node = nodeId ? projection.nodes.get(nodeId)?.data : undefined;
      const edge = edgeId ? projection.edges.get(edgeId) : undefined;
      if (nodeId && !node || edgeId && !edge) return;
      const multi = selectedNodes.size + selectedEdges.size > 1 && (nodeId ? selectedNodes.has(nodeId) : edgeId ? selectedEdges.has(edgeId) : false);
      if (!multi) {
        selectedNodes.clear(); selectedEdges.clear();
        if (nodeId) selectedNodes.add(nodeId); else if (edgeId) selectedEdges.add(edgeId);
      }
      const contextSelection = selectionKey();
      for (const [id, entry] of [...fileCards, ...textCards]) if (!selectedNodes.has(id)) await entry.card.deactivate();
      if (closed || owner !== document || openingSource !== document.toString() || contextSelection !== selectionKey()) return;
      paintSelection(); viewport.focus();
      const source = document.toString(), selected = selectionKey(), version = ++menuVersion;
      const items: ContextMenuItem[] = [], actions = new Map<string, () => void | Promise<void>>();
      const add = (id: string, label: string, run: () => void | Promise<void>) => { items.push({ id, label }); actions.set(id, run); };
      const separator = () => { if (items.length && !('type' in items[items.length - 1])) items.push({ type: 'separator' }); };
      const rect = viewport.getBoundingClientRect(), point = { x: Math.round((event.clientX - rect.left - tx) / scale), y: Math.round((event.clientY - rect.top - ty) / scale) };
      const create = (type: 'text' | 'group' | 'link', extra: Record<string, CanvasValue> = {}, bounds = { ...point, width: type === 'text' ? 250 : 400, height: type === 'text' ? 60 : 400 }) => {
        const id = uniqueNodeId();
        commit(draft => draft.addNode({ id, type, ...bounds, ...(type === 'text' ? { text: '' } : type === 'group' ? { label: 'Untitled group' } : {}), ...extra }));
        selectedNodes.clear(); selectedEdges.clear(); selectedNodes.add(id); paintSelection();
        if (type !== 'link') startEditing(id, type === 'text' ? 'text' : 'label');
      };
      if (multi) {
        add('zoom-selection', 'Zoom to selection', () => fit(selectionNodes()));
        add('create-group', 'Create group', () => {
          const nodes = selectionNodes(); if (!nodes.length) return;
          const x = Math.min(...nodes.map(node => node.x)) - 20, y = Math.min(...nodes.map(node => node.y)) - 20;
          const width = Math.max(...nodes.map(node => node.x + node.width)) + 20 - x, height = Math.max(...nodes.map(node => node.y + node.height)) + 20 - y;
          create('group', {}, { x, y, width, height });
        });
        separator(); add('delete', 'Delete', removeSelection);
      } else if (node && nodeId) {
        add('zoom-selection', 'Zoom to selection', () => fit([node]));
        if (node.type === 'text') add('edit', 'Edit', () => startEditing(nodeId));
        if (node.type === 'group') add('edit-label', 'Edit label', () => startEditing(nodeId, 'label'));
        if (node.type === 'link') {
          add('change-url', 'Change URL...', () => startEditing(nodeId, 'url'));
          if (options.openLink) add('open-link', 'Open external link', () => options.openLink!(String(node.url)));
          const copy = options.copyText ?? (win.navigator.clipboard?.writeText ? (text: string) => win.navigator.clipboard.writeText(text) : undefined);
          if (copy) add('copy-url', 'Copy URL', () => copy(String(node.url)));
        }
        if (node.type === 'file' && /\.md$/i.test(String(node.file)) && options.openFileInNewTab) {
          separator(); add('open-new-tab', 'Open in new tab', () => options.openFileInNewTab!(String(node.file)));
        }
        if (markdownFile(node) && fileCards.get(nodeId)?.card.isEditable()) add('edit-note', 'Edit', () => fileCards.get(nodeId)!.card.activate());
        separator(); add('remove', 'Remove', removeSelection);
      } else if (edge && edgeId) {
        add('edit-label', 'Edit label', () => {
          popupEditor('Edit connection label', String(edge.label ?? ''), (draft, label) => {
            const index = recordIndex(draft.edges, edge);
            draft.setRoot('edges', draft.edges.map((record, i) => i === index ? { ...record, label } : record));
          });
        });
        add('follow-connection', 'Follow connection', () => {
          const from = projection.nodes.get(edge.fromNode)!.data, to = projection.nodes.get(edge.toNode)!.data;
          const a = endpoint(from, edge.fromSide, to), b = endpoint(to, edge.toSide, from);
          const distance = (p: { x: number; y: number }) => Math.hypot(point.x - p.x, point.y - p.y);
          fit([distance(a) > distance(b) ? from : to]);
        });
        separator(); add('remove', 'Remove', removeSelection);
      } else {
        add('add-card', 'Add card', () => create('text'));
        if (options.chooseFile) {
          add('add-note', 'Add note from vault', () => chooseFile(point, 'note'));
          add('add-media', 'Add media from vault', () => chooseFile(point, 'media'));
        }
        add('add-web-page', 'Add web page', () => {
          let id: string | undefined;
          popupEditor('Web page URL', '', (draft, url) => {
            if (url.trim()) { id = uniqueNodeId(); draft.addNode({ id, type: 'link', ...point, width: 400, height: 400, url }); }
          }, () => { if (id) { selectedNodes.clear(); selectedEdges.clear(); selectedNodes.add(id); paintSelection(); } });
        });
        add('create-group', 'Create group', () => create('group'));
        if (undoStack.length || redoStack.length) separator();
        if (undoStack.length) add('undo', 'Undo', undo);
        if (redoStack.length) add('redo', 'Redo', redo);
      }
      const action = await showContextMenu(event, items, { document: dom });
      if (!action || closed || editor || version !== menuVersion || owner !== document || source !== document.toString() || selected !== selectionKey() || !element.isConnected) return;
      await actions.get(action)?.();
    } catch (error) { if (!closed) report(error); }
  }
  viewport.addEventListener('contextmenu', event => { void contextMenu(event); });
  const windowBlur = () => { space = false; if (drag) finishDrag({ pointerId: drag.id } as PointerEvent, true); };
  win.addEventListener('blur', windowBlur);
  render();
  return {
    element, get document() { return document; }, undo, redo, flush,
    hasPendingChanges: () => !!editor && editor.value !== editorOriginal || saveVersion > completedSaveVersion || !!failedSave || !!options.textEmbedLifecycle?.hasPendingChanges() || [...fileCards.values(), ...textCards.values()].some(entry => entry.card.hasPendingChanges()),
    setDocument(next) {
      // File watchers also report our own completed writes. Replacing identical
      // source would discard undo/redo, active drafts and rich renderer owners.
      if (closed) return;
      menuVersion++; // A host refresh still invalidates already-open menu actions.
      // The model is public and mutable: equal model strings alone do not prove
      // the rendered projection already represents this source.
      const source = next.toString();
      if (source === renderedSource && source === document.toString()) return;
      assertCanReplaceCards(next);
      finishEditing?.(false); clearDrag(); document = next; undoStack.length = redoStack.length = 0; selectedNodes.clear(); selectedEdges.clear(); render(true);
    },
    destroy() { if (closed) return; closed = true; finishEditing?.(false); clearDrag(); for (const entry of [...fileCards.values(), ...textCards.values()]) entry.card.destroy(); fileCards.clear(); textCards.clear(); for (const entry of attachments.values()) try { entry.owner.destroy(); } catch (error) { report(error); } attachments.clear(); win.removeEventListener('blur', windowBlur); element.remove(); },
  };
}
