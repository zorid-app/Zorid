# Test Spec — Lezer Live Preview Parser Migration

Status: RALPLAN consensus approved
Date: 2026-05-30
PRD: `.omx/plans/prd-lezer-live-preview-parser-migration-20260530T031309Z.md`

## Test Strategy

The migration changes the semantic source of Live Preview from regex scanners to CodeMirror/Lezer syntax trees. Tests must prove behavior parity, parser ownership, bug regression coverage, static removal of regex parser paths, and bounded performance.

## Required Test Layers

### 1. Static/source gate: no live-preview regex parsers

Add a test such as `tests/editor-live-preview-no-regex-parsers.test.ts`.

Assertions:

- Scan production files under `packages/editor/src/live-preview` plus any private Zorid Markdown/parser-extension modules introduced for this migration. Prefer an AST/token-aware check when practical.
- Fail if forbidden parser tokens appear in production source after final migration:
  - `RegExp`
  - `.match(`
  - `.matchAll(`
  - `.exec(`
  - regex literal patterns used for Markdown recognition
- Prefer a zero-exception final state. If a non-parser exception is unavoidable, it must be allowlisted with file, line, and reason.
- The static test itself may use regex or string search; the restriction applies to production live-preview parser code. If the existing renderer seam remains, `LivePreviewRenderer.match(context)` is explicitly allowed as an API method name and must not be confused with `String.prototype.match`.

### 2. Parser facade tests

Add or extend tests around the private Zorid Markdown language module.

Assertions:

- Editor setup uses the private Zorid Markdown support wrapper, not bare `markdown()`.
- The parser includes GFM support for TaskList and Strikethrough.
- Private custom syntaxes create identifiable nodes/ranges for:
  - wiki links;
  - tags;
  - highlights;
  - frontmatter containers;
  - callout markers/groups, if needed by the renderer plan.
- Syntax-tree parsing covers current fixture documents without requiring public plugin APIs.
- Parser-order fixtures prove frontmatter and callout extensions bind before/after the relevant Markdown block parsers as intended.
- Barrel/export compatibility checks prove `packages/editor/src/live-preview/index.ts` continues to expose intended supported helpers and no longer exports replaced regex context helpers unless intentionally shimmed.

### 3. Syntax range collector tests

Add focused tests for `syntax-ranges.ts` or equivalent.

Assertions:

- The collector accepts `EditorState`, visible/near-visible bounds, focus/selection context, and returns normalized semantic matches.
- Collector tests construct editor states with the private Zorid Markdown language installed so syntax-tree assertions exercise the real parser configuration.
- It traverses only visible/near-visible bounds for normal collection.
- It uses `ensureSyntaxTree`/availability policy for the required upper bound and handles incomplete parse fallback deterministically.
- It emits stable ranges for heading, inline code, delimiter ranges, strong/emphasis, strikethrough, highlight, links, wiki links, tags, blockquotes, task markers, fenced-code widgets, and callout widgets.
- It emits suppression/container ranges from syntax nodes, not text scanning.

### 4. Existing Live Preview parity suites

Keep and update existing suites as behavior gates:

- `tests/editor-live-preview-primitives.test.ts`
  - headings;
  - inline code + delimiter hiding;
  - strong/emphasis/strikethrough/highlight;
  - Markdown links;
  - wiki links;
  - tags;
  - focused reveal.
- `tests/editor-live-preview-semantic-fixtures.test.ts`
  - frontmatter raw behavior;
  - fenced/indented code suppression;
  - no false positives inside code/frontmatter.
- `tests/editor-live-preview-widgets.test.ts`
  - fenced-code widget ranges;
  - widget reveal/restore;
  - pointer activation;
  - safe DOM;
  - bounded widget windows.
- `tests/editor-live-preview-callouts.test.ts`
  - callout marker/group fixtures;
  - ordinary blockquotes still render as blockquote lines;
  - unsupported/nested/lazy-continuation policies preserved;
  - public inline/task/link/tag ranges suppressed inside inactive callout widgets and preserved outside.
- `tests/editor-live-preview-selection-mapping.test.ts`
  - selection/reveal interactions remain source-position correct.
- `tests/editor-live-preview-clipboard.test.ts`
  - clipboard/source text behavior remains exact.

### 5. Task checkbox regression tests

Extend `tests/editor-task-toggle.test.ts` and/or semantic fixtures.

Required malformed fixture:

```md
- [ ]f- [ ]a 4- [ ]- [ ]
```

Assertions:

- Live Preview does not create a task checkbox range for malformed adjacent markers unless the parser identifies a valid GFM task-list marker.
- `findTaskMarkerAtPosition` returns `null` for positions inside malformed marker-like text.
- No returned task marker range spans a newline.
- Valid task-list items still render and toggle:
  - `- [ ] task`
  - `- [x] task`
  - nested valid task items when supported by GFM/list nodes.
- Toggling remains undoable/redoable and source-preserving with `Transaction.userEvent` of `input.task.toggle`.

### 6. Suppression/context tests

Assertions:

- Inline/link/tag/highlight/task ranges inside inline code are suppressed by node containment.
- Ranges inside fenced code, indented code, and frontmatter are suppressed by syntax container nodes.
- Ranges inside inactive widget activation ranges are suppressed through the private widget suppression seam.
- Ranges outside the suppression container remain visible.
- No suppression helper relies on `markdown-code-context.ts` regex scanning in final code.

### 7. Performance and viewport tests

Extend `tests/editor-live-preview-performance-fixtures.test.ts`.

Assertions:

- Syntax-tree traversal respects visible/near-visible bounds.
- Widget collection still uses bounded context windows and dedupes overlapping visible windows.
- Large documents with distant fenced code/callouts/tasks do not cause full-document traversal for normal visible-range collection.
- If `ensureSyntaxTree` is used, timeout and `upto` are bounded and tested.
- If fixture evidence is borderline, include a short before/after timing note in completion evidence.
- Existing performance fixtures remain green; run `pnpm perf:smoke` if targeted evidence is inconclusive.

### 8. Package/dependency tests

Assertions:

- `packages/editor/package.json` directly declares any Lezer/CodeMirror packages imported by editor source.
- Root package/lockfile stay consistent after dependency changes.
- Import boundary lint remains green.

## Validation Commands

Run in this order during implementation:

1. Targeted failing/green loop:
   - `pnpm vitest run tests/editor-live-preview-no-regex-parsers.test.ts`
   - `pnpm vitest run tests/editor-task-toggle.test.ts`
   - `pnpm vitest run tests/editor-live-preview-semantic-fixtures.test.ts`
2. Main Live Preview suites:
   - `pnpm vitest run tests/editor-live-preview-primitives.test.ts tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-callouts.test.ts tests/editor-live-preview-performance-fixtures.test.ts tests/editor-live-preview-selection-mapping.test.ts tests/editor-live-preview-clipboard.test.ts`
3. Project gates:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
4. Optional/no-worse performance gate if needed:
   - `pnpm perf:smoke`

## Completion Evidence Required

Implementation is not complete until the final report includes:

- Static gate result showing no live-preview regex parser paths.
- Targeted test output for Live Preview and task toggle suites.
- `pnpm lint` result.
- `pnpm typecheck` result.
- `pnpm test` result.
- Performance/no-worse evidence from fixtures or `pnpm perf:smoke`.
- A short list of any remaining allowed non-parser regexes, ideally empty.
