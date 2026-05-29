# PRD — Live Preview Pass 2: Source-Backed Task and Replace-Preview Foundation

Status: Ralplan consensus approved  
Date: 2026-05-29  
Scope: Next implementation pass after Live Preview first pass and Pass 1.5. This pass hardens source-backed editing interactions and introduces the smallest safe replace-preview primitive. It explicitly avoids tables, properties, embeds, callouts, math widgets, image widgets, and Reading view parity.

## Requirements Summary

Zorid already has the editor ownership boundary, selection-aware Live Preview mark decorations, visible desktop styling, matcher hardening, and explicit task-marker deferral. The next pass should close the most important gap before block widgets: prove that a Live Preview affordance can mutate Markdown source safely through CodeMirror transactions, while preserving source reveal, history, autosave, and external synchronization invariants.

The target is **Live Preview Pass 2: Source-Backed Task and Replace-Preview Foundation**.

This pass has three product/architecture goals:

1. Add a source-backed task checkbox toggle that changes Markdown text, not DOM state.
2. Verify list/blockquote/task editing behavior that should already come from `@codemirror/lang-markdown` before adding any custom keymaps.
3. Add a minimal internal replace-preview primitive for one low-risk source marker family, proving the path from style-only marks toward actual Obsidian-like syntax hiding without taking on block widgets.

## RALPLAN-DR Summary

### Principles

1. Markdown source remains the only durable document model.
2. CodeMirror transactions/history own every source mutation.
3. Preview rendering must be selection/focus-aware and source-preserving unless an explicit command dispatches a text change.
4. Harden task/list/input behavior before block widgets.
5. Internal seams may prepare for richer renderer capabilities, but no public renderer API is stabilized in this pass.

### Decision Drivers

1. Deep research recommends task checkbox and input-command hardening before complex block widgets and tables.
2. Current repo evidence shows Pass 1 and much of Pass 1.5 are done, but task markers are still styling-only.
3. Current Live Preview is mark-only; a very small replace-preview slice is needed before callout/embed/table widgets can be designed responsibly.

### Viable Options

#### Option A — Task toggle + markdown keymap verification + one replace-preview primitive (preferred)

Approach: Add a command-first task checkbox toggle; optionally add a narrow click handler only if it remains transaction-backed and well tested. Add mounted-editor tests for Markdown list/blockquote/task continuation. Add an internal renderer capability for replace decorations and use it on one low-risk source-marker slice.

Pros:
- Follows the research-backed implementation order.
- Proves source-backed interaction before widgets.
- Keeps risk bounded to line/inline Markdown.
- Gives future block widgets a tested transaction/reveal foundation.

Cons:
- Still does not deliver tables, properties, embeds, or full syntax hiding.
- Requires careful test design around history and external `setText()`.
- Replace-preview scope may feel small if limited to one marker family.

#### Option B — Jump to block widgets now

Approach: Implement callout/code/math/embed widgets before checkbox interaction and replace-preview hardening.

Pros:
- More visually Obsidian-like in screenshots.
- Exercises widget architecture earlier.

Cons:
- Contradicts the deep-research recommended sequence.
- Builds on an unproven source-mutation/history layer.
- Risks selection/history/clipboard regressions before task/list basics are mature.

#### Option C — Parser/Lezer rewrite first

Approach: Replace regex matchers with syntax-tree-backed matching before interactions.

Pros:
- Better long-term architecture.
- Reduces regex false positives.

Cons:
- High internal churn with limited user-visible progress.
- Does not prove source-backed transactions.
- Can be prepared through internal seams without doing the rewrite now.

### Preferred option

Option A.

## Acceptance Criteria

### Source-backed task checkbox toggle

- `@zorid/editor` exposes an internal command/helper to toggle the task marker on the current task line between unchecked and checked states.
- The toggle dispatches a CodeMirror transaction that edits the Markdown source marker (`[ ]`, `[x]`, or `[X]`) and preserves unrelated text exactly.
- The command works when the selection/cursor is on the task marker or task line according to a documented pass-2 policy.
- The command is command-first. A pointer/click handler may be added only if it remains narrow, transaction-backed, and tested; otherwise click behavior is explicitly deferred.
- Undo/redo returns to the prior Markdown source text.
- Focused source reveal behavior still removes preview decoration for the active task range.
- External `MountedMarkdownEditor.setText()` remains silent by default; stale external replacement must not echo back as a user edit after a newer toggle. This pass does not promise protection against intentional external overwrites unless explicit versioning is added.
- Non-task lines are no-ops and do not mutate the document.

### Markdown input/keymap confidence

- Tests prove current `markdown()` composition provides expected list, task-list, and blockquote continuation behavior where CodeMirror supports it.
- If a desired behavior is absent, the implementation uses official CodeMirror-provided keymaps/extensions already in dependencies before considering custom commands.
- No custom Enter/Backspace/list continuation command is introduced without a failing regression test and a narrow passing implementation.

### Replace-preview foundation

- `packages/editor/src/live-preview` supports an internal distinction between mark-only ranges and replace/widget-capable preview ranges without exposing a public API.
- Implement exactly one low-risk replace-preview slice by default: inactive inline-code backtick delimiter hiding. Use inactive heading marker prefix hiding only as a documented fallback if inline-code delimiter tests reveal unacceptable brittleness.
- Replace-preview is selection/focus-aware: raw source is visible when focused selection intersects the source range.
- Replace-preview does not change `EditorState.doc`.
- Tests cover active/inactive toggling, source preservation, adjacent ranges, and undo/history noninterference.
- The implementation leaves a clear seam for future `Decoration.widget`, `Decoration.replace`, and `EditorView.atomicRanges` use, but does not implement block-widget atomic ranges unless needed by the chosen tiny slice.

### Matcher and architecture boundaries

- New code remains under `packages/editor/src/live-preview` unless minor desktop styling changes are needed.
- Renderer/matcher internals remain private/experimental and are not added to `packages/platform-api` as public plugin API.
- Regex matcher fixes are allowed only when directly needed by the pass-2 tests; no broad parser rewrite.
- Tables, properties/frontmatter visual editor, embeds, image/PDF rendering, callout widgets, math rendering, and Reading view parity remain out of scope.

### Regression protection

- Existing editor Live Preview primitive tests remain green.
- Existing editor package wiring tests remain green.
- Existing desktop markdown autosave and desktop vault editor tests remain green.
- Import-boundary rules remain green.
- Editor package typecheck remains green.

## Implementation Steps

1. **Add task marker source helpers**
   - Define internal task marker parsing utilities under `packages/editor/src/live-preview` or a sibling editor command module.
   - Locate the current line and detect `^\s*[-*+]\s+\[[ xX]\]` markers.
   - Return the exact marker bracket range and next marker text without scanning unrelated document regions.

2. **Implement command-first checkbox toggle**
   - Add an editor-owned command/helper that receives an `EditorView` and dispatches a text replacement transaction.
   - Prefer unchecked → checked as `[ ]` → `[x]`; preserve `[X]` handling by normalizing or documenting the chosen policy.
   - Keep non-task invocation a no-op.
   - Do not add a general widget/event subsystem.

3. **Test task toggle source/history behavior**
   - Add focused tests for unchecked→checked, checked→unchecked, unrelated text preservation, no-op non-task lines, undo/redo, and source reveal around active task markers.
   - Add mounted-editor test coverage that external silent `setText()` does not echo stale changes after a toggle.

4. **Verify Markdown keymap behavior before custom input work**
   - Add mounted-editor tests for Enter/Backspace behavior on unordered lists, task lists, and blockquotes.
   - If tests show current `markdown()` behavior is sufficient, document that no custom keymap is added.
   - If a gap exists, compose only an official CodeMirror extension/keymap already available through dependencies and test it.

5. **Introduce internal replace-preview capability**
   - Extend the internal Live Preview range/build model minimally so a renderer can request mark or replace behavior.
   - Keep root package re-exports experimental and avoid platform API changes.
   - Add tests for deterministic building and source preservation.

6. **Implement one low-risk replace-preview renderer slice**
   - Default target: inactive inline-code delimiter hiding, because the matched source range is compact and already covered by inline code tests.
   - Fallback target: inactive heading marker prefix hiding only if inline-code delimiter mapping proves brittle in tests and the brittleness is documented.
   - Keep the slice small; do not attempt bold/italic/link replacement in this pass.

7. **Run targeted and broad-enough verification**
   - Targeted tests: editor Live Preview primitives, new task toggle tests, new keymap tests, editor package wiring, desktop Live Preview styles if CSS changes.
   - Regression tests: desktop markdown autosave and desktop vault editor.
   - Static checks: editor typecheck, import boundaries, full typecheck/lint if feasible.

## Out of Scope

- Full Obsidian parity.
- Tables and table cell editor.
- Properties/frontmatter visual editor.
- Callout widgets/context menus.
- Embeds, images, PDFs, image resize handles.
- Math rendering.
- Reading view parity and Markdown post-processor adapter.
- Public third-party renderer API stabilization.
- Broad syntax-tree/Lezer parser migration.
- Mobile/touch-specific Live Preview behavior.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Checkbox toggle breaks history or source mapping | Use only CodeMirror transactions; add undo/redo and source-preservation tests. |
| Pointer/click checkbox work expands into a widget subsystem | Keep command-first; defer click if it exceeds narrow transaction-backed handling. |
| Replace decorations destabilize cursor mapping | Limit to one low-risk marker slice; reveal source on selection intersection; keep mark fallback available. |
| Regex hardening becomes parser rewrite | Only fix matcher behavior needed by explicit tests; defer Lezer migration. |
| Vue cache overwrites editor-owned state | Re-run autosave and mounted synchronization tests; keep external replacements silent by default. |
| Public API accidentally stabilizes | Keep range/build additions internal/experimental and out of platform API. |
| Scope creep into block widgets | Out-of-scope gate: no tables/properties/embeds/callouts/math/images in this pass. |

## Verification Steps

- `pnpm test -- tests/editor-live-preview-primitives.test.ts tests/editor-package-wiring.test.ts <new-task-toggle-test> <new-keymap-test> <new-replace-preview-test>`
- `pnpm test -- tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts`
- `pnpm test -- tests/desktop-live-preview-styles.test.ts` if desktop styling changes
- `pnpm --filter @zorid/editor run typecheck`
- `pnpm lint:boundaries`
- `pnpm typecheck`
- `pnpm lint`

## ADR

### Decision

Plan Live Preview Pass 2 around source-backed task checkbox toggling, Markdown keymap confidence tests, and one small replace-preview primitive before block widgets.

### Drivers

- The deep research recommends source-backed task interaction and input/command hardening before complex block widgets and tables.
- Repo evidence shows Live Preview first pass and most of Pass 1.5 are complete, but task markers remain styling-only.
- A tiny replace-preview slice is the lowest-risk way to move from mark-only styling toward true syntax hiding.

### Alternatives considered

- **Jump to block widgets now.** Rejected because it builds complex selection/history behavior on an unproven source-backed interaction layer.
- **Parser/Lezer rewrite first.** Rejected because it creates broad churn and delays the source-backed interaction proof; internal seams can preserve the migration path.
- **Task toggle only, no replace-preview.** Rejected because it leaves the mark-only Live Preview architecture untested for the next step toward syntax hiding.

### Why chosen

Option A gives the smallest complete next layer: users get a meaningful interactive task feature, maintainers get tests for Markdown editing behavior, and the editor gets a low-risk proof of replace-preview mechanics.

### Consequences

- Zorid still will not claim full Obsidian parity after this pass.
- Some regex matchers remain temporary.
- The first replace-preview behavior may be intentionally narrow and may not yet look like full syntax hiding.
- Future block widget work gets stronger transaction/history/reveal evidence.

### Follow-ups

1. Pass 3: first low-risk block preview shell, likely blockquote/callout or fenced code block style wrapper.
2. Pass 4: callout/code/math/simple embed widgets with activation state and atomic range tests.
3. Pass 5: properties/frontmatter subsystem.
4. Pass 6: table editor after mapping/history/clipboard tests mature.
5. Pass 7: Reading view parity and public renderer extension API design.

## Available-Agent-Types Roster

- `executor` — implementation owner for editor internals and tests.
- `test-engineer` — task toggle, keymap, undo/history, and replace-preview test design.
- `architect` — review of internal renderer capability and transaction boundaries.
- `critic` — scope-control and acceptance-criteria gate.
- `code-reviewer` — final diff review before merge.
- `verifier` — verification evidence and claim audit.
- `designer` — optional review only if visible task/replace styling changes.

## Follow-up Staffing Guidance

### Recommended `$ultragoal` path

Use `$ultragoal` as the default durable execution wrapper with sequential goals:

1. Task marker source helper + command-first toggle — `executor`, medium reasoning.
2. Task toggle/source/history tests — `test-engineer` + `executor`, medium reasoning.
3. Markdown keymap behavior tests and any needed official composition — `test-engineer`, medium reasoning.
4. Internal replace-preview capability + one renderer slice — `executor` + `architect` spot review, medium/high reasoning.
5. Regression verification and cleanup — `verifier` + `code-reviewer`, high reasoning.

### Recommended `$team` path

Use `$team` if parallel delivery is desired after Ultragoal creates the durable ledger:

- Lane A (`executor`, medium): task marker helpers and toggle command.
- Lane B (`test-engineer`, medium): task toggle/history/keymap tests.
- Lane C (`executor`, medium): replace-preview internals and one renderer slice.
- Lane D (`verifier`, high): targeted verification, import boundaries, and final evidence.

### Explicit `$ralph` fallback

Use `$ralph` only if a single persistent owner is intentionally preferred over durable goal tracking. The fallback should execute this PRD and the companion test spec exactly, with the stop condition being green targeted tests, editor typecheck, import boundaries, and documented gaps for any deferred click handler.

## Goal-Mode Follow-up Suggestions

- `$ultragoal` — default next step for durable sequential implementation of this plan.
- `$team` — good fit if you want task toggle, tests, and replace-preview work done in parallel under a coordinated verification path.
- `$ultragoal` + `$team` — best fit for parallelizable durable-goal delivery: Ultragoal owns the ledger/checkpoints while Team runs lanes.
- `$ralph` — fallback only for single-owner persistence.
