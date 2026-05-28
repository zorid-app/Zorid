<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Component } from 'vue';
import { ChevronDown, ChevronRight, Command, FileText, Files, Folder, Link2, Search, Settings, Tag } from '@lucide/vue';
import { createDesktopShellState } from '@zorid/desktop-shell';
import type { PluginStatus, VaultEntry } from '@zorid/platform-api';
import MarkdownEditor from './components/MarkdownEditor.vue';

type JsonRecord = Record<string, unknown>;

interface CommandDto { readonly id: string; readonly title: string; }
interface SettingsSectionDto {
  readonly id: string;
  readonly title: string;
  readonly schema: unknown;
  readonly source: 'app' | 'plugin-runtime' | 'plugin-manifest';
  readonly pluginId?: string;
  readonly pluginStatus?: PluginStatus['status'];
}
interface IndexStatusDto {
  readonly state: 'idle' | 'rebuilding' | 'watching' | 'updating' | 'error';
  readonly fileCount: number;
  readonly lastIndexedAtMs?: number;
  readonly diagnostics: readonly string[];
  readonly error?: string;
}
interface SearchResultDto { readonly path: string; readonly title: string; readonly excerpt: string; }
interface BacklinkDto { readonly fromPath: string; readonly excerpt: string; }
interface TagDto { readonly tag: string; readonly count: number; }
interface OutlineItemDto { readonly path: string; readonly heading: string; readonly ordinal: number; }
interface TypeDto { readonly path: string; readonly name: string; readonly fields: readonly { readonly key: string; readonly type: string; readonly required?: boolean; readonly default?: unknown }[]; readonly diagnostics: readonly string[]; }
interface FieldDto { readonly key: string; readonly value?: unknown; readonly type?: string; readonly required?: boolean; readonly source: 'frontmatter' | 'type-default'; }
interface FileFieldsDto { readonly path: string; readonly typeName?: string; readonly fields: readonly FieldDto[]; readonly diagnostics: readonly { readonly key: string; readonly message: string }[]; }
interface BaseDto { readonly path: string; readonly name: string; readonly views: readonly { readonly id: string; readonly renderer: string }[]; readonly diagnostics: readonly string[]; }
interface DataViewResultDto { readonly basePath: string; readonly viewId: string; readonly renderer: string; readonly columns: readonly string[]; readonly rows: readonly { readonly path: string; readonly fields: Record<string, unknown> }[]; readonly groups: readonly { readonly key: string; readonly rows: readonly { readonly path: string; readonly fields: Record<string, unknown> }[] }[]; }
interface MarkdownEmbedDto { readonly sourcePath: string; readonly basePath: string; readonly viewId?: string; }
type WindowRole = 'launcher' | 'editor';
interface RecentVaultDto { readonly id: string; readonly name: string; readonly path: string; readonly lastOpenedAt: string; }
interface EditorSnapshotDto { readonly profile?: { readonly rootLabel: string }; readonly indexStatus: IndexStatusDto; }

interface SettingProperty {
  readonly name: string;
  readonly title: string;
  readonly type: string;
  readonly description?: string;
  readonly defaultValue?: unknown;
}

const desktop = window.zoridDesktop as unknown as {
  getWindowRole(): Promise<WindowRole | undefined>;
  createVault(): Promise<{ rootLabel: string } | undefined>;
  openVault(): Promise<{ rootLabel: string } | undefined>;
  listRecentVaults(): Promise<readonly RecentVaultDto[]>;
  openRecentVault(id: string): Promise<{ rootLabel: string }>;
  getVaultProfile(): Promise<{ rootLabel: string } | undefined>;
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
const vaultLabel = ref<string>();
const entriesByDirectory = ref<Record<string, readonly VaultEntry[]>>({});
const expandedDirectories = ref<Record<string, boolean>>({ '': true });
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
let unsubscribeIndexUpdates: (() => void) | undefined;
let unsubscribeEditorSnapshot: (() => void) | undefined;

const status = computed(() => vaultLabel.value ?? 'No vault open');
const rootEntries = computed(() => entriesByDirectory.value[''] ?? []);
const dirty = computed(() => selectedPath.value !== undefined && editorText.value !== savedText.value);
const filteredCommands = computed(() => {
  const query = commandQuery.value.trim().toLowerCase();
  if (!query) return commands.value;
  return commands.value.filter((command: CommandDto) => `${command.title} ${command.id}`.toLowerCase().includes(query));
});
const activePlugins = computed(() => plugins.value.filter((plugin) => plugin.status === 'active').length);
const activeBase = computed(() => bases.value.find((base) => base.path === activeBasePath.value));

function settingsKey(section: SettingsSectionDto): string {
  return `${section.pluginId ?? 'app'}:${section.id}`;
}

function activityIconFor(item: string): Component {
  return activityIcons[item] ?? Files;
}

function jsonRecord(value: unknown): JsonRecord {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function schemaRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function settingProperties(section: SettingsSectionDto): readonly SettingProperty[] {
  const properties = schemaRecord(section.schema).properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.entries(properties as Record<string, Record<string, unknown>>).map(([name, schema]) => {
    const property: SettingProperty = {
      name,
      title: typeof schema.title === 'string' ? schema.title : name,
      type: typeof schema.type === 'string' ? schema.type : 'string',
      ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
      ...(schema.default !== undefined ? { defaultValue: schema.default } : {}),
    };
    return property;
  });
}

function settingObject(section: SettingsSectionDto): JsonRecord {
  return jsonRecord(settingValues.value[settingsKey(section)]);
}

function settingDisplayValue(section: SettingsSectionDto, property: SettingProperty): string {
  const value = settingObject(section)[property.name] ?? property.defaultValue ?? '';
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
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

function inputChecked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked;
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

async function openVault(): Promise<void> {
  error.value = undefined;
  try {
    await desktop.openVault();
    if (windowRole.value === 'launcher') await loadRecentVaults();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
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
  if (snapshot.profile) vaultLabel.value = snapshot.profile.rootLabel;
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
    vaultLabel.value = profile.rootLabel;
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

function fieldInputValue(field: FieldDto): string {
  if (field.value === undefined || field.value === null) return '';
  if (Array.isArray(field.value)) return field.value.join(', ');
  return String(field.value);
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
    if (command.id === 'vault.open' || command.id === 'file-explorer.open-root') {
      await openVault();
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
  window.removeEventListener('keydown', handleKeydown);
  unsubscribeIndexUpdates?.();
  unsubscribeEditorSnapshot?.();
});
</script>

<template>
  <main v-if="windowRole === 'launcher'" class="launcher-shell" data-z-theme="dark">
    <aside class="launcher-recents" aria-label="Recent vaults">
      <div class="window-dots" aria-hidden="true"><span></span><span></span><span></span></div>
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

  <main v-else-if="windowRole === 'editor'" class="zorid-shell" data-zorid-shell data-z-theme="dark">
    <aside class="activity-rail" aria-label="Primary navigation">
      <button v-for="item in shell.activityRail" :key="item" type="button" class="rail-button" :title="item" :aria-label="item">
        <component :is="activityIconFor(item)" class="icon" aria-hidden="true" />
      </button>
      <button type="button" class="rail-button" title="Command palette" aria-label="Command palette" @click="openCommandPalette">
        <Command class="icon" aria-hidden="true" />
      </button>
      <button type="button" class="rail-button" title="Settings" aria-label="Settings" @click="settingsOpen = true">
        <Settings class="icon" aria-hidden="true" />
      </button>
    </aside>

    <aside class="sidebar" data-region="left-sidebar">
      <header>
        <p class="eyebrow">Zorid</p>
        <h1>Files</h1>
      </header>
      <button type="button" class="primary" @click="openVault">Open vault</button>
      <p class="muted">{{ status }}</p>
      <div class="toolbar" aria-label="File actions">
        <button type="button" @click="createNote" :disabled="!vaultLabel">New note</button>
        <button type="button" @click="createFolder" :disabled="!vaultLabel">New folder</button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <ul class="file-tree" aria-label="Vault files">
        <li v-for="entry in rootEntries" :key="entry.path">
          <button type="button" class="tree-item" :class="{ selected: selectedPath === entry.path }" @click="openEntry(entry)">
            <ChevronDown v-if="entry.kind === 'directory' && expandedDirectories[entry.path]" class="tree-icon" aria-hidden="true" />
            <ChevronRight v-else-if="entry.kind === 'directory'" class="tree-icon" aria-hidden="true" />
            <FileText v-else class="tree-icon" aria-hidden="true" />
            {{ entry.path }}
          </button>
          <ul v-if="entry.kind === 'directory' && expandedDirectories[entry.path]" class="nested">
            <li v-for="child in entriesByDirectory[entry.path] ?? []" :key="child.path">
              <button type="button" class="tree-item" :class="{ selected: selectedPath === child.path }" @click="openEntry(child)">
                <Folder v-if="child.kind === 'directory'" class="tree-icon" aria-hidden="true" />
                <FileText v-else class="tree-icon" aria-hidden="true" />
                {{ child.path.split('/').at(-1) }}
              </button>
            </li>
          </ul>
        </li>
      </ul>
    </aside>

    <section class="editor" data-region="editor">
      <p class="eyebrow">Markdown editor</p>
      <h2>{{ selectedPath ?? 'Open a Markdown file' }} <span v-if="dirty" class="dirty">• unsaved</span></h2>
      <nav v-if="openTabs.length > 0" class="tab-bar" aria-label="Open Markdown files">
        <button v-for="path in openTabs" :key="path" type="button" :class="{ selected: selectedPath === path }" @click="activateTab(path)">
          {{ path.split('/').at(-1) }}
        </button>
      </nav>
      <div class="toolbar inline" aria-label="Selected file actions">
        <button type="button" :disabled="!selectedPath || !dirty" @click="saveActive">Save</button>
        <button type="button" :disabled="!selectedPath" @click="renameSelected">Rename</button>
        <button type="button" :disabled="!selectedPath" @click="deleteSelected">Delete</button>
      </div>
      <MarkdownEditor v-if="selectedPath" :text="editorText" @change="(text) => { editorText = text; }" @save="saveActive" />
      <p v-else class="muted">Open a vault, then select a Markdown file from the real filesystem-backed explorer.</p>
    </section>

    <aside class="sidebar right" data-region="right-sidebar">
      <section class="panel">
        <p class="eyebrow">Search</p>
        <input v-model="searchQuery" class="side-input" placeholder="Search files, tags, headings…" @input="runSearch" />
        <ul class="result-list" aria-label="Search results">
          <li v-for="result in searchResults" :key="result.path">
            <button type="button" @click="openSearchResult(result.path)">
              <strong>{{ result.title }}</strong>
              <small>{{ result.path }}</small>
              <span>{{ result.excerpt }}</span>
            </button>
          </li>
        </ul>
      </section>
      <section class="panel">
        <p class="eyebrow">Outline</p>
        <ol v-if="outline.length > 0" class="outline-list">
          <li v-for="item in outline" :key="`${item.path}:${item.ordinal}`">{{ item.heading }}</li>
        </ol>
        <p v-else class="muted">No indexed headings for this file.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Backlinks</p>
        <ul v-if="backlinks.length > 0" class="result-list">
          <li v-for="link in backlinks" :key="link.fromPath">
            <button type="button" @click="openSearchResult(link.fromPath)">
              <strong>{{ link.fromPath }}</strong>
              <span>{{ link.excerpt }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="muted">No backlinks found.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Tags</p>
        <div v-if="tags.length > 0" class="tag-cloud">
          <button v-for="tag in tags" :key="tag.tag" type="button" @click="searchTag(tag.tag)">#{{ tag.tag }} <small>{{ tag.count }}</small></button>
        </div>
        <p v-else class="muted">No tags indexed.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Fields</p>
        <template v-if="selectedPath && fileFields">
          <label class="setting-field">
            <span>Type</span>
            <select :value="fileFields.typeName ?? ''" @change="updateActiveType">
              <option value="">None</option>
              <option v-for="type in types" :key="type.path" :value="type.name">{{ type.name }}</option>
            </select>
          </label>
          <div v-if="fileFields.diagnostics.length > 0" class="diagnostics">
            <p v-for="diagnostic in fileFields.diagnostics" :key="`${diagnostic.key}:${diagnostic.message}`">{{ diagnostic.key }}: {{ diagnostic.message }}</p>
          </div>
          <div class="fields-grid">
            <label v-for="field in fileFields.fields" :key="field.key" class="setting-field">
              <span>{{ field.key }} <small v-if="field.required">required</small></span>
              <input
                v-if="field.type === 'boolean'"
                type="checkbox"
                :checked="Boolean(field.value)"
                @change="updateActiveField(field, inputChecked($event))"
              />
              <input
                v-else
                :type="field.type === 'int' || field.type === 'float' ? 'number' : 'text'"
                :value="fieldInputValue(field)"
                @change="updateActiveField(field, inputValue($event))"
              />
            </label>
          </div>
        </template>
        <p v-else class="muted">Select an indexed Markdown file to edit fields.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Types</p>
        <ul v-if="types.length > 0" class="type-list">
          <li v-for="type in types" :key="type.path">
            <strong>{{ type.name }}</strong>
            <small>{{ type.fields.length }} fields</small>
            <p v-for="diagnostic in type.diagnostics" :key="diagnostic" class="error">{{ diagnostic }}</p>
          </li>
        </ul>
        <p v-else class="muted">No .ztype schemas found in .zorid/types.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Bases</p>
        <template v-if="bases.length > 0">
          <label class="setting-field">
            <span>.zbase</span>
            <select :value="activeBasePath ?? ''" @change="selectBase">
              <option v-for="base in bases" :key="base.path" :value="base.path">{{ base.name }}</option>
            </select>
          </label>
          <label v-if="activeBase" class="setting-field">
            <span>View</span>
            <select :value="activeViewId ?? ''" @change="selectView">
              <option v-for="view in activeBase.views" :key="view.id" :value="view.id">{{ view.id }} · {{ view.renderer }}</option>
            </select>
          </label>
          <div v-if="dataView" class="data-view" :data-renderer="dataView.renderer">
            <p class="muted">{{ dataView.renderer }} · {{ dataView.rows.length }} rows</p>
            <table v-if="dataView.renderer === 'table'">
              <thead><tr><th v-for="column in dataView.columns" :key="column">{{ column }}</th></tr></thead>
              <tbody>
                <tr v-for="row in dataView.rows" :key="row.path">
                  <td v-for="column in dataView.columns" :key="column">{{ column === 'path' ? row.path : row.fields[column] }}</td>
                </tr>
              </tbody>
            </table>
            <ul v-else class="result-list">
              <li v-for="row in dataView.rows" :key="row.path"><button type="button" @click="openSearchResult(row.path)">{{ row.path }}</button></li>
            </ul>
            <div v-if="dataView.groups.length > 0" class="group-list">
              <p v-for="group in dataView.groups" :key="group.key">{{ group.key }} · {{ group.rows.length }}</p>
            </div>
          </div>
        </template>
        <p v-else class="muted">No .zbase files found.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Markdown embeds</p>
        <div v-if="markdownEmbeds.length > 0" class="embed-list">
          <button v-for="embed in markdownEmbeds" :key="`${embed.basePath}:${embed.viewId ?? ''}`" type="button" @click="() => { activeBasePath = embed.basePath; activeViewId = embed.viewId; refreshDataView(); }">
            {{ embed.basePath }}<template v-if="embed.viewId">#{{ embed.viewId }}</template>
          </button>
        </div>
        <p v-else class="muted">No ![[*.zbase]] embeds in this file.</p>
      </section>
      <section class="panel">
        <p class="eyebrow">Status</p>
        <p class="muted">Index: {{ indexStatus.state }} · {{ indexStatus.fileCount }} files</p>
        <p class="muted">Plugins: {{ activePlugins }} active / {{ plugins.length }} registered</p>
      </section>
      <section class="panel">
        <div class="panel-header">
          <p class="eyebrow">Plugins</p>
          <button type="button" @click="refreshShellData">Refresh</button>
        </div>
        <ul class="plugin-list" aria-label="Plugin statuses">
          <li v-for="plugin in plugins" :key="plugin.pluginId">
            <span>{{ plugin.pluginId.replace('zorid.core.', '') }}</span>
            <strong>{{ plugin.status }}</strong>
          </li>
        </ul>
      </section>
      <section class="panel">
        <div class="panel-header">
          <p class="eyebrow">Settings</p>
          <button type="button" @click="settingsOpen = true">Open</button>
        </div>
        <p class="muted">{{ settingsSections.length }} schema sections discovered without activating placeholders.</p>
      </section>
    </aside>

    <footer class="status-bar" aria-label="Application status">
      <span>{{ status }}</span>
      <span>{{ selectedPath ?? 'No file selected' }}</span>
      <span>Index {{ indexStatus.state }} · {{ indexStatus.fileCount }} files</span>
      <span>{{ plugins.length }} plugins</span>
    </footer>

    <div v-if="commandPaletteOpen" class="modal-backdrop" role="presentation" @click.self="commandPaletteOpen = false">
      <section class="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input v-model="commandQuery" class="command-input" autofocus placeholder="Run a command…" @keydown.escape="commandPaletteOpen = false" />
        <ul class="command-list">
          <li v-for="command in filteredCommands" :key="command.id">
            <button type="button" @click="runCommand(command)">
              <span>{{ command.title }}</span>
              <small>{{ command.id }}</small>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <div v-if="settingsOpen" class="modal-backdrop" role="presentation" @click.self="settingsOpen = false">
      <section class="settings-shell" role="dialog" aria-modal="true" aria-label="Settings">
        <header class="settings-header">
          <div>
            <p class="eyebrow">Settings</p>
            <h2>App and plugin settings</h2>
          </div>
          <button type="button" @click="settingsOpen = false">Close</button>
        </header>
        <article v-for="section in settingsSections" :key="settingsKey(section)" class="settings-section">
          <header>
            <h3>{{ section.title }}</h3>
            <p class="muted">{{ section.source }}<template v-if="section.pluginId"> · {{ section.pluginId }} · {{ section.pluginStatus }}</template></p>
          </header>
          <div v-if="settingProperties(section).length > 0" class="settings-grid">
            <label v-for="property in settingProperties(section)" :key="property.name" class="setting-field">
              <span>{{ property.title }}</span>
              <input
                v-if="property.type === 'boolean'"
                type="checkbox"
                :checked="Boolean(settingObject(section)[property.name] ?? property.defaultValue)"
                @change="updateSettingProperty(section, property, inputChecked($event))"
              />
              <input
                v-else
                :type="property.type === 'number' || property.type === 'integer' ? 'number' : 'text'"
                :value="settingDisplayValue(section, property)"
                @change="updateSettingProperty(section, property, inputValue($event))"
              />
              <small v-if="property.description">{{ property.description }}</small>
            </label>
          </div>
          <p v-else class="muted">Schema registered; no editable primitive properties yet.</p>
        </article>
      </section>
    </div>
  </main>

  <main v-else class="launcher-shell loading" data-z-theme="dark">
    <p class="muted">Loading Zorid…</p>
  </main>
</template>
