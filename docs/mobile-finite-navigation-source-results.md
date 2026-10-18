# Finite same-vault JS navigation checkpoint

Owner: mobile-ios-shell / term_c8bf385c-b0d0-4bee-b3cd-cf0bffcdc971.
Branch: `tingkai-c/mobile-ios-finite-navigation`; base `f54dde44`.
Frozen implementation: `4d04d0824251b98a69dac1ccdca30175165ef521`.
Root integration owner: `run_3e72b2c9ab72`; Tasks seam: `run_7a10da5526b5`.
Native pairing owner: `term_d8fdd76f-8de9-4cfe-b570-604b005df067`.

The interrupted eight-file diff was inspected and preserved, then completed.
No main mutation, push, Xcode/Rust builds, emulator operations, or tooling edits.
Only this worktree's untracked node_modules symlink was repointed to the matching
read-only managed-calendar-desktop-ui dependency cache. Both package.json and
pnpm-lock.yaml byte-match that checkout. The previous linked tree lacked Calendar
packages and failed type-checking; no packages or lockfiles were changed.

Implementation retains one Workspace/Vault/client lease and independently queues
navigation transactions. Source flush and stable-ID target admission precede
staging; checkpoint/pending recovery cannot precede expected-ID admission.
Native positive ready resolution commits irrevocably. Failed target rendering or
native ACK restores the retained source. Lifecycle drains rollback before capturing
inert state. A spontaneous link has its own intent and native notification even
when reusing a provisional target tab; source retirement removes the obsolete tab.
The first seven openNote parameters are unchanged; expectedEntryId is eighth.

Validation: 293/293 focused tests pass, single test concurrency, covering
mobile-native, workspace-mobile-navigation, workspace-mobile-lifecycle, note-buffer,
note-buffer-durable-recovery, note-buffer-witness and note-buffer-write-guard.
`tsc --noEmit` passes against the matching cache. `git diff --check` passes.
Logs: `finite-js-focused.log`, `finite-js-typecheck.log` under
`/Users/ctk/orca/artifacts/zorid-native-20261018`.

Root's independent reviewer found admission pin poisoning in the interrupted
NoteBuffer change. The frozen successor pins only after successful admission and
revalidates queued admissions. Added regressions cover failed loaded/fresh admission
and queued mismatching IDs. Root has the frozen successor for final delta review.
Initial review established no other concrete defect in its assigned source scope.

The exact DTO is unchanged: sameVaultNavigation?:1, five-field documentOpenRequest,
ready with path/entryId/revision/recovery, failed/stale with id/status. Native owner
confirmed positive ready resolves only after fresh correlated validation/root bind.
No remaining contract question identified. Swift pairing, native runtime verification,
and main integration are separate and are not established by these source checks.

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
