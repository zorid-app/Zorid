# Core Plugin Contract

Status: v0 design baseline

## Definition

Core plugins are official bundled Zorid features stored under `plugins/core/*`. They are shipped with the app and enabled in v0, but they should be architected as plugins so Zorid dogfoods its own extension surfaces.

## Core plugins in v0

- file-explorer
- search
- backlinks
- outline
- tags
- status-bar
- fields
- data-views

## Shell features, not plugins

- command palette
- settings UI
- main desktop layout
- main mobile layout
- plugin manager UI

## API policy

Core plugins use experimental Platform APIs in v0. These APIs can change quickly while the architecture stabilizes.

Core plugins should not randomly import private package internals. If a feature needs lower-level access, first add a narrow Platform API. Temporary bridges must be documented as technical debt.

## Plugin context shape

```ts
export interface ZoridPluginContext {
  app: AppAPI;
  vault: VaultAPI;
  workspace: WorkspaceAPI;
  editor: EditorAPI;
  metadata: MetadataAPI;
  objects: ObjectStoreAPI;
  search: SearchAPI;
  commands: CommandsAPI;
  settings: SettingsAPI;
  events: EventBusAPI;
  storage: PluginStorageAPI;
  plugins: PluginRegistryAPI;
  register: PluginRegistrationAPI;
  platform: PlatformAPI;
}
```

## Lifecycle-owned cleanup

Every core plugin contribution must be registered through lifecycle-owned APIs so the plugin host can automatically clean it up on unload or failure.

Examples:

```ts
ctx.register.command(command);
ctx.register.event(ctx.events.on("vault:file-created", handler));
ctx.register.viewRenderer(renderer);
ctx.register.domEvent(element, "click", handler);
```

All registrations return disposables and are disposed by the plugin host in reverse order during unload.

## Platform split

Core plugin manifests should declare platform support and required capabilities, even when v0 only ships trusted core plugins.

```json
{
  "platforms": ["desktop", "mobile"],
  "capabilities": {
    "required": ["vault.read", "workspace.views"],
    "optional": ["haptics"]
  }
}
```

Plugins should use Zorid platform APIs rather than raw Electron, Node, or Capacitor APIs unless a feature is explicitly desktop-only or mobile-only.

## Dependency direction

Core plugins may depend on Platform APIs and, when declared, other core plugin APIs. Dependencies are first-class for deterministic load order, compatibility checks, lazy activation, and diagnostics. They are not permission to import another plugin's internals.

Core plugins must not depend on Vue internals or shell internals. Public plugin UI APIs are framework-agnostic; Vue can be used internally by bundled core plugins but is not part of the public plugin ABI.

## Lazy loading

Core plugins should declare contributions up front and lazy-load heavy code on first use where possible.
