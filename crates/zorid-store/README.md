# Native transactional storage foundation

This crate implements the SQLite authority behind the portable vault mutation
contract. Each CLI/desktop process opens its own connection. Every mutation starts
an immediate transaction, reloads current metadata, validates the expected
revision and operation ID, invokes the shared planner, and atomically commits:

- Current entry metadata and original binary bytes.
- A replayable operation and its durable receipt.
- An outgoing intent and a separate filesystem-projection intent.

SQLite uses WAL and `synchronous=FULL`. Idempotent retries return the original
receipt. Revision conflicts, failed outgoing-intent writes and path collisions
must leave no partial mutation. Revision tokens are independent of CRDT state
vectors. Folder revisions cover descendant changes to guard stale subtree edits.

## Boundary and outstanding work

This is a database layer; `zorid-native` supplies the first filesystem adapter.
The database path is selected by its caller. Store itself neither edits user
files nor scans/imports them. Schema v2 adds baseline/attempt/external-observation
records and transaction helpers for atomic import and projection completion.
Schema v3 adds operation-scoped folder-create attempts, directory provenance,
bounded scan coverage/observations and atomic absence finalization. Canonical v1
v2 and v3 schemas migrate atomically; foreign/malformed schemas fail before
changing journal mode. Projection records validate SQL/JSON identities and kinds.
`open_no_follow` and `open_existing_no_follow` serve the native adapter's checked
canonical path; ordinary `open` retains explicit-path database-only behavior.
Only those adapters may retire projection intents. Outbox records currently
contain **local plaintext command data**, not transport payloads. The sync adapter
must author/retain an immutable encrypted update separately; received updates must
never manufacture a local command receipt or authored outbox entry.

The initial planner reads all entry metadata per mutation, not all content bytes.
Scaling that index and streaming large content are still required before large
vault readiness. A successful database transaction proves neither native file
durability nor browser, editor, encrypted sync or backup behavior.

## Verification

Run from the workspace with bounded concurrency:

```sh
cargo test -p zorid-store -j 1 -- --test-threads=1
```

Fixtures cover binary restart persistence, lost-ack retries, stale independent
connections, real independent process contention, atomic failure injection,
folder preconditions and unknown schema rejection. Execution evidence is recorded
in the coordinator roadmap rather than inferred from the existence of tests.

Implementation references: [rusqlite](https://docs.rs/rusqlite/0.40.2/rusqlite/)
and SQLite's transaction/durability semantics. LiveSync's distinction between
transport ACK, database commit and file projection informed the separate intents;
its PouchDB revision-tree replication is not used here.

## Committed UI reads and local change cursor

Schema v4 persists `EntryPresentation { id, ctime_ms, mtime_ms, size_bytes }` in
same transactions as entry bytes and metadata. Times are local replica ingestion/
mutation display times, not original filesystem creation/modification times and
never ordering, identity, sync or CAS authority. They are JavaScript-safe integers;
legacy migration uses zero explicitly meaning unknown. Creation time is retained;
mtime does not move backwards with the wall clock. Folder size is zero; file size
comes from committed bytes, even while filesystem publication is pending.

`read_path(&VaultPath)` returns `Option<PresentedEntry { state, content,
presentation }>` from one snapshot. `list_snapshot()` returns `ListingSnapshot {
entries: Vec<PresentedState { state, presentation }>, cursor }` with its cursor in
the same read transaction. Existing `read`/`list` APIs retain their old shapes.
`apply_at` permits a host-injected millisecond display clock; ordinary apply and
external import use the system clock. All successful command paths, including
imports, append metadata events; replay and projection completion add none.

`changes_after(&str, u32)` returns `ChangePage { changes, next_cursor, head_cursor,
has_more }`. Cursors are canonical nonnegative signed-64 decimal strings and are
specific to this database; they are distinct from command receipt sequences and
relay cursors. Limits are 1..=1000 records, additionally bounded to 1 MiB of stored
JSON per page. Oversized events and gaps error explicitly rather than skip; take
a full snapshot to reload an oversized event. A missing journal tail is corruption,
not an empty page. No pruning/reset/restore cursor protocol is implemented.

Migration appends a `Bootstrap` event with `requires_full_reload=true` and no
entries: consumers must reload the coherent snapshot at this boundary. Ordinary
`LocalCommand` events include changed ancestors and tombstones by stable ID.
`ReceivedUpdate` is a reserved distinct origin; no received-write API exists yet.
Native CRDT ingestion will atomically persist state/provenance, ledger/cursor,
materialized content, presentation and this journal, with authored receipts only
for authored operations. The local-only `projection_queue` requires a later
common origin-tagged projection migration before received updates can publish.
