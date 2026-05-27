# Deep Interview Spec: Zorid App First Implementation Wave

## Metadata

- Source workflow: `$deep-interview`
- Profile: standard
- Context type: brownfield planning repo / greenfield implementation
- Final ambiguity: 11%
- Threshold: 20%
- Rounds: 5
- Context snapshot: `.omx/context/zorid-app-20260527T041759Z.md`
- Transcript: see latest `.omx/interviews/zorid-app-*.md`

## Requirements source of truth

Primary planning inputs:
- `plan/Zorid.md`
- `plan/Plan/Overview.md`
- `plan/Plan/Frontend.md`
- `plan/Plan/Architecture/*.md`
- `plan/Plan/Core Plugins/*.md`

Research inputs are advisory unless promoted into the architecture/feature docs.

## Intent

Build Zorid as a large AI-assisted development project while preserving long-term architecture quality. The user wants implementation to cover the documented v0 architecture and feature docs, not merely a toy prototype or visual shell.

## Desired outcome

A first implementation wave that delivers documented v0 behavior:
- runnable desktop Electron app;
- Vue 3 + TypeScript + Vite frontend;
- pnpm monorepo structure;
- CodeMirror Markdown editor flow;
- Obsidian-style desktop layout structure;
- core shell surfaces;
- app kernel, service registries, events, commands, settings;
- plugin host, manifests, lazy activation where practical, lifecycle-owned cleanup;
- core plugins for file explorer, search, backlinks, outline, tags, status bar, fields, and data views;
- Markdown + `.ztype` + `.zbase` canonical storage;
- SQLite derived index/cache;
- fields/types UI and table/list data views;
- tests, build/type/lint gates, and updated architecture docs.

## In scope

### Foundation

- Monorepo using pnpm.
- Apps/packages/plugins structure consistent with `Plan/Overview.md`.
- Desktop-first Electron app.
- Mobile package/Capacitor skeleton compatible with future app-private vault model, but not full mobile UX parity.
- Vue 3 + TypeScript + Vite shell.
- CodeMirror 6 editor package.

### Kernel/platform APIs

- App kernel with lifecycle, service registry, event bus, command registry, settings registry, platform/capability registry, plugin host supervision, API metadata.
- Core Platform APIs to support v0: VaultAPI, WorkspaceAPI, EditorAPI, MetadataAPI, SearchAPI, ObjectStoreAPI, CommandsAPI, SettingsAPI, EventBusAPI, PluginStorageAPI, PluginRegistryAPI, PlatformAPI.
- API/package design must be drafted and approved before deep implementation.

### Plugin architecture

- Trusted bundled core plugins in v0.
- Plugin manifests with platform/capability declarations, activation triggers, static contributions, and dependency metadata.
- Lifecycle-owned disposables for commands, views, events, DOM listeners, timers, editor extensions, Markdown processors, settings, status items, and plugin exports.
- Lazy activation placeholders where practical.
- Framework-neutral DOM mount contract for plugin UI.

### Desktop shell/frontend

- Obsidian-like layout structure: activity rail, left sidebar, central workspace/tabs/panes, bottom status bar.
- File explorer, command palette, settings shell, status bar, basic plugin manager surface.
- Tabs/panes and workspace state.
- Non-pixel-perfect styling is acceptable; exact Obsidian styling is out of scope.
- Performance guardrails: no full vault/index/editor document in deep Vue state; use virtualization and workers where practical.

### Markdown/editor

- Create/open/edit/save Markdown notes.
- Dirty/save status.
- Heading/navigation hooks for outline.
- Editor command bridge and extension registry.

### Storage/index/search

- Canonical user data: Markdown files, `.zbase` YAML view files, `.ztype` YAML Type files, `.zorid/config.json`, `.zorid/workspace.json`.
- Derived/rebuildable data: `.zorid/index/index.sqlite`, `.zorid/cache/**`.
- SQLite schema and indexing algorithm from `Plan/Architecture/Index Schema.md`.
- Index Markdown frontmatter, headings, links, tags, fields; index `.ztype` and `.zbase` files.
- Search, backlinks, tags, outline, and status surfaces read from services/index, not renderer-wide scans.

### Fields/types/data views

- YAML frontmatter fields.
- `.ztype` Types under `.zorid/types/*.ztype`.
- `zorid.type` links files to Type IDs.
- Typed field group UI with preservation behavior when Type is removed/re-added.
- `.zbase` YAML view files, default `.zorid/views/`, embeddable via vault-relative Markdown embed syntax.
- Table/list v0 renderers.
- Safe filter grammar and diagnostics.
- Sort/group/filter by fields where documented.

### Quality/docs

- Unit/integration/e2e or smoke tests for critical flows.
- Lint/typecheck/build pass before claiming implementation completion.
- Architecture docs updated, especially approved API/package design docs.

## Out of scope / Non-goals for first implementation wave

- Full mobile UX parity.
- Arbitrary third-party plugin ecosystem enablement/support.
- Google Drive/S3 sync, automatic backup, and timeline history beyond placeholders/interfaces.
- P1/P2 rich features: Excalidraw, Canvas, PDF annotation, calendar sync, image viewer, advanced Notion-like rich views beyond v0 table/list, etc.
- Rust/WASM acceleration beyond interface/skeleton if useful; JS implementation first.
- Offline collaboration, operation logs, conflict merge engine, CRDT-backed object types.
- Pixel-perfect Obsidian styling.

## Decision boundaries

Codex/OMX may decide autonomously:
- implementation sequencing;
- common library/tooling choices compatible with Vue/Vite/Electron/pnpm;
- non-pixel-perfect UI styling details;
- persistence internals while preserving canonical-vs-derived storage rules;
- exact test strategy and test placement;
- tactical implementation choices that do not alter documented architecture or scope.

Codex/OMX must ask or produce an approval artifact before:
- changing documented architecture materially;
- dropping documented v0 behavior;
- adding major dependencies or runtime assumptions;
- expanding into deferred scope;
- finalizing package boundaries;
- finalizing public Plugin API;
- finalizing core Platform APIs.

Required gate before implementation:
- Draft a package/API design document covering package boundaries, dependency directions, public Plugin API, and core Platform APIs.
- Get user approval or requested revisions before deep implementation of those APIs/packages.

## Testable acceptance criteria

First implementation wave is complete when all selected criteria hold:

1. Runnable desktop app
   - Electron app launches.
   - User can open a normal folder vault.

2. Markdown editor flow
   - User can create/open/edit/save Markdown in CodeMirror.
   - Tabs/panes and dirty/save status work.

3. Core shell surfaces
   - Obsidian-like layout structure exists.
   - File explorer, command palette, settings shell, status bar, and basic plugin manager surface exist.

4. Index/search/backlinks
   - SQLite-derived index extracts files/headings/links/tags/frontmatter fields.
   - Search, backlinks, tags, outline read from index/services.

5. Fields/types/data views
   - `.ztype` Types parse and validate.
   - Typed field UI renders grouped fields.
   - `.zbase` table/list views render records.
   - Markdown embeds of `.zbase` work.
   - Filters/sort/group and diagnostics work at v0 level.

6. Core plugin architecture
   - v0 core features are implemented as bundled lifecycle-owned plugins where appropriate.
   - Manifests/lazy activation are implemented where practical.

7. Quality gate
   - Relevant unit/integration/e2e or smoke tests cover critical flows.
   - Lint/typecheck/build pass.
   - No known blocking errors remain.

8. Docs
   - Approved API/package docs and implementation notes are committed as future source of truth.

## Assumptions exposed and resolutions

- Assumption: “Everything documented” might include P1/P2/v1/future items.
  - Resolution: First implementation wave means documented v0 architecture/features; deferred/future items are non-goals.

- Assumption: Codex/OMX can choose package/API architecture alone.
  - Resolution: No. Package boundaries, public Plugin API, and core Platform APIs require a proposed design doc and user approval.

- Assumption: Exact implementation path matters.
  - Resolution: User does not care about path; Codex/OMX can choose sequencing if final v0 documented behavior is delivered.

## Brownfield evidence vs inference notes

Evidence from plan files:
- v0 is desktop-first with mobile skeleton later.
- Vue 3 + TypeScript + Vite + pnpm + Electron + Capacitor are settled.
- Markdown, `.zbase`, `.ztype` are canonical; SQLite is derived.
- Core plugins and shell/kernel/platform boundaries are documented.
- Several topics are explicitly future/deferred, including full mobile parity, third-party ecosystem, sync, Rust/WASM acceleration, operation logs/CRDT, and rich P1/P2 features.

Inference confirmed by user:
- Implement the documented v0 feature/architecture set rather than choosing a narrow prototype path.
- Defer future/deferred items listed above.
- Use an API/package design approval gate before implementation.

## Recommended handoff

Recommended next workflow: `$ralplan` / `$plan --consensus --direct .omx/specs/deep-interview-zorid-app.md`

Planning output should start with the required package/API design document gate, then produce canonical planning artifacts under `.omx/plans/`.

Do not implement directly from this deep-interview spec until the package/API design doc is approved.
