# Bases actual Electron campaign 011 — 2026-10-22

**Stopped on the first failure: 171 actions and 20 successful checks. Full
acceptance remains open.** The first numeric edit was rejected as stale and the
saved rating remained `1`, rather than the expected `5`. Later rich-property,
layout, New, restart and safety steps were not executed.

Executor: `bases_ui_review`. Run interval:
`2026-10-22T08:16:33.622Z`–`2026-10-22T08:18:07.408Z`.

## Exact source and artifact boundary

This was the isolated frontend lane `.worktrees/bases-frontend-validation`,
branch `codex/bases-frontend-validation`, frozen at
`f567857b582ba06ea8eb4af773a0defd7ea4714d`. Its `src` tree was
`92b5f9cc954616124cdabc83a7d324e7dd1efef6`; its Rust `crates` tree remained
`5e010112661da69eb290d6a5edb72d4906e844a1`, matching the previously validated
native artifact. It includes the new resize queue and shown-window harness,
but **does not test the later Q3 core semantics or final integrated source**.

The desktop build completed before launch. Its preparation receipt is
`/private/tmp/zorid-bases-frontend-validation-011-build-receipt-20261022.json`;
that receipt's `appLaunched: false` describes preparation, before this run.
The focused UI closure passed 120 tests. The harness closure passed 26 of 27
under the default sandbox; its single native read-only window adapter case
passed separately with desktop access. This is not a claim of one 27/27 run.

Evidence directory: `/private/tmp/zorid-bases-heavy-20261022-011`.

| Retained item | SHA-256 |
| --- | --- |
| Native `zorid-desktop-host` | `176fcff5a6228ba4dde53068e8703f0b53c30b9d4673020e241af6ccf57b167e` |
| Electron 44.8.0 executable | `12aa325561098c5dc5b175e465225b1b61e8f4090ce6d5dade89887e0eec8ab7` |
| [result.json](/private/tmp/zorid-bases-heavy-20261022-011/result.json) | `d37b0693184a6fff67db9f13e88961e660a51af3e4a8e4b1ce755386350fa67b` |
| Both provenance manifests, byte-identical | `229d7cbd8290eba0272e068650d166634e3c348204774b0ed45dae7290eec4b3` |
| [failure.png](/private/tmp/zorid-bases-heavy-20261022-011/failure.png) | `be187be327ed9f115c4fa2989be0f226afc7cb0505196f3e9737251135de9504` |

Before/after provenance reports unchanged tracked source, frontend distribution,
native host, Electron and harness fingerprints. Fixture vault, screenshots,
downloaded CSV and saved-byte receipts are retained alongside the result.

## Observed behavior and remaining diagnosis

The previous resize failure is passed in this run: focused ArrowRight persisted
Rating width `91`, and Home then saved `columnSize: {}`, removing the override.
Both exact saved-source checks passed. Summary creation/editing, scoped group
summaries, reachable summary Delete and its acknowledged selection also passed.

The next ordinary numeric edit used the existing visible-control sequence:
double-click Rating in `Book 001.md`, click its input, Select All, insert `5`,
and Enter. The eventual saved-byte assertion failed with `1 !== 5`.
Failure DOM shows the cell still marked `data-base-editing="draft"`, an input
with `aria-invalid="true"`, and the cell title
`This base result is stale; refresh before editing`. The serialized DOM does
not include the input's current `.value`; it proves a retained editor, not the
exact retained input string. Original saved rating `1` was preserved.

The runtime did not capture controller, rendered-table or captured-widget
versions before/after opening this editor. Therefore it does not distinguish
an already stale begin from a controller/query advance during editing. A later
focused source fixture reproduces stale rejection when refresh advances after
opening a draft, while settled resize/reset followed by editing succeeds; this
does not establish the precise native cause. Passive version markers and
read-only edit receipts are being prepared for a separate rerun. No save guard
relaxation or harness semantic wait is accepted by this record.

## Visibility, cleanup and acceptance limits

The run used `--show-window`. AppKit recorded owned Electron PID `53966`
unhidden, with a real on-screen layer-0 window `4855` at
`{x:144,y:72,width:1152,height:775}`. Renderer state was visible, not hidden,
and focused. AppKit activation was requested and accepted, but its `active`
flag remained false; this does not claim OS foreground parity.

Failure cleanup used `SIGKILL-cleanup` for Electron `53966`, reported null exit
code and signal `SIGKILL`. Native child `54012` used the exact disposable 011
vault and had no reported leak. There was no cleanup failure. After cleanup, the executor observed
`owned011Processes: []` in the tool result of a separate escalated
exact-profile/vault process probe; a standalone raw receipt for that probe was
not retained in the evidence directory. This is failure cleanup, not
normal-quit/restart acceptance.

The journey used real Electron/native transport and visible-control CDP input
in a disposable vault. Synthetic clipboard handling does not establish system
clipboard integration. No mobile, sync, browser/WASM, matched Obsidian visual,
crash/power-loss, performance or final integrated acceptance follows from this
partial interim run.
