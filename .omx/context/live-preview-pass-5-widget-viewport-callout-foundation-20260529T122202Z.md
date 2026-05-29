# Context Snapshot — Live Preview Pass 5 Widget Viewport + Callout Foundation

Date: 2026-05-29T12:22:02Z
Task statement: Create a RALPLAN consensus implementation plan for the next Live Preview pass suggested by analysis: close the current widget viewport/performance infrastructure gap, keep widget APIs private, and optionally add one bounded semantic widget if the infrastructure hardening remains small.

## Desired outcome

A durable implementation-ready PRD/test-spec and consensus handoff for Live Preview Pass 5. The pass should first harden private widget decoration collection so it stays viewport-aware or explicitly justified, then add the smallest private product-visible semantic widget: an Obsidian-style callout shell for complete `> [!type]` blockquote groups. It must not start public plugin-facing widget APIs, tables, properties/frontmatter, Reading parity, embeds, math, syntax highlighting, or broad parser migration.

## Known facts / evidence

- `.omx/plans/prd-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md:9-21` planned the first private structured widget foundation as a fenced-code block shell over canonical Markdown source.
- `.omx/plans/prd-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md:112-149` required private widget types, `WidgetType`, complete fenced-code matching, source reveal, source preservation, and scoped desktop styling.
- `.omx/plans/prd-live-preview-widget-hardening-20260529T113249Z.md:15-37` required mounted reveal/restore, pointer activation, source preservation, no-atomic-ranges policy, and no public APIs/new widget families.
- `packages/editor/src/live-preview/extension.ts:97-132` builds mark/replace/line decorations from `view.visibleRanges`, preserving viewport-bounded behavior for non-widget Live Preview ranges.
- `packages/editor/src/live-preview/extension.ts:139-181` builds private widget decorations through a `StateField`, but currently creates context `{ from: 0, to: state.doc.length }`, so widget matching scans the full document instead of visible ranges.
- `packages/editor/src/live-preview/renderers.ts:94-142` contains `CodeBlockPreviewWidget`, safe DOM construction, stable `eq`, and mousedown activation via CodeMirror selection/effect.
- `packages/editor/src/live-preview/renderers.ts:144-163` turns complete fenced-code ranges into private `code-block-widget` ranges.
- `tests/editor-live-preview-widgets.test.ts:113-218` covers widget source reveal, boundary semantics, mounted reveal/restore, pointer activation, safe DOM, and no atomic ranges.
- `apps/desktop/src/renderer/src/styles.css:531-556` contains scoped desktop styling for the current code-block widget.
- `tests/desktop-live-preview-styles.test.ts:4-35` enforces `.markdown-editor` scoping for Live Preview styles.
- Verification from the prior analysis: targeted widget/live-preview gate passed 9 files / 59 tests; full gate `pnpm typecheck && pnpm lint && pnpm test` passed 40 files / 198 tests.

## Constraints

- RALPLAN is planning-only; do not implement source changes in this workflow.
- Markdown source remains canonical; widget DOM is projection and must not hold durable document state.
- Keep all new widget APIs private under `packages/editor/src/live-preview`; do not add `packages/platform-api` renderer/widget APIs.
- No new dependencies unless a future execution pass proves existing CodeMirror/Markdown support cannot meet the acceptance criteria.
- Avoid broad Lezer/parser migration; use bounded Markdown scanners/helpers with fixtures.
- No tables, properties/frontmatter visual editor, embeds/images/PDFs, math, syntax highlighting, copy toolbar, Reading view parity, or public third-party renderer API.
- If viewport hardening proves non-small during implementation, stop at infrastructure hardening and defer callouts rather than bundling risky changes.

## Unknowns / open questions

- Whether widget `StateField` can directly access `EditorView.visibleRanges`; if not, implementation may need a small `ViewPlugin`/state-effect bridge for visible range updates.
- Whether Happy DOM can adequately prove viewport update behavior; large-doc range tests may be enough, with optional browser smoke deferred.
- Exact callout block grouping policy for nested/continued blockquotes should be frozen by fixtures before implementation.
- Whether the private code-block widget should be moved out of `renderers.ts` before adding callouts, or whether a small private `widgets.ts`/`block-widgets.ts` extraction is sufficient.

## Likely codebase touchpoints

- `packages/editor/src/live-preview/extension.ts`
- `packages/editor/src/live-preview/internal-types.ts`
- `packages/editor/src/live-preview/renderers.ts`
- possible new private module: `packages/editor/src/live-preview/widgets.ts` or `packages/editor/src/live-preview/callout-widget.ts`
- `packages/editor/src/live-preview/markdown-code-context.ts` and possible new blockquote/callout scanner helper
- `tests/editor-live-preview-widgets.test.ts`
- possible new `tests/editor-live-preview-callouts.test.ts` if coverage is cleaner split out
- `tests/editor-live-preview-blocks.test.ts`
- `tests/editor-live-preview-primitives.test.ts`
- `tests/desktop-live-preview-styles.test.ts`
- `apps/desktop/src/renderer/src/styles.css`
