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

## Family publication and visibility hooks

The follow-up source gates file and directory begin, progress and completion on
entry visibility, including an already-active attempt. Hidden attempts, stage
files, physical baselines and jobs remain retained. Native project/resume paths
check visibility before filesystem work; scanner absence confirmation checks it
again inside its database transaction. Physical ownership lookup still includes
hidden rows so observation and parent import cannot create a new identity over
retained data.

File and directory completion call the family owner's `check_publication` inside
the finish transaction before baseline advancement or exact job retirement.
Directory completion saves the attempt's immutable target, not a newer current
revision. For later metadata-only folder revisions, native rechecks the bound
inode and parent, then `bind_directory_bound` requires
`same_directory_publication` to compare old/current immutable family witnesses.
Only an identical witness may advance the physical revision; changed location or
namespace heads stay pending. This advancement retires no namespace jobs.

These calls depend on the family source and approval-blocked schema8 aggregation:
`is_visible`, `Store::is_visible_entry`, and the family publication helpers. The
schema activation patch and namespace binding patch are not applied by this
follow-up. Runtime compilation waits for the coordinator's coherent assembly.

The remaining physical Move/Delete implementation sequence is concrete:

1. Resolve approval for the two existing exact patches and integrate their
   source with this hook slice. The local namespace journal then preserves
   physical binding CAS through Move/Delete completion.
2. Add received namespace attachment alongside the local journal. In one store
   transaction, validate current desired materialization, explicit affected
   members and exact covered received job IDs, CAS prior physical bindings,
   and persist immutable evidence. Existing active publications must settle or
   explicitly transfer responsibility before attachment.
3. Persist any lagging-content physical branch and its globally fresh revision
   before filesystem execution. Direct entry Move joins the old physical frontier
   with the applied Move via the portable helper. Descendants of an ancestor Move
   retain their own entry frontier and carry the explicit journal ancestry/path
   proof; they must never graft the parent event into their graph.
4. Execute the existing explicit-member capture/stage/publish phases with those
   proofs. Finish the exact plan atomically with binding/baseline updates and
   covered job retirement; semantic Delete removes active bindings and retains
   recovery evidence. Recovery/Pending classifications never fabricate Delete.
5. Route native family apply/receive/recover through attachment and replay, then
   run the combined store/native/CLI fixtures. `Pending` is an intermediate state,
   not the completed Move/Delete milestone.

## Verification

Source tests cover bound fresh import/restart, immutable proof validation,
physical versus logical revision lag, exact transaction rollback, corrupted rows,
prior-schema rejection, ambiguous physical ownership, external atomic-save edits,
replaced parent/inode preservation and actual process exits at publication phases.
Formatting and diff checks passed. No build or runtime test has run for this
slice. The prior namespace gate passed 144 tests before these new hooks; that is
not evidence for this unverified binding implementation. The root coordinator
owns the serialized verification slot and shared dependency lock.
