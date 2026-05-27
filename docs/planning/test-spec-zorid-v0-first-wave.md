# Test Spec: Zorid v0 First Implementation Wave

Status: package/API gate locked by Prometheus Strict  
Source PRD: `prd-zorid-v0-first-wave-*.md`

## 1. Verification philosophy

Use a layered test strategy: small package tests for contracts/parsers/registries; integration tests for cross-service flows; e2e/smoke tests for desktop user journeys; performance smoke tests for large-list/editor/index guardrails.

## 2. Static gates

- `pnpm lint` passes.
- `pnpm typecheck` passes, including Vue SFC checks via `vue-tsc` or equivalent.
- `pnpm build` succeeds for desktop renderer/main/preload packages.
- Import-boundary checks prevent platform packages importing shell/UI packages.

- Import-boundary tests cover every documented package direction and forbidden edge.
- Public-prealpha API docs tests cover `FieldsAPI` and `DataViewsAPI` direct `ctx` properties and API metadata.
- Plugin export lookup tests prove `ctx.plugins.getApi<T>()` only returns manifest-declared plugin exports, never app services.
- DataViews embed tests include caller plugin identity/capability diagnostics.
- Plugin manager status tests inspect load records without activating inactive plugins.
- Lazy placeholder import-sentinel tests prove runtime modules are not imported before trigger.
- Manifest schema validation runs in tests.

## 3. Unit tests

### Shared/kernel
- `DisposableStack` disposes in reverse order and handles async disposal errors predictably.
- `ServiceRegistry` rejects duplicate required services and returns typed services.
- `EventBus` emits/unsubscribes without leaking listeners.
- `CommandRegistry` registers/unregisters commands and invokes placeholders.
- `SettingsRegistry` validates shell and plugin settings schemas.

### Plugin API/host
- Manifest parser accepts valid core manifests and rejects invalid IDs/platform/capabilities/activation triggers.
### API metadata/capability/lazy observability
- `AppAPI.apiInfo()` fixture includes API level, compatibility, prerelease state, namespace versions, function `since` metadata, deprecation metadata where present, and capability metadata.
- Generated docs/API metadata tests fail when a public API method is missing `since` or stability classification.
- Capability policy disables plugins with missing required capabilities before activation.
- Optional capability use without support records a structured `plugin.capability.missing` diagnostic.
- Registration methods check matching capabilities in diagnostic/enforce mode.
- Lazy placeholders create `PluginLoadRecord` entries without importing plugin runtime code.
- Trigger replay updates load status from `placeholder` to `loading` to `active`, including reason, trigger, dependency chain, and duration.
- Failed activation leaves the shell stable and records `plugin:failed` event plus last error.

- Dependency graph orders core plugins and rejects cycles.
- Lazy trigger index maps `onCommand`, `onView`, `onFileExtension`, and `onMarkdownEmbed` to plugins.
- Plugin unload calls `deactivate` and disposes registered resources in reverse order.

### Vault/workspace/editor
- Vault path normalization rejects traversal and keeps vault-relative paths stable.
- Workspace layout tree opens/closes/splits panes and persists/restores state.
- Editor service creates/destroys editor handles and reports dirty/save updates without mirroring full doc into Vue state.

### Object/index/data parsing
- YAML frontmatter field inference covers string/int/float/boolean/date/datetime/list/null.
- `.ztype` parser validates schema, duplicate fields, options/defaults, required fields.
- `.zbase` parser validates top-level fields, ordered views, view IDs, renderer-specific config preservation.
- Filter parser rejects arbitrary JS and supports documented grammar/operators/helpers.

## 4. Integration tests

### Desktop/vault/editor
1. Open fixture vault.
2. Create `Notes/Test.md`.
3. Edit body/frontmatter in CodeMirror.
4. Save file.
5. Verify file on disk and dirty state clears.

### Index rebuild
1. Delete `.zorid/index/index.sqlite` in fixture vault.
2. Run full rebuild.
3. Verify files/types/type_fields/fields/links/tags/headings/zbases/zbase_views/search_fts records.
4. Verify `.ztype` files index before Markdown validation.

### Incremental index
1. Modify Markdown frontmatter and body link.
2. Watcher schedules a batch.
3. One transaction updates records.
4. `metadata:index-updated(paths)` emits.
5. Search/backlinks/tags/outline update selected UI slices.

### Core plugin lifecycle
1. Load core manifest placeholder.
2. Invoke file explorer/search/backlinks command.
3. Verify plugin activates, registers real contribution, replays action.
4. Disable plugin.
5. Verify commands/views/status items/listeners are removed.

### Fields/types/data views
1. Create `.zorid/types/task.ztype`.
2. Create Markdown with `zorid.type: task` and fields.
3. Verify grouped field UI renders declared fields and Other fields.
4. Remove `zorid.type`, verify field values remain and typed UI hides.
5. Restore `zorid.type`, verify typed UI returns with previous values.
6. Create `.zorid/views/tasks.zbase` table/list views.
7. Embed with `![[.zorid/views/tasks.zbase]]`.
8. Verify table/list render filtered records with sort/group.

## 5. E2E/smoke tests

Desktop smoke:
- Launch Electron app.
- Open fixture vault folder.
- File explorer displays notes.
- Open note in editor.
- Edit/save note.
- Open command palette and run search/open command.
- Open backlinks/tags/outline/status surfaces.
- Open `.zbase` view and embedded `.zbase` in Markdown.
- App can close/reopen with workspace state restored.

Mobile skeleton smoke:
- Mobile package builds or at least typechecks.
- Capacitor config exists.
- Mobile shell skeleton mounts a placeholder primary surface.

## 6. Performance checks

Initial non-blocking budgets, measured on a fixture/generated vault:
- Desktop cold shell visible target: <1500 ms on normal dev machine.
- Open normal note after vault loaded: <100 ms target.
- Command palette open: <50 ms target.
- Search first indexed response for medium fixture vault: <200 ms target.
- File/search/data-view lists use virtualization for large result sets.
- Typing remains responsive while indexing batch is running.

If hardware makes a target unreliable, record the environment and trend instead of hiding the failure.

## 7. Observability/diagnostics

- Indexing status events expose pending/running/error counts.
- Invalid `.ztype`, `.zbase`, and filter expressions produce structured diagnostics with file/path/code/message.
- Plugin activation failures mark plugin failed and leave shell stable.
- Plugin manager diagnostics panel shows plugin status, activation reason, trigger, duration, missing capabilities, and last error.
- Renderer errors in plugin views show local error surfaces, not blank app crash.

## 8. Manual verification checklist before implementation handoff completion

- [ ] User-approved API/package design doc exists.
- [ ] PRD and test spec match approved design doc.
- [ ] All core acceptance flows have automated tests or documented test gaps.
- [ ] Build/type/lint/test outputs are freshly captured.
- [ ] Known deferred items are placeholders/interfaces only, not half-implemented scope creep.
