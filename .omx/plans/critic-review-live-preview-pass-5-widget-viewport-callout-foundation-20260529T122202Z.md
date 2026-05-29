# Critic Review — Live Preview Pass 5 Widget Viewport + Callout Foundation

Date: 2026-05-29  
Verdict: APPROVE

## Justification

The PRD and test spec are actionable without executor guesswork and satisfy the durable Critic consensus gate. The plan is grounded in the real gap: public Live Preview decorations use `view.visibleRanges` in `packages/editor/src/live-preview/extension.ts:97-100`, while widget collection currently uses full-document context in `extension.ts:139-147`.

## Evaluation Summary

- **Principle-option consistency**: Pass. PRD principles prioritize source truth, private seams, infrastructure before breadth, and one bounded widget; Option A follows that with a hard Phase 5A/5B gate.
- **Fair alternatives**: Pass. Option B fairly covers viewport-only safety; Option C covers task-checkbox tradeoffs; ADR rejects public APIs/tables/properties as too broad.
- **Risk mitigation clarity**: Pass. Conditional deferral of callouts, private bridge containment, parser-scope limits, source-preservation, CSS scoping, and API-scope controls are explicit.
- **Testable acceptance criteria**: Pass. Scanner-work vs emitted-range proof is explicit, and callout grouping fixtures are concrete.
- **Concrete verification steps**: Pass. Targeted and full gates are listed with completion criteria.
- **Scope control**: Pass. The plan forbids public/platform APIs, broad parser migration, Reading parity, tables, properties, embeds, math, syntax highlighting, and rich callout UI.
- **Architect feedback applied**: Pass. Iteration 1 blockers are addressed by PRD/test-spec requirements for scanner input windows, unrelated distant-region failure tests, suppression/ordering seam, and grouped callout fixtures. Iteration 2 refinements are also applied: semantic-container fixture, preferred private suppression flow, deterministic ordering.

## Representative Task Simulation

Viewport hardening has a concrete failing target against current full-document behavior; suppression seam is scoped to private Live Preview internals; callout matching/styling is fixture-bounded and source-preserving.

No blocking issues found.
