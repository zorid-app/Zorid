/** Original file-tree drag behavior. See docs/file-tree-drag-reference.md. */
export interface FileTreeEntry { path: string; type: 'file' | 'folder' }
export interface FileTreeDragRow {
  path: string;
  element: HTMLElement;
  /** Optional folder wrapper containing its descendants; flat trees also work. */
  container?: HTMLElement;
  collapsed?: boolean;
}
export interface FileTreeMove { source: string; destination: string }
export interface FileTreeMoveIntent { paths: readonly string[]; folder: string }
export interface FileTreeMoveContext { isCurrent(): boolean; isSourceCurrent(path: string): boolean }
export interface FileTreeDragOptions {
  root: HTMLElement;
  getEntries(): readonly FileTreeEntry[];
  getRows(): readonly FileTreeDragRow[];
  getSelectedPaths(): readonly string[];
  /** Stable until a vault switch. Never use only its display name. */
  getVaultToken(): unknown;
  /** Stable per entry lifetime; change on delete/recreate/rename, not ordinary edits. */
  getEntryToken(path: string): unknown;
  expandFolder(path: string): void;
  move(intent: FileTreeMoveIntent, context: FileTreeMoveContext): void | Promise<void>;
  enabled?(): boolean;
  rootLabel?: string;
  onError?(error: unknown): void;
}
export const FILE_TREE_HOVER_DELAY = 750;
export const FILE_TREE_DRAG_MIME = 'application/x-zorid-file-tree';
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const key = (path: string) => path.normalize('NFC').toLowerCase();
const validPath = (path: string) => !!path && !/[\\\u0000-\u001f]/.test(path) && !path.startsWith('/') && !/^[a-z]:/i.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..');
const within = (child: string, folder: string) => key(child).startsWith(`${key(folder)}/`);

/** Descendants follow the selected folder once; similarly prefixed siblings remain separate. */
export function fileTreeSelectionRoots(paths: readonly string[], entries: readonly FileTreeEntry[]): string[] {
  const types = new Map(entries.map(entry => [entry.path, entry.type]));
  const unique = [...new Set(paths)];
  return unique.filter(path => !unique.some(other => other !== path && types.get(other) === 'folder' && path.startsWith(`${other}/`)));
}

/** Allocate a complete no-overwrite plan. The host must still enforce destination exclusivity. */
export function planFileTreeMove(intent: FileTreeMoveIntent, entries: readonly FileTreeEntry[]): FileTreeMove[] {
  if (intent.folder && !validPath(intent.folder)) throw new Error('Invalid destination folder');
  const index = new Map(entries.map(entry => [entry.path, entry]));
  if (intent.folder && index.get(intent.folder)?.type !== 'folder') throw new Error('Destination folder no longer exists');
  const paths = [...new Set(intent.paths)];
  for (const path of paths) {
    if (!validPath(path) || !index.has(path)) throw new Error(`Source no longer exists: ${path}`);
    if (key(path) === key(intent.folder) || (index.get(path)!.type === 'folder' && within(intent.folder, path))) throw new Error('Cannot move a folder inside itself');
  }
  const occupied = new Set(entries.map(entry => key(entry.path)));
  const moves: FileTreeMove[] = [];
  for (const path of fileTreeSelectionRoots(paths, entries)) {
    if (parent(path) === intent.folder) continue;
    const entry = index.get(path)!, name = basename(path);
    const dot = entry.type === 'file' ? name.lastIndexOf('.') : -1;
    const stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : '';
    const prefix = intent.folder ? `${intent.folder}/` : '';
    let destination = prefix + name, suffix = 1;
    while (occupied.has(key(destination))) destination = `${prefix}${stem} ${suffix++}${extension}`;
    occupied.add(key(destination));
    moves.push({ source: path, destination });
  }
  return moves;
}

export interface FileTreeMoveHost {
  getEntries(): readonly FileTreeEntry[];
  isCurrent(): boolean;
  isSourceCurrent(path: string): boolean;
  /** Must reject existing destinations atomically and preserve unrecognized file contents. */
  rename(source: string, destination: string): Promise<void>;
}
export class FileTreeMoveError extends Error {
  readonly completed: readonly FileTreeMove[];
  constructor(message: string, completed: readonly FileTreeMove[], cause?: unknown) {
    super(message, { cause }); this.name = 'FileTreeMoveError'; this.completed = completed.map(move => ({ ...move }));
  }
}
/** Sequential moves report partial success and stop; no destructive automatic rollback. */
export async function executeFileTreeMove(intent: FileTreeMoveIntent, host: FileTreeMoveHost): Promise<FileTreeMove[]> {
  const completed: FileTreeMove[] = [];
  try {
    if (!host.isCurrent()) throw new Error('The file move is no longer current');
    const initial = host.getEntries();
    const plan = planFileTreeMove(intent, initial);
    const types = new Map(initial.map(entry => [entry.path, entry.type]));
    for (const move of plan) {
      if (!host.isCurrent()) throw new Error('The file move is no longer current');
      if (!host.isSourceCurrent(move.source)) throw new Error(`Source changed: ${move.source}`);
      const current = host.getEntries();
      if (current.find(entry => entry.path === move.source)?.type !== types.get(move.source)) throw new Error(`Source changed: ${move.source}`);
      // Reallocate against the current snapshot after preceding moves; never overwrite a late collision.
      const next = planFileTreeMove({ paths: [move.source], folder: intent.folder }, current)[0];
      if (!next) continue;
      await host.rename(next.source, next.destination);
      completed.push(next);
    }
    return completed;
  } catch (cause) {
    throw new FileTreeMoveError(completed.length ? `Moved ${completed.length} item(s); remaining items were not moved` : 'Files were not moved', completed, cause);
  }
}

export function createFileTreeDrag(options: FileTreeDragOptions): { cancel(): void; destroy(): void } {
  const { root } = options, doc = root.ownerDocument, win = doc.defaultView;
  if (!win) throw new Error('File-tree dragging requires a window');
  type Session = { paths: string[]; token: unknown; types: Map<string, string>; identities: Map<string, unknown>; generation: number };
  let session: Session | null = null, destroyed = false, pending = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hover: { path: string; element: HTMLElement } | null = null;
  const marked = new Set<HTMLElement>();
  const ghost = doc.createElement('div'); ghost.className = 'file-tree-drag-ghost'; ghost.setAttribute('aria-hidden', 'true');
  const nativeImage = doc.createElement('div'); nativeImage.className = 'file-tree-drag-native-image'; nativeImage.setAttribute('aria-hidden', 'true');
  const title = doc.createElement('div'), action = doc.createElement('div'); action.className = 'file-tree-drag-action'; ghost.append(title, action);
  const clearHover = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; hover?.element.classList.remove('is-file-drop-target'); hover = null; action.textContent = ''; };
  const clearVisuals = () => { clearHover(); for (const element of marked) element.classList.remove('is-file-drag-source'); marked.clear(); ghost.remove(); nativeImage.remove(); root.classList.remove('is-file-dragging'); };
  const cancel = () => { generation++; session = null; clearVisuals(); };
  const current = (drag: Session) => {
    if (destroyed || generation !== drag.generation || options.getVaultToken() !== drag.token || options.enabled?.() === false) return false;
    const entries = new Map(options.getEntries().map(entry => [entry.path, entry.type]));
    return drag.paths.every(path => entries.get(path) === drag.types.get(path) && options.getEntryToken(path) === drag.identities.get(path));
  };
  const error = (reason: unknown) => { if (options.onError) options.onError(reason); else console.error('File-tree move failed', reason); };
  const rowAt = (node: Node) => options.getRows().find(row => row.element.isConnected && row.element.contains(node));
  const start = (event: DragEvent) => {
    if (event.defaultPrevented || destroyed || pending || options.enabled?.() === false || !event.target) return;
    const node = event.target as Element, row = rowAt(node);
    if (!row) return;
    if (node.closest?.('input, textarea, [contenteditable="true"]')) { event.preventDefault(); return; }
    cancel();
    const entries = options.getEntries(), index = new Map(entries.map(entry => [entry.path, entry]));
    const selected = options.getSelectedPaths();
    const paths = [...new Set(selected.includes(row.path) ? selected : [row.path])];
    if (!paths.length || paths.some(path => !validPath(path) || !index.has(path))) { event.preventDefault(); return; }
    event.stopPropagation();
    const drag: Session = { paths, token: options.getVaultToken(), types: new Map(paths.map(path => [path, index.get(path)!.type])), identities: new Map(paths.map(path => [path, options.getEntryToken(path)])), generation };
    session = drag;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(FILE_TREE_DRAG_MIME, JSON.stringify({ version: 1, paths }));
      // Preserve the existing single-file receiver contract; receivers must validate paths.
      if (paths.length === 1) event.dataTransfer.setData('application/x-zorid-file', paths[0]);
      event.dataTransfer.setData('text/plain', paths.join('\n'));
    }
    for (const item of options.getRows()) if (paths.includes(item.path)) { item.element.classList.add('is-file-drag-source'); marked.add(item.element); }
    const files = paths.filter(path => index.get(path)!.type === 'file').length, folders = paths.length - files;
    title.textContent = paths.length === 1 ? basename(paths[0]) : [files && `${files} files`, folders && `${folders} folders`].filter(Boolean).join(' and ');
    root.classList.add('is-file-dragging'); ghost.style.left = `${event.clientX + 5}px`; ghost.style.top = `${event.clientY + 5}px`; doc.body.append(ghost);
    if (event.dataTransfer?.setDragImage) { doc.body.append(nativeImage); event.dataTransfer.setDragImage(nativeImage, 0, 0); }
  };
  const targetAt = (event: DragEvent): { path: string; element: HTMLElement; collapsed: boolean } | null => {
    if (!session || !current(session) || !event.target || !root.contains(event.target as Node)) return null;
    const node = event.target as Node, rows = options.getRows(), entries = new Map(options.getEntries().map(entry => [entry.path, entry.type]));
    const row = rowAt(node);
    let path = row ? (entries.get(row.path) === 'folder' ? row.path : parent(row.path)) : '';
    if (!row) {
      const containers = rows.filter(item => entries.get(item.path) === 'folder' && item.container?.contains(node));
      containers.sort((a, b) => b.path.length - a.path.length);
      path = containers[0]?.path ?? '';
    }
    const folder = rows.find(item => item.path === path);
    try { planFileTreeMove({ paths: session.paths, folder: path }, options.getEntries()); }
    catch { return null; }
    return { path, element: folder?.container ?? folder?.element ?? root, collapsed: !!folder?.collapsed };
  };
  const over = (event: DragEvent) => {
    if (!session) return;
    if (!current(session)) { cancel(); return; }
    const target = targetAt(event);
    if (!target) { clearHover(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return; }
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    ghost.style.left = `${event.clientX + 5}px`; ghost.style.top = `${event.clientY + 5}px`;
    if (hover?.path === target.path && hover.element === target.element) return;
    clearHover(); hover = target; target.element.classList.add('is-file-drop-target');
    action.textContent = `Move into ${target.path ? basename(target.path) : options.rootLabel ?? 'vault'}`;
    if (target.path && target.collapsed) {
      const drag = session;
      timer = setTimeout(() => {
        timer = undefined;
        if (session !== drag || !current(drag) || hover?.path !== target.path) return;
        try { options.expandFolder(target.path); } catch (reason) { error(reason); }
      }, FILE_TREE_HOVER_DELAY);
    }
  };
  const drop = (event: DragEvent) => {
    if (!session) return;
    const drag = session, target = targetAt(event);
    event.preventDefault(); event.stopPropagation();
    session = null; clearVisuals();
    if (!target || !current(drag)) { generation++; return; }
    const intent = { paths: [...drag.paths], folder: target.path };
    if (!planFileTreeMove(intent, options.getEntries()).length) return;
    pending = true;
    // The operation token survives native dragend, but cancel/destroy/vault switch invalidates it.
    const targetIdentity = target.path ? options.getEntryToken(target.path) : undefined;
    const context: FileTreeMoveContext = {
      isCurrent: () => !destroyed && generation === drag.generation && options.getVaultToken() === drag.token
        && (!target.path || (options.getEntryToken(target.path) === targetIdentity
          && options.getEntries().some(entry => entry.path === target.path && entry.type === 'folder'))),
      isSourceCurrent: path => context.isCurrent() && drag.paths.includes(path)
        && options.getEntries().find(entry => entry.path === path)?.type === drag.types.get(path)
        && options.getEntryToken(path) === drag.identities.get(path),
    };
    try { Promise.resolve(options.move(intent, context)).catch(error).finally(() => { pending = false; }); }
    catch (reason) { pending = false; error(reason); }
  };
  const leave = (event: DragEvent) => { if (!event.relatedTarget || !root.contains(event.relatedTarget as Node)) clearHover(); };
  const end = () => { if (session) cancel(); };
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && session) cancel(); };
  root.addEventListener('dragstart', start, true); root.addEventListener('dragover', over, true); root.addEventListener('dragenter', over, true); root.addEventListener('drop', drop, true); root.addEventListener('dragleave', leave);
  doc.addEventListener('dragend', end, true); doc.addEventListener('keydown', keydown, true); win.addEventListener('blur', end);
  return { cancel, destroy() {
    if (destroyed) return; destroyed = true; cancel();
    root.removeEventListener('dragstart', start, true); root.removeEventListener('dragover', over, true); root.removeEventListener('dragenter', over, true); root.removeEventListener('drop', drop, true); root.removeEventListener('dragleave', leave);
    doc.removeEventListener('dragend', end, true); doc.removeEventListener('keydown', keydown, true); win.removeEventListener('blur', end);
  } };
}
