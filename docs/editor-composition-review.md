# Editor composition and selection integration audit

Audited original Zorid source at `ee44810` on 2026-10-16. This pass used the actual
`createEditor` factory, CodeMirror commands, transaction dispatch and rendered
widget controllers in jsdom. It did not inspect or execute proprietary code.

## Reproduced defect: table activation drops secondary selections

`live-tables.ts` `receiveSelection()` reads the owner's main selection and calls
`activate()`. Activation writes `EditorSelection.single(...)` to the owner. If a
main caret enters a rendered cell while another caret remains in ordinary note
text, the scheduled cell activation silently drops the other caret and changes
`mainIndex`. Subsequent typing affects only the table. Swapping the main index
so the ordinary text caret is primary preserves both carets and both edits.

`tests/editor-composition-review.test.ts` contains both cases. The first is an
intentionally failing regression on the audited commit, not skipped or marked as
an expected failure. Before integrating this test into a green branch, fix the
selection ownership behavior. Preserve complete selections across the parent /
child boundary; suppressing child activation for multi-range selections is one
possible host policy, but native appearance and input behavior still need review.

## Passing checks

Seven checks passed; one regression failed:

- Forward deletion of emoji, a ZWJ emoji sequence and a flag inside a table cell
  produces valid text and round-trips through parent-owned undo/redo.
- Synthetic composition transaction updates retain the same nested cell editor,
  map escaped pipes and UTF-16 offsets correctly, and undo as one owner history
  event.
- A reversed selection across task, embed and table source replaces precisely
  that source range; undo restores original source, selection direction and widgets.
- Revealing embed source, deleting an emoji target and undoing restores exact
  source and caret offset.
- Two carets spanning text and a table preserve both edits when the text caret is
  primary, demonstrating that the failure depends on child activation.

Command: `node --test --test-concurrency=1 tests/editor-composition-review.test.ts`.

## Evidence limits and remaining native verification

Synthetic `compositionstart` / `compositionend` events plus explicit transactions
exercise listener lifecycle and our transaction bridge. They do not produce a
native IME, candidate popup or actual browser-managed composing DOM. jsdom has
no usable layout; zero geometry shims do not verify clicked positions, painted
multi-range selections, bidi caret movement or candidate placement.

Native checks remain necessary for Japanese/Chinese/Korean input and cancellation
inside live text, tables and revealed embeds; selection dragging across block
widgets; composed input during external updates; and grapheme/bidi arrow movement.
Combining-mark backward-deletion policy has not been asserted as parity: editor
commands may intentionally delete marks separately, and this audit collected no
reference evidence to establish a different rule.
