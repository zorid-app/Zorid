# Portable vault mutation contract

This crate contains logical paths, stable IDs, entry metadata, byte-preserving
mutation requests, committed event batches and pure validation helpers. It has
no filesystem, database, threading, clock, random-number or network dependency.
It does not implement sync, encryption, CRDTs, storage, or an editor. Its serde
shape is an initial local boundary, **not a negotiated remote protocol**.

## Local data model

- `VaultPath` is a non-root UTF-8 logical path with `/` separators. It preserves
  Unicode spelling and case. Empty/dot segments, backslashes, control characters,
  absolute/drive-prefixed paths and the root `.zorid` subtree are rejected, also
  during deserialization. The reserved root name is ASCII case-insensitive.
  Other hidden files, `.obsidian`, unknown extensions and nested `.zorid` names
  are ordinary vault content. No global hidden-file exclusion is permitted.
- Logical validation is not filesystem authorization. Adapters must prevent
  symlink/reparse-point escapes and handle platform-specific forbidden names,
  case/Unicode aliases and lengths without silently renaming or overwriting data.
  Non-UTF-8 native filenames require an explicit import error or future encoding;
  they must never be converted lossily. Listing the vault root does not require
  constructing an entry path for it.
- `EntryId` is stable across writes and moves. Delete/recreate at the same path
  allocates a new ID; a tombstone keeps the old identity. IDs are allocated by
  adapters, not derived from paths. `Revision` and `OperationId` are opaque
  tokens with `new`/`as_str` methods; the core does not generate randomness.
- `EntryKind::File` covers arbitrary bytes, including binary and unknown formats.
  `Create` requires `Some(bytes)` for files and `None` for folders. `Write` never
  means Markdown normalization or UTF-8 decoding. Inline bytes are a bounded
  first-slice representation; adapters must reject oversized requests before
  allocation where possible. This is not an attachment streaming protocol.
- Revisions change for every accepted entry mutation. Folder revisions also
  change for descendant changes, protecting stale recursive operations. A
  revision is not an mtime, content hash, sequence from another replica, or Yjs
  state vector: deletion-only CRDT updates can leave a state vector unchanged.
  Concurrent CRDT writers need distinct actor identities, not a shared device ID.

## Independent CLI and desktop processes

Every process embeds its own core. No desktop, daemon or IPC service is required.
The native adapter must implement the following protocol; this crate only defines
the contract and pure precondition checks.

1. Authenticate/authorize access and validate the request. Acquire any required
   projection/reconciliation lock with a bounded timeout. Use one documented lock
   order across all processes; never hold these locks over network I/O or prompts.
2. Begin the database write transaction and read fresh state inside it. An
   in-memory CRDT or entry cache is not authoritative. If database state advanced,
   reload/apply the missing committed updates before calculating the mutation.
3. Look up the operation ID in this vault's durable idempotency records.
   `check_idempotency` returns the original commit for an exactly equal request;
   different content, path or preconditions under the same ID are rejected. Check
   this before revision preconditions, so retrying an uncertain successful commit
   does not fail merely because the original mutation advanced its revision.
   Replays do not emit new events or append a second outgoing change. Do not prune
   records until the supported retry horizon and expired-operation behavior are
   explicitly defined; the initial adapter should retain them.
4. Check identity/liveness/revision using `validate_target` for existing entries.
   Also enforce file/folder kind, destination occupancy under native path aliases,
   an existing live folder parent, no folder move into itself/descendants, unused
   create IDs (including retained tombstones), and recursive-delete requirements.
   Revalidate the complete affected subtree in this same transaction. A move must
   keep every descendant ID and update its path/revision. A recursive delete must
   retain every descendant as a tombstone. Changed old/new ancestor folder
   revisions belong to the same batch. Existing tombstones do not occupy paths.
5. Atomically persist entry changes, authoritative bytes/CRDT state or durable blob
   references, an ordered change journal, pending projection/reconciliation work,
   required outgoing sync intent, and the exact request/result idempotency record.
   Persist referenced blobs before committing references; a crash must not leave
   an acknowledged entry referencing missing bytes. Checked sequence allocation
   must reject overflow, never wrap. Commit according to the storage adapter's
   explicitly tested durability settings before returning `CommitResult`.
6. Consumers may observe the journal after commit. Each `CommitResult` is one
   atomic journal event with a local increasing `sequence` and all `EntryChange`s.
   Its JSON sequence is a positive decimal string to preserve u64 precision in JS.
   Sequence is neither a distributed ordering rule nor an optimistic entry token.
   Notifications merely wake readers; polling/resume from the durable journal must
   discover changes missed while a process was stopped. Readers see committed
   snapshots, not another renderer's uncommitted input buffer.

Database state and its journal are the authoritative durable logical replica;
vault files are an externally editable projection. Local database commits must
not be confused with completed file projection. Projection runs under a bounded
cross-process lock, reads fresh intents, and records progress durably. Never
overwrite unexpected external bytes: preserve/import them using their proven
base, or retain a recoverable alternative when the base cannot be established.
The lock coordinates participating app processes only; external tools do not
honor it. Filesystem operations therefore need defensive rechecks, recoverable
staging and crash-point tests in the adapter. A lock alone does not make SQLite
and filesystem updates atomic.

Recovery resumes committed projection intents instead of treating half-written
files as fresh edits. Startup/rescan also imports changes made while the core was
stopped. Use explicit provenance to distinguish generated file writes from external
edits; timestamps and file sizes are insufficient. Do not run the legacy TS saver
and the Rust projection adapter as separate authorities over the same vault.

## Meaning of success and failure

`CommitResult` means **saved locally in the database**. Filesystem projection,
delivery to a peer, durable server acknowledgment, and independent backup are
different states owned by their adapters. No boolean `synced` is inferred here.
`Delete` is recoverable logical deletion, not content purge or OS trash success.
History retention, restore, encrypted envelopes, remote conflict policy and
enrollment/recovery remain outside this first contract.

`ContractError` gives stable domain error tags. Adapter errors must separately
represent unavailable storage, quota, authorization, bounded lock timeout,
projection failure and uncertain commit outcome. After an uncertain commit,
retry the **same** request and operation ID. Never manufacture success or retry a
different request under that ID. Rust callers must call `request.validate()`;
deserializing a `MutationRequest` performs it automatically. Unknown request
fields/commands fail rather than silently ignoring consequential behavior.

The pure fixtures cover invalid serde inputs, Unicode/hidden paths, arbitrary
bytes, stale and replaced identities, subtree revision checks, idempotent replay
and large sequence precision. They do not establish transaction durability,
multi-process safety, WASM compilation, filesystem recovery or sync correctness.
Those require adapter and integrated-client tests.

Serde representation uses the official [container attributes](https://serde.rs/container-attrs.html)
and [enum representations](https://serde.rs/enum-representations.html). No OS `Path`
parser is used for logical vault paths, avoiding host-dependent separator rules.
