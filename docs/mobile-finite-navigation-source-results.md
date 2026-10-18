# Finite same-vault navigation: source results

Historical capability evidence. On 2026-10-18 at04:38 UTC the user superseded
native-owned document routing with a single retained WebView owning tabs/history
and logical route commit. The new optional `webRouting:1` capability must not
advertise `sameVaultNavigation:1` simultaneously. Native ready/presentation ACK
does not authorize history changes in the successor. See
[current plan](mobile-live-editor-window-plan.md). The composed native-authoritative
`ddbc83a7` candidate never reached compilation and is reference only.

2026-10-18 UTC. Owner: mobile-ios-shell, branch
`tingkai-c/mobile-ios-finite-navigation`, base `f54dde44`.
Implementation freeze: `4d04d0824251b98a69dac1ccdca30175165ef521`.
Root/integration: `run_3e72b2c9ab72`; Tasks seam: `run_7a10da5526b5`.
Paired Swift/plugin/root/factory remains native owner's scope.

The interrupted eight-file diff was preserved and completed. The optional
sameVaultNavigation version 1 channel stages stable-ID Markdown admission and
source flush before native ready. Navigation uses its own transaction queue,
retains the actual source view until acceptance, and keeps the same Vault/client
binding. Positive native ready resolution is irrevocable. Lifecycle drains failed
navigation rollback before capturing inert state. Spontaneous links supersede
command intents and publish their own identity even from a provisional target tab.
The source tab is retired after acceptance or newer navigation takeover.

`openNote` retains its original seven arguments and adds optional eighth
`expectedEntryId`. By-ID admission precedes checkpoint adoption/pending recovery.
Rejected admission does not pin a loaded/fresh buffer to the rejected ID; queued
admissions validate the successful immutable identity. Path reuse cannot retarget
an existing loaded buffer or create another writer for that admitted entry.

## Verification

Passed, exit 0, Node v26.10.0:

```sh
node --test --test-concurrency=1 tests/mobile-native.test.ts tests/note-buffer-durable-recovery.test.ts tests/workspace-mobile-navigation.test.ts tests/workspace-mobile-lifecycle.test.ts tests/note-buffer.test.ts tests/note-buffer-witness.test.ts tests/note-buffer-write-guard.test.ts
./node_modules/.bin/tsc --noEmit
git diff --check
```

293 tests passed, zero failures/skips/cancellations. No broader suite or native
build/pass was run. Matching read-only dependencies:
`/Users/ctk/orca/workspaces/Zorid/managed-calendar-desktop-ui/node_modules`.
Both package.json and pnpm-lock.yaml byte-match the owner checkout. Only the
untracked symlink in this worktree changed; the cache and lockfiles were untouched.

Artifacts: `/Users/ctk/orca/artifacts/zorid-native-20261018`.

| Artifact | SHA-256 |
| --- | --- |
| finite-js-focused.log | `2d224375a6fe4ad8fe758ce3426e7a7b9d5a7e2bf36d20a43d8a6c69bf8fa28a` |
| finite-js-typecheck.log (empty successful output) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## Frozen Git blobs

| Path | Blob |
| --- | --- |
| src/platform/index.ts | `12f0b59f889bf269f3e8e6bd606f99d810c567f9` |
| src/platform/mobile-native.ts | `e01cded493c8d14af3fec8db007ec7942a508e97` |
| src/ui/note-buffer.ts | `1d24867397e764c069f900fabf4de021b49065a8` |
| src/ui/note-durable-state.ts | `9b2511aa0672ca363719bf71169a8fcf71375d7d` |
| src/ui/workspace.ts | `f885d7b989352931d8aa0964db8414cfdc0d1d86` |
| tests/mobile-native.test.ts | `42d88953ecd330f9b41ffb1fe66394424fbc2d03` |
| tests/note-buffer-durable-recovery.test.ts | `bffba30ab5464cf5271b411d222c5e80155dc5d6` |
| tests/workspace-mobile-navigation.test.ts | `8a5c1dc848f67504d2bbdcadb406cfe236c30514` |

Root assigned an independent source reviewer. Its initial concrete P2 finding
(failed admission pin poisoning) is corrected in this freeze, with regressions.
Root independently verified the correction; the final same-freeze reviewer
subsequently approved this optional source slice. No unresolved DTO question is identified.
Native owner confirms positive ready resolves only after fresh correlated
validation and root binding. That confirmation and these focused tests establish
source behavior only: paired Swift delivery, native/mobile verification, undo
continuity require separate native evidence. Canonical integration is recorded below.
This owner performed no main mutation, push, Xcode/Rust build, simulator pass, or
build-tooling edit.

## Canonical integration and independent verdict

Integrated as main `a2d480e2` after independent exact-freeze source approval.
Root compared all eight affected files with4d04d082: byte-identical; diff check
passed. Reviewer read the293-pass log without repeating unchanged checks. The
admission-poisoning defect is corrected; final source has no remaining scoped
review blocker. Old clients without exact sameVaultNavigation:1 capability install
no new listener and expose no navigation service, retaining the cold route.

Canonical pnpm12.14 frozen offline install restored seven cached packages,
including FullCalendar7.1.3 and temporal-polyfill1.0.6, without lock/source change.
This is source integration, not paired Swift/iOS interaction acceptance or
adjacent-page/undo retention. Dev17 currently being built predates this channel.

## Paired native review checkpoint — 2026-10-18 04:13 UTC

Independent source review of the moving `native-warm-editor` snapshot found a
source-readiness gap. Observed base `95eeb2d1`, NativeMobile blob
`962901d7cb4485e95eaa5a755c5ffe7ad99ae9bd`: beginning navigation clears
`documentSnapshotReady`, while failed/stale completion does not revalidate it.
Canonical JS rollback restores the cached source without another `noteOpened`.
The source therefore cannot begin another retained navigation after this path.
Terminal failed/stale proves rollback settled, not that source rendering succeeded;
the native owner must safely reattest the restored source or keep a recoverable
fence. Root relayed this finding in Orca `msg_52e319b47a14`.

DTO validation, fresh by-ID ready checks and the rejected-ready rollback barrier
were consistent in that snapshot. Root wiring was still incomplete: the retained
navigation method had no caller. This is a moving-source review finding, not
approval of the paired implementation or a native runtime result. The separate
NewNote18 candidate `9cf7fe9f` excludes this unfinished warm source; root confirmed
its native app/project bytes match reviewed `4e390d70` and current main
`c233362a` is an ancestor before the assigned iOS verification slot.

## Corrected paired source approval — 2026-10-18 04:29 UTC

The independent reviewer approved exact native `20a777e36e25105774ba376f8794951754c34eca`
in `native-warm-editor`. The root caller now exists. Baseline source reattestation
checks original path/EntryId/store through a fresh listing on the same physical
Rust session, keeps the pending barrier, and changes no target binding, history,
Recents or supersession state. Only the correlated terminal releases the failed
transaction. Fresh target witness checks precede the synchronous root commit;
positive ACK remains irrevocable. The prior helper's exact ticket/persistence and
uncertainty handling are reused. This closes the earlier scoped source finding,
not native compilation or runtime acceptance.

The paired JS successor initially missed the full source predicate after awaited
`noteOpened`. Independent review caught that race; the owner corrected it before
commit. Root approved exact blobs: Workspace `ffcb73f3e43056533f091d0926fc16ffb7eff40a`,
mobile test `0b841e271d19150d620adbf34597142face4adb1`, navigation test
`d1784deaec173afc1d298b949b6332aa7a4028de`. Restore/cleanup must succeed before
reattest; full ownership, visible connected ready runtime, scope and immutable-ID
checks run before and after the await. Command-current is checked only before:
successful source attestation intentionally invalidates that old command. A later
route or rejected attestation cannot mark dedup success. Terminal follows settlement.

Observed owner results:260/260 in the two affected test files, full TypeScript and
diff check pass. Root inspected the source/test correction and recomputed persistent
log digests without rerunning unchanged tests: `finite-js-reattest-focused.log`
SHA256 `7204ab0c376878c3d13a15613fc140c363e1d4b49f5a907192e57ad57bc73672`;
empty successful typecheck log SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
Logs remain under `/Users/ctk/orca/artifacts/zorid-native-20261018`.

These sources remain separately isolated pending coherent commits/composition.
Next gate: paired Swift/JS compilation and bounded positive/rollback interaction
proof. Two actual adjacent live editors and independent undo/scroll during an
interactive swipe remain a subsequent required slice. NewNote19 chrome verification
uses a separate candidate without this unfinished warm source.
