# Native namespace projection

This slice adds local physical Move/Delete for unmanaged files and folders to the
standalone native core. It is not received namespace sync: managed text namespace
mutations still fail closed at the schema6 text guard, and authenticated file
namespace ingestion still needs its own atomic adapter integration.

## Authority and commit boundary

A new local command observes its explicit members under the shared vault lock.
It reconciles existing publication attempts first and retains the caller's exact
revision CAS after external observations. Preflight records each before-state,
bytes, file/directory baseline, source inode and source-parent inode. Existing
folder baselines must match. Destination parents outside the moved subtree also
have pre-commit inode proofs. Internal destination parents must be newly staged
members of the same exact job.

The Store commits the mutation, receipt, outgoing intent, ProjectionJob and its
immutable physical evidence in one SQLite transaction. Revision allocation uses
the existing global revision-fence path. Filesystem work follows the commit;
errors then produce the original receipt with Pending projection, never a new
operation ID. Replay finds the original namespace job even after its entry was
deleted or subsequently moved again.

File baselines predating this feature did not retain inode identities. A NEW
explicit local command authorizes its freshly observed matching occupant; this
is not proof of historical ownership before preflight. An old pending namespace
job without saved evidence never acquires ownership from today's path or bytes.
Schema7 preserves those jobs, reports them pending and leaves occupants alone.
A separate recovery decision is required for such jobs.

## Physical protocol

1. Capture explicit file members into unique `.zorid/<job>.<index>.namespace`
   locations using descriptor-relative no-clobber renames and directory fsyncs.
2. Capture source directories bottom-up only once empty. Check emptiness and
   identity again after rename. An unexpected captured object is restored only
   into an absent source path, otherwise retained and reported.
3. For moves, create destination directories parent-first using persisted stage
   identities, then publish captured file inodes without replacing destinations.
4. Recheck every member, then atomically update baselines and retire that exact
   job. Later jobs are not covered by its completion.

This also supports case-only file/folder renames using private intermediate
names. Folder work is physically incremental: a pending operation can have some
members captured while others remain at their old paths. Only explicit job
members are authority; no receiver-path expansion or whole nonempty-subtree
rename is performed. An unlisted child keeps its source directory accessible and
leaves the job pending. Captured files remain in recovery storage.

`NOREPLACE` protects the destination, not the source. The implementation checks
captured identity after rename to handle a source substitution race. Inode
numbers are OS provenance, not cryptographic or permanently unique identities.
The existing cooperative-user filesystem threat model and descriptor/VFS race
limitations still apply. Cross-device rename errors remain pending; no unchecked
copy/delete fallback is provided.

## Recovery and retained data

Recovery enumerates namespace jobs, including deleted entries. Ordinary writes,
imports, projections and scanner absence inference are excluded at all pending
old/new member paths and affected folder subtrees. Retry classifies private and
published objects by saved identity; a recreated source/destination is not
adopted because its bytes happen to match.

Deleted file inodes, old directory inodes and immutable evidence have no automatic
GC. Recovery inspects retained completed captures for late writes through open
file/directory handles. File divergence creates a durable external observation;
late directory children remain at the retained location and are reported. Missing
retained captures are reported explicitly; absence is not interpreted as GC.
`status.namespace_attempts` exposes member source/target paths and deterministic
vault-relative recovery/stage locations without including file contents. A
reserved location may be empty after successful file publication. This is a
headless recovery surface, not a finished recovery UI.

Bounds: at most 10,000 explicit members, the configured native per-file limit,
and 64 MiB of retained evidence bytes counting source and copied file-baseline
bytes. Store APIs reject bound violations atomically. Multi-batch large-subtree
operations and recovery conflict resolution are not implemented here.

The unshipped schema7 layout separates `namespace_attempts` (exact immutable job
header and completion), `namespace_members` (immutable indexed change/evidence
with source-identity metadata) and `namespace_member_progress` (small mutable
phase fields). Member indexes remain stable because retained filenames depend on
them. Progress updates compare one member and write only its progress row;
immutable evidence is never rewritten by progress. Full creation/load/completion
checks still validate the exact ordered member set, aggregate bound and job.
Metadata queries do not select the evidence column. Native status and completed
retries use metadata, pending recovery loads one attempt, and completed deletion
audit loads one retained file's evidence at a time. This removes repeated
whole-attempt byte writes; no large-vault throughput benchmark is claimed.

## Verification scope

Source fixtures cover exact receipt replay, file/folder move/delete, case-only
names, process restart at capture/publication/directory-stage/finish boundaries,
identical-byte replacement inodes, occupied destinations, external edits,
unlisted children, retained late handle writes, previous file-projection crash
phases and unproven legacy jobs. Store fixtures cover atomic evidence binding,
progress CAS, baseline CAS, later-job retention and migration.

Initial macOS verification passed in session57772 (exit0): 137 tests, comprising
59 native and 78 store tests, at a012eaa plus the missing OperationId import and
Linux-only gating of the non-UTF8 fixture. The latter failed at fixture creation
with macOS EILSEQ92; it is source-covered but not runtime-verified on Linux.
Initial session83915 found the missing import; session23350 passed 59 native
checks and failed only that unsupported fixture setup. The final run used:

```
CARGO_TARGET_DIR=/Users/ctk/orca/workspaces/Zorid/core-native-namespace/target \
CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 \
cargo test --offline -p zorid-store -p zorid-native -j1 -- --test-threads=1
```

Cargo resolved 17 cached dependency entries in this isolated worktree; the
coordinator owns the root lockfile reconciliation. Tested isolated lock SHA256:
`7e87159c99304f7bf33807f58a955bdcbb67a607a8ed4f23b6a23d309c20d773`.

The independently reviewed per-member journal optimization at `0b0cf86` passed
144 tests (61 native, 83 store) in session69584, exit0, using the same bounded
command and isolated target. Session6452 first passed all 61 native tests but
failed the new corruption fixture while injecting a reordered member index:
SQLite correctly enforced its foreign key before the validation assertion ran.
The narrow test correction disables foreign keys only on that fixture's separate
corruption-injection connection, outside a transaction. The SQL injection then
succeeds and the unchanged metadata API rejection assertion passes. Production
constraints were not changed. The final pass includes immutable-evidence update
protection, metadata-only access, selected-member progress isolation, missing
retention diagnostics and a child arriving during directory capture.

No browser/Electron/CLI subprocess namespace convergence or received namespace
sync claim follows from these native/store results. Managed-text namespace
linkage and received physical-binding integration remain separate work.
