# Native vault adapter: first filesystem slice

`NativeVault` embeds the Rust core and SQLite authority in each caller process.
The CLI does not need Electron, a daemon, IPC, or a running core service. This
slice supports regular-file create/write and importing explicit filesystem path
hints, including unknown extensions, binary bytes, hidden files, and Unicode
paths. Existing parent directories are imported as logical folders.

`open` / `open_with_options` initialize private `.zorid` metadata in an existing
selected directory. `open_existing` / `open_existing_with_options` require an
initialized vault and cannot create a missing or empty database. `list` and `read`
read committed database state. `apply` returns `{ commit, projection }`: commit
is durable local authority; `projection: pending` preserves that receipt when
filesystem work subsequently fails. Retry the identical request/operation ID.
`reconcile(&[VaultPath])` rereads explicit path hints; `recover()` repairs durable
projection attempts and unprojected file revisions. Opening alone does not run a
scanner or recovery. `status()` returns metadata summaries, never body bytes.

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

Physical folder creation, rename/move/subtrees, and deletion reconciliation are
explicitly unsupported. An external deletion is retained as a blocked condition,
never silently recreated. There is no startup/watcher scanner, merge UI, backup,
retention/GC, bounded history pagination, blob streaming, network sync, Electron
bridge, browser projection, or mobile adapter here. Metadata and provenance are
currently read as whole snapshots; large vault scalability needs separate work.

Focused fixtures use temporary directories and real child processes, never user
vaults. Run in the coordinator's serialized build slot:

```sh
cargo test -p zorid-store -p zorid-native -j1 -- --test-threads=1
```
