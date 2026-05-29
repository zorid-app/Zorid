# Test Spec — Live Preview Pass 4: Structured Widget Activation Foundation

Date: 2026-05-29  
Related PRD: `.omx/plans/prd-live-preview-pass-4-structured-widget-activation-20260529T095644Z.md`

## Test Objectives

1. Prove the first fenced-code structured widget is source-preserving.
2. Prove focused selection and pointer activation reveal raw source predictably.
3. Prove fenced-code matching avoids unsafe incomplete-fence and code-context false positives.
4. Prove existing inline/block/task/keymap/editor regressions remain green.
5. Prove desktop styling remains scoped to `.markdown-editor`.

## Unit / Primitive Tests

Add `tests/editor-live-preview-widgets.test.ts` or equivalent focused coverage.

### Fenced code matcher fixtures

- Backtick fence: ````` ```ts\nconst x = 1;\n``` ````` emits one widget-capable range covering opening fence through closing fence.
- Tilde fence: `~~~js\nconsole.log(1)\n~~~` emits one widget-capable range.
- Longer fence: four-backtick opening closes only with at least four backticks.
- Info string is captured or represented in widget metadata without changing source.
- Incomplete/unclosed fence remains raw and emits no widget range by default; this must use a complete-fence matcher/helper distinct from suppression helpers that may intentionally include open fences.
- Mixed fence markers do not close each other.
- Indented code remains raw/source-like for this pass.
- A fenced code block containing `#tag`, `[link](x)`, `[[Wiki]]`, `- [ ] task`, or `> quote` does not emit tag/link/wiki/task/blockquote preview ranges inside the code block.
- The same inline/task/blockquote constructs outside fenced code continue to emit current ranges.
- Ordering is deterministic when a fenced-code widget range and outside line/mark ranges coexist near boundaries.

### Source preservation

- Collecting widget ranges does not change `state.doc.toString()`.
- Mounted rendering does not change `editor.getText()`.
- Focus, selection movement, pointer activation, and preview restoration do not change source text.

### Active/inactive reveal

- In inactive/unfocused context, complete fenced code emits a widget decoration/range.
- In focused context with selection inside opening fence, body, or closing fence activation range, widget preview is suppressed and raw source is visible.
- Selection outside the range restores widget preview.
- Boundary policy is explicit: cursor at range start and range end are tested according to the chosen intersection semantics.

### Widget lifecycle

- Mounted editor DOM contains the chosen class, e.g. `.z-live-preview-code-block-widget`, when inactive.
- Widget class uses stable identity behavior (`eq()` or equivalent) so repeated selection changes do not require unnecessary DOM churn where testable.
- Widget DOM is built through safe DOM APIs; tests may assert rendered text is textContent, not executable HTML.
- Pointer activation on widget shell reveals source at the documented source position if pointer activation is implemented in this pass.

### Atomic range / activation state policy

- If `EditorView.atomicRanges` is added, tests cover cursor/deletion boundary behavior around inactive widget ranges.
- If no `atomicRanges` is added, tests and implementation notes explicitly demonstrate why selection-intersection source reveal is sufficient for this pass.
- If a private `StateField`/`StateEffect` is added, tests cover activation persistence/restoration and no source mutation.

## Mounted Editor / Integration Tests

- Mount editor with complete fenced code and assert widget DOM appears inactive.
- Focus editor and dispatch selection inside the fenced code source range; assert widget DOM disappears/suppresses.
- Dispatch selection outside; assert widget DOM returns.
- Assert `editor.getText()` is unchanged across all selection movements.
- Existing mounted save shortcut and external silent `setText()` tests remain green.

## Desktop Style Tests

Update `tests/desktop-live-preview-styles.test.ts`:

- Include the final code block widget class in expected `.z-live-preview-*` classes.
- Assert every `.z-live-preview-*` selector remains scoped under `.markdown-editor`.
- Assert no global `pre`, global `code`, global `blockquote`, or `.markdown-preview-view` selectors are introduced for this pass.

## Regression Tests

Required targeted run:

```bash
pnpm vitest run tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-live-preview-primitives.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-package-wiring.test.ts tests/desktop-live-preview-styles.test.ts tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts
```

Required static checks:

```bash
pnpm --filter @zorid/editor run typecheck
pnpm lint:boundaries
```

Recommended full gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Optional desktop gate if host behavior changes beyond scoped CSS:

```bash
pnpm desktop:build
```

## Non-Goals for This Test Pass

- No screenshots required.
- No syntax highlighting/copy toolbar/code action tests.
- No tables/properties/callout/embeds/math/Reading parity/public renderer API tests.
- No mobile/touch tests.
- No performance benchmark unless implementation introduces suspected viewport/redraw regression.

## Completion Gate

The pass is complete only when:

1. Widget tests pass and enforce fenced-code widget matching, source preservation, and activation/source reveal behavior.
2. Existing Live Preview primitive/block/task/keymap/editor-package tests remain green.
3. Desktop styling remains scoped.
4. Editor typecheck and import-boundary checks pass.
5. Recommended full gate passes or any gap is explicitly documented.
6. Final implementation report confirms no out-of-scope features were implemented.
