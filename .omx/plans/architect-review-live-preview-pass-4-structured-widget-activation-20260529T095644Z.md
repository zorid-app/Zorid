# Architect Review — Live Preview Pass 4 Structured Widget Activation

Verdict: APPROVE

## Summary

The plan is well-grounded in the research and current repo state: it advances from mark/replace/line Live Preview into one private block-widget proof while preserving Markdown source truth and explicitly deferring tables/properties/Reading parity/public APIs. The strongest concern is that fenced-code is a safe but not fully representative widget; however, the PRD/test spec contain enough activation, source-preservation, boundary, and scope controls to make it a valid Pass 4 foundation.

## Strongest steelman antithesis

Fenced-code may be too tame to validate the widget architecture that future Obsidian-like widgets actually need. The research's block-widget examples emphasize callouts, block math, embeds, and finally tables; code blocks are standard Markdown and already participate in current suppression helpers. A minimal code shell risks proving only that block replacement DOM can mount, not the harder structured-editor lifecycle needed for callouts/tables/properties.

## Tradeoff tension

The real tension is low-risk architecture proof vs representativeness.

- Fenced-code shell: standard Markdown and low semantic risk, but less representative of richer widget state/editing/nested content.
- Callout shell: more Obsidian-like and builds on blockquote Pass 3, but risks scope creep into callout type/title/collapse/nested Markdown.
- Activation-only refactor: lowest visible risk, but speculative without a mounted widget proof.

## Assessment

- Source-truth principle: passes. The plan repeatedly preserves Markdown as canonical source and forbids widget DOM becoming durable state.
- Private-seam principle: mostly passes. Tighten wording to prefer `internal-types.ts`/private modules over exported `types.ts` for widget-specific types.
- No-scope-creep principle: passes. Non-goals are clear and repeated.

## Recommendations applied before Critic review

1. Tighten private seam wording: prefer private/internal types and avoid changing exported `types.ts` unless unavoidable.
2. Clarify complete-fence helper split: current `markdownFencedCodeRanges()` includes open fences for suppression, so widget matching should use a complete-only helper or metadata flag.
3. Make ordering/suppression fixture mandatory rather than conditional.

## Verdict

APPROVE for Critic review.
