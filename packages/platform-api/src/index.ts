import type { Disposable, JsonValue, PluginId, Result, VaultPath } from '@zorid/shared';

export type ApiStability = 'public' | 'public-experimental' | 'core-experimental' | 'internal';
export type PlatformKind = 'desktop' | 'mobile';

export type CapabilityName =
  | 'vault.read'
  | 'vault.write'
  | 'vault.write.markdown'
  | 'vault.write.zbase'
  | 'vault.write.ztype'
  | 'metadata.read'
  | 'workspace.views'
  | 'workspace.navigation'
  | 'workspace.fileRenderers'
  | 'editor.read'
  | 'editor.write'
  | 'commands.register'
  | 'settings.register'
  | 'status.register'
  | 'platform.haptics'
  | 'desktop.folderVault'
  | 'mobile.appPrivateVault'
  | 'nativeFs.watch';

export interface ApiFunctionInfo {
  readonly since: string;
  readonly stability: ApiStability;
  readonly deprecatedSince?: string;
  readonly capabilities?: readonly CapabilityName[];
}

export interface ApiNamespaceInfo {
  readonly version: string;
  readonly stability: ApiStability;
  readonly experimental?: boolean;
  readonly functions: Readonly<Record<string, ApiFunctionInfo>>;
}

export interface CapabilityInfo {
  readonly id: CapabilityName;
  readonly since: string;
  readonly stability: ApiStability;
  readonly description: string;
}

export interface ApiInfo {
  readonly apiLevel: number;
  readonly compatibleApiLevel: number;
  readonly apiPrerelease: boolean;
  readonly namespaces: Readonly<Record<string, ApiNamespaceInfo>>;
  readonly capabilities: readonly CapabilityInfo[];
}

export interface AppAPI {
  readonly version: string;
  readonly apiLevel: number;
  apiInfo(): ApiInfo;
}

export interface VaultProfile {
  readonly id: string;
  readonly kind: 'folder' | 'app-private';
  readonly rootLabel: string;
}
export interface VaultFileStat {
  readonly path: VaultPath;
  readonly kind: 'file' | 'directory';
  readonly mtimeMs: number;
  readonly size: number;
}
export type VaultEntry = VaultFileStat;
export type VaultStat = VaultFileStat;

export interface VaultAPI {
  readonly profile: VaultProfile;
  readText(path: VaultPath): Promise<string>;
  writeText(path: VaultPath, content: string): Promise<void>;
  list(path?: VaultPath): Promise<readonly VaultEntry[]>;
  stat(path: VaultPath): Promise<VaultStat | null>;
  createFolder(path: VaultPath): Promise<void>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  delete(path: VaultPath): Promise<void>;
  watch(listener: (event: VaultChangeEvent) => void): Disposable;
  watch(path: VaultPath, callback: (event: VaultChangeEvent) => void): Disposable;
  /** Backward-compatible v0 alias; public docs prefer readText. */
  read(path: VaultPath): Promise<string>;
  /** Backward-compatible v0 alias; public docs prefer writeText. */
  write(path: VaultPath, contents: string): Promise<void>;
}

export interface VaultChangeEvent {
  readonly path: VaultPath;
  readonly type: 'created' | 'changed' | 'deleted' | 'renamed';
}

export type PaneId = string;
export interface WorkspacePaneSnapshot {
  readonly id: PaneId;
  readonly items: readonly JsonValue[];
  readonly activeItemId?: string;
}
export interface WorkspaceSnapshot {
  readonly panes: readonly WorkspacePaneSnapshot[];
  readonly activePaneId: PaneId;
}
export interface WorkspaceAPI {
  openFile(path: VaultPath, options?: OpenFileOptions): Promise<PaneId>;
  openView(type: string, input?: unknown, options?: OpenViewOptions): Promise<PaneId>;
  openView(view: ViewContribution, options?: OpenViewOptions): Promise<PaneId>;
  splitPane(paneId: PaneId, direction: 'left' | 'right' | 'up' | 'down'): Promise<PaneId>;
  closePane(paneId: PaneId): Promise<void>;
  getSnapshot(): WorkspaceSnapshot;
  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): Disposable;
  registerView(contribution: ViewContribution): Disposable;
  /** Backward-compatible v0 convenience for current core plugins. */
  activeFile(): VaultPath | undefined;
  /** Backward-compatible v0 alias; public docs prefer splitPane. */
  split(direction: 'horizontal' | 'vertical'): Promise<PaneId>;
}

export interface OpenFileOptions {
  readonly paneId?: string;
  readonly preview?: boolean;
}
export interface OpenViewOptions {
  readonly paneId?: string;
  readonly focus?: boolean;
}

export interface EditorAPI {
  openDocument(path: VaultPath, options?: OpenDocumentOptions): Promise<EditorHandle>;
  getActiveEditor(): EditorHandle | null;
  registerExtension(extension: EditorExtensionContribution): Disposable;
  registerCommand(command: EditorCommandContribution): Disposable;
  /** Backward-compatible v0 alias; public docs prefer getActiveEditor. */
  activeEditor(): EditorHandle | undefined;
  /** Backward-compatible v0 alias; public docs prefer openDocument. */
  open(path: VaultPath): Promise<EditorHandle>;
  /** Backward-compatible v0 helper; public docs prefer EditorHandle.save. */
  save(handle: EditorHandle): Promise<void>;
}

export interface OpenDocumentOptions {
  readonly paneId?: PaneId;
}
export interface EditorChange {
  readonly from?: number;
  readonly to?: number;
  readonly insert: string;
}
export interface EditorUpdateEvent {
  readonly text: string;
  readonly dirty: boolean;
}
export interface EditorCommandContribution {
  readonly id: string;
  readonly title: string;
  readonly run: (editor: EditorHandle) => void | Promise<void>;
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
  /** Backward-compatible v0 helper; public docs prefer dispatch. */
  setText(value: string): void;
  isDirty(): boolean;
}

export interface MetadataAPI {
  getFile(path: VaultPath): Promise<FileMetadata | undefined>;
  backlinks(path: VaultPath): Promise<readonly LinkRecord[]>;
  tags(): Promise<readonly TagRecord[]>;
}

export interface SearchAPI {
  search(query: string, options?: SearchOptions): Promise<readonly SearchResult[]>;
}

export interface ObjectStoreAPI {
  readType(path: VaultPath): Promise<ZtypeDocument>;
  readBase(path: VaultPath): Promise<ZbaseDocument>;
  writeObject(path: VaultPath, value: JsonValue): Promise<Result<void>>;
}

export interface FieldsAPI {
  getFields(path: VaultPath): Promise<readonly FieldValue[]>;
  getType(path: VaultPath): Promise<ZtypeDocument | undefined>;
  updateField(path: VaultPath, key: string, value: JsonValue): Promise<void>;
  setType(path: VaultPath, typePath: VaultPath | undefined): Promise<void>;
}

export interface DataViewsAPI {
  registerRenderer(renderer: DataViewRenderer): Disposable;
  evaluateFilters(filters: ZbaseFilters): Promise<readonly FileRecord[]>;
  openBase(path: VaultPath): Promise<void>;
  renderEmbed(container: HTMLElement, path: VaultPath, options?: DataViewRenderOptions): Promise<Disposable>;
}

export interface CommandsAPI {
  register(command: CommandContribution): Disposable;
  execute(id: string, args?: JsonValue): Promise<unknown>;
  list(): readonly CommandContribution[];
}

export interface SettingsAPI {
  register(section: SettingsContribution): Disposable;
}
export interface EventBusAPI {
  on<T = unknown>(event: string, listener: (payload: T) => void): Disposable;
  emit<T = unknown>(event: string, payload: T): void;
}
export interface PluginStorageAPI {
  get<T extends JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
}
export interface CapabilityDiagnosticInfo {
  readonly code: 'plugin.capability.missing' | 'plugin.capability.undeclared';
  readonly capability: CapabilityName;
  readonly pluginId: string;
}
export interface PluginStatus {
  readonly pluginId: string;
  readonly status: 'discovered' | 'placeholder' | 'loading' | 'active' | 'failed' | 'disabled';
  readonly platformCompatible: boolean;
  readonly discoveredAtMs?: number;
  readonly activationRequestedAtMs?: number;
  readonly loadedAtMs?: number;
  readonly dependenciesLoaded: readonly string[];
  readonly activationReason?: string;
  readonly trigger?: string;
  readonly dependencyChain: readonly string[];
  readonly missingCapabilities: readonly CapabilityName[];
  readonly capabilityDiagnostics: readonly CapabilityDiagnosticInfo[];
  readonly lastError?: string;
  readonly durationMs?: number;
}
export interface PluginRegistryAPI {
  getApi<T = unknown>(pluginId: string): Promise<T | undefined>;
  isActive(pluginId: string): boolean;
  getStatus(pluginId: string): PluginStatus | undefined;
  listStatuses(): readonly PluginStatus[];
  activate(pluginId: string): Promise<void>;
}
export interface PlatformAPI {
  readonly kind: PlatformKind;
  hasCapability(capability: CapabilityName): boolean;
  listCapabilities(): readonly CapabilityName[];
}

export interface PluginRegistrationAPI {
  disposable(disposable: Disposable | (() => void | Promise<void>)): Disposable;
  command(command: CommandContribution): Disposable;
  setting(schema: SettingsContribution): Disposable;
  view(view: ViewContribution): Disposable;
  fileRenderer(renderer: FileRendererContribution): Disposable;
  viewRenderer(renderer: ViewRendererContribution): Disposable;
  statusItem(item: StatusItemContribution): Disposable;
  editorExtension(extension: EditorExtensionContribution): Disposable;
  markdownProcessor(processor: MarkdownProcessorContribution): Disposable;
  event(disposable: Disposable): Disposable;
  domEvent<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): Disposable;
}

export interface DomPluginMountContext {
  readonly pluginId: PluginId;
  readonly root: HTMLElement;
  readonly dispose: (disposable: Disposable | (() => void | Promise<void>)) => void;
}
export interface DomPluginView {
  mount(ctx: DomPluginMountContext): void | Promise<void>;
  unmount?(): void | Promise<void>;
}
export interface ViewRendererContribution {
  readonly type: string;
  render(container: HTMLElement, input: JsonValue): Disposable | Promise<Disposable>;
}
export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly callback?: (args?: JsonValue) => unknown | Promise<unknown>;
}
export interface SettingsContribution {
  readonly id: string;
  readonly title: string;
  readonly schema: JsonValue;
}
export interface ViewContribution {
  readonly id: string;
  readonly title: string;
  readonly view: DomPluginView;
}
export type FileRendererSurface = 'full-page' | 'markdown-embed';
export interface FileRendererMountContext {
  readonly pluginId: PluginId;
  readonly rendererId: string;
  readonly surface: FileRendererSurface;
  readonly root: HTMLElement;
  readonly path: VaultPath;
  readonly fragment?: string;
  readonly readText: () => Promise<string>;
  readonly dispose: (disposable: Disposable | (() => void | Promise<void>)) => void;
}
export interface FileRendererContribution {
  readonly id: string;
  readonly title: string;
  readonly mount: (ctx: FileRendererMountContext) => void | Promise<void>;
  readonly dispose?: () => void | Promise<void>;
}
export interface StatusItemContribution {
  readonly id: string;
  readonly priority?: number;
  readonly render: (container: HTMLElement) => Disposable | void;
}
export interface EditorExtensionContribution {
  readonly id: string;
  readonly extension: unknown;
}
export interface MarkdownProcessorContribution {
  readonly id: string;
  readonly process: (container: HTMLElement, source: string) => Disposable | void | Promise<Disposable | void>;
}

export interface FileMetadata {
  readonly path: VaultPath;
  readonly frontmatter: Readonly<Record<string, JsonValue>>;
  readonly headings: readonly string[];
  readonly tags: readonly string[];
}
export interface LinkRecord {
  readonly from: VaultPath;
  readonly to: VaultPath;
  readonly unresolved?: boolean;
}
export interface TagRecord {
  readonly tag: string;
  readonly count: number;
}
export interface SearchOptions {
  readonly limit?: number;
}
export interface SearchResult {
  readonly path: VaultPath;
  readonly score: number;
  readonly snippet: string;
}
export interface FieldValue {
  readonly key: string;
  readonly value: JsonValue;
  readonly source: 'frontmatter' | 'type-default' | 'inferred';
}
export interface FileRecord {
  readonly path: VaultPath;
  readonly fields: readonly FieldValue[];
}
export interface ZtypeDocument {
  readonly path: VaultPath;
  readonly fields: readonly ZtypeField[];
}
export interface ZtypeField {
  readonly key: string;
  readonly type: 'string' | 'int' | 'float' | 'boolean' | 'date' | 'datetime' | 'list' | 'multiselect';
  readonly required?: boolean;
  readonly default?: JsonValue;
}
export interface ZbaseDocument {
  readonly path: VaultPath;
  readonly views: readonly ZbaseView[];
}
export interface ZbaseView {
  readonly id: string;
  readonly renderer: string;
  readonly filters?: ZbaseFilters;
}
export interface ZbaseFilters {
  readonly expression: JsonValue;
}
export interface DataViewRenderer {
  readonly type: string;
  render(
    container: HTMLElement,
    records: readonly FileRecord[],
    ctx: DataViewRenderContext,
  ): Disposable | Promise<Disposable>;
}
export interface DataViewRenderOptions {
  readonly basePath?: VaultPath;
}
export interface DataViewRenderContext {
  readonly basePath: VaultPath /** Host-derived caller identity; plugin callers never supply this value. */;
  readonly callerPluginId: PluginId;
}

export const capabilityInfos = [
  {
    id: 'vault.read',
    since: '0.1.0',
    stability: 'public',
    description: 'Read files and directories from the active vault.',
  },
  {
    id: 'vault.write',
    since: '0.1.0',
    stability: 'public',
    description: 'Write generic files inside the active vault.',
  },
  {
    id: 'vault.write.markdown',
    since: '0.1.0',
    stability: 'public',
    description: 'Write Markdown files inside the active vault.',
  },
  {
    id: 'vault.write.zbase',
    since: '0.1.0',
    stability: 'public-experimental',
    description: 'Write Zorid .zbase view definition files.',
  },
  {
    id: 'vault.write.ztype',
    since: '0.1.0',
    stability: 'public-experimental',
    description: 'Write Zorid .ztype field schema files.',
  },
  {
    id: 'metadata.read',
    since: '0.1.0',
    stability: 'public',
    description: 'Read derived metadata, tags, backlinks, and search index data.',
  },
  {
    id: 'workspace.views',
    since: '0.1.0',
    stability: 'public',
    description: 'Open panes, splits, contributed views, and data-view embeds.',
  },
  {
    id: 'workspace.navigation',
    since: '0.1.0',
    stability: 'public',
    description: 'Navigate the workspace to files and editor panes.',
  },
  {
    id: 'workspace.fileRenderers',
    since: '0.1.0',
    stability: 'public-experimental',
    description: 'Register and use trusted custom file renderers for full-page and Markdown embed surfaces.',
  },
  { id: 'editor.read', since: '0.1.0', stability: 'public', description: 'Open and read editor buffers.' },
  {
    id: 'editor.write',
    since: '0.1.0',
    stability: 'public',
    description: 'Modify editor buffers and register editor/Markdown extensions.',
  },
  { id: 'commands.register', since: '0.1.0', stability: 'public', description: 'Register command palette commands.' },
  { id: 'settings.register', since: '0.1.0', stability: 'public', description: 'Register settings schema sections.' },
  { id: 'status.register', since: '0.1.0', stability: 'public', description: 'Register status bar contributions.' },
  {
    id: 'platform.haptics',
    since: '0.1.0',
    stability: 'public-experimental',
    description: 'Use mobile haptic platform features when available.',
  },
  {
    id: 'desktop.folderVault',
    since: '0.1.0',
    stability: 'public',
    description: 'Use a user-selected desktop folder as the active vault.',
  },
  {
    id: 'mobile.appPrivateVault',
    since: '0.1.0',
    stability: 'public-experimental',
    description: 'Use the mobile app-private vault storage backend.',
  },
  {
    id: 'nativeFs.watch',
    since: '0.1.0',
    stability: 'public',
    description: 'Watch native filesystem changes inside the active vault.',
  },
] as const satisfies readonly CapabilityInfo[];
export const capabilityNames = capabilityInfos.map((capability) => capability.id) as readonly CapabilityName[];

const publicFunction = (capabilities?: readonly CapabilityName[]): ApiFunctionInfo => ({
  since: '0.1.0',
  stability: 'public',
  ...(capabilities === undefined ? {} : { capabilities }),
});
const experimentalFunction = (capabilities?: readonly CapabilityName[]): ApiFunctionInfo => ({
  since: '0.1.0',
  stability: 'public-experimental',
  ...(capabilities === undefined ? {} : { capabilities }),
});

export const apiInfoFixture: ApiInfo = {
  apiLevel: 1,
  compatibleApiLevel: 1,
  apiPrerelease: true,
  capabilities: capabilityInfos,
  namespaces: {
    app: { version: '0.1.0', stability: 'public', functions: { apiInfo: publicFunction() } },
    vault: {
      version: '0.1.0',
      stability: 'public',
      functions: {
        readText: publicFunction(['vault.read']),
        writeText: publicFunction(['vault.write']),
        list: publicFunction(['vault.read']),
        stat: publicFunction(['vault.read']),
        createFolder: publicFunction(['vault.write']),
        rename: publicFunction(['vault.write']),
        delete: publicFunction(['vault.write']),
        watch: publicFunction(['vault.read', 'nativeFs.watch']),
        read: publicFunction(['vault.read']),
        write: publicFunction(['vault.write']),
      },
    },
    workspace: {
      version: '0.1.0',
      stability: 'public',
      functions: {
        openFile: publicFunction(['workspace.navigation']),
        openView: publicFunction(['workspace.views']),
        splitPane: publicFunction(['workspace.navigation']),
        closePane: publicFunction(['workspace.navigation']),
        getSnapshot: publicFunction(),
        subscribe: publicFunction(),
        registerView: publicFunction(['workspace.views']),
        activeFile: publicFunction(),
        split: publicFunction(['workspace.navigation']),
      },
    },
    editor: {
      version: '0.1.0',
      stability: 'public',
      functions: {
        openDocument: publicFunction(['editor.read']),
        getActiveEditor: publicFunction(['editor.read']),
        registerExtension: publicFunction(['editor.write']),
        registerCommand: publicFunction(['editor.write']),
        activeEditor: publicFunction(['editor.read']),
        open: publicFunction(['editor.read']),
        save: publicFunction(['editor.write']),
      },
    },
    metadata: {
      version: '0.1.0',
      stability: 'public',
      functions: {
        getFile: publicFunction(['metadata.read']),
        backlinks: publicFunction(['metadata.read']),
        tags: publicFunction(['metadata.read']),
      },
    },
    search: { version: '0.1.0', stability: 'public', functions: { search: publicFunction(['metadata.read']) } },
    objects: {
      version: '0.1.0',
      stability: 'public',
      functions: {
        readType: publicFunction(['vault.read']),
        readBase: publicFunction(['vault.read']),
        writeObject: publicFunction(['vault.write', 'vault.write.markdown', 'vault.write.zbase', 'vault.write.ztype']),
      },
    },
    fields: {
      version: '0.1.0',
      stability: 'public-experimental',
      experimental: true,
      functions: {
        getFields: experimentalFunction(['metadata.read']),
        getType: experimentalFunction(['metadata.read']),
        updateField: experimentalFunction(['vault.write.markdown']),
        setType: experimentalFunction(['vault.write.ztype']),
      },
    },
    dataViews: {
      version: '0.1.0',
      stability: 'public-experimental',
      experimental: true,
      functions: {
        registerRenderer: experimentalFunction(['workspace.views']),
        evaluateFilters: experimentalFunction(['metadata.read']),
        openBase: experimentalFunction(['workspace.views', 'vault.read']),
        renderEmbed: experimentalFunction(['workspace.views', 'vault.read']),
      },
    },
    commands: {
      version: '0.1.0',
      stability: 'public',
      functions: { register: publicFunction(['commands.register']), execute: publicFunction(), list: publicFunction() },
    },
    settings: { version: '0.1.0', stability: 'public', functions: { register: publicFunction(['settings.register']) } },
    events: { version: '0.1.0', stability: 'public', functions: { on: publicFunction(), emit: publicFunction() } },
    storage: { version: '0.1.0', stability: 'public', functions: { get: publicFunction(), set: publicFunction() } },
    plugins: {
      version: '0.1.0',
      stability: 'public',
      functions: {
        getApi: publicFunction(),
        isActive: publicFunction(),
        getStatus: publicFunction(),
        listStatuses: publicFunction(),
        activate: publicFunction(),
      },
    },
    platform: {
      version: '0.1.0',
      stability: 'public',
      functions: { hasCapability: publicFunction(), listCapabilities: publicFunction() },
    },
    register: {
      version: '0.1.0',
      stability: 'public',
      functions: {
        disposable: publicFunction(),
        command: publicFunction(['commands.register']),
        setting: publicFunction(['settings.register']),
        view: publicFunction(['workspace.views']),
        fileRenderer: experimentalFunction(['workspace.fileRenderers']),
        viewRenderer: publicFunction(['workspace.views']),
        statusItem: publicFunction(['status.register']),
        editorExtension: publicFunction(['editor.write']),
        markdownProcessor: publicFunction(['editor.write']),
        event: publicFunction(),
        domEvent: publicFunction(),
      },
    },
  },
};
