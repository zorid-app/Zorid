# Context Snapshot — Live Preview First Pass

## Task statement
Create a consensus implementation plan for the first pass of Zorid's Obsidian-style Live Preview editor work, focused on items 1-4 from the prior analysis:
1. editor ownership/boundary,
2. Live Preview core,
3. MVP renderers,
4. Markdown dialect foundation.

## Desired outcome
A durable Ralplan handoff with a PRD, test specification, Architect review, Critic review, and consensus gate. The plan must be implementation-ready but must not start coding.

## Known facts / evidence
- The two research reports in `plan/deep-research-report.md` and `plan/deep-research-report (1).md` converge on Live Preview as a CodeMirror 6 selection-aware projection over canonical Markdown source, implemented through decorations/widgets, not direct DOM patching.
- `plan/deep-research-report.md:5-9` separates Source mode, Live Preview, and Reading view.
- `plan/deep-research-report.md:115-121` states Live Preview and Reading view are separate technical paths.
- `plan/deep-research-report (1).md:5-11` recommends a selection-aware renderer registry with `StateField`, `ViewPlugin`, `WidgetType`, `atomicRanges`, clipboard/history handling.
- `plan/deep-research-report (1).md:374-416` recommends implementation order and test families.
- `docs/product/frontend.md:132-143` says `packages/editor` owns CodeMirror, load/save, plugin extension support, and should avoid forcing full document text into global reactive state.
- Current `apps/desktop/src/renderer/src/components/MarkdownEditor.vue:2-38` directly imports and mounts CodeMirror in the Vue component.
- Current `apps/desktop/src/renderer/src/App.vue:119-120,904-906` stores full `editorText`/`savedText` in Vue and passes it to the editor component.
- Current `packages/editor/src/index.ts:19-43` has a headless `MarkdownEditorHandle` with `EditorState`, but no mounted `EditorView` ownership.
- `packages/platform-api/src/index.ts:130-140,306-312` already exposes editor extension and Markdown processor contribution contracts.
- `apps/desktop/src/main/runtime.ts:1016-1025` registers editor extensions but leaves Markdown processors as no-op.
- `apps/desktop/src/main/runtime.ts:876-885` rewrites Markdown frontmatter for field updates, relevant to later Properties work but out of this pass.

## Constraints
- Planning only; no implementation in this workflow.
- First pass should include items 1-4 only.
- Exclude tables, Properties/frontmatter visual editor, embeds, callouts, Reading view parity, and public third-party renderer API stability from first-pass delivery.
- Preserve existing open/edit/autosave behavior.
- Keep Markdown source as canonical data; preview widgets/decorations must not become durable data.
- Respect current API-gated package boundaries and import boundary checks.

## Unknowns / open questions
- Exact CM6 renderer API names are not yet designed in code.
- Whether current `EditorExtensionContribution.extension: unknown` is sufficient for first-pass internal extensions or should be typed to CM6 `Extension` during implementation.
- How aggressively to remove full-document Vue mirroring in pass 1 versus preserving it as a compatibility bridge while introducing editor-owned transactions.
- Whether task checkbox toggle is simple enough for first pass; it should be optional/test-gated.

## Likely codebase touchpoints
- `packages/editor/src/index.ts`
- `packages/editor/package.json`
- `packages/editor/tsconfig.json`
- `apps/desktop/src/renderer/src/components/MarkdownEditor.vue`
- `apps/desktop/src/renderer/src/App.vue`
- `apps/desktop/src/renderer/src/markdown-autosave.ts`
- `packages/platform-api/src/index.ts`
- `packages/plugin-host/src/index.ts`
- `apps/desktop/src/main/runtime.ts`
- `tests/desktop-vault-editor.test.ts`
- `tests/desktop-markdown-autosave.test.ts`
- new tests under `tests/` for editor live preview registry, renderers, and desktop integration.
