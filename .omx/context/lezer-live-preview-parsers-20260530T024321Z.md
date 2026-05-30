# Deep Interview Context Snapshot — Lezer Live Preview Parsers

## Task statement
Replace regex-based Markdown/live-preview parsing in Zorid with Lezer/CodeMirror syntax-tree parsing, and extend Lezer for Zorid custom syntax.

## Desired outcome
An execution-ready requirements spec that defines boundaries, success conditions, non-goals, and decision authority for a parser migration before implementation.

## Stated solution
Use Lezer parsing instead of regex parsers; custom syntax should be represented as Lezer Markdown extensions rather than ad-hoc regex scanners.

## Probable intent hypothesis
The user wants robust Markdown semantics and fewer rendering bugs like the observed task-checkbox mismatch, while preserving a source-backed Live Preview model.

## Known facts/evidence
[from-code][auto-confirmed] `package.json` already depends on `@codemirror/lang-markdown`, `@codemirror/state`, and `@codemirror/view`.
[from-code][auto-confirmed] `packages/editor/src/index.ts` already installs `markdown()` in the editor extension list.
[from-code][auto-confirmed] `packages/editor/src/live-preview/renderers.ts` contains many regex/matchAll-based renderers for inline code, emphasis, tags, links, blockquotes, callouts, and task markers.
[from-code][auto-confirmed] `packages/editor/src/live-preview/task-toggle.ts` independently uses a task-marker regex.
[from-code][auto-confirmed] `packages/editor/src/live-preview/markdown-code-context.ts` uses regex scanning for fenced code, indented code, and frontmatter suppression.
[from-code][auto-confirmed] Tests exist for live preview primitives, widgets, callouts, clipboard, selection mapping, performance fixtures, task toggles, and Markdown keymap behavior.
[from-research] CodeMirror `markdown({ extensions })` accepts Markdown parser extensions.
[from-research] Lezer Markdown supports defining node types and adding block/inline parser extensions; it parses to a syntax tree and does not render HTML.

## Constraints
- Deep-interview mode only: no implementation until requirements/spec are crystallized and handed off.
- Current project guidance prefers no new dependencies unless explicitly requested; Lezer packages may already be transitive via CodeMirror but direct dependency choices need a planning decision.
- Keep Markdown source as canonical; Live Preview widgets/decorations must remain projections over text.

## Unknowns/open questions
- Whether “all regex parsers” means every regex in live-preview parsing, or only semantic Markdown recognition that affects rendering.
- Which custom syntaxes are in scope for the first migration pass.
- Whether feature parity must be exact before removing regex fallback, or a staged hybrid is acceptable.
- Whether Reading view parity is part of this migration or deferred.
- Whether public plugin syntax registration is in scope or only private first-party custom syntax.

## Decision-boundary unknowns
- May OMX choose exact internal parser architecture and file layout?
- May OMX add direct dependencies on `@lezer/markdown` / `@lezer/common` if needed?
- May OMX temporarily keep regex fallback for unsupported syntax during migration?
- May OMX change public/internal live-preview renderer contracts?

## Likely codebase touchpoints
- `packages/editor/src/index.ts`
- `packages/editor/src/live-preview/renderers.ts`
- `packages/editor/src/live-preview/extension.ts`
- `packages/editor/src/live-preview/markdown-code-context.ts`
- `packages/editor/src/live-preview/task-toggle.ts`
- `packages/editor/src/live-preview/block-renderers.ts`
- live-preview tests under `tests/editor-live-preview-*.test.ts`
- `tests/editor-task-toggle.test.ts`
- `tests/editor-markdown-keymap.test.ts`

## Prompt-safe initial-context summary status
not_needed
