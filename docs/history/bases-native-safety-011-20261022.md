# Actual native safety011 — 2026-10-22

**Failed after 44 recorded actions and seven checks**, at the empty-cell display
following a real partial bulk clear. The shared-body/conditional-history scenario
passed; an independent CLI write established B's retained conflict, and A's
score cleared durably to YAML null. Its cell rendered literal `null` instead of
empty text, blocking the next history step. Full safety acceptance remains open.

## Exact source and evidence

Output: `/private/tmp/zorid-bases-safety-current-20261022-011`.
The report records `2026-10-22T18:36:00.350Z` through
`2026-10-22T18:37:11.821Z`, frozen application
`140eafc13983a16c29ff7f48e9c991daafd418c3`, Rust tree
`07265b1d344e89cd84c2fae143c4c4ab8678c2ca` and desktop011.
The matched host was
`/private/tmp/zorid-bases-final-native-07265b1d/zorid-desktop-host`, SHA-256
`403cbeb86da2d0279cd919134bd3ebc53cd95b21b9303e5581b6a08fce2d3c99`.
All 333 dist hashes match
`/private/tmp/zorid-bases-final-fixtures-desktop-build-20261022-011-receipt.json`
(SHA-256 `23a19079268657cf7e33dc5b385e75b3bd3ad387d60daa8353b96de47e52d3ba`),
whose producer is the same application commit.

| File in the output directory | SHA-256 |
| --- | --- |
| `result.json` | `e24e433292808a3da4efad3ec1bc7181c705f37a69c16101a4eac12d55e72c36` |
| Identical `provenance-before.json` / `provenance-after.json` | `33228f67a462198e1eeda13e9329be2ecef8cc450ed5833fe34e9771679b037a` |
| `failure.png` | `fb2e594ff3bd006121f8e21a0a21f1054ad520a7c547f3d10186c2fda9627dbd` |
| `s01-shared-body-conditional-history.png` | `4339101555f3d9066a2756badbd4dc0bdc12397c3a51224f7281c63988d1be9a` |

## Passed boundaries and exact stopping point

The scenario ledger marks `shared-body-and-conditional-history` passed: shared
dirty body plus Base property commit, separate editor undo/redo, preservation of
unrelated external content during Base undo/redo, and refusal of a later touched
score change. The seven check rows are window visibility, five saved-source
checks in that scenario, and `partial-clear-first-file-durable`.

The corrected [conflict fixture](../../tests/bases-electron-safety-integration/campaign.mjs)
appends through the actual body caret and races a real independent CLI write,
rather than relying on an external filesystem branch merge. Its retained record
contains the public version1 `ok:true` CLI envelope, genuine commit receipt,
exit0/null signal and verified cleanup. CLI SHA-256 was
`8e4e61e4f158f0bfcc1a40286f9a3f677ecabc741ffba680a901721b4246f42b`.
Operation `bases-safety-external-7824c7ed-f159-4be2-b52d-c8f3e6165a24` commits B
from revision `aad2c75f-ad2f-4c1b-865e-97bddef419cf` to
`6aa90955-8685-4f9a-a6a2-3a9925be804b`, sequence 67. The retained checkpoint
has `conflict: true`, original base and exact local body draft, while physical
B holds the external source. This is an established precondition in 011, unlike
the invalid conflict setup in earlier 009.

The real A/B range Delete then reached the partial-completion message and
durable A check. A's full physical source has `score: null`, preserves unrelated
frontmatter/body content and hashes to
`03d3d1b05ef5caeb80904514f615a6648cada8d207710035416f8b25422c591e`.
B remains the exact 128-byte external source, SHA-256
`5a6588ae385053b8a5465d763cf9e197b391e8184f39d20d2df9bea04195c45e`,
matching the CLI input hash. This audit independently checked both files and
the captured CLI stdout/stderr hashes and envelope.

The next assertion, `Partial success publishes fresh saved row before history`,
requires A's rendered score cell to be empty. Failure DOM and the inspected
2560×1804 screenshot show literal `null`, B still 2 and Total 2. This is a product
null-display blocker, not failure to persist A or establish B's conflict.
Partial-command undo, recovery-copy/retry and final restart did not execute;
the eleven later scenario entries are explicitly unexecuted.

## Cleanup, source fixes and acceptance limits

The runner records Electron PID 91370 terminated by `SIGKILL-cleanup`, exitCode
null/signal SIGKILL; identified native child PID 91462, `leaked: []`. Normal quit
did not pass. Before/after provenance is byte-identical and
`provenanceVerified: true`; this audit independently matched all 836 source
hashes to frozen Git blobs, saved-source hashes and the frontend receipt.

The documentation snapshot `f10da606f3963d272b0fb2ea48edb83de14d4654` composes
reviewed later source changes: split continuation ownership `e852ff26`, physical
registry Apply guarding `29128ef6`, and null-display correction `f10da606`.
Those fixes were absent from this frozen run. Building frontend012 or composing
reviewed tests does not retroactively pass 011; the correction and remaining
journey require fresh actual execution. This record does not accept all safety,
registry CAS, split-race, full heavy-user, reference parity or main integration.
This documentation task launched no app, build or product test and changed no
product files or checkpoint.
