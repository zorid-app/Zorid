# Test Specification — Live Preview First Pass

Status: Ralplan draft  
Date: 2026-05-29

## Test Strategy

This pass is primarily an editor architecture and selection-mapping slice. Tests should prove source text integrity, editor boundary ownership, renderer matching, active/inactive behavior, and preservation of existing desktop autosave flows.

## Unit Tests

### Renderer matcher tests
- Given Markdown headings, matcher returns exact heading/source ranges.
- Given inline code, matcher returns delimiter/content ranges without changing text.
- Given Markdown links and wiki links, matcher classifies visible label and raw source range.
- Given tags, matcher identifies body tags without treating ordinary URL fragments or frontmatter text as body tags where avoidable.
- Given task markers, matcher identifies `- [ ]` and `- [x]` only if checkbox renderer is included.

### Active/inactive policy tests
- Selection outside a renderer range permits preview decoration.
- Cursor inside a renderer range reveals raw source.
- Multi-range selection intersecting one renderer does not force all unrelated renderers raw unless intentionally implemented.
- Preview decorations do not mutate document text.
- Focus state participates in active/inactive policy: focused intersecting ranges reveal source; non-intersecting or unfocused eligible ranges can preview according to renderer policy.
- Visible-range filtering is deterministic for renderer builds, even if tiny-doc fallback scans the full doc internally.

### Extension composition tests
- Base Markdown support and Live Preview extensions compose without duplicate keymap/update listener side effects.
- First-party renderer registry ordering is deterministic.
- `@zorid/editor` owns CodeMirror dependency/export wiring required for mounted editor creation.
- Plugin `EditorExtensionContribution` values are either narrowed to CM6 `Extension` at the platform type level or unsupported unknown values are type-guarded and safely ignored/reported before composition.

## Integration Tests

### Editor mount lifecycle
- Mounting creates an editor in a provided host element.
- Destroying/unmounting destroys the `EditorView` without leaking listeners.
- External text replacement updates the CodeMirror doc without duplicate change events.
- If Vue retains a full-text cache for autosave/display compatibility, tests prove it is synchronized from editor updates and cannot overwrite newer editor text during file switches or external replacement.

### Desktop wrapper behavior
- Opening a Markdown file displays existing text.
- Editing text emits an autosave snapshot with latest source Markdown.
- `Mod-s` triggers immediate save and preserves existing behavior.
- Switching files flushes pending autosave before replacing editor state.

### Live Preview behavior
- Inactive heading/link/tag/inline-code ranges receive expected preview classes/decorations.
- Moving cursor into the range reveals raw Markdown source.
- Editing inside a revealed range updates source text and re-applies preview when cursor leaves.

## Regression Tests

- Existing `tests/desktop-markdown-autosave.test.ts` stays green.
- Existing `tests/desktop-vault-editor.test.ts` stays green.
- Existing platform/plugin API tests stay green if editor contribution types change; new tests cover type narrowing or unknown-value guarding.
- Import-boundary test stays green.

## Explicit Non-Tests / Deferred Areas

Do not test full table editor, Properties UI, embeds, callouts, image resize, Reading view parity, or public third-party renderer API stability in this pass, except to assert they are not included if helpful.

## Verification Commands

- `pnpm lint:boundaries`
- `pnpm --filter @zorid/editor run typecheck`
- `pnpm test -- tests/desktop-markdown-autosave.test.ts tests/desktop-vault-editor.test.ts <new-editor-tests>`
- `pnpm typecheck`
- `pnpm lint`
