# Bases actual Electron campaign 014 — 2026-10-22

**Stopped on the first failure: 178 actions and 20 successful checks. Full
acceptance remains open.** A new rejection records the controller's current
invalidation kind as `configuration-commit`, with an epoch change `61/62` and
matching target/Base entry and revision witnesses. The exact upstream
configuration command is not established by these receipts. The numeric draft
`5` was retained; saved rating stayed `1`.

Executor: `bases_ui_review`. Actual interval:
`2026-10-22T09:32:11.594Z`–`2026-10-22T09:33:46.011Z`. Later journey steps
were not executed. This is an evidence-only record.

## Frozen source and artifacts

The isolated runtime lane `.worktrees/bases-frontend-validation`, branch
`codex/bases-frontend-validation`, was frozen at
`7055c7643575c4c101f819e968a54caf4c34460d`, with `src` tree
`7120d3a91b20418faf4b105f7b363c37b5ae8387`. The only source successor after
013 adds reviewed passive causal fields; the existing reader already captures
the whole JSON record. Journey input, seven read phases, independent saved-byte
oracle and guards are unchanged. No retry or semantic wait was added.

Rust `crates` stayed exactly `5e010112661da69eb290d6a5edb72d4906e844a1`,
matching the preserved host
`/private/tmp/zorid-bases-preserved-native-5e010112/zorid-desktop-host`.
This is an **interim frontend diagnostic against the old matching core**,
not acceptance of the later Q3 semantics or final integration.

The desktop build completed with exit 0 before launch; log
`/private/tmp/zorid-bases-heavy-014-desktop-build.log`. The retained successful
[post-build prelaunch receipt](/private/tmp/zorid-bases-heavy-014-postbuild-prelaunch-20261022.json)
records exact source/native/Electron hashes, all 333 distribution files,
no owned test processes and 1,379,139,584 free bytes. The runner's disk guard
recorded 1,778,610,176 bytes, above the unchanged 1 GiB minimum.

Evidence directory: `/private/tmp/zorid-bases-heavy-20261022-014`.

| Retained item | SHA-256 |
| --- | --- |
| Preserved native host | `176fcff5a6228ba4dde53068e8703f0b53c30b9d4673020e241af6ccf57b167e` |
| Electron 44.8.0 executable | `12aa325561098c5dc5b175e465225b1b61e8f4090ce6d5dade89887e0eec8ab7` |
| `dist/assets/index-CIquqkL_.js` | `ab1d2ad2a7a64b188dfbca837685eef7a82b98bfe4d21b43bc6968f4505ee2dc` |
| [result.json](/private/tmp/zorid-bases-heavy-20261022-014/result.json) | `d5a36e602c3bff8e8cab759c4aaa8c46b4c82f913c087b13aad0851719598d6c` |
| Both provenance manifests, byte-identical | `45ad4eb68191e206884ab3ceea58ae6917cb46eb9df6319a406c4e6b0bf8e286` |
| [failure.png](/private/tmp/zorid-bases-heavy-20261022-014/failure.png) | `be187be327ed9f115c4fa2989be0f226afc7cb0505196f3e9737251135de9504` |
| [Full frames and derived diagnostic](/private/tmp/zorid-bases-heavy-20261022-014/numeric-edit-diagnostic.json) | `0e18eda6c28de5ab70c36c9eb0d509aede898ecdadb0cfb8e9888ac5a656e0e8` |
| [Exact cleanup proof](/private/tmp/zorid-bases-heavy-20261022-014/owned-process-cleanup-proof.json) | `8a9201f8b44bc45a98ea5a9f7e675bd0539af7cf9b00be6f4ec21535c1cb4924` |

The runner verified unchanged tracked source, distribution, native host,
Electron and harness fingerprints before/after the run. Screenshots, downloaded
CSV, saved-source receipts and the disposable fixture vault remain retained.

## Seven frames and exact new causal record

`C/T/W` are controller/table/widget versions; timestamps are raw action `at`
milliseconds. Serial `1` existed before this numeric edit. The new rejection
is serial `2`, first observed after idle; the earlier marker is not attributed
to this operation.

| Phase | Timestamp | C / T / W | Editor | Last rejection serial |
| --- | --- | --- | --- | ---: |
| before-click | 1792661573941 | 31 / 31 / 31 | no editor | 1 |
| after-click | 1792661573949 | 31 / 31 / 31 | `1`, draft | 1 |
| before-type | 1792661573950 | 31 / 31 / 31 | `1`, draft | 1 |
| after-type | 1792661573954 | 31 / 31 / 31 | `5`, draft | 1 |
| before-Enter | 1792661573955 | 31 / 31 / 31 | `5`, draft | 1 |
| after-Enter | 1792661573956 | 31 / 31 / 31 | `5`, pending, disabled | 1 |
| after-idle | 1792661574858 | 32 / 31 / 31 | `5`, draft, invalid | 2 |

The exact new parsed record is:

```json
{
  "serial": 2,
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
  "baseIdentityMatches": true,
  "capturedStale": true,
  "currentStale": true,
  "invalidationTargetAffected": false,
  "invalidationBaseAffected": false,
  "invalidationOtherPath": false,
  "capturedTargetEntryAvailable": true,
  "currentTargetEntryAvailable": true,
  "capturedTargetRevisionAvailable": true,
  "currentTargetRevisionAvailable": true,
  "targetEntryMatches": true,
  "targetRevisionMatches": true,
  "capturedBaseEntryAvailable": true,
  "currentBaseEntryAvailable": true,
  "capturedBaseRevisionAvailable": true,
  "currentBaseRevisionAvailable": true,
  "baseEntryMatches": true,
  "baseRevisionMatches": true,
  "capturedInvalidationKind": "vault-modify",
  "currentInvalidationKind": "configuration-commit"
}
```

At rejection time the versions are `31/31`, while the later after-idle DOM
controller marker is `32`. The queued operation rejected before `getBuffer`;
this attempt's cold buffer load is excluded. The causal record names
`configuration-commit` as the current last invalidation kind, replacing the
captured `vault-modify`. All target/Base/other-path role flags are false for
that recorded current cause. Entry/revision witnesses for both target and Base
are available and match. These comparisons use cached `Vault.entries` entry
and revision data; they are not host-authoritative proof that files are
unchanged. These are internal counters and booleans, not raw file identities
or revision values.

This narrows the existing rejection to a configuration-finalization invalidation
while the numeric operation was queued. It does not identify which exact
upstream configuration command completed, prove a fresh target modification,
or establish that reads/metadata refreshes caused a vault event. The source
remedy and its negative-case validation remain separate work; no guard bypass
is accepted here.

The last frame has value `5`, enabled input, `aria-invalid="true"`, BODY focus,
and the title `This base result is stale; refresh before editing`. The durable
oracle still reads rating `1`. Both preceding resize checks pass again:
ArrowRight saves width `91`, then Home removes the custom override.

## Visibility, cleanup and limits

Owned Electron PID `52573` was unhidden with real on-screen layer-0 window
`4861`, bounds `{x:144,y:72,width:1152,height:775}`. Renderer state was visible,
not hidden and focused. AppKit active remained false despite an accepted
activation request; OS foreground parity is not established.

Failure cleanup used `SIGKILL-cleanup` for `52573`, with null exit code and
signal `SIGKILL`. Exact preserved-host child `52608` had `leaked: []`.
The retained proof at `2026-10-22T09:34:02Z` reports
`exactOwned014Processes: []`. Production host `47540` was not touched.
This is failure cleanup, not normal-quit/restart acceptance.

No product/source edits or extra builds occurred during the runtime slot.
No final integrated, Q3 core, browser/WASM, mobile, sync, matched Obsidian visual,
OS clipboard, normal-quit/restart, crash/power-loss or performance acceptance
follows from this partial diagnostic run.
