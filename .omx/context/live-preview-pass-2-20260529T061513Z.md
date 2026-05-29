# Context Snapshot — Live Preview Pass 2

Date: 2026-05-29T06:15:13Z
Task statement: Make a complete consensus plan for the next implementation pass after Live Preview first pass and Pass 1.5 grounding.
Desired outcome: Implementation-ready PRD/test specification and consensus handoff for the recommended next pass.

## Known facts / evidence

- `plan/deep-research-report.md` says Live Preview, Source mode, and Reading view are separate paths; Live Preview is editor-local, source-backed, focus/cursor-aware, and Reading view uses a separate Markdown render/post-processor path.
- `plan/deep-research-report (1).md` recommends a CodeMirror 6 architecture with language layer, semantic renderer registry, activation state, input/command layer, and preview parity layer.
- `plan/deep-research-report (1).md` recommends implementation order: minimal selection-aware core, list/blockquote keymap behavior, source-backed task checkbox toggle, then block widgets and tables later.
- `.omx/plans/prd-live-preview-first-pass-20260529T041049Z.md` planned editor boundary + selection-aware MVP renderers.
- `.omx/plans/prd-live-preview-pass-1-5-20260529T053819Z.md` planned visible styling, matcher hardening, low-risk Markdown input verification, and task checkbox decision.
- `packages/editor/src/index.ts` now owns mounted CodeMirror lifecycle through `MountedMarkdownEditor`, composes `markdown()`, plugin contributions, Live Preview extension, save keymap, and update listener.
- `packages/editor/src/live-preview/extension.ts` now computes viewport/focus/selection-aware `Decoration.mark` ranges.
- `packages/editor/src/live-preview/renderers.ts` includes regex-backed renderers for heading, inline code, Markdown link, wiki link, tag, and task marker.
- `apps/desktop/src/renderer/src/components/MarkdownEditor.vue` is a thin Vue host wrapper.
- `apps/desktop/src/renderer/src/styles.css` includes scoped `.markdown-editor .z-live-preview-*` styles.
- `tests/editor-live-preview-primitives.test.ts` covers range filtering, source reveal, MVP renderer set, matcher boundaries, table non-goal, mounted default renderers, save shortcut, and explicit task-toggle deferral.
- `tests/editor-package-wiring.test.ts` verifies CodeMirror ownership, default markdown keymap presence, extension contribution guarding, and silent external replacements.
- `tests/desktop-live-preview-styles.test.ts` verifies preview styles are scoped.

## Recent verification evidence

- `pnpm test -- tests/editor-live-preview-primitives.test.ts tests/editor-package-wiring.test.ts` passed: 2 files, 15 tests.
- `pnpm test -- tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts` passed: 2 files, 11 tests.
- `pnpm test -- tests/desktop-live-preview-styles.test.ts` passed: 1 file, 1 test.
- `pnpm --filter @zorid/editor run typecheck` passed.
- `pnpm lint:boundaries` passed.

## Constraints

- Markdown source remains canonical; no rich-text document model.
- Use CodeMirror transactions, decorations, widgets, facets/keymaps, and official extension seams; do not mutate editor content DOM directly.
- Keep renderer APIs internal/experimental; do not expose a public third-party renderer API in this pass.
- Avoid tables, properties/frontmatter visual editor, embeds, images, callouts, math widgets, and Reading view parity in this pass.
- Do not add dependencies unless explicitly requested.
- Keep existing desktop open/edit/save/autosave behavior green.

## Unknowns / open questions

- Whether source-backed checkbox should be command-only, click-enabled, or both; plan should prefer command-first and only allow click if it stays small and testable.
- How far to take replace/widget source hiding in this pass without destabilizing current mark-based MVP.
- Whether current CodeMirror Markdown keymap behavior is sufficient for desired list/blockquote/task continuation in mounted editor behavior.
- Whether regex matchers need small false-positive fixes before introducing replace decorations.

## Likely codebase touchpoints

- `packages/editor/src/live-preview/*`
- `packages/editor/src/index.ts`
- `tests/editor-live-preview-primitives.test.ts`
- Possible new tests: `tests/editor-live-preview-task-toggle.test.ts`, `tests/editor-markdown-keymap.test.ts`, `tests/editor-live-preview-replace.test.ts`
- `apps/desktop/src/renderer/src/styles.css` only if task checkbox or replace-preview classes need minor visual updates.
