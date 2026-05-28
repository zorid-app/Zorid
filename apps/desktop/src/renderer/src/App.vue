<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Component, CSSProperties } from 'vue';
import { ArrowDownUp, ChevronsDown, ChevronsUp, FilePlus, Files, FolderPlus, Link2, Search, Tag } from '@lucide/vue';
import { createDesktopShellState } from '@zorid/desktop-shell';
import ActivityRail from './components/ActivityRail.vue';
import AppResizeHandle from './components/AppResizeHandle.vue';
import AppStatusBar from './components/AppStatusBar.vue';
import CommandPaletteWindow from './components/CommandPaletteWindow.vue';
import FileTree from './components/FileTree.vue';
import { FILE_TREE_SORT_MODES, sortEntries, sortModeLabel, type FileTreeSortMode } from './components/file-tree-model.js';
import MarkdownEditor from './components/MarkdownEditor.vue';
import RightSidebarPanels from './components/RightSidebarPanels.vue';
import SettingsWindow from './components/SettingsWindow.vue';
import TopTabStrip from './components/TopTabStrip.vue';
import { DEFAULT_PANE_LAYOUT, SHELL_LAYOUT, parsePaneLayout, resolveDraggedPaneWidth, safePaneLayoutStorageKey, resolvePaneLayout, serializePaneLayout } from './shell-layout.js';
import type { PaneLayout } from './shell-layout.js';
import type { BacklinkDto, BaseDto, CommandDto, DataViewResultDto, EditorSnapshotDto, FieldDto, FileFieldsDto, IndexStatusDto, MarkdownEmbedDto, OutlineItemDto, PluginStatus, RecentVaultDto, SearchResultDto, SettingsSectionDto, SettingProperty, TagDto, TypeDto, VaultEntry, VaultProfileDto, WindowRole } from './types.js';

type JsonRecord = Record<string, unknown>;

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
const selectedPath = ref<string>();
const openTabs = ref<string[]>([]);
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
type ResizeSide = 'left' | 'right';
interface PaneResizeState { readonly side: ResizeSide; readonly startX: number; readonly startLeftWidth: number; readonly startRightWidth: number; }
const paneResize = ref<PaneResizeState>();
let unsubscribeIndexUpdates: (() => void) | undefined;
let unsubscribeEditorSnapshot: (() => void) | undefined;

const status = computed(() => vaultLabel.value ?? 'No vault open');
const paneLayoutStorageKeyForActiveVault = computed(() => safePaneLayoutStorageKey(vaultProfile.value?.id));
const shellStyle = computed<CSSProperties>(() => ({
  '--left-sidebar-width': `${paneLayout.value.leftWidth}px`,
  '--right-sidebar-width': `${paneLayout.value.rightWidth}px`,
  '--activity-rail-width': `${SHELL_LAYOUT.railWidth}px`,
  '--resize-handle-width': `${SHELL_LAYOUT.resizeHandleWidth}px`,
  '--titlebar-height': `${SHELL_LAYOUT.titlebarHeight}px`,
  '--traffic-light-space': `${SHELL_LAYOUT.trafficLightReservedWidth}px`,
  '--status-bar-min-height': `${SHELL_LAYOUT.statusBarMinHeight}px`,
  '--status-bar-max-height': `${SHELL_LAYOUT.statusBarMaxHeight}px`,
}));
const sortedEntriesByDirectory = computed<Record<string, readonly VaultEntry[]>>(() => Object.fromEntries(
  Object.entries(entriesByDirectory.value).map(([directory, entries]) => [directory, sortEntries(entries, fileTreeSortMode.value)]),
));
const rootEntries = computed(() => sortedEntriesByDirectory.value[''] ?? []);
const fileTreeSortLabel = computed(() => sortModeLabel(fileTreeSortMode.value));
const dirty = computed(() => selectedPath.value !== undefined && editorText.value !== savedText.value);
const editorTitle = computed(() => selectedPath.value?.split('/').at(-1) ?? vaultLabel.value ?? 'Zorid');
const editorStartupOnlyCommandIds = new Set(['vault.open', 'file-explorer.open-root']);
const visibleCommands = computed(() => windowRole.value === 'editor'
  ? commands.value.filter((command) => !editorStartupOnlyCommandIds.has(command.id))
  : commands.value);
const filteredCommands = computed(() => {
  const query = commandQuery.value.trim().toLowerCase();
  const source = visibleCommands.value;
  if (!query) return source;
  return source.filter((command: CommandDto) => `${command.title} ${command.id}`.toLowerCase().includes(query));
});
const activePlugins = computed(() => plugins.value.filter((plugin) => plugin.status === 'active').length);

function settingsKey(section: SettingsSectionDto): string {
  return `${section.pluginId ?? 'app'}:${section.id}`;
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
    const next = resolveDraggedPaneWidth(resize.startLeftWidth + delta, SHELL_LAYOUT.leftMinWidth, SHELL_LAYOUT.leftMaxWidth);
    updatePaneLayout({ leftWidth: next.width, leftCollapsed: next.collapsed }, 'left');
  } else {
    const next = resolveDraggedPaneWidth(resize.startRightWidth - delta, SHELL_LAYOUT.rightMinWidth, SHELL_LAYOUT.rightMaxWidth);
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
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
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

async function refreshMetadataPanels(): Promise<void> {
  [tags.value, types.value, bases.value] = await Promise.all([desktop.listTags(), desktop.listTypes(), desktop.listBases()]);
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
    const setting = await desktop.getSettingValue(section.id, section.pluginId) as { value?: unknown };
    next[settingsKey(section)] = setting.value;
  }
  settingValues.value = next;
}

async function updateSettingProperty(section: SettingsSectionDto, property: SettingProperty, raw: string | boolean): Promise<void> {
  const key = settingsKey(section);
  const nextValue = { ...settingObject(section), [property.name]: coerceSettingValue(raw, property.type) } satisfies JsonRecord;
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
  void loadDirectory('').then(() => refreshShellData()).catch((caught: unknown) => { error.value = caught instanceof Error ? caught.message : String(caught); });
}

async function initializeWindow(): Promise<void> {
  const role = await desktop.getWindowRole() ?? 'editor';
  windowRole.value = role;
  if (role === 'launcher') {
    await loadRecentVaults();
    return;
  }
  unsubscribeIndexUpdates = desktop.onIndexUpdated(() => { void refreshShellData(); });
  unsubscribeEditorSnapshot = desktop.onEditorSnapshot(applyEditorSnapshot);
  const profile = await desktop.getVaultProfile().catch(() => undefined);
  if (profile) {
    applyVaultProfile(profile);
    await loadDirectory('');
    await refreshShellData();
  }
}

async function openEntry(entry: VaultEntry): Promise<void> {
  error.value = undefined;
  if (entry.kind === 'directory') {
    expandedDirectories.value = { ...expandedDirectories.value, [entry.path]: !expandedDirectories.value[entry.path] };
    if (expandedDirectories.value[entry.path]) await loadDirectory(entry.path);
    return;
  }
  selectedPath.value = entry.path;
  if (!openTabs.value.includes(entry.path)) openTabs.value = [...openTabs.value, entry.path];
  const text = await desktop.readVaultText(entry.path);
  editorText.value = text;
  savedText.value = text;
  await refreshMetadataPanels();
}

async function createNote(): Promise<void> {
  const name = prompt('Markdown file path', 'Untitled.md');
  if (!name) return;
  await desktop.createMarkdownFile(name, `# ${name.replace(/\.md$/i, '')}\n`);
  await loadDirectory('');
  await refreshShellData();
}

async function createFolder(): Promise<void> {
  const name = prompt('Folder path', 'Notes');
  if (!name) return;
  await desktop.createVaultFolder(name);
  await loadDirectory('');
}

async function renameSelected(): Promise<void> {
  if (!selectedPath.value) return;
  const next = prompt('Rename path', selectedPath.value);
  if (!next || next === selectedPath.value) return;
  const previous = selectedPath.value;
  await desktop.renameVaultPath(previous, next);
  selectedPath.value = next;
  openTabs.value = openTabs.value.map((path) => path === previous ? next : path);
  await loadDirectory('');
  await refreshShellData();
}

async function activateTab(path: string): Promise<void> {
  selectedPath.value = path;
  const text = await desktop.readVaultText(path);
  editorText.value = text;
  savedText.value = text;
  await refreshMetadataPanels();
}

async function saveActive(): Promise<void> {
  if (!selectedPath.value) return;
  await desktop.writeVaultText(selectedPath.value, editorText.value);
  savedText.value = editorText.value;
  await refreshShellData();
}

async function deleteSelected(): Promise<void> {
  if (!selectedPath.value) return;
  const previous = selectedPath.value;
  const generalSettings = jsonRecord(settingValues.value['app:app.general']);
  if (generalSettings.confirmDeletes !== false && !confirm(`Delete ${previous}? This permanently removes the file from the vault.`)) return;
  await desktop.deleteVaultPath(previous);
  selectedPath.value = undefined;
  editorText.value = '';
  savedText.value = '';
  openTabs.value = openTabs.value.filter((path) => path !== previous);
  await loadDirectory('');
  await refreshShellData();
}

function openCommandPalette(): void {
  commandPaletteOpen.value = true;
  commandQuery.value = '';
}

async function openSearchResult(path: string): Promise<void> {
  selectedPath.value = path;
  if (!openTabs.value.includes(path)) openTabs.value = [...openTabs.value, path];
  const text = await desktop.readVaultText(path);
  editorText.value = text;
  savedText.value = text;
  await refreshMetadataPanels();
}

async function searchTag(tag: string): Promise<void> {
  searchQuery.value = `#${tag}`;
  await runSearch();
}

function coerceFieldValue(raw: string | boolean, type?: string): unknown {
  if (type === 'boolean') return Boolean(raw);
  if (type === 'int') return Number.parseInt(String(raw), 10) || 0;
  if (type === 'float') return Number.parseFloat(String(raw)) || 0;
  if (type === 'list') return String(raw).split(',').map((part) => part.trim()).filter(Boolean);
  return raw;
}

async function updateActiveField(field: FieldDto, raw: string | boolean): Promise<void> {
  if (!selectedPath.value) return;
  fileFields.value = await desktop.updateFileField(selectedPath.value, field.key, coerceFieldValue(raw, field.type));
  await refreshShellData();
}

async function updateActiveType(event: Event): Promise<void> {
  if (!selectedPath.value) return;
  const value = inputValue(event);
  fileFields.value = await desktop.setFileType(selectedPath.value, value || undefined);
  await refreshShellData();
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
  window.addEventListener('keydown', handleKeydown);
  void initializeWindow().catch((caught: unknown) => { error.value = caught instanceof Error ? caught.message : String(caught); });
});
onBeforeUnmount(() => {
  stopPaneResize();
  window.removeEventListener('keydown', handleKeydown);
  unsubscribeIndexUpdates?.();
  unsubscribeEditorSnapshot?.();
});
</script>

<template>
  <main v-if="windowRole === 'launcher'" class="launcher-shell" data-z-theme="dark">
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

  <main v-else-if="windowRole === 'editor'" class="zorid-shell" :style="shellStyle" data-zorid-shell data-z-theme="dark">
    <TopTabStrip
      :open-tabs="openTabs"
      :selected-path="selectedPath"
      :editor-title="editorTitle"
      :status="status"
      @activate="activateTab"
    />

    <ActivityRail
      :items="shell.activityRail"
      :icon-for="activityIconFor"
      @open-command-palette="openCommandPalette"
      @open-settings="settingsOpen = true"
    />

    <aside v-show="!paneLayout.leftCollapsed" class="sidebar" data-region="left-sidebar">
      <header>
        <p class="eyebrow">Zorid</p>
        <h1>Files</h1>
      </header>
      <p class="muted">{{ status }}</p>
      <div class="file-pane-toolbar" aria-label="File actions">
        <button type="button" class="file-pane-action" @click="createNote" :disabled="!vaultLabel" aria-label="New file" title="New file">
          <FilePlus class="file-pane-action-icon" aria-hidden="true" />
        </button>
        <button type="button" class="file-pane-action" @click="createFolder" :disabled="!vaultLabel" aria-label="New folder" title="New folder">
          <FolderPlus class="file-pane-action-icon" aria-hidden="true" />
        </button>
        <label class="file-pane-sort" :title="`Sort files: ${fileTreeSortLabel}`">
          <ArrowDownUp class="file-pane-action-icon" aria-hidden="true" />
          <select :value="fileTreeSortMode" :aria-label="`Sort files: ${fileTreeSortLabel}`" @change="updateFileTreeSortMode">
            <option v-for="mode in FILE_TREE_SORT_MODES" :key="mode" :value="mode">{{ sortModeLabel(mode) }}</option>
          </select>
        </label>
        <button type="button" class="file-pane-action" @click="expandLoadedDirectories" :disabled="!vaultLabel" aria-label="Expand loaded folders" title="Expand loaded folders">
          <ChevronsDown class="file-pane-action-icon" aria-hidden="true" />
        </button>
        <button type="button" class="file-pane-action" @click="collapseLoadedDirectories" :disabled="!vaultLabel" aria-label="Collapse loaded folders" title="Collapse loaded folders">
          <ChevronsUp class="file-pane-action-icon" aria-hidden="true" />
        </button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <FileTree
        :root-entries="rootEntries"
        :entries-by-directory="sortedEntriesByDirectory"
        :expanded-directories="expandedDirectories"
        :selected-path="selectedPath"
        @open-entry="openEntry"
      />
    </aside>

    <AppResizeHandle
      side="left"
      label="Resize file sidebar"
      :active="paneResize?.side === 'left'"
      @resize-start="startPaneResize('left', $event)"
    />

    <section class="editor" data-region="editor">
      <p class="eyebrow">Markdown editor</p>
      <h2>{{ selectedPath ?? 'Open a Markdown file' }} <span v-if="dirty" class="dirty">• unsaved</span></h2>
      <div class="toolbar inline" aria-label="Selected file actions">
        <button type="button" :disabled="!selectedPath || !dirty" @click="saveActive">Save</button>
        <button type="button" :disabled="!selectedPath" @click="renameSelected">Rename</button>
        <button type="button" :disabled="!selectedPath" @click="deleteSelected">Delete</button>
      </div>
      <MarkdownEditor v-if="selectedPath" :text="editorText" @change="(text) => { editorText = text; }" @save="saveActive" />
      <p v-else class="muted">Select a Markdown file from the filesystem-backed explorer.</p>
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

  <main v-else class="launcher-shell loading" data-z-theme="dark">
    <p class="muted">Loading Zorid…</p>
  </main>
</template>
