# Context Snapshot — Live Preview Interaction + Internal Block Architecture Hardening

Date: 2026-05-30T04:18:14Z

## Task statement
Create a RALPLAN consensus implementation plan for the next Live Preview pass: interaction hardening with explicit selection and clipboard coverage, plus internal block architecture hardening after the Lezer migration.

## Desired outcome
A durable, implementation-ready PRD/test-spec and Architect→Critic consensus handoff. The pass must harden selection, clipboard/source preservation, activation/boundary behavior, and private block-renderer architecture without starting tables, Properties/frontmatter visual editor, Reading-view parity, broad public plugin APIs, or a new parser migration.

## Known facts / evidence
- `/home/tingk/agent-context/Zorid/live-editor/deep-research-report.md:5-9` frames Obsidian Live Preview as source-backed editor projection, distinct from Source mode and Reading view.
- `/home/tingk/agent-context/Zorid/live-editor/deep-research-report.md:56-72` emphasizes focus/selection-driven source reveal and selection-boundary risk.
- `/home/tingk/agent-context/Zorid/live-editor/deep-research-report (1).md:5-11` recommends a selection-aware renderer registry over Markdown source using Lezer syntax tree, CodeMirror decorations/widgets, clipboard filters, history/effects, and atomic ranges where appropriate.
- `/home/tingk/agent-context/Zorid/live-editor/deep-research-report (1).md:134-144` proposes five architecture layers: language layer, semantic renderer registry, activation state, input/command layer, and preview parity layer.
- `/home/tingk/agent-context/Zorid/live-editor/deep-research-report (1).md:376-388` recommends staged implementation: language/selection core, list/blockquote keymaps, task checkboxes, block widgets before tables, Properties as a separate subsystem, Reading parity later.
- `/home/tingk/agent-context/Zorid/live-editor/deep-research-report (1).md:406-416` prioritizes parser/matcher fixtures, mapping tests, clipboard/history tests, and performance/viewport tests.
- `/home/tingk/agent-context/Zorid/live-editor/pass6.md:90-118` recommends selection/mapping, clipboard/source preservation, viewport/performance fixtures, and private custom block renderer registry as the next pass.
- `packages/editor/src/index.ts:129-157` centrally wires the editor extension stack, including `zoridMarkdown()`, history, plugin extensions, and default Live Preview internals.
- `packages/editor/src/live-preview/markdown-language.ts:185-195` defines the private Lezer Markdown facade with GFM and Zorid extensions.
- `packages/editor/src/live-preview/syntax-tree-ranges.ts:98-150` collects public Live Preview ranges from syntax trees.
- `packages/editor/src/live-preview/extension.ts:117-164` bounds widget scans around visible ranges and dedupes widget ranges.
- `packages/editor/src/live-preview/extension.ts:359-394` bridges view visible ranges into widget state with microtask dispatch.
- `packages/editor/src/live-preview/block-renderers.ts:14-51` already contains a minimal private block renderer adapter.
- `packages/editor/src/live-preview/renderers.ts:132-175` and `packages/editor/src/live-preview/renderers.ts:218-262` implement private code-block and callout widgets with source activation.
- `packages/editor/src/live-preview/task-toggle.ts:15-28` toggles task markers through CodeMirror transactions.
- `packages/editor/src/live-preview/source-text.ts:8-11` currently exposes exact canonical source text slicing, but no broader clipboard policy layer.
- `tests/editor-live-preview-no-regex-parsers.test.ts:55-81` gates Live Preview parser recognition against regex scanner regression.
- `tests/editor-live-preview-block-registry.test.ts:50-121` covers current private block registry adapter and private/public boundary.
- `tests/editor-live-preview-selection-mapping.test.ts:28-71` covers existing selection reveal behavior around inline replacements and widgets.
- `tests/editor-live-preview-clipboard.test.ts:13-37` covers source text extraction fixtures, but not CodeMirror clipboard hooks.
- `tests/editor-live-preview-performance-fixtures.test.ts:16-112` covers current viewport/performance fixtures.
- `tests/editor-live-preview-widgets.test.ts:319-322` documents the current no-atomic-ranges policy.
- Local CodeMirror typings expose `EditorView.clipboardInputFilter`, `EditorView.clipboardOutputFilter`, and `EditorView.atomicRanges` in `node_modules/@codemirror/view/dist/index.d.ts:1229-1352`.
- Fresh targeted verification during planning: `pnpm vitest run tests/editor-live-preview-no-regex-parsers.test.ts tests/editor-live-preview-parser-facade.test.ts tests/editor-live-preview-block-registry.test.ts tests/editor-live-preview-performance-fixtures.test.ts tests/editor-live-preview-selection-mapping.test.ts tests/editor-live-preview-clipboard.test.ts` passed 6 files / 22 tests.

## Constraints
- Planning-only RALPLAN turn: do not implement source code changes in this workflow.
- Markdown source remains canonical; widgets/decorations are projections only.
- Lezer migration is already done for the current Live Preview surface; do not plan another broad parser rewrite.
- Keep internal block helpers private under `packages/editor/src/live-preview`; do not expose a stable public third-party custom block/plugin API in this pass.
- Selection and clipboard are primary acceptance criteria, not optional follow-ups.
- No table editor, Properties/frontmatter visual editor, Reading-view parity adapter, embeds/images/math widgets, public plugin API, or new dependencies unless implementation proves a narrow need.
- Preserve existing Lezer/no-regex gates, desktop editor behavior, autosave behavior, import boundaries, lint, typecheck, tests, and performance smoke gates.

## Unknowns / open questions
- Whether CodeMirror `EditorView.atomicRanges` should stay unused or be introduced for selected widget classes; this pass should decide via tests, not preference.
- Whether clipboard preservation can be satisfied by source-slice helper plus explicit commands/tests, or needs `EditorView.clipboardOutputFilter`/`clipboardInputFilter` integration.
- How far to generalize the private block renderer contract without prematurely designing a public plugin API.
- Whether code-block/callout widget `WidgetType.updateDOM()` or `estimatedHeight` is needed now, or should remain deferred until measured/reproduced.

## Likely codebase touchpoints
- `packages/editor/src/live-preview/block-renderers.ts`
- `packages/editor/src/live-preview/extension.ts`
- `packages/editor/src/live-preview/internal-types.ts`
- `packages/editor/src/live-preview/renderers.ts`
- `packages/editor/src/live-preview/source-text.ts`
- possible new private modules under `packages/editor/src/live-preview/`: `activation.ts`, `clipboard.ts`, `block-registry.ts`, or similar if they simplify existing internals
- `tests/editor-live-preview-selection-mapping.test.ts`
- `tests/editor-live-preview-clipboard.test.ts`
- `tests/editor-live-preview-block-registry.test.ts`
- `tests/editor-live-preview-performance-fixtures.test.ts`
- `tests/editor-live-preview-widgets.test.ts`
- regression suites: `tests/editor-live-preview-primitives.test.ts`, `tests/editor-live-preview-blocks.test.ts`, `tests/editor-live-preview-callouts.test.ts`, `tests/editor-task-toggle.test.ts`, `tests/editor-markdown-keymap.test.ts`, `tests/editor-package-wiring.test.ts`, `tests/desktop-live-preview-styles.test.ts`
