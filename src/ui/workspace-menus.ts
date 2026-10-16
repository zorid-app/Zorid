import type { ContextMenuItem } from '../platform/context-menu.ts';

export type WorkspaceMenuAction = () => void | Promise<void>;
export interface WorkspaceMenu {
  items: ContextMenuItem[];
  /** One settlement only, including cancellation. Errors propagate to the host. */
  run(id: string | null): Promise<boolean>;
  dispose(): void;
}
export interface MenuLifetime {
  /** Recheck captured target, vault generation and popup generation after await. */
  isValid(): boolean;
}
export interface FileMenuActions {
  rename?: WorkspaceMenuAction;
  delete?: WorkspaceMenuAction;
  move?: WorkspaceMenuAction;
  copyVaultPath?: WorkspaceMenuAction;
  copyFullPath?: WorkspaceMenuAction;
  openDefaultApp?: WorkspaceMenuAction;
  revealInSystem?: WorkspaceMenuAction;
  openNewWindow?: WorkspaceMenuAction;
  /** Supply a dialog action, not a remove-bookmark toggle. */
  bookmark?: WorkspaceMenuAction;
  editBookmark?: WorkspaceMenuAction;
}
export interface ExplorerMenuContext extends MenuLifetime {
  kind: 'file' | 'folder';
  isRoot?: boolean;
  platform?: 'mac' | 'other';
  bookmarked?: boolean;
  actions: FileMenuActions & {
    openNewTab?: WorkspaceMenuAction;
    openRight?: WorkspaceMenuAction;
    newNote?: WorkspaceMenuAction;
    newFolder?: WorkspaceMenuAction;
    duplicate?: WorkspaceMenuAction;
    searchInFolder?: WorkspaceMenuAction;
  };
}
export interface PaneMenuContext extends MenuLifetime {
  location: 'main' | 'sidebar';
  /** Present only for a view with a file; empty Markdown tabs omit file actions. */
  file?: { bookmarked?: boolean; actions: FileMenuActions };
  platform?: 'mac' | 'other';
  markdown?: { mode: 'reading' | 'live'; canAddProperty?: boolean };
  actions: {
    splitRight?: WorkspaceMenuAction;
    splitDown?: WorkspaceMenuAction;
    toggleReading?: WorkspaceMenuAction;
    addProperty?: WorkspaceMenuAction;
    find?: WorkspaceMenuAction;
    replace?: WorkspaceMenuAction;
    exportPdf?: WorkspaceMenuAction;
    revealInNavigation?: WorkspaceMenuAction;
  };
}
export interface WorkspaceMenuTab { id: string; pinned: boolean }
export interface TabMenuContext extends PaneMenuContext {
  targetId: string;
  tabs: readonly WorkspaceMenuTab[];
  /** Hidden tab headers contribute tab actions only, matching reference dispatch. */
  visible: boolean;
  tabActions: {
    closeTabs?: (ids: readonly string[]) => void | Promise<void>;
    togglePin?: WorkspaceMenuAction;
    moveToNewWindow?: WorkspaceMenuAction;
  };
}
export interface TabGroupMenuContext extends MenuLifetime {
  location: 'main' | 'sidebar';
  stacked?: boolean;
  activeId: string;
  tabs: readonly (WorkspaceMenuTab & { title: string })[];
  actions: {
    toggleStacked?: WorkspaceMenuAction;
    closeTabs?: (ids: readonly string[]) => void | Promise<void>;
    activateTab?: (id: string) => void | Promise<void>;
  };
}

const explorerSections = ['open', 'action-primary', 'action', 'info', 'system', 'danger'] as const;
const paneSections = ['close', 'pane', 'open', 'action', 'find', 'info', 'system', 'danger'] as const;
type Section = typeof explorerSections[number] | typeof paneSections[number] | 'tablist';

/** Small original section composer. It never transmits callbacks or host state. */
function composer(lifetime: MenuLifetime) {
  const sections = new Map<Section, ContextMenuItem[]>();
  const callbacks = new Map<string, WorkspaceMenuAction>();
  let settled = false;
  function action(id: string, label: string, callback?: WorkspaceMenuAction, state: { enabled?: boolean; checked?: boolean } = {}): ContextMenuItem | undefined {
    if (!callback) return;
    const key = `workspace.${id}`;
    if (callbacks.has(key)) throw new Error(`Duplicate workspace menu action: ${id}`);
    if (state.enabled !== false) callbacks.set(key, callback);
    return { id: key, label, ...state };
  }
  function add(section: Section, id: string, label: string, callback?: WorkspaceMenuAction, state?: { enabled?: boolean; checked?: boolean }) {
    const item = action(id, label, callback, state);
    if (item) append(section, item);
  }
  function append(section: Section, item: ContextMenuItem) {
    const items = sections.get(section) || [];
    items.push(item); sections.set(section, items);
  }
  return {
    add, action, append,
    finish(order: readonly Section[]): WorkspaceMenu {
      const items: ContextMenuItem[] = [];
      for (const section of order) {
        const group = sections.get(section);
        if (!group?.length) continue;
        if (items.length) items.push({ type: 'separator' });
        items.push(...group);
      }
      return {
        items,
        async run(id) {
          if (settled) return false;
          settled = true;
          const callback = id ? callbacks.get(id) : undefined;
          callbacks.clear();
          if (!callback || !lifetime.isValid()) return false;
          await callback();
          return true;
        },
        dispose() { settled = true; callbacks.clear(); },
      };
    },
  };
}
type Composer = ReturnType<typeof composer>;

function fileContributions(menu: Composer, actions: FileMenuActions, options: {
  kind: 'file' | 'folder'; root?: boolean; platform?: 'mac' | 'other'; bookmarked?: boolean; searchInFolder?: WorkspaceMenuAction;
}) {
  if (options.root) return;
  const file = options.kind === 'file';
  menu.add('action', 'move', file ? 'Move file to...' : 'Move folder to...', actions.move);
  if (!file) menu.add('action', 'search-folder', 'Search in folder', options.searchInFolder);
  menu.add('action', 'bookmark', options.bookmarked ? 'Edit bookmark' : 'Bookmark...', options.bookmarked ? actions.editBookmark : actions.bookmark);
  const paths = [
    menu.action('copy-vault-path', 'from vault folder', actions.copyVaultPath),
    menu.action('copy-full-path', 'from system root', actions.copyFullPath),
  ].filter((item): item is ContextMenuItem => !!item);
  if (paths.length) menu.append('info', { label: 'Copy path', submenu: paths });
  if (file) menu.add('system', 'open-default', 'Open in default app', actions.openDefaultApp);
  menu.add('system', 'reveal-system', options.platform === 'mac' ? 'Reveal in Finder' : 'Show in system explorer', actions.revealInSystem);
  if (file) menu.add('open', 'open-window', 'Open in new window', actions.openNewWindow);
}

/** Single explorer target. Multi-selection uses a different reference inventory. */
export function buildExplorerMenu(context: ExplorerMenuContext): WorkspaceMenu {
  const menu = composer(context), actions = context.actions;
  const root = context.kind === 'folder' && context.isRoot === true;
  if (context.kind === 'file') {
    menu.add('open', 'open-tab', 'Open in new tab', actions.openNewTab);
    menu.add('open', 'open-right', 'Open to the right', actions.openRight);
  } else {
    menu.add('action-primary', 'new-note', 'New note', actions.newNote);
    menu.add('action-primary', 'new-folder', 'New folder', actions.newFolder);
  }
  if (!root) {
    menu.add('action', 'duplicate', context.platform === 'mac' ? 'Duplicate' : 'Make a copy', actions.duplicate);
  }
  fileContributions(menu, actions, { ...context, root, searchInFolder: actions.searchInFolder });
  if (!root) {
    menu.add('danger', 'rename', 'Rename...', actions.rename);
    menu.add('danger', 'delete', 'Delete', actions.delete);
  }
  return menu.finish(explorerSections);
}

function paneContributions(menu: Composer, context: PaneMenuContext) {
  const actions = context.actions;
  menu.add('open', 'split-right', 'Split right', actions.splitRight, { enabled: context.location !== 'sidebar' });
  menu.add('open', 'split-down', 'Split down', actions.splitDown);
  if (context.file) {
    menu.add('action', 'rename', 'Rename...', context.file.actions.rename);
    menu.add('danger', 'delete', 'Delete file', context.file.actions.delete);
    fileContributions(menu, context.file.actions, { kind: 'file', platform: context.platform, bookmarked: context.file.bookmarked });
    menu.add('system', 'reveal-navigation', 'Reveal file in navigation', actions.revealInNavigation);
  }
  if (context.markdown) {
    menu.add('pane', 'reading', 'Reading view', actions.toggleReading, { checked: context.markdown.mode === 'reading' });
    menu.add('action', 'add-property', 'Add file property', actions.addProperty, { enabled: context.markdown.canAddProperty !== false });
    menu.add('find', 'find', 'Find...', actions.find);
    menu.add('find', 'replace', 'Replace...', actions.replace, { enabled: context.markdown.mode === 'live' });
    menu.add('action', 'export-pdf', 'Export to PDF...', actions.exportPdf);
  }
}

/** Desktop pane more-options does not inherit tab close/pin/bulk-close actions. */
export function buildPaneMenu(context: PaneMenuContext): WorkspaceMenu {
  const menu = composer(context);
  paneContributions(menu, context);
  return menu.finish(paneSections);
}

export function buildTabMenu(context: TabMenuContext): WorkspaceMenu {
  const menu = composer(context);
  const tabs = context.tabs.map(tab => ({ ...tab }));
  const index = tabs.findIndex(tab => tab.id === context.targetId);
  if (index < 0) return menu.finish(paneSections);
  const target = tabs[index], close = context.tabActions.closeTabs;
  const closeAction = (ids: string[]) => close ? () => close(Object.freeze(ids.slice())) : undefined;
  menu.add('close', 'close', 'Close', closeAction([target.id]));
  if (context.location !== 'sidebar') {
    const others = tabs.filter(tab => !tab.pinned && tab.id !== target.id).map(tab => tab.id);
    const after = tabs.slice(index + 1).filter(tab => !tab.pinned).map(tab => tab.id);
    const all = tabs.filter(tab => !tab.pinned).map(tab => tab.id);
    if (others.length) menu.add('close', 'close-others', 'Close others', closeAction(others));
    if (after.length) menu.add('close', 'close-after', 'Close tabs after', closeAction(after));
    if (all.length && (all.length !== 1 || all[0] !== target.id)) menu.add('close', 'close-all', 'Close all', closeAction(all));
  }
  menu.add('pane', 'pin', target.pinned ? 'Unpin' : 'Pin', context.tabActions.togglePin);
  menu.add('open', 'move-window', 'Move to new window', context.tabActions.moveToNewWindow);
  if (context.visible) paneContributions(menu, context);
  return menu.finish(paneSections);
}

/** Sidebar groups list tabs but do not offer main-area stacking or bulk close. */
export function buildTabGroupMenu(context: TabGroupMenuContext): WorkspaceMenu {
  const menu = composer(context), actions = context.actions;
  const tabs = context.tabs.map(tab => ({ ...tab }));
  if (context.location !== 'sidebar') {
    menu.add('action', 'stack', context.stacked ? 'Unstack tabs' : 'Stack tabs', actions.toggleStacked);
    const ids = Object.freeze(tabs.filter(tab => !tab.pinned).map(tab => tab.id));
    const close = actions.closeTabs;
    menu.add('close', 'close-all', 'Close all', close ? () => close(ids) : undefined);
  }
  const activate = actions.activateTab;
  tabs.forEach((tab, index) => menu.add('tablist', `tab-${index}`, tab.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) || 'Untitled', activate ? () => activate(tab.id) : undefined, { checked: tab.id === context.activeId }));
  return menu.finish(['action', 'close', 'tablist']);
}
