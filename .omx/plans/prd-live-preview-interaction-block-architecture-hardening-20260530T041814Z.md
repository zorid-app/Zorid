# PRD — Live Preview Interaction + Internal Block Architecture Hardening

Date: 2026-05-30T04:18:14Z
Status: Draft for RALPLAN consensus
Mode: RALPLAN-DR short

## Requirements Summary

Implement the next Live Preview hardening pass after the Lezer migration. The pass must make selection and clipboard behavior explicit and test-backed, then harden the private internal block architecture so existing code-block and callout widgets share a clearer source-backed projection pipeline.

This pass is not a visual feature expansion. It is an interaction and architecture pass whose product outcome is: users can select, copy/cut, and activate Live Preview projections without losing canonical Markdown source or destabilizing cursor behavior, and future first-party/custom block widgets have a private internal path to grow from.

## Grounding Evidence

- Live Preview should stay source-backed and selection-aware: `/home/tingk/agent-context/Zorid/live-editor/deep-research-report (1).md:5-11`.
- The research architecture calls for language layer, semantic renderer registry, activation state, input/command layer, and preview parity layer: `/home/tingk/agent-context/Zorid/live-editor/deep-research-report (1).md:134-144`.
- Testing should prioritize mapping, clipboard/history, and viewport/performance fixtures: `/home/tingk/agent-context/Zorid/live-editor/deep-research-report (1).md:406-416`.
- The prior pass6 discussion already identified this as the next pass: `/home/tingk/agent-context/Zorid/live-editor/pass6.md:90-118`.
- Current editor setup is centralized in `packages/editor/src/index.ts:129-157`.
- Current Lezer Markdown facade exists in `packages/editor/src/live-preview/markdown-language.ts:185-195`.
- Current syntax-tree range collector exists in `packages/editor/src/live-preview/syntax-tree-ranges.ts:98-150`.
- Current private block adapter exists in `packages/editor/src/live-preview/block-renderers.ts:14-51`.
- Current widget pipeline is viewport-bounded through `packages/editor/src/live-preview/extension.ts:117-164` and `packages/editor/src/live-preview/extension.ts:359-394`.
- Current clipboard coverage is source-slice fixture level, not a CM clipboard integration layer: `packages/editor/src/live-preview/source-text.ts:8-11`, `tests/editor-live-preview-clipboard.test.ts:13-37`.
- Current no-atomic-ranges policy is documented by test: `tests/editor-live-preview-widgets.test.ts:319-322`.

## RALPLAN-DR Summary

### Principles
1. Canonical Markdown source remains the only durable data model.
2. Selection and clipboard behavior are product correctness, not implementation details.
3. Internal architecture may generalize, but public/plugin API stability is explicitly out of scope.
4. Prefer test-locked behavior and small private extractions over broad rewrites.
5. Preserve Lezer/no-regex parser ownership and existing desktop editor behavior.

### Decision Drivers
1. **Interaction correctness:** cursor, selection, activation, copy/cut, and undo/redo must preserve source semantics.
2. **Future block scalability:** code blocks, callouts, and future first-party custom blocks should not diverge through unrelated special cases.
3. **Risk containment:** avoid tables/properties/public APIs until the internal block path is stable.

### Viable Options

#### Option A — Interaction-first hardening, then private block contract refinement (Recommended)
Approach: Start with failing tests for selection spans, clipboard/cut source preservation, activation boundaries, and atomic policy. Then extract/refine private block renderer/activation/clipboard seams only where tests force structure.

Pros:
- Directly addresses the user's stated priority: selection and clipboard.
- Keeps architectural changes grounded in existing code and tests.
- Avoids over-designing plugin APIs before first-party behavior is stable.

Cons:
- May leave the private block contract smaller than a future plugin system needs.
- Requires careful test design to avoid locking accidental implementation quirks.

#### Option B — Private block registry first, then interaction hooks
Approach: First design a larger internal registry including match/build/activate/clipboard policies, then port widgets and fill tests.

Pros:
- Produces a cleaner-looking architecture earlier.
- Makes future block families easier to describe.

Cons:
- Higher over-abstraction risk before selection/clipboard requirements prove the needed shape.
- Could miss concrete interaction bugs while refactoring internals.

#### Option C — Add one new custom block proof first
Approach: Add a timeline/calendar-style first-party block to force architecture needs.

Pros:
- Product-visible proof of block extensibility.
- Exercises future custom-block direction.

Cons:
- Premature: selection/clipboard/activation behavior for existing widgets is not yet sufficiently hardened.
- Adds feature scope while core interaction risk remains.

### Chosen option
Option A. It keeps user-prioritized selection and clipboard first, while still delivering the requested internal block architecture hardening as the second half of the same pass.

## Scope

### In scope
1. **Selection and mapping hardening**
   - Add/strengthen tests for selections spanning mark, replace, line, and widget ranges.
   - Cover cursor positions at start/end boundaries and mixed selections around inline code delimiters, task checkboxes, code-block widgets, and callout widgets.
   - Confirm pointer activation and keyboard selection leave canonical source unchanged except explicit source-backed commands.

2. **Clipboard/source preservation hardening**
   - Upgrade clipboard tests from helper-level source slicing to behavior-level coverage.
   - Attempt mounted or filter-level copy/cut coverage using CodeMirror clipboard seams; helper slicing alone is insufficient final evidence unless the implementation records a concrete Happy DOM/browser limitation and preserves equivalent command/filter tests.
   - Add CodeMirror clipboard output/input filter or command integration if tests show helper-level behavior is insufficient.
   - Cover copy/cut for inline code, task checkboxes, fenced code widgets, callout widgets, and mixed contiguous selections.

3. **Activation and atomic-range policy decision**
   - Add tests that express desired cursor/selection behavior around widgets, including cursor exactly at `activationTo`, cursor exactly after the widget/range end, and delete/backspace at both widget edges.
   - Decide whether to keep the current no-atomic-ranges policy or introduce `EditorView.atomicRanges` for selected widget ranges.
   - If atomic ranges are introduced, keep them private and test cursor motion/deletion semantics plus pointer activation after the atomic decision.

4. **Private internal block architecture hardening**
   - Add a private contract checkpoint after interaction tests but before refactor: define internal fields for source range, activation range, clipboard source policy, and optional atomic policy.
   - Refine `LivePreviewBlockRenderer` so code-block and callout widgets share one private match→widget→activation path.
   - Keep all block helpers private; do not export them through package root or `live-preview/index.ts` unless tests require an explicitly experimental internal export.
   - Move shared activation/source/clipboard metadata into private types if that reduces duplication.

5. **Viewport/performance fixture extension**
   - Extend large-document fixtures for mixed headings/tasks/code/callouts.
   - Ensure block hardening does not regress bounded widget scans or syntax-tree/no-regex gates.

### Out of scope
- Public third-party plugin/custom block API.
- Table editor or table structured widget.
- Properties/frontmatter visual editor.
- Reading-view parity adapter.
- Embeds/images/math widgets.
- Broad parser rewrite; the current Lezer migration should be preserved.
- New dependencies unless a narrow, documented blocker appears.

## Acceptance Criteria

1. Selection tests prove focused selections reveal or preserve raw source correctly across inline mark/replace ranges, task markers, code-block widgets, callout widgets, and mixed ranges.
2. Boundary tests cover start/end positions for widgets and inline replace ranges, including adjacent non-widget content.
3. Clipboard tests prove copy/cut source preservation for hidden syntax and widget-backed source; mixed selections return canonical Markdown where expected.
4. Atomic-range policy is explicit and test-backed: either no `atomicRanges` remains with expanded cursor/selection evidence, or private atomic ranges are introduced with cursor/deletion tests.
5. Code-block and callout widgets are adapted through a shared private block renderer path, with tests proving no public block API leakage through `live-preview/index.ts`, package root exports, or `packages/editor/package.json` export map.
6. Existing Lezer/no-regex parser ownership remains green.
7. Existing editor behavior remains green: primitives, blocks, callouts, widgets, task toggles, Markdown keymap, package wiring, desktop Live Preview styles, autosave/editor smoke tests as relevant.
8. Full verification target before completion: `pnpm lint`, `pnpm typecheck`, targeted Live Preview suites, and `pnpm test`; if full `pnpm test` cannot run, document the blocker and run the broadest equivalent targeted gate.

## Implementation Steps

1. **Test-first interaction gap expansion**
   - Files: `tests/editor-live-preview-selection-mapping.test.ts`, `tests/editor-live-preview-widgets.test.ts`, `tests/editor-live-preview-callouts.test.ts`, `tests/editor-task-toggle.test.ts`.
   - Add selection spans and boundary cases that currently matter for product behavior.
   - Include keyboard/pointer activation scenarios where Happy DOM can prove behavior.

2. **Test-first clipboard/source preservation expansion**
   - Files: `tests/editor-live-preview-clipboard.test.ts`, possible new mounted clipboard test file if cleaner.
   - Cover copy/cut source preservation for hidden inline syntax, task markers, code-block widgets, callout widgets, and mixed selections.
   - Attempt mounted or filter-level copy/cut behavior using CodeMirror clipboard seams; if not feasible in Happy DOM, document that limitation and prove an equivalent command/filter path.
   - Decide whether source slicing is enough or CM clipboard filters are needed.

3. **Atomic policy decision and implementation**
   - Files: `packages/editor/src/live-preview/extension.ts`, `packages/editor/src/live-preview/internal-types.ts`, `tests/editor-live-preview-widgets.test.ts`, selection tests.
   - Keep no-atomic-ranges only if expanded tests prove desired cursor behavior, including cursor exactly at/after activation boundaries and delete/backspace at both widget edges.
   - If introducing `EditorView.atomicRanges`, keep ranges private and generated from the same widget range source, and prove pointer activation remains source-backed.

4. **Private block architecture refinement**
   - Files: `packages/editor/src/live-preview/block-renderers.ts`, `packages/editor/src/live-preview/renderers.ts`, possible private module extraction.
   - Move code-block and callout widget metadata toward the shared private adapter.
   - Add block renderer tests for match→widget adaptation, activation metadata, source identity, dedupe, and public/private boundary.

5. **Viewport/performance and regression gates**
   - Files: `tests/editor-live-preview-performance-fixtures.test.ts`, broad Live Preview suites.
   - Extend fixtures for large mixed documents and ensure bounded scan behavior remains.
   - Run targeted then broad verification.

## Risks and Mitigations

- **Risk:** Over-generalizing a private registry into a premature public API.  
  **Mitigation:** Keep helpers private, enforce with tests, and document public API as non-goal.

- **Risk:** Atomic ranges improve keyboard movement but break source reveal expectations.  
  **Mitigation:** Decide through tests around cursor movement, selection, deletion, pointer activation, and source restoration.

- **Risk:** Clipboard filters may transform text unexpectedly for ordinary source selections.  
  **Mitigation:** Prefer exact source preservation; add negative tests for ordinary text and code/frontmatter suppression.

- **Risk:** Mounted clipboard behavior is hard to simulate in Happy DOM.  
  **Mitigation:** Test pure filter/command behavior plus mounted smoke where reliable; document any browser/e2e gap.

- **Risk:** Performance regresses when generalized block metadata collects more context.  
  **Mitigation:** Keep visible-range scan windows and expand large-doc fixtures before refactor completion.

## Verification Plan

Targeted first:

```sh
pnpm vitest run \
  tests/editor-live-preview-selection-mapping.test.ts \
  tests/editor-live-preview-clipboard.test.ts \
  tests/editor-live-preview-block-registry.test.ts \
  tests/editor-live-preview-widgets.test.ts \
  tests/editor-live-preview-callouts.test.ts \
  tests/editor-live-preview-performance-fixtures.test.ts
```

Regression gate:

```sh
pnpm vitest run \
  tests/editor-live-preview-no-regex-parsers.test.ts \
  tests/editor-live-preview-parser-facade.test.ts \
  tests/editor-live-preview-primitives.test.ts \
  tests/editor-live-preview-blocks.test.ts \
  tests/editor-live-preview-semantic-fixtures.test.ts \
  tests/editor-task-toggle.test.ts \
  tests/editor-markdown-keymap.test.ts \
  tests/editor-package-wiring.test.ts \
  tests/desktop-live-preview-styles.test.ts
```

Final gate:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

## ADR

### Decision
Run an interaction-first Live Preview hardening pass that prioritizes selection, clipboard/source preservation, activation/atomic policy, and private block architecture refinement.

### Drivers
- Selection and clipboard are core correctness for a source-backed Live Preview editor.
- The Lezer migration is complete enough for current syntax recognition; remaining risk is interaction semantics and scalable private architecture.
- Future block support needs common internal seams before public plugin/API design.

### Alternatives considered
- Registry-first refactor before interaction tests: rejected due to over-abstraction risk.
- New custom block proof first: rejected because it adds feature complexity before interaction behavior is locked.
- Broad public plugin API: rejected as premature and explicitly outside current pass.

### Why chosen
The chosen plan directly addresses the user's priority while preserving the research-backed staged path: harden selection/clipboard/history/viewport behavior before increasing block complexity or exposing plugin APIs.

### Consequences
- This pass may produce mostly tests/internal refactors rather than dramatic UI changes.
- It should make later custom blocks safer and cheaper.
- It may defer one first-party custom block proof if interaction/clipboard/atomic policy takes the full pass.

### Follow-ups
- After this pass, consider one tiny first-party custom block proof if internal block seams are stable.
- Later, plan tables/properties/embeds/math as separate passes with their own interaction and performance criteria.
- Public plugin API should wait until at least two first-party block families use the private registry successfully.

## Available Agent Types Roster

- `explore` / `explorer`: fast repo lookup and changed-surface mapping.
- `test-engineer`: selection, clipboard, and regression test design.
- `architect`: private block architecture, activation, atomic policy review.
- `executor`: implementation/refactor work.
- `verifier`: final gate and evidence validation.
- `code-reviewer`: post-implementation quality review.
- `git-master`: commit hygiene if needed.

## Follow-up Staffing Guidance

### Default durable goal path: `$ultragoal`
Use `$ultragoal` for sequential durable execution with checkpoints:
1. Goal 1: selection/mapping tests and fixes.
2. Goal 2: clipboard/source preservation tests and hooks/commands if needed.
3. Goal 3: atomic policy decision and implementation.
4. Goal 4: private block architecture refinement.
5. Goal 5: viewport/performance and full verification.

Suggested reasoning: executor medium, test-engineer medium, architect high for atomic/block policy, verifier high.

### Parallel path: `$team` + `$ultragoal`
Use Team if you want parallel delivery while Ultragoal owns durable checkpoints.

Potential lanes:
- Lane A (`test-engineer`): selection and clipboard fixtures.
- Lane B (`architect`/`executor`): activation/atomic and block contract design.
- Lane C (`executor`): code-block/callout adapter refactor.
- Lane D (`verifier`): performance/no-regex/regression gates.

Team verification path:
- Team proves targeted suites pass and reports changed files per lane.
- Ultragoal checkpoints the accepted evidence and runs final broad gates.

Launch hints:

```sh
# Durable default
$ultragoal .omx/plans/prd-live-preview-interaction-block-architecture-hardening-20260530T041814Z.md

# Parallel implementation with durable checkpoint owner
$team "Implement .omx/plans/prd-live-preview-interaction-block-architecture-hardening-20260530T041814Z.md with lanes for selection, clipboard, atomic/block architecture, and verification"
```

### Ralph fallback
Use `$ralph` only if a single persistent owner is explicitly preferred over durable Ultragoal checkpointing. Ralph is not the recommended default here.

## Goal-Mode Follow-up Suggestions

- `$ultragoal`: recommended default for executing this plan durably.
- `$team`: recommended if parallel implementation speed matters; pair with Ultragoal evidence checkpointing.
- `$performance-goal`: not primary, unless the pass narrows to measurable viewport/render latency optimization.
- `$autoresearch-goal`: not applicable; this is implementation planning, not a research deliverable.

## Architect Review Improvements Applied

- Added a private contract checkpoint for source range, activation range, clipboard source policy, and optional atomic policy.
- Strengthened clipboard evidence from helper-level slicing to attempted mounted/filter-level behavior or documented equivalent limitation.
- Clarified atomic boundary expectations at `activationTo`, after widget end, delete/backspace edges, and pointer activation.
- Added package export-map verification to the private block boundary criteria.
