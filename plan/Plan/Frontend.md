# Frontend Plan

Status: v0 implementation handoff  
Date: 2026-05-27

## 1. Decisions

| Area            | Decision                                                 |
| --------------- | -------------------------------------------------------- |
| Framework       | Vue 3 + TypeScript                                       |
| Build tool      | Vite                                                     |
| Package manager | pnpm                                                     |
| Desktop runtime | Electron                                                 |
| Mobile runtime  | Capacitor, after desktop core works                      |
| Editor          | CodeMirror 6                                             |
| UI architecture | Shared Vue design system + desktop/mobile shell packages |
| Plugin UI ABI   | Framework-agnostic mount container, not Vue-specific     |

v0 implementation order: desktop-first. Mobile should keep package/app skeletons compatible with the shared architecture but does not need full feature parity before desktop v0 works.

---

## 2. Frontend Package Responsibilities

```text
packages/ui-vue
  design tokens
  common components
  menus/modals/notices/settings controls
  virtual lists/tables

packages/desktop-shell
  desktop layout frame
  sidebars
  tabs/panes
  command palette surface
  settings surface
  plugin manager surface
  status bar container

packages/mobile-shell
  mobile app shell skeleton
  one-main-surface navigation
  sheets/gestures/haptics adapters later

packages/editor
  CodeMirror 6 wrapper
  EditorAPI implementation
  Markdown editor state bridge

packages/workspace
  layout tree
  panes/tabs model
  view registry
  active file/view state
```

---

## 3. Desktop v0 Layout

The desktop shell should use the Obsidian-style screenshot as the visual/layout reference. The local self-contained copy is:

```text
Plan/Assets/desktop-layout-reference-obsidian.png
```

Obsidian embed for vault viewing:

![[Plan/Assets/desktop-layout-reference-obsidian.png]]

Reference structure:

```text
┌──────────────────────────────────────────────────────────────┐
│ macOS/window chrome + app top bar + tabs                      │
├──────┬─────────────────────────────┬─────────────────────────┤
│ C    │ A/D                         │ editor/workspace         │
│ side │ top controls + file tree     │ tabs + active view       │
│ rail │                             │                         │
├──────┴─────────────────────────────┴─────────────────────────┤
│ B status bar                                                  │
└──────────────────────────────────────────────────────────────┘

A: top-left app controls/chrome area with activity buttons.
B: bottom status bar.
C: narrow side action/activity rail.
D: file tree/sidebar content area.
```

Implementation guidance:

- Treat the screenshot as the authoritative desktop layout reference for v0.
- Match structure first, not exact Obsidian styling. Zorid can have its own visual identity later.
- Use a narrow left activity rail for core sections such as files, search, graph/backlinks, calendar/data, command/terminal-like tools if enabled.
- Use the adjacent left sidebar for the active section, initially File Explorer.
- Put tabs across the top of the main workspace.
- Keep the editor/workspace as the largest central area.
- Keep the status bar as a bottom shell-owned container with plugin-contributed items.
- The left sidebar should be collapsible.
- Right sidebar is optional after v0; do not add it unless needed for backlinks/outline.

Core surfaces:

- left activity rail: section switching and quick actions;
- left sidebar: file explorer/search/tags/backlinks/outline surfaces;
- center workspace: Markdown editor, `.zbase` viewer, plugin views;
- bottom status bar: shell-owned container, plugin-contributed items.

---

## 4. State Management

Use explicit service state before adding a large global store.

Recommended v0 pattern:

- app kernel owns services;
- workspace package owns workspace state;
- Vue components subscribe to narrow reactive slices;
- CodeMirror state stays inside editor package and is not mirrored wholesale into Vue;
- index/search results are paginated or virtualized.

Avoid:

- putting whole file contents into global Vue state;
- rerendering large sidebars on every editor keystroke;
- direct imports from shell into platform packages.

---

## 5. CodeMirror 6 Integration

Editor package owns CodeMirror.

Responsibilities:

- create/destroy editor instances;
- load/save Markdown through `VaultAPI`;
- expose `EditorAPI` for commands/plugins;
- emit lightweight events such as active file, selection, dirty state;
- support editor extensions through lifecycle-owned plugin registration;
- avoid forcing full document text into global reactive state.

v0 editor features:

- open/edit/save Markdown;
- basic Markdown syntax support;
- dirty state;
- command hooks;
- heading navigation hooks for Outline;
- active file updates for Backlinks/Status Bar.

---

## 6. Data Views UI

Data Views v0 renderers:

```text
table
list
```

Renderer input:

```ts
interface DataViewRenderProps {
  basePath: string;
  baseId: string;
  viewId: string;
  viewType: string;
  records: FileRecord[];
  config: unknown;
}
```

Rules:

- large result sets use virtualization;
- invalid filter/schema shows inline diagnostic;
- missing renderer shows placeholder;
- table/list are core renderers;
- plugin renderers later receive the same mount-container style contract.

---

## 7. Fields/Types UI

Typed field UI:

```text
┌─ Task ──────────────────────┐
│ Status:   [todo ▼]          │
│ Priority: [high ▼]          │
│ Due:      [2026-06-01]      │
└─────────────────────────────┘
```

Rules:

- Type-declared fields group in a box titled with the Type name;
- undeclared fields appear under “Other fields” when expanded;
- removing `zorid.type` hides the Type box but keeps values;
- re-adding `zorid.type` restores the box with previous values;
- field edits update Markdown frontmatter.

---

## 8. Command Palette and Settings

Shell-owned, not plugins.

Command palette:

- reads from kernel command registry;
- can show plugin commands before plugin runtime loads;
- invoking placeholder command triggers lazy plugin activation.

Settings UI:

- reads settings schemas from kernel/settings registry;
- renders shell settings and plugin settings;
- plugins register settings schemas, not custom shell internals.

---

## 9. Performance Requirements

v0 frontend should be designed for lower-end devices even though implementation starts desktop-first.

Requirements:

- lazy-load heavy plugin code;
- virtualize large file/search/data-view lists;
- batch index update UI refreshes;
- keep CodeMirror document state outside global Vue state;
- avoid synchronous vault-wide scans in renderer;
- use workers for indexing/query-heavy work where practical;
- measure large-vault startup and search before claiming performance success.

---

## 10. Acceptance Criteria

Desktop v0 frontend is ready when it can:

- open a folder vault;
- show file explorer;
- open/edit/save Markdown in CodeMirror;
- show command palette;
- show settings UI shell;
- index files and display search results;
- show backlinks/tags/outline/status surfaces;
- render Type field groups;
- open/embed `.zbase` files;
- render table/list Data Views;
- show diagnostics for invalid `.ztype`, `.zbase`, or filters.
