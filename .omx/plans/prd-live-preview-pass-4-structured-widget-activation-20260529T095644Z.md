# PRD — Live Preview Pass 4: Structured Widget Activation Foundation

Status: RALPLAN consensus approved  
Date: 2026-05-29  
Scope: Next implementation pass after Live Preview Pass 3 blockquote line-preview foundation. This pass introduces the first private structured block-widget activation path for Live Preview while preserving source truth and deferring tables, properties/frontmatter, embeds/images/PDFs, math rendering, Reading parity, and public plugin API stabilization.

## Requirements Summary

Zorid now has a CodeMirror-owned Markdown editor, selection/focus-aware preview decorations, scoped desktop styling, source-backed task toggling, one replace-preview primitive, and a low-risk blockquote line-preview shell. The two deep research reports recommend the next architectural step as structured editor-local widgets: keep Markdown source canonical, use CodeMirror decorations/widgets rather than Reading HTML, and introduce activation/mapping/history seams before attempting complex widgets like tables or properties.

The target is **Live Preview Pass 4: Structured Widget Activation Foundation**.

The pass should prove one structured block widget can exist inside the current Live Preview pipeline without breaking current invariants:

1. Markdown source remains the only durable document model.
2. Preview remains viewport-bounded and selection/focus-aware.
3. Inactive widget preview can become active raw-source editing without losing document text.
4. Durable widget edits, if any, happen only through CodeMirror transactions.
5. Widget infrastructure remains private and minimal until more renderer types justify public API design.

Recommended first structured widget: **fenced code block preview shell**. It is lower risk than callouts, embeds, tables, and properties because fenced code is already a standard Markdown construct, current code already has fenced-code context helpers, and the pass can exercise `WidgetType`, block `Decoration.replace`, activation, source reveal, and desktop styling without syntax highlighting, copy toolbar, language loaders, or nested structured editing.

## Grounding Evidence

- `plan/deep-research-report.md:19-24` distinguishes Source mode, Live Preview, and Reading view as separate paths.
- `plan/deep-research-report.md:56-72` describes Live Preview as focus/selection-aware syntax hiding/source reveal.
- `plan/deep-research-report.md:115-119` says Live Preview is editor-local decorations/widgets, not full Reading HTML rendering.
- `plan/deep-research-report (1).md:132-144` recommends language, renderer registry, activation state, input/command, and preview parity layers.
- `plan/deep-research-report (1).md:366-370` warns widget state must not replace Markdown source; persistent edits should be transactions.
- `plan/deep-research-report (1).md:374-388` recommends widgets after inline/keymap/task foundations and before properties/Reading parity.
- `plan/deep-research-report (1).md:390-416` recommends parser fixtures plus mapping, clipboard/history, and viewport/performance tests.
- `packages/editor/src/index.ts:115-129` wires `markdown()`, history, extension contributions, and Live Preview extension.
- `packages/editor/src/live-preview/types.ts:22-42` has a private experimental renderer seam and `mark`/`replace` distinction.
- `packages/editor/src/live-preview/extension.ts:37-42` has focused source reveal by selection intersection.
- `packages/editor/src/live-preview/extension.ts:81-132` currently builds viewport-bounded decorations through `ViewPlugin`.
- `packages/editor/src/live-preview/renderers.ts:126-192` has current default mark/replace/line renderers but no `WidgetType`/block widget path.
- `packages/editor/src/live-preview/markdown-code-context.ts:17-72` already detects fenced/indented code ranges for suppression contexts.
- `packages/editor/src/live-preview/task-toggle.ts:16-61` proves source-backed mutations can use CodeMirror transactions.
- `tests/editor-live-preview-blocks.test.ts:20-106` proves blockquote line-preview foundation is implemented and tested.
- `tests/editor-task-toggle.test.ts:57-168` proves source-backed task toggles, undo/redo, and source reveal are tested.
- `apps/desktop/src/renderer/src/styles.css:476-522` owns scoped host styling for current Live Preview classes.

## RALPLAN-DR Summary

### Principles

1. **Source is truth**: Markdown text remains canonical; widget DOM is projection, not persisted state.
2. **Activation before richness**: prove source reveal, widget activation, and mapping before visual feature breadth.
3. **One structured widget proof**: implement one low-risk fenced-code shell, not a widget platform rewrite.
4. **Private seams first**: keep new renderer/build/widget APIs internal until multiple first-party widgets validate the shape.
5. **Tests define maturity**: mapping, source preservation, undo/history boundaries, and viewport behavior matter more than screenshot similarity.

### Decision Drivers

1. Deep research recommends moving from selection-aware inline/task foundations into block widgets before properties, tables, and Reading parity.
2. Repo evidence shows Pass 3 line/block preview exists, but there is no `WidgetType`, activation state, atomic range, or structured widget lifecycle yet.
3. Fenced code blocks exercise the needed CM6 widget mechanics with less semantic and interaction scope than callouts, embeds, tables, or properties.

### Viable Options

#### Option A — Fenced code block structured shell (preferred)

Approach: Add a private fenced-code block renderer that replaces inactive complete fenced-code source ranges with a minimal `WidgetType` shell and activates/reveals source when selection or pointer activation enters the range.

Pros:
- Exercises real `WidgetType` and block `Decoration.replace` mechanics.
- Uses standard Markdown and existing fenced-code helpers.
- Avoids OFM callout semantics, table cell editors, media loading, and metadata subsystems.
- Provides the clearest stepping stone toward callout/code/math/embed widgets.

Cons:
- Less visibly Obsidian-specific than callouts.
- Syntax highlighting/copy toolbar must be explicitly deferred to avoid scope creep.
- Requires careful source-range boundary tests around incomplete fences and nested backticks.

#### Option B — Callout structured shell first

Approach: Add a simple `> [!type]` callout widget shell with title/type rendering but no context menu or collapse behavior.

Pros:
- More product-visible and Obsidian-like.
- Directly starts OFM block-widget work.
- Good foundation for future callout interactions.

Cons:
- Requires parser semantics beyond vanilla blockquote.
- Risks entangling widget activation with title editing, collapse, nested content, and callout type/theme behavior.
- Higher risk of rewriting the just-completed blockquote line policy too soon.

#### Option C — Activation/state refactor only, no visible widget

Approach: Add private StateField/StateEffect/renderer build abstractions and tests, but no default visible widget renderer.

Pros:
- Lowest visual regression risk.
- Lets architecture settle before UI behavior.
- Useful if widget mechanics prove too broad for one pass.

Cons:
- No product-visible progress.
- Abstractions risk becoming speculative without a real renderer.
- Does not prove desktop styling or mounted widget lifecycle.

### Preferred option

Option A. Implement a fenced-code block structured shell as the smallest real widget proof, with explicit guardrails against syntax highlighting, copy toolbar, language loading, table/properties/callout scope, and public API stabilization.

## Acceptance Criteria

### Structured widget model

- `packages/editor/src/live-preview` contains a private widget-capable renderer/build path that can produce a CodeMirror block widget decoration for a complete fenced code block range.
- The existing `LivePreviewRenderer` seam remains experimental/private; no `packages/platform-api` public renderer API is added.
- Widget-specific types should live in `internal-types.ts` or a private module by default; avoid changing exported `types.ts` or root exports unless implementation tests prove it is unavoidable.
- The implementation introduces only the minimal new abstractions needed for this pass, such as an internal range kind/build result for `widget` or a small private `BlockWidgetRenderer` adapter.
- The widget class extends CodeMirror `WidgetType` and implements stable identity behavior through `eq()` or equivalent minimal comparison.
- Widget DOM uses safe DOM construction, not arbitrary `innerHTML` from Markdown content.
- The widget path does not mutate `EditorState.doc` while rendering.

### Fenced code widget behavior

- A complete fenced code block using backtick or tilde fences of length at least three can be matched as one block widget range.
- The opening fence, optional info string, code body, and closing fence are preserved in source and represented in the activation range.
- Inactive/unfocused fenced code blocks render as a minimal shell under a class such as `z-live-preview-code-block-widget`.
- The shell may show the language/info string and a preformatted body preview, but no syntax highlighting, copy button, toolbar, line numbers, or language-loader dependency is added in this pass.
- Incomplete/unclosed fences are not converted into widgets unless the code explicitly documents and tests a safe fallback; default should be raw source for incomplete fences.
- Indented code blocks remain raw/source-like in this pass unless existing suppression helpers need minor fixture coverage.
- Existing inline, link, tag, task, and blockquote renderers are suppressed inside fenced code and continue to work outside fenced code.

### Activation and source reveal

- Focused selection intersecting a fenced code widget activation range suppresses the widget and reveals raw Markdown source.
- Pointer activation on an inactive widget dispatches a narrow transaction/effect or selection update that reveals source at a deterministic source position, preferably the opening fence or first code content position.
- Activation is private to `packages/editor/src/live-preview`; if `StateField`/`StateEffect` is introduced, it is narrowly scoped to active widget ranges and tested.
- `EditorView.atomicRanges` is added only if the widget remains replaced while inactive/active cursor navigation would otherwise enter hidden source unpredictably. If added, tests must cover cursor/deletion boundary behavior; if not added, the plan must document why selection-intersection reveal is sufficient for this pass.
- Moving selection outside the fenced code range restores inactive widget preview.
- Source text is exact before/after focus, selection, pointer activation, and preview restoration.

### Source-backed mutation and history policy

- This pass does not need to implement durable code-block edits from inside widget DOM. If any durable edit is added, it must dispatch a CodeMirror transaction and have undo/redo tests.
- Widget-local UI state, if any, is ephemeral unless explicitly represented by a tested `StateEffect`/history integration.
- Existing task toggle undo/redo tests remain green.

### Desktop styling

- Desktop adds scoped styles under `.markdown-editor` for the code block widget class and any internal widget sub-elements.
- Styles use existing tokens and do not target `.markdown-preview-view`, global `pre`, global `code`, or global `blockquote` for this pass.
- Existing Live Preview style scoping test is extended to include the new widget class.

### Regression and compatibility

- Existing Pass 1/1.5/2/3 tests remain green:
  - editor Live Preview primitives
  - editor Live Preview blocks
  - editor task toggle
  - editor Markdown keymap behavior
  - editor package wiring
  - desktop Live Preview styles
  - desktop markdown autosave
  - desktop vault editor
- Editor package typecheck remains green.
- Import-boundary lint remains green.
- Full typecheck/lint/test should pass before execution completion.

### Explicit non-goals

- No table widget or table cell editor.
- No properties/frontmatter visual editor.
- No callout widget, callout type selector, context menu, or collapse behavior.
- No embeds, images, PDFs, media previews, or image resize handles.
- No math rendering.
- No syntax highlighting, copy toolbar, code actions, or language-loader dependency for code blocks.
- No Reading view parity or Markdown post-processor adapter.
- No public third-party renderer API stabilization.
- No broad regex-to-Lezer parser rewrite.
- No mobile/touch-specific behavior.

## Implementation Steps

1. **Lock widget behavior with tests first**
   - Add `tests/editor-live-preview-widgets.test.ts`.
   - Cover complete backtick and tilde fences, info strings, body text preservation, incomplete fences staying raw, fenced-code suppression of inline/task/tag/link renderers, active focused source reveal, and restoration after selection leaves.
   - Add mounted-editor tests proving widget DOM appears inactive, pointer activation or selection reveal suppresses it, and `editor.getText()` remains exact.

2. **Introduce minimal private widget types**
   - Prefer `packages/editor/src/live-preview/internal-types.ts` or a new private module for widget-specific types; avoid changing exported `types.ts` unless tests prove no private path can support the implementation.
   - Implement a minimal `WidgetType` subclass for fenced code shell in a new private module such as `packages/editor/src/live-preview/widgets.ts` or `code-block-widget.ts`.
   - Keep existing public package-root exports unchanged unless in-repo tests require a narrow experimental export.

3. **Implement fenced code block range matching**
   - Reuse or carefully extend `markdown-code-context.ts` to return complete fenced code block source ranges with fence metadata.
   - Do not reuse `markdownFencedCodeRanges()` directly for widget conversion without distinguishing complete vs open fences; current suppression behavior may include open fences through the scan window, while widgets must require complete safe ranges by default.
   - Do not convert incomplete fences to widgets by default.
   - Keep indented code blocks raw and suppression-only unless fixture tests require a tiny helper adjustment.

4. **Wire widget decoration building**
   - Update `extension.ts` to build `Decoration.replace({ widget, block: true })` or equivalent CM6 block widget decorations for inactive fenced code ranges.
   - Preserve current mark/replace/line behavior and ordering for existing renderers.
   - Add mandatory deterministic ordering/suppression tests proving fenced-code widget ranges suppress nested inline/task/tag/link/blockquote renderers inside the block while leaving outside ranges intact.

5. **Add activation/source reveal path**
   - Ensure focused selection intersection suppresses the widget and shows raw source.
   - Add a pointer/mousedown activation path only for the widget shell if needed to create a deterministic source reveal position.
   - Use a private `StateEffect`/`StateField` only if selection-only activation cannot express pointer reveal cleanly; document and test the chosen approach.
   - Add `atomicRanges` only if tests demonstrate it is needed for hidden widget range cursor/deletion behavior.

6. **Add scoped desktop styling**
   - Update `apps/desktop/src/renderer/src/styles.css` near current Live Preview styles.
   - Extend `tests/desktop-live-preview-styles.test.ts` to require `.markdown-editor` scoping for the new widget class.
   - Keep styles token-based and avoid Reading/global selectors.

7. **Run targeted verification**
   - `pnpm vitest run tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-live-preview-primitives.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-package-wiring.test.ts tests/desktop-live-preview-styles.test.ts tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts`
   - `pnpm --filter @zorid/editor run typecheck`
   - `pnpm lint:boundaries`

8. **Run broad verification before completion**
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
   - Optional: `pnpm desktop:build` if widget host styling or mounted editor behavior changes materially.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Widget infrastructure becomes a speculative rewrite | Implement exactly one fenced-code shell and only abstractions directly required by tests. |
| Code block scope creeps into syntax highlighting/copy toolbar | Make those explicit non-goals; tests should only assert shell/source behavior. |
| Replaced widget breaks cursor/selection mapping | Test focused source reveal, pointer activation, boundary positions, and restoration. Add atomic ranges only if needed. |
| Widget DOM becomes alternate source of truth | Keep durable edits out of widget DOM; any mutation must be a CodeMirror transaction with undo/redo coverage. |
| Regex helpers mis-handle incomplete fences | Add fixtures for unclosed fences and mixed backtick/tilde fences; default incomplete fences to raw source. |
| Existing inline/block renderers appear inside code widgets | Reuse/extend fenced-code suppression tests. |
| Desktop CSS leaks into Reading view or global code blocks | Keep `.markdown-editor` selector gate and extend style-scope tests. |
| Public API accidentally stabilizes too early | Keep changes under `packages/editor/src/live-preview`; no platform API changes. |

## Verification Steps

Required targeted gate:

```bash
pnpm vitest run tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-live-preview-primitives.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-package-wiring.test.ts tests/desktop-live-preview-styles.test.ts tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts
pnpm --filter @zorid/editor run typecheck
pnpm lint:boundaries
```

Recommended full gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Optional desktop gate if host behavior changes beyond scoped CSS:

```bash
pnpm desktop:build
```

## ADR

### Decision

Plan Live Preview Pass 4 around a private fenced-code block structured widget shell with source-reveal activation, rather than starting with callouts, tables, properties, or Reading parity.

### Drivers

- Deep research recommends CodeMirror decorations/widgets and activation state before richer Obsidian parity.
- Repo has mark/replace/line preview foundations but no `WidgetType` or structured widget lifecycle yet.
- Fenced code is the lowest-risk complete block widget because it is standard Markdown and already participates in suppression helpers.

### Alternatives considered

- **Callout widget first.** Rejected for this pass because it adds OFM semantics, title/type/collapse expectations, and nested-content risk before widget activation is proven.
- **Activation refactor only.** Rejected because abstractions without a real renderer are likely to be speculative and less product-visible.
- **Table or properties first.** Rejected because both are explicitly later-stage high-complexity subsystems in the research.

### Why chosen

A fenced-code shell exercises the missing architecture layer while keeping scope narrow: block replacement, widget DOM lifecycle, activation/source reveal, scoped styling, and source preservation can all be proven without introducing table/property/callout complexity.

### Consequences

- Zorid still will not claim full Obsidian Live Preview parity after this pass.
- The renderer seam remains private and may change in later passes.
- Syntax highlighting and code actions remain deferred.
- Future callout/math/embed widgets get a tested widget/activation foundation.

### Follow-ups

1. Pass 5: callout widget shell using the widget activation foundation, still without full context menu/collapse if not yet justified.
2. Pass 6: block math or simple embed widget, including measurement/atomic range hardening if needed.
3. Pass 7: properties/frontmatter subsystem as a separate metadata editor.
4. Later: tables and Reading parity adapter after multiple first-party widgets validate the renderer model.

## Available-Agent-Types Roster

- `explore` — fast repo-local lookup and impact mapping.
- `planner` — sequencing and scope control.
- `architect` — architecture review, boundaries, and tradeoff analysis.
- `critic` — plan quality gate and risk/test challenge.
- `executor` — implementation of private editor/widget code.
- `test-engineer` — test matrix design and regression coverage.
- `verifier` — final evidence review and completion claim validation.
- `designer` — optional visual styling review for widget shell affordance.
- `code-reviewer` — optional final code review if widget internals become complex.

## Follow-up Staffing Guidance

### Recommended default: `$ultragoal`

Use `$ultragoal` as the default durable execution follow-up. Suggested lanes/checkpoints:

1. **Executor, medium reasoning** — implement private widget model, fenced-code matcher, and decoration builder.
2. **Test-engineer, medium reasoning** — write/extend widget, regression, and style tests before or alongside implementation.
3. **Verifier, high reasoning** — run targeted and broad gates, validate no non-goals slipped in, and summarize evidence.

### Recommended parallel path: `$ultragoal` + `$team`

Use Team when parallel throughput is valuable, with Ultragoal retaining durable checkpoint ownership.

- Worker lane 1 (`executor`, medium): `packages/editor/src/live-preview` widget model and fenced-code widget.
- Worker lane 2 (`test-engineer`, medium): `tests/editor-live-preview-widgets.test.ts` plus regression fixtures.
- Worker lane 3 (`designer` or `executor`, low/medium): scoped desktop styles and style-scope tests.
- Leader/verifier (`verifier`, high): integrate evidence, run final gates, ensure non-goals remain excluded.

### Explicit `$ralph` fallback

Use `$ralph` only if the user explicitly wants a single-owner persistent implementation/verification loop instead of durable Ultragoal tracking. Ralph should receive this PRD, the test spec, and the consensus handoff; it must not broaden scope beyond fenced-code widget activation.

## Goal-Mode Follow-up Suggestions

- `$ultragoal` — recommended default for executing this implementation plan with durable checkpoints.
- `$team` + `$ultragoal` — recommended if the implementation should be parallelized while keeping a leader-owned durable ledger.
- `$performance-goal` — not the default; only use if a later pass reframes the work around measurable editor scroll/redraw performance.
- `$autoresearch-goal` — not appropriate here; research is already synthesized into this implementation plan.
- `$ralph` — explicit fallback only for single-owner persistent execution.

## Team Launch Hints

```bash
# Team-only implementation lane, if chosen by the user:
$team "Implement Live Preview Pass 4 from .omx/plans/prd-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md and .omx/plans/test-spec-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md. Keep scope to fenced-code structured widget activation."

# Durable goal + team pattern, preferred for parallel durable delivery:
$ultragoal "Execute Live Preview Pass 4 using .omx/plans/prd-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md and coordinate any team evidence as checkpoints."
```

## Team Verification Path

Team must prove before shutdown:

1. Widget tests pass and demonstrate source preservation, source reveal, pointer/selection activation, incomplete fence fallback, and renderer suppression inside code blocks.
2. Existing Live Preview primitive/block/task/keymap/package tests pass.
3. Desktop style scoping test passes.
4. `pnpm --filter @zorid/editor run typecheck` and `pnpm lint:boundaries` pass.
5. Final integration owner runs or records the recommended full gate (`pnpm typecheck`, `pnpm lint`, `pnpm test`) and any desktop build gap.
6. Final report explicitly confirms no tables/properties/callouts/embeds/math/Reading parity/public API were implemented.

## Plan Changelog

- Initial RALPLAN draft created from deep research reports and repository implementation evidence.
- Applied Architect review refinements: private/internal widget type wording, complete-fence helper split, and mandatory ordering/suppression fixture.
- Critic review approved the revised plan with no required changes.
