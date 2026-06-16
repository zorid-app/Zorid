import path from 'node:path';
import { createZoridKernel, type ZoridKernel } from '@zorid/app-kernel';
import type { IndexStore } from '@zorid/db';
import { NodeSqliteIndexStore } from '@zorid/db/node-sqlite';
import { createEditorService } from '@zorid/editor';
import type { IndexedFileRecord } from '@zorid/index-api';
import { InlineIndexScheduler } from '@zorid/index-worker';
import { createJsIndexEngine, parseFrontmatter } from '@zorid/indexer-js';
import { parseZbase, parseZtype } from '@zorid/object-store';
import type {
  CapabilityName,
  CommandContribution,
  FileRendererSurface,
  PluginStatus,
  SettingsContribution,
  VaultEntry,
  VaultProfile,
  ZbaseFilters,
  ZbaseView,
  ZtypeField,
} from '@zorid/platform-api';
import type { PluginManifest, ZoridPlugin, ZoridPluginContext } from '@zorid/plugin-api';
import { createPluginRegistryAPI, PluginHost, resolveFileRendererContribution } from '@zorid/plugin-host';
import {
  asPluginId,
  type Disposable,
  type DisposableStack,
  type JsonValue,
  normalizeVaultPath,
  type VaultPath,
} from '@zorid/shared';
import { createVaultService, type FolderVault } from '@zorid/vault';
import { createWorkspaceService } from '@zorid/workspace';

export interface SettingsSectionDto {
  readonly id: string;
  readonly title: string;
  readonly schema: JsonValue;
  readonly source: 'app' | 'plugin-runtime' | 'plugin-manifest';
  readonly pluginId?: string;
  readonly pluginStatus?: PluginStatus['status'];
}

export interface CommandDto {
  readonly id: string;
  readonly title: string;
}

export interface SettingValueDto {
  readonly sectionId: string;
  readonly pluginId?: string;
  readonly value: JsonValue | undefined;
}

export interface IndexStatusDto {
  readonly state: 'idle' | 'rebuilding' | 'watching' | 'updating' | 'error';
  readonly fileCount: number;
  readonly lastIndexedAtMs?: number;
  readonly diagnostics: readonly string[];
  readonly error?: string;
}

export interface SearchResultDto {
  readonly path: VaultPath;
  readonly title: string;
  readonly excerpt: string;
}

export interface SearchCandidateDto {
  readonly value: string;
  readonly replacement: string;
}

type SearchOperatorKind = 'path' | 'file' | 'tag' | 'line' | 'section' | 'property-exists' | 'property-value';

interface SearchOperatorClause {
  readonly kind: SearchOperatorKind;
  readonly key?: string;
  readonly value?: string;
}

interface ParsedSearchQuery {
  readonly bareTerms: readonly string[];
  readonly operatorClauses: readonly SearchOperatorClause[];
  readonly hasOperatorSyntax: boolean;
}

interface SearchCandidateContext {
  readonly kind: 'path' | 'file' | 'tag' | 'property-key' | 'property-value';
  readonly fragment: string;
  readonly propertyKey?: string;
}

interface SearchCandidateCorpus {
  readonly pathValues: readonly string[];
  readonly fileValues: readonly string[];
  readonly tagValues: readonly string[];
  readonly propertyKeys: readonly string[];
  readonly propertyValuesByKey: ReadonlyMap<string, readonly string[]>;
}

export interface BacklinkDto {
  readonly fromPath: VaultPath;
  readonly excerpt: string;
}

export interface TagDto {
  readonly tag: string;
  readonly count: number;
}

export interface OutlineItemDto {
  readonly path: VaultPath;
  readonly heading: string;
  readonly ordinal: number;
}

export interface TypeDto {
  readonly path: VaultPath;
  readonly name: string;
  readonly fields: readonly ZtypeField[];
  readonly diagnostics: readonly string[];
}

export interface FieldDto {
  readonly key: string;
  readonly value: JsonValue | undefined;
  readonly type?: ZtypeField['type'];
  readonly required?: boolean;
  readonly source: 'frontmatter' | 'type-default';
}

export interface FieldValidationDiagnosticDto {
  readonly key: string;
  readonly message: string;
}

export interface FileFieldsDto {
  readonly path: VaultPath;
  readonly typeName?: string;
  readonly typePath?: VaultPath;
  readonly fields: readonly FieldDto[];
  readonly diagnostics: readonly FieldValidationDiagnosticDto[];
}

export interface BaseDto {
  readonly path: VaultPath;
  readonly name: string;
  readonly views: readonly ZbaseView[];
  readonly diagnostics: readonly string[];
}

export interface DataViewRowDto {
  readonly path: VaultPath;
  readonly fields: Readonly<Record<string, JsonValue>>;
}

export interface DataViewGroupDto {
  readonly key: string;
  readonly rows: readonly DataViewRowDto[];
}

export interface DataViewResultDto {
  readonly basePath: VaultPath;
  readonly viewId: string;
  readonly renderer: string;
  readonly columns: readonly string[];
  readonly rows: readonly DataViewRowDto[];
  readonly groups: readonly DataViewGroupDto[];
}

export interface MarkdownEmbedDto {
  readonly sourcePath: VaultPath;
  readonly basePath: VaultPath;
  readonly viewId?: string;
  readonly rendererId?: string;
  readonly renderer?: FileRendererMatchDto;
}

export interface FileRendererMatchDto {
  readonly pluginId: string;
  readonly rendererId: string;
  readonly title: string;
  readonly surface: FileRendererSurface;
  readonly path: VaultPath;
  readonly rendererEntry: string;
  readonly rendererExport: string;
}

export const trustedCoreFileRendererLoaders: ReadonlyMap<
  string,
  { readonly pluginId: string; readonly rendererEntry: string; readonly rendererExport: string }
> = new Map([
  [
    'zorid.core.data-views.zbase',
    {
      pluginId: 'zorid.core.data-views',
      rendererEntry: './src/file-renderers.ts',
      rendererExport: 'zbaseFileRenderer',
    },
  ],
]);

export const appSettingsSections: readonly SettingsContribution[] = [
  {
    id: 'app.general',
    title: 'General',
    schema: { type: 'object', properties: { confirmDeletes: { type: 'boolean', default: true } } },
  },
  {
    id: 'app.appearance',
    title: 'Appearance',
    schema: {
      type: 'object',
      properties: {
        theme: {
          type: 'string',
          title: 'Theme',
          description: 'Choose how Zorid selects its color theme.',
          default: 'system',
          enum: ['system', 'light', 'dark'],
        },
      },
    },
  },
];

export interface AppSettingsStore {
  get(sectionId: string): JsonValue | undefined;
  set(sectionId: string, value: JsonValue): JsonValue | undefined;
}

export class InMemoryAppSettingsStore implements AppSettingsStore {
  readonly #values = new Map<string, JsonValue>();

  get(sectionId: string): JsonValue | undefined {
    return this.#values.get(`app:${sectionId}`);
  }

  set(sectionId: string, value: JsonValue): JsonValue | undefined {
    if (!appSettingsSections.some((section) => section.id === sectionId))
      throw new Error(`Unknown app settings section: ${sectionId}`);
    this.#values.set(`app:${sectionId}`, value);
    return this.get(sectionId);
  }
}

const desktopCapabilities: readonly CapabilityName[] = [
  'vault.read',
  'vault.write',
  'vault.write.markdown',
  'vault.write.zbase',
  'vault.write.ztype',
  'metadata.read',
  'workspace.views',
  'workspace.navigation',
  'workspace.fileRenderers',
  'editor.read',
  'editor.write',
  'commands.register',
  'settings.register',
  'status.register',
  'desktop.folderVault',
  'nativeFs.watch',
];

export const corePluginManifests: readonly PluginManifest[] = [
  {
    schemaVersion: 1,
    id: 'zorid.core.file-explorer',
    name: 'File Explorer',
    version: '0.1.0',
    kind: 'core',
    entry: './src/index.ts',
    zoridApi: '^0.1.0',
    platforms: ['desktop'],
    capabilities: {
      required: ['vault.read', 'vault.write', 'workspace.views', 'workspace.navigation', 'commands.register'],
      optional: [],
    },
    activation: ['onCommand:file-explorer.open-root', 'onCommand:file-explorer.open-readme'],
    contributes: {
      commands: [
        { id: 'file-explorer.open-root', title: 'Open File Explorer' },
        { id: 'file-explorer.open-readme', title: 'Open README' },
      ],
    },
  },
  {
    schemaVersion: 1,
    id: 'zorid.core.search',
    name: 'Search',
    version: '0.1.0',
    kind: 'core',
    entry: './src/index.ts',
    zoridApi: '^0.1.0',
    platforms: ['desktop'],
    capabilities: { required: ['metadata.read', 'workspace.views', 'commands.register'], optional: [] },
    activation: ['onCommand:search.open'],
    contributes: { commands: [{ id: 'search.open', title: 'Open Search' }] },
  },
  {
    schemaVersion: 1,
    id: 'zorid.core.backlinks',
    name: 'Backlinks',
    version: '0.1.0',
    kind: 'core',
    entry: './src/index.ts',
    zoridApi: '^0.1.0',
    platforms: ['desktop'],
    capabilities: { required: ['metadata.read', 'workspace.views', 'commands.register'], optional: [] },
    activation: ['onCommand:backlinks.open'],
    contributes: { commands: [{ id: 'backlinks.open', title: 'Open Backlinks' }] },
  },
  {
    schemaVersion: 1,
    id: 'zorid.core.outline',
    name: 'Outline',
    version: '0.1.0',
    kind: 'core',
    entry: './src/index.ts',
    zoridApi: '^0.1.0',
    platforms: ['desktop'],
    capabilities: { required: ['metadata.read', 'workspace.navigation', 'commands.register'], optional: [] },
    activation: ['onCommand:outline.open'],
    contributes: { commands: [{ id: 'outline.open', title: 'Open Outline' }] },
  },
  {
    schemaVersion: 1,
    id: 'zorid.core.tags',
    name: 'Tags',
    version: '0.1.0',
    kind: 'core',
    entry: './src/index.ts',
    zoridApi: '^0.1.0',
    platforms: ['desktop'],
    capabilities: { required: ['metadata.read', 'workspace.views', 'commands.register'], optional: [] },
    activation: ['onCommand:tags.open'],
    contributes: { commands: [{ id: 'tags.open', title: 'Open Tags' }] },
  },
  {
    schemaVersion: 1,
    id: 'zorid.core.status-bar',
    name: 'Status Bar',
    version: '0.1.0',
    kind: 'core',
    entry: './src/index.ts',
    zoridApi: '^0.1.0',
    platforms: ['desktop'],
    capabilities: { required: ['status.register', 'commands.register', 'settings.register'], optional: [] },
    activation: ['onCommand:status-bar.open'],
    contributes: {
      commands: [{ id: 'status-bar.open', title: 'Open Status Bar' }],
      statusItems: [{ id: 'zorid.core.status-bar' }],
      settings: [
        {
          id: 'status-bar',
          title: 'Status Bar',
          schema: {
            type: 'object',
            properties: {
              showVault: { type: 'boolean', default: true },
              showIndexStatus: { type: 'boolean', default: true },
            },
          },
        },
      ],
    },
  },
  {
    schemaVersion: 1,
    id: 'zorid.core.fields',
    name: 'Fields',
    version: '0.1.0',
    kind: 'core',
    entry: './src/index.ts',
    zoridApi: '^0.1.0',
    platforms: ['desktop'],
    capabilities: {
      required: ['metadata.read', 'vault.write.markdown', 'vault.write.ztype', 'commands.register'],
      optional: [],
    },
    activation: ['onCommand:fields.inspect-active'],
    contributes: { commands: [{ id: 'fields.inspect-active', title: 'Inspect Active Fields' }] },
  },
  {
    schemaVersion: 1,
    id: 'zorid.core.data-views',
    name: 'Data Views',
    version: '0.1.0',
    kind: 'core',
    entry: './src/index.ts',
    rendererEntry: './src/file-renderers.ts',
    zoridApi: '^0.1.0',
    platforms: ['desktop'],
    capabilities: {
      required: ['metadata.read', 'workspace.views', 'workspace.fileRenderers', 'vault.read', 'commands.register'],
      optional: [],
    },
    dependsOn: { 'zorid.core.fields': '^0.1.0' },
    activation: [
      'onCommand:data-views.open',
      'onMarkdownEmbed:.zbase',
      'onFileExtension:.zbase',
      'onFileRenderer:.zbase',
    ],
    contributes: {
      commands: [{ id: 'data-views.open', title: 'Open Base' }],
      viewRenderers: [{ type: 'table' }, { type: 'list' }],
      fileRenderers: [
        {
          id: 'zorid.core.data-views.zbase',
          title: 'Zbase Data View',
          extensions: ['.zbase'],
          surfaces: ['full-page', 'markdown-embed'],
          priority: 100,
          rendererExport: 'zbaseFileRenderer',
        },
      ],
    },
  },
];

export interface DesktopRuntimeOptions {
  readonly manifests?: readonly PluginManifest[];
  readonly load?: (manifest: PluginManifest) => Promise<ZoridPlugin> | ZoridPlugin;
  readonly appSettings?: AppSettingsStore;
}

interface DebugVaultPathDescription {
  readonly input: string;
  readonly normalized?: VaultPath;
  readonly resolved?: string;
  readonly exists: boolean;
  readonly kind?: 'file' | 'directory';
  readonly error?: string;
}

function missingRuntimeLoader(manifest: PluginManifest): never {
  throw new Error(`No runtime loader installed for core plugin: ${manifest.id}`);
}

export class DesktopRuntime {
  readonly kernel: ZoridKernel;
  readonly pluginHost: PluginHost;
  readonly workspace = createWorkspaceService();
  readonly editor = createEditorService({
    read: (path) => this.requireVault().readText(path),
    write: (path, contents) => this.requireVault().writeText(path, contents),
  });
  #activeVault?: FolderVault;
  #indexStore?: IndexStore;
  #appSettings: AppSettingsStore;
  #indexWatcher?: Disposable;
  #vaultServiceRegistration?: Disposable;
  #indexServiceRegistration?: Disposable;
  #indexUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  #indexStatus: IndexStatusDto = { state: 'idle', fileCount: 0, diagnostics: [] };
  #settingsValues = new Map<string, JsonValue>();
  #placeholderCommands = new Map<string, Disposable>();
  #searchCandidateCorpus: SearchCandidateCorpus | undefined;
  #searchCandidateCorpusStore: IndexStore | undefined;

  constructor(options: DesktopRuntimeOptions = {}) {
    const manifests = options.manifests ?? corePluginManifests;
    this.#appSettings = options.appSettings ?? new InMemoryAppSettingsStore();
    this.kernel = createZoridKernel({ capabilities: desktopCapabilities });
    for (const section of appSettingsSections) this.kernel.settings.register(section);
    this.registerAppCommands();
    this.kernel.services.register('workspace', this.workspace);
    this.kernel.services.register('editor', this.editor);
    this.pluginHost = new PluginHost({
      manifests,
      platform: 'desktop',
      capabilities: new Set(desktopCapabilities),
      load: options.load ?? missingRuntimeLoader,
      events: this.kernel.events,
      createBaseContext: (manifest, stack) => this.createPluginContext(manifest, stack),
    });
    this.registerStaticPlaceholders(manifests);
  }

  async debugDescribeVaultPath(vaultPath: string): Promise<DebugVaultPathDescription> {
    const normalized = normalizeVaultPath(vaultPath);
    const resolved = this.requireVault().resolve(normalized);
    try {
      const info = await this.requireVault().stat(normalized);
      return {
        input: vaultPath,
        normalized,
        resolved,
        exists: true,
        ...(info?.kind === undefined ? {} : { kind: info.kind }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { input: vaultPath, normalized, resolved, exists: false, error: 'ENOENT' };
      throw error;
    }
  }

  vaultRoot(): string | undefined {
    return this.#activeVault?.root;
  }

  async openVault(root: string): Promise<VaultProfile> {
    if (this.#indexUpdateTimer) {
      clearTimeout(this.#indexUpdateTimer);
      this.#indexUpdateTimer = undefined;
    }
    await this.#indexWatcher?.dispose();
    this.#vaultServiceRegistration?.dispose();
    this.#indexServiceRegistration?.dispose();
    this.#indexStore?.dispose();
    this.#searchCandidateCorpus = undefined;
    this.#searchCandidateCorpusStore = undefined;
    this.#activeVault = createVaultService(root);
    this.#indexStore = new NodeSqliteIndexStore(path.join(this.#activeVault.root, '.zorid', 'index', 'index.sqlite'));
    this.#vaultServiceRegistration = this.kernel.services.register('vault', this.#activeVault);
    this.#indexServiceRegistration = this.kernel.services.register('index.store', this.#indexStore);
    this.kernel.events.emit('vault:opened', this.#activeVault.profile);
    await this.rebuildIndex();
    this.#indexWatcher = this.#activeVault.watch((event) => this.scheduleIndexUpdate(event.path));
    return this.#activeVault.profile;
  }

  vaultProfile(): VaultProfile | undefined {
    return this.#activeVault?.profile;
  }
  requireVault(): FolderVault {
    if (!this.#activeVault) throw new Error('No vault is open.');
    return this.#activeVault;
  }
  resolveVaultPath(vaultPath: string): string {
    return this.requireVault().resolve(normalizeVaultPath(vaultPath));
  }
  async listVault(path = ''): Promise<readonly VaultEntry[]> {
    return this.requireVault().list(normalizeVaultPath(path));
  }
  async readVaultText(path: string): Promise<string> {
    return this.requireVault().readText(normalizeVaultPath(path));
  }
  async writeVaultText(path: string, contents: string): Promise<void> {
    const vaultPath = normalizeVaultPath(path);
    await this.requireVault().writeText(vaultPath, contents);
    await this.updateIndexedPath(vaultPath);
  }
  async createVaultFolder(path: string): Promise<void> {
    await this.requireVault().createFolder(normalizeVaultPath(path));
  }
  async createMarkdownFile(path: string, contents = ''): Promise<void> {
    const vaultPath = normalizeVaultPath(path);
    if (await this.requireVault().stat(vaultPath)) throw new Error(`Vault path already exists: ${vaultPath}`);
    await this.requireVault().writeText(vaultPath, contents);
    await this.updateIndexedPath(vaultPath);
  }
  async renameVaultPath(from: string, to: string): Promise<void> {
    const fromPath = normalizeVaultPath(from);
    const toPath = normalizeVaultPath(to);
    if (await this.requireVault().stat(toPath)) throw new Error(`Vault path already exists: ${toPath}`);
    await this.requireVault().rename(fromPath, toPath);
    this.#indexStore?.delete(fromPath);
    await this.updateIndexedPath(toPath);
  }
  async deleteVaultPath(path: string): Promise<void> {
    const vaultPath = normalizeVaultPath(path);
    const info = await this.requireVault().stat(vaultPath);
    await this.requireVault().delete(vaultPath);
    if (info?.kind === 'directory') {
      await this.rebuildIndex();
      this.#emitIndexUpdated([vaultPath]);
      return;
    }
    this.#indexStore?.delete(vaultPath);
    this.#emitIndexUpdated([vaultPath]);
  }
  listCommands(): readonly CommandDto[] {
    return this.kernel.commands.list().map(({ id, title }) => ({ id, title }));
  }
  async executeCommand(id: string, args?: JsonValue): Promise<unknown> {
    return this.kernel.commands.execute(id, args);
  }
  listPluginStatuses(): readonly PluginStatus[] {
    return createPluginRegistryAPI(this.pluginHost).listStatuses();
  }
  listSettingsSections(): readonly SettingsSectionDto[] {
    const runtime = this.kernel.settings.list().map(
      (section): SettingsSectionDto => ({
        id: section.id,
        title: section.title,
        schema: section.schema,
        source: section.id.startsWith('app.') ? 'app' : 'plugin-runtime',
      }),
    );
    const staticSections = this.pluginHost.staticSettings().map(
      (section): SettingsSectionDto => ({
        id: section.id,
        title: section.title,
        schema: section.schema,
        source: 'plugin-manifest',
        pluginId: section.pluginId,
        pluginStatus: section.pluginStatus,
      }),
    );
    const seen = new Set<string>();
    return [...runtime, ...staticSections].filter((section) => {
      const key = this.settingsKey(section.id, section.pluginId);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  getSettingValue(sectionId: string, pluginId?: string): SettingValueDto {
    if (pluginId === undefined && sectionId.startsWith('app.'))
      return { sectionId, value: this.#appSettings.get(sectionId) };
    return pluginId === undefined
      ? { sectionId, value: this.#settingsValues.get(this.settingsKey(sectionId)) }
      : { sectionId, pluginId, value: this.#settingsValues.get(this.settingsKey(sectionId, pluginId)) };
  }

  setSettingValue(sectionId: string, value: JsonValue, pluginId?: string): SettingValueDto {
    const section = this.listSettingsSections().find(
      (candidate) => candidate.id === sectionId && candidate.pluginId === pluginId,
    );
    if (!section) throw new Error(`Unknown settings section: ${pluginId ? `${pluginId}:` : ''}${sectionId}`);
    if (pluginId === undefined && sectionId.startsWith('app.')) {
      this.#appSettings.set(sectionId, value);
      const dto = this.getSettingValue(sectionId);
      this.kernel.events.emit('settings:updated', dto);
      return dto;
    }
    this.#settingsValues.set(this.settingsKey(sectionId, pluginId), value);
    const dto = this.getSettingValue(sectionId, pluginId);
    this.kernel.events.emit('settings:updated', dto);
    return dto;
  }

  settingsKey(sectionId: string, pluginId?: string): string {
    return `${pluginId ?? 'app'}:${sectionId}`;
  }

  getIndexStatus(): IndexStatusDto {
    return { ...this.#indexStatus, diagnostics: [...this.#indexStatus.diagnostics] };
  }
  getIndexedFile(path: string): IndexedFileRecord | undefined {
    return this.#indexStore?.get(normalizeVaultPath(path));
  }
  searchIndex(query: string): readonly SearchResultDto[] {
    const store = this.#indexStore;
    if (!store) return [];
    const parsed = this.parseSearchQuery(query);
    if (!parsed.hasOperatorSyntax || parsed.operatorClauses.length === 0) return this.searchIndexFullText(store, query);
    return this.searchIndexWithOperators(store, parsed);
  }

  searchIndexFullText(store: IndexStore, query: string): readonly SearchResultDto[] {
    const needle = query.trim().replace(/^#/, '').toLowerCase();
    if (!needle) return [];
    if (store instanceof NodeSqliteIndexStore) {
      return store.searchFullText(query).map((hit) => {
        const record = store.get(hit.path);
        return {
          path: hit.path,
          title: record?.headings[0] ?? path.basename(String(hit.path)),
          excerpt: hit.snippet || (record ? this.excerpt(record, needle) : ''),
        };
      });
    }
    return this.fallbackSearch(store, needle);
  }

  searchIndexWithOperators(store: IndexStore, parsed: ParsedSearchQuery): readonly SearchResultDto[] {
    return store
      .all()
      .filter((record) => this.recordMatchesOperatorQuery(record, parsed))
      .map((record) => ({
        path: record.path,
        title: record.headings[0] ?? path.basename(String(record.path)),
        excerpt: this.operatorExcerpt(record, parsed),
      }))
      .sort((a, b) => String(a.path).localeCompare(String(b.path)))
      .slice(0, 50);
  }

  searchIndexCandidates(query: string): readonly SearchCandidateDto[] {
    const store = this.#indexStore;
    if (!store) return [];
    const context = this.parseSearchCandidateContext(query);
    if (!context) return [];
    const corpus = this.searchCandidateCorpus(store);
    const normalizedFragment = this.normalizeSearchValue(context.fragment);
    const includesFragment = (value: string): boolean =>
      normalizedFragment.length === 0 || value.toLowerCase().includes(normalizedFragment);
    const toCandidate = (value: string): SearchCandidateDto => ({
      value,
      replacement: this.searchCandidateReplacement(context, value),
    });
    const select = (values: readonly string[]): readonly SearchCandidateDto[] =>
      values
        .filter((value) => includesFragment(value))
        .slice(0, 200)
        .map(toCandidate);

    if (context.kind === 'path') {
      return select(corpus.pathValues);
    }
    if (context.kind === 'file') {
      return select(corpus.fileValues);
    }
    if (context.kind === 'tag') {
      return select(corpus.tagValues);
    }
    if (context.kind === 'property-key') {
      return select(corpus.propertyKeys);
    }
    if (context.kind === 'property-value') {
      const propertyKey = this.normalizeSearchValue(context.propertyKey ?? '');
      if (!propertyKey) return [];
      const values = corpus.propertyValuesByKey.get(propertyKey) ?? [];
      return select(values);
    }
    return [];
  }

  getBacklinks(vaultPath: string): readonly BacklinkDto[] {
    if (!this.#indexStore) return [];
    const target = normalizeVaultPath(vaultPath);
    return this.#indexStore
      .all()
      .filter((record) =>
        record.links.some((link) => link === target || path.basename(String(link)) === path.basename(String(target))),
      )
      .map((record) => ({ fromPath: record.path, excerpt: this.excerpt(record, String(target).toLowerCase()) }));
  }

  listTags(): readonly TagDto[] {
    if (!this.#indexStore) return [];
    const counts = new Map<string, number>();
    for (const record of this.#indexStore.all()) {
      for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => ({ tag, count }));
  }

  getOutline(vaultPath: string): readonly OutlineItemDto[] {
    const record = this.getIndexedFile(vaultPath);
    return record?.headings.map((heading, index) => ({ path: record.path, heading, ordinal: index + 1 })) ?? [];
  }

  async listTypes(): Promise<readonly TypeDto[]> {
    if (!this.#activeVault) return [];
    const vault = this.requireVault();
    let entries: readonly VaultEntry[] = [];
    try {
      entries = await vault.list(normalizeVaultPath('.zorid/types'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const types: TypeDto[] = [];
    for (const entry of entries.filter(
      (candidate) => candidate.kind === 'file' && String(candidate.path).endsWith('.ztype'),
    )) {
      const diagnostics: string[] = [];
      let fields: readonly ZtypeField[] = [];
      try {
        fields = parseZtype(entry.path, await vault.readText(entry.path)).fields;
      } catch (error) {
        diagnostics.push(error instanceof Error ? error.message : String(error));
      }
      types.push({ path: entry.path, name: path.basename(String(entry.path), '.ztype'), fields, diagnostics });
    }
    return types.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getFileFields(vaultPath: string): Promise<FileFieldsDto> {
    const normalized = normalizeVaultPath(vaultPath);
    const record = this.requireIndexStore().get(normalized);
    const fields = record?.fields ?? {};
    const typeName = typeof fields['zorid.type'] === 'string' ? fields['zorid.type'] : undefined;
    const type = typeName ? (await this.listTypes()).find((candidate) => candidate.name === typeName) : undefined;
    const schemaFields = type?.fields ?? [];
    const fieldDtos: FieldDto[] = [];
    const seen = new Set<string>();
    for (const schema of schemaFields) {
      seen.add(schema.key);
      const value = fields[schema.key] ?? schema.default;
      fieldDtos.push({
        key: schema.key,
        value,
        type: schema.type,
        ...(schema.required !== undefined ? { required: schema.required } : {}),
        source: fields[schema.key] === undefined ? 'type-default' : 'frontmatter',
      });
    }
    for (const [key, value] of Object.entries(fields)) {
      if (!seen.has(key)) fieldDtos.push({ key, value, source: 'frontmatter' });
    }
    return {
      path: normalized,
      ...(typeName !== undefined ? { typeName } : {}),
      ...(type !== undefined ? { typePath: type.path } : {}),
      fields: fieldDtos,
      diagnostics: this.validateFields(fields, schemaFields),
    };
  }

  async updateFileField(vaultPath: string, key: string, value: JsonValue): Promise<FileFieldsDto> {
    const normalized = normalizeVaultPath(vaultPath);
    const record = this.requireIndexStore().get(normalized);
    if (!record) throw new Error(`No indexed file: ${normalized}`);
    const fields: Record<string, JsonValue> = { ...record.fields, [key]: value };
    if (value === null) delete fields[key];
    await this.writeMarkdownFrontmatter(normalized, fields);
    await this.updateIndexedPath(normalized);
    return this.getFileFields(normalized);
  }

  async setFileType(vaultPath: string, typeName: string | undefined): Promise<FileFieldsDto> {
    return this.updateFileField(vaultPath, 'zorid.type', typeName ?? null);
  }

  async listBases(): Promise<readonly BaseDto[]> {
    if (!this.#activeVault) return [];
    const vault = this.requireVault();
    const roots = ['.zorid/views', '.zorid/bases', ''];
    const seen = new Set<string>();
    const bases: BaseDto[] = [];
    for (const root of roots) {
      let entries: readonly VaultEntry[] = [];
      try {
        entries = await vault.list(normalizeVaultPath(root));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries.filter(
        (candidate) => candidate.kind === 'file' && String(candidate.path).endsWith('.zbase'),
      )) {
        if (seen.has(String(entry.path))) continue;
        seen.add(String(entry.path));
        bases.push(await this.readBase(entry.path));
      }
    }
    return bases.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  }

  async renderDataView(basePath: string, viewId?: string): Promise<DataViewResultDto> {
    const base = await this.readBase(normalizeVaultPath(basePath));
    const view = base.views.find((candidate) => candidate.id === viewId) ?? base.views[0];
    if (!view)
      return {
        basePath: base.path,
        viewId: viewId ?? 'default',
        renderer: 'table',
        columns: ['path'],
        rows: [],
        groups: [],
      };
    const viewOptions = view as ZbaseView & { sortBy?: string; sort?: string; groupBy?: string; group?: string };
    const sortKey = viewOptions.sortBy ?? viewOptions.sort;
    const groupKey = viewOptions.groupBy ?? viewOptions.group;
    const rows = this.requireIndexStore()
      .all()
      .filter((record) => !String(record.path).endsWith('.zbase') && !String(record.path).endsWith('.ztype'))
      .filter((record) => this.matchesZbaseFilters(record.fields, view.filters))
      .map((record) => ({ path: record.path, fields: record.fields }));
    if (sortKey) rows.sort((a, b) => String(a.fields[sortKey] ?? '').localeCompare(String(b.fields[sortKey] ?? '')));
    const columns = [...new Set(['path', ...rows.flatMap((row) => Object.keys(row.fields))])];
    const groups = groupKey ? this.groupRows(rows, groupKey) : [];
    return { basePath: base.path, viewId: view.id, renderer: view.renderer, columns, rows, groups };
  }

  getMarkdownEmbeds(vaultPath: string): readonly MarkdownEmbedDto[] {
    const normalized = normalizeVaultPath(vaultPath);
    const record = this.getIndexedFile(normalized);
    if (!record) return [];
    return [...record.text.matchAll(/!\[\[([^\]#]+)(?:#([A-Za-z0-9_.-]+))?\]\]/g)].flatMap((match) => {
      const basePath = normalizeVaultPath(match[1] ?? '');
      const renderer = this.resolveFileRenderer(basePath, 'markdown-embed');
      if (!renderer && !basePath.toLowerCase().endsWith('.zbase')) return [];
      return {
        sourcePath: normalized,
        basePath,
        ...(match[2] ? { viewId: match[2] } : {}),
        ...(renderer ? { rendererId: renderer.rendererId, renderer } : {}),
      };
    });
  }

  resolveFileRenderer(path: string, surface: FileRendererSurface): FileRendererMatchDto | undefined {
    const normalized = normalizeVaultPath(path);
    const contribution = resolveFileRendererContribution([...this.pluginHost.manifests.values()], normalized, surface);
    const loader = contribution ? trustedCoreFileRendererLoaders.get(contribution.id) : undefined;
    const manifest = contribution ? this.pluginHost.manifests.get(contribution.pluginId) : undefined;
    if (
      !contribution ||
      !loader ||
      !manifest ||
      loader.pluginId !== contribution.pluginId ||
      loader.rendererEntry !== manifest.rendererEntry ||
      loader.rendererExport !== contribution.rendererExport
    )
      return undefined;
    return contribution
      ? {
          pluginId: contribution.pluginId,
          rendererId: contribution.id,
          title: contribution.title,
          surface,
          path: normalized,
          rendererEntry: loader.rendererEntry,
          rendererExport: loader.rendererExport,
        }
      : undefined;
  }

  async rebuildIndex(): Promise<IndexStatusDto> {
    const vault = this.requireVault();
    const store = this.requireIndexStore();
    this.#setIndexStatus({ state: 'rebuilding', fileCount: store.all().length });
    try {
      const files = await this.collectIndexableFiles();
      const output = await new InlineIndexScheduler(createJsIndexEngine()).rebuild(files);
      store.replaceAll(output.records);
      this.#setIndexStatus({
        state: 'watching',
        fileCount: store.all().length,
        lastIndexedAtMs: Date.now(),
        diagnostics: output.diagnostics.map(
          (diagnostic) => `${diagnostic.path}: ${diagnostic.code}: ${diagnostic.message}`,
        ),
      });
      this.#emitIndexUpdated(output.records.map((record) => record.path));
      return this.getIndexStatus();
    } catch (error) {
      this.#setIndexStatus({
        state: 'error',
        fileCount: store.all().length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async collectIndexableFiles(
    directory = '',
  ): Promise<readonly { readonly path: VaultPath; readonly contents: string }[]> {
    const vault = this.requireVault();
    let entries: readonly VaultEntry[];
    try {
      entries = await vault.list(normalizeVaultPath(directory));
    } catch (error) {
      if (this.#isMissingPathError(error)) return [];
      throw error;
    }

    const files: { path: VaultPath; contents: string }[] = [];
    for (const entry of entries) {
      if (this.#isIgnoredIndexPath(entry.path)) continue;
      try {
        if (entry.kind === 'directory') files.push(...(await this.collectIndexableFiles(entry.path)));
        else if (this.#isIndexableFile(entry.path))
          files.push({ path: entry.path, contents: await vault.readText(entry.path) });
      } catch (error) {
        if (!this.#isMissingPathError(error)) throw error;
      }
    }
    return files;
  }

  scheduleIndexUpdate(path: VaultPath): void {
    if (this.#isIgnoredIndexPath(path)) return;
    if (this.#indexUpdateTimer) clearTimeout(this.#indexUpdateTimer);
    this.#setIndexStatus({ state: 'updating', fileCount: this.#indexStore?.all().length ?? 0 });
    this.#indexUpdateTimer = setTimeout(() => {
      this.#indexUpdateTimer = undefined;
      void this.updateIndexedPath(path).catch(() => undefined);
    }, 50);
  }

  async updateIndexedPath(path: VaultPath): Promise<void> {
    if (this.#isIgnoredIndexPath(path)) return;
    const vault = this.requireVault();
    const store = this.requireIndexStore();
    try {
      const info = await vault.stat(path);
      if (!info) store.delete(path);
      else if (info.kind === 'directory') {
        await this.rebuildIndex();
        return;
      } else if (this.#isIndexableFile(path)) {
        const output = await new InlineIndexScheduler(createJsIndexEngine()).update({
          path,
          contents: await vault.readText(path),
        });
        const [record] = output.records;
        if (record) store.upsert(record);
      } else store.delete(path);
      this.#setIndexStatus({ state: 'watching', fileCount: store.all().length, lastIndexedAtMs: Date.now() });
      this.#emitIndexUpdated([path]);
    } catch (error) {
      if (this.#isMissingPathError(error)) {
        store.delete(path);
        this.#setIndexStatus({ state: 'watching', fileCount: store.all().length, lastIndexedAtMs: Date.now() });
        this.#emitIndexUpdated([path]);
        return;
      }
      this.#setIndexStatus({
        state: 'error',
        fileCount: store.all().length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  requireIndexStore(): IndexStore {
    if (!this.#indexStore) throw new Error('Index store is not initialized.');
    return this.#indexStore;
  }
  #setIndexStatus(next: Partial<IndexStatusDto> & Pick<IndexStatusDto, 'state' | 'fileCount'>): void {
    this.#indexStatus = { ...this.#indexStatus, diagnostics: [], ...next };
    this.kernel.events.emit('metadata:index-status', this.#indexStatus);
  }
  #emitIndexUpdated(paths: readonly VaultPath[]): void {
    this.#searchCandidateCorpus = undefined;
    this.#searchCandidateCorpusStore = undefined;
    this.kernel.events.emit('metadata:index-updated', { paths });
  }
  #isIndexableFile(path: VaultPath): boolean {
    return /\.(md|markdown|ztype|zbase)$/i.test(String(path));
  }
  #isIgnoredIndexPath(path: VaultPath): boolean {
    const value = String(path);
    return (
      value.startsWith('.zorid/index/') ||
      value === '.zorid/index' ||
      /(?:^|\/)[^/]+\.sqlite(?:-(?:wal|shm))?$/i.test(value) ||
      /(?:^|\/)[^/]+-(?:wal|shm)$/i.test(value)
    );
  }
  #isMissingPathError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    );
  }
  excerpt(record: IndexedFileRecord, needle: string): string {
    const normalized = needle.replace(/^#/, '').toLowerCase();
    const line =
      record.text.split(/\r?\n/).find((candidate) => candidate.toLowerCase().includes(normalized)) ??
      record.text.split(/\r?\n/)[0] ??
      '';
    return line.slice(0, 180);
  }

  operatorExcerpt(record: IndexedFileRecord, parsed: ParsedSearchQuery): string {
    const lineClauses = parsed.operatorClauses.filter((clause) => clause.kind === 'line' && clause.value);
    for (const clause of lineClauses) {
      const match = this.findLineMatch(record, clause.value ?? '');
      if (match) return match.slice(0, 180);
    }
    const sectionClauses = parsed.operatorClauses.filter((clause) => clause.kind === 'section' && clause.value);
    for (const clause of sectionClauses) {
      const section = this.findSectionMatch(record, clause.value ?? '');
      if (!section) continue;
      const heading = section.split(/\r?\n/).find((line) => /^#{1,6}\s+/.test(line.trim()));
      if (heading) return heading.slice(0, 180);
      const line = section.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
      if (line) return line.slice(0, 180);
    }
    const terms = [
      ...parsed.bareTerms,
      ...parsed.operatorClauses
        .map((clause) => clause.value?.trim())
        .filter((value): value is string => Boolean(value)),
    ];
    for (const term of terms) {
      const normalized = this.normalizeSearchValue(term);
      if (!normalized) continue;
      const line = record.text.split(/\r?\n/).find((candidate) => candidate.toLowerCase().includes(normalized));
      if (line) return line.slice(0, 180);
    }
    return (record.text.split(/\r?\n/)[0] ?? '').slice(0, 180);
  }

  fallbackSearch(store: IndexStore, needle: string): readonly SearchResultDto[] {
    return store
      .all()
      .filter((record) => {
        const haystack = [record.path, record.text, ...record.headings, ...record.tags.map((tag) => `#${tag}`)]
          .join('\n')
          .toLowerCase();
        return haystack.includes(needle);
      })
      .map((record) => ({
        path: record.path,
        title: record.headings[0] ?? path.basename(String(record.path)),
        excerpt: this.excerpt(record, needle),
      }))
      .slice(0, 50);
  }

  parseSearchQuery(query: string): ParsedSearchQuery {
    const tokens = this.tokenizeSearchQuery(query);
    const bareTerms: string[] = [];
    const operatorClauses: SearchOperatorClause[] = [];
    let hasOperatorSyntax = false;

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      const propertyClause = this.parsePropertyClause(token);
      if (propertyClause) {
        operatorClauses.push(propertyClause);
        hasOperatorSyntax = true;
        continue;
      }
      if (this.isPropertyLikeToken(token)) {
        hasOperatorSyntax = true;
        continue;
      }
      const operatorMatch = token.match(/^(path|file|tag|line|section):(.*)$/i);
      if (!operatorMatch) {
        bareTerms.push(this.normalizeSearchValue(token));
        continue;
      }
      hasOperatorSyntax = true;
      const kind = operatorMatch[1]?.toLowerCase() as Exclude<SearchOperatorKind, 'property-exists' | 'property-value'>;
      let rawValue = operatorMatch[2] ?? '';
      const nextToken = tokens[index + 1];
      if (!rawValue && typeof nextToken === 'string' && !this.tokenStartsOperator(nextToken)) {
        rawValue = nextToken;
        index += 1;
      }
      const value = this.normalizeSearchValue(rawValue);
      if (!value) continue;
      operatorClauses.push({ kind, value });
    }

    return {
      bareTerms: bareTerms.filter((term) => term.length > 0),
      operatorClauses,
      hasOperatorSyntax,
    };
  }

  tokenizeSearchQuery(query: string): readonly string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;
    let escaped = false;
    for (const char of query) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        current += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        inQuotes = !inQuotes;
        current += char;
        continue;
      }
      if (!inQuotes && /\s/.test(char)) {
        if (current.trim()) tokens.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim()) tokens.push(current.trim());
    return tokens;
  }

  parseSearchCandidateContext(query: string): SearchCandidateContext | undefined {
    if (!query.trim() || /\s$/.test(query)) return undefined;
    const tokens = this.tokenizeSearchQuery(query);
    const token = tokens.at(-1);
    if (!token) return undefined;

    const operatorMatch = token.match(/^(path|file|tag):(.*)$/i);
    if (operatorMatch) {
      const kindToken = operatorMatch[1];
      if (!kindToken) return undefined;
      const kind = kindToken.toLowerCase() as 'path' | 'file' | 'tag';
      const fragment = this.normalizeCandidateFragment(operatorMatch[2] ?? '');
      return { kind, fragment };
    }

    const propertyValueMatch = token.match(/^\[([^\]:]+):([^\]]*)$/);
    if (propertyValueMatch) {
      return {
        kind: 'property-value',
        propertyKey: this.normalizeSearchValue(propertyValueMatch[1] ?? ''),
        fragment: this.normalizeCandidateFragment(propertyValueMatch[2] ?? ''),
      };
    }

    const propertyKeyMatch = token.match(/^\[([^\]]*)$/);
    if (propertyKeyMatch) {
      return {
        kind: 'property-key',
        fragment: this.normalizeCandidateFragment(propertyKeyMatch[1] ?? ''),
      };
    }
    return undefined;
  }

  parsePropertyClause(token: string): SearchOperatorClause | undefined {
    const valueClause = token.match(/^\[([^\]\s:]+):(.+)\]$/);
    if (valueClause) {
      const key = this.normalizeSearchValue(valueClause[1] ?? '');
      const value = this.normalizeSearchValue(valueClause[2] ?? '');
      if (!key || !value) return undefined;
      return { kind: 'property-value', key, value };
    }
    const existsClause = token.match(/^\[([^\]\s:]+)\]$/);
    if (!existsClause) return undefined;
    const key = this.normalizeSearchValue(existsClause[1] ?? '');
    if (!key) return undefined;
    return { kind: 'property-exists', key };
  }

  isPropertyLikeToken(token: string): boolean {
    return token.startsWith('[') && (token.includes(':') || token.endsWith(']'));
  }

  tokenStartsOperator(token: string): boolean {
    return /^(path|file|tag|line|section):/i.test(token) || token.startsWith('[');
  }

  normalizeSearchValue(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    const quoted = trimmed.match(/^"((?:\\.|[^"\\])*)"$/);
    if (!quoted) return trimmed.toLowerCase();
    const quotedValue = quoted[1];
    if (quotedValue === undefined) return '';
    return quotedValue.replace(/\\"/g, '"').replace(/\\\\/g, '\\').toLowerCase();
  }

  normalizeCandidateFragment(value: string): string {
    return value.trim().replace(/^"/, '').replace(/\\"/g, '"').toLowerCase();
  }

  searchCandidateReplacement(context: SearchCandidateContext, value: string): string {
    if (context.kind === 'path' || context.kind === 'file' || context.kind === 'tag') {
      return `${context.kind}:${this.quoteSearchValueIfNeeded(value)}`;
    }
    if (context.kind === 'property-key') return `[${value}]`;
    return `[${context.propertyKey ?? ''}:${this.quoteSearchValueIfNeeded(value)}]`;
  }

  quoteSearchValueIfNeeded(value: string): string {
    if (!/\s/.test(value)) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  searchCandidateCorpus(store: IndexStore): SearchCandidateCorpus {
    if (this.#searchCandidateCorpus && this.#searchCandidateCorpusStore === store) return this.#searchCandidateCorpus;

    const pathValues = new Set<string>();
    const fileValues = new Set<string>();
    const tagValues = new Set<string>();
    const propertyKeys = new Set<string>();
    const propertyValuesByKey = new Map<string, Set<string>>();

    for (const record of store.all()) {
      const recordPath = String(record.path);
      if (!recordPath.startsWith('.zorid/')) {
        pathValues.add(recordPath);
        fileValues.add(path.basename(recordPath));
      }
      const segments = recordPath.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        const prefix = segments.slice(0, index).join('/');
        if (prefix && !prefix.startsWith('.zorid/')) pathValues.add(prefix);
      }

      for (const tag of record.tags) tagValues.add(tag);

      for (const [key, rawValue] of Object.entries(record.fields)) {
        propertyKeys.add(key);
        const normalizedKey = key.toLowerCase();
        const values = propertyValuesByKey.get(normalizedKey) ?? new Set<string>();
        if (Array.isArray(rawValue)) {
          for (const value of rawValue) values.add(String(value));
        } else {
          values.add(String(rawValue));
        }
        propertyValuesByKey.set(normalizedKey, values);
      }
    }

    const sortedValuesByKey = new Map<string, readonly string[]>();
    for (const [key, values] of propertyValuesByKey.entries()) {
      sortedValuesByKey.set(
        key,
        [...values].sort((a, b) => a.localeCompare(b)),
      );
    }

    this.#searchCandidateCorpusStore = store;
    this.#searchCandidateCorpus = {
      pathValues: [...pathValues].sort((a, b) => a.localeCompare(b)),
      fileValues: [...fileValues].sort((a, b) => a.localeCompare(b)),
      tagValues: [...tagValues].sort((a, b) => a.localeCompare(b)),
      propertyKeys: [...propertyKeys].sort((a, b) => a.localeCompare(b)),
      propertyValuesByKey: sortedValuesByKey,
    };
    return this.#searchCandidateCorpus;
  }

  recordMatchesOperatorQuery(record: IndexedFileRecord, parsed: ParsedSearchQuery): boolean {
    const haystack = [record.path, record.text, ...record.headings, ...record.tags.map((tag) => `#${tag}`)]
      .join('\n')
      .toLowerCase();
    for (const term of parsed.bareTerms) {
      if (!haystack.includes(term)) return false;
    }
    return parsed.operatorClauses.every((clause) => this.matchesOperatorClause(record, clause));
  }

  matchesOperatorClause(record: IndexedFileRecord, clause: SearchOperatorClause): boolean {
    if (clause.kind === 'path')
      return String(record.path)
        .toLowerCase()
        .includes(this.normalizeSearchValue(clause.value ?? ''));
    if (clause.kind === 'file')
      return path
        .basename(String(record.path))
        .toLowerCase()
        .includes(this.normalizeSearchValue(clause.value ?? ''));
    if (clause.kind === 'tag') {
      const expected = this.normalizeSearchValue(clause.value ?? '').replace(/^#/, '');
      return record.tags.some((tag) => tag.toLowerCase() === expected);
    }
    if (clause.kind === 'line') return Boolean(this.findLineMatch(record, clause.value ?? ''));
    if (clause.kind === 'section') return Boolean(this.findSectionMatch(record, clause.value ?? ''));
    if (clause.kind === 'property-exists') return this.propertyExists(record, clause.key ?? '');
    if (clause.kind === 'property-value') return this.propertyMatches(record, clause.key ?? '', clause.value ?? '');
    return false;
  }

  findLineMatch(record: IndexedFileRecord, query: string): string | undefined {
    const terms = this.normalizeSearchValue(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return undefined;
    return record.text.split(/\r?\n/).find((line) => terms.every((term) => line.toLowerCase().includes(term)));
  }

  findSectionMatch(record: IndexedFileRecord, query: string): string | undefined {
    const terms = this.normalizeSearchValue(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return undefined;
    const sections = this.splitMarkdownSections(record.text);
    return sections.find((section) => {
      const normalized = section.toLowerCase();
      return terms.every((term) => normalized.includes(term));
    });
  }

  splitMarkdownSections(text: string): readonly string[] {
    const lines = text.split(/\r?\n/);
    const sections: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (/^#{1,6}\s+/.test(line.trim()) && current.length > 0) {
        sections.push(current.join('\n'));
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) sections.push(current.join('\n'));
    return sections;
  }

  propertyExists(record: IndexedFileRecord, key: string): boolean {
    const expected = this.normalizeSearchValue(key);
    return Object.keys(record.fields).some((fieldKey) => fieldKey.toLowerCase() === expected);
  }

  propertyMatches(record: IndexedFileRecord, key: string, query: string): boolean {
    const expectedKey = this.normalizeSearchValue(key);
    const valueEntry = Object.entries(record.fields).find(([fieldKey]) => fieldKey.toLowerCase() === expectedKey);
    if (!valueEntry) return false;
    return this.matchesFieldValue(valueEntry[1], query);
  }

  matchesFieldValue(value: JsonValue, query: string): boolean {
    const normalized = this.normalizeSearchValue(query);
    if (normalized.length === 0) return false;
    if (Array.isArray(value)) return value.some((item) => this.matchesFieldValue(item as JsonValue, query));
    if (typeof value === 'string') return value.toLowerCase().includes(normalized);
    if (typeof value === 'number') {
      const expected = Number(normalized);
      return Number.isFinite(expected) && value === expected;
    }
    if (typeof value === 'boolean') {
      if (normalized !== 'true' && normalized !== 'false') return false;
      return value === (normalized === 'true');
    }
    return false;
  }

  validateFields(
    fields: Readonly<Record<string, JsonValue>>,
    schemaFields: readonly ZtypeField[],
  ): readonly FieldValidationDiagnosticDto[] {
    const diagnostics: FieldValidationDiagnosticDto[] = [];
    for (const field of schemaFields) {
      const value = fields[field.key] ?? field.default;
      if (field.required && (value === undefined || value === null || value === ''))
        diagnostics.push({ key: field.key, message: 'Required field is missing.' });
      if (value !== undefined && value !== null && !this.matchesFieldType(value, field.type))
        diagnostics.push({ key: field.key, message: `Expected ${field.type}.` });
    }
    return diagnostics;
  }

  matchesFieldType(value: JsonValue, type: ZtypeField['type']): boolean {
    if (type === 'string' || type === 'date' || type === 'datetime' || type === 'multiselect')
      return typeof value === 'string';
    if (type === 'int') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'float') return typeof value === 'number';
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'list') return Array.isArray(value);
    return true;
  }

  async writeMarkdownFrontmatter(vaultPath: VaultPath, fields: Readonly<Record<string, JsonValue>>): Promise<void> {
    if (!/\.(md|markdown)$/i.test(String(vaultPath)))
      throw new Error(`Fields can only be written to Markdown files: ${vaultPath}`);
    const contents = await this.requireVault().readText(vaultPath);
    const { body } = parseFrontmatter(contents);
    const lines = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a === 'zorid.type' ? -1 : b === 'zorid.type' ? 1 : a.localeCompare(b)))
      .map(([key, value]) => `${key}: ${this.serializeFrontmatterValue(value)}`);
    await this.requireVault().writeText(vaultPath, `---\n${lines.join('\n')}\n---\n${body}`);
  }

  serializeFrontmatterValue(value: JsonValue): string {
    if (Array.isArray(value)) return `[${value.map((item) => String(item)).join(', ')}]`;
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    return String(value);
  }

  async readBase(vaultPath: VaultPath): Promise<BaseDto> {
    const diagnostics: string[] = [];
    let views: readonly ZbaseView[] = [];
    try {
      views = parseZbase(vaultPath, await this.requireVault().readText(vaultPath)).views;
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    return { path: vaultPath, name: path.basename(String(vaultPath), '.zbase'), views, diagnostics };
  }

  matchesZbaseFilters(fields: Readonly<Record<string, JsonValue>>, filters: ZbaseFilters | undefined): boolean {
    const expression = filters?.expression;
    if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return true;
    const equals = expression.equals;
    if (Array.isArray(equals) && equals.length === 2 && typeof equals[0] === 'string')
      return fields[equals[0]] === equals[1];
    return true;
  }

  groupRows(rows: readonly DataViewRowDto[], key: string): readonly DataViewGroupDto[] {
    const groups = new Map<string, DataViewRowDto[]>();
    for (const row of rows) {
      const group = String(row.fields[key] ?? '—');
      groups.set(group, [...(groups.get(group) ?? []), row]);
    }
    return [...groups.entries()].map(([groupKey, groupedRows]) => ({ key: groupKey, rows: groupedRows }));
  }

  async dispose(): Promise<void> {
    if (this.#indexUpdateTimer) {
      clearTimeout(this.#indexUpdateTimer);
      this.#indexUpdateTimer = undefined;
    }
    const cleanupTasks = [
      ...this.pluginHost
        .records()
        .filter((record) => record.status === 'active')
        .map((record) => () => this.pluginHost.deactivate(record.pluginId)),
      () => this.#indexWatcher?.dispose(),
      () => this.#vaultServiceRegistration?.dispose(),
      () => this.#indexServiceRegistration?.dispose(),
      () => this.#indexStore?.dispose(),
      () => this.kernel.disposables.dispose(),
    ];
    const cleanupResults = await Promise.allSettled(cleanupTasks.map((task) => Promise.resolve().then(task)));
    const failures = cleanupResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Desktop runtime disposal failed.',
      );
  }

  registerAppCommands(): void {
    this.kernel.disposables.use(
      this.kernel.commands.register({
        id: 'vault.open',
        title: 'Open Vault',
        callback: async () => ({ action: 'vault.open' }),
      }),
    );
    this.kernel.disposables.use(
      this.kernel.commands.register({
        id: 'command-palette.open',
        title: 'Command Palette: Open',
        callback: async () => ({ action: 'command-palette.open' }),
      }),
    );
    this.kernel.disposables.use(
      this.kernel.commands.register({
        id: 'settings.open',
        title: 'Settings: Open',
        callback: async () => {
          this.kernel.events.emit('settings:open', {});
          return { action: 'settings.open' };
        },
      }),
    );
  }

  registerStaticPlaceholders(manifests: readonly PluginManifest[]): void {
    for (const manifest of manifests) {
      const record = this.pluginHost.record(manifest.id);
      if (record?.status === 'disabled') continue;
      for (const command of manifest.contributes?.commands ?? []) {
        const disposable = this.kernel.commands.register({
          ...command,
          callback: async (args) => {
            this.#placeholderCommands.get(command.id)?.dispose();
            this.#placeholderCommands.delete(command.id);
            await this.pluginHost.activate(manifest.id, 'static-command', `onCommand:${command.id}`);
            return this.kernel.commands.execute(command.id, args);
          },
        });
        this.#placeholderCommands.set(command.id, disposable);
      }
    }
  }

  createPluginContext(manifest: PluginManifest, stack: DisposableStack): ZoridPluginContext {
    const registry = createPluginRegistryAPI(this.pluginHost);
    const registerDisposable = (disposable: Disposable | (() => void | Promise<void>)): Disposable => {
      const normalized = typeof disposable === 'function' ? { dispose: disposable } : disposable;
      return stack.use(normalized);
    };
    return {
      pluginId: asPluginId(manifest.id),
      app: this.kernel.app,
      vault: this.#activeVault ?? this.emptyVaultApi(),
      workspace: this.workspace,
      editor: this.editor,
      metadata: {} as ZoridPluginContext['metadata'],
      objects: {} as ZoridPluginContext['objects'],
      search: {} as ZoridPluginContext['search'],
      fields: {} as ZoridPluginContext['fields'],
      dataViews: {} as ZoridPluginContext['dataViews'],
      commands: this.kernel.commands,
      settings: this.kernel.settings,
      events: this.kernel.events,
      storage: { get: async () => undefined, set: async () => undefined },
      plugins: registry,
      register: {
        disposable: registerDisposable,
        command: (command: CommandContribution) => stack.use(this.kernel.commands.register(command)),
        setting: (schema: SettingsContribution) => stack.use(this.kernel.settings.register(schema)),
        view: (view) => stack.use(this.workspace.registerView(view)),
        fileRenderer: () => registerDisposable({ dispose: () => undefined }),
        viewRenderer: () => registerDisposable({ dispose: () => undefined }),
        statusItem: () => registerDisposable({ dispose: () => undefined }),
        editorExtension: (extension) => stack.use(this.editor.registerExtension(extension)),
        markdownProcessor: () => registerDisposable({ dispose: () => undefined }),
        event: registerDisposable,
        domEvent: (target, type, listener) => {
          target.addEventListener(type, listener);
          return registerDisposable(() => target.removeEventListener(type, listener));
        },
      },
      platform: {
        kind: 'desktop',
        hasCapability: (capability) => desktopCapabilities.includes(capability),
        listCapabilities: () => desktopCapabilities,
      },
    };
  }

  emptyVaultApi(): ZoridPluginContext['vault'] {
    const missing = () => Promise.reject(new Error('No vault is open.'));
    return {
      profile: { id: 'no-vault', kind: 'folder', rootLabel: 'No vault' },
      readText: missing,
      writeText: missing,
      list: missing,
      stat: missing,
      createFolder: missing,
      rename: missing,
      delete: missing,
      watch: () => ({ dispose: () => undefined }),
      read: missing,
      write: missing,
    };
  }
}

export function createDesktopRuntime(options: DesktopRuntimeOptions = {}): DesktopRuntime {
  return new DesktopRuntime(options);
}
