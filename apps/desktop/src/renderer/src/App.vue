<script setup lang="ts">
import { ArrowDownUp, ChevronsDown, ChevronsUp, FilePlus, Files, FolderPlus, Link2, Search, Tag } from '@lucide/vue';
import { createDesktopShellState } from '@zorid/desktop-shell';
import { ZIconButton } from '@zorid/ui-vue';
import type { Component, CSSProperties } from 'vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ActivityRail from './components/ActivityRail.vue';
import AppResizeHandle from './components/AppResizeHandle.vue';
import AppStatusBar from './components/AppStatusBar.vue';
import CommandPaletteWindow from './components/CommandPaletteWindow.vue';
import FileTree from './components/FileTree.vue';
import {
  FILE_TREE_SORT_MODES,
  type FileTreeSortMode,
  sortEntries,
  sortModeLabel,
} from './components/file-tree-model.js';
import MarkdownEditor from './components/MarkdownEditor.vue';
import RightSidebarPanels from './components/RightSidebarPanels.vue';
import SettingsWindow from './components/SettingsWindow.vue';
import TopTabStrip from './components/TopTabStrip.vue';
import type { TopTabItem } from './components/top-tab-model.js';
import { fileTab, fileTabId, nextTabIdAfterClose, placeholderTab } from './components/top-tab-model.js';
import { createMarkdownAutosave, type MarkdownAutosaveSnapshot } from './markdown-autosave.js';
import type { PaneLayout } from './shell-layout.js';
import {
  DEFAULT_PANE_LAYOUT,
  parsePaneLayout,
  resolveDraggedPaneWidth,
  resolvePaneLayout,
  SHELL_LAYOUT,
  safePaneLayoutStorageKey,
  serializePaneLayout,
} from './shell-layout.js';
import type {
  BacklinkDto,
  BaseDto,
  CommandDto,
  DataViewResultDto,
  EditorSnapshotDto,
  FieldDto,
  FileFieldsDto,
  IndexStatusDto,
  MarkdownEmbedDto,
  OutlineItemDto,
  PluginStatus,
  RecentVaultDto,
  SearchResultDto,
  SettingProperty,
  SettingsSectionDto,
  TagDto,
  TypeDto,
  VaultEntry,
  VaultProfileDto,
  WindowRole,
} from './types.js';

type JsonRecord = Record<string, unknown>;
type ThemePreference = 'system' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';

const desktop = window.zoridDesktop as unknown as {
  getWindowRole(): Promise<WindowRole | undefined>;
  createVault(): Promise<VaultProfileDto | undefined>;
  openVault(): Promise<VaultProfileDto | undefined>;
  listRecentVaults(): Promise<readonly RecentVaultDto[]>;
  openRecentVault(id: string): Promise<VaultProfileDto>;
  getVaultProfile(): Promise<VaultProfileDto | undefined>;
  listVault(path?: string): Promise<readonly VaultEntry[]>;
  readVaultText(path: string): Promise<string>;
  writeVaultText(path: string, contents: string): Promise<void>;
  createVaultFolder(path: string): Promise<void>;
  createMarkdownFile(path: string, contents?: string): Promise<void>;
  renameVaultPath(from: string, to: string): Promise<void>;
  deleteVaultPath(path: string): Promise<void>;
  getIndexStatus(): Promise<IndexStatusDto>;
  searchIndex(query: string): Promise<readonly SearchResultDto[]>;
  getBacklinks(path: string): Promise<readonly BacklinkDto[]>;
  listTags(): Promise<readonly TagDto[]>;
  getOutline(path: string): Promise<readonly OutlineItemDto[]>;
  listTypes(): Promise<readonly TypeDto[]>;
  getFileFields(path: string): Promise<FileFieldsDto>;
  updateFileField(path: string, key: string, value: unknown): Promise<FileFieldsDto>;
  setFileType(path: string, typeName?: string): Promise<FileFieldsDto>;
  listBases(): Promise<readonly BaseDto[]>;
  renderDataView(basePath: string, viewId?: string): Promise<DataViewResultDto>;
  getMarkdownEmbeds(path: string): Promise<readonly MarkdownEmbedDto[]>;
  onIndexUpdated(callback: () => void): () => void;
  onEditorSnapshot(callback: (snapshot: EditorSnapshotDto) => void): () => void;
  onSettingUpdated(callback: (setting: SettingValueUpdate) => void): () => void;
  listCommands(): Promise<readonly CommandDto[]>;
  executeCommand(id: string, args?: unknown): Promise<unknown>;
  listPluginStatuses(): Promise<readonly PluginStatus[]>;
  listSettingsSections(): Promise<readonly SettingsSectionDto[]>;
  getSettingValue(sectionId: string, pluginId?: string): Promise<{ value?: unknown }>;
  setSettingValue(sectionId: string, value: unknown, pluginId?: string): Promise<unknown>;
};

const shell = createDesktopShellState();
const windowRole = ref<WindowRole>();
const recentVaults = ref<readonly RecentVaultDto[]>([]);
const launcherError = ref<string>();
const launcherBusy = ref(false);
const activityIcons: Record<string, Component> = {
  files: Files,
  search: Search,
  backlinks: Link2,
  tags: Tag,
};
const vaultProfile = ref<VaultProfileDto>();
const vaultLabel = ref<string>();
const entriesByDirectory = ref<Record<string, readonly VaultEntry[]>>({});
const expandedDirectories = ref<Record<string, boolean>>({ '': true });
const fileTreeSortMode = ref<FileTreeSortMode>('name-asc');
const draggingSourcePath = ref<string>();
const draggingOverPath = ref<string>();
const dragHoverDepthByPath: Record<string, number> = {};
const FILE_TREE_DRAG_EXPAND_DELAY_MS = 500;
let dragExpandTimer: ReturnType<typeof setTimeout> | undefined;
const selectedPath = ref<string>();
const openTabs = ref<TopTabItem[]>([]);
const selectedTabId = ref<string>();
const placeholderTabCounter = ref(0);
const editorText = ref('');
const savedText = ref('');
const error = ref<string>();
const commands = ref<readonly CommandDto[]>([]);
const commandQuery = ref('');
const commandPaletteOpen = ref(false);
const plugins = ref<readonly PluginStatus[]>([]);
const settingsSections = ref<readonly SettingsSectionDto[]>([]);
const settingValues = ref<Record<string, unknown>>({});
const settingsOpen = ref(false);
const indexStatus = ref<IndexStatusDto>({ state: 'idle', fileCount: 0, diagnostics: [] });
const searchQuery = ref('');
const searchResults = ref<readonly SearchResultDto[]>([]);
const backlinks = ref<readonly BacklinkDto[]>([]);
const tags = ref<readonly TagDto[]>([]);
const outline = ref<readonly OutlineItemDto[]>([]);
const types = ref<readonly TypeDto[]>([]);
const fileFields = ref<FileFieldsDto>();
const bases = ref<readonly BaseDto[]>([]);
const activeBasePath = ref<string>();
const activeViewId = ref<string>();
const dataView = ref<DataViewResultDto>();
const markdownEmbeds = ref<readonly MarkdownEmbedDto[]>([]);
const paneLayout = ref<PaneLayout>({ ...DEFAULT_PANE_LAYOUT });
const systemTheme = ref<ResolvedTheme>(readSystemTheme());
type ResizeSide = 'left' | 'right';
interface PaneResizeState {
  readonly side: ResizeSide;
  readonly startX: number;
  readonly startLeftWidth: number;
  readonly startRightWidth: number;
}
interface SettingValueUpdate {
  readonly sectionId: string;
  readonly pluginId?: string;
  readonly value?: unknown;
}
const paneResize = ref<PaneResizeState>();
let unsubscribeIndexUpdates: (() => void) | undefined;
let unsubscribeEditorSnapshot: (() => void) | undefined;
let unsubscribeSettingUpdates: (() => void) | undefined;
let stopSystemThemeWatcher: (() => void) | undefined;
let stopDocumentThemeBinding: (() => void) | undefined;
const autosave = createMarkdownAutosave({
  write: writeAutosaveSnapshot,
  onError: (caught) => {
    error.value = caught instanceof Error ? caught.message : String(caught);
  },
});

const status = computed(() => vaultLabel.value ?? 'No vault open');
const paneLayoutStorageKeyForActiveVault = computed(() => safePaneLayoutStorageKey(vaultProfile.value?.id));
const shellStyle = computed<CSSProperties>(() => ({
  '--left-sidebar-width': `${paneLayout.value.leftWidth}px`,
  '--right-sidebar-width': `${paneLayout.value.rightWidth}px`,
  '--activity-rail-width': `${SHELL_LAYOUT.railWidth}px`,
  '--resize-handle-width': `${SHELL_LAYOUT.resizeHandleWidth}px`,
  '--resize-handle-half-width': `${SHELL_LAYOUT.resizeHandleWidth / 2}px`,
  '--titlebar-height': `${SHELL_LAYOUT.titlebarHeight}px`,
  '--traffic-light-space': `${SHELL_LAYOUT.trafficLightReservedWidth}px`,
  '--titlebar-pane-toggle-width': `${SHELL_LAYOUT.titlebarPaneToggleWidth}px`,
}));
const sortedEntriesByDirectory = computed<Record<string, readonly VaultEntry[]>>(() =>
  Object.fromEntries(
    Object.entries(entriesByDirectory.value).map(([directory, entries]) => [
      directory,
      sortEntries(entries, fileTreeSortMode.value),
    ]),
  ),
);
const rootEntries = computed(() => sortedEntriesByDirectory.value[''] ?? []);
const fileTreeSortLabel = computed(() => sortModeLabel(fileTreeSortMode.value));
const activeTab = computed(() => openTabs.value.find((tab) => tab.id === selectedTabId.value));
const editorEmptyText = computed(() =>
  activeTab.value?.kind === 'placeholder'
    ? 'Create new note (⌘ N), go to file (⌘ O), or close this placeholder tab.'
    : 'Select a Markdown file from the filesystem-backed explorer.',
);
const editorStartupOnlyCommandIds = new Set(['vault.open', 'file-explorer.open-root']);
const visibleCommands = computed(() =>
  windowRole.value === 'editor'
    ? commands.value.filter((command) => !editorStartupOnlyCommandIds.has(command.id))
    : commands.value,
);
const filteredCommands = computed(() => {
  const query = commandQuery.value.trim().toLowerCase();
  const source = visibleCommands.value;
  if (!query) return source;
  return source.filter((command: CommandDto) => `${command.title} ${command.id}`.toLowerCase().includes(query));
});
const activePlugins = computed(() => plugins.value.filter((plugin) => plugin.status === 'active').length);
const appearanceSettings = computed(() => jsonRecord(settingValues.value['app:app.appearance']));
const themePreference = computed<ThemePreference>(() => parseThemePreference(appearanceSettings.value.theme));
const effectiveTheme = computed<ResolvedTheme>(() =>
  themePreference.value === 'system' ? systemTheme.value : themePreference.value,
);

function settingsKey(section: SettingsSectionDto): string {
  return `${section.pluginId ?? 'app'}:${section.id}`;
}

function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function startSystemThemeWatcher(): void {
  if (typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    systemTheme.value = query.matches ? 'dark' : 'light';
  };
  update();
  query.addEventListener?.('change', update);
  stopSystemThemeWatcher = () => query.removeEventListener?.('change', update);
}

function applyDocumentTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.zTheme = theme;
}

function applySettingUpdate(setting: SettingValueUpdate): void {
  settingValues.value = {
    ...settingValues.value,
    [`${setting.pluginId ?? 'app'}:${setting.sectionId}`]: setting.value,
  };
}

function activityIconFor(item: string): Component {
  return activityIcons[item] ?? Files;
}

function applyVaultProfile(profile: VaultProfileDto): void {
  vaultProfile.value = profile;
  vaultLabel.value = profile.rootLabel;
  loadPaneLayout(profile.id);
}

function loadPaneLayout(vaultId?: string): void {
  const storageKey = safePaneLayoutStorageKey(vaultId);
  const stored = storageKey ? parsePaneLayout(localStorage.getItem(storageKey)) : undefined;
  paneLayout.value = resolvePaneLayout(stored ?? DEFAULT_PANE_LAYOUT, { viewportWidth: window.innerWidth });
}

function savePaneLayout(): void {
  const storageKey = paneLayoutStorageKeyForActiveVault.value;
  if (!storageKey) return;
  localStorage.setItem(storageKey, serializePaneLayout(paneLayout.value));
}

function updatePaneLayout(next: Partial<PaneLayout>, preserveSide?: ResizeSide): void {
  paneLayout.value = resolvePaneLayout(
    { ...paneLayout.value, ...next },
    { viewportWidth: window.innerWidth, ...(preserveSide ? { preserveSide } : {}) },
  );
}

function handlePanePointerMove(event: PointerEvent): void {
  const resize = paneResize.value;
  if (!resize) return;
  const delta = event.clientX - resize.startX;
  if (resize.side === 'left') {
    const next = resolveDraggedPaneWidth(
      resize.startLeftWidth + delta,
      SHELL_LAYOUT.leftMinWidth,
      SHELL_LAYOUT.leftMaxWidth,
    );
    updatePaneLayout({ leftWidth: next.width, leftCollapsed: next.collapsed }, 'left');
  } else {
    const next = resolveDraggedPaneWidth(
      resize.startRightWidth - delta,
      SHELL_LAYOUT.rightMinWidth,
      SHELL_LAYOUT.rightMaxWidth,
    );
    updatePaneLayout({ rightWidth: next.width, rightCollapsed: next.collapsed }, 'right');
  }
}

function stopPaneResize(): void {
  if (!paneResize.value) return;
  paneResize.value = undefined;
  window.removeEventListener('pointermove', handlePanePointerMove);
  window.removeEventListener('pointerup', stopPaneResize);
  window.removeEventListener('pointercancel', stopPaneResize);
  savePaneLayout();
}

function startPaneResize(side: ResizeSide, event: PointerEvent): void {
  event.preventDefault();
  paneResize.value = {
    side,
    startX: event.clientX,
    startLeftWidth: paneLayout.value.leftWidth,
    startRightWidth: paneLayout.value.rightWidth,
  };
  window.addEventListener('pointermove', handlePanePointerMove);
  window.addEventListener('pointerup', stopPaneResize);
  window.addEventListener('pointercancel', stopPaneResize);
}

function jsonRecord(value: unknown): JsonRecord {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function settingObject(section: SettingsSectionDto): JsonRecord {
  return jsonRecord(settingValues.value[settingsKey(section)]);
}

function coerceSettingValue(raw: string | boolean, type: string): unknown {
  if (type === 'boolean') return Boolean(raw);
  if (type === 'number' || type === 'integer') {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  return String(raw);
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

async function refreshShellData(): Promise<void> {
  const nextCommands = await desktop.listCommands();
  const nextPlugins = await desktop.listPluginStatuses();
  const nextSettings = await desktop.listSettingsSections();
  const nextIndexStatus = await desktop.getIndexStatus();
  commands.value = nextCommands;
  plugins.value = nextPlugins;
  settingsSections.value = nextSettings;
  indexStatus.value = nextIndexStatus;
  await loadSettingValues(nextSettings);
  await refreshMetadataPanels();
}

async function refreshSettingsData(): Promise<void> {
  const nextSettings = await desktop.listSettingsSections();
  settingsSections.value = nextSettings;
  await loadSettingValues(nextSettings);
}

async function refreshMetadataPanels(): Promise<void> {
  [tags.value, types.value, bases.value] = await Promise.all([
    desktop.listTags(),
    desktop.listTypes(),
    desktop.listBases(),
  ]);
  if (!activeBasePath.value && bases.value[0]) activeBasePath.value = bases.value[0].path;
  await refreshDataView();
  if (searchQuery.value.trim()) searchResults.value = await desktop.searchIndex(searchQuery.value);
  else searchResults.value = [];
  if (selectedPath.value) {
    const [nextBacklinks, nextOutline] = await Promise.all([
      desktop.getBacklinks(selectedPath.value),
      desktop.getOutline(selectedPath.value),
    ]);
    backlinks.value = nextBacklinks;
    outline.value = nextOutline;
    fileFields.value = await desktop.getFileFields(selectedPath.value);
    markdownEmbeds.value = await desktop.getMarkdownEmbeds(selectedPath.value);
  } else {
    backlinks.value = [];
    outline.value = [];
    fileFields.value = undefined;
    markdownEmbeds.value = [];
  }
}

async function runSearch(): Promise<void> {
  searchResults.value = searchQuery.value.trim() ? await desktop.searchIndex(searchQuery.value) : [];
}

async function loadSettingValues(sections: readonly SettingsSectionDto[]): Promise<void> {
  const next: Record<string, unknown> = { ...settingValues.value };
  for (const section of sections) {
    const setting = (await desktop.getSettingValue(section.id, section.pluginId)) as { value?: unknown };
    next[settingsKey(section)] = setting.value;
  }
  settingValues.value = next;
}

async function updateSettingProperty(
  section: SettingsSectionDto,
  property: SettingProperty,
  raw: string | boolean,
): Promise<void> {
  const key = settingsKey(section);
  const nextValue = {
    ...settingObject(section),
    [property.name]: coerceSettingValue(raw, property.type),
  } satisfies JsonRecord;
  settingValues.value = { ...settingValues.value, [key]: nextValue };
  await desktop.setSettingValue(section.id, nextValue, section.pluginId);
}

async function loadDirectory(path = ''): Promise<void> {
  entriesByDirectory.value = { ...entriesByDirectory.value, [path]: await desktop.listVault(path) };
}

function updateFileTreeSortMode(event: Event): void {
  fileTreeSortMode.value = (event.target as HTMLSelectElement).value as FileTreeSortMode;
}

function loadedDirectoryPaths(): string[] {
  const directories = new Set<string>();
  for (const entries of Object.values(entriesByDirectory.value)) {
    for (const entry of entries) {
      if (entry.kind === 'directory') directories.add(entry.path);
    }
  }
  return [...directories];
}

function expandLoadedDirectories(): void {
  const next: Record<string, boolean> = { ...expandedDirectories.value, '': true };
  for (const directory of loadedDirectoryPaths()) next[directory] = true;
  expandedDirectories.value = next;
}

function collapseLoadedDirectories(): void {
  expandedDirectories.value = { '': true };
}

function clearFileTreeDragState(): void {
  draggingSourcePath.value = undefined;
  draggingOverPath.value = undefined;
  for (const key of Object.keys(dragHoverDepthByPath)) delete dragHoverDepthByPath[key];
}

function clearDragExpandTimer(): void {
  if (!dragExpandTimer) return;
  clearTimeout(dragExpandTimer);
  dragExpandTimer = undefined;
}

function isAncestorPath(ancestorPath: string, descendantPath: string): boolean {
  if (!ancestorPath) return false;
  return descendantPath === ancestorPath || descendantPath.startsWith(`${ancestorPath}/`);
}

function resolveMovedPath(sourcePath: string, targetDirectoryPath: string): string {
  const name = sourcePath.split('/').filter(Boolean).at(-1) ?? sourcePath;
  return targetDirectoryPath ? `${targetDirectoryPath}/${name}` : name;
}

function incrementDragHoverDepth(path: string): void {
  dragHoverDepthByPath[path] = (dragHoverDepthByPath[path] ?? 0) + 1;
}

function decrementDragHoverDepth(path: string): number {
  const next = (dragHoverDepthByPath[path] ?? 0) - 1;
  if (next <= 0) {
    delete dragHoverDepthByPath[path];
    return 0;
  }
  dragHoverDepthByPath[path] = next;
  return next;
}

function scheduleDragExpandPath(path: string): void {
  if (expandedDirectories.value[path]) return;
  clearDragExpandTimer();
  dragExpandTimer = setTimeout(() => {
    if (draggingSourcePath.value && draggingOverPath.value === path) {
      expandedDirectories.value = { ...expandedDirectories.value, [path]: true };
      void loadDirectory(path);
    }
  }, FILE_TREE_DRAG_EXPAND_DELAY_MS);
}

async function loadRecentVaults(): Promise<void> {
  recentVaults.value = await desktop.listRecentVaults();
}

async function runLauncherAction(action: () => Promise<unknown>): Promise<void> {
  launcherError.value = undefined;
  launcherBusy.value = true;
  try {
    await action();
    await loadRecentVaults();
  } catch (caught) {
    launcherError.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    launcherBusy.value = false;
  }
}

async function createVaultFromLauncher(): Promise<void> {
  await runLauncherAction(() => desktop.createVault());
}

async function openFolderFromLauncher(): Promise<void> {
  await runLauncherAction(() => desktop.openVault());
}

async function openRecentFromLauncher(id: string): Promise<void> {
  await runLauncherAction(() => desktop.openRecentVault(id));
}

function applyEditorSnapshot(snapshot: EditorSnapshotDto): void {
  if (snapshot.profile) applyVaultProfile(snapshot.profile);
  indexStatus.value = snapshot.indexStatus;
  void loadDirectory('')
    .then(() => refreshShellData())
    .catch((caught: unknown) => {
      error.value = caught instanceof Error ? caught.message : String(caught);
    });
}

async function initializeWindow(): Promise<void> {
  const role = (await desktop.getWindowRole()) ?? 'editor';
  windowRole.value = role;
  await refreshSettingsData();
  if (role === 'launcher') {
    await loadRecentVaults();
    return;
  }
  unsubscribeIndexUpdates = desktop.onIndexUpdated(() => {
    void refreshShellData();
  });
  unsubscribeEditorSnapshot = desktop.onEditorSnapshot(applyEditorSnapshot);
  const profile = await desktop.getVaultProfile().catch(() => undefined);
  if (profile) {
    applyVaultProfile(profile);
    await loadDirectory('');
    await refreshShellData();
  }
}

async function writeAutosaveSnapshot(snapshot: MarkdownAutosaveSnapshot): Promise<void> {
  await desktop.writeVaultText(snapshot.path, snapshot.text);
  if (selectedPath.value === snapshot.path && editorText.value === snapshot.text) savedText.value = snapshot.text;
  await refreshShellData();
}

function scheduleAutosave(): void {
  if (!selectedPath.value) return;
  if (editorText.value === savedText.value) {
    void autosave.saveNow({ path: selectedPath.value, text: savedText.value }).catch((caught: unknown) => {
      error.value = caught instanceof Error ? caught.message : String(caught);
    });
    return;
  }
  autosave.schedule({ path: selectedPath.value, text: editorText.value });
}

function updateEditorText(text: string): void {
  editorText.value = text;
  scheduleAutosave();
}

async function flushPendingAutosave(): Promise<void> {
  await autosave.flush();
}

function clearFileSelection(): void {
  selectedPath.value = undefined;
  editorText.value = '';
  savedText.value = '';
  backlinks.value = [];
  outline.value = [];
  fileFields.value = undefined;
  markdownEmbeds.value = [];
}

async function activatePlaceholderTab(tabId: string): Promise<void> {
  await flushPendingAutosave();
  selectedTabId.value = tabId;
  clearFileSelection();
}

async function activateFilePath(path: string): Promise<void> {
  await flushPendingAutosave();
  const nextTabId = fileTabId(path);
  selectedTabId.value = nextTabId;
  clearFileSelection();
  const text = await desktop.readVaultText(path);
  if (selectedTabId.value !== nextTabId) return;
  selectedPath.value = path;
  editorText.value = text;
  savedText.value = text;
  await refreshMetadataPanels();
}

async function openFileTab(path: string): Promise<void> {
  const id = fileTabId(path);
  if (!openTabs.value.find((tab) => tab.id === id)) openTabs.value = [...openTabs.value, fileTab(path)];
  await activateFilePath(path);
}

async function createPlaceholderTab(): Promise<void> {
  placeholderTabCounter.value += 1;
  const tab = placeholderTab(placeholderTabCounter.value);
  openTabs.value = [...openTabs.value, tab];
  await activatePlaceholderTab(tab.id);
}

async function activateTab(tabId: string): Promise<void> {
  const tab = openTabs.value.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  if (tab.kind === 'placeholder') {
    await activatePlaceholderTab(tab.id);
    return;
  }
  await activateFilePath(tab.path);
}

async function closeTab(tabId: string): Promise<void> {
  const nextId = nextTabIdAfterClose(openTabs.value, tabId);
  const closingActiveTab = selectedTabId.value === tabId;
  if (closingActiveTab) await flushPendingAutosave();
  openTabs.value = openTabs.value.filter((tab) => tab.id !== tabId);
  if (!closingActiveTab) return;
  if (nextId) await activateTab(nextId);
  else {
    selectedTabId.value = undefined;
    clearFileSelection();
  }
}

function toggleLeftPane(): void {
  const nextCollapsed = !paneLayout.value.leftCollapsed;
  updatePaneLayout(
    {
      leftCollapsed: nextCollapsed,
      leftWidth: nextCollapsed ? SHELL_LAYOUT.collapsedWidth : SHELL_LAYOUT.leftDefaultWidth,
    },
    'left',
  );
  savePaneLayout();
}

function toggleRightPane(): void {
  const nextCollapsed = !paneLayout.value.rightCollapsed;
  updatePaneLayout(
    {
      rightCollapsed: nextCollapsed,
      rightWidth: nextCollapsed ? SHELL_LAYOUT.collapsedWidth : SHELL_LAYOUT.rightDefaultWidth,
    },
    'right',
  );
  savePaneLayout();
}

async function openEntry(entry: VaultEntry): Promise<void> {
  error.value = undefined;
  if (entry.kind === 'directory') {
    expandedDirectories.value = { ...expandedDirectories.value, [entry.path]: !expandedDirectories.value[entry.path] };
    if (expandedDirectories.value[entry.path]) await loadDirectory(entry.path);
    return;
  }
  await openFileTab(entry.path);
}

function handleTreeDragStart(entry: VaultEntry, event: DragEvent): void {
  draggingSourcePath.value = entry.path;
  draggingOverPath.value = undefined;
  for (const key of Object.keys(dragHoverDepthByPath)) delete dragHoverDepthByPath[key];
  clearDragExpandTimer();
  if (!event.dataTransfer) return;
  event.dataTransfer.setData('text/plain', entry.path);
  event.dataTransfer.effectAllowed = 'move';
}

function handleTreeDragEnd(): void {
  clearDragExpandTimer();
  clearFileTreeDragState();
}

function handleTreeDragEnter(entry: VaultEntry, event: DragEvent): void {
  if (!draggingSourcePath.value || entry.kind !== 'directory') return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  incrementDragHoverDepth(entry.path);
  draggingOverPath.value = entry.path;
  if (isAncestorPath(entry.path, draggingSourcePath.value)) return;
  scheduleDragExpandPath(entry.path);
}

function handleTreeDragOver(entry: VaultEntry, event: DragEvent): void {
  if (!draggingSourcePath.value || entry.kind !== 'directory') return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dragHoverDepthByPath[entry.path] = Math.max(1, dragHoverDepthByPath[entry.path] ?? 0);
  if (draggingOverPath.value !== entry.path) {
    draggingOverPath.value = entry.path;
    clearDragExpandTimer();
    scheduleDragExpandPath(entry.path);
  }
}

function handleTreeDragLeave(entry: VaultEntry): void {
  if (!draggingSourcePath.value || entry.kind !== 'directory') return;
  if (decrementDragHoverDepth(entry.path) > 0) return;
  if (entry.path !== draggingOverPath.value) return;
  clearDragExpandTimer();
  draggingOverPath.value = undefined;
}

function handleTreeRootDragEnter(event: DragEvent): void {
  if (!draggingSourcePath.value) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  incrementDragHoverDepth('');
  draggingOverPath.value = '';
  clearDragExpandTimer();
}

function handleTreeRootDragOver(event: DragEvent): void {
  if (!draggingSourcePath.value) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dragHoverDepthByPath[''] = Math.max(1, dragHoverDepthByPath[''] ?? 0);
  if (draggingOverPath.value !== '') {
    draggingOverPath.value = '';
    clearDragExpandTimer();
  }
}

function handleTreeRootDragLeave(event: DragEvent): void {
  if (!draggingSourcePath.value) return;
  const current = event.currentTarget as Node | null;
  const related = event.relatedTarget as Node | null;
  if (current && related && current.contains(related)) return;
  if (decrementDragHoverDepth('') > 0) return;
  if (draggingOverPath.value !== '') return;
  clearDragExpandTimer();
  draggingOverPath.value = undefined;
}

async function handleTreeDropTarget(targetDirectoryPath: string, event: DragEvent): Promise<void> {
  event.preventDefault();
  if (!draggingSourcePath.value) {
    clearFileTreeDragState();
    return;
  }
  if (
    isAncestorPath(targetDirectoryPath, draggingSourcePath.value) ||
    draggingSourcePath.value === targetDirectoryPath
  ) {
    clearFileTreeDragState();
    return;
  }
  const previous = draggingSourcePath.value;
  const next = resolveMovedPath(previous, targetDirectoryPath);
  if (next === previous) {
    clearFileTreeDragState();
    return;
  }
  error.value = undefined;
  try {
    await desktop.renameVaultPath(previous, next);
    const previousTabId = fileTabId(previous);
    if (selectedPath.value === previous) selectedPath.value = next;
    if (selectedTabId.value === previousTabId) selectedTabId.value = fileTabId(next);
    openTabs.value = openTabs.value.map((tab) => (tab.id === previousTabId ? fileTab(next) : tab));
    await loadDirectory('');
    if (targetDirectoryPath) await loadDirectory(targetDirectoryPath);
    await refreshShellData();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearFileTreeDragState();
    clearDragExpandTimer();
  }
}

async function handleTreeDrop(entry: VaultEntry, event: DragEvent): Promise<void> {
  if (entry.kind !== 'directory') {
    clearFileTreeDragState();
    return;
  }
  await handleTreeDropTarget(entry.path, event);
}

async function handleTreeRootDrop(event: DragEvent): Promise<void> {
  await handleTreeDropTarget('', event);
}

async function createNote(): Promise<void> {
  await runFileOperation(async () => {
    const name = prompt('Markdown file path', 'Untitled.md');
    if (!name) return;
    await desktop.createMarkdownFile(name, `# ${name.replace(/\.md$/i, '')}\n`);
    await loadDirectory('');
    await refreshShellData();
  });
}

async function createFolder(): Promise<void> {
  await runFileOperation(async () => {
    const name = prompt('Folder path', 'Notes');
    if (!name) return;
    await desktop.createVaultFolder(name);
    await loadDirectory('');
    await refreshShellData();
  });
}

async function runFileOperation(action: () => Promise<unknown>): Promise<void> {
  error.value = undefined;
  try {
    await action();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

async function renameSelected(): Promise<void> {
  if (!selectedPath.value) return;
  const next = prompt('Rename path', selectedPath.value);
  if (!next || next === selectedPath.value) return;
  await flushPendingAutosave();
  const previous = selectedPath.value;
  await desktop.renameVaultPath(previous, next);
  selectedPath.value = next;
  selectedTabId.value = fileTabId(next);
  openTabs.value = openTabs.value.map((tab) => (tab.id === fileTabId(previous) ? fileTab(next) : tab));
  await loadDirectory('');
  await refreshShellData();
}

async function saveActive(): Promise<void> {
  if (!selectedPath.value) return;
  await autosave.saveNow({ path: selectedPath.value, text: editorText.value });
}

async function deleteSelected(): Promise<void> {
  if (!selectedPath.value) return;
  await flushPendingAutosave();
  const previous = selectedPath.value;
  const generalSettings = jsonRecord(settingValues.value['app:app.general']);
  if (
    generalSettings.confirmDeletes !== false &&
    !confirm(`Delete ${previous}? This permanently removes the file from the vault.`)
  )
    return;
  await desktop.deleteVaultPath(previous);
  await closeTab(fileTabId(previous));
  await loadDirectory('');
  await refreshShellData();
}

function openCommandPalette(): void {
  commandPaletteOpen.value = true;
  commandQuery.value = '';
}

async function openSearchResult(path: string): Promise<void> {
  await openFileTab(path);
}

async function searchTag(tag: string): Promise<void> {
  searchQuery.value = `#${tag}`;
  await runSearch();
}

function coerceFieldValue(raw: string | boolean, type?: string): unknown {
  if (type === 'boolean') return Boolean(raw);
  if (type === 'int') return Number.parseInt(String(raw), 10) || 0;
  if (type === 'float') return Number.parseFloat(String(raw)) || 0;
  if (type === 'list')
    return String(raw)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  return raw;
}

async function setActiveFieldValue(field: FieldDto, value: unknown): Promise<void> {
  if (!selectedPath.value) return;
  fileFields.value = await desktop.updateFileField(selectedPath.value, field.key, value);
  await refreshShellData();
}

async function updateActiveField(field: FieldDto, raw: string | boolean): Promise<void> {
  await setActiveFieldValue(field, coerceFieldValue(raw, field.type));
}

async function setActiveType(typeName: string | undefined): Promise<void> {
  if (!selectedPath.value) return;
  fileFields.value = await desktop.setFileType(selectedPath.value, typeName || undefined);
  await refreshShellData();
}

async function updateActiveType(event: Event): Promise<void> {
  await setActiveType(inputValue(event) || undefined);
}

async function refreshDataView(): Promise<void> {
  if (!activeBasePath.value) {
    dataView.value = undefined;
    return;
  }
  dataView.value = await desktop.renderDataView(activeBasePath.value, activeViewId.value);
  activeViewId.value = dataView.value.viewId;
}

async function selectBase(event: Event): Promise<void> {
  activeBasePath.value = inputValue(event) || undefined;
  activeViewId.value = undefined;
  await refreshDataView();
}

async function selectView(event: Event): Promise<void> {
  activeViewId.value = inputValue(event) || undefined;
  await refreshDataView();
}

async function runCommand(command: CommandDto): Promise<void> {
  commandPaletteOpen.value = false;
  error.value = undefined;
  try {
    if (command.id === 'settings.open') {
      await desktop.executeCommand(command.id);
      settingsOpen.value = true;
      await refreshShellData();
      return;
    }
    if (command.id === 'command-palette.open') {
      openCommandPalette();
      return;
    }
    await desktop.executeCommand(command.id);
    await refreshShellData();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void saveActive();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    if (selectedTabId.value) void closeTab(selectedTabId.value);
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openCommandPalette();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === ',') {
    event.preventDefault();
    settingsOpen.value = true;
  }
}

onMounted(() => {
  startSystemThemeWatcher();
  stopDocumentThemeBinding = watch(effectiveTheme, applyDocumentTheme, { immediate: true });
  window.addEventListener('keydown', handleKeydown);
  unsubscribeSettingUpdates = desktop.onSettingUpdated(applySettingUpdate);
  void initializeWindow().catch((caught: unknown) => {
    error.value = caught instanceof Error ? caught.message : String(caught);
  });
});
onBeforeUnmount(() => {
  stopPaneResize();
  stopSystemThemeWatcher?.();
  stopDocumentThemeBinding?.();
  delete document.documentElement.dataset.zTheme;
  clearDragExpandTimer();
  window.removeEventListener('keydown', handleKeydown);
  unsubscribeIndexUpdates?.();
  unsubscribeEditorSnapshot?.();
  unsubscribeSettingUpdates?.();
  void flushPendingAutosave().catch((caught: unknown) => {
    error.value = caught instanceof Error ? caught.message : String(caught);
  });
});
</script>

<template>
  <main v-if="windowRole === 'launcher'" class="launcher-shell" :data-z-theme="effectiveTheme">
    <aside class="launcher-recents" aria-label="Recent vaults">
      <div class="traffic-light-spacer launcher-traffic-light-spacer" aria-hidden="true"></div>
      <header>
        <p class="eyebrow">Zorid</p>
        <h1>Recent vaults</h1>
      </header>
      <ul v-if="recentVaults.length > 0" class="recent-list">
        <li v-for="vault in recentVaults" :key="vault.id">
          <button type="button" @click="openRecentFromLauncher(vault.id)" :disabled="launcherBusy">
            <strong>{{ vault.name }}</strong>
            <span>{{ vault.path }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="muted">No vaults opened yet.</p>
    </aside>

    <section class="launcher-main" aria-label="Open a vault">
      <div class="zorid-gem" aria-hidden="true"></div>
      <h2>Zorid</h2>
      <p class="launcher-version">Choose a vault to start</p>
      <div class="launcher-card">
        <article class="launcher-action">
          <div>
            <h3>Create new vault</h3>
            <p>Create a new Zorid vault under a folder.</p>
          </div>
          <button type="button" class="accent" :disabled="launcherBusy" @click="createVaultFromLauncher">Create</button>
        </article>
        <article class="launcher-action">
          <div>
            <h3>Open folder as vault</h3>
            <p>Choose an existing folder of Markdown files.</p>
          </div>
          <button type="button" :disabled="launcherBusy" @click="openFolderFromLauncher">Open</button>
        </article>
        <p v-if="launcherError" class="error">{{ launcherError }}</p>
      </div>
    </section>
  </main>

  <main v-else-if="windowRole === 'editor'" class="zorid-shell" :style="shellStyle" data-zorid-shell :data-z-theme="effectiveTheme">
    <TopTabStrip
      :open-tabs="openTabs"
      :selected-tab-id="selectedTabId"
      :left-collapsed="paneLayout.leftCollapsed"
      :right-collapsed="paneLayout.rightCollapsed"
      @activate="activateTab"
      @close="closeTab"
      @new-tab="createPlaceholderTab"
      @toggle-left-pane="toggleLeftPane"
      @toggle-right-pane="toggleRightPane"
    />

    <ActivityRail
      :items="shell.activityRail"
      :icon-for="activityIconFor"
      @open-command-palette="openCommandPalette"
      @open-settings="settingsOpen = true"
    />

    <aside v-show="!paneLayout.leftCollapsed" class="sidebar" data-region="left-sidebar">
      <div class="file-pane-toolbar" aria-label="File actions">
        <ZIconButton label="New file" @click="createNote" :disabled="!vaultLabel">
          <FilePlus class="file-pane-action-icon" aria-hidden="true" />
        </ZIconButton>
        <ZIconButton label="New folder" @click="createFolder" :disabled="!vaultLabel">
          <FolderPlus class="file-pane-action-icon" aria-hidden="true" />
        </ZIconButton>
        <label class="file-pane-sort" :title="`Sort files: ${fileTreeSortLabel}`">
          <ArrowDownUp class="file-pane-action-icon" aria-hidden="true" />
          <select :value="fileTreeSortMode" :aria-label="`Sort files: ${fileTreeSortLabel}`" @change="updateFileTreeSortMode">
            <option v-for="mode in FILE_TREE_SORT_MODES" :key="mode" :value="mode">{{ sortModeLabel(mode) }}</option>
          </select>
        </label>
        <ZIconButton label="Expand loaded folders" @click="expandLoadedDirectories" :disabled="!vaultLabel">
          <ChevronsDown class="file-pane-action-icon" aria-hidden="true" />
        </ZIconButton>
        <ZIconButton label="Collapse loaded folders" @click="collapseLoadedDirectories" :disabled="!vaultLabel">
          <ChevronsUp class="file-pane-action-icon" aria-hidden="true" />
        </ZIconButton>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <FileTree
        :root-entries="rootEntries"
        :entries-by-directory="sortedEntriesByDirectory"
        :expanded-directories="expandedDirectories"
        :selected-path="selectedPath"
        :dragging-path="draggingSourcePath"
        :drag-over-path="draggingOverPath"
        @open-entry="openEntry"
        @drag-start="handleTreeDragStart"
        @drag-end="handleTreeDragEnd"
        @drag-over="handleTreeDragOver"
        @drag-enter="handleTreeDragEnter"
        @drag-leave="handleTreeDragLeave"
        @drag-over-root="handleTreeRootDragOver"
        @drag-enter-root="handleTreeRootDragEnter"
        @drag-leave-root="handleTreeRootDragLeave"
        @drop-on-directory="handleTreeDrop"
        @drop-on-root="handleTreeRootDrop"
      />
    </aside>

    <AppResizeHandle
      side="left"
      label="Resize file sidebar"
      :active="paneResize?.side === 'left'"
      @resize-start="startPaneResize('left', $event)"
    />

    <section class="editor" data-region="editor">
      <MarkdownEditor
        v-if="selectedPath"
        :text="editorText"
        :document-path="selectedPath"
        :file-fields="fileFields"
        :types="types"
        @change="updateEditorText"
        @save="saveActive"
        @error="(message) => (error = message)"
        @update-field="setActiveFieldValue"
        @update-type="setActiveType"
      />
      <p v-else class="muted new-tab-empty">{{ editorEmptyText }}</p>
    </section>

    <AppResizeHandle
      side="right"
      label="Resize right sidebar"
      :active="paneResize?.side === 'right'"
      @resize-start="startPaneResize('right', $event)"
    />

    <RightSidebarPanels
      v-show="!paneLayout.rightCollapsed"
      v-model:search-query="searchQuery"
      :search-results="searchResults"
      :outline="outline"
      :backlinks="backlinks"
      :tags="tags"
      :selected-path="selectedPath"
      :file-fields="fileFields"
      :types="types"
      :bases="bases"
      :active-base-path="activeBasePath"
      :active-view-id="activeViewId"
      :data-view="dataView"
      :markdown-embeds="markdownEmbeds"
      :index-status="indexStatus"
      :active-plugins="activePlugins"
      :plugins="plugins"
      :settings-sections="settingsSections"
      @run-search="runSearch"
      @open-search-result="openSearchResult"
      @search-tag="searchTag"
      @update-active-type="updateActiveType"
      @update-active-field="updateActiveField"
      @select-base="selectBase"
      @select-view="selectView"
      @select-embed="(embed) => { activeBasePath = embed.basePath; activeViewId = embed.viewId; refreshDataView(); }"
      @refresh-shell-data="refreshShellData"
      @open-settings="settingsOpen = true"
    />

    <AppStatusBar
      :status="status"
      :selected-path="selectedPath"
      :index-state="indexStatus.state"
      :file-count="indexStatus.fileCount"
      :plugin-count="plugins.length"
    />

    <CommandPaletteWindow
      v-model:open="commandPaletteOpen"
      v-model:query="commandQuery"
      :commands="filteredCommands"
      @run="runCommand"
    />

    <SettingsWindow
      v-model:open="settingsOpen"
      :sections="settingsSections"
      :values="settingValues"
      @update-property="updateSettingProperty"
    />
  </main>

  <main v-else class="launcher-shell loading" :data-z-theme="effectiveTheme">
    <p class="muted">Loading Zorid…</p>
  </main>
</template>
