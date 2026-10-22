# Bases actual Electron campaign 010 — 2026-10-22

**Failed at the first failing assertion; full acceptance remains open.** The
campaign recorded **166 actions and 18 successful checks** against frozen source
`2f0d77a4d255d7290be090d1450d8c5f62576eef`, from
`2026-10-22T07:15:17.394Z` to `2026-10-22T07:16:48.401Z`. Later journey steps
were not executed. This record is evidence-only; it does not change product or
harness behavior.

Executor: `bases_ui_review`. Documentation owner: the same worker, isolated
branch `codex/bases-heavy-010-record`, sparse worktree
`.worktrees/bases-heavy-010-record`, based on
`a11e0491f2778c7388232fa798a35ae689a7402f`. The documentation base is later
than the runtime source and is not the tested source.

## Retained evidence and artifacts

Evidence directory: `/private/tmp/zorid-bases-heavy-20261022-010`.

- [Result and saved-byte/check/action receipts](/private/tmp/zorid-bases-heavy-20261022-010/result.json)
- [Before manifest](/private/tmp/zorid-bases-heavy-20261022-010/provenance-before.json)
  and [after manifest](/private/tmp/zorid-bases-heavy-20261022-010/provenance-after.json)
- [Failure screenshot](/private/tmp/zorid-bases-heavy-20261022-010/failure.png)
  and [scoped group summaries](/private/tmp/zorid-bases-heavy-20261022-010/02c-group-summaries.png)
- Desktop build receipt: `/private/tmp/zorid-bases-heavy-010-desktop-build.log`;
  coordinator build session `84451` completed successfully before launch.

| Item | SHA-256 |
| --- | --- |
| Native `/Users/ctk/Projects/Zorid/target/s1-release/release/zorid-desktop-host` | `176fcff5a6228ba4dde53068e8703f0b53c30b9d4673020e241af6ccf57b167e` |
| Electron 44.8.0 executable | `12aa325561098c5dc5b175e465225b1b61e8f4090ce6d5dade89887e0eec8ab7` |
| `dist/assets/index-BKmpc21i.js` | `b7f1a9a5f084e67defb852295142082693488c9230d1b3ee66a1db70f64ee17d` |
| `result.json` | `4c4341ef82dcfc32666064a0f54cdce646f514d095b3913d46133ce8a718f7f9` |
| Both provenance manifests, byte-identical | `bb424afaebed941816cead4699b13093409f635903238e9eb56b86b4ec3dfb57` |
| `failure.png` | `6573cc2b48dec31a4179e9ae188ad59cdc6434e3d49bd9e41d3448e60d8caab6` |

The full manifests enumerate tracked source, all 333 `dist` files, native and
Electron executables, harness and CDP helper. Before/after objects and manifest
bytes matched; `provenanceVerified` is true. No build or source edit occurred
during the run. The launch guard recorded 1,102,168,064 available bytes, above
the required 1 GiB.

## Observed successful behavior

The 18 check receipts cover ordinary Base creation; view rename preserving
comments/unknown fields; add/duplicate/default views; formula create, rename and
remove; built-in/custom summaries; actual Results CSV download; live summary
name/expression changes; exact group summary scope; summary deletion; subsequent
summary-selection acknowledgement; and keyboard width increase. The result
contains each exact receipt and saved source where applicable.

The previously failing Summary actions geometry passed: the actual Delete
summary button was reachable, deletion saved, and the picker returned. Group
summaries retained the explicit empty display alongside `71`, `72`, `73`, with
exact group counts/member paths and independent overall value `214`.

The previous resize-focus failure also passed in its exercised sequence. After
the RatingTotal selection was durably saved and its exact footer label appeared,
the real context-menu/Escape/Tab sequence focused the Rating separator.
Read-only receipts immediately before and after ArrowRight both report:

```json
{"matchesSeparator":true,"separatorConnected":true,"focusedTag":"SPAN","focusedRole":"separator","focusedLabel":"Resize Rating","focusedProperty":"note.rating","summaryLabel":"RatingTotal","busy":"false"}
```

ArrowRight saved `columnSize["note.rating"]: 91`, the expected measured width
plus ten pixels. This validates that concrete focus/resize sequence on these
artifacts, not every focus transition or the rest of the campaign.

## First failure and separate source reproduction

The next context-menu/Escape/Tab sequence again passed the live separator-focus
assertion. Home was then sent to reset automatic width. The saved-source oracle
at `tests/bases-electron-integration/journey.mjs:194` continued to read `91`,
where the selected custom-width entry should have been absent. It failed after
the bounded saved-read wait with `91 !== undefined`. The failure screenshot
still reports the Rating separator as active; no alert or unfinished editor is
reported. Home arrived about 286 ms after ArrowRight.

An independent focused JSDOM reproduction demonstrated a pending-command loss
path in [the table implementation](../../src/bases/table-view.ts): create a
table with Rating width `81`, hold the first `patchView` promise, focus its
separator, then dispatch ArrowRight followed by Home. The exact observation was:

```json
{"focusedSeparator":true,"pending":true,"patches":[{"columnSize":{"note.rating":91}}]}
```

`patch()` returns when `hasActiveEdits()` is true, which includes its own
`configPending`. Thus the second width command can be silently dropped while
the first save is pending. A durable file read can succeed before that save's
query/acknowledgement promise settles. This demonstrates the source-level risk
and is a plausible explanation of the actual failure. **The native runtime did
not record `configPending` at Home, so the precise native cause is not yet
established.** Product diagnosis/fix, independent review, and a rebuilt actual
rerun remain required; this record does not accept a later fix.

## Lifecycle and acceptance boundary

The harness stopped on the first failure and preserved the fixture vault,
screenshots, downloaded CSV, saved bytes and receipts. It closed its owned
Electron PID `62716` using failure cleanup (`SIGTERM-cleanup`, reported exit
code `0`, null signal). Its exact native child PID `62813` had no reported leak;
`cleanupFailure` is null. A separate escalated process probe using the exact
010 profile/vault identities returned `owned010Processes: []` after cleanup.
This was failure cleanup, not a successful normal-quit/restart scenario.

Execution used the normal Electron app and native host with visible-control
CDP input in a disposable vault. The app was verified hidden, so this does not
establish foreground OS focus/keyboard parity. Synthetic clipboard handling in
this campaign does not establish OS clipboard integration. Later rich edits,
layouts, New, lifecycle/restart and safety steps remain unexecuted here. No
mobile, browser/WASM, sync, matched Obsidian visual, crash/power-loss or
performance acceptance follows from this partial run.
