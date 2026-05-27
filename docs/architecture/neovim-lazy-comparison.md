# Core Architecture Review: Zorid vs Neovim and lazy.nvim

Status: accepted design input for v0 architecture docs  
Date: 2026-05-27

## Summary verdict

Zorid should copy Neovim's API contract discipline and lazy.nvim's lazy-loading observability, but it should not copy Neovim's full openness. Zorid is a local-first document/workspace app, so its plugin API should remain domain-shaped, capability-scoped, and safer than a general Lua runtime.

## API cleanliness

### Zorid direction

Zorid's API is intentionally domain-shaped:

- `VaultAPI` for canonical file operations;
- `WorkspaceAPI` for panes, tabs, views, and layout state;
- `EditorAPI` for CodeMirror-backed editor surfaces;
- `MetadataAPI` and `SearchAPI` for derived index reads;
- `ObjectStoreAPI` for `.zbase` and `.ztype` files;
- `CommandsAPI`, `SettingsAPI`, `EventBusAPI`, `PluginStorageAPI`, `PluginRegistryAPI`, and `PlatformAPI` for extension infrastructure.

The public `AppAPI` remains metadata-only. It must not expose a generic `getService()` escape hatch.

### Neovim comparison

Neovim is extremely extensible, but its API is layered by history and runtime model: Vimscript/Ex access, C/RPC `vim.api`, and Lua-native `vim.*` APIs. That is powerful, but it gives plugin authors more surface area and more ways to couple to internals.

Zorid should instead keep a smaller, typed, capability-shaped API and expose compatibility metadata similar to Neovim's API metadata model.

## Extensibility

### Zorid direction

Zorid extensibility is manifest-first:

- plugin ID and version are stable identifiers;
- platform support is explicit;
- required and optional capabilities are declared;
- dependencies are versioned and only grant access to exported public APIs;
- static contributions install placeholders;
- runtime registrations go through lifecycle-owned `ctx.register.*` methods;
- unload cleanup is automatic through disposables.

This makes Zorid less open than Neovim, but safer for a notes/workspace app where plugins should not freely mutate all state.

### Required tightening

Capabilities must be enforced by the host-created context, not only documented in manifests. v0 trusted core plugins may use diagnostic mode, but the implementation must be shaped for future strict enforcement.

## Lazy loading

### Zorid direction

Zorid's lazy model should mirror lazy.nvim's best ergonomics:

```text
static contribution / placeholder
  -> trigger fires
  -> dependency graph loads
  -> plugin runtime dynamic import
  -> activate(ctx)
  -> placeholder replaced
  -> original action replayed
```

Supported v0 triggers:

- `onStartup`
- `onCommand:<command-id>`
- `onView:<view-type>`
- `onFileExtension:<extension>`
- `onMarkdownEmbed:<extension-or-type>`
- `onWorkspaceEvent:<event-name>`

### lazy.nvim comparison

lazy.nvim is ahead operationally: it controls startup, supports rich trigger specs, exposes stats/profiling, and emits lifecycle events. Zorid should adopt the observability lesson immediately even before third-party plugins exist.

## Accepted refinements

The following are now part of the v0 architecture contract:

1. **API metadata:** `AppAPI.apiInfo()` exposes API level, compatibility, prerelease state, namespace versions, function metadata, and capability metadata.
2. **Capability-enforced context:** the plugin host builds `ZoridPluginContext` from manifest capabilities and platform capabilities; missing required capabilities disable activation, and missing optional capability use produces diagnostics.
3. **Lazy-load observability:** `PluginLoadRecord`, plugin status APIs, plugin lifecycle events, and plugin manager/devtools diagnostics are required in the first wave.
