# Actual native mapped selection003 — 2026-10-22

**Passed 60 recorded actions and 11 checks.** Ordinary-editor caret and forward
range selection remained correctly mapped across two Base property writes that
grew/shrank the hidden frontmatter prefix. Normal quit, a fresh process and
durable/UI readback also passed. This is the focused selection campaign, not
full heavy-user, navigation-race, dirty-body or reference-parity acceptance.

## Exact execution and source

Output: `/private/tmp/zorid-bases-selection-current-20261022-003`.
The report records `2026-10-22T18:41:54.220Z` through
`2026-10-22T18:42:11.302Z`, application
`75270dc88ebf5976a81168f66762a9f13c8d2f10`, Rust crates tree
`07265b1d344e89cd84c2fae143c4c4ab8678c2ca`.

The host was `/private/tmp/zorid-bases-final-native-07265b1d/zorid-desktop-host`,
SHA-256 `403cbeb86da2d0279cd919134bd3ebc53cd95b21b9303e5581b6a08fce2d3c99`.
Desktop011's passing receipt,
`/private/tmp/zorid-bases-final-fixtures-desktop-build-20261022-011-receipt.json`,
SHA-256 `23a19079268657cf7e33dc5b385e75b3bd3ad387d60daa8353b96de47e52d3ba`,
records producer `140eafc13983a16c29ff7f48e9c991daafd418c3`. The later campaign
commit contains test setup changes; all 333 recorded dist hashes match that
receipt. Its source commit is not substituted for the frontend producer.

## Completed mapping and persistence cases

The [campaign](../../tests/bases-electron-selection-integration/campaign.mjs)
uses one Base and one ordinary Live Edit note in separate panes. Real keyboard
navigation sets a caret before BRAVO on `Selection 🦀 anchor BRAVO CHARLIE tail.`.
After each Base edit, the existing note tab restores focus; there is no body
click, private editor call or DOM Selection assignment to restore the range.
The [oracle](../../tests/bases-electron-selection-integration/selection-oracle.mjs)
reads DOM selection and independently relates body UTF16 positions to exact
authored source strings.

| Case | Observed result |
| --- | --- |
| Collapsed caret, score 1→123456789 | Frontmatter prefix 53→61 UTF16 units. Caret remains at body offset 42 / line column 20, mapping source offset 95→103. Editor focus, collapsed state and exact line/prefix remain unchanged. |
| Forward BRAVO range, score 123456789→2 | Prefix 61→53. Anchor/head remain body offsets 42/47 and columns 20/25, with selected text BRAVO; source positions 103/108→95/100. Direction and editor focus remain exact. |
| Fresh process | Exact final note, Base and registry survive; split tabs return, the Base shows score 2 and the ordinary body line remains exact. Selection persistence across sessions is not asserted. |

The exact saved note hashes were
`8d40b0959f5e28816fa9dd606fb9eb1b7cc7cf29df7bd4e096d095a72712a919`
after prefix growth and
`1a4d829e88320e45965ec50616b24d364bcfe7f9e0e37808a7dfecee44f80d52`
after shrink/restart. Base hash remained
`b6a5d499f9434e217e194e243caed1209f91be29e3fff44caafdc4c935a938c6`;
registry hash remained
`54c56f58b4381ac3db737802f0a22d4a2fd3b80714d773c42ff76fc68897fa93`.
This audit independently reconstructed those exact source strings and UTF16
prefix lengths and checked the final physical files.

## Evidence and cleanup

| File in the output directory | SHA-256 |
| --- | --- |
| `result.json` | `b2d73d666dc87a4b4dc11931a578c279d4582ef8390b70bbf9bf6030dd679cec` |
| Identical `provenance-before.json` / `provenance-after.json` | `8c1ea3ba0c07894ed604c2ffae68cf90430b11c99e735b177bab4e5158b6c354` |
| `caret-prefix-grows.png` | `e49011207d14d4855813c274020dfd54d2ffc2b20332e9451dce12b34cea3b40` |
| `nonempty-range-prefix-shrinks.png` | `0a37ea134b4f832289521468026e27ac238367a03301c047ebb069a25d0044fd` |
| `mapped-selection-fresh-process.png` | `1e4f3d6b13a1368c7f9521886578e73e6b08099891b5842034a0d93285a70c07` |

The 2560×1804 range screenshot was inspected as supporting evidence. This audit
recomputed hashes, matched all 836 recorded source hashes against the frozen Git
blobs, verified the identical before/after proof and saved-source witnesses.
The report marks `provenanceVerified: true`.

Normal quit requests were accepted for Electron PIDs 2701 and 2963; both exited 0
with null signal. Cleanup records are `already-exited`, `leaked: []`; identified
native children were 2761 and 3036. No termination fallback was needed. The owned
window/renderer visibility checks are distinct from OS foreground or physical
keyboard parity.

Earlier selection001/002 setup failures remain historical. This successful
ordered setup does not resolve an unrestricted stale split/navigation race.
Later source changes at `f10da606` are not runtime evidence from this pass.
No app, build or product test was rerun by this documentation task.
