# Native vault adapter

`NativeVault` embeds the Rust core and SQLite authority in each caller process.
The CLI does not need Electron, a daemon, IPC, or a running core service. This
adapter supports regular-file create/write, physical folder creation, explicit
filesystem path imports, and a bounded recursive rescan, including unknown extensions, binary bytes, hidden files, and Unicode
paths. Existing parent directories are imported as logical folders.

`open` / `open_with_options` initialize private `.zorid` metadata in an existing
selected directory. `open_existing` / `open_existing_with_options` require an
initialized vault and cannot create a missing or empty database. `list` and `read`
read committed database state. `apply` returns `{ commit, projection }`: commit
is durable local authority; `projection: pending` preserves that receipt when
filesystem work subsequently fails. Retry the identical request/operation ID.
`reconcile(&[VaultPath])` rereads explicit path hints; `recover()` repairs durable
projection attempts and unprojected file revisions. Opening alone does not run a
scanner or recovery. `rescan()` explicitly recovers prior projection work, then
walks the vault with finite limits. `status()` returns metadata summaries and the
latest scan state, never body bytes.

## Authority, locking, and crash recovery

All participating native writers acquire `.zorid/vault.lock` with a bounded
`try_lock` loop, then enter SQLite transactions. Do not hold a database transaction
while waiting for this filesystem lock. Defaults: 5 second filesystem lock bound,
16 MiB whole-file content limit. The standalone `zorid-store` is a database-only
primitive: bypassing NativeVault for concurrent content mutations is not a
supported filesystem-coordination protocol. Tests use it while projection is
stopped to simulate a newer desired revision.

The same SQLite database stores baseline bytes/revision, desired bytes/revision,
projection attempts, captured external alternatives, journal/outbox and projection
intents. There is no second metadata authority. Each publication:

1. Persists its target and previous physical baseline.
2. Exclusively creates a private stage, writes and syncs it, and records its inode.
3. Moves an existing destination into a unique retained recovery file using an
   atomic no-replace rename, then checks the displaced bytes against the baseline.
4. Publishes the stage with an atomic no-replace rename and syncs the directory.
5. Verifies the staged inode reached the requested path; commits its new baseline
   and retires only represented file create/write intents atomically.

Recovery inspects actual files as well as persisted phase: a process can die
between any filesystem operation and its database record. Short unacknowledged
stages are quarantined and regenerated; complete adopted stages are synced before
publication. A staged inode already at the destination proves an earlier
publication even if the DB desired revision has advanced. Otherwise, an old target
is cancelled and never overwrites newer desired content. Folder/move/deletion
intents are not retired by descendant file publication.

External bytes differing from the baseline are captured before import. They are
automatically imported only if database revision still equals that baseline;
divergent versions remain separate recoverable alternatives. A destination
appearing in the displacement/publication gap is never replaced. Displaced files
are retained, and recovery checks even completed attempts for late writes through
an external application's old open handle. No retained file or alternative is
garbage-collected in this slice. This is byte preservation, not semantic merging.

## Folder creation and recursive rescan

Folder creation has a separate operation-scoped attempt. It creates and syncs a
private empty directory, persists its identity, and publishes with no-replace
rename. An external directory at the destination is never adopted as our staged
inode. Completion records directory provenance and retires exactly the original
folder-create intent, leaving child operations pending. Folder revision changes
caused by later descendant edits do not invalidate an exact operation retry.

`rescan_with_options(ScanOptions)` defaults to 10,000 observed entries, 64 MiB of
captured file bytes, depth 128, and a five-second soft scan budget. `max_entries`
must be 1..=100,000; bounded counters fit losslessly in JSON numbers. Zero byte
budget permits empty files/directories; depth zero does not descend below root;
zero duration records an incomplete pass without recovery/scanning. Time is
checked between filesystem calls, not a guarantee that blocking I/O is cancelled.
Prior projection recovery precedes the timed scan for nonzero duration.

Scans include hidden names and unknown/binary files, skipping only the reserved
root `.zorid` directory. A nested `.zorid` is ordinary user content. Symlinks,
special files, filesystem aliases and unrepresentable names are reported without
traversal. Captured bodies use the existing data/external-observation authority;
scan tables contain bounded metadata, not another copy of each file body.

Each directory records incomplete coverage before enumeration and complete
coverage only after stable identity and namespace checks. Read errors, replacement,
limits and process death leave incomplete records. A complete rescan may report
formerly materialized paths that are now absent, but still retains their DB bytes
and history. Absence finalization rechecks against the original covered parent
identity. All absence facts and the finished complete marker commit in one
transaction; an interrupted/failed finalization exposes neither draft absences nor
a completed run. No scan authors deletions or guesses external renames.

This is a bounded pass, not paginated enumeration: a directory wider than the
remaining entry budget stays incomplete and requires a larger limit. Increasing
the bound or repeating a full scan is explicit; there is no hidden infinite retry.
Completed/unfinished scan history and retained recovery files are not yet pruned.

## Filesystem security boundary

Implemented targets are macOS and Linux; other targets return `Unsupported`.
Content traversal uses directory descriptors and `O_NOFOLLOW`. Observed symlinks,
hard-linked regular files, case/normalization aliases, replaced internal files,
unsafe `.zorid` ownership/permissions and changed parent bindings fail closed.
Parent identities are rechecked immediately before and after publication; a
changed binding cannot receive a successful projection acknowledgement.

This is **not a hostile same-user filesystem sandbox**. An adversarial process
can move an ancestor between a check and a rename. Descriptor-relative access
prevents symlink traversal, but cannot atomically prove namespace containment
against arbitrary concurrent ancestor relocation. Likewise, ordinary SQLite uses
its pathname VFS, not a custom descriptor-anchored VFS. `.zorid` must remain a
private, current-user-owned directory; observed internal aliases/identity changes
are rejected and native DB opens use SQLite NOFOLLOW. Malicious same-user
replacement of private metadata during a SQLite open is outside this guarantee.

Default filesystem sync calls and SQLite FULL/WAL provide the tested local
persistence mechanism; no claim of hardware power-loss certification, network
filesystem semantics, Windows support, or encrypted-at-rest local storage.

## Remaining delivery work

Rename/move/subtrees and deletion reconciliation remain explicitly unsupported.
An external deletion is retained as a pending absence observation after complete
scan coverage, never silently recreated or converted into a logical tombstone.
There is no automatic startup/watcher scheduling, merge UI, backup, retention/GC,
bounded history pagination, blob streaming, network sync, Electron bridge, browser
projection, or mobile adapter here. Metadata and provenance are
currently read as whole snapshots; large vault scalability needs separate work.

Focused fixtures use temporary directories and real child processes, never user
vaults. Run in the coordinator's serialized build slot:

```sh
cargo test -p zorid-store -p zorid-native -j1 -- --test-threads=1
```
