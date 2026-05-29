# Architect Review — Live Preview Pass 5 Widget Viewport + Callout Foundation

Date: 2026-05-29  
Final verdict: APPROVE  
Iterations: 2

## Iteration 1 Verdict: ITERATE

The first draft was directionally sound but needed revision before Critic review. Required fixes:

1. Distinguish bounded emitted widget ranges from bounded scanner work/input windows.
2. Require tests that fail if widget matchers/scanners consume unrelated distant document regions, not only tests that distant widgets are absent.
3. Add an implementation step for a private callout suppression/ordering seam so callout widget ranges suppress blockquote/inline/task/link/tag decorations inside the callout without affecting outside ranges.
4. Freeze callout grouping fixtures more concretely: quoted blank lines, interrupted blockquotes, lazy continuation, and nested `>>` behavior.

Strongest antithesis: viewport/performance hardening only is safer because callouts introduce grouping, suppression, styling, and semantic fixture policy before the widget collection model is proven scalable.

## Iteration 2 Verdict: APPROVE

The revised PRD/test spec are architecturally sound and ready for Critic review. The iteration directly addresses the prior Architect blockers: it separates emitted-range bounding from scanner/input-window bounding, requires tests that fail on unrelated distant-region consumption, adds a private suppression/ordering seam, and freezes callout grouping edge fixtures.

## Analysis

The plan is grounded in the actual current gap: non-widget decorations are already viewport-driven via `view.visibleRanges`, while widget decorations are built from a full-document context.

- `packages/editor/src/live-preview/extension.ts:97-100` — public/non-widget decorations collect per `view.visibleRanges`.
- `packages/editor/src/live-preview/extension.ts:139-147` — widget collection currently uses `{ from: 0, to: state.doc.length }`.
- `.omx/plans/prd-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md:111-119` — revised acceptance criteria require bounded scanner work/input, not just bounded emitted widgets.
- `.omx/plans/test-spec-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md:20-29` — revised tests explicitly reject distant-widget absence as sufficient proof.

The conditional two-phase structure is the right architectural shape:

- `.omx/plans/prd-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md:98-105` — Phase 5A hardens widget infrastructure first; Phase 5B callouts proceed only if 5A stays small and green.
- `.omx/plans/prd-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md:250-251` — risk mitigation covers viewport plumbing expansion and bridge fragility.

The private seam requirement is also sound:

- `packages/editor/src/live-preview/internal-types.ts:5-14` — internal widget/line kinds already exist separately from public renderer types.
- `packages/editor/src/live-preview/renderers.ts:276-278` — widget renderers are already a separate private renderer list.
- `.omx/plans/prd-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md:121-129` — revised plan requires private deterministic suppression/ordering without public callout knowledge.
- `.omx/plans/test-spec-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md:69-75` — tests cover inside suppression, outside preservation, and deterministic ordering.

Callout grouping is fixture-bounded enough for implementation planning:

- `.omx/plans/prd-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md:132-145`
- `.omx/plans/test-spec-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md:49-68`

## Strongest Steelman Antithesis

The strongest argument against favored Option A is that adding callouts in the same pass may prematurely couple three unstable seams: viewport-state bridging, scanner-window semantics, and cross-renderer suppression. The existing code-block scanner still has prefix-scan behavior — `markdownCompleteFencedCodeBlockRanges` iterates from document start until `scanWindow.to` (`packages/editor/src/live-preview/markdown-code-context.ts:76-80`) — so “bounded widget scanning” may uncover deeper scanner-boundary design work than expected. Option B, viewport hardening only, would minimize regression risk and avoid designing suppression semantics under pressure.

## Tradeoff Tension

The core tension is correctness vs bounded work. Markdown block detection sometimes needs context outside the visible range, but the plan correctly forbids consuming unrelated distant regions. The synthesis is to allow explicitly tested near-visible or semantic-container expansion, while rejecting unconditional full-document scans.

## Synthesis Path

Proceed with Option A under the existing hard stop:

1. Implement/test Phase 5A first.
2. Define the accepted scan-window policy in tests.
3. Add callouts only after widget collection, scanner-window proof, and suppression seam tests are green.
4. Defer callouts if viewport bridging or scanner boundary work becomes broad.

## Non-blocking Improvement Suggestions

1. Add one explicit fixture for a visible range inside or adjacent to a long fenced block/callout whose opener or closer is outside the viewport, proving bounded semantic-container handling rather than unrelated distant scanning.
2. In the suppression seam, prefer computing widget ranges once per active scan window and passing private suppression ranges into public decoration collection, rather than making public renderers callout-aware.
3. Make the deterministic ordering rule explicit: sort by `from`, `to`, priority/kind, then `rendererId`.
