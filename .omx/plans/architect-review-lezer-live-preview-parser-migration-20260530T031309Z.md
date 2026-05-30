# Architect Review — Lezer Live Preview Parser Migration

Verdict: APPROVE
Date: 2026-05-30
PRD: `.omx/plans/prd-lezer-live-preview-parser-migration-20260530T031309Z.md`
Test Spec: `.omx/plans/test-spec-lezer-live-preview-parser-migration-20260530T031309Z.md`

## Summary

Option A — private Zorid Markdown facade plus centralized syntax-range collector — is architecturally sound for this migration. It matches the current architecture's strongest seams: CodeMirror already installs Markdown support, Live Preview already reduces recognizers into `LivePreviewRange`/`InternalLivePreviewRange`, and widget suppression/ordering is centralized enough to preserve while swapping parser input.

## Strongest steelman antithesis

A renderer-by-renderer Lezer migration could be safer operationally because each current regex renderer has product-specific quirks and fixtures. A centralized collector risks becoming a large semantic rewrite where mistakes in node mapping, parse completeness, or custom extension precedence break many previews at once. This is especially plausible for callouts/frontmatter, where current behavior is not just Markdown parsing but Zorid-specific grouping policy.

## Tradeoff tension

| Tension | Preferred side | Cost |
|---|---|---|
| Central parser facade vs localized renderer migration | Central facade | Larger upfront refactor and wider review surface |
| Strict no-regex final gate vs pragmatic text utilities | Strict gate | Custom Lezer extensions must avoid becoming hidden regex scanners |
| Syntax-tree source of truth vs exact regex-quirk parity | Syntax-tree semantics | Some current fuzzy behavior may need intentional fixture decisions |
| Bounded viewport traversal vs complete semantic containers | Bounded traversal | Widgets/callouts/fences need tested near-visible expansion policy |

## Synthesis path

Approve Option A, but allow short-lived renderer-by-renderer staging internally. The durable end state should be:

1. `zoridMarkdown()` wraps `markdown({ extensions })`.
2. Private Lezer Markdown extensions define/emit nodes for current custom syntax.
3. A single collector maps syntax nodes to existing `LivePreviewRange` / `InternalLivePreviewRange`.
4. Existing decoration/widget code remains mostly intact.
5. Final static gate rejects production Live Preview regex parser paths.

## Analysis

- Current regex parser duplication is broad across `renderers.ts`, `markdown-code-context.ts`, and `task-toggle.ts`.
- The stable output contract is appropriate: `LivePreviewContext`, `LivePreviewRange`, `LivePreviewRenderer.match`, and internal line/widget ranges are already the main range seams.
- Widget-first suppression and deterministic ordering are centralized in `extension.ts`, so preserving that layer while replacing recognition is lower risk than replacing rendering wholesale.
- The viewport/performance constraint is grounded by existing bounded widget scan tests.
- The Lezer plan is supported by installed APIs: `markdown(config)` accepts `extensions?: MarkdownExtension`; `@lezer/markdown` supports `defineNodes`, `parseBlock`, `parseInline`, `remove`, and `wrap`; GFM provides TaskList and Strikethrough; CodeMirror language APIs expose syntax-tree availability and bounded parsing helpers.

## Approved improvements to apply before final handoff

1. Expand the no-regex static gate to include the private Zorid Markdown/parser-extension module wherever it lands, not only `packages/editor/src/live-preview`, so custom Lezer extensions cannot hide regex scanners.
2. Add a barrel/export compatibility check for `packages/editor/src/live-preview/index.ts`, because it currently exports markdown context helpers.
3. Add parser-order fixtures for callouts/frontmatter because Lezer block parser precedence is explicit via `before`/`after` hooks.
4. Require collector tests to create editor states with the private Markdown language installed; many existing tests currently use bare `EditorState.create({ doc })`.

## Final assessment

- Architecture soundness: APPROVED.
- Parser boundaries: APPROVED, with static-gate expansion required in final plan.
- Internal/public contract safety: APPROVED, provided existing range output remains stable.
- Custom syntax via Lezer: APPROVED, with parser-order fixtures required in final plan.
- No-regex final gate: APPROVED with coverage hardening.
- Testing/performance plan: APPROVED.
