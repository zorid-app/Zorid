# PRD: Zorid v0 First Implementation Wave

Status: package/API gate locked by Prometheus Strict  
Source spec: `.omx/specs/deep-interview-zorid-app.md`  
API gate: `.omx/plans/api-package-design-zorid-v0-first-wave-*.md`

## 1. Requirements summary

Zorid v0 must become a runnable, desktop-first, local-first Markdown workspace with the documented v0 architecture/features. The first wave must not be a toy prototype: it must establish the monorepo, kernel/platform API boundaries, plugin host, core shell, Markdown editor flow, derived SQLite indexing, fields/types, and table/list data views.

Grounding evidence:
- Product direction: local-first cross-platform Markdown workspace with structured data and modular lazy-loaded architecture (`docs/product/overview.md:6-19`).
- Settled platform/tooling: monorepo, Vue 3 + TypeScript, Vite, pnpm, Electron, Capacitor, CodeMirror 6 (`docs/product/overview.md:23-51`, `docs/product/frontend.md:6-19`).
- Repository/package outline and import direction are already documented (`docs/product/overview.md:108-179`).
- v0 milestone requires desktop app, Markdown editor, file explorer, tabs/panes, command palette/settings, SQLite index, fields/types, `.zbase` table/list views, search/backlinks/tags/outline/status, lazy core plugin surfaces, and index rebuild (`docs/product/overview.md:664-688`).

## 2. Users and jobs

- **Primary user:** the app owner/developer using AI-assisted development to build a large open-source note app quickly.
- **Future end user:** local-first note taker/project manager who wants Markdown files plus structured fields/views without losing file readability.
- **Plugin developer later:** not enabled for arbitrary third-party plugins in v0, but v0 APIs must not block the future ecosystem.

## 3. In scope

### 3.1 Foundation
- pnpm workspace monorepo.
- Electron desktop app with secure main/preload/renderer split.
- Capacitor mobile app skeleton only.
- Shared TypeScript configs, lint/test/build scripts.
- Architecture docs and ADRs updated as implementation decisions are made.

### 3.2 API/package design approval gate
- Draft and approve package boundaries, dependency directions, public Plugin API, and core Platform APIs before deep implementation.
- The design artifact must be kept in `docs/architecture/` or `.omx/plans/` and copied/promoted into repo docs when implementation starts.

### 3.3 Kernel and platform services
- `app-kernel`: lifecycle, service registry, event bus, command registry, settings registry, platform capabilities, API metadata.
- `vault`: folder-vault storage, watcher abstraction, file operations.
- `workspace`: layout tree, panes/tabs, view registry, active file/view state.
- `editor`: CodeMirror wrapper and EditorAPI.
- `metadata`, `db`, `index-api`, `indexer-js`, `index-worker`: derived index pipeline and query APIs.
- `object-store`: `.zbase` and `.ztype` parsing/validation/read-write helpers.

### 3.4 Plugin host and core plugins
- Manifest discovery/parsing/validation.
- Platform/capability checks.
- Dependency ordering for core plugins.
- Static contributions and lazy activation placeholders where practical.
- Lifecycle-owned disposable cleanup.
- Core plugins: file-explorer, search, backlinks, outline, tags, status-bar, fields, data-views.

### 3.5 Desktop shell/editor/UI
- Obsidian-like structure: activity rail, left sidebar, central workspace/tabs/panes, status bar (`docs/product/frontend.md:60-108`).
- Command palette/settings/plugin manager are shell-owned.
- CodeMirror Markdown editor create/open/edit/save flow.
- Vue state is limited to selected UI slices; CodeMirror/vault/index data stay outside deep Vue state (`docs/product/frontend.md:112-120`, `docs/product/frontend.md:230-240`).

### 3.6 Storage/index/data features
- Canonical Markdown + `.zbase` + `.ztype`; SQLite/cache derived and rebuildable (`docs/architecture/index-schema.md:6-25`).
- Incremental indexing pipeline for `.md`, `.zbase`, `.ztype` with transaction writes and metadata events (`docs/architecture/index-schema.md:29-82`).
- Metadata/Search APIs hide raw SQL from plugins (`docs/architecture/index-schema.md:370-382`).
- Fields/types: frontmatter fields, `.ztype` Types, `zorid.type`, typed grouped field UI, preservation behavior (`docs/architecture/fields-and-types.md:6-18`, `docs/architecture/fields-and-types.md:58-113`, `docs/architecture/fields-and-types.md:165-225`).
- Data views: `.zbase` YAML, ordered views, table/list v0, safe expression parser, diagnostics (`docs/architecture/zbase-schema-and-filter-grammar.md:6-15`, `docs/architecture/zbase-schema-and-filter-grammar.md:116-149`, `docs/architecture/zbase-schema-and-filter-grammar.md:220-247`, `docs/architecture/zbase-schema-and-filter-grammar.md:356-386`).

## 4. Out of scope / non-goals

- Full mobile UX parity.
- Arbitrary third-party plugin ecosystem enablement/support.
- Real Google Drive/S3 sync, automatic backup, timeline history.
- P1/P2 rich features: Excalidraw, Canvas, PDF annotation, calendar sync, image viewer, advanced Notion-like rich views beyond table/list.
- Rust/WASM acceleration beyond interface/skeleton if useful.
- Offline collaboration, operation logs, conflict merge engine, CRDT-backed object types.
- Pixel-perfect Obsidian styling.

## 5. Acceptance criteria

### Foundation
- `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and app build scripts exist.
- Root `pnpm-workspace.yaml` includes apps, packages, and core plugins.
- Electron app launches a desktop renderer.
- Mobile app/package skeleton exists but is not required to match desktop feature parity.

### API gate
- The package/API gate is locked for v0: contracts-only `platform-api`, broad typed plugin facade, no public generic `getService()`, public-prealpha `FieldsAPI`/`DataViewsAPI`, approved manifest policy, and deferred shell UI replacement track.
- Package/API design doc is approved before implementation proceeds beyond skeleton boundaries.
- Package import boundaries are enforceable by code review and preferably by lint/test checks.

### Desktop app/editor
- User can open a normal folder vault.
- User can create/open/edit/save Markdown in CodeMirror.
- Dirty/save state is visible.
- Tabs/panes can open multiple files/views.
- Command palette invokes registered commands.
- Settings shell renders app/plugin settings schemas.

### Index/search/metadata
- Index rebuild from Markdown + `.zbase` + `.ztype` succeeds after deleting derived DB.
- Incremental file changes update index records and emit metadata events.
- Search returns indexed content/filename/headings/tags/fields.
- Backlinks/tags/outline/status read from services/index, not synchronous renderer scans.

### Fields/types/data views
- `.ztype` files parse, validate, and register Type IDs/field definitions.
- Markdown `zorid.type` applies Type field semantics.
- Typed field UI renders grouped fields and preserves undeclared/ad-hoc fields.
- `.zbase` files parse, validate, and open/embed from Markdown.
- Table/list views render filtered records with v0 sort/group behavior.
- Invalid `.ztype`, `.zbase`, and filter expressions produce user-visible diagnostics without crashing.


### API metadata, capability enforcement, and lazy-load observability
- `AppAPI.apiInfo()` exposes API level, compatibility level, prerelease state, namespace versions, function metadata, and capability metadata.
- The plugin host creates a capability-shaped `ZoridPluginContext` from manifest and platform capabilities. Missing required capabilities disable activation; missing optional capability use produces structured diagnostics.
- Plugin lazy loading records status, activation reason, trigger, dependency chain, duration, missing capabilities, and errors in `PluginLoadRecord`.
- Plugin manager/devtools can inspect plugin statuses without activating inactive plugins.

### Plugin architecture
- Core plugin manifests exist and validate.
- Core plugins register contributions through lifecycle-owned APIs.
- Disabling/unloading a core plugin removes registered commands/views/status items/listeners.
- Lazy activation placeholders replay at least one command or view action in a test.

## 6. Constraints

- No raw unrestricted Electron/Node bridge in renderer; preload must expose narrow, typed APIs.
- Public plugin UI cannot require Vue.
- Platform packages cannot import shell/Vue packages.
- Plugins do not receive raw SQLite handles in v0.
- API metadata and plugin load records must be visible through public/core APIs rather than private implementation imports.
- Large vault/index/editor document data must not live in deep Vue state.
- Major architecture changes, dropped v0 behavior, major dependencies, or deferred-scope expansion require user approval.

## 7. Dependencies and evidence

- Vue official TypeScript docs recommend Vite-powered TS setup and `vue-tsc` command-line checks.
- Vite official docs require Node.js 20.19+ / 22.12+ for current Vite and provide Vue TS scaffolding.
- Electron context-isolation docs require narrow `contextBridge` APIs rather than exposing raw IPC.
- pnpm workspaces require `pnpm-workspace.yaml` and support `workspace:` dependencies.
- CodeMirror supports modular extension APIs and Markdown language support.
- Capacitor supports web-to-native runtime skeleton and native plugin APIs; full mobile UX is deferred.
