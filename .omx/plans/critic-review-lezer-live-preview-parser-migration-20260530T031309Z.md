# Critic Review — Lezer Live Preview Parser Migration

Verdict: APPROVE
Date: 2026-05-30
PRD: `.omx/plans/prd-lezer-live-preview-parser-migration-20260530T031309Z.md`
Test Spec: `.omx/plans/test-spec-lezer-live-preview-parser-migration-20260530T031309Z.md`
Architect Review: `.omx/plans/architect-review-lezer-live-preview-parser-migration-20260530T031309Z.md`

## Evaluation

- Principle-option consistency: Pass. Option A directly follows the principles: Lezer as semantic source, source-preserving projections, private parser surface, parity-first, bounded traversal.
- Fair alternatives: Pass. Renderer-by-renderer traversal and standalone parsing are treated fairly with real pros/cons, then rejected for clear architectural reasons.
- Risk mitigation clarity: Pass. Incomplete parse, hidden regex scanners, performance, export compatibility, and callout/frontmatter parser awkwardness are each tied to concrete mitigations.
- Testable acceptance criteria: Pass. Criteria are executable: static no-regex gate, parser facade tests, collector tests, parity suites, malformed checkbox fixture, suppression tests, dependency checks, lint/typecheck/full tests.
- Concrete verification steps: Pass. Validation command order and completion evidence are explicit.
- No-regex gate: Pass. Architect improvement is applied: the static gate covers `packages/editor/src/live-preview` plus any private parser-extension modules.
- Custom syntax via Lezer: Pass. Wiki links, tags, highlights, frontmatter, and callouts are required to become private Lezer Markdown extensions or identifiable parser nodes.
- Performance/no-worse plan: Pass. Bounded visible/near-visible traversal, `ensureSyntaxTree` bounds, existing performance fixtures, and `pnpm perf:smoke` fallback are specified.
- User boundary preservation: Pass. No Reading view migration, public plugin API, UI redesign, new syntax, or editor replacement.
- Architect improvements applied: Pass.

## Representative simulations

- Current regex parser paths in `renderers.ts`, `markdown-code-context.ts`, and `task-toggle.ts` match the PRD's migration target.
- Existing widget suppression/windowing seams in `extension.ts` can be preserved while swapping recognition source.
- Existing task-toggle and live-preview suites provide usable parity gates for the malformed checkbox and source-preservation requirements.

## Optional improvements applied to final artifacts

1. Specify that the retained `LivePreviewRenderer.match(context)` method name is not itself a forbidden regex/String match call.
2. Prefer an AST/token-based static gate over raw string grep for regex literals and String regex APIs.
3. Add before/after timing notes if performance fixture evidence is borderline.

## Final verdict

APPROVE. The plan is ready for durable execution handoff after optional wording hardening is applied.
