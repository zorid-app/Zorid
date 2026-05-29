Implement the approved RALPLAN plan for Live Preview Pass 1.5 from:
- PRD: .omx/plans/prd-live-preview-pass-1-5-20260529T053819Z.md
- Test spec: .omx/plans/test-spec-live-preview-pass-1-5-20260529T053819Z.md
- Handoff: .omx/plans/ralplan-handoff-live-preview-pass-1-5-20260529T053819Z.json

Hard constraints:
- Markdown source remains canonical; preview rendering must not mutate source except explicit source-backed commands.
- Do not implement tables, properties/frontmatter visual editor, embeds, image resize, math rendering, callout widgets, Reading view parity, mobile/touch behavior, or stable public third-party renderer API.
- Keep renderer APIs internal/experimental; do not add renderer registration to packages/platform-api.
- Preserve desktop open/edit/save/autosave behavior and import-boundary rules.
- Use CodeMirror contracts (extensions/decorations/transactions), not direct mutation of editor-managed content DOM.

Goals:
1. Split current Live Preview types/helpers/renderers/extension out of packages/editor/src/index.ts into internal packages/editor/src/live-preview modules while preserving current in-repo compatibility exports.
2. Add scoped, theme-aware visible CSS for current z-live-preview-* classes under the desktop .markdown-editor scope, plus a lightweight static test/source assertion rejecting unscoped z-live-preview selectors.
3. Harden matcher fixtures and active/inactive mounted behavior tests for headings, inline code, Markdown links, wiki links, tags, task markers, false positives, deterministic ordering, and source preservation.
4. Decide and implement the task marker path: command-first source-backed checkbox toggle with undo/history tests if small; otherwise explicit styling-only deferral with tests. Do not introduce a broad widget/event subsystem.
5. Verify current markdown() keymap behavior before adding anything; avoid duplicate custom keymaps unless tests demonstrate a concrete gap.
6. Run targeted and broad verification: editor live-preview tests, editor package wiring, desktop autosave/vault editor regressions, @zorid/editor typecheck, import boundaries, repo typecheck, repo lint.
7. Run the mandatory final cleanup and independent code-review gate; commit changed files with a plain descriptive commit message only after the final gate passes.
