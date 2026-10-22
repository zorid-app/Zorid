# Bases actual Electron campaign 015 — 2026-10-22

**Stopped on the first failure: 180 actions and 22 successful checks. Full
acceptance remains open.** The previous first-numeric-save failure passes:
`Book 001.md` saves rating `5` with its body and unrelated properties preserved.
The next checkbox saves `done: true`. The following topics-picker input fails
its visible, unobscured target precondition; the actual admission state at that
click was not captured, so its cause remains unproven.

Executor: `bases_ui_review`. Actual interval:
`2026-10-22T10:34:10.725Z`–`2026-10-22T10:35:16.309Z`. Later rich-property,
layout, New, restart and safety steps were not executed. This record changes
neither product nor harness behavior.

## Exact source and artifacts

Runtime lane `.worktrees/bases-frontend-validation`, branch
`codex/bases-frontend-validation`, was frozen at
`eeb8646a49a44ad33dc8e1ec83b39fbbdefefab9`, with `src` tree
`6a10f988983684f163b24a8af98edc164e888079`. It composes reviewed lifecycle
barrier `eeaec9d1`; the existing journey and all input/oracle/wait sequences
are unchanged. The focused pre-build Node closure passed 34 tests, recorded in
`/private/tmp/zorid-bases-heavy-015-barrier-node-tests.log`.

Rust `crates` remained exactly `5e010112661da69eb290d6a5edb72d4906e844a1`,
matching `/private/tmp/zorid-bases-preserved-native-5e010112/zorid-desktop-host`.
This is **interim frontend verification with the old matching core**; it does
not accept later Q3 semantics or final integration.

The desktop build completed with exit 0 before launch, log
`/private/tmp/zorid-bases-heavy-015-desktop-build.log`. The retained successful
[post-build prelaunch receipt](/private/tmp/zorid-bases-heavy-015-postbuild-prelaunch-20261022.json)
records exact source/native/Electron hashes, all 333 distribution files,
no owned test processes and 1,303,560,192 free bytes. The runner's guard recorded
1,302,614,016 bytes, above the unchanged 1 GiB minimum.

Evidence directory: `/private/tmp/zorid-bases-heavy-20261022-015`.

| Retained item | SHA-256 |
| --- | --- |
| Preserved native host | `176fcff5a6228ba4dde53068e8703f0b53c30b9d4673020e241af6ccf57b167e` |
| Electron 44.8.0 executable | `12aa325561098c5dc5b175e465225b1b61e8f4090ce6d5dade89887e0eec8ab7` |
| `dist/assets/index-BbysNiLJ.js` | `a8492e11bb860b2abf3c150cc34e930f79468e9862dc3c9a3e19afd9da5459a1` |
| [result.json](/private/tmp/zorid-bases-heavy-20261022-015/result.json) | `24fe3a2980afbcae5d1d789378449d0d110279ef0cac763019bd3627f620361c` |
| Both provenance manifests, byte-identical | `94c0d18c875305981e5d40466a6d41c6c9a09a4f76bdae06f3bcb78c8ab335d8` |
| [failure.png](/private/tmp/zorid-bases-heavy-20261022-015/failure.png) | `8b4e29d93f43b4ea828dcf14335e7493c95e797c7b690fd99e513b65c9108514` |
| [Exact cleanup proof](/private/tmp/zorid-bases-heavy-20261022-015/owned-process-cleanup-proof.json) | `8d7f547601d7aa4770136dba07e75da187854c7b76845656ebdbdf39a8c4a0f9` |

The runner verified unchanged tracked source, distribution, native host,
Electron and harness fingerprints before/after execution. Fixture vault,
screenshots, downloaded CSV and independent saved-source checks remain retained.

## First numeric edit passes

The seven passive frames show controller/table/widget (`C/T/W`) versions at
`33` on begin and `34` coherently after the accepted save. Busy becomes true
during the pending write and false after settling. Timestamps are raw action
`at` milliseconds.

| Phase | Timestamp | C / T / W | Busy | Editors | Draft / pending counts |
| --- | --- | --- | --- | ---: | --- |
| before-click | 1792665292893 | 33 / 33 / 33 | false | 0 | 0 / 0 |
| after-click | 1792665292901 | 33 / 33 / 33 | false | 1 | 1 / 0 |
| before-type | 1792665292902 | 33 / 33 / 33 | false | 1 | 1 / 0 |
| after-type | 1792665292913 | 33 / 33 / 33 | false | 1 | 1 / 0 |
| before-Enter | 1792665292913 | 33 / 33 / 33 | false | 1 | 1 / 0 |
| after-Enter | 1792665292915 | 33 / 33 / 33 | true | 1 | 0 / 1 |
| after-idle | 1792665294223 | 34 / 34 / 34 | false | 0 | 0 / 0 |

The entered value is `5` before Enter; after idle there is no remaining editor,
draft or pending marker. The durable rating/body/unrelated-property check then
passes. Last-rejection serial `1` is unchanged across all seven frames and
belongs to an earlier version-25 rejection. It is not a rejection of this
numeric edit. Full frames and passed-check names are also retained in
`numeric-edit-diagnostic.json` beside the original result.

The following checkbox pointer occurs at `1792665294237`; its independent
saved-source check confirms `done: true` before the next step. Preceding summary,
resize-width `91`, and Home override-removal checks also pass again.

## Next failure and diagnostic boundary

The topics cell pointer occurs at `1792665294595`, 358 ms after the checkbox
pointer. The next action is typing `Writing` into
`.bases-property-popover input[role="combobox"]`. Its initial target lookup
fails after the normal wait; no subsequent text-insertion action is recorded.
The failure is at journey line 218, with the assertion:

```text
Visible unobscured .bases-property-popover input[role="combobox"][0]
```

This demonstrates that the required visible/hit-testable picker input was not
available to that next action. It does not prove the popup was absent throughout
the entire interval. `UI.point` checks rendered geometry, native `disabled`,
visibility and pointer hit-testing; it does not check session busy/admission or
cell `aria-readonly`. Waiting for durable checkbox bytes alone need not prove
that the asynchronous query/UI refresh has settled, so a closed admission gate
is a source-plausible explanation. **Actual 015 did not capture admission,
busy or cell ARIA at the topics click; that cause is not established here.**

The retained failure DOM contains body `innerText`, with `editors: []` and
`alerts: []`; it is not full DOM HTML. The screenshot's truncated active BODY
HTML also does not expose those cell/session attributes. No harness readiness
wait or product guard change is accepted based solely on this partial record.

## Visibility, cleanup and limits

Owned Electron PID `38781` was unhidden with real on-screen layer-0 window
`4865`, bounds `{x:144,y:72,width:1152,height:775}`. Renderer state was visible,
not hidden and focused. AppKit active remained false despite an accepted
activation request; OS foreground parity is not established.

Failure cleanup used `SIGTERM-cleanup` for `38781`, exit code `0`, null signal.
Exact preserved-host child `38818` had `leaked: []`. The retained proof at
`2026-10-22T10:36:19Z` reports `exactOwned015Processes: []`. The unrelated
production host `47540` was not touched. This is failure cleanup, not successful
normal-quit/restart acceptance.

No source edits or extra builds occurred during the runtime slot. No full
journey, final integrated, Q3 core, browser/WASM, mobile, sync, matched Obsidian
visual, OS clipboard, normal-quit/restart, crash/power-loss or performance
acceptance follows from this partial run.
