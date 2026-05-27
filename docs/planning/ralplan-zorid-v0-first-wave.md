# RALPLAN: Zorid v0 First Implementation Wave

Status: APPROVED by RALPLAN consensus; package/API gate locked by Prometheus Strict  
Source spec: `docs/planning/deep-interview-zorid-app.md`  
PRD: `docs/planning/prd-zorid-v0-first-wave.md`  
Test spec: `docs/planning/test-spec-zorid-v0-first-wave.md`  
API/package gate: `docs/architecture/package-api-design.md`

## RALPLAN-DR Summary

### Principles

1. **File-first durability:** Markdown, `.ztype`, and `.zbase` are canonical; SQLite/cache are derived and rebuildable.
2. **API-first modularity:** package boundaries, Platform APIs, Plugin API, and lifecycle cleanup are explicit before heavy implementation.
3. **Desktop-first usefulness:** ship a runnable Electron Markdown workspace before full mobile UX or P1/P2 expansions.
4. **Dogfood extensibility:** v0 core features should be built as bundled lifecycle-owned plugins where practical.
5. **Performance by boundary:** CodeMirror/editor state, vault contents, and index records stay out of deep Vue state; use workers/virtualization.

### Decision drivers

1. **Long-term architecture correctness:** package/API design must survive a large AI-assisted build without collapsing into private cross-imports.
2. **End-to-end v0 utility:** the first wave must produce a runnable app with real Markdown/index/field/view flows, not only scaffolding.
3. **Scope containment:** defer mobile parity, third-party ecosystem, sync/history, Rust/WASM acceleration, CRDT/offline collaboration, and P1/P2 rich features.

### Viable options

#### Option A — API-gated vertical architecture (recommended)

Approach: approve package/API design first, scaffold monorepo/contracts/tests, then implement thin but real end-to-end flows package by package.

Pros:
- Honors user’s package/API co-design boundary.
- Produces runnable value early while preserving architecture.
- Lets tests enforce package boundaries before broad feature work.

Cons:
- More upfront planning/doc work than pure coding.
- Some APIs will still need revision after implementation pressure.

#### Option B — Scaffold all packages first

Approach: build all packages, manifests, interfaces, and test skeletons before vertical user flows.

Pros:
- Strong architecture map from day one.
- Easy to parallelize after scaffolding.

Cons:
- High risk of unused abstractions and delayed app feedback.
- Could pass typechecks while failing product usefulness.

#### Option C — UI/editor slice first

Approach: prioritize Electron/Vue shell, file explorer, tabs, and CodeMirror editor before plugin/index/data architecture.

Pros:
- Fastest visible progress.
- Useful for visual iteration and user motivation.

Cons:
- Risks violating package/API approval gate.
- Later retrofitting plugin/index boundaries could be expensive.

Recommendation: Option A.

## ADR

### Decision

Use an **API-gated vertical architecture** plan: first finalize an approved package/API design artifact; then implement v0 through contract-tested vertical slices that deliver the desktop app, editor, index/search/backlinks, fields/types/data views, and core plugin architecture.

### Drivers

- User explicitly requires co-design/approval for package boundaries, public Plugin API, and core Platform APIs.
- Existing plan demands both modularity and runnable v0 behavior.
- Scope must remain bounded to v0 while preserving future plugin/mobile/sync paths.

### Alternatives considered

- **Scaffold all packages first:** rejected as too likely to create untested abstractions before product feedback.
- **UI/editor slice first:** rejected as too likely to bypass API/package approval and create shell-private shortcuts.

### Why chosen

Option A is the only option that satisfies the approval gate and still converges toward testable, runnable product value.

### Consequences

- Implementation cannot begin deeply until the API/package design doc is approved.
- Early tests must focus on contracts, import boundaries, parser/schema behavior, and critical vertical flows.
- Some tactical choices remain autonomous, but major API/package changes require user review.

### Follow-ups

- Promote the approved API/package design doc into `docs/architecture/` when implementation begins, preserving the “desktop-only unless mobile-tested” and “no public `getService()`” constraints verbatim.
- Convert this plan into `$ultragoal` durable goals after approval.
- Use `$team` for parallel implementation lanes once package boundaries are accepted.

## Implementation plan

### Phase 0 — Approval gate: package/API design

1. Use the locked `docs/architecture/package-api-design.md` gate as the implementation source of truth.
2. Resolve approval questions now narrowed by Architect feedback:
   - approve `packages/platform-api` as contracts-only type owner;
   - approve metadata-only public `AppAPI` with no generic `getService()` escape hatch;
   - approve normalized capability IDs from `Plugin Manifest.md`;
   - approve public-prealpha `FieldsAPI` and `DataViewsAPI` marked `public-experimental`;
   - approve desktop-only first-wave core plugin manifests unless mobile-tested.
3. After approval, promote the artifact to `docs/architecture/package-api-design.md` and record ADR.

Exit criteria:
- User-approved package/API design exists.
- PRD/test spec are revised if approval changes boundaries.

### Phase 1 — Workspace foundation

1. Create root pnpm workspace and TypeScript/lint/test config.
2. Scaffold apps/packages/plugins directories from approved package design.
3. Add import-boundary enforcement.
4. Add shared `Disposable`, error/result, path/ID utilities.
5. Add CI-equivalent local scripts: typecheck, lint, test, build.

Exit criteria:
- All empty/skeleton packages build/typecheck.
- Import-boundary checks catch forbidden dependency direction in a fixture/test.

### Phase 2 — Kernel, registries, plugin host contracts

1. Implement service registry, event bus, command registry, settings registry, platform capability registry.
2. Implement manifest parser/validator and core plugin manifest fixtures.
3. Implement dependency ordering and lazy trigger index.
4. Implement plugin activation/deactivation lifecycle and disposable stack.
5. Implement shell-owned command palette/settings/plugin manager data surfaces against registries.
6. Implement API metadata fixtures, capability policy tests, and plugin load status records/events.

Exit criteria:
- Unit tests cover registries, manifest validation, dependency order/cycle rejection, lazy placeholder replay, and cleanup.

### Phase 3 — Desktop shell + vault + editor vertical slice

1. Implement Electron main/preload/renderer with secure context bridge.
2. Implement desktop folder vault open/list/read/write/watch through `VaultAPI`.
3. Implement desktop shell layout structure: activity rail, left sidebar, tabs/panes, status bar.
4. Implement WorkspaceAPI layout tree and persistence.
5. Implement CodeMirror editor wrapper, open/edit/save, dirty status, editor command bridge.
6. Implement file explorer core plugin enough to browse/open/create/rename/delete files.

Exit criteria:
- Electron app opens fixture vault and can create/open/edit/save Markdown.
- File explorer and tabs/panes work through APIs, not shell-private shortcuts.

### Phase 4 — Index/metadata/search/backlinks/tags/outline/status

1. Implement SQLite schema/migrations from Index Schema plan.
2. Implement JS index engine for Markdown/frontmatter/headings/links/tags/fields and `.ztype`/`.zbase` records.
3. Implement index scheduler/worker bridge and rebuild/incremental update paths.
4. Implement MetadataAPI/SearchAPI over index store.
5. Implement search, backlinks, outline, tags, and status-bar core plugins.

Exit criteria:
- Delete/rebuild index succeeds from fixture vault.
- Search/backlinks/tags/outline/status update from metadata events.

### Phase 5 — Fields/types/object store/data views

1. Implement `.ztype` parser/validator and Type registry.
2. Implement field inference/normalization and Type application.
3. Implement typed field UI core plugin with preservation behavior.
4. Implement `.zbase` parser/validator, safe filter parser/evaluator, diagnostics.
5. Implement DataViewsAPI and table/list renderers with virtualization-ready inputs.
6. Implement Markdown `.zbase` embed rendering/opening.

Exit criteria:
- `.ztype` and `.zbase` fixture flows pass integration tests.
- Table/list views filter/sort/group records and show diagnostics for invalid input.

### Phase 6 — Mobile skeleton, docs, and hardening

1. Add Capacitor/mobile package skeleton and app-private vault placeholders.
2. Add performance smoke fixtures and budget reporting.
3. Audit Vue reactivity boundaries, virtualized lists, and worker usage.
4. Update docs/ADRs with final package/API choices and implementation notes.
5. Run full verification suite and record fresh evidence.

Exit criteria:
- Mobile skeleton builds/typechecks.
- Full quality gates pass or known gaps are explicitly documented.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| API design overfits before implementation | Use Option A vertical slices; keep APIs versioned/experimental in v0; revise only through documented ADRs. |
| AI agents violate import boundaries | Add lint/test boundary checks early; keep package ownership explicit. |
| Plugin architecture delays product usability | Deliver editor/vault/index/data-view vertical slices; core plugins may use experimental APIs but no private shell shortcuts. |
| Electron security shortcuts leak raw APIs | Use context isolation and narrow preload bridge; never expose raw `ipcRenderer.send`. |
| SQLite/native module friction in Electron | Encapsulate DB adapter; consider a first-pass pure JS/worker-compatible SQLite approach if native packaging blocks progress. |
| Indexing blocks typing/UI | Worker-backed scheduling, debounced batches, selected UI slice updates only. |
| `.zbase` filter grammar expands too much | Implement documented v0 grammar only; reject arbitrary JS; diagnostics over silent failure. |
| Test/e2e fragility causes false confidence or flaky blockers | Keep fast package/integration tests as primary proof; run deterministic desktop smoke/e2e on fixture vaults; record environment and quarantine only with explicit follow-up. |
| API metadata drifts from docs | Generate or fixture-test `apiInfo()` against documented public/core APIs; require `since` and stability metadata in review. |
| Capability declarations are not enforced | Build context wrappers through `CapabilityPolicy`; test diagnostic mode now and strict mode later. |
| Lazy loading becomes invisible/debug-hostile | Record `PluginLoadRecord` for every plugin and expose status in plugin manager/devtools. |

## Verification steps

1. Run static gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
2. Run unit tests for registries, plugin host, parsers, filter grammar, index records.
3. Run integration tests for vault/editor save, index rebuild/incremental update, plugin lifecycle, fields/types/data views.
4. Run desktop smoke/e2e: open vault, edit/save note, search, backlinks/tags/outline, command palette, `.zbase` view/embed.
5. Run performance smoke and record environment/results.
6. Verify docs/ADRs reflect approved API/package design and implementation deviations.

## Available-agent-types roster

- `planner`: plan revisions, sequencing, artifact maintenance.
- `architect`: package/API architecture review and tradeoff synthesis.
- `critic`: consensus/quality gate and acceptance criteria pressure.
- `executor`: implementation in scoped packages.
- `test-engineer`: test harnesses, fixtures, e2e/performance checks.
- `debugger`: root-cause failing app/test/build issues.
- `code-reviewer`: broad code review before PR/merge.
- `verifier`: final evidence audit against PRD/test spec.
- `designer`: desktop/mobile shell UX and component-system review.
- `dependency-expert`: package selection/upgrade/native module risk evaluation.
- `researcher`: official docs lookup when dependency behavior is version-sensitive.
- `code-simplifier`: post-implementation cleanup without behavior changes.
- `git-master`: commit/branch/PR hygiene.

## Follow-up staffing guidance

### `$ultragoal` default durable execution

Use `$ultragoal docs/planning/ralplan-zorid-v0-first-wave.md` after the locked architecture gate.

Suggested goal lanes:
1. API/package approval gate — planner + architect, high reasoning.
2. Workspace foundation — executor + test-engineer, medium reasoning.
3. Kernel/plugin host — executor + test-engineer + critic checkpoint, medium/high.
4. Desktop shell/editor/vault — executor + designer + test-engineer, medium/high.
5. Index/metadata/core plugins — executor + debugger + test-engineer, high.
6. Fields/types/data views — executor + test-engineer + critic, high.
7. Hardening/docs/verifier — verifier + code-reviewer + writer, high.

### Sequential handoff constraint

Before launching broad `$team` lanes, complete workspace foundation, contracts, import-boundary tests, API metadata fixtures, and capability policy scaffolding through `$ultragoal` or a single executor lane. Only then split independent implementation lanes. Docs/tests/verifier work should stay read-only or serialized when touching shared contracts.

### `$team` parallel implementation after approval

Use Team when package boundaries are accepted and lanes have disjoint write scopes.

Launch hint:
```text
$team docs/planning/ralplan-zorid-v0-first-wave.md
```

Suggested team lanes:
- Lane A: workspace foundation + shared configs (`package.json`, `pnpm-workspace.yaml`, `tsconfig`, `packages/shared`).
- Lane B: app-kernel + plugin-api contracts (`packages/app-kernel`, `packages/plugin-api`).
- Lane C: desktop shell/editor/vault (`apps/desktop`, `packages/desktop-shell`, `packages/editor`, `packages/vault`).
- Lane D: index/metadata/object-store (`packages/db`, `packages/index-*`, `packages/metadata`, `packages/object-store`).
- Lane E: core plugins + data views (`plugins/core/*`).
- Lane F: tests/fixtures/docs (`tests/*`, `docs/*`).

Team verification path:
- Each lane reports changed files, tests run, open risks.
- Team lead runs integrated typecheck/lint/test/build.
- Verifier checks PRD/test-spec acceptance and records evidence for Ultragoal checkpoint.

### `$ralph` fallback

Use only if user explicitly wants a persistent single-owner verification/fix loop after planning. Ralph should consume the approved plan and test spec; it should not reopen requirements unless the package/API gate changes.

## Goal-Mode Follow-up Suggestions

- `$ultragoal` — recommended default after API/package approval; tracks durable sequential goals and evidence.
- `$team` + `$ultragoal` — recommended for parallel delivery after boundaries are approved; Team executes lanes, Ultragoal owns ledger/checkpoints.
- `$performance-goal` — not primary now; use later if performance budgets become the central optimization mission.
- `$autoresearch-goal` — not applicable as final handoff; research here was supporting evidence, not the product deliverable.

## Applied reviewer improvements

Architect iteration 1 feedback applied:
- Added `packages/platform-api` as contracts-only API type owner so `plugin-api` can reference platform API types without hidden implementation imports.
- Removed public `AppAPI.getService()` and split service access into internal/core-only contexts if needed later.
- Normalized capability IDs against `Plan/Architecture/Plugin Manifest.md`.
- Added method signatures for CommandsAPI, SettingsAPI, EventBusAPI, PluginStorageAPI, PluginRegistryAPI, and PlatformAPI.
- Added public-prealpha `FieldsAPI` and `DataViewsAPI` contracts marked `public-experimental`, clarified one-way `data-views` -> `FieldsAPI` dependency.
- Explicitly forbade plugin access to raw SQLite, IndexStore, IndexEngine, IndexScheduler, raw Electron IPC, fs, and Node handles.
- Clarified first-wave core plugin manifests are desktop-only unless explicitly mobile-tested.
- Added EventBus emission namespace guidance for v0 bundled/core plugins.


## Prometheus Strict gate lock

Locked decisions:
- approve the documented package graph and import boundaries;
- use a broad typed `ZoridPluginContext` facade for plugin DX;
- no public generic `getService()` / service locator;
- allow private `CorePluginContext` only if unavoidable and documented as technical debt;
- approve framework-neutral DOM plugin UI ABI;
- approve manifest/platform policy and desktop-only first-wave core plugins unless mobile-tested;
- expose `FieldsAPI` and `DataViewsAPI` as public-prealpha experimental APIs;
- defer Neovim-level shell UI replacement to the future Plugin Power feature plan.
