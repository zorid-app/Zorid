# Zorid Frontend Architecture Plan

Status: decided for initial architecture  
Date: 2026-05-26

## Decision

Use **Vue 3 + TypeScript + Vite** for Zorid's first-party app shell.

Use **CodeMirror 6** for the Markdown editor.

Use **Capacitor** for mobile runtime.

Do **not** use Ionic as the core UI framework. Ionic components may be evaluated later for isolated mobile controls, but Zorid should own its design system and performance model.

Most important boundary:

> Vue is the implementation framework for Zorid's bundled shell UI. Vue is **not** the plugin API.

Plugins should target Zorid's typed platform APIs and DOM/editor extension points, not internal Vue components or Vue stores.

---

## Why Vue

The original question was whether to use React, Vue, Svelte, Solid, or Ionic.

Given the project goals, Vue is the best initial balance:

1. **Performance can be excellent when used correctly**
   - Vue's reactivity is efficient enough for a large app if high-volume state is kept outside deep reactive objects.
   - Use `shallowRef`, `markRaw`, selector-style stores, virtualization, dynamic imports, and worker-backed services.

2. **Better AI coding reliability than Solid**
   - Codex/GPT-5.5 High can likely write SolidJS well, but there are fewer examples and conventions.
   - Vue has more ecosystem examples, clearer common patterns, and a larger contributor base.
   - For a massive project built mostly with AI assistance, fewer framework-specific mistakes matters more than theoretical maximum UI micro-performance.

3. **Better performance discipline than React by default**
   - React can be fast, but accidental broad re-rendering is easy in large apps.
   - Zorid has many granular updates: indexing status, file changes, backlinks, tabs, panes, search results, editor extensions, sync state.
   - Vue is a safer middle ground: mainstream ecosystem with less React-style render churn risk.

4. **Better plugin-platform fit than Svelte as the app shell**
   - Svelte is very performant and productive, but its compiled component model can complicate third-party plugin distribution if plugins are expected to bring arbitrary UI frameworks.
   - Zorid should expose a framework-neutral DOM mount contract, so the shell framework should remain internal.

5. **Better app-shell ownership than Ionic**
   - Ionic is a mobile UI toolkit, not the core app architecture.
   - Zorid needs custom desktop and mobile UI around a Markdown editor, tabs, file trees, command palette, panes, data views, and plugin containers.
   - Capacitor is useful; Ionic as the main UI layer is optional and probably too opinionated for Zorid's editor/workspace model.

---

## Framework Ranking for Zorid

| Choice | Runtime performance | AI coding reliability | Ecosystem | Plugin-platform fit | Verdict |
|---|---:|---:|---:|---:|---|
| Vue 3 | Very good | Very good | High | Good if APIs are framework-neutral | **Choose for v0** |
| Solid | Excellent | Medium | Medium | Good | Best raw performance, more AI/contributor risk |
| Svelte | Excellent | Medium | Medium | Medium | Great app framework, trickier plugin ecosystem |
| React | Good if disciplined | Excellent | Excellent | Good | Best ecosystem, higher re-render footgun risk |
| Ionic | Component-dependent | Good | Good mobile | Not core architecture | Optional component source, not base framework |

---

## Non-Negotiable Frontend Performance Principles

The app must run well on lower-end devices. Framework choice alone will not guarantee that. The architecture must enforce these rules:

1. **Never put the whole vault in Vue state.**
2. **Never put the whole SQLite index in Vue state.**
3. **Never mirror the full CodeMirror document into Vue state.**
4. **Never make plugin internals depend on Vue internals.**
5. **Never block typing on indexing, search, backup, sync, or plugin work.**
6. **Use virtualization for every potentially large list.**
7. **Use lazy loading for every non-core pane, plugin, command, renderer, and settings page.**
8. **Use workers for indexing/search-heavy tasks.**
9. **Use `markRaw` for editor/plugin/service instances.**
10. **Use `shallowRef` for large immutable records and external store snapshots.**
11. **Use small selector subscriptions instead of deep reactive global objects.**
12. **Use stable typed APIs between packages so features can be developed in parallel.**

---

## Frontend Responsibility Split

```text
Vue app shell
  - window layout
  - panes and tabs
  - sidebars
  - command palette
  - settings UI
  - status bar
  - modals
  - mobile shell/navigation
  - plugin view containers
  - first-party plugin UI

CodeMirror
  - editor state
  - document model
  - text selection
  - editor transactions
  - decorations
  - syntax highlighting
  - editor extensions
  - live preview primitives

TypeScript services
  - vault storage API
  - workspace state
  - command registry
  - settings registry
  - event bus
  - plugin host
  - metadata/search APIs
  - sync APIs
  - backup/history orchestration

Workers / Rust-WASM
  - Markdown parsing
  - link extraction
  - tag extraction
  - fields/custom block extraction
  - search document construction
  - graph/backlink computation
  - scoring/ranking later

SQLite / CacheStore
  - derived index records
  - metadata queries
  - search tables
  - plugin storage
  - history/timeline records
```

---

      data-views/
```

Rule: `ui-vue` may depend on platform APIs. Platform APIs must not depend on `ui-vue`.

---

## Vue State Architecture

Use Vue for shell-level state only.

### Good Vue state

```text
current theme
visible modal
active command palette query
current pane ID
sidebar collapsed/open state
selected file path
indexing status summary
sync status summary
settings form draft
```

### Bad Vue state

```text
all files in vault as deep reactive tree
entire SQLite index
entire Markdown document text
all search documents
all backlinks for every file
all plugin internal state
CodeMirror EditorView instance as reactive object
```

### Store pattern

Use service-owned external state with Vue selector adapters.

```ts
// service owns real state
workspaceStore.getSnapshot();
workspaceStore.subscribe(listener);

// Vue composable selects small UI slice
export function useWorkspaceSelection() {
  const activePaneId = shallowRef(workspaceStore.getSnapshot().activePaneId);

  const unsubscribe = workspaceStore.subscribe(snapshot => {
    activePaneId.value = snapshot.activePaneId;
  });

  onScopeDispose(unsubscribe);

  return { activePaneId };
}
```

For large objects:

```ts
const editorView = shallowRef<EditorView | null>(null);
editorView.value = markRaw(view);
```

Use this rule:

> Services own data. Vue displays selected data.

---

## Editor Integration Plan

The editor should not be a Vue-controlled textarea. It should be a CodeMirror-owned editor mounted inside Vue.

```text
Vue component
  -> creates DOM container
  -> calls editor service to create CodeMirror EditorView
  -> registers lifecycle hooks
  -> receives small status updates only
```

Example boundary:

```ts
export interface EditorAPI {
  openDocument(path: string): Promise<EditorHandle>;
  save(handle: EditorHandle): Promise<void>;
  registerExtension(extension: EditorExtensionContribution): Disposable;
  registerCommand(command: EditorCommandContribution): Disposable;
}
```

CodeMirror owns:

- text document;
- selection;
- undo history;
- decorations;
- editor transactions;
- editor plugins/extensions.

Vue owns:

- which editor pane is visible;
- tab title/path;
- dirty indicator;
- high-level editor status;
- settings controls.

---

## Plugin UI Architecture

Plugins must not be forced to use Vue.

Expose a framework-neutral DOM mount contract:

```ts
export interface PluginViewContribution {
  id: string;
  title: string;
  icon?: string;
  lazy?: boolean;
  mount(container: HTMLElement, ctx: ZoridPluginContext): Promise<PluginViewInstance> | PluginViewInstance;
}

export interface PluginViewInstance {
  update?(input: unknown): void;
  focus?(): void;
  unmount(): void | Promise<void>;
}
```

This allows:

```text
first-party Vue plugin views
React plugin views
Svelte plugin views
Solid plugin views
plain DOM plugin views
Canvas/WebGL plugin views
iframe-sandboxed plugin views
```

The Zorid shell only provides:

```text
container HTMLElement
plugin context
lifecycle hooks
permission-gated APIs
```

It does not require plugin UI to be Vue.

---

## Plugin Capability Model

Plugins should be powerful but not uncontrolled.

### Allowed extension points

Plugins can contribute:

- commands;
- hotkeys;
- sidebars;
- panes/views;
- status bar items;
- settings sections;
- editor extensions;
- Markdown block renderers;
- metadata/index contributors;
- query/data views;
- sync providers;
- themes;
- import/export tools.

### Restricted by default

Plugins should not automatically get:

- raw filesystem access;
- Node/Electron APIs;
- arbitrary network access;
- shell command execution;
- unrestricted clipboard access;
- other plugins' private state;
- direct SQLite handles;
- internal Vue stores;
- internal app services not exposed through public API.

### Manifest permissions

```ts
export type PluginPermission =
  | 'vault:read'
  | 'vault:write'
  | 'workspace:views'
  | 'editor:extensions'
  | 'metadata:read'
  | 'search:query'
  | 'settings:write'
  | 'storage:plugin'
  | `network:${string}`;
```

Example:

```json
{
  "id": "com.example.calendar-sync",
  "name": "Calendar Sync",
  "permissions": [
    "vault:read",
    "vault:write",
    "storage:plugin",
    "network:https://calendar.example.com"
  ]
}
```

---

## Lazy Loading Architecture

Borrow the lazy.nvim model conceptually:

```text
1. Plugins declare contributions in manifests.
2. PluginHost registers cheap placeholders.
3. Placeholders are attached to commands, hotkeys, views, events, filetypes, editor extensions, or Markdown block renderers.
4. On first use, PluginHost loads the real plugin.
5. Dependencies are loaded.
6. Permissions are checked.
7. The placeholder is replaced.
8. Original user action is replayed.
```

Lazy trigger types:

```ts
export interface PluginLazyTriggers {
  onStartup?: boolean;
  onCommand?: string[];
  onHotkey?: string[];
  onView?: string[];
  onEvent?: string[];
  onFileType?: string[];
  onMarkdownBlock?: string[];
  onEditorExtension?: string[];
}
```

Example manifest:

```json
{
  "id": "zorid.backlinks",
  "name": "Backlinks",
  "entry": "./index.js",
  "contributes": {
    "views": [{ "id": "backlinks.panel", "title": "Backlinks" }],
    "commands": [{ "id": "backlinks.open", "title": "Open Backlinks" }]
  },
  "lazy": {
    "onView": ["backlinks.panel"],
    "onCommand": ["backlinks.open"]
  }
}
```

---

## Desktop Frontend Shell

Desktop shell should include:

```text
AppRoot
  GlobalProviders
  MainLayout
    ActivityBar / Ribbon
    LeftSidebar
      FileExplorerView
      SearchView
      TagsView
    CenterWorkspace
      PaneSplitTree
        EditorPane
        PluginViewPane
    RightSidebar
      BacklinksView
      OutlineView
    StatusBar
  CommandPalette
  SettingsModal
  PluginManagerModal
```

Desktop priorities:

1. Keyboard-first command palette.
2. Tabbed panes.
3. Fast file explorer.
4. Backlinks/search sidebars.
5. Minimal chrome.
6. Plugin view containers.

---

## Mobile Frontend Shell

Mobile should use the same platform APIs but different layout components.

```text
MobileAppRoot
  MobileNavigationShell
    CurrentView
      EditorMobileView
      FileBrowserMobileView
      SearchMobileView
      PluginMobileView
    BottomActionBar / CommandButton
    MobileCommandSheet
    MobileSettingsSheet
```

Mobile-specific rules:

1. No desktop-style multi-pane layout by default.
2. Use one primary surface at a time.
3. Keep command palette as a mobile action sheet.
4. File navigation should be touch-first.
5. Editor toolbar should be custom, not generic Ionic-first.
6. Indexing/sync/backup must happen in the background and expose simple status.
7. Mobile must tolerate app pause/resume and delayed file scans.

---

## Styling and Design System

Use a lightweight custom design system:

```text
design tokens
  colors
  spacing
  typography
  radii
  shadows
  z-index
  animation durations

components
  Button
  IconButton
  Input
  List
  VirtualList
  Tabs
  Pane
  Modal
  CommandItem
  SettingsRow
  StatusItem
```

Recommended styling approach:

- CSS variables for theming.
- Plain CSS modules or scoped Vue styles for components.
- Avoid heavy UI component libraries at the core.
- Avoid global CSS chaos.
- Ensure every component supports density and mobile variants.

Do not start with a large UI library. Zorid's UX is specialized enough that a custom lightweight system is safer.

---

## Routing

Avoid URL/router-first architecture for the core workspace.

A note editor is not primarily a web page app. It is a workspace state machine.

Use routing only for:

```text
settings sections
onboarding
plugin manager
help/about
possibly mobile top-level surfaces
```

Use `WorkspaceAPI` for panes/tabs/views.

```ts
workspace.openFile(path);
workspace.openView('backlinks.panel', { position: 'right' });
workspace.splitPane(activePaneId, 'right');
```

---

## Data View Frontend Plan

Data views are important enough to design early but implement after the core editor/index.

A flexible view should separate:

```text
query model
  -> result set
    -> view adapter
      -> table / kanban / calendar / timeline renderer
```

Core types:

```ts
export interface ZoridQuery {
  source: 'notes' | 'tasks' | 'fields' | 'tags';
  filters: QueryFilter[];
  sort?: QuerySort[];
  groupBy?: string[];
  select?: string[];
}

export interface DataViewContribution {
  id: string;
  title: string;
  supportedShapes: DataShape[];
  mount(container: HTMLElement, ctx: DataViewContext): PluginViewInstance;
}
```

First-party renderers later:

```text
table
kanban
calendar
timeline
gallery/list
```

---

## Ionic Decision

Use **Capacitor**, not Ionic as the core frontend architecture.

Ionic may be useful later for isolated controls:

```text
action sheet
picker
mobile modal
native-feeling toggles
```

But do not build Zorid around Ionic because:

1. Zorid needs custom editor/workspace UX.
2. Desktop and mobile should share platform APIs, not necessarily share identical components.
3. Ionic may add component weight and design constraints.
4. The editor, command palette, file tree, and plugin panes need custom performance handling.

Rule:

> Capacitor is infrastructure. Ionic is optional UI inventory.

---

## Performance Budgets

Initial budgets to enforce with tests/profiling:

```text
Desktop cold shell visible: target < 1500 ms on normal machine
Mobile shell visible: target < 2500 ms on lower-end device
Open normal note: target < 100 ms after vault loaded
Typing latency: no visible delay during indexing
Command palette open: target < 50 ms
Search initial response from index: target < 200 ms for medium vault
File tree scroll: stable 60fps with virtualization
Plugin lazy command first run: acceptable one-time load, then fast repeat
```

These numbers can be revised after real benchmarks, but performance budgets must exist from the beginning.

---

## Frontend Testing Plan

### Unit tests

- command registry;
- settings registry;
- workspace layout tree;
- plugin manifest validation;
- lazy trigger mapping;
- Vue composables with small selected state;
- path display helpers;
- editor API wrappers.

### Component tests

- command palette;
- tab bar;
- pane split layout;
- file explorer virtual list;
- settings sections;
- plugin view container lifecycle;
- status bar contributions.

### Integration tests

- open file from file explorer;
- editor save updates dirty state;
- command palette invokes command;
- plugin placeholder lazy-loads and replays command;
- plugin view mounts and unmounts cleanly;
- disabling plugin removes commands/views;
- index status updates without rerendering entire shell.

### E2E tests

- open vault;
- create note;
- edit/save note;
- create wikilink;
- see backlink;
- search note content;
- open command palette;
- toggle plugin;
- close/reopen workspace;
- mobile smoke: open note and edit.

### Performance tests

- startup bundle/module timing;
- large file tree virtualization;
- search results virtualization;
- large note open;
- typing while indexing;
- plugin lazy-load timing;
- memory usage after opening/closing many panes.

---

## Implementation Steps

### Phase 1: Frontend foundation

1. Scaffold Vue 3 + TypeScript + Vite renderer.
2. Add shared `ui-vue` package.
3. Add design tokens and minimal components.
4. Add app kernel provider/bootstrap.
5. Add service registry, event bus, command registry, settings registry.
6. Add basic desktop app shell layout.
7. Add basic mobile shell layout.

### Phase 2: Workspace shell

1. Implement layout tree model.
2. Implement tabs and panes.
3. Implement view registry.
4. Implement plugin view container.
5. Implement persisted workspace state.
6. Add split pane behavior after single-pane editor is stable.

### Phase 3: Editor shell integration

1. Create Vue `EditorPane.vue` wrapper.
2. Mount CodeMirror imperatively.
3. Store `EditorView` as `markRaw`.
4. Wire open/save through `VaultStorage`.
5. Add dirty state and status bar updates.
6. Add editor command bridge.
7. Add editor extension registry.

### Phase 4: Plugin host frontend integration

1. Implement manifest parser.
2. Register lazy command placeholders.
3. Register lazy view placeholders.
4. Implement dynamic plugin loading.
5. Add framework-neutral DOM mount lifecycle.
6. Convert file explorer/search/backlinks/status bar into first-party plugin-style modules.

### Phase 5: Performance hardening

1. Add virtualization for file explorer.
2. Add virtualization for search results.
3. Add virtualization for backlinks if large.
4. Audit deep reactivity usage.
5. Replace large reactive objects with `shallowRef`/external stores.
6. Add startup bundle analysis.
7. Add performance CI smoke tests where practical.

### Phase 6: Mobile-specific UX

1. Build mobile navigation shell.
2. Build mobile command sheet.
3. Build touch file browser.
4. Build mobile editor toolbar.
5. Add resume/suspend state handling.
6. Test mobile shell with sample vault.

---

## Architecture Guardrails for Codex

Since this project will mainly be implemented with Codex/GPT-5.5 High, encode these guardrails in repo docs and possibly lint rules:

1. Do not import `ui-vue` from platform packages.
2. Do not expose Vue stores as plugin API.
3. Do not place `EditorView` or service instances in deep reactive objects.
4. Do not use Vue state for full vault/index data.
5. Prefer service APIs plus small composables.
6. Prefer dynamic imports for plugin/pane code.
7. Use `markRaw` for external class instances.
8. Use `shallowRef` for large snapshots.
9. Add tests when adding a new registry or plugin extension point.
10. Keep plugin APIs typed and versioned.

---

## Final Frontend Architecture Summary

```text
Vue 3 + TypeScript + Vite
  = first-party shell and bundled UI

CodeMirror 6
  = editor state and editor extensions

Capacitor
  = mobile native runtime

Electron
  = desktop native runtime

Zorid Plugin API
  = framework-neutral extension surface

DOM mount contract
  = plugin UI freedom

Workers + Rust/WASM + SQLite
  = performance-critical indexing/search/metadata pipeline
```

The frontend decision is therefore:

> Choose Vue for maintainable, AI-friendly, performant app-shell development, while designing Zorid as a framework-neutral plugin platform with strict performance boundaries.
