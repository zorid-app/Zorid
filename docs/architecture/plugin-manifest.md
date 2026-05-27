# Plugin Manifest

Status: v0 implementation handoff  
Date: 2026-05-27

## 1. Purpose

Plugin manifests let the plugin host discover core plugins, validate platform/capability compatibility, register static contributions, resolve dependency order, and install lazy activation placeholders.

v0 only ships trusted core plugins, but the manifest shape should be compatible with future third-party plugins.

---

## 2. Manifest File

Each plugin has:

```text
plugin.json
```

Example:

```json
{
  "schemaVersion": 1,
  "id": "zorid.core.data-views",
  "name": "Data Views",
  "version": "0.1.0",
  "kind": "core",
  "entry": "./src/index.ts",
  "zoridApi": "^0.1.0",
  "platforms": ["desktop"],
  "capabilities": {
    "required": ["vault.read", "metadata.read", "workspace.views"],
    "optional": ["platform.haptics"]
  },
  "dependsOn": {
    "zorid.core.fields": "^0.1.0"
  },
  "activation": [
    "onCommand:data-views.open",
    "onFileExtension:.zbase",
    "onMarkdownEmbed:.zbase",
    "onView:zbase"
  ],
  "contributes": {
    "commands": [
      {
        "id": "data-views.open",
        "title": "Open Base"
      }
    ],
    "viewRenderers": [
      { "type": "table" },
      { "type": "list" }
    ]
  }
}
```

---

## 3. Required Fields

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | integer | v0 supports `1` |
| `id` | string | globally unique plugin ID |
| `name` | string | display name |
| `version` | semver string | plugin version |
| `kind` | string | `core` in v0 |
| `entry` | string | module entry path |
| `zoridApi` | semver range | compatible app API range |
| `platforms` | array | `desktop`, `mobile`, or both |
| `capabilities` | object | required/optional capability lists |

Optional:

| Field | Type | Rule |
|---|---|---|
| `description` | string | plugin description |
| `dependsOn` | object | required plugin API dependencies |
| `optionalDependsOn` | object | optional plugin API dependencies |
| `activation` | array | lazy activation triggers; omitted means host/plugin default activation policy |
| `contributes` | object | static contributions; omitted means no placeholders before activation |

---

## 4. Plugin IDs

Core plugin ID format:

```text
zorid.core.<name>
```

Examples:

```text
zorid.core.fields
zorid.core.data-views
zorid.core.search
```

Future third-party IDs should be namespaced, for example:

```text
vendor.plugin-name
```

IDs are stable API identifiers and should not change after release.

---

## 5. Platforms

```json
"platforms": ["desktop"]
```

Allowed values:

```text
desktop
mobile
```

Desktop-only example:

```json
"platforms": ["desktop"]
```

The plugin host disables or hides plugins incompatible with the current platform.

---

## 6. Capabilities

Capabilities are permission-shaped declarations. v0 hard-disables plugins missing required platform capabilities before runtime import. Trusted bundled core plugins may use diagnostic method-wrapper enforcement while wrappers remain strict-mode compatible.

```json
"capabilities": {
  "required": ["vault.read", "workspace.views"],
  "optional": ["platform.haptics"]
}
```

Initial capability names:

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

- missing required capability disables plugin;
- missing optional capability does not disable plugin;
- plugins should call `ctx.platform.hasCapability(name)` before using optional capabilities.

---

## 7. Dependencies

```json
"dependsOn": {
  "zorid.core.fields": "^0.1.0"
},
"optionalDependsOn": {
  "zorid.core.data-views": "^0.1.0"
}
```

Rules:

- dependency keys are plugin IDs;
- values are semver ranges;
- required dependency missing/incompatible disables dependent plugin;
- optional dependency missing/incompatible should degrade gracefully;
- cycles are invalid;
- dependency grants access only to declared public plugin exports, not internals.

API lookup for future plugin-defined exports:

```ts
const charts = await ctx.plugins.getApi<ChartsAPI>("vendor.charts");
```

`FieldsAPI` and `DataViewsAPI` are host-owned public-prealpha proxies on `ctx.fields` and `ctx.dataViews`, not plugin-export lookup surfaces. v0 only needs minimal dependency ordering for bundled core plugins.

---

## 8. Activation Triggers

Supported v0 triggers:

```text
onStartup
onCommand:<command-id>
onView:<view-type>
onFileExtension:<extension>
onMarkdownEmbed:<extension-or-type>
onWorkspaceEvent:<event-name>
```

Examples:

```json
"activation": [
  "onCommand:search.open",
  "onWorkspaceEvent:active-file-changed"
]
```

Lazy-loading behavior:

```text
register static contribution/placeholder
  -> trigger fires
  -> record activation reason/trigger
  -> load dependencies
  -> dynamic import plugin entry
  -> activate(ctx)
  -> replace placeholder
  -> replay original user action when applicable
  -> expose load record in plugin manager/devtools
```

Lazy-loading diagnostics:

- each plugin has a `PluginLoadRecord`;
- dependency-triggered activation records `reason: "dependency"` plus `requestedBy`;
- failed activation records structured diagnostics and leaves the shell stable;
- plugin manager can inspect records without activating the plugin.

---

## 9. Static Contributions

### Commands

```json
"commands": [
  {
    "id": "search.open",
    "title": "Open Search",
    "category": "Search"
  }
]
```

### Views

```json
"views": [
  {
    "id": "search.panel",
    "title": "Search"
  }
]
```

### View renderers

```json
"viewRenderers": [
  { "type": "table" },
  { "type": "list" },
  { "type": "charts.bar" }
]
```

### Settings

```json
"settings": [
  {
    "id": "data-views",
    "title": "Data Views"
  }
]
```

The manifest registers discoverable placeholders only. Runtime behavior is registered during `activate(ctx)` through lifecycle-owned APIs.

---

## 10. Runtime Entry

Plugin module shape:

```ts
import { defineZoridPlugin } from "@zorid/plugin-api";

export default defineZoridPlugin({
  async activate(ctx) {
    ctx.register.command({
      id: "example.say-hello",
      title: "Say Hello",
      run: () => console.log("hello"),
    });
  },
  async deactivate() {
    // optional manual cleanup; registered disposables are automatic
  },
});
```

All runtime registrations should go through `ctx.register.*` so unload cleanup is automatic.

---

## 11. Manifest Validation

Invalid manifest behavior:

- core plugin invalid: app starts with diagnostic and plugin disabled if possible;
- missing required field: error;
- unknown field: warning;
- invalid platform/capability/dependency: error or warning depending severity;
- invalid contribution: ignore that contribution and report diagnostic.

---

## 12. v0 Core Plugin IDs

```text
zorid.core.file-explorer
zorid.core.search
zorid.core.backlinks
zorid.core.outline
zorid.core.tags
zorid.core.status-bar
zorid.core.fields
zorid.core.data-views
```

---

## 13. Relationship to API metadata

Manifest fields feed runtime API metadata and plugin diagnostics:

- `zoridApi` is checked against `AppAPI.apiInfo().apiLevel` and `apiCompatible`;
- declared capabilities are included in `CapabilityInfo` metadata;
- activation triggers and status are reflected in `PluginLoadRecord`;
- missing required capabilities disable activation before runtime import;
- optional capability failures are reported as structured diagnostics.
