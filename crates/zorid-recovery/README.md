# Local retained recovery snapshots

`RecoveryStore` stores historical file content in an explicit app-local SQLite
path. The host resolves that path and creates its parent directory. A database
is bound to both a logical vault identity and local replica identity; opening it
with another scope fails before cleanup or initialization.

This is retained history, not the pending-save journal, sync storage or an index
cache. Automatic settlement of interrupted saves belongs to the native save
service. Hosts must not convert diagnostics from this crate into technical
product UI.

```rust,ignore
let mut recovery = RecoveryStore::open(path, &RecoveryScope {
    vault_id,
    replica_id,
}, now_ms)?;
recovery.capture(SnapshotInput {
    entry_id: &stable_entry_id,
    historical_path: "folder/note.md",
    content: intended_bytes,
    provenance: SnapshotProvenance::Periodic,
}, now_ms)?;
```

All time is supplied by the caller as nonnegative Unix milliseconds. The crate
never reads the system clock. Defaults are a five-minute per-entry cadence,
seven-day retention, and a 16 MiB per-snapshot size limit. Policy configuration
is explicit. Save-failure captures bypass cadence. Identical latest content is
skipped even for a save failure, without extending the old snapshot's retention;
a later return to earlier content after another version creates a new snapshot.

Expiry runs when opening, capturing, or explicitly pruning. Rows exactly at the
retention boundary remain until they become older than that boundary. Capture
and expiry share a transaction: an insertion failure does not delete old rows.
Unchanged/cadence-skipped captures still commit expiry cleanup.

Snapshots retain stable entry identity, historical vault-relative path, capture
timestamp, provenance and exact content bytes. List pages contain at most 100
metadata items and support a timestamp/id cursor. Reads enforce the configured
size limit before loading content and verify SHA-256 integrity. Invalid or
corrupt records return an error; they are not silently reset or returned as
valid content. There is no automatic historical-version restore in this crate.

The database connection and SQL are private. Shared native connection policy
(opening, busy timeout, WAL and durability pragmas) comes from `zorid-sqlite`;
this crate owns its schema and transactional operations.

Unit tests use actual temporary SQLite databases and explicit timestamps. They
cover persistence, deduplication, cadence, forced capture, expiry boundaries,
transaction rollback, scope rejection, bounded pagination and corrupt records.
