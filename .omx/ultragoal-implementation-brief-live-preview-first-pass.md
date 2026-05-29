Implement the approved Live Preview first-pass plan from `.omx/plans/prd-live-preview-first-pass-20260529T041049Z.md` and `.omx/plans/test-spec-live-preview-first-pass-20260529T041049Z.md`.

Hard constraints:
- Markdown source remains the only durable document model.
- `packages/editor` owns CodeMirror dependency/export wiring and mounted editor lifecycle.
- CodeMirror document state is source of truth; any Vue full-text state is temporary one-way autosave/display cache with guarded external replacement semantics.
- Preserve current open/edit/save/autosave user behavior.
- Do not implement tables, Properties/frontmatter visual editor, embeds/callouts, Reading view parity, mobile touch behavior, or stable public third-party renderer API in this pass.
- Keep changes inside planned touchpoints and preserve import-boundary rules.

Goals:
1. Move CodeMirror mounted-editor ownership into `@zorid/editor`: declare/own CodeMirror dependencies, expose a mounted editor factory, compose base Markdown/save/change extensions, decide and implement guarded handling for `EditorExtensionContribution.extension`, and add targeted package-boundary tests.
2. Convert the desktop Vue `MarkdownEditor` into a thin host wrapper around `@zorid/editor`, preserving edit/save/autosave semantics and making any remaining Vue full-text state explicitly cache-only.
3. Add testable Live Preview core primitives in `@zorid/editor`: renderer registry/composition types, visible-range aware matching context, focus/selection-aware active-source versus inactive-preview policy, deterministic range filtering, transaction-safe decoration mapping, and source-text invariants.
4. Add MVP first-party preview renderers for low-risk Markdown elements: headings, inline code, Markdown links, wiki links, tags, and optionally task checkbox markers only if source-backed tests are solid; no complex widgets.
5. Add/update targeted tests for renderer matching, active-source reveal, inactive preview decoration behavior, source-text preservation, dependency/export wiring, and existing desktop autosave/open/save behavior.
6. Run verification: `pnpm lint:boundaries`, `pnpm --filter @zorid/editor run typecheck`, targeted Vitest tests for editor/desktop autosave, `pnpm typecheck`, and `pnpm lint` if available/feasible.
7. Run the mandatory final cleanup and independent code-review gate; only complete the aggregate goal if cleaner, verification, code-reviewer, and architect review all pass.
