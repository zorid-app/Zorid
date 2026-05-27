import type { PluginId } from '@zorid/shared';
import type {
  AppAPI,
  CapabilityName,
  CommandsAPI,
  DataViewsAPI,
  EditorAPI,
  EventBusAPI,
  FieldsAPI,
  MetadataAPI,
  ObjectStoreAPI,
  PlatformAPI,
  PluginRegistrationAPI,
  PluginRegistryAPI,
  PluginStorageAPI,
  SearchAPI,
  SettingsAPI,
  SettingsContribution,
  VaultAPI,
  WorkspaceAPI,
} from '@zorid/platform-api';

export interface ZoridPluginContext {
  readonly pluginId: PluginId;
  readonly app: AppAPI;
  readonly vault: VaultAPI;
  readonly workspace: WorkspaceAPI;
  readonly editor: EditorAPI;
  readonly metadata: MetadataAPI;
  readonly objects: ObjectStoreAPI;
  readonly search: SearchAPI;
  /** Public-prealpha experimental; capability-gated and revisionable before alpha. */
  readonly fields: FieldsAPI;
  /** Public-prealpha experimental; capability-gated and revisionable before alpha. */
  readonly dataViews: DataViewsAPI;
  readonly commands: CommandsAPI;
  readonly settings: SettingsAPI;
  readonly events: EventBusAPI;
  readonly storage: PluginStorageAPI;
  readonly plugins: PluginRegistryAPI;
  readonly register: PluginRegistrationAPI;
  readonly platform: PlatformAPI;
}

export interface ZoridPlugin {
  activate(ctx: ZoridPluginContext): void | Promise<void>;
  deactivate?(ctx: ZoridPluginContext): void | Promise<void>;
}

export function defineZoridPlugin(plugin: ZoridPlugin): ZoridPlugin {
  return plugin;
}

export type PluginKind = 'core' | 'community';
export type ActivationTrigger = `onCommand:${string}` | `onView:${string}` | `onFileExtension:${string}` | `onMarkdownEmbed:${string}` | 'onStartup';

export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PluginKind;
  readonly entry: string;
  readonly zoridApi: string;
  readonly platforms: readonly ('desktop' | 'mobile')[];
  readonly capabilities: PluginCapabilityManifest;
  readonly description?: string;
  readonly dependsOn?: Readonly<Record<string, string>>;
  readonly optionalDependsOn?: Readonly<Record<string, string>>;
  /** Omitted means host/plugin default activation policy. */
  readonly activation?: readonly ActivationTrigger[];
  /** Omitted means no placeholders before activation. */
  readonly contributes?: StaticContributions;
}

export interface PluginCapabilityManifest {
  readonly required: readonly CapabilityName[];
  readonly optional: readonly CapabilityName[];
}

export interface StaticContributions {
  readonly commands?: readonly { readonly id: string; readonly title: string }[];
  readonly views?: readonly { readonly id: string; readonly title: string }[];
  readonly viewRenderers?: readonly { readonly type: string }[];
  readonly statusItems?: readonly { readonly id: string }[];
  readonly settings?: readonly SettingsContribution[];
}
