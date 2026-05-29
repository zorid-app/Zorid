Implement the approved RALPLAN plan for Live Preview Pass 2 from:
- PRD: .omx/plans/prd-live-preview-pass-2-20260529T061513Z.md
- Test spec: .omx/plans/test-spec-live-preview-pass-2-20260529T061513Z.md
- Handoff: .omx/plans/ralplan-handoff-live-preview-pass-2-20260529T061513Z.json

Hard constraints:
- Markdown source remains canonical; no rich-text document model.
- All source mutations must go through CodeMirror transactions/history.
- Keep renderer APIs internal/experimental; do not expose a public renderer API in packages/platform-api.
- Do not implement tables, properties/frontmatter UI, embeds, images/PDFs, image resize, callout widgets, math rendering, Reading view parity, broad Lezer/parser migration, or mobile/touch-specific behavior.
- Use CodeMirror contracts (extensions/decorations/transactions), not direct mutation of editor-managed content DOM.
- Preserve desktop open/edit/save/autosave behavior and import-boundary rules.

Goals:
1. Add internal task marker source helpers and a command-first source-backed checkbox toggle in @zorid/editor. Toggle current task lines between unchecked and checked via CodeMirror transactions; non-task lines no-op; click handling is deferred unless it stays tiny and fully tested.
2. Add task toggle/source/history tests. Cover unchecked/checked toggles, uppercase checked policy, indented tasks, non-task no-ops, unrelated text preservation, mounted onChange behavior, undo/redo, source reveal around task markers, and silent external setText behavior.
3. Verify Markdown list/task/blockquote keymap behavior before adding any custom input logic. Add mounted tests for current markdown() Enter/Backspace behavior; if behavior is sufficient, document no custom keymap was added. If not, use only official CodeMirror keymaps/extensions already in dependencies and test the gap.
4. Add an internal replace-preview capability plus exactly one renderer slice: inactive inline-code backtick delimiter hiding. Use heading marker hiding only as documented fallback if inline-code delimiter tests prove brittle. Preserve source text and reveal raw source on focused selection intersection.
5. Run targeted and broad verification: new editor tests, existing live-preview/package-wiring/style tests, desktop autosave/vault editor tests, @zorid/editor typecheck, import boundaries, repo typecheck, and repo lint.
6. Run the mandatory final cleanup and independent code-review gate; resolve any blockers; commit changed files with a plain descriptive commit message after the final gate passes.
