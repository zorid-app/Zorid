import { DisposableStack, ZoridError, asPluginId, normalizeVaultPath, type Disposable } from '@zorid/shared';
import type { ActivationTrigger, PluginManifest, ZoridPlugin, ZoridPluginContext } from '@zorid/plugin-api';
import type { CapabilityName, CommandsAPI, DataViewRenderOptions, DataViewsAPI, EditorAPI, EventBusAPI, FieldsAPI, MetadataAPI, ObjectStoreAPI, PluginRegistryAPI, SearchAPI, SettingsAPI, VaultAPI, WorkspaceAPI } from '@zorid/platform-api';

export type PluginLoadStatus = 'discovered' | 'placeholder' | 'loading' | 'active' | 'failed' | 'disabled';

export interface PluginLoadRecord {
  readonly pluginId: string;
  status: PluginLoadStatus;
  activationReason?: string;
  trigger?: ActivationTrigger;
  dependencyChain: readonly string[];
  dependenciesLoaded: readonly string[];
  missingCapabilities: readonly CapabilityName[];
  platformCompatible: boolean;
  discoveredAtMs?: number;
  activationRequestedAtMs?: number;
  loadedAtMs?: number;
  lastError?: string;
  durationMs?: number;
  capabilityDiagnostics?: readonly CapabilityDiagnostic[];
}

export interface CapabilityDiagnostic { readonly code: 'plugin.capability.missing' | 'plugin.capability.undeclared'; readonly capability: CapabilityName; readonly pluginId: string; }

export interface ManifestValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const validActivationPrefixes = ['onCommand:', 'onView:', 'onFileExtension:', 'onMarkdownEmbed:'];

export function validatePluginManifest(input: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const manifest = input as Partial<PluginManifest>;
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest must be an object'] };
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof manifest.id !== 'string') errors.push('id is required');
  else { try { asPluginId(manifest.id); } catch { errors.push(`invalid plugin id: ${manifest.id}`); } }
  for (const key of ['name', 'version', 'entry', 'zoridApi'] as const) if (typeof manifest[key] !== 'string') errors.push(`${key} is required`);
  if (manifest.kind !== 'core' && manifest.kind !== 'community') errors.push('kind must be core or community');
  if (!Array.isArray(manifest.platforms) || manifest.platforms.some((p) => p !== 'desktop' && p !== 'mobile')) errors.push('platforms must contain desktop/mobile');
  if (!manifest.capabilities || !Array.isArray(manifest.capabilities.required) || !Array.isArray(manifest.capabilities.optional)) errors.push('capabilities.required and capabilities.optional are required arrays');
  for (const trigger of manifest.activation ?? []) {
    if (trigger !== 'onStartup' && !validActivationPrefixes.some((prefix) => trigger.startsWith(prefix))) errors.push(`invalid activation trigger: ${trigger}`);
  }
  return { ok: errors.length === 0, errors };
}

export function resolvePluginOrder(manifests: readonly PluginManifest[]): string[] {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(id: string, chain: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new ZoridError('plugin.dependency.cycle', `Plugin dependency cycle: ${[...chain, id].join(' -> ')}`);
    const manifest = byId.get(id);
    if (!manifest) throw new ZoridError('plugin.dependency.missing', `Missing plugin dependency: ${id}`);
    visiting.add(id);
    for (const dep of Object.keys(manifest.dependsOn ?? {})) visit(dep, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const manifest of manifests) visit(manifest.id, []);
  return order;
}

export interface LazyTriggerIndex {
  readonly onCommand: ReadonlyMap<string, readonly string[]>;
  readonly onView: ReadonlyMap<string, readonly string[]>;
  readonly onFileExtension: ReadonlyMap<string, readonly string[]>;
  readonly onMarkdownEmbed: ReadonlyMap<string, readonly string[]>;
  readonly onStartup: readonly string[];
}

function add(map: Map<string, string[]>, key: string, pluginId: string): void {
  const list = map.get(key) ?? [];
  list.push(pluginId);
  map.set(key, list);
}

export function createLazyTriggerIndex(manifests: readonly PluginManifest[]): LazyTriggerIndex {
  const onCommand = new Map<string, string[]>();
  const onView = new Map<string, string[]>();
  const onFileExtension = new Map<string, string[]>();
  const onMarkdownEmbed = new Map<string, string[]>();
  const onStartup: string[] = [];
  for (const manifest of manifests) {
    for (const trigger of manifest.activation ?? []) {
      if (trigger === 'onStartup') onStartup.push(manifest.id);
      else if (trigger.startsWith('onCommand:')) add(onCommand, trigger.slice('onCommand:'.length), manifest.id);
      else if (trigger.startsWith('onView:')) add(onView, trigger.slice('onView:'.length), manifest.id);
      else if (trigger.startsWith('onFileExtension:')) add(onFileExtension, trigger.slice('onFileExtension:'.length), manifest.id);
      else if (trigger.startsWith('onMarkdownEmbed:')) add(onMarkdownEmbed, trigger.slice('onMarkdownEmbed:'.length), manifest.id);
    }
  }
  return { onCommand, onView, onFileExtension, onMarkdownEmbed, onStartup };
}

export type PluginRuntimeLoader = (manifest: PluginManifest) => Promise<ZoridPlugin> | ZoridPlugin;
export type PluginContextFactory = (manifest: PluginManifest, stack: DisposableStack) => ZoridPluginContext;

export interface PluginHostOptions {
  readonly manifests: readonly PluginManifest[];
  readonly platform: 'desktop' | 'mobile';
  readonly capabilities: ReadonlySet<CapabilityName>;
  readonly load: PluginRuntimeLoader;
  readonly createBaseContext: PluginContextFactory;
  readonly events?: Pick<EventBusAPI, 'emit'>;
  readonly now?: () => number;
}

export class PluginHost {
  readonly manifests: ReadonlyMap<string, PluginManifest>;
  readonly triggerIndex: LazyTriggerIndex;
  #records = new Map<string, PluginLoadRecord>();
  #plugins = new Map<string, ZoridPlugin>();
  #stacks = new Map<string, DisposableStack>();
  #options: PluginHostOptions;

  constructor(options: PluginHostOptions) {
    this.#options = options;
    this.manifests = new Map(options.manifests.map((manifest) => [manifest.id, manifest]));
    resolvePluginOrder(options.manifests);
    this.triggerIndex = createLazyTriggerIndex(options.manifests);
    for (const manifest of options.manifests) {
      const validation = validatePluginManifest(manifest);
      if (!validation.ok) throw new ZoridError('plugin.manifest.invalid', validation.errors.join('; '));
      const missing = manifest.capabilities.required.filter((capability) => !options.capabilities.has(capability));
      const compatible = manifest.platforms.includes(options.platform);
      const status = compatible && missing.length === 0 ? 'placeholder' : 'disabled';
      const record: PluginLoadRecord = {
        pluginId: manifest.id,
        status,
        dependencyChain: Object.keys(manifest.dependsOn ?? {}),
        dependenciesLoaded: [],
        missingCapabilities: missing,
        platformCompatible: compatible,
        discoveredAtMs: options.now?.() ?? Date.now(),
      };
      this.#records.set(manifest.id, record);
      this.#emit(status === 'disabled' ? 'plugin:disabled' : 'plugin:placeholder-registered', record);
    }
  }

  records(): readonly PluginLoadRecord[] { return [...this.#records.values()].map((record) => ({ ...record })); }
  record(pluginId: string): PluginLoadRecord | undefined { const record = this.#records.get(pluginId); return record ? { ...record } : undefined; }
  #emit(event: 'plugin:placeholder-registered' | 'plugin:load-started' | 'plugin:loaded' | 'plugin:failed' | 'plugin:disabled' | 'plugin:unloaded', record: PluginLoadRecord): void {
    this.#options.events?.emit(event, { ...record });
  }

  async activate(pluginId: string, reason = 'manual', trigger?: ActivationTrigger): Promise<void> {
    const manifest = this.manifests.get(pluginId);
    if (!manifest) throw new ZoridError('plugin.missing', `Unknown plugin: ${pluginId}`);
    const record = this.#records.get(pluginId);
    if (!record) throw new ZoridError('plugin.record-missing', `Missing load record: ${pluginId}`);
    if (record.status === 'disabled') throw new ZoridError('plugin.disabled', `Plugin is disabled: ${pluginId}`);
    if (record.status === 'active') return;

    const loadedDeps: string[] = [];
    for (const dep of Object.keys(manifest.dependsOn ?? {})) { await this.activate(dep, 'dependency'); loadedDeps.push(dep); }
    record.dependenciesLoaded = loadedDeps;

    const start = this.#options.now?.() ?? Date.now();
    record.status = 'loading';
    record.activationReason = reason;
    record.activationRequestedAtMs = start;
    this.#emit('plugin:load-started', record);
    if (trigger !== undefined) record.trigger = trigger;
    const stack = new DisposableStack();
    try {
      const plugin = await this.#options.load(manifest);
      const context = this.#createPluginContext(manifest, stack);
      await plugin.activate(context);
      this.#plugins.set(pluginId, plugin);
      this.#stacks.set(pluginId, stack);
      record.status = 'active';
      record.loadedAtMs = this.#options.now?.() ?? Date.now();
      record.durationMs = record.loadedAtMs - start;
      this.#emit('plugin:loaded', record);
    } catch (error) {
      await stack.dispose().catch((disposeError: unknown) => { record.lastError = `${error instanceof Error ? error.message : String(error)}; dispose failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`; });
      record.status = 'failed';
      record.lastError = error instanceof Error ? error.message : String(error);
      this.#emit('plugin:failed', record);
      throw error;
    }
  }


  #createPluginContext(manifest: PluginManifest, stack: DisposableStack): ZoridPluginContext {
    const base = this.#options.createBaseContext(manifest, stack) as ZoridPluginContext & Record<string, unknown>;
    const required = new Set<CapabilityName>(manifest.capabilities.required);
    const optional = new Set<CapabilityName>(manifest.capabilities.optional);
    const declared = new Set<CapabilityName>([...required, ...optional]);
    const record = this.#records.get(manifest.id);
    const recordDiagnostic = (code: CapabilityDiagnostic['code'], capability: CapabilityName): void => {
      const diagnostic = { code, capability, pluginId: manifest.id };
      if (record) record.capabilityDiagnostics = [...(record.capabilityDiagnostics ?? []), diagnostic];
    };
    const ensure = (capability: CapabilityName): boolean => {
      if (!declared.has(capability)) {
        recordDiagnostic('plugin.capability.undeclared', capability);
        throw new ZoridError('plugin.capability.undeclared', `Plugin ${manifest.id} did not declare ${capability}`);
      }
      if (!this.#options.capabilities.has(capability)) {
        recordDiagnostic('plugin.capability.missing', capability);
        if (required.has(capability)) throw new ZoridError('plugin.capability.missing', `Capability unavailable for ${manifest.id}: ${capability}`);
        return false;
      }
      return true;
    };
    const unavailable = (capability: CapabilityName) => new ZoridError('plugin.capability.unavailable', `Optional capability unavailable for ${manifest.id}: ${capability}`);
    const writableObjectCapability = (path: unknown): CapabilityName => {
      const stringPath = String(path);
      if (stringPath.endsWith('.ztype')) return 'vault.write.ztype';
      if (stringPath.endsWith('.zbase')) return 'vault.write.zbase';
      if (stringPath.endsWith('.md') || stringPath.endsWith('.markdown')) return 'vault.write.markdown';
      return 'vault.write';
    };
    const wrapVault = (vault: VaultAPI | undefined): VaultAPI | undefined => vault && {
      ...vault,
      readText: (path) => ensure('vault.read') ? vault.readText(path) : Promise.reject(unavailable('vault.read')),
      writeText: (path, contents) => ensure('vault.write') ? vault.writeText(path, contents) : Promise.reject(unavailable('vault.write')),
      read: (path) => ensure('vault.read') ? vault.read(path) : Promise.reject(unavailable('vault.read')),
      write: (path, contents) => ensure('vault.write') ? vault.write(path, contents) : Promise.reject(unavailable('vault.write')),
      list: (path) => ensure('vault.read') ? vault.list(path) : Promise.reject(unavailable('vault.read')),
      stat: (path) => ensure('vault.read') ? vault.stat(path) : Promise.reject(unavailable('vault.read')),
      createFolder: (path) => ensure('vault.write') ? vault.createFolder(path) : Promise.reject(unavailable('vault.write')),
      rename: (from, to) => ensure('vault.write') ? vault.rename(from, to) : Promise.reject(unavailable('vault.write')),
      delete: (path) => ensure('vault.write') ? vault.delete(path) : Promise.reject(unavailable('vault.write')),
      watch: ((pathOrListener: Parameters<VaultAPI['watch']>[0], maybeCallback?: (event: import('@zorid/platform-api').VaultChangeEvent) => void) => {
        if (!(ensure('vault.read') && ensure('nativeFs.watch'))) throw unavailable('nativeFs.watch');
        return typeof pathOrListener === 'function' ? vault.watch(pathOrListener) : vault.watch(pathOrListener, maybeCallback!);
      }) as VaultAPI['watch'],
    };
    const wrapWorkspace = (workspace: WorkspaceAPI | undefined): WorkspaceAPI | undefined => workspace && {
      ...workspace,
      openFile: (path, options) => ensure('workspace.navigation') ? workspace.openFile(path, options) : Promise.reject(unavailable('workspace.navigation')),
      openView: ((typeOrView: Parameters<WorkspaceAPI['openView']>[0], inputOrOptions?: unknown, maybeOptions?: import('@zorid/platform-api').OpenViewOptions) => ensure('workspace.views') ? workspace.openView(typeOrView as never, inputOrOptions as never, maybeOptions as never) : Promise.reject(unavailable('workspace.views'))) as WorkspaceAPI['openView'],
      splitPane: (paneId, direction) => ensure('workspace.navigation') ? workspace.splitPane(paneId, direction) : Promise.reject(unavailable('workspace.navigation')),
      closePane: (paneId) => ensure('workspace.navigation') ? workspace.closePane(paneId) : Promise.reject(unavailable('workspace.navigation')),
      getSnapshot: () => workspace.getSnapshot(),
      subscribe: (listener) => workspace.subscribe(listener),
      registerView: (contribution) => ensure('workspace.views') ? workspace.registerView(contribution) : (() => { throw unavailable('workspace.views'); })(),
      activeFile: () => workspace.activeFile(),
      split: (direction) => ensure('workspace.navigation') ? workspace.split(direction) : Promise.reject(unavailable('workspace.navigation')),
    };
    const wrapEditor = (editor: EditorAPI | undefined): EditorAPI | undefined => editor && {
      ...editor,
      getActiveEditor: () => ensure('editor.read') ? editor.getActiveEditor() : (() => { throw unavailable('editor.read'); })(),
      activeEditor: () => ensure('editor.read') ? editor.activeEditor() : (() => { throw unavailable('editor.read'); })(),
      openDocument: (path, options) => ensure('editor.read') ? editor.openDocument(path, options) : Promise.reject(unavailable('editor.read')),
      open: (path) => ensure('editor.read') ? editor.open(path) : Promise.reject(unavailable('editor.read')),
      save: (handle) => ensure('editor.write') ? editor.save(handle) : Promise.reject(unavailable('editor.write')),
      registerExtension: (extension) => ensure('editor.write') ? editor.registerExtension(extension) : (() => { throw unavailable('editor.write'); })(),
      registerCommand: (command) => ensure('editor.write') ? editor.registerCommand(command) : (() => { throw unavailable('editor.write'); })(),
    };
    const wrapMetadata = (metadata: MetadataAPI | undefined): MetadataAPI | undefined => metadata && {
      ...metadata,
      getFile: (path) => ensure('metadata.read') ? metadata.getFile(path) : Promise.reject(unavailable('metadata.read')),
      backlinks: (path) => ensure('metadata.read') ? metadata.backlinks(path) : Promise.reject(unavailable('metadata.read')),
      tags: () => ensure('metadata.read') ? metadata.tags() : Promise.reject(unavailable('metadata.read')),
    };
    const wrapSearch = (search: SearchAPI | undefined): SearchAPI | undefined => search && {
      ...search,
      search: (query, options) => ensure('metadata.read') ? search.search(query, options) : Promise.reject(unavailable('metadata.read')),
    };
    const wrapObjects = (objects: ObjectStoreAPI | undefined): ObjectStoreAPI | undefined => objects && {
      ...objects,
      readType: (path) => ensure('vault.read') ? objects.readType(path) : Promise.reject(unavailable('vault.read')),
      readBase: (path) => ensure('vault.read') ? objects.readBase(path) : Promise.reject(unavailable('vault.read')),
      writeObject: (path, value) => ensure(writableObjectCapability(path)) ? objects.writeObject(path, value) : Promise.reject(unavailable(writableObjectCapability(path))),
    };
    const wrapFields = (fields: FieldsAPI | undefined): FieldsAPI | undefined => fields && {
      ...fields,
      getFields: (path) => ensure('metadata.read') ? fields.getFields(path) : Promise.reject(unavailable('metadata.read')),
      getType: (path) => ensure('metadata.read') ? fields.getType(path) : Promise.reject(unavailable('metadata.read')),
      updateField: (path, key, value) => ensure('vault.write.markdown') ? fields.updateField(path, key, value) : Promise.reject(unavailable('vault.write.markdown')),
      setType: (path, typePath) => ensure('vault.write.ztype') ? fields.setType(path, typePath) : Promise.reject(unavailable('vault.write.ztype')),
    };
    const wrapDataViews = (dataViews: DataViewsAPI | undefined): DataViewsAPI | undefined => dataViews && {
      ...dataViews,
      registerRenderer: (renderer) => ensure('workspace.views') ? dataViews.registerRenderer(renderer) : (() => { throw unavailable('workspace.views'); })(),
      evaluateFilters: (filters) => ensure('metadata.read') ? dataViews.evaluateFilters(filters) : Promise.reject(unavailable('metadata.read')),
      openBase: (path) => (ensure('workspace.views') && ensure('vault.read')) ? dataViews.openBase(path) : Promise.reject(unavailable('vault.read')),
      renderEmbed: (container, path, options) => {
        if (!(ensure('workspace.views') && ensure('vault.read'))) return Promise.reject(unavailable('vault.read'));
        const scoped = dataViews as DataViewsAPI & { renderEmbedForPlugin?: (container: HTMLElement, path: ReturnType<typeof normalizeVaultPath>, callerPluginId: ReturnType<typeof asPluginId>, options?: DataViewRenderOptions) => Promise<Disposable> };
        return scoped.renderEmbedForPlugin ? scoped.renderEmbedForPlugin(container, path, asPluginId(manifest.id), options) : dataViews.renderEmbed(container, path, options);
      },
    };
    const wrapCommands = (commands: CommandsAPI | undefined): CommandsAPI | undefined => commands && {
      ...commands,
      register: (command) => ensure('commands.register') ? commands.register(command) : (() => { throw unavailable('commands.register'); })(),
      execute: (id, args) => commands.execute(id, args),
      list: () => commands.list(),
    };
    const wrapSettings = (settings: SettingsAPI | undefined): SettingsAPI | undefined => settings && {
      ...settings,
      register: (section) => ensure('settings.register') ? settings.register(section) : (() => { throw unavailable('settings.register'); })(),
    };
    const wrapPlugins = (plugins: PluginRegistryAPI | undefined): PluginRegistryAPI | undefined => plugins && {
      ...plugins,
      getApi: (pluginId) => plugins.getApi(pluginId),
      isActive: (pluginId) => plugins.isActive(pluginId),
      getStatus: (pluginId) => plugins.getStatus(pluginId),
      listStatuses: () => plugins.listStatuses(),
      activate: (pluginId) => plugins.activate(pluginId),
    };
    return {
      ...base,
      vault: wrapVault(base.vault as VaultAPI | undefined) ?? base.vault,
      workspace: wrapWorkspace(base.workspace as WorkspaceAPI | undefined) ?? base.workspace,
      editor: wrapEditor(base.editor as EditorAPI | undefined) ?? base.editor,
      metadata: wrapMetadata(base.metadata as MetadataAPI | undefined) ?? base.metadata,
      objects: wrapObjects(base.objects as ObjectStoreAPI | undefined) ?? base.objects,
      search: wrapSearch(base.search as SearchAPI | undefined) ?? base.search,
      fields: wrapFields(base.fields as FieldsAPI | undefined) ?? base.fields,
      dataViews: wrapDataViews(base.dataViews as DataViewsAPI | undefined) ?? base.dataViews,
      commands: wrapCommands(base.commands as CommandsAPI | undefined) ?? base.commands,
      settings: wrapSettings(base.settings as SettingsAPI | undefined) ?? base.settings,
      plugins: wrapPlugins(base.plugins as PluginRegistryAPI | undefined) ?? base.plugins,
      register: base.register && {
        ...base.register,
        command: (command) => ensure('commands.register') ? base.register.command(command) : (() => { throw unavailable('commands.register'); })(),
        setting: (schema) => ensure('settings.register') ? base.register.setting(schema) : (() => { throw unavailable('settings.register'); })(),
        view: (view) => ensure('workspace.views') ? base.register.view(view) : (() => { throw unavailable('workspace.views'); })(),
        viewRenderer: (renderer) => ensure('workspace.views') ? base.register.viewRenderer(renderer) : (() => { throw unavailable('workspace.views'); })(),
        statusItem: (item) => ensure('status.register') ? base.register.statusItem(item) : (() => { throw unavailable('status.register'); })(),
        editorExtension: (extension) => ensure('editor.write') ? base.register.editorExtension(extension) : (() => { throw unavailable('editor.write'); })(),
        markdownProcessor: (processor) => ensure('editor.write') ? base.register.markdownProcessor(processor) : (() => { throw unavailable('editor.write'); })(),
        disposable: (disposable) => base.register.disposable(disposable),
        event: (disposable) => base.register.event(disposable),
        domEvent: (target, type, listener) => base.register.domEvent(target, type, listener),
      },
    } as ZoridPluginContext;
  }

  async deactivate(pluginId: string): Promise<void> {
    const plugin = this.#plugins.get(pluginId);
    const manifest = this.manifests.get(pluginId);
    const record = this.#records.get(pluginId);
    if (!plugin || !manifest || !record) return;
    const stack = this.#stacks.get(pluginId);
    await plugin.deactivate?.(this.#createPluginContext(manifest, stack ?? new DisposableStack()));
    await stack?.dispose();
    this.#plugins.delete(pluginId);
    this.#stacks.delete(pluginId);
    record.status = 'placeholder';
    this.#emit('plugin:unloaded', record);
  }
}

function toPluginStatus(record: PluginLoadRecord): import('@zorid/platform-api').PluginStatus {
  return {
    pluginId: record.pluginId,
    status: record.status,
    platformCompatible: record.platformCompatible,
    dependencyChain: record.dependencyChain,
    dependenciesLoaded: record.dependenciesLoaded,
    missingCapabilities: record.missingCapabilities,
    capabilityDiagnostics: record.capabilityDiagnostics ?? [],
    ...(record.discoveredAtMs === undefined ? {} : { discoveredAtMs: record.discoveredAtMs }),
    ...(record.activationRequestedAtMs === undefined ? {} : { activationRequestedAtMs: record.activationRequestedAtMs }),
    ...(record.loadedAtMs === undefined ? {} : { loadedAtMs: record.loadedAtMs }),
    ...(record.activationReason === undefined ? {} : { activationReason: record.activationReason }),
    ...(record.trigger === undefined ? {} : { trigger: record.trigger }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
  };
}

export function createPluginRegistryAPI(host: PluginHost): import('@zorid/platform-api').PluginRegistryAPI {
  return {
    getApi: async () => undefined,
    isActive: (pluginId) => host.record(pluginId)?.status === 'active',
    getStatus: (pluginId) => {
      const record = host.record(pluginId);
      return record ? toPluginStatus(record) : undefined;
    },
    listStatuses: () => host.records().map(toPluginStatus),
    activate: (pluginId) => host.activate(pluginId, 'registry'),
  };
}
