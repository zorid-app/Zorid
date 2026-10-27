# Native filesystem identity repair — 2026-10-27

The user explicitly requested fixing the persisted device-number problem, after
the compact warning UX alone failed to address its cause. The old native scanner
treated saved `st_dev:st_ino` values as permanent physical ownership. macOS's
device-number change therefore blocked unchanged notes as replacements.

Owner `bases_fixture_admission` used `codex/content-equivalent-rebaseline`, base
`460f8dbc`; independent reviewer `bases_final_spec` approved the exact candidate.
Root composed `b935857e` as `64e605e4` and owns main integration/app delivery.

## Repair boundary

Native recovery now revalidates the complete currently bound namespace. Every
bound path/kind and file content must match its saved baseline and current logical
state; original physical identities cannot have moved elsewhere. Exact path,
parent, inode, single-link and digest checks remain active. Extra untracked files
are left for normal import.

One immediate Store transaction rechecks the full expected binding list, normal
family publication, baselines/content and ownership. Outstanding publication,
namespace, intent, observation, binary-command or related recovery work blocks
the batch. Directory baselines/bindings update parent-first atomically. Historical
proofs, logical IDs, revisions and contents are not rewritten. The derived scan
cursor is retired before the binding CAS, and discovery restarts once.

This accepts a freshly verified equivalent projection; it does not guess that an
old device number and a new one identify the same volume. A changed or missing
bound file conservatively prevents the whole batch. Mixed-content recovery and
stable-volume identity design are not claimed completed by this change.

## Focused verification

Only `cargo test --locked --release -j1 -p zorid-native --test
content_equivalent_rebaseline -- --test-threads=1` ran. The original code failed
the positive recovery case while three protection cases passed. Final exact
target passes4/4 with no ignored cases:

- Nested text/binary recovery, extra-file import, ordinary save and retained
  historical proof preservation.
- Changed bytes remain protected and are not overwritten.
- A prepared write prevents parent/namespace rebinding.
- The original inode elsewhere prevents adoption of an ambiguous replacement.

The initial green attempt correctly recovered files but a test oracle incorrectly
required an unchanged parent-folder revision after a legitimate new-child import.
The final oracle preserves strict original file IDs/revisions, paths/kinds and
history while allowing that ordinary namespace revision. Final runtime0.67s;
native host-only release build succeeds. No broader suite or matrix was run.

Rust tree: `5412f95531e7ae4050ac061e23befb9aba123ed9`.
Native host SHA256:
`d2ab9d83e094d9f5db3294dbf2f249aad092740f759918f4bca985c1ac0bcc92`.
Frontend source remains exactly `460f8dbc`; its verified renderer was reused.
The arm64 local unsigned bundle passes355-file verification before installation
at `~/Applications/Zorid.app`. The prior app quit normally; the updated normal
app reopened the existing vault. This is not a signed/notarized release claim.

## Actual vault acceptance

Before: all10 saved file contents matched, no active work, but only1/11 file/
folder bindings matched current device/inode identities. A read-only metadata
snapshot was preserved before reopening the new build.

After automatic recovery:11/11 original bindings match. All original logical IDs
remain present; schema is unchanged. A later live snapshot has12/12 current,
zero baseline/content/state/record mismatches, no read races/errors and no active
work. The normal native Base shows nine results without an availability warning.

Live validation overlapped ordinary acknowledged writes to Test1 and a subsequent
file creation. The initial121-byte Test1 observation matches normal Write
operation44; subsequent operation45 changes it again. No prior121-byte retained
draft existed in the backup. Nine other original files remain unchanged at the
first observation. The user explicitly confirmed testing edits to Test1 after reopening. These
successful ordinary saves are separate from metadata-only rebinding; do not claim
every file stayed unchanged during interactive verification.

Evidence is retained in ignored `tmp/native-identity-fix-20261027/`: before/after
hashed snapshots, acceptance receipt, pre-repair SQLite backup, read-only checker,
write timeline, source/build identities, test logs and installed package receipt.
The normal user app remains open. Temporary implementation worktrees and obsolete
build products are retired after delivery; branch/source history is preserved.
