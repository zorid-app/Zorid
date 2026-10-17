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
and v2 schemas migrate atomically; foreign/malformed schemas fail before
changing journal mode. Projection records validate SQL/JSON identities and kinds.
`open_no_follow` and `open_existing_no_follow` serve the native adapter's checked
canonical path; ordinary `open` retains explicit-path database-only behavior.
Only those adapters may retire projection intents. Outbox records currently
contain **local plaintext**; the encrypted sync adapter must encrypt them before
network transfer and retire them only after durable remote acceptance.

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
