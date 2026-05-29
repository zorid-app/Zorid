# PRD — Live Preview Pass 5: Widget Viewport + Callout Foundation

Status: RALPLAN consensus approved  
Date: 2026-05-29  
Scope: Next implementation pass after Live Preview Pass 4/4.5. This pass first hardens private widget decoration collection so it is viewport-aware or explicitly justified, then adds one bounded private semantic widget: a minimal Obsidian-style callout shell for complete `> [!type]` blockquote groups. It preserves Markdown source truth and defers tables, properties/frontmatter, embeds/images/PDFs, math rendering, syntax highlighting, Reading parity, and public plugin/widget API stabilization.

## Requirements Summary

Pass 4 and 4.5 established a private fenced-code Live Preview widget foundation. The current code proves `WidgetType` rendering, source reveal, pointer activation, safe DOM construction, scoped desktop styling, and no-atomic-ranges behavior for code blocks. The main architectural gap is that non-widget decorations are collected from CodeMirror `view.visibleRanges`, but widget decorations currently rebuild from a full-document context.

Pass 5 should therefore treat widget viewport/performance policy as the first-class acceptance gate before adding more visible behavior. If that hardening remains small, the pass should add the first semantic Markdown widget beyond code blocks: a private callout shell for complete blockquote groups beginning with `> [!type]` or `> [!type] Title`. The callout shell should exercise the same private widget pipeline with vanilla Markdown source, without collapse behavior, type selector, nested rich editing, public APIs, or Reading-view parity.

The pass succeeds when:

1. Widget decoration collection is viewport-aware enough for large documents, or the implementation records and tests a narrow full-document exception with a concrete threshold/rationale.
2. Widget scanner **work/input window** is bounded separately from emitted output, so tests cannot pass merely because distant widgets are filtered after a broad scan.
3. Existing fenced-code widget behavior remains source-preserving and green.
4. Complete callout blockquote groups can render as inactive private widgets and reveal raw source when focused selection enters the activation range.
5. Pointer activation on a callout reveals deterministic source without mutating Markdown.
6. Private widget ranges suppress overlapping public mark/line renderers inside inactive widgets through an explicit ordering/suppression seam, without suppressing outside ranges.
7. All new widget classes are scoped, private, safe-DOM projections over canonical Markdown source.

## Grounding Evidence

- `.omx/plans/prd-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md:9-21` planned the private fenced-code widget foundation as the first structured widget proof over canonical Markdown source.
- `.omx/plans/prd-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md:112-149` required private widget types, `WidgetType`, complete fenced-code matching, source reveal, source preservation, and scoped desktop styling.
- `.omx/plans/prd-live-preview-widget-hardening-20260529T113249Z.md:15-37` required mounted reveal/restore, pointer activation, source preservation, no-atomic-ranges policy, and no public APIs/new widget families.
- `packages/editor/src/live-preview/extension.ts:97-132` builds non-widget Live Preview decorations from `view.visibleRanges` through a `ViewPlugin`.
- `packages/editor/src/live-preview/extension.ts:139-181` builds private widget decorations through a `StateField`, currently using `{ from: 0, to: state.doc.length }` for widget collection.
- `packages/editor/src/live-preview/renderers.ts:94-142` contains `CodeBlockPreviewWidget`, stable `eq`, safe DOM/text construction, and pointer activation by CodeMirror dispatch.
- `packages/editor/src/live-preview/renderers.ts:144-163` converts complete fenced-code ranges into private `code-block-widget` ranges.
- `tests/editor-live-preview-widgets.test.ts:113-218` covers code-widget reveal, boundary semantics, mounted reveal/restore, pointer activation, safe DOM, and no atomic ranges.
- `apps/desktop/src/renderer/src/styles.css:531-556` owns scoped host styling for the fenced-code widget.
- `tests/desktop-live-preview-styles.test.ts:4-35` enforces `.markdown-editor` scoping for Live Preview classes.
- Prior verification evidence: targeted Pass 4/4.5 gate passed 9 files / 59 tests, and full `pnpm typecheck && pnpm lint && pnpm test` passed 40 files / 198 tests.

## RALPLAN-DR Summary

### Principles

1. **Source remains canonical**: Markdown text is the only durable document model; widget DOM is disposable projection.
2. **Infrastructure before breadth**: viewport/performance behavior must be settled before adding multiple widget families.
3. **Private seams first**: widget APIs stay under `packages/editor/src/live-preview` until several first-party widgets validate the shape.
4. **One semantic widget proof**: add at most one bounded callout shell after infrastructure hardening, not a broad OFM platform.
5. **Tests define maturity**: range fixtures, source preservation, activation, viewport behavior, and style scoping matter more than visual richness.

### Decision Drivers

1. The current widget implementation works functionally but scans full document context for widget decorations while non-widget Live Preview decorations are viewport-bounded.
2. Callouts are more product-visible than another technical widget and build naturally on the existing blockquote line-preview foundation, but they must not destabilize current blockquote behavior.
3. Public widget/plugin APIs, tables, properties, and Reading parity require more validated private behavior than the repo currently has.

### Viable Options

#### Option A — Viewport hardening + private callout shell (preferred)

Approach: First make widget collection viewport-aware or explicitly bounded/tested. Then add a private callout block widget for complete callout blockquote groups only.

Pros:
- Closes the strongest current architectural gap before adding more widgets.
- Adds product-visible Live Preview progress without public API commitment.
- Reuses existing selection/focus reveal and blockquote context knowledge.
- Produces evidence for whether the private widget seam can support a second widget type.

Cons:
- Requires careful grouping fixtures to avoid mis-parsing ordinary blockquotes.
- Can creep into callout collapse/type styling if non-goals are not enforced.
- May require small reorganization of `renderers.ts` to avoid accumulating widget code in one file.

#### Option B — Viewport/performance hardening only

Approach: Do not add callouts. Focus exclusively on widget visible-range architecture, large-doc tests, and private code organization.

Pros:
- Lowest regression risk.
- Directly addresses the known gap.
- Keeps implementation small if visible-range plumbing is harder than expected.

Cons:
- Less product-visible.
- Does not prove the private widget seam with a second semantic widget.
- Delays OFM-style behavior another pass.

#### Option C — Task-checkbox visual widget next

Approach: After viewport hardening, add a richer task checkbox widget or pointer interaction around existing source-backed task toggles.

Pros:
- Builds on existing task toggle transaction/history tests.
- Lower semantic parsing risk than callouts.
- Could improve common checklist workflows.

Cons:
- Less useful for validating block widget grouping.
- Risks mixing durable mutation semantics with projection-only widget hardening.
- Does not exercise block-level callout/theming path that product plans likely need soon.

### Preferred option

Option A, with an explicit two-phase gate:

- **Phase 5A — bounded widget infrastructure**: prove emitted widget ranges and scanner work/input windows are bounded, including viewport-change-only updates and no broad unrelated document consumption.
- **Phase 5B — private callout shell**: add callouts only if Phase 5A remains small, green, and does not require broad Markdown parser or extension architecture changes.

Hard stop condition: if widget viewport/scanner hardening requires broader architecture work than expected, complete and verify Phase 5A and defer callouts to the next pass. Do not let callout scope compromise the viewport/performance gate.

## Acceptance Criteria

### Widget viewport/performance policy

- Widget decoration collection no longer unconditionally scans the full document for every rebuild unless a narrow, explicitly tested exception is documented in code and tests.
- The implementation uses CodeMirror visible ranges, a small visible-range state/effect bridge, or another tested approach that keeps widget matching bounded to visible or near-visible document slices.
- The test strategy distinguishes **bounded emitted ranges** from **bounded scanner work/input window**. A test that only proves distant widgets are absent is insufficient unless it also proves the matcher/scanner did not consume unrelated distant regions.
- Fenced-code widgets still appear when their source range intersects the visible range.
- Fenced-code widgets do not appear for complete fences outside the active widget scan window in tests designed to prove bounded collection.
- Scanner-work tests fail if a widget matcher is handed `{ from: 0, to: state.doc.length }` or otherwise consumes unrelated distant document regions for normal viewport rebuilds. Acceptable proof includes a test-only renderer recording context windows, an instrumented scanner fixture, or a public-behavior test that exposes distant-region consumption.
- Include at least one semantic-container fixture where the visible range is inside or adjacent to a long fenced block or callout whose opener/closer sits outside the viewport, proving bounded context expansion without unrelated distant scanning.
- Selection/focus reveal still suppresses an active widget when the focused selection intersects its activation range, even if the selection enters the range through pointer activation.
- Large-document tests prove widget collection is bounded by observation, such as counting calls/context windows from test-only renderers and asserting distant widgets are absent until the viewport/range changes.
- If implementation cannot access viewport state from the widget `StateField` cleanly, introduce the smallest private bridge; do not redesign all Live Preview renderer APIs.

### Private widget organization and suppression ordering

- Widget-only types remain private under `packages/editor/src/live-preview`; exported `types.ts`, package-root exports, and `packages/platform-api` remain unchanged unless tests prove a narrow internal export is necessary.
- Adding callouts does not force a public renderer API, third-party widget API, or Markdown processor adapter.
- If `renderers.ts` becomes crowded, move private widget classes/helpers to a private module such as `widgets.ts`, `code-block-widget.ts`, or `callout-widget.ts`; keep imports one-directional and boundary-safe.
- Existing mark/replace/line renderers remain behaviorally unchanged outside widget suppression interactions.
- Add or reuse a private suppression/ordering seam so inactive widget ranges can suppress overlapping public mark/line ranges inside their activation ranges before decorations are built. This seam must be private, deterministic, and tested with callout ranges plus outside ranges.
- Prefer computing widget ranges once per active scan window and passing private suppression ranges into public decoration collection, rather than making public renderers callout-aware.
- The suppression seam must not require public renderers to know about callout widget internals and must not suppress ranges outside the widget activation range.
- Deterministic ordering should be explicit and stable: sort by `from`, `to`, private priority/kind, then `rendererId` unless implementation evidence requires a narrower equivalent.

### Callout matching behavior

- Complete callout groups are matched only when a blockquote group starts with a callout marker of the form `> [!type]` or `> [!type] Optional title` with up to three leading spaces.
- Supported marker type characters are intentionally conservative for this pass, such as ASCII letters, numbers, `_`, and `-`; unsupported marker forms stay raw.
- The callout activation range covers the complete matched blockquote group.
- The first pass grouping policy is explicit and fixture-locked:
  - consecutive `>` blockquote lines after the marker are included;
  - quoted blank lines such as `>` or `> ` are included;
  - an unquoted blank line or unquoted paragraph interrupts and ends the callout;
  - lazy continuation lines are not included in this pass;
  - nested `>>` blockquotes remain raw/blockquote-line styled unless the implementation adds a specific fixture proving safe handling.
- The callout widget preserves the opening marker, optional title, and all quoted body source in the document.
- Ordinary blockquotes without a callout marker continue to use the existing blockquote line renderer.
- Incomplete/ambiguous groups and interrupted blockquote structures remain raw/blockquote-line styled unless fixtures prove a safe narrow conversion.
- Callout matching is suppressed inside fenced and indented code blocks.
- Existing inline/link/tag/task/blockquote line renderers inside a callout group are suppressed while the callout widget is inactive through the private suppression seam, and continue to work outside callout ranges.

### Callout widget behavior

- In inactive/unfocused context, a complete callout group renders as a minimal shell under a class such as `.z-live-preview-callout-widget`.
- The shell may show the callout type, optional title, and plain text body preview; it must not add collapse behavior, type picker, context menu, icons from a new dependency, nested rich editor, or durable widget-local editing.
- Widget DOM is constructed through DOM/text APIs; user Markdown is never assigned as executable `innerHTML`.
- Widget identity uses `eq()` or equivalent stable comparison for relevant source/type/title/body fields.
- Pointer/mousedown activation focuses the editor and dispatches selection to a documented source position, preferably the callout marker or title start.
- Focused selection at range start, inside marker/title/body, or at range end suppresses the widget and reveals raw Markdown source; range end + 1 restores preview when outside the group.
- Source text remains exact across collection, mount, focus, selection movement, pointer activation, reveal, restoration, and editor destruction.

### Desktop styling

- Add scoped styles under `.markdown-editor` for `.z-live-preview-callout-widget` and internal sub-elements.
- Use existing tokens; no new design-token dependency is required.
- Do not target `.markdown-preview-view`, global `blockquote`, global `pre`, global `code`, or unscoped `.z-live-preview-*` selectors.
- Extend `tests/desktop-live-preview-styles.test.ts` so all new callout widget classes are `.markdown-editor` scoped.

### Regression and compatibility

- Existing tests remain green:
  - `tests/editor-live-preview-widgets.test.ts`
  - `tests/editor-live-preview-blocks.test.ts`
  - `tests/editor-live-preview-primitives.test.ts`
  - `tests/editor-task-toggle.test.ts`
  - `tests/editor-markdown-keymap.test.ts`
  - `tests/editor-package-wiring.test.ts`
  - `tests/desktop-live-preview-styles.test.ts`
  - `tests/desktop-markdown-autosave.test.ts`
  - `tests/desktop-vault-editor.test.ts`
- Editor package typecheck remains green.
- Import-boundary lint remains green.
- Full typecheck/lint/test should pass before execution completion.

### Explicit non-goals

- No public/plugin-facing Live Preview widget API.
- No `packages/platform-api` renderer/widget changes.
- No tables or table cell editor.
- No properties/frontmatter visual editor.
- No embeds, images, PDFs, media previews, or image resize handles.
- No math rendering.
- No syntax highlighting, copy toolbar, code actions, line numbers, or language-loader dependency.
- No callout collapse, icon pack, type selector, context menu, or custom theme registry.
- No Reading view parity or Markdown post-processor adapter.
- No broad regex-to-Lezer/parser migration.
- No mobile/touch-specific behavior.

## Implementation Steps

1. **Lock viewport behavior with tests first**
   - Add focused tests in `tests/editor-live-preview-widgets.test.ts` or a new `tests/editor-live-preview-widget-viewport.test.ts`.
   - Use a test-only internal widget renderer, instrumented scanner fixture, or mounted editor scenario to prove widget matching is bounded to visible/near-visible ranges.
   - Prove both bounded emitted output and bounded scanner work/input windows; distant-widget absence alone is not sufficient.
   - Cover visible code-block widget, distant code-block absence before viewport/range change, active reveal, pointer activation, and exact source preservation.

2. **Refactor widget collection minimally**
   - Update `packages/editor/src/live-preview/extension.ts` so widget decorations are built from visible/near-visible ranges instead of unconditional full-document context.
   - If needed, introduce a tiny private visible-range effect/state bridge from the `ViewPlugin` into the widget `StateField`.
   - Keep existing public `livePreviewExtension` and `livePreviewExtensionWithWidgets` shape unless tests prove a private-only adjustment is necessary.

3. **Preserve and re-run fenced-code widget guarantees**
   - Ensure `CodeBlockPreviewWidget`, complete fence matching, pointer activation, no-atomic-ranges policy, and safe DOM tests stay green.
   - Add regression coverage if viewport changes expose hidden edge cases at widget boundaries.

4. **Add private widget suppression/ordering seam**
   - Add tests proving inactive widget ranges suppress overlapping public mark/line ranges inside activation ranges and do not suppress outside ranges.
   - Keep the seam private to Live Preview; do not require public renderers or `packages/platform-api` to know about callouts.
   - Ensure code-block and callout widget ranges produce deterministic ordering when multiple widget types are near public ranges.

5. **Add callout matcher fixtures**
   - Add `tests/editor-live-preview-callouts.test.ts` or extend widget tests with fixtures for simple callout, titled callout, body lines, quoted blank lines, ordinary blockquotes, unsupported markers, interrupted groups, lazy continuation raw behavior, nested `>>` raw behavior, code suppression, and outside inline/task/link/tag behavior.
   - Freeze grouping policy before adding DOM behavior.

6. **Implement minimal private callout widget**
   - Add a private scanner/helper for complete callout blockquote groups, likely near block/widget helpers rather than public `types.ts`.
   - Implement a private `WidgetType` subclass for the callout shell using safe DOM/text APIs.
   - Wire it through `defaultLivePreviewWidgetRenderers` only after viewport hardening is green.

7. **Add callout activation/source reveal**
   - Reuse the existing selection-intersection reveal policy.
   - Add pointer activation to a deterministic source position.
   - Keep no-atomic-ranges unless tests show cursor/deletion behavior requires it; if atomic ranges are added, include boundary/deletion tests.

8. **Add scoped desktop styling**
   - Update `apps/desktop/src/renderer/src/styles.css` near current Live Preview widget styles.
   - Extend `tests/desktop-live-preview-styles.test.ts` to require callout classes under `.markdown-editor` and reject global/Reading selectors.

9. **Run targeted verification**
   - `pnpm test -- tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-callouts.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-live-preview-primitives.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-package-wiring.test.ts tests/desktop-live-preview-styles.test.ts tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts`  
     If no separate callout test file is created, omit that path and keep equivalent coverage in `tests/editor-live-preview-widgets.test.ts`.
   - `pnpm --filter @zorid/editor run typecheck`
   - `pnpm lint:boundaries`

10. **Run broad verification before completion**
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
   - Optional: `pnpm desktop:build` if mounted widget host behavior or CSS changes prove materially broader than scoped styles.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Viewport plumbing becomes larger than expected | Treat callout as conditional; finish and verify viewport hardening first, then defer callout if needed. |
| Visible-range state bridge makes extension ordering fragile | Keep the bridge private and covered by mounted tests for initial render, focus, selection, doc change, and viewport/range updates. |
| Callout parsing becomes an OFM parser project | Accept only conservative first-line marker groups; leave nested/collapsible/advanced callouts raw. |
| Callout widget suppresses ordinary blockquote styling incorrectly | Add fixtures proving ordinary blockquotes remain line-rendered and callouts are the only widget-converted blockquotes. |
| Widget DOM becomes alternate state | No durable widget-local editing; source-preservation tests around every interaction. |
| CSS leaks into Reading/global styles | Enforce `.markdown-editor` scoping test for every `.z-live-preview-*` selector. |
| Public API stabilizes too early | Do not change `packages/platform-api`; keep private modules and package-root exports stable. |

## Verification Steps

Required targeted gate:

```bash
pnpm test -- tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-callouts.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-live-preview-primitives.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-package-wiring.test.ts tests/desktop-live-preview-styles.test.ts tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts
pnpm --filter @zorid/editor run typecheck
pnpm lint:boundaries
```

If callout coverage is folded into `tests/editor-live-preview-widgets.test.ts`, use this targeted gate instead:

```bash
pnpm test -- tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-live-preview-primitives.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-package-wiring.test.ts tests/desktop-live-preview-styles.test.ts tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts
pnpm --filter @zorid/editor run typecheck
pnpm lint:boundaries
```

Recommended full gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Optional desktop gate if mounted behavior or styling expands beyond scoped CSS:

```bash
pnpm desktop:build
```

## ADR

### Decision

Implement Live Preview Pass 5 as viewport/performance hardening for private widget decorations, followed by a bounded private callout shell only if the infrastructure slice remains small and green.

### Drivers

- Widget decorations currently have a stronger full-document-scan risk than non-widget decorations.
- A second private widget is needed before public API design can be evidence-based.
- Callouts provide product-visible progress while remaining simpler than tables/properties/embeds.

### Alternatives considered

- **Viewport hardening only**: safer but less informative about the second-widget seam.
- **Task-checkbox visual widget**: lower parsing risk but mixes durable mutation concerns into a projection-hardening pass.
- **Public widget/plugin API now**: rejected because only one private widget family is proven and the shape is not mature.
- **Tables/properties next**: rejected as too broad before widget viewport and second-widget behavior are proven.

### Why chosen

This option addresses the strongest current implementation gap first and adds one narrowly-scoped semantic widget only after that foundation is stable. It preserves the project’s source-truth and private-seam constraints while producing enough evidence for future API and richer-widget planning.

### Consequences

- The next implementation pass is still primarily infrastructure/correctness work, not a broad visual feature pass.
- Callout behavior will intentionally be less rich than Obsidian; collapse, icons, context menus, and theme registries remain future work.
- If viewport hardening expands, callouts should be deferred rather than forced into the same pass.

### Follow-ups

- After Pass 5, plan either callout interaction polish or a task-checkbox visual widget based on implementation evidence.
- Public plugin-facing widget APIs should wait until at least code-block and callout/task widget behavior validate common abstractions.
- Tables/properties/frontmatter should remain separate RALPLAN scopes.

## Available-Agent-Types Roster

- `explore` — fast repo-local lookup and impact mapping.
- `architect` — boundary/interface review for widget collection and private API shape.
- `critic` — quality gate for scope control, alternatives, and testability.
- `executor` — implementation of bounded source/test/style changes.
- `test-engineer` — fixture and regression coverage design.
- `verifier` — final evidence collection and claim validation.
- `code-reviewer` — post-implementation code review.
- `code-simplifier` — optional cleanup if widget modules become tangled.
- `designer` — optional visual review if callout styling needs interaction/design scrutiny.

## Follow-up Staffing Guidance

### Recommended `$ultragoal` path

Use `$ultragoal` as the default durable follow-up. Suggested lanes/checkpoints:

1. **Viewport checkpoint** — executor + test-engineer, medium reasoning: tests and minimal `extension.ts` hardening are green.
2. **Callout matcher checkpoint** — executor + test-engineer, medium reasoning: conservative fixtures prove grouping/suppression behavior.
3. **Callout widget/style checkpoint** — executor + designer optional, medium reasoning: safe DOM, activation, scoped styling.
4. **Verification checkpoint** — verifier, high reasoning: targeted and full gates pass or gaps are documented.

### Recommended `$team` path

Use `$team` if implementation should proceed in parallel after Ultragoal creates the durable ledger. Suggested team lanes:

- Lane 1 (`executor`, medium): viewport widget collection in `packages/editor/src/live-preview/extension.ts` and related private types.
- Lane 2 (`test-engineer`, medium): viewport and callout fixture tests.
- Lane 3 (`executor`, medium): private callout matcher/widget and desktop styles after Lane 1 contracts are clear.
- Lane 4 (`verifier`, high): targeted/full verification and regression summary.

Avoid parallel edits to the same files without leader coordination; `extension.ts`, `renderers.ts`, and widget tests are likely shared-file hotspots.

### `$ralph` fallback

Use `$ralph` only if the user intentionally wants a single-owner persistent completion loop instead of the default Ultragoal ledger. Ralph should execute this plan sequentially with the viewport hardening stop condition enforced before callout work starts.

## Goal-Mode Follow-up Suggestions

- `$ultragoal` — recommended default: create durable checkpoints from this PRD/test spec and execute sequentially with verification evidence.
- `$team` + `$ultragoal` — recommended if speed matters: Team runs coordinated lanes while Ultragoal owns durable progress/checkpoints.
- `$performance-goal` — not the default, but appropriate if the viewport-hardening slice turns into measurable large-document performance optimization with benchmarks.
- `$autoresearch-goal` — not recommended; this is implementation planning, not a research deliverable.

## Team Launch Hints

```bash
$ultragoal .omx/plans/prd-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md
```

For coordinated execution after durable goal setup:

```bash
$team "Implement Live Preview Pass 5 from .omx/plans/prd-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md and .omx/plans/test-spec-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md"
```

Equivalent OMX runtime hint:

```bash
omx team "Implement Live Preview Pass 5 widget viewport + callout foundation using the approved PRD/test-spec in .omx/plans"
```

## Team Verification Path

Before team shutdown, Team should provide checkpoint-ready evidence for Ultragoal:

1. Changed-file summary by lane.
2. Targeted widget/callout/style test output.
3. `pnpm --filter @zorid/editor run typecheck` output.
4. `pnpm lint:boundaries` output.
5. Full `pnpm typecheck && pnpm lint && pnpm test` output or documented blocker.
6. Explicit confirmation that public APIs, tables/properties/embeds/math/Reading parity, syntax highlighting, and new dependencies were not added.

## Plan Changelog

- Initial RALPLAN draft created from prior Pass 4/4.5 plans and current repository implementation evidence.
- Architect iteration applied: separated bounded emitted ranges from bounded scanner work/input windows, added private suppression/ordering seam requirements, and froze callout grouping policy for quoted blank lines, interruptions, lazy continuations, and nested blockquotes.
- Architect-approved refinements applied: semantic-container viewport fixture, preferred suppression seam data flow, and deterministic ordering rule.
