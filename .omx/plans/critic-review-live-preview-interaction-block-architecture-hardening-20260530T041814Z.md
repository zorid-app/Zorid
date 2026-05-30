# Critic Review — Live Preview Interaction + Internal Block Architecture Hardening

## Verdict

**APPROVE**

## Justification

The revised PRD and test spec are actionable after Architect approval. The four artifacts and referenced implementation/test/support paths exist. Representative current code was cross-checked: selection filtering in `extension.ts`, helper-only clipboard coverage in `source-text.ts` / clipboard tests, private block adapter use in `block-renderers.ts` / `renderers.ts`, package export boundaries, CodeMirror clipboard/atomic APIs, and existing Lezer/no-regex gates.

## Summary

- **Clarity**: Pass. The plan is explicitly interaction-first: selection and clipboard are primary, architecture follows.
- **Verifiability**: Pass. Targeted suites, regression suites, lint/typecheck/full test gates are concrete.
- **Completeness**: Pass. Covers selection, clipboard, activation boundaries, atomic policy, private block hardening, viewport/perf, and no-regex preservation.
- **Big Picture**: Pass. Correctly avoids tables, Properties, Reading parity, public plugin API, and parser rewrite.
- **Principle/Option Consistency**: Pass. Option A matches the stated principles: source-backed, test-first, private/internal, Lezer-preserving.
- **Alternatives Depth/Fairness**: Pass. Registry-first and new-block-first alternatives are fairly represented with real pros and justified rejections.
- **Risk/Verification Rigor**: Pass. Architect’s concerns were incorporated: mounted/filter clipboard attempt, activation boundary details, atomic decision tests, package export boundary.
- **Deliberate Additions**: Not required for this RALPLAN-DR short plan.

## Representative simulations against current files

- Selection/activation: `livePreviewRangeIntersectsSelection` currently treats cursor at `activationTo` inclusively, so the plan’s exact `activationTo` / after-end tests are necessary and actionable.
- Clipboard: current `livePreviewSourceTextForRange` is exact slicing only, and existing clipboard tests are helper-level; the revised spec correctly requires mounted/filter-level attempt using CodeMirror clipboard seams or documented limitation plus equivalent proof.
- Private block boundary: code-block and callout already route through the private adapter, but metadata does not yet encode clipboard/atomic policy; the planned private contract checkpoint is well-placed and does not imply public API exposure.

## Blocking gaps requiring planner revision

None.

## Non-blocking improvements for executors

- Add an explicit undo/redo assertion for cut behavior wherever cut integration is implemented.
- Consider one multi-selection clipboard case if CodeMirror behavior is easy to cover.
- When verifying private API boundaries, prefer checking `packages/editor/package.json` exports plus root/live-preview barrels, as planned.
