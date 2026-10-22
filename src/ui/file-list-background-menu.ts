import { dismissContextMenu, showContextMenu } from '../platform/context-menu.ts';
import type { ContextMenuItem } from '../platform/context-menu.ts';
import type { WorkspaceMenu, WorkspaceMenuAction } from './workspace-menus.ts';

export interface FileListBackgroundContext {
  hasVault: boolean;
  /** Captured vault and menu generation, rechecked before invoking an action. */
  isValid(): boolean;
  actions: {
    newNote?: WorkspaceMenuAction;
    newFolder?: WorkspaceMenuAction;
    newCanvas?: WorkspaceMenuAction;
    newBase?: WorkspaceMenuAction;
  };
}

/** Vault-root creation menu, deliberately separate from file/folder targets. */
export function buildFileListBackgroundMenu(context: FileListBackgroundContext): WorkspaceMenu {
  const callbacks = new Map<string, WorkspaceMenuAction>();
  const items: ContextMenuItem[] = [];
  const add = (id: string, label: string, action?: WorkspaceMenuAction) => {
    if (!context.hasVault || !action) return;
    callbacks.set(id, action); items.push({ id, label });
  };
  add('file-list.new-note', 'New note', context.actions.newNote);
  add('file-list.new-folder', 'New folder', context.actions.newFolder);
  add('file-list.new-canvas', 'New canvas', context.actions.newCanvas);
  add('file-list.new-base', 'New base', context.actions.newBase);
  let settled = false;
  return {
    items,
    async run(id) {
      if (settled) return false;
      settled = true;
      const callback = id ? callbacks.get(id) : undefined; callbacks.clear();
      if (!callback || !context.isValid()) return false;
      await callback(); return true;
    },
    dispose() { settled = true; callbacks.clear(); },
  };
}

export interface FileListBackgroundOptions {
  /** False outside the Files tab or when no vault is open. */
  isAvailable(): boolean;
  /** Current direct file-tree child; replacement invalidates an open menu. */
  getTree(): HTMLElement | null;
  buildMenu(): WorkspaceMenu;
  /** Clear tree selection/focused item, without changing the active note. */
  clearSelection?(): void;
  onError(error: unknown): void;
  showMenu?: typeof showContextMenu;
  dismissMenu?: typeof dismissContextMenu;
}

/** Install on the scrollable file-list surface, not the whole sidebar.
 * Both bare local wrappers correspond to the reference's single list container;
 * file/folder descendants and toolbar/search/bookmark surfaces never qualify.
 */
export function installFileListBackgroundMenu(container: HTMLElement, options: FileListBackgroundOptions): () => void {
  const document = container.ownerDocument;
  let destroyed = false, serial = 0, pending: WorkspaceMenu | undefined;
  const report = (error: unknown) => { try { options.onError(error); } catch (error) { console.error('File-list menu error handler failed', error); } };
  const supersede = () => { serial++; pending?.dispose(); pending = undefined; };
  const onContextMenu = (event: MouseEvent) => {
    if (destroyed || event.defaultPrevented || !container.isConnected || !options.isAvailable()) return;
    const tree = options.getTree();
    if (!tree || tree.parentElement !== container || event.target !== container && event.target !== tree) return;
    let menu: WorkspaceMenu;
    try { menu = options.buildMenu(); } catch (error) { report(error); return; }
    if (!menu.items.length) { menu.dispose(); return; }
    event.preventDefault(); event.stopPropagation();
    const request = ++serial; pending = menu;
    try {
      options.clearSelection?.();
      const result = (options.showMenu ?? showContextMenu)(event, menu.items, { document });
      void result.then(async id => {
        if (request === serial) pending = undefined;
        if (request !== serial || destroyed || !container.isConnected || !options.isAvailable() || options.getTree() !== tree) { menu.dispose(); return; }
        await menu.run(id);
      }).catch(error => { menu.dispose(); if (!destroyed && request === serial) { pending = undefined; report(error); } });
    } catch (error) { menu.dispose(); if (request === serial) pending = undefined; report(error); }
  };
  // Relinquish popup ownership before another surface opens its menu.
  const supersedeKeyboard = (event: KeyboardEvent) => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) supersede(); };
  document.addEventListener('contextmenu', supersede, true);
  document.addEventListener('keydown', supersedeKeyboard, true);
  container.addEventListener('contextmenu', onContextMenu);
  return () => {
    if (destroyed) return;
    destroyed = true;
    const hadPending = !!pending; supersede();
    document.removeEventListener('contextmenu', supersede, true);
    document.removeEventListener('keydown', supersedeKeyboard, true);
    container.removeEventListener('contextmenu', onContextMenu);
    if (hadPending) {
      try { void (options.dismissMenu ?? dismissContextMenu)(document).catch(report); } catch (error) { report(error); }
    }
  };
}
