# Zorid v0 Package/API Design Draft

Status: architecture gate locked for v0 implementation; future shell UI replacement deferred  
Source spec: `.omx/specs/deep-interview-zorid-app.md`  
Planning gate: package boundaries, public Plugin API, and core Platform APIs must be approved before deep implementation.  
Revision: Architect ITERATE feedback applied — platform API type ownership, public/internal API split, capability normalization, omitted APIs, plugin-defined exports, data/index boundary, and desktop/mobile scope clarified; API metadata, capability-enforced contexts, and lazy-load observability added.

## 1. Design principles

1. **Canonical user data stays file-first.** Markdown, `.ztype`, and `.zbase` are durable vault data; SQLite/cache are derived and rebuildable.
2. **Kernel orchestrates, features attach.** The kernel owns lifecycle, services, events, commands, settings, capability metadata, and plugin host supervision; product features live in shell packages or core plugins.
3. **Core plugins dogfood public APIs.** v0 core plugins may use experimental APIs, but should not import shell internals or random private package internals.
4. **Vue is shell implementation, not plugin ABI.** Public plugin UI uses a framework-neutral DOM mount contract.
5. **Performance boundaries are architectural.** Large vault/index/editor data must stay in services/workers/CodeMirror, not deep Vue state.
6. **Tiered API contract.** Public Plugin API is minimal and capability-scoped; core-only APIs are explicitly experimental; DB/index/Electron internals stay private.

## 2. Proposed package boundaries

### Apps

| Path | Ownership | Responsibilities | May depend on |
|---|---|---|---|
| `apps/desktop` | Electron platform app | Main process, secure preload bridge, desktop renderer entry, folder vault access, native file watching, SQLite adapter wiring | shell packages, platform packages |
| `apps/mobile` | Capacitor skeleton | Mobile app entry, app-private vault adapters later, platform capability declaration | mobile shell, platform packages |

### Contracts/platform packages

| Package | Responsibilities | Public outputs |
|---|---|---|
| `packages/shared` | Result/errors, path helpers, IDs, clocks, disposables, common JSON types | `Result`, `ZoridError`, `Disposable`, `VaultPath`, `JsonValue` |
| `packages/platform-api` | **Contracts-only package** for public/core Platform API types consumed by `plugin-api`, shells, core plugins, and service implementations | `AppAPI`, `VaultAPI`, `WorkspaceAPI`, `EditorAPI`, `MetadataAPI`, `SearchAPI`, `ObjectStoreAPI`, `CommandsAPI`, `SettingsAPI`, `EventBusAPI`, `PluginStorageAPI`, `PluginRegistryAPI`, `PlatformAPI`, contribution types |
| `packages/plugin-api` | Public plugin manifest/context/define helper/capability types; imports API types from `platform-api` only | `ZoridPluginContext`, `defineZoridPlugin`, manifest schemas |

### Implementation packages

| Package | Responsibilities | Public outputs |
|---|---|---|
| `packages/app-kernel` | App bootstrap, lifecycle, service registry, event bus implementation, commands/settings implementations, platform capabilities, API metadata | `createZoridApp`, service implementations; no generic public service escape hatch |
| `packages/vault` | Vault profile, storage adapter, watcher abstraction, file ops, path normalization | `createVaultService` implementing `VaultAPI` |
| `packages/workspace` | Layout tree, panes/tabs, view registry, active file/view state | `createWorkspaceService` implementing `WorkspaceAPI` |
| `packages/editor` | CodeMirror wrapper, editor handles, document lifecycle, editor commands/extensions | `createEditorService` implementing `EditorAPI` |
| `packages/metadata` | Metadata/query/search facade over index records; field/filter helpers | `createMetadataService`, `createSearchService` |
| `packages/object-store` | `.zbase`/`.ztype` read-write/validate helpers and object IDs | `createObjectStoreService` implementing `ObjectStoreAPI` |
| `packages/db` | SQLite connection/migrations/schema, transaction helpers, platform DB adapter | **Internal** `DatabaseAPI`, `Migration`, `IndexStore`; not exposed to plugins |
| `packages/index-api` | Internal index engine contract and normalized records | **Internal/core-only** `IndexEngine`, `IndexFilesInput`, `IndexFilesOutput` |
| `packages/indexer-js` | JS reference implementation for Markdown/frontmatter/link/tag/type/base parsing | `JsIndexEngine` implementing internal `IndexEngine` |
| `packages/index-worker` | Worker batching, scheduling, incremental rebuild bridge | **Internal/core-only** `IndexScheduler`, `IndexWorkerClient` |
| `packages/plugin-host` | Manifest discovery, validation, dependency graph, lazy triggers, dynamic import adapter, lifecycle cleanup, plugin API exports | `PluginHost`, implementation of `PluginRegistryAPI` |
| `packages/sync` | Placeholder interfaces only for deferred sync/history scope | `SyncProvider` interface; no real sync engine first wave |

### Shell/UI packages

| Package | Responsibilities | Public outputs |
|---|---|---|
| `packages/ui-vue` | Tokens, common components, virtual lists/tables, menus/modals/notices/settings controls | Vue components/composables internal to first-party shell/core plugins |
| `packages/desktop-shell` | Desktop layout frame, activity rail, left sidebar, tabs/panes surface, command palette/settings/plugin manager/status bar containers | `DesktopShell`, shell composables |
| `packages/mobile-shell` | Compatible skeleton for one-main-surface navigation, sheets/gestures/haptics adapters later | `MobileShell` placeholder/skeleton |

### Core plugins

| Path | Responsibilities | Primary APIs used | v0 platforms |
|---|---|---|---|
| `plugins/core/file-explorer` | Folder tree, create/rename/move/delete/open files | Vault, Workspace, Commands, Events | desktop |
| `plugins/core/search` | Search panel/results/snippets/open-on-select | Search, Metadata, Workspace, Commands | desktop |
| `plugins/core/backlinks` | Inbound links/unresolved references for active note | Metadata, Workspace, Events | desktop |
| `plugins/core/outline` | Heading outline and editor navigation | Editor, Metadata, Workspace | desktop |
| `plugins/core/tags` | Tag list/count/navigation | Metadata, Search, Workspace | desktop |
| `plugins/core/status-bar` | Index/file/dirty/error placeholder status items | Events, Metadata, Editor, Workspace | desktop |
| `plugins/core/fields` | Typed field parsing UI + host-owned FieldsAPI proxy implementation | Metadata, ObjectStore | desktop |
| `plugins/core/data-views` | `.zbase` open/embed/render table/list + host-owned DataViewsAPI proxy implementation | ObjectStore, Metadata, FieldsAPI, Workspace, Editor, PluginRegistry | desktop |

Mobile skeleton may include placeholder manifests later, but first-wave core plugin manifests are desktop-only unless a specific plugin is proven compatible with `mobile.appPrivateVault`.

## 3. Import direction rules

```text
apps -> shell packages -> implementation packages -> platform-api/shared
shell packages -> ui-vue + platform-api + implementation package factories
plugins/core -> plugin-api + platform-api + optional declared plugin-defined exported APIs; FieldsAPI/DataViewsAPI remain host-owned ctx proxies
plugin-api -> platform-api + shared only
platform-api -> shared only
implementation packages -> platform-api + shared + explicitly lower-level internal packages
ui-vue -> platform-api/shared only; never implementation internals by default
```

Forbidden:
- Platform contracts importing implementation, shell, or Vue packages.
- Platform implementation packages importing shell packages or Vue components.
- Plugin API exposing Vue stores/components as required ABI.
- Core plugins importing another core plugin’s private source files.
- Renderer code receiving raw unrestricted Electron/Node APIs.
- Plugins receiving raw SQLite handles, `IndexStore`, `IndexEngine`, or `IndexScheduler` in v0.
- Public `AppAPI` exposing generic `getService()`.

## 4. API tiers

| Tier | Audience | Stability | Examples |
|---|---|---|---|
| Public Plugin API | bundled core plugins now, community plugins later | broad typed prealpha facade, versioned | `ZoridPluginContext`, `register.*`, `VaultAPI`, `WorkspaceAPI`, `EditorAPI`, `MetadataAPI`, `SearchAPI`, `ObjectStoreAPI`, `FieldsAPI`, `DataViewsAPI` |
| Public-prealpha experimental API | bundled core plugins now, community plugins later after alpha hardening | explicitly revisionable before alpha | `FieldsAPI`, `DataViewsAPI`, future `UIAPI` preview surfaces |
| Internal implementation API | app services only | private | `DatabaseAPI`, `IndexStore`, `IndexEngine`, Electron IPC channels, raw fs/sqlite handles |

## 5. Public Plugin API draft

### 5.1 Entry point

```ts
export function defineZoridPlugin(plugin: ZoridPlugin): ZoridPlugin;

export interface ZoridPlugin {
  activate(ctx: ZoridPluginContext): void | Promise<void>;
  deactivate?(ctx: ZoridPluginContext): void | Promise<void>;
}
```

### 5.2 Context

```ts
export interface ZoridPluginContext {
  app: AppAPI;
  vault: VaultAPI;
  workspace: WorkspaceAPI;
  editor: EditorAPI;
  metadata: MetadataAPI;
  objects: ObjectStoreAPI;
  search: SearchAPI;
  /** Public-prealpha experimental; capability-gated and revisionable before alpha. */
  fields: FieldsAPI;
  /** Public-prealpha experimental; capability-gated and revisionable before alpha. */
  dataViews: DataViewsAPI;
  commands: CommandsAPI;
  settings: SettingsAPI;
  events: EventBusAPI;
  storage: PluginStorageAPI;
  plugins: PluginRegistryAPI;
  register: PluginRegistrationAPI;
  platform: PlatformAPI;
}
```

### 5.3 App API: no generic service escape hatch

```ts
export interface AppAPI {
  readonly version: string;
  readonly apiLevel: number;
  apiInfo(): ApiInfo;
}
```

If core internals later need service access, use an internal `CorePluginContext` in `plugin-host`, not the public `ZoridPluginContext`.

### 5.4 Registration/disposables

```ts
export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface PluginRegistrationAPI {
  disposable(disposable: Disposable | (() => void | Promise<void>)): Disposable;
  command(command: CommandContribution): Disposable;
  setting(schema: SettingsContribution): Disposable;
  view(view: ViewContribution): Disposable;
  viewRenderer(renderer: ViewRendererContribution): Disposable;
  statusItem(item: StatusItemContribution): Disposable;
  editorExtension(extension: EditorExtensionContribution): Disposable;
  markdownProcessor(processor: MarkdownProcessorContribution): Disposable;
  event(disposable: Disposable): Disposable;
  domEvent<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void): Disposable;
  interval(id: number): Disposable;
}
```

### 5.5 Commands/settings/events/storage/plugins/platform

```ts
export interface CommandsAPI {
  list(): CommandContribution[];
  get(id: string): CommandContribution | undefined;
  execute(id: string, input?: unknown): Promise<unknown>;
}

export interface SettingsAPI {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  getSection(pluginId: string): Promise<Record<string, unknown>>;
}

export interface EventBusAPI {
  on<T = unknown>(event: string, listener: (payload: T) => void): Disposable;
  once<T = unknown>(event: string, listener: (payload: T) => void): Disposable;
  /** v0 bundled/core plugins may emit namespaced events they own, e.g. "zorid.core.search:query". Community plugin event emission needs stricter namespace/capability rules later. */
  emit<T = unknown>(event: string, payload: T): void;
}

export interface PluginStorageAPI {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
}

export interface PluginRegistryAPI {
  getManifest(pluginId: string): ZoridPluginManifest | undefined;
  isActive(pluginId: string): boolean;
  activate(pluginId: string): Promise<void>;
  /** Only returns declared plugin exports from manifest-declared dependencies/optional dependencies; never returns internal app services. */
  getApi<T = unknown>(pluginId: string): Promise<T | undefined>;
}

export interface PlatformAPI {
  readonly kind: 'desktop' | 'mobile';
  hasCapability(capability: CapabilityId): boolean;
  listCapabilities(): CapabilityId[];
}
```

### 5.6 Plugin UI mount contract

```ts
export interface ViewRendererContribution<Props = unknown> {
  type: string;
  mount(container: HTMLElement, props: Props, ctx: ZoridPluginContext): void | Disposable | (() => void) | Promise<void | Disposable | (() => void)>;
}

export interface ViewContribution<Input = unknown> {
  id: string;
  title: string;
  icon?: string;
  mount(container: HTMLElement, input: Input, ctx: ZoridPluginContext): PluginViewInstance | Promise<PluginViewInstance>;
}

export interface PluginViewInstance {
  update?(input: unknown): void;
  focus?(): void;
  unmount(): void | Promise<void>;
}
```

### 5.7 Manifest shape

```ts
export interface ZoridPluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  kind: 'core' | 'community';
  entry: string;
  zoridApi: string;
  platforms: Array<'desktop' | 'mobile'>;
  capabilities: {
    required?: CapabilityId[];
    optional?: CapabilityId[];
  };
  dependsOn?: Record<string, string>;
  optionalDependsOn?: Record<string, string>;
  activation?: ActivationTrigger[];
  contributes?: StaticContributions;
}
```

Normalized initial capability IDs, aligned with `Plan/Architecture/Plugin Manifest.md`:
```text
vault.read
vault.write
vault.write.markdown
vault.write.zbase
vault.write.ztype
metadata.read
workspace.views
workspace.navigation
editor.read
editor.write
commands.register
settings.register
status.register
platform.haptics
desktop.folderVault
mobile.appPrivateVault
nativeFs.watch
```

Rules:
- `vault.write` implies all narrower vault write capabilities only for trusted core plugins in v0; community plugins later should request narrower capabilities.
- Registration methods should check corresponding registration capability in v0 diagnostics, even if enforcement is initially soft for bundled core plugins.
- Missing required capabilities disable or hide the plugin on that platform.

## 6. Core Platform API draft

### 6.1 Vault

```ts
export interface VaultAPI {
  readonly profile: VaultProfile;
  readText(path: VaultPath): Promise<string>;
  writeText(path: VaultPath, content: string): Promise<void>;
  list(path?: VaultPath): Promise<VaultEntry[]>;
  stat(path: VaultPath): Promise<VaultStat | null>;
  createFolder(path: VaultPath): Promise<void>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  delete(path: VaultPath): Promise<void>;
  watch(listener: (event: VaultChangeEvent) => void): Disposable;
}
```

### 6.2 Workspace

```ts
export interface WorkspaceAPI {
  openFile(path: VaultPath, options?: OpenFileOptions): Promise<PaneId>;
  openView(type: string, input?: unknown, options?: OpenViewOptions): Promise<PaneId>;
  splitPane(paneId: PaneId, direction: 'left' | 'right' | 'up' | 'down'): Promise<PaneId>;
  closePane(paneId: PaneId): Promise<void>;
  getSnapshot(): WorkspaceSnapshot;
  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): Disposable;
  registerView(contribution: ViewContribution): Disposable;
}
```

### 6.3 Editor

```ts
export interface EditorAPI {
  openDocument(path: VaultPath, options?: OpenDocumentOptions): Promise<EditorHandle>;
  getActiveEditor(): EditorHandle | null;
  registerExtension(extension: EditorExtensionContribution): Disposable;
  registerCommand(command: EditorCommandContribution): Disposable;
}

export interface EditorHandle {
  readonly id: string;
  readonly path: VaultPath;
  getText(): string;
  dispatch(change: EditorChange): void;
  save(): Promise<void>;
  focus(): void;
  onUpdate(listener: (event: EditorUpdateEvent) => void): Disposable;
  dispose(): void | Promise<void>;
}
```

### 6.4 Metadata/search/objects

```ts
export interface MetadataAPI {
  getFileRecord(path: VaultPath): Promise<FileRecord | null>;
  getFields(path: VaultPath): Promise<FieldRecord[]>;
  getBacklinks(path: VaultPath): Promise<LinkRecord[]>;
  getOutline(path: VaultPath): Promise<HeadingRecord[]>;
  getTags(): Promise<TagSummary[]>;
  queryFiles(filter: FilterAst, options?: QueryOptions): Promise<FileRecord[]>;
  subscribe(listener: (event: MetadataEvent) => void): Disposable;
}

export interface SearchAPI {
  searchText(query: string, options?: SearchOptions): Promise<SearchResultPage>;
}

export interface ObjectStoreAPI {
  readZbase(path: VaultPath): Promise<ZbaseDocument>;
  writeZbase(path: VaultPath, doc: ZbaseDocument): Promise<void>;
  readZtype(path: VaultPath): Promise<ZtypeDocument>;
  writeZtype(path: VaultPath, doc: ZtypeDocument): Promise<void>;
  validateZbase(doc: unknown): ZbaseValidationResult;
  validateZtype(doc: unknown): ZtypeValidationResult;
}
```

## 7. Public-prealpha structured-data APIs

Fields/DataViews source-of-truth rule: `FieldsAPI` and `DataViewsAPI` are host-owned proxy APIs exposed directly on `ZoridPluginContext`. The underlying implementation may be provided by bundled core plugins internally, but public consumers must treat `ctx.fields` and `ctx.dataViews` as the canonical access path. Plugin export lookup is reserved for optional future plugin-defined APIs.

## 7. Public-prealpha structured-data API contracts

These are public-prealpha experimental host-owned proxy APIs in v0. They are included in API metadata as `public-experimental`, capability-gated, and explicitly revisionable before alpha. Public plugins access them directly from the broad typed plugin facade as `ctx.fields` and `ctx.dataViews`. `ctx.plugins.getApi<T>()` remains available only for future plugin-declared exports and must not be the source of truth for these platform-owned proxies.

### 7.1 FieldsAPI

```ts
export interface FieldsAPI {
  getType(typeId: string): Promise<ZtypeDocument | null>;
  listTypes(): Promise<ZtypeSummary[]>;
  getFields(path: VaultPath): Promise<FieldRecord[]>;
  updateField(path: VaultPath, key: string, value: JsonValue): Promise<void>;
  setType(path: VaultPath, typeId: string | null): Promise<void>;
  inferFieldValue(value: unknown): InferredFieldValue;
}
```

### 7.2 DataViewsAPI

```ts
export interface DataViewsAPI {
  registerRenderer(renderer: ViewRendererContribution<DataViewRenderProps>): Disposable;
  evaluateFilters(filters: ZbaseFilters, options?: QueryOptions): Promise<FileRecord[]>;
  openBase(path: VaultPath, options?: OpenBaseOptions): Promise<PaneId>;
  renderEmbed(container: HTMLElement, path: VaultPath, ctx: ZoridPluginContext): Promise<Disposable>;
}
```


## 8. API metadata contract

Zorid adopts a Neovim-inspired API metadata contract so plugins and future external tools can reason about compatibility without importing private implementation details. `AppAPI.apiInfo()` is the canonical runtime source of truth.

```ts
export interface ApiInfo {
  readonly appVersion: string;
  readonly apiLevel: number;
  /** Lowest API level this runtime remains backward compatible with. */
  readonly apiCompatible: number;
  /** True while the current API level may still change before a stable release. */
  readonly apiPrerelease: boolean;
  readonly namespaces: Record<ApiNamespaceId, ApiNamespaceInfo>;
  readonly functions: ApiFunctionInfo[];
  readonly capabilities: CapabilityInfo[];
}

export type ApiNamespaceId =
  | 'app'
  | 'vault'
  | 'workspace'
  | 'editor'
  | 'metadata'
  | 'search'
  | 'objects'
  | 'commands'
  | 'settings'
  | 'events'
  | 'storage'
  | 'plugins'
  | 'platform'
  | 'fields'
  | 'dataViews';

export interface ApiNamespaceInfo {
  readonly version: string;
  readonly stability: 'public' | 'public-experimental' | 'core-experimental' | 'internal';
  readonly experimental?: boolean;
}

export interface ApiFunctionInfo {
  readonly namespace: ApiNamespaceId;
  readonly name: string;
  readonly since: number;
  readonly deprecatedSince?: number;
  readonly stability: 'public' | 'public-experimental' | 'core-experimental' | 'internal';
  readonly requiredCapabilities?: CapabilityId[];
}

export interface CapabilityInfo {
  readonly id: CapabilityId;
  readonly since: number;
  readonly description: string;
  readonly stability: 'public' | 'public-experimental' | 'core-experimental';
}
```

Rules:
- Public APIs must declare `since`; removals require `deprecatedSince` first.
- New optional methods/fields may be added within a compatibility level.
- Breaking changes require an API level bump and an ADR.
- Public-prealpha APIs such as `FieldsAPI` and `DataViewsAPI` must be marked `public-experimental` until stabilized or revised before alpha.
- The generated docs and runtime `apiInfo()` fixture must be tested for consistency.

## 9. Capability-enforced plugin context

Capabilities are not just manifest annotations. The plugin host must construct a permission-shaped `ZoridPluginContext` from the validated manifest and platform capability registry.

```ts
export interface PluginCapabilityError extends ZoridError {
  code: 'plugin.capability.missing';
  pluginId: string;
  capability: CapabilityId;
  api: string;
}

export interface CapabilityPolicy {
  mode: 'diagnostic' | 'enforce';
  has(pluginId: string, capability: CapabilityId): boolean;
  require(pluginId: string, capability: CapabilityId, api: string): void;
}
```

Context construction rules:
- Missing required capabilities disable or hide the plugin before activation.
- Missing optional capabilities keep the plugin loadable, but related methods must either be absent from optional helper surfaces or throw a structured `PluginCapabilityError`.
- v0 trusted core plugins may run in `diagnostic` mode, but the host API shape must be compatible with later strict `enforce` mode.
- Registration methods must check their matching capability: `commands.register`, `settings.register`, `status.register`, `workspace.views`, `editor.write`, and vault write variants.
- `vault.write` may imply narrower write capabilities only for trusted core plugins in v0; future community plugins should request narrower capabilities.
- Capability failures are surfaced in the plugin manager/devtools and are included in plugin load records.

## 10. Lazy-load observability and plugin devtools contract

The plugin host must expose lazy-loading state from day one. This is the Zorid equivalent of lazy.nvim-style startup/load visibility, scoped to v0 core plugins and future third-party readiness.

```ts
export type PluginRuntimeStatus =
  | 'discovered'
  | 'placeholder'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disabled';

export type PluginActivationReason =
  | 'startup'
  | 'command'
  | 'view'
  | 'fileExtension'
  | 'markdownEmbed'
  | 'workspaceEvent'
  | 'dependency'
  | 'manual';

export interface PluginLoadRecord {
  readonly pluginId: string;
  readonly status: PluginRuntimeStatus;
  readonly reason?: PluginActivationReason;
  readonly trigger?: string;
  readonly requestedBy?: string;
  readonly startedAt?: number;
  readonly activatedAt?: number;
  readonly durationMs?: number;
  readonly dependenciesLoaded?: string[];
  readonly capabilitiesMissing?: CapabilityId[];
  readonly error?: PluginDiagnostic;
}

export interface PluginRegistryAPI {
  getManifest(pluginId: string): ZoridPluginManifest | undefined;
  isActive(pluginId: string): boolean;
  activate(pluginId: string): Promise<void>;
  /** Only returns declared plugin exports from manifest-declared dependencies/optional dependencies; never returns internal app services. */
  getApi<T = unknown>(pluginId: string): Promise<T | undefined>;
  getStatus(pluginId: string): PluginLoadRecord | undefined;
  listStatuses(): PluginLoadRecord[];
}
```

Required host events:
- `plugin:placeholder-registered`
- `plugin:load-started`
- `plugin:loaded`
- `plugin:failed`
- `plugin:disabled`
- `plugin:unloaded`

Required first-wave UI/devtools surfaces:
- Plugin manager shows status, platform compatibility, missing capabilities, activation reason, and last error.
- A lightweight plugin diagnostics panel can list load records sorted by duration/status.
- Tests cover placeholder registration, trigger replay, dependency-triggered activation, failed activation diagnostics, and status updates.


Caller identity rule: `DataViewsAPI.renderEmbed` must derive caller plugin identity from the host-created `ZoridPluginContext`; plugin-supplied IDs never grant authority. Diagnostics may include the caller ID, but authorization always comes from the invoking context and capability policy.

## 11. Public API capability matrix

Required manifest capabilities are hard-gated before runtime import. If a plugin lacks a required capability for the current platform, the plugin is disabled or hidden before activation. Trusted bundled core plugins may still run method-wrapper checks in diagnostic mode during v0, but the host must be strict-enforcement-compatible. Optional capability use records structured diagnostics instead of crashing.

| API namespace / method family | Required capability | Enforcement in v0 | Notes |
|---|---|---|---|
| `VaultAPI.readText/list/stat/watch` | `vault.read` | hard gate + wrapper check | `watch` also requires `nativeFs.watch` on desktop folder vaults. |
| `VaultAPI.writeText/createFolder/rename/delete` | `vault.write` or narrower write capability | hard gate + wrapper check | Prefer `vault.write.markdown`, `vault.write.zbase`, `vault.write.ztype` for future community plugins. |
| `WorkspaceAPI.openView/registerView` | `workspace.views` | hard gate + wrapper check | Split/open file navigation also requires `workspace.navigation` where applicable. |
| `WorkspaceAPI.openFile/splitPane/closePane` | `workspace.navigation` | hard gate + wrapper check | v0 core plugins use desktop workspace only. |
| `EditorAPI.getActiveEditor/openDocument` | `editor.read` | wrapper check | `openDocument` may also require vault read. |
| `EditorAPI.registerExtension/registerCommand` | `editor.write` | wrapper check | Editor mutations stay outside Vue state. |
| `MetadataAPI` / `SearchAPI` reads | `metadata.read` | hard gate + wrapper check | No raw SQL/index access. |
| `ObjectStoreAPI.readZbase/readZtype/validate*` | `vault.read` | wrapper check | Validation is safe; reads require vault access. |
| `ObjectStoreAPI.writeZbase/writeZtype` | `vault.write.zbase` / `vault.write.ztype` | hard gate + wrapper check | `vault.write` may imply narrower writes for trusted core plugins only. |
| `CommandsAPI.execute/list/get` | none for reads; command-specific checks later | diagnostic | `ctx.register.command` requires `commands.register`. |
| `PluginRegistrationAPI.command` | `commands.register` | hard gate + wrapper check | Contribution removed on unload. |
| `PluginRegistrationAPI.setting` | `settings.register` | hard gate + wrapper check | Settings schemas are lifecycle-owned. |
| `PluginRegistrationAPI.statusItem` | `status.register` | hard gate + wrapper check | Richer status placement deferred. |
| `FieldsAPI` reads/inference | `metadata.read` | public-experimental wrapper check | Public-prealpha; docs/API metadata must mark experimental. |
| `FieldsAPI.updateField/setType` | `vault.write.markdown` and `vault.write.ztype` when type files change | public-experimental wrapper check | Must preserve undeclared/ad-hoc fields. |
| `DataViewsAPI.evaluateFilters/openBase/renderEmbed` | `metadata.read`, `workspace.views`, `vault.read` | public-experimental wrapper check | `renderEmbed` uses caller plugin identity to avoid cross-plugin privilege confusion. |
| `DataViewsAPI.registerRenderer` | future renderer capability; v0 trusted core diagnostic | public-experimental diagnostic | Third-party renderer capability deferred until plugin-power track. |

## 12. Data/index boundary

Public/core plugins may use:
- `MetadataAPI` for indexed file metadata, fields, backlinks, outline, tags, and filter queries.
- `SearchAPI` for full-text and ranked search.
- `ObjectStoreAPI` for canonical `.zbase`/`.ztype` file parsing, validation, and writes.
- `FieldsAPI`/`DataViewsAPI` through host-owned `ctx.fields` and `ctx.dataViews` public-prealpha proxies; public consumers must not depend on core-plugin export lookup for these APIs.

Public/core plugins may not use:
- raw SQLite connections;
- `DatabaseAPI` / `IndexStore`;
- `IndexEngine` / `IndexScheduler` / worker protocol internals;
- raw Electron IPC, `fs`, or Node handles from renderer/plugin code.

## 13. Desktop/mobile scope

- First-wave core plugin manifests should declare `platforms: ["desktop"]` unless a plugin is explicitly implemented/tested with the mobile skeleton.
- `apps/mobile` and `packages/mobile-shell` exist to preserve architecture compatibility, not to run full core plugin UI parity.
- Mobile-compatible manifests require `mobile.appPrivateVault` and mobile-specific acceptance tests.

## 14. Approval questions for user review

Locked v0 decisions:
1. Introduce `packages/platform-api` as the contracts-only API type owner.
2. Use an ergonomic, broad, typed `ZoridPluginContext` facade for public plugin DX.
3. Keep public `AppAPI` metadata-only; do not expose a generic public `getService()` service locator.
4. Reserve private `CorePluginContext` only for bundled core implementation pressure if unavoidable and documented as technical debt.
5. Use normalized capability IDs from `Plugin Manifest.md` exactly as listed here.
6. Treat `FieldsAPI` and `DataViewsAPI` as public-prealpha experimental APIs in v0.
7. Mark first-wave core plugin manifests desktop-only unless explicitly mobile-tested.
8. Defer Neovim-level shell UI replacement to `docs/product/v1-features/plugin-power-and-shell-ui-extensibility.md`.


Promotion constraint: when this draft is promoted into `docs/architecture/`, preserve the “desktop-only unless mobile-tested” and “no public `getService()`” constraints verbatim.

## 15. External-doc constraints checked during planning

- Vue official docs confirm Vue packages are TypeScript-first and recommend Vite-powered TypeScript project setup with `vue-tsc` for command-line type checking.
- Vite official docs for v8 require Node.js 20.19+ or 22.12+ and support Vue/TypeScript templates and monorepo use.
- Electron official docs recommend context isolation and safe `contextBridge` exposure, not exposing raw IPC directly.
- pnpm official docs require a root `pnpm-workspace.yaml` for workspaces and support `workspace:` dependencies.
- CodeMirror advertises modular public APIs, extension interface, Markdown language support, and large-document responsiveness.
- Capacitor positions itself as a cross-platform native runtime and supports native filesystem/plugin access, matching the deferred mobile skeleton plan.


## 16. Deferred plugin-power track

Zorid should eventually support Neovim-level plugin UI power through official Shell/UI extension points rather than raw shell internals. The future feature plan is `docs/product/v1-features/plugin-power-and-shell-ui-extensibility.md`.
