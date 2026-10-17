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

Coordinator rerun: isolated combined candidate `1a02f01` includes the reviewed
binary fix and added regressions. Native gate `6627` passed **42/42** for
`cargo test -p zorid-native external_ -- --test-threads=1`; portable planner gate
`80385` passed **8/8** for the external namespace scope. The native scope includes
14 namespace fixtures plus existing scan/create/external-content fixtures.
The coordinator owns all builds; no overlapping worker build was run. This is
combined fixture evidence, not main integration or actual desktop verification.
Schema rejection, default-local host process and CLI/host build gate `96668` was
still running at this checkpoint. Actual default Electron and external-tool
verification remain coordinator-owned next actions.

Read-only combined host review confirms startup and enrolled Rescan invoke the
new Auto API and use its top-level reconciliation completion. The service polls
and handles full-reload journal records without constraining the new origin.
Known source limitations remain: the host's wire `imported` field currently uses
the read-only scan's zero count instead of `report.imported.len()`; startup treats
any incomplete pass as a whole-host error, including a retained hidden Recovery
branch or scan budget exhaustion; and compound external subtree changes that
independently relocate tracked descendants can be retained as incomplete rather
than automatically reconciled. The tested folder moves preserve captured
relative paths, including changed bytes and newly added untracked children.
These conservative limits are not data-loss or native-UX completion claims.

## Compound lifecycle follow-up

Root actual default-app verification found a common unsupported compound change:
rename `ExternalTools` to `ExternalRenamed`, edit its retained text child and
remove its retained binary child before the next scan. The prior implementation
preserved physical bytes/IDs but returned incomplete and authored no namespace
change. The active root fixture was not modified by this worker.

The follow-up records a single `MoveWithDeletions` observation. Missing roots
must be canonical minimal subtrees of the original captured physical members.
Every surviving member requires its exact expected relocated inode/type/bytes.
Every minimal deleted root requires a persisted `RelocatedAbsent` proof under
its original immediate parent inode at the expected new path, from completely
enumerated coverage. Missing ancestors never prove descendant deletion, and
any deleted member inode seen elsewhere rejects the compound operation.

The store composes the existing root-only Move planner with historical Delete
plans for the exact missing captured subtrees, then persists only the final
graph/materialization, all authored records, bindings, pending content and one
receipt atomically. Intermediate Move publications are never emitted. Unseen
remote heads and unbound remote children are not consumed or expanded.

Independent read-only review approved the stored proof shape, live checks before
prepare/import, atomic final-state composition and receipt retries. Source
fixtures cover the observed sequence, nested deletion with unseen remote edits,
prepared restart, replacement/parent-swap/elsewhere-inode denial. This follow-up
is source-reviewed and formatted; its combined runtime gate remains pending.

Separate prerequisite `0fcf8fe` makes corrupt/JSON/SQL/schema/identity/authority
failures propagate typed errors. Only explicit per-entry conflicts or limits
become incomplete diagnostics, with root/private authority checked first.
Three new fault fixtures and the updated rollback fixture accompany it. Desktop
diagnostic activation must wait for its coordinated validation. The >256 held
directory progress wall is a separate required follow-up, not solved by treating
incomplete inventory as complete namespace authority.
