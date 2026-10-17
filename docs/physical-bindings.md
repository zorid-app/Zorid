# Physical baseline bindings

This source slice belongs to `client_sync_review` in Orca worktree
`core-physical-binding`, based on verified namespace source `e66311a`.
`data_readiness` owns schema8 module/export aggregation and text-sync integration.
The schema is fresh-only; previous development schemas must fail explicitly.
No existing vault is silently enrolled by matching bytes.

## Authority and transactions

A `PhysicalBinding` contains the saved physical `EntryState` and an adapter inode
plus its anchored parent inode. The saved revision can lag the logical entry's
revision, including parent revisions changed by child writes. Binding reads
validate against the physical file/directory baseline, never the current logical
entry. Inode identities are OS provenance within the existing filesystem threat
model, not cryptographic or permanently unique identifiers.

Three durable tables keep different responsibilities explicit:

- `physical_bindings` is current physical authority, indexed by physical path.
- `publication_parent_proofs` records the expected old binding and destination
  parent before staging/displacement/publication. It is immutable per attempt.
- `observation_physical` records the actual public-file inode/parent and expected
  old binding for an immutable observation. Raw retained recovery observations
  convey no public-path authority.

File and folder publication commits the verified staged inode binding, physical
baseline and exact job retirement in one SQL transaction. Cancellation leaves
prior binding and outstanding jobs intact. The native adapter checks the old
inode before and after displacement and checks destination parent identity on
restart. It verifies the final named inode before acknowledging publication.

A public external file observation can import an atomic-save replacement inode
with changed bytes within the same proven parent. An identical-byte replacement
is retained and reported; equal bytes alone cannot inherit the old inode's
namespace authority. A replaced parent is not adopted even when the child bytes
changed. Generic baseline writers remove stale bindings; only bound transaction
paths install a new one. First folder import now commits logical state, physical
baseline, binding and queue retirement atomically.

Hidden or relocated logical entries can still own their old physical path.
`physical_owner_at` is independent of visible listings and rejects ambiguous
multiple owners. Native observations block new-ID import at an owned path while
namespace reconciliation is outstanding. Full handling of observations against
hidden managed entries requires the family materialization adapter.

## Managed text integration seam

The schema owner calls `check_observation` before replacing a baseline and retains
its returned proof in the same transaction. After `projection::put_baseline`
invalidates the old binding, `put_observed_binding` installs authority for the
actual observed branch state/revision. It must not use the merged current text
revision when the observed physical bytes do not include remote edits. A raw
observation without physical proof leaves the result unbound.

## Namespace dependency and approval block

This slice cannot be integrated as complete namespace behavior until local
Move/Delete completion maintains the binding alongside its existing baseline.
The exact proposed change remains **unapplied** in
`/tmp/zorid-namespace-physical-binding.patch`: immutable prior binding in namespace
evidence, exact compare-and-swap, moved captured/staged inode plus proved target
parent, and removal of active binding on deletion while retaining its evidence.
It does not relax the original single-job namespace validation.

Automatic approval review rejected applying that patch twice, stating that
cross-owner authorization was untrusted and changes to physical recovery
namespace authority could be destructive. The coordinator and ledger owner
explicitly acknowledged scoped ownership, but the review still rejected it.
The coordinator is resolving approval for the concrete patch. No alternate tool,
executor or path has been used to apply it.

Received namespace attachment remains a separate, unimplemented contract. It
must compare exact desired materialization versions and explicit covered received
job IDs, retain unresolved Recovery/Pending states, and never invent a tombstone
from invisibility. A received move with newer logical content must preserve the
old physical content branch under a newly reserved physical revision and new
location witness; it cannot label old disk bytes with the latest logical revision.
The text witness and coalescing contract are being finalized with the family owner.

## Verification

Source tests cover bound fresh import/restart, immutable proof validation,
physical versus logical revision lag, exact transaction rollback, corrupted rows,
prior-schema rejection, ambiguous physical ownership, external atomic-save edits,
replaced parent/inode preservation and actual process exits at publication phases.
Formatting and diff checks passed. No build or runtime test has run for this
slice. The prior namespace gate passed 144 tests before these new hooks; that is
not evidence for this unverified binding implementation. The root coordinator
owns the serialized verification slot and shared dependency lock.
