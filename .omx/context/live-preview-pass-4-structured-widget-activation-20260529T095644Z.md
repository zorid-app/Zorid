# Context Snapshot — Live Preview Pass 4 Structured Widget Activation

Date: 2026-05-29 09:56:44Z
Task statement: Create a complete RALPLAN consensus plan for the recommended next Live Preview implementation pass after reading the two deep research reports and grounding against repository facts.

## Desired outcome

A durable implementation-ready plan for Live Preview Pass 4 that advances Zorid from mark/replace/line decorations into the first structured block-widget foundation, without prematurely implementing tables, properties, Reading parity, or a public renderer/plugin API.

## Known facts / evidence

- `plan/deep-research-report.md:19-24` distinguishes Source mode, Live Preview, and Reading view as distinct rendering paths.
- `plan/deep-research-report.md:56-72` frames Live Preview as focus/selection-aware syntax hiding with source reveal.
- `plan/deep-research-report.md:115-119` states Live Preview should be editor-local decorations/widgets, while Reading view is complete HTML rendering.
- `plan/deep-research-report (1).md:132-144` recommends layered architecture: language layer, semantic renderer registry, activation state, input/command layer, preview parity layer.
- `plan/deep-research-report (1).md:374-388` recommends implementation order: minimal selection-aware pipeline, Markdown keymaps, task checkbox, block widgets, properties/frontmatter subsystem, then Reading adapter.
- `plan/deep-research-report (1).md:390-416` recommends module boundaries and parser/mapping/history/performance tests.
- `packages/editor/src/index.ts:115-129` wires CodeMirror `markdown()`, history, extension contributions, and `livePreviewExtension`.
- `packages/editor/src/live-preview/types.ts:22-42` defines the current private/experimental renderer seam with `mark` and `replace` range kinds.
- `packages/editor/src/live-preview/extension.ts:37-42` implements selection/focus source reveal by suppressing preview ranges intersecting selection.
- `packages/editor/src/live-preview/extension.ts:81-132` builds viewport-bounded CodeMirror decorations through a `ViewPlugin`.
- `packages/editor/src/live-preview/renderers.ts:126-192` includes current default renderers: blockquote line, heading, inline code, inline-code delimiter replace, markdown link, wiki link, tag, and task marker.
- `packages/editor/src/live-preview/task-toggle.ts:16-61` implements source-backed task marker toggling by CodeMirror transaction.
- `tests/editor-live-preview-blocks.test.ts:20-106` covers Pass 3 blockquote line-preview foundation.
- `tests/editor-task-toggle.test.ts:57-168` covers source-backed task toggles, undo/redo, and active source reveal.
- `apps/desktop/src/renderer/src/styles.css:476-522` scopes current Live Preview styles under `.markdown-editor`.
- Verification during analysis: `pnpm vitest run tests/editor-live-preview-primitives.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/desktop-live-preview-styles.test.ts` passed 5 files / 33 tests.
- Verification during analysis: `pnpm --filter @zorid/editor run typecheck` and `pnpm lint:boundaries` passed.

## Constraints

- Planning only: do not implement source changes in this RALPLAN turn.
- Keep Pass 4 bounded to one low-risk structured widget proof.
- Markdown source remains canonical; widgets must not become durable data stores.
- Renderer/API additions remain private to `packages/editor/src/live-preview` unless tests prove a narrow package-root export is needed.
- No new dependencies unless a later execution pass proves an existing dependency cannot support the feature.
- No tables, properties/frontmatter visual editor, embeds/images/PDF widgets, math rendering, Reading parity adapter, or public third-party renderer API in this pass.

## Unknowns / open questions

- Whether the first structured widget should be fenced code block shell or callout shell. Current planning recommendation favors fenced code block shell because it is lower risk and exercises `WidgetType`/activation without OFM callout semantics.
- Whether current regex code-context helpers are sufficient for first widget range detection or need a small block scanner; broad Lezer/parser migration is intentionally deferred.
- Whether Happy DOM can adequately assert widget DOM/mapping behavior or whether some interaction checks need browser/e2e smoke later.

## Likely codebase touchpoints

- `packages/editor/src/live-preview/types.ts`
- `packages/editor/src/live-preview/internal-types.ts`
- `packages/editor/src/live-preview/extension.ts`
- `packages/editor/src/live-preview/renderers.ts` or new `block-widgets.ts` / `widgets.ts`
- `packages/editor/src/live-preview/markdown-code-context.ts`
- `packages/editor/src/live-preview/index.ts`
- `packages/editor/src/index.ts` only for existing experimental exports if needed
- `apps/desktop/src/renderer/src/styles.css`
- Tests: `tests/editor-live-preview-widgets.test.ts`, `tests/editor-live-preview-blocks.test.ts`, `tests/editor-live-preview-primitives.test.ts`, `tests/editor-task-toggle.test.ts`, `tests/editor-markdown-keymap.test.ts`, `tests/editor-package-wiring.test.ts`, `tests/desktop-live-preview-styles.test.ts`
