# Test Spec — Live Preview Interaction + Internal Block Architecture Hardening

Date: 2026-05-30T04:18:14Z
Status: Draft for RALPLAN consensus

## Test Objective

Prove that Live Preview remains a source-backed projection after the Lezer migration while hardening selection, clipboard, activation, atomic policy, private block architecture, and viewport behavior.

## Test Families

### 1. Selection and mapping tests

Files:
- `tests/editor-live-preview-selection-mapping.test.ts`
- `tests/editor-live-preview-widgets.test.ts`
- `tests/editor-live-preview-callouts.test.ts`
- `tests/editor-task-toggle.test.ts`

Required cases:
- Focused cursor inside inline-code source reveals delimiter replacements.
- Selections spanning mark + replace ranges preserve adjacent preview ranges where expected.
- Selections spanning paragraph → task marker → paragraph reveal task source without changing document text.
- Selections spanning paragraph → fenced-code widget → paragraph reveal widget source and restore when selection leaves.
- Selections spanning callout widget boundaries reveal source and restore outside the range.
- Boundary cases at `from`, `to`, `activationFrom`, `activationTo`, and cursor exactly after widget/range end are explicit for inline replace and widgets.
- Pointer activation for task, code block, and callout places selection at the expected source-backed position.

Pass criteria:
- Canonical source text is unchanged except explicit task toggle command.
- Reveal/restore behavior is deterministic for focused and unfocused states.
- Tests document whether adjacent ranges remain previewed or reveal together.

### 2. Clipboard/source preservation tests

Files:
- `tests/editor-live-preview-clipboard.test.ts`
- possible new `tests/editor-live-preview-clipboard-mounted.test.ts` if mounted behavior is clearer separately
- possible private implementation file `packages/editor/src/live-preview/clipboard.ts`

Required cases:
- Copy source for inactive inline code includes Markdown delimiters.
- Copy source for task checkbox includes `- [ ]` or `- [x]` marker exactly.
- Copy source for fenced-code widget includes complete fence/source exactly.
- Copy source for callout widget includes complete callout Markdown exactly.
- Mixed contiguous selections return exact canonical Markdown substring.
- Cut behavior, if implemented as a command/filter, removes canonical source ranges and preserves undoability, with explicit undo/redo assertion wherever cut integration is implemented.
- Ordinary text selections pass through unchanged.
- Multi-selection clipboard behavior is covered if CodeMirror behavior is practical to simulate in the chosen test environment.
- Mounted or filter-level copy/cut behavior is attempted with CodeMirror clipboard seams.

Decision gate:
- Helper-level source slicing alone is insufficient final evidence unless a concrete Happy DOM/browser limitation is documented and an equivalent command/filter path is proven.
- If mounted/CM behavior needs integration, use `EditorView.clipboardOutputFilter` and/or commands with tests.

Pass criteria:
- Source-backed copy/cut behavior is exact and deterministic.
- No widget DOM text becomes the clipboard source of truth.

### 3. Activation and atomic-range policy tests

Files:
- `tests/editor-live-preview-widgets.test.ts`
- `tests/editor-live-preview-selection-mapping.test.ts`
- `packages/editor/src/live-preview/extension.ts`

Required cases:
- Cursor movement and selection around code-block and callout widgets follow the chosen policy.
- Cursor exactly at `activationTo` and exactly after the widget/range end has explicit expected behavior.
- Delete/backspace at both widget edges does not corrupt source.
- Pointer activation still reveals source even if atomic ranges are introduced.
- Current no-atomic-ranges test is either retained with stronger evidence or replaced with explicit private atomic-range coverage.

Pass criteria:
- The repository has one clear policy, not ambiguous comments.
- If `EditorView.atomicRanges` appears in production code, tests prove why.
- If `EditorView.atomicRanges` remains absent, tests prove cursor/selection behavior is still acceptable.

### 4. Private block architecture tests

Files:
- `tests/editor-live-preview-block-registry.test.ts`
- `packages/editor/src/live-preview/block-renderers.ts`
- `packages/editor/src/live-preview/renderers.ts`

Required cases:
- Private block renderer adapter maps match metadata to internal widget ranges.
- Code-block and callout widgets both use the shared private adapter path.
- Activation/source metadata is preserved through the shared path.
- Dedupe and visible scan-window behavior still come from the central widget pipeline.
- Public package root, `live-preview/index.ts`, and `packages/editor/package.json` export map do not export private block renderer helpers.

Pass criteria:
- Future first-party widgets can follow the same internal shape.
- No public plugin API is accidentally created.

### 5. Viewport/performance tests

Files:
- `tests/editor-live-preview-performance-fixtures.test.ts`
- `tests/editor-live-preview-no-regex-parsers.test.ts`

Required cases:
- Large mixed document with many headings, tasks, callouts, and code blocks returns only near-visible widget ranges.
- Task projections remain limited to requested visible ranges.
- Initial widget scan does not use whole document.
- No-regex parser ownership gate remains passing.

Pass criteria:
- Hardening does not regress bounded scan behavior.
- Lezer migration remains the parser basis.

## Regression Suites

Run after targeted fixes:

```sh
pnpm vitest run \
  tests/editor-live-preview-no-regex-parsers.test.ts \
  tests/editor-live-preview-parser-facade.test.ts \
  tests/editor-live-preview-primitives.test.ts \
  tests/editor-live-preview-semantic-fixtures.test.ts \
  tests/editor-live-preview-blocks.test.ts \
  tests/editor-live-preview-widgets.test.ts \
  tests/editor-live-preview-callouts.test.ts \
  tests/editor-live-preview-selection-mapping.test.ts \
  tests/editor-live-preview-clipboard.test.ts \
  tests/editor-live-preview-block-registry.test.ts \
  tests/editor-live-preview-performance-fixtures.test.ts \
  tests/editor-task-toggle.test.ts \
  tests/editor-markdown-keymap.test.ts \
  tests/editor-package-wiring.test.ts \
  tests/desktop-live-preview-styles.test.ts
```

Full gates:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

## Explicit Non-Tested / Deferred Areas

- Browser-native clipboard permission and OS clipboard integration beyond what unit/mounted tests can simulate.
- Real browser visual pixel stability for widget height changes.
- Tables, properties, Reading-view parity, embeds/images/math widgets, and public plugin APIs.

## Completion Evidence Required

- List of changed source/test files.
- Targeted interaction/clipboard/block/performance test output.
- No-regex parser gate output.
- Lint/typecheck/full test output or documented blocker with substitute evidence.
- Explicit note on atomic-range decision and why tests support it.

## Architect Review Improvements Applied

- Clipboard tests now require attempted mounted/filter-level behavior or an explicit limitation with equivalent proof.
- Atomic tests now require exact `activationTo`, after-end, delete/backspace edge, and pointer activation coverage.
- Private block tests now include package export-map boundary verification.

## Critic Review Improvements Applied

- Added undo/redo assertion expectation for implemented cut behavior.
- Added optional multi-selection clipboard coverage when practical to simulate.
