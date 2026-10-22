# Bases actual Electron campaign 012 — 2026-10-22

**Stopped on the first failure: 178 actions and 20 successful checks. Full
acceptance remains open.** The first numeric save left the durable rating at
`1`, rather than `5`. Seven passive receipts show a current editor begin and a
controller version advance after Enter; they do not identify the rejecting
guard, epoch change, identity mismatch or refresh trigger.

Executor: `bases_ui_review`. Actual run:
`2026-10-22T08:58:03.425Z`–`2026-10-22T08:59:39.933Z`.
Later journey steps were not executed. This record is evidence-only.

## Frozen source and artifacts

Runtime worktree `.worktrees/bases-frontend-validation`, branch
`codex/bases-frontend-validation`, was frozen at
`5082a703352b469de33d6b72fdc5ada31a095ccb`; its `src` tree was
`4d2d85d9022b5c8ec15acb522db34ea459bd6bd7`. Only reviewed passive DOM markers
and read-only journey receipts were added after 011. The numeric edit's original
double-click, type, Enter and idle sequence and its independent saved-value
oracle remain unchanged; no semantic wait, retry or guard relaxation was added.

The Rust `crates` tree stayed exactly
`5e010112661da69eb290d6a5edb72d4906e844a1`. The runner deliberately used
`/private/tmp/zorid-bases-preserved-native-5e010112/zorid-desktop-host`, the
preserved old host with unchanged SHA `176fcff5…`. Its path differs from 011;
the preserved-artifact receipt records the original path and matching bytes.
This is an **interim frontend diagnostic run against the old matching core**,
not acceptance of the later Q3 core source or final integration.

`npm run build:desktop` completed with exit 0 in session `52061` before launch;
log `/private/tmp/zorid-bases-heavy-012-desktop-build.log`. No source edits or
builds occurred during the runtime slot. Runner session `62030` ended with
exit 1 on the first failing assertion.

Evidence directory: `/private/tmp/zorid-bases-heavy-20261022-012`.

| Retained item | SHA-256 |
| --- | --- |
| Preserved native host | `176fcff5a6228ba4dde53068e8703f0b53c30b9d4673020e241af6ccf57b167e` |
| Electron 44.8.0 executable | `12aa325561098c5dc5b175e465225b1b61e8f4090ce6d5dade89887e0eec8ab7` |
| `dist/assets/index-sfLiccCi.js` | `0dc97547a27e4447424c52037882cf1089ba8498838ad097c8e53949881cc8fa` |
| [result.json](/private/tmp/zorid-bases-heavy-20261022-012/result.json) | `80c5d5d5c6c0d2fa785f2659ef683f3284192764e1bdd73cc0e71ea0125040bf` |
| Both provenance manifests, byte-identical | `7829912dfaf510be034e8634f86062a4f6345fbeecd9274cdb8e68e63a1e4bee` |
| [failure.png](/private/tmp/zorid-bases-heavy-20261022-012/failure.png) | `38b062d42e9898720a90aab6e522ee4189364c9bf4623a17300b7b0a70228d4c` |
| [Seven full passive frames and derived diagnostic](/private/tmp/zorid-bases-heavy-20261022-012/numeric-edit-diagnostic.json) | `97ed143e86eedf0716aa86e7c8200c1bf8b938438d9a7333b010448754e7715c` |
| [Exact owned-process cleanup proof](/private/tmp/zorid-bases-heavy-20261022-012/owned-process-cleanup-proof.json) | `8288435ad0fc6a4fb8151f4b468f6e3eddef2147b72661cb2b3247a019a7350b` |

The runner verified unchanged tracked source, all 333 frontend distribution
files, native host, Electron and harness fingerprints before/after execution.
Fixture vault, downloaded CSV, screenshots and saved-source receipts remain.

## Exact first numeric edit receipts

`C` is the controller version, `T` the adopted table version, and `W` the
widget's captured/own-acknowledged version. Timestamps are the raw action `at`
milliseconds. Each receipt is a single passive DOM read, not a polling loop.

| Phase | Timestamp | C / T / W | Editors | Value | Editing | Disabled / invalid | Focus |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| before-click | 1792659527978 | 31 / 31 / 31 | 0 | — | absent | — | Rating separator |
| after-click | 1792659527989 | 31 / 31 / 31 | 1 | `1` | draft | false / absent | rating input |
| before-type | 1792659527989 | 31 / 31 / 31 | 1 | `1` | draft | false / absent | rating input |
| after-type | 1792659528016 | 31 / 31 / 31 | 1 | `5` | draft | false / absent | rating input |
| before-Enter | 1792659528016 | 31 / 31 / 31 | 1 | `5` | draft | false / absent | rating input |
| after-Enter | 1792659528017 | 31 / 31 / 31 | 1 | `5` | pending | true / absent | rating input |
| after-idle | 1792659528921 | 32 / 31 / 31 | 1 | `5` | draft | false / true | BODY |

All seven frames have controller updating/error flags `false`, busy `false`,
one connected target cell, grid `aria-rowcount="75"`, and 385 mounted data
cells. Draft/pending counts are respectively `0/0`, `1/0`, `1/0`, `1/0`, `1/0`,
`0/1`, `1/0`. The last frame's cell title is
`This base result is stale; refresh before editing`; earlier titles are empty.
The full JSON retains path/property/focus/count fields as well as these values.

These observations exclude an already version-stale editor begin in the
captured frames. They show the controller advance between the after-Enter
pending frame and after-idle rejection. Equal version markers do not exclude a
controller epoch or identity failure during asynchronous work, and the receipts
do not identify the origin of the subsequent version advance. No more precise
cause is accepted here. The intended `5` draft remains visible and the saved
rating `1` is preserved.

The previous resize/reset checks pass again: ArrowRight saves width `91`, then
Home saves an empty `columnSize` map. The existing summary and scoped-group
checks also pass before this first numeric failure.

## Lifecycle, auxiliary preflight and limits

The real owned window was shown: Electron PID `3572`, layer-0 on-screen window
`4857`, bounds `{x:144,y:72,width:1152,height:775}`, AppKit hidden `false`.
Renderer visibility was visible/not hidden and focused. AppKit active remained
false despite an accepted activation request; OS foreground parity is unproven.

Failure cleanup used `SIGKILL-cleanup` for Electron `3572`, with null exit code
and signal `SIGKILL`. Exact preserved-host child `3714` had `leaked: []`.
The separate retained cleanup proof at `2026-10-22T09:00:02Z` reports
`exactOwned012Processes: []`. The unrelated production host `47540` was not
touched. This is failure cleanup, not successful normal quit or restart.

An executor auxiliary prelaunch process filter mistakenly matched its own shell
command text and failed before writing its proposed post-build receipt. The
shell then continued to the runner, whose independent preflight, disk guard and
before/after provenance checks passed. This auxiliary failure is recorded in
`/private/tmp/zorid-bases-heavy-012-build-and-live-receipt-20261022.json`, which
explicitly identifies itself as a post-launch receipt. It is not presented as a
successful independent prelaunch process proof. The retained runner disk guard recorded
1,339,826,176 free bytes; the live check recorded 1,315,323,904, both above 1 GiB.

No new Q3 core, final integrated, mobile, sync, browser/WASM, matched Obsidian
visual, OS clipboard, normal-quit/restart, crash/power-loss or performance
acceptance follows from this partial diagnostic run.
