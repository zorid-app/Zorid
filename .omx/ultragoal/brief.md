Implement the approved RALPLAN plan for Live Preview Pass 3 from:
- PRD: .omx/plans/prd-live-preview-pass-3-block-preview-foundation-20260529T091213Z.md
- Test spec: .omx/plans/test-spec-live-preview-pass-3-block-preview-foundation-20260529T091213Z.md
- Handoff: .omx/plans/ralplan-handoff-live-preview-pass-3-block-preview-foundation-20260529T091213Z.json

Hard constraints:
- Markdown source remains canonical; preview rendering must not mutate EditorState.doc.
- Implement only line-level blockquote preview foundation using a Decoration.line-style internal capability.
- Use one preview range per blockquote source line; focused selection suppresses only the active line decoration.
- No StateField or EditorView.atomicRanges by default; document them as later structured-widget needs unless tests prove unavoidable.
- Do not expose renderer registration through packages/platform-api or plugin APIs.
- Do not add a new named package-root export for blockquoteLivePreviewRenderer unless unavoidable for in-repo compatibility.
- Do not implement tables, properties/frontmatter UI, callout widgets, embeds/images/PDFs, math rendering, Reading view parity, broad Lezer/parser migration, or mobile/touch-specific behavior.

Goals:
1. Add tests-first coverage for blockquote Live Preview: line-level ranges, blank `>`/`> ` lines, indentation boundaries, code/table false positives, line.from/line.to activation boundaries, mounted DOM reveal/restore, and coexistence with inline renderers.
2. Add internal line-decoration support in @zorid/editor Live Preview and implement a private blockquote line renderer included in defaultLivePreviewRenderers.
3. Add scoped desktop styling for the blockquote line preview class and update style-scope tests.
4. Run targeted verification: block/live-preview/task/keymap/package/style/autosave/vault tests, @zorid/editor typecheck, and import boundaries.
5. Run broad verification: pnpm typecheck, pnpm lint, pnpm test, and any needed desktop build if host behavior changes.
6. Run the mandatory final cleanup and independent code-review gate; resolve blockers; commit changed files with a plain descriptive commit message after final gate passes.
