# External file reconciliation candidate

Owner: `/root/external_reconcile_sol`; isolated Orca worktree
`core-external-namespace`, branch `tingkai-c/core-external-namespace`.
Only the shared-core coordinator integrates `main`.

Source candidate `d928aa5` depends on the initial import slice `a584d70`
(tree-equivalent to `a91a20e`), portable planner `fd32145`, bounded scanner
`fff63c2`, and planner/scanner regressions `e07501b`. The initial import slice
must be applied once. Source formatting and `git diff --check` passed; this is
not compilation or runtime verification. The coordinator assembled this chain
with desktop default activation in isolated candidate `9aec09b` and owns the
serialized compile gate. Focused reconciliation fixtures are a follow-up.

The native API is `reconcile_external(ScanOptions, ExternalFileMode)` and returns
`ExternalReconcileReport { complete, run, issues, imported, namespace }`.
`run.complete` reports read-only physical scan coverage; top-level `complete`
additionally reports reconciliation success. The CLI dispatches enrolled
rescans through this API; the desktop host owner wires startup and polling.
Legacy unenrolled scans retain their earlier behavior.

Auto enrollment preserves exact bytes and BOM. Strict UTF-8 without NUL selects
Text except known binary extensions; explicit Text/Binary overrides remain.
Existing identities retain their original mode. Imports freeze entry ID and
mode before authoring and reject an inode that already has a physical owner.

Schema 9 is a fresh unreleased format; schema 8 is rejected before modifying
database bytes. Scan evidence includes immutable per-path type, inode/parent,
content digest/length and explicit historical-binding absence. Absence requires
the original completely enumerated immediate parent; missing ancestors never
imply missing descendants. Incomplete coverage authorizes no namespace changes.

Independent source review `/root/external_reconcile_sol/external_scan_review`
found and the candidate corrected: missing absence accepted as success, moved
content lacking a persisted witness, raw scan decoding bypassing validated SQL
columns, contradictory absence/positive records, and destination-parent
enrollment order. A separate narrow review justified historical receipts for
hidden Recovery/Tombstone outcomes only after exact physical Normal history,
same current identity, validated current graph/cache and unchanged active
publication fences. This records an already-observed branch; it does not project
hidden desired state or consume unseen remote heads. Automatic review rejected
an earlier broad visibility-guard removal; that rejected mutation was not run.

Required next evidence: compile native/CLI/desktop host, focused creation and
namespace fixtures including rename-plus-edit, folder membership, incomplete
scan, interruption/retry, historical Recovery/Tombstone receipts and rollback;
then combined actual desktop/CLI default startup/discovery verification. No
native/mobile/reference-parity or full milestone completion is claimed here.

Coordinator gate update: combined native/CLI/host compilation succeeded after
`7c6e267` moved digest construction behind the store proof API. Native gate
`25993` ran `cargo test -p zorid-native external_ -- --test-threads=1` on combined
candidate `8c25e06`: 37/38 passed. The failing nested-folder rename plus binary
edit exposed an opaque physical revision mismatch. Reviewed correction
`f3cc59a` permits rebinding only when every non-revision EntryState field and
both present complete causal publication records are identical. Equal bytes
alone cannot pass. The coordinator owns the rerun; passing is not yet claimed.

The focused fixture source now includes 14 namespace tests: original ordinary
create/move/delete/budgets/retry/absence/digest/Recovery/Tombstone cases, plus
post-preparation in-place byte change, atomic receipt-trigger abort, same-byte
unseen binary event rejection and unseen namespace move-away/back rejection.
The nested folder fixture also creates an untracked subdirectory/file after
the move, exercising deferred child enrollment after its parent's historical
observation. These additions were formatted and source-reviewed, not locally run.
