# Actual native safety009 — 2026-10-22

**The shared-body/conditional-history scenario passed**, including refusal to
undo an intervening touched-property change. The full campaign failed after
**39 recorded actions and six completed checks**, while establishing the next
partial-bulk fixture's retained-conflict precondition. No partial bulk command
ran. Eleven later scenario entries and final restart remained unexecuted.

## Exact source, artifacts and evidence

Output: `/private/tmp/zorid-bases-safety-current-20261022-009`.
The report records `2026-10-22T17:57:17.781Z` through
`2026-10-22T17:58:48.567Z`, frozen application
`ba6304a5387f8f107b083ceddb150f795648a9b7` and Rust crates tree
`79bbf4f9a6986c536cd096e0d681f260cce9fd72`. The documentation snapshot
`cd84177919504bac21d7bd6735a07afd3bd1cd20` has the same Rust tree; it is not
substituted for the actual campaign commit.

The matched host was
`/private/tmp/zorid-bases-conditional-native-79bbf4f9/zorid-desktop-host`, SHA-256
`d9f1606848d0f0477aad938d2773b02e2c15bc8f9d1f84e994aa3a50719e684d`.
Its passing native/CLI build receipt is
`/private/tmp/zorid-bases-conditional-native-79bbf4f9/receipt.json`, SHA-256
`bf0c76e255ae38b836740d999e4db42139425a2f1c9185219a4ba167242cc0ef`,
build source `ed225fae77203e4ada3bed15e1ee4d9f72484c63` with the same Rust tree.
Desktop009's receipt is
`/private/tmp/zorid-bases-conditional-desktop-build-20261022-009-receipt.json`,
SHA-256 `e212e0b6d638cd383096edd1e16adec37ac19537c43cda0840f1aeebba80278f`;
it records terminal exit0 and source `ba6304a5…`. All333 dist hashes match the
probe provenance. The [safety campaign](../../tests/bases-electron-safety-integration/campaign.mjs)
source SHA-256 was
`1df31421601398ab9ade84302d24f5596123fe551903a414db7f3cc47ad8fc30`.

| Retained file, relative to the output directory | SHA-256 |
| --- | --- |
| `result.json` | `c6e0f2f0aeb504dff61571600b9d1883bdf0f23dc77f0795c3ffed460daacc88` |
| `provenance-before.json` and identical `provenance-after.json` | `f0294e2e0dcc0303f934847def2ae1bc8831027a595d51e71238f21cd46dc07c` |
| `s01-shared-body-conditional-history.png` | `59b14773e302aebef71187620956228d969f6aeb73bd54b5440463d910ce49fe` |
| `failure.png` | `b900e60fac44ec748450d1a1fdf981692b52be484f5e0c05fe2360f0190837cf` |

Both screenshots are2560×1804 pixels. They were inspected as diagnostic evidence,
not matched-reference visual acceptance. This audit independently recomputed
these hashes and the host hash, matched all836 recorded tracked source hashes
against frozen `ba6304a5` Git blobs, and checked both build-receipt/log hash
associations. No application, build or product test was rerun.

## Completed shared-body and conditional-history scenario

The scenario ledger marks `shared-body-and-conditional-history` passed. The six
check rows comprise the owned visible-window observation and five durable-source
checks; the final touched-property rejection is an additional assertion within
that completed scenario, not an invented seventh check row.

- An ordinary A editor held the intended unsaved body append while the other
  pane committed Base score1→9. The resulting physical source retained both.
- Editor undo removed only its body append while preserving score9; editor redo
  restored the exact prior saved source.
- An external writer changed unrelated frontmatter/body content. Base undo
  changed score9→1 while retaining that external content; redo restored score9
  with the exact same unrelated external bytes.
- A later external writer changed the touched score9→7. Base undo displayed
  `A touched property changed after this command; its current value was preserved`.
  The campaign asserted that the complete physical source remained exact.

Final A source SHA-256 was
`3bb9062ef7425fcd26912685cee07a2ef7b7b03ab4d478bae663f89ed38fcec1`,
with score7, the shared body marker and unrelated external content. The retained
scenario screenshot still displays9 in the rendered grid/properties while
showing the refusal. This scenario proves protected physical bytes and the
observed rejection; it does not establish subsequent rendered-value convergence.

## Partial-bulk fixture failure and bounded diagnosis

The next scenario, `partial-bulk-conflict-history-and-recovery`, failed at
`Real native conflict retains typed draft` in `conflictNote`, before range
selection, Delete, partial-clear/undo or recovery-copy assertions. The fixture
used the driver's ordinary Select All/text input to insert a **complete note
source** into Live Edit, then externally appended an authority marker while the
physical note still held the earlier source. It expected a retained conflict.

Live Edit's [property-boundary selection guard](../../src/editor/live-properties.ts)
keeps the hidden frontmatter prefix outside body selection. The actual native
write request already contained two frontmatter blocks: the retained original
prefix plus the fixture's full source inserted into the body. This is a fixture
construction error, not evidence that the product duplicated the prefix itself.
The subsequent external observation merged the local and external text branches;
the final physical/core source includes both markers rather than the fixture's
expected retained-conflict state. The run remains failed; these facts do not
convert it into partial-bulk/recovery acceptance.

The guarded-buffer owner supplied the causal anchors, then this audit checked the
original disposable SQLite database directly using `mode=ro&immutable=1`, with
no WAL present. B entry `615eb02f-30a1-4839-8396-620c04eeb12f` had original revision
`9b0de6b6-9007-420f-9225-1a657b2826d4`. Host intent6, operation
`ae2f4079-65c8-4280-b7c8-9c44364dad9f`, is committed and acknowledged; its requested
bytes already have the duplicate prefix. External observation
`5c26fda4-f237-41dd-b656-12314aa0a864` retains the original baseline and external
append. Final B revision is `3483a30b-dbec-4a47-86fc-07f602c9b1f6`; its212-byte
core content and physical file have SHA-256
`c22ca4303c87fcf6e1ab1c18ce632c56211b918109a392d082ba1b1e2f8c760d`.
Both `Retained B body draft` and `External authority Retained B body draft` are
present. The vault database SHA-256 remained
`d6595d1f4a4cb1d54f664a2de10da61ec3cd6295843af37997d2695450e6c7b6`
before/after read-only inspection. No source or database write was performed.

## Cleanup and remaining scope

The visible owned app was PID8352 and identified native child PID8426. The
runner records `SIGTERM-cleanup`, Electron exit0 with null signal and
`leaked: []`. The source/artifact provenance objects match exactly and
`provenanceVerified` is true. This is the retained runner cleanup proof, not a
new historical process-list capture; the campaign's final normal-quit/restart
steps were not reached.

Property-settings CAS, live-summary stale/newer input, path reuse/close guards,
named-reference retry, mounted/nested/fenced rename, Hover/New publication,
typed/null/list/link/date/folder operations and sidebar scenarios remain
unexecuted in this run. Full safety acceptance and the broader implementation
goal remain open. This task created only this history file and did not edit
the coordinator checkpoint or product source.
