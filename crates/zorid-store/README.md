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


## Durable host handoff (schema v5)

`prepare_host_intent(client, request)` stores exact command bytes and a stable token
without executing or authorizing it. Lost prepare acknowledgments return the same
token for the same client/operation/body. Operation IDs remain global within the
vault; another client's reuse fails. Query/list are metadata-and-receipt only and
never return the stored request body. Tokens are meaningful only with their client
and the selected vault authority; a wrong-client query returns not found.

After its own durable token checkpoint, the consumer requests commit. The native
adapter records `commit_requested`, then applies the stored request under the same
bounded filesystem lock. SQLite attaches the receipt to `committed` atomically
with content, presentation, local journal and authored/projection intents. A crash
before this commit leaves an exact retry; a crash after it leaves the original
receipt. Preparing against an existing exact receipt attaches it only upon commit
authorization. Prepared or rejected IDs cannot execute through generic apply.

Known domain rejection becomes a persisted `rejected` outcome with a stable error
code. Storage errors, filesystem failures, lock failures, unsupported environment
and malformed stored records are not definitive rejection: query/replay the same
token. Prepared orphans never autoexecute or block unrelated commands. A recovery
consumer may retry only `commit_requested` and reconcile committed/rejected
unacknowledged outcomes. No automatic host-consumer startup scheduler is supplied.

Acknowledgment must match the exact committed operation/decimal sequence or
rejected operation/code. It records consumer reconciliation separately from the
core receipt and never removes either the request or receipt. Intent pruning and
abandoning prepared records require a later retention policy. Host intents are
not the sync outbox and confer no remote acknowledgment.

The stream API now reports typed `ReloadRequired(CursorAhead|JournalGap|EventTooLarge)`
when a coherent inventory snapshot is the recovery path. Malformed data or a
missing journal tail remains corruption; consumers must not swallow those errors.

## Schema 6: local authority, common projection jobs and managed text

The local authority UUID persists across ordinary moves. Recreating a database at
its old path gets a new UUID; local durable-write and checkpoint references bind
to this UUID, not to the path or logical sync realm/vault ID. Raw copies of a DB
copy identity and cannot be detected from those bytes. A supported restore/fork
workflow must rotate authority/writer identity and invalidate old host references;
that workflow is not implemented by this slice.

Projection jobs now have independent identity and explicit origin (`local_command`
or `received_update`). Old operation sequence cutoffs are migrated to exact job
IDs before removing the legacy queue. Existing attempts retain their captured
bytes and baseline; completing them cannot retire a later received job. Folder
attempts reference an exact creation job. Physical moves/deletes remain pending
work for the namespace projector; schema migration does not pretend they occurred.

Managed text is explicitly bound to a trusted realm/vault/entry/bootstrap identity.
An empty existing file can be bound; nonempty adoption is an exact revision/bytes
conditional authored command. Incoming envelopes cannot create paths or infer
identity from names. Native text APIs invoke the portable planner in the same
SQLite IMMEDIATE transaction as their state writes. Received updates atomically
commit the exact-wire dedupe ledger, optional ordered receive cursor, immutable
causal revision, materialized bytes, ancestor revisions, presentation, local event
and common projection job. They create no local MutationRequest receipt or
outgoing authored intent. A duplicate can advance delivery without a UI event.

Managed local writes retain the normal exact command receipt and host-intent fence,
but their outgoing work is a typed authored text payload rather than the local
MutationRequest. `seal_authored_text` computes a candidate envelope, then persists
one winning exact wire with its self-echo ledger under a write transaction. Only
the returned persisted bytes may be transmitted. A competing candidate is discarded;
replay returns the original wire. Keys remain a caller capability. Upload ACK only
marks that exact outgoing wire accepted and never advances a receive cursor.

External edits use the causal state that actually produced the physical baseline.
The imported observed branch and merged current state have distinct immutable
revisions. One transaction saves both, one authored update and the observation
resolution; the physical baseline points to observed bytes until publication
succeeds. History is retained without automatic pruning. Concurrent whole-file
commands remain exact revision CAS and are never silently rebased. The portable
text planner's size/diff/actor bounds apply; arbitrary binary and unknown files
remain ordinary entries until the separate file-sync ingestion is integrated.

`read_presented(id)` and `read_path(path)` read committed identity/revision/bytes
and presentation from one snapshot, even when filesystem projection is pending.
Host intent metadata includes mutation kind without exposing request bodies.
Recovery checkpoints are authority/client scoped, SQLite FULL, local-only opaque
UTF-8 records. CAS retries succeed only while their exact revision is still head;
tombstones and compact used-revision fences prevent ABA. Checkpoint success waits
for transaction commit, and none of these records enter the sync outbox.

Schema6 focused validation ran `cargo test --offline -p zorid-store -p zorid-native
-j1 -- --test-threads=1` using the isolated worktree's own target: 108 tests passed.
The source was independently reviewed for queue migration, checkpoint fences and
text ingestion invariants. Product transport and native namespace integration
remain separate acceptance work.

New transition revisions are reserved once in a vault-wide retained fence, seeded
from historical local receipts, current metadata and local journal entries during
migration. This prevents a received sibling update from restoring an ancestor's
old optimistic token. Causal provenance may attach to an existing revision during
explicit binding/adoption, but no new transition may reuse it. Fence gaps fail
closed; automatic revision-history pruning is not implemented.
