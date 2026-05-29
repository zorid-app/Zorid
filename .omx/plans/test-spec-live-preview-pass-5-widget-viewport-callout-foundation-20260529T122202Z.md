# Test Spec — Live Preview Pass 5: Widget Viewport + Callout Foundation

Date: 2026-05-29  
Related PRD: `.omx/plans/prd-live-preview-pass-5-widget-viewport-callout-foundation-20260529T122202Z.md`

## Test Objectives

1. Prove private widget decoration collection is bounded to visible/near-visible ranges or has a documented/tested narrow full-document exception.
2. Preserve all existing fenced-code widget activation, source-preservation, pointer activation, safe DOM, and no-atomic-ranges behavior.
3. Prove one private callout widget can be matched, mounted, activated, restored, and styled without changing Markdown source.
4. Prove ordinary blockquotes and existing inline/task/link/tag renderers remain correct outside callout/widget ranges.
5. Prove desktop callout styles remain scoped to `.markdown-editor`.

## Unit / Primitive Tests

### Widget viewport behavior

Add coverage in `tests/editor-live-preview-widgets.test.ts` or `tests/editor-live-preview-widget-viewport.test.ts`:

- A document with one visible complete fenced-code block and one distant complete fenced-code block emits only the visible widget range for the active visible window.
- Moving/changing the visible window to the distant block emits the distant widget range.
- Widget collection uses the same or an explicitly documented near-visible scan expansion policy for code and callout widgets.
- Tests prove scanner work/input windows are bounded separately from emitted ranges. Use a test-only widget renderer that records `visibleFrom`/`visibleTo`, an instrumented scanner helper, or another deterministic assertion that fails if normal viewport rebuilds pass `{ from: 0, to: state.doc.length }` or otherwise consume unrelated distant regions.
- A distant-widget absence assertion alone is not sufficient for this pass unless paired with scanner-work/window proof.
- Include a visible-range fixture inside or adjacent to a long fenced block/callout where opener or closer is outside the viewport, proving bounded semantic-container context expansion without scanning unrelated distant regions.
- A focused selection intersecting a visible widget range suppresses the widget and reveals source.
- Pointer activation still dispatches selection to the documented source position after viewport hardening.
- `EditorState.doc.toString()` remains exact before/after widget collection and selection transitions.
- If a private visible-range bridge is introduced, tests cover initial state, focus changes, selection changes, doc changes, and viewport/range updates.
- If a full-document exception remains, tests must assert and document the threshold/rationale, and the PRD should be updated to explain why it is safe for the current pass.

### Fenced-code regression

Existing tests in `tests/editor-live-preview-widgets.test.ts` must remain green and should still cover:

- Complete backtick and tilde fences emit private `code-block-widget` ranges.
- Longer fence markers close only with matching marker/length.
- Incomplete/unclosed fences emit no widget range.
- Indented code remains raw/source-like.
- Inline/task/tag/link/wiki/blockquote renderers are suppressed inside fenced code and work outside.
- Focused range start, body, and range end suppress the widget; range end + 1 restores preview.
- Mounted reveal/restore and pointer activation do not mutate source.
- Widget DOM uses text APIs and does not execute user Markdown as HTML.
- No `EditorView.atomicRanges` policy remains explicitly tested unless implementation adds atomic ranges.

## Callout Matcher Tests

Add `tests/editor-live-preview-callouts.test.ts` or an equivalent section in widget tests.

### Positive fixtures

- `> [!note]\n> Body` emits one callout widget range covering both quoted lines.
- `> [!warning] Custom title\n> Body` captures type `warning`, title `Custom title`, and body source.
- Up to three leading spaces before `>` are accepted.
- Quoted blank lines (`>` or `> `) remain inside the callout group.
- Multiple separate callouts emit deterministic non-overlapping ranges.
- A callout adjacent to normal paragraph text does not include the paragraph in the activation range.

### Negative / raw fixtures

- Ordinary blockquotes like `> quote` remain blockquote line ranges, not callout widgets.
- Unsupported marker forms remain raw/blockquote-line styled.
- Callout-like text inside fenced code emits no callout widget.
- Callout-like text inside indented code emits no callout widget.
- An unquoted blank line or unquoted paragraph interrupts and ends the callout group.
- Lazy continuation lines remain raw/outside the callout in this pass.
- Nested `>>` blockquotes remain raw/blockquote-line styled unless explicitly supported by implementation fixtures.
- Mixed content outside the callout still emits existing inline/task/tag/link renderers.

### Suppression / ordering fixtures

- Inline/task/tag/link/wiki/blockquote renderers inside an inactive callout range are suppressed by a private widget suppression/ordering seam.
- The same syntax outside the callout range continues to emit current ranges.
- A public renderer does not need callout-specific knowledge to be suppressed inside a widget range.
- Prefer tests that show widget ranges are computed once per active scan window and passed as private suppression ranges into public decoration collection, or document an equivalent private flow.
- Ordering is deterministic when code-block widgets, callout widgets, and outside mark/line ranges coexist; expected order should follow `from`, `to`, private priority/kind, then `rendererId` or a documented equivalent.

## Mounted Editor / Integration Tests

- Mount editor with a complete callout and assert `.z-live-preview-callout-widget` exists when inactive.
- Assert `editor.getText()` equals the original source immediately after mount.
- Focus editor and dispatch selection at callout range start, marker/title/body, and range end; assert callout widget is suppressed and source remains exact.
- Dispatch selection to range end + 1 or outside paragraph; assert callout widget returns and source remains exact.
- Dispatch `mousedown` on `.z-live-preview-callout-widget`; assert the editor is focused/selection is moved to the documented source position and source remains exact.
- Mount callout containing `<script>` literal text; assert widget textContent contains the literal text and no `script` element is created.
- Verify ordinary blockquote mounted line decorations remain for non-callout blockquotes.

## Desktop Style Tests

Update `tests/desktop-live-preview-styles.test.ts`:

- Add `.z-live-preview-callout-widget` and internal callout classes to the expected Live Preview class list.
- Assert every `.z-live-preview-*` selector remains scoped under `.markdown-editor`.
- Assert no `.markdown-preview-view` selector is introduced for callouts.
- Assert no global `blockquote`, global `pre`, or global `code` selectors are introduced by this pass.

## Regression Tests

Required targeted run when a separate callout test file exists:

```bash
pnpm test -- tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-callouts.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-live-preview-primitives.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-package-wiring.test.ts tests/desktop-live-preview-styles.test.ts tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts
pnpm --filter @zorid/editor run typecheck
pnpm lint:boundaries
```

Fallback targeted run if callout tests are folded into widget tests:

```bash
pnpm test -- tests/editor-live-preview-widgets.test.ts tests/editor-live-preview-blocks.test.ts tests/editor-live-preview-primitives.test.ts tests/editor-task-toggle.test.ts tests/editor-markdown-keymap.test.ts tests/editor-package-wiring.test.ts tests/desktop-live-preview-styles.test.ts tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts
pnpm --filter @zorid/editor run typecheck
pnpm lint:boundaries
```

Recommended full gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Optional desktop gate if scoped styling or mounted behavior changes materially:

```bash
pnpm desktop:build
```

## Non-Goals for This Test Pass

- No screenshot or pixel-diff requirement.
- No callout collapse, icon-pack, type-selector, context-menu, custom theme registry, or title-editing tests.
- No table/property/frontmatter/embed/math/Reading parity tests.
- No public plugin/widget API tests.
- No syntax highlighting/copy toolbar/code action tests.
- No mobile/touch tests.
- No benchmark requirement unless implementation turns viewport hardening into measurable performance optimization.

## Completion Gate

The pass is complete only when:

1. Widget viewport/bounded-collection tests pass or a narrow exception is explicitly tested and documented.
2. Existing fenced-code widget tests remain green.
3. Callout matcher, mounted activation, source preservation, safe DOM, and scoped styling tests pass.
4. Existing Live Preview primitive/block/task/keymap/package/autosave/vault tests remain green.
5. Editor typecheck and import-boundary lint pass.
6. Full `pnpm typecheck && pnpm lint && pnpm test` passes or any gap is explicitly documented.
7. Final implementation report confirms no out-of-scope public APIs, tables/properties/embeds/math/Reading parity, syntax highlighting, or new dependencies were added.
