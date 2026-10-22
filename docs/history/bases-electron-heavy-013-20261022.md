# Bases actual Electron campaign 013 — 2026-10-22

**Stopped on the first failure: 178 actions and 20 successful checks. Full
acceptance remains open.** The first numeric save was rejected by the existing
controller epoch guard before buffer admission: captured/current epoch `61/62`,
submitted/current version `31/31`. The event or clock trigger remains unproven.
Draft `5` was retained and the durable rating remained `1`.

Executor: `bases_ui_review`. Actual interval:
`2026-10-22T09:15:24.178Z`–`2026-10-22T09:16:58.895Z`. Later journey steps
were not executed. This is an evidence-only record, not a product change.

## Exact source and artifact boundary

The isolated runtime lane `.worktrees/bases-frontend-validation`, branch
`codex/bases-frontend-validation`, was frozen at
`fc18e77193a2cb34fc287946b05617c4928fb13c`, with `src` tree
`4b45c855a47360d2d7ebcabcd045ba63d68d8a5f`. Reviewed passive rejection
diagnostics and a nullable DOM receipt field were composed after 012. The same
seven read phases, visible input sequence, saved-value oracle and save guards
were retained. No semantic wait, retry or guard relaxation was added.

Rust `crates` remained exactly `5e010112661da69eb290d6a5edb72d4906e844a1`,
matching the preserved host
`/private/tmp/zorid-bases-preserved-native-5e010112/zorid-desktop-host`.
This tests the interim frontend with the old matching core; **it does not accept
the later Q3 semantics or final integration**.

The desktop build completed with exit 0 before launch; log
`/private/tmp/zorid-bases-heavy-013-desktop-build.log`. The retained successful
[post-build prelaunch receipt](/private/tmp/zorid-bases-heavy-013-postbuild-prelaunch-20261022.json)
records exact source/native/Electron hashes, 333 distribution files, no owned
test processes, and 1,216,438,272 free bytes. The runner's own disk guard then
recorded 1,214,930,944 bytes, above the unchanged 1 GiB minimum.

Evidence directory: `/private/tmp/zorid-bases-heavy-20261022-013`.

| Retained item | SHA-256 |
| --- | --- |
| Preserved native host | `176fcff5a6228ba4dde53068e8703f0b53c30b9d4673020e241af6ccf57b167e` |
| Electron 44.8.0 executable | `12aa325561098c5dc5b175e465225b1b61e8f4090ce6d5dade89887e0eec8ab7` |
| `dist/assets/index-Dn_jIPs7.js` | `ffabeb964410d3149bcdeb6b6c1f1e15713f070df1b52d6bf916d3d701d1a311` |
| [result.json](/private/tmp/zorid-bases-heavy-20261022-013/result.json) | `c0d1eb71cea56627626780e31e80ef260eee92acdab3dd22397a4dba125ae284` |
| Both provenance manifests, byte-identical | `f533f8808a7691d68c4843f76936c725645fe8202cf4efd75a6cf0c0719df901` |
| [failure.png](/private/tmp/zorid-bases-heavy-20261022-013/failure.png) | `74258bdd55c36a10ea07ba886eb01be7c76024c50edb9f97b135f6957c8db88b` |
| [Full frames and derived diagnostic](/private/tmp/zorid-bases-heavy-20261022-013/numeric-edit-diagnostic.json) | `95590d8730a5f4be399cfca301442abfb8972004338f6b509c9581ba2bd901d9` |
| [Exact cleanup proof](/private/tmp/zorid-bases-heavy-20261022-013/owned-process-cleanup-proof.json) | `c7f4ba22a74de6ae8f16e5c8c97f74bec1a8bd7141c0e484dd5a8a20a018334b` |

Before/after manifests verify unchanged tracked source, frontend distribution,
native host, Electron and harness fingerprints. Screenshots, downloaded CSV,
fixture vault and independent saved-byte checks are retained.

## Seven observed frames and the new rejection

`C/T/W` are controller/table/widget version markers. Timestamps are raw action
`at` milliseconds. The rejection serial is part of the passive DOM JSON marker.

| Phase | Timestamp | C / T / W | Input value / state | Last rejection serial |
| --- | --- | --- | --- | ---: |
| before-click | 1792660566878 | 31 / 31 / 31 | no editor | 2 |
| after-click | 1792660566886 | 31 / 31 / 31 | `1`, draft, focused | 2 |
| before-type | 1792660566886 | 31 / 31 / 31 | `1`, draft, focused | 2 |
| after-type | 1792660566899 | 31 / 31 / 31 | `5`, draft, focused | 2 |
| before-Enter | 1792660566899 | 31 / 31 / 31 | `5`, draft, focused | 2 |
| after-Enter | 1792660566900 | 31 / 31 / 31 | `5`, pending, disabled | 2 |
| after-idle | 1792660567707 | 32 / 31 / 31 | `5`, draft, invalid, BODY focus | 3 |

Serial `2` was already present before this numeric edit and referred to an
earlier version-24 rejection. It is not attributed to this numeric operation.
Serial `3` is new after Enter; its exact parsed raw record is:

```json
{
  "serial": 3,
  "guard": "controller",
  "phase": "before-buffer",
  "reason": "epoch",
  "submittedVersion": 31,
  "currentVersion": 31,
  "capturedEpoch": 61,
  "currentEpoch": 62,
  "capturedTargetIdentity": 4,
  "currentTargetIdentity": 4,
  "capturedBaseIdentity": 82,
  "currentBaseIdentity": 82,
  "capturedSelection": 1,
  "currentSelection": 1,
  "capturedConfigurationEpoch": 29,
  "currentConfigurationEpoch": 29,
  "hasResult": true,
  "queryError": false,
  "updating": true,
  "disposed": false,
  "targetIdentityMatches": true,
  "baseIdentityMatches": true
}
```

These are rejection-time fields, distinct from the later after-idle DOM marker
`C=32`. The rejection occurred at the queued operation's existing validation
before `getBuffer`, so this attempt's cold buffer load is excluded as the
cause. Target/Base identities, selection and configuration epoch match; this
does not exclude a target modification with unchanged identity. Both vault
invalidation and clock paths can advance the controller epoch. The receipt
does not identify which path fired, its event kind or file role. No claim that
a read or metadata refresh caused a vault event follows from this run.

The last frame retains value `5`, enabled input, `aria-invalid="true"`, and
the cell title `This base result is stale; refresh before editing`. The saved
value check still reads `1`. Resize and reset checks pass again before this
failure: ArrowRight persists width `91`; Home removes its override.

## Visibility, cleanup and limits

The real owned Electron PID `31647` was unhidden with on-screen layer-0 window
`4859`, bounds `{x:144,y:72,width:1152,height:775}`. Renderer state was visible,
not hidden and focused. AppKit active remained false despite an accepted
activation request; OS foreground parity is not established.

Failure cleanup used `SIGKILL-cleanup` for `31647`, with null exit code and
signal `SIGKILL`. Exact preserved-host child `31686` had `leaked: []`.
The retained exact-profile/vault process proof at `2026-10-22T09:17:16Z` records
`exactOwned013Processes: []`. The unrelated production host `47540` was not
touched. This is failure cleanup, not normal-quit/restart acceptance.

No product/source edits or additional builds occurred during the runtime slot.
No final integrated, Q3 core, browser/WASM, mobile, sync, matched Obsidian visual,
OS clipboard, normal-quit/restart, crash/power-loss or performance acceptance
follows from this partial diagnostic run.
