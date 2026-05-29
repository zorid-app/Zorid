# PRD — Live Preview First Pass

Status: Ralplan draft  
Date: 2026-05-29  
Scope: First pass only: editor boundary, Live Preview core, MVP renderers, Markdown dialect foundation.

## Requirements Summary

Zorid needs an implementation-ready first pass toward Obsidian-style Live Preview. The pass should establish the architecture and prove source-backed cursor-aware preview behavior on simple Markdown elements, without attempting complex structured widgets.

The target behavior is not rich-text editing. Markdown text remains canonical; Live Preview is a CodeMirror 6 view-layer projection that decorates, replaces, or styles selected syntax when inactive and reveals source when cursor/selection intersects the element.

## Grounding Evidence

- `plan/deep-research-report.md:5-9` — Obsidian Source, Live Preview, and Reading view are separate display paths.
- `plan/deep-research-report.md:28-58` — Live Preview mostly hides syntax when inactive and reveals source on cursor entry, with exceptions for complex widgets.
- `plan/deep-research-report.md:115-121` — Live Preview is local editor decorations/widgets; Reading view is a separate render path.
- `plan/deep-research-report (1).md:5-11` — recommended implementation is a selection-aware renderer registry using CodeMirror 6 decorations/widgets, `StateField`, `ViewPlugin`, and transaction-safe mapping.
- `plan/deep-research-report (1).md:374-416` — recommended implementation order is minimal core first, then task/list/block widgets, tables/properties later, with parser/mapping/history/performance tests.
- `docs/product/frontend.md:132-143` — `packages/editor` should own CodeMirror lifecycle and extension support while avoiding whole-document Vue state mirroring.
- `apps/desktop/src/renderer/src/components/MarkdownEditor.vue:2-38` — the desktop Vue component currently owns CodeMirror mounting directly.
- `apps/desktop/src/renderer/src/App.vue:119-120,904-906` — current desktop app stores full editor text in Vue and passes it down.
- `packages/editor/src/index.ts:19-43` — current editor package owns a headless `EditorState` but not a mounted `EditorView`.
- `packages/platform-api/src/index.ts:130-140,306-312` — existing API has editor extension and Markdown processor contribution surfaces.
- `apps/desktop/src/main/runtime.ts:1016-1025` — editor extensions are registered; Markdown processors are currently no-op.

## RALPLAN-DR Summary

### Principles
1. Markdown source is the only durable document model.
2. CodeMirror owns editor state, transactions, selection, history, and document rendering.
3. Vue owns shell/layout state, not the full live editor document.
4. First pass proves architecture with low-risk elements before complex widgets.
5. Public plugin API stability is not promised by this pass; internal seams should be shaped for future stabilization.

### Decision Drivers
1. Preserve current user-visible edit/save/autosave behavior while moving toward the documented package boundary.
2. Minimize selection/history risk by avoiding tables/properties/embeds/callouts in pass 1.
3. Create testable editor primitives that future renderers can reuse.

### Viable Options

#### Option A — Thin architectural first pass with simple renderers (preferred)
Approach: Move mounted CM6 ownership into `packages/editor`, add internal renderer registry/selection-aware decorations, implement simple inline/line renderers, add dialect matchers for links/tags/tasks.

Pros:
- Aligns with research and repo architecture.
- Produces visible user-facing progress without taking on tables/properties complexity.
- Creates reusable primitives and tests for future widgets.
- Keeps risk bounded.

Cons:
- Does not deliver full Obsidian parity.
- May temporarily retain a compatibility text callback from editor to shell for autosave.
- Some API naming may be revised in later passes.

#### Option B — Boundary-only refactor, no Live Preview renderers
Approach: Only move CM6 mounting into `packages/editor`, preserving plain Markdown editing.

Pros:
- Lowest implementation risk.
- Simplest verification.

Cons:
- Does not prove the core Live Preview state machine.
- Delays discovery of selection/decorations design issues.
- Gives little product-facing value beyond cleanup.

#### Option C — Broad first pass including widgets/tables/properties
Approach: Implement editor boundary plus complex block widgets and properties UI in the same pass.

Pros:
- Bigger visible step toward Obsidian parity.

Cons:
- Contradicts research guidance to do tables/properties later.
- Raises selection/history/clipboard risks before primitives are proven.
- Increases chance of private shell shortcuts and API churn.

### Preferred option
Option A. It is the best match for the current repo stage and the research evidence.

## Acceptance Criteria

### Editor boundary
- `packages/editor` provides a mounted editor creation surface that owns `EditorView` lifecycle.
- The desktop Vue `MarkdownEditor` component becomes a thin host wrapper and no longer constructs `EditorState`/`EditorView` directly.
- Existing open/edit/save/autosave behavior remains covered by tests.
- `@zorid/editor` declares or otherwise owns the CodeMirror package dependency/export wiring needed for mounted `EditorView` creation; dependency ownership is not left implicit in the root app.
- The implementation does not introduce forbidden package imports under `scripts/check-import-boundaries.mjs`.
- Ownership invariant: after the refactor, CodeMirror document state is source of truth. Any remaining Vue full-text state is explicitly treated as a temporary autosave/display cache with one-way synchronization from editor updates and guarded external replacement semantics.

### Live Preview core
- `packages/editor` exposes internal renderer registration/composition primitives for first-party renderers.
- The core can decide active/raw versus inactive/preview behavior based on current selection intersection and editor focus state.
- When the editor is focused, intersecting cursor/selection ranges reveal raw source; when not focused or not intersecting, eligible ranges may render preview decorations according to renderer policy.
- Renderer APIs accept visible-range or viewport context, and tests prove deterministic range filtering even if the first implementation still uses a conservative/full-doc fallback for tiny documents.
- Source text remains unchanged by preview rendering alone.

### MVP renderers
- At least these low-risk renderers are implemented and tested: heading styling/source reveal, inline code styling/source reveal, Markdown/wiki link styling/source reveal, tag styling/source reveal.
- Task checkbox toggle is included only if it can be made source-backed and testable without destabilizing pass 1; otherwise it is explicitly deferred with tests documenting the gap.
- Tables, Properties/frontmatter visual editor, embeds, callouts, and Reading view parity are not included.

### Markdown dialect foundation
- A small matcher/parser utility layer exists for first-pass Zorid/Obsidian-ish syntax: wiki links, Markdown links, tags, task markers, heading ranges.
- The API shape does not require renderer code to directly mutate CodeMirror content DOM.
- Future parser-extension migration remains possible without changing renderer call sites wholesale.
- Existing `EditorExtensionContribution.extension: unknown` handling is explicit for this pass: implementation either narrows it to CM6 `Extension` in platform types with API/test updates, or keeps it unknown but type-guards and ignores/reports unsupported values before composition.

### Verification
- Unit tests cover renderer matching, active/inactive selection decisions, and source-backed text invariants.
- Desktop integration tests cover open/edit/autosave still writing the latest Markdown source.
- Typecheck, lint, tests, and import-boundary checks pass for changed files.

## Implementation Steps

1. **Create the editor host boundary in `packages/editor`**
   - Add a DOM-mountable editor factory/service that creates/destroys `EditorView`.
   - Keep `MarkdownEditorHandle` as the document/service abstraction, or adapt it so mounted views and headless handles share the same source/update contract.
   - Add an editor-owned change subscription that emits lightweight updates for autosave.

2. **Convert desktop `MarkdownEditor.vue` into a thin host**
   - Remove direct CM6 construction from the Vue component.
   - Pass host element and callbacks into `packages/editor`.
   - Preserve `Mod-s` save behavior through editor keymap or host callback.
   - Keep any temporary full-text callback only as a compatibility bridge, not as architectural truth.

3. **Add internal Live Preview renderer primitives**
   - Define renderer match/build contracts in `packages/editor`.
   - Add active-range detection based on selection intersection and focus state.
   - Add a `ViewPlugin` for lightweight decorations and reserve `StateField` extension points for later block widgets.
   - Accept visible-range context in renderer building, with deterministic tests for range filtering.
   - Ensure preview decorations do not change document text.

4. **Implement first-pass matchers/renderers**
   - Match headings, inline code, markdown links, wiki links, tags, and optionally task markers.
   - Apply styling/replacement only when inactive; reveal raw source when active.
   - Keep task checkbox toggle source-backed if included.

5. **Wire extension composition and first-party renderer registration**
   - Compose base Markdown support, keymaps, update listeners, and live preview extension set in `packages/editor`.
   - Make CodeMirror dependency/export ownership explicit in `@zorid/editor`.
   - Preserve existing plugin `registerExtension` storage; do not stabilize a third-party renderer API yet.
   - Define pass-1 behavior for `EditorExtensionContribution.extension: unknown`: narrow to CM6 `Extension` with tests, or type-guard/ignore unsupported values with diagnostics.
   - Document internal versus future-public seams in code comments or package docs if needed.

6. **Add tests and update existing tests**
   - Add tests for matcher ranges and active/inactive rendering decisions.
   - Add integration tests that mount the editor in a DOM-like environment and verify source text after edits.
   - Keep autosave regression tests passing.
   - Add import-boundary coverage if package imports change.

## Out of Scope

- Tables and table cell editor.
- Properties/frontmatter visual editor.
- Callout widgets.
- Embed/image/PDF rendering.
- Reading view renderer parity.
- Public third-party renderer API stability.
- Mobile/touch-specific Live Preview behavior.
- Full Obsidian parity claims.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Vue still mirrors the full doc during transition | Allow a temporary compatibility bridge only with explicit one-way synchronization rules; mark CodeMirror document as source of truth and avoid adding more global doc state. |
| Selection mapping breaks editing | Start with low-risk inline/line renderers; reveal raw source on intersection; add focused mapping tests. |
| Renderer registry becomes public API too soon | Keep first-pass registry internal or explicitly experimental. |
| Direct DOM mutation causes CM6 instability | Require renderers to return CM6 decorations/widgets only. |
| Checkbox toggle mutates source incorrectly | Include checkbox only if source-backed tests are solid; otherwise defer. |
| Package boundary violations | Run `pnpm lint:boundaries` and keep editor implementation under `packages/editor`. |
| Extension composition ambiguity | Decide and test whether platform API narrows editor extensions to CM6 `Extension` or type-guards unknown contributions before composition. |
| Focus-state mismatch with research model | Include focus-aware rendering policy and tests so syntax hiding is not driven by selection alone. |

## Verification Steps

- `pnpm lint:boundaries`
- `pnpm --filter @zorid/editor run typecheck`
- tests proving `@zorid/editor` dependency/export wiring for mounted editor creation
- targeted Vitest tests for editor live preview primitives
- `pnpm test -- tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts <new-editor-tests>`
- `pnpm typecheck`
- `pnpm lint`

## ADR

### Decision
Adopt Option A: a thin first pass that moves mounted CodeMirror ownership into `packages/editor`, adds internal Live Preview renderer primitives, implements simple source-backed inline/line renderers, and establishes Markdown dialect matcher utilities.

### Drivers
- The research reports identify selection-aware CM6 decorations/widgets as the maintainable model.
- Current repo architecture already assigns CodeMirror ownership to `packages/editor`.
- Complex widgets are high-risk before selection/history primitives are proven.

### Alternatives considered
- Option B: boundary-only refactor. Rejected because it does not prove the Live Preview state machine.
- Option C: broad widgets/tables/properties pass. Rejected because it is too risky and contradicts phased research guidance.

### Why chosen
Option A gives the smallest useful vertical slice: it corrects the editor ownership boundary and proves the core source-backed preview model with testable, low-risk Markdown elements.

### Consequences
- Zorid gets visible editor progress without full Obsidian parity.
- Implementation must explicitly resolve temporary Vue text-cache synchronization and editor extension composition semantics.
- Some temporary compatibility plumbing may remain between editor and desktop shell.
- Future passes can add block widgets, tables, Properties, and Reading view parity using the same primitives.

### Follow-ups
- Pass 2: block widgets for callouts/code blocks/simple embeds.
- Pass 3: Properties/frontmatter subsystem.
- Pass 4: table editor after mapping/history/clipboard tests mature.
- Pass 5: Reading view parity and public renderer extension API design.

## Available-Agent-Types Roster

- `architect` — boundary review and API shape.
- `critic` — plan/testability/risk gate.
- `executor` — implementation of editor package and desktop wrapper.
- `test-engineer` — renderer/mapping/autosave test strategy.
- `verifier` — final evidence and quality gate.
- `code-reviewer` — post-implementation review.
- `explore` — quick repo lookups during execution.
- `designer` — later visual styling/interaction review for preview affordances.

## Follow-up Staffing Guidance

### Recommended `$ultragoal` path
Use `$ultragoal` as the default durable execution wrapper. Suggested sequential goals:
1. Editor boundary refactor — `executor`, medium reasoning.
2. Live Preview primitives — `executor` + `architect` spot review, medium/high reasoning.
3. MVP renderers — `executor`, medium reasoning.
4. Tests/verification — `test-engineer` + `verifier`, medium/high reasoning.

### Recommended `$team` path
Use `$team` if parallel delivery is desired:
- Lane A (`executor`, medium): `packages/editor` mounted editor factory and extension composition.
- Lane B (`executor`, medium): desktop wrapper integration and autosave preservation.
- Lane C (`test-engineer`, medium): renderer/mapping/autosave tests.
- Lane D (`architect` or `code-reviewer`, high): boundary/API review.

### `$ralph` fallback
Use `$ralph` only if the user explicitly wants a persistent single-owner implementation/verification loop instead of Ultragoal's durable ledger. It is not the default follow-up.

## Goal-Mode Follow-up Suggestions

- `$ultragoal` — recommended default for implementing this plan with durable checkpointing.
- `$team` + `$ultragoal` — recommended if faster parallel implementation is desired while preserving durable goal checkpoints.
- `$performance-goal` — not primary for this pass; use later when viewport/rendering benchmarks become the main goal.
- `$autoresearch-goal` — not needed; research evidence already exists in the two deep research reports.

## Team Launch Hints

```bash
$team "Implement .omx/plans/prd-live-preview-first-pass-20260529T041049Z.md with lanes: editor boundary, desktop wrapper, tests, architecture review. Stop after verification evidence; do not include tables/properties/embeds/callouts."
```

or durable parallel path:

```bash
$ultragoal ".omx/plans/prd-live-preview-first-pass-20260529T041049Z.md" && $team "Execute the approved Live Preview first-pass plan and report checkpoint-ready evidence to Ultragoal."
```

## Team Verification Path

Team must prove:
- changed files stay within planned touchpoints;
- editor source text remains canonical;
- autosave/open/save tests pass;
- renderer tests prove inactive preview and active source reveal;
- lint/typecheck/import-boundary checks pass;
- no tables/properties/embeds/callouts are implemented in pass 1.

## Plan Changelog

- Initial Ralplan draft created from repo-grounded analysis and the two deep research reports.
- Applied Architect ITERATE feedback: dependency/export wiring, source-of-truth invariant, focus-aware preview policy, visible-range testability, and explicit `EditorExtensionContribution.extension` handling.
- Applied Critic approval improvements: first execution checkpoint must decide extension typing, task checkbox remains optional/deferred unless source-backed tests are solid, and execution should land in small verification checkpoints.
