# Browser storage contract

[Architecture](README.md) · [Browser platform](platforms/browser.md) · [Storage](storage.md) · [Interfaces](interfaces.md)

This maps implemented browser storage at `f799219a`. It records source contracts,
not new runtime acceptance or a browser SQLite implementation. The accepted product
direction is a browser that joins an existing sync group, retains working note data
and indexes, and catches up incrementally; attachment bodies should load on demand
into a bounded cache. That connected working-set design is not the current default
startup contract. No mandatory SQLite/OPFS engine is selected.

## Where current data lives

The normal page opens a dedicated Worker and Rust/WASM, backed by origin-local
IndexedDB. The default name is `zorid-core-vault:default-v1`; the current normalized
authority schema is version 8. This name is not a server group identifier. Startup
requires same-origin WASM assets, IndexedDB and Web Locks; it does not require sync
credentials. Incompatible existing formats are rejected and retained, rather than
cleared or silently replaced. Storage/ownership failure must remain visible as an
error; it is not permission to select a fresh authority. See [startup](../../src/platform/browser-default.ts#L18),
[worker open](../../src/platform/browser-core-worker.ts#L70) and
[database schema/open checks](../../src/core/browser-streaming-vault.ts#L15).

| Data | Current location and ownership | Disposal boundary |
| --- | --- | --- |
| File namespace, committed text, graph state and immutable payload/wire sources | Authority database: `metadata`, `content`, `presentation`, `sync_*` stores | Authoritative local working state; not a disposable index |
| Prepared/requested intents, terminal receipts and publication journal | Same authority: `intents`, `receipts`, `journal`, `control` | Preserve exact operation/outcome identity through reconciliation |
| Editor drafts and consumer operation checkpoints | Same authority: `checkpoint_heads` and `checkpoint_revisions`, scoped by client | Pending/recovery data, including unsent edits; not cache |
| Binary stages, staged source chunks and read pins | Same authority: `binary_stages`, `binary_stage_chunks`, `binary_reads` plus immutable sources | Stages may contain an incomplete/uncertain upload; pins have explicit close/recovery handling |
| Managed records, operation sources, receipts and retry state | Same authority: `managed_*`, with realm/vault/collection identity | Durable application data and unresolved work; not index cache |
| Derived document generations, parsed rows, projections and pins | `document-index:v1/` keys in authority `control` | Rebuildable through the document-index service only |
| Client-slot registry | Separate `<database>:client-slots:v1` IndexedDB database | Preserves client/recovery identity across openings |
| Preferred slot pointer | `sessionStorage`, keyed by database | A pointer, not authority or recovery content |
| Sync key/session, live query builders and transfer FIFO | Worker/page memory | Lost on termination; persisted source and checkpoints remain separate |

The [normalized source/stage schema](../../src/core/browser-normalized-idb.ts#L3),
[managed schema](../../src/core/browser-managed-records.ts#L7),
[editor checkpoint](../../src/ui/note-durable-state.ts#L26),
[document cache](../../src/core/browser-document-index.ts#L9) and
[slot registry](../../src/platform/browser-client-slots.ts#L97) define these boundaries.
Committed text and source payloads can be plaintext locally. E2EE transport does
not establish encryption of browser storage at rest. Older localStorage preview
vault/draft/session records are a separate legacy export surface, never silently
imported into the new authority; see [legacy export](../../src/platform/browser-legacy-export.ts#L1).

## Local commit and acknowledgment

A prepared plan is not a commit. The host first persists an inert intent, then
persists explicit `commit_requested` authorization before applying it. Rust/WASM
prepares and validates the mutation; a final IndexedDB transaction rechecks source,
publication and identity witnesses. That transaction commits graph/source changes,
materialization, authored outbox membership, file receipt, journal sequence and
terminal intent together. Binary final commit similarly couples graph/publication,
outbox admission and terminal stage outcome. Staging chunks alone does not publish
a file. See [intent execution](../../src/core/browser-streaming-vault.ts#L204),
[binary commit](../../src/core/browser-streaming-vault.ts#L250) and
[shared publication/outbox commit](../../src/core/browser-sync-streaming.ts#L513).

Transactions use strict durability, reject an unavailable strict mode, check the
persisted local authority identity and resolve only on `oncomplete`. They do not
span an `await`; planning, networking and lock acquisition happen outside their
synchronous request callbacks. A lost reply can still leave a durable commit:
retain the original IDs and query/replay its outcome. See
[transaction host](../../src/core/browser-normalized-idb.ts#L68) and
[consumer reconciliation](../../src/platform/browser-durable-writes.ts#L135).

| Signal | What it establishes | What it does not establish |
| --- | --- | --- |
| Checkpoint CAS completed | Exact draft/request state was stored locally | File mutation or server delivery |
| Local committed receipt | File operation and its local publication/outbox transaction completed | Relay acceptance or peer convergence |
| Intent acknowledged | Consumer reconciled the exact committed/rejected local outcome | Sync acknowledgment; source deletion permission |
| Relay acceptance validated, then exact wire acknowledged locally | This authored update was accepted by the configured relay; its local pending flag is cleared | Every peer received it, all causal dependencies arrived, or backup completeness |
| Sync sweep `complete` | Fixed relay snapshot consumed and sampled outbox empty | Full materialization, no missing chunks, or convergence with every peer |

[Intent acknowledgment](../../src/core/browser-streaming-vault.ts#L413) only marks
that local intent acknowledged. The [sync worker](../../src/platform/browser-sync-worker.ts#L135)
validates relay acceptance before [outbox acknowledgment](../../src/core/browser-sync-streaming.ts#L977).
Incoming update application and its next cursor are in the same guarded commit;
network requests never hold an IndexedDB transaction. [Sweep completeness](../../src/platform/browser-sync-worker.ts#L30)
is deliberately narrower than a global synced guarantee.

## Scope, reload and multiple tabs

Three identities must remain distinct:

- The database name selects origin-local storage. Its persisted `local-store-id`
  UUID is the authority identity exposed as checkpoint `vaultId`/binary
  `localStoreId`; the client UUID owns intents, checkpoints, stages and pins.
- Sync scope is `realm_id`, `vault_id`, `key_epoch`, with replica/incarnation IDs.
  It is checked against stored configuration; a configured relay also has a
  server epoch and cursor. These are not the checkpoint authority UUID.
- Managed data adds owner/collection/record/generation identity inside that sync
  scope. A collection identifier alone does not authorize another group.

Default startup initializes a synthetic local realm/vault if none exists.
Enrollment into another scope requires an empty authority and never adopts existing
files implicitly. Connecting this default local workspace to an existing remote
group therefore needs an explicit product/bootstrap design. See
[local enrollment](../../src/platform/browser-core-worker.ts#L88),
[enrollment preconditions](../../src/core/browser-sync-streaming.ts#L911) and
[sync configuration](../../src/platform/browser-sync-worker.ts#L72). Current sync
configuration is a trusted worker fixture/session capability, not delivered
Cloud/self-hosted sign-in or group enrollment UX.

Persistent slots select a client ID before admission. A page slot lock and a
worker lifetime lock for `(authorityId, clientId)` prevent duplicate ownership.
Distinct clients can share one database; each transaction still checks source/CAS
preconditions. Locks have no TTL, stealing or automatic alternate-client fallback.
A preferred slot already owned by another page fails explicitly. See
[slot selection](../../src/platform/browser-client-slots.ts#L100) and
[worker lease](../../src/platform/browser-client-lease.ts#L11).

Worker open acquires its lease before replay/checkpoint recovery. It retries
unacknowledged `commit_requested`/committed file intents, then returns recovery IDs
that consumers must reconcile before authorizing new mutations. A prepared intent
alone does not authorize replay. Binary command recovery retries only
`commit_requested`, never automatically commits receiving/sealed stages.
BroadcastChannel messages are change hints; other tabs reread authority instead of
trusting incoming data/sequence. See [startup recovery and hints](../../src/platform/browser-core-worker.ts#L111)
and [binary recovery](../../src/platform/browser-binary-commands.ts#L259).

Explicit release drains admitted work through a guarded flush phase, closes query
and read pins, revokes sync and releases worker/slot ownership. Unknown release
acknowledgments retain retry phases. The default platform release passes an empty
flush callback: it does not itself flush every editor buffer. `pagehide` closes the
runtime and retires the slot synchronously; it cannot promise a final editor
checkpoint or network flush. Already committed IndexedDB data remains distinct
from unfinished in-memory work. See [admission/release](../../src/platform/browser-client-admission.ts#L174),
[default release/pagehide](../../src/platform/browser-default.ts#L120) and
[transport close](../../src/platform/browser-core-runtime.ts#L368).

## Cache deletion and the S0A interface seam

Logical disposal classes currently share a physical database. Deleting the whole
database or arbitrary `control`/`sync_*` rows is not a cache reset: it can remove
unsent edits, receipts, staged attachment bytes, source dependencies and recovery
identity. The document-index `rebuild()` expires its old pins and deletes only its
own generation-key prefix; it leaves source/checkpoint stores intact. Use that
[service boundary](../../src/core/browser-document-index.ts#L339) rather than exposing
raw cache database deletion. No general attachment-source eviction/GC contract is
established by the current index rebuild API.

S0A must review these existing consumer seams before broader storage redesign:

- Preserve atomic source/receipt/outbox publication, exact scope binding, truthful
  outcomes and cancellation/release behavior across storage/index/cache services.
- Preserve scoped index rebuild independently of protected pending data, even while
  cache and source share IndexedDB. A future backend must retain this distinction.
- First-party `Vault` binary reads/creates/modifications reserve a whole transfer
  using a FIFO keyed by the exact `BinaryStreams` object. Metadata-only identity
  selection remains immediate; body/pin I/O waits outside the metadata/text-write
  queue. Aliased Vault wrappers and binary recovery share that stream key. See
  [scheduler](../../src/core/binary-transfer-queue.ts#L1),
  [Vault transfer ownership](../../src/core/vault.ts#L347) and
  [browser recovery admission](../../src/platform/browser-client-admission.ts#L173).
- The direct browser adapter convenience `createBinary`/`writeBinary` exports still
  call their own `binary()` helper outside that FIFO. No current first-party
  production caller was found using these exports directly: ordinary Vault paths
  choose streams, attachment resources read through Vault, and import uses Vault.
  Do not claim universal serialization of arbitrary low-level consumers. Review
  whether to route or narrow that surface during S0A; this map changes no API.
  See [adapter helper/exports](../../src/platform/browser-default.ts#L43),
  [Vault selection](../../src/core/vault.ts#L452),
  [attachment resources](../../src/ui/attachments.ts#L50) and
  [attachment import](../../src/core/attachment-import.ts#L179).

## Guarantees still open

Current code does not establish connected Cloud/self-hosted onboarding, remote
bootstrap of the retained working set, on-demand bounded attachment eviction,
key retention across visits, browser-storage eviction recovery, or native snapshot
history parity. No guarantee covers every keystroke before its asynchronous
checkpoint or a final flush during forced termination. Transaction atomicity
does not promise retention after user/browser clearing of origin storage. Strict
local transactions are not off-device backups.

The accepted browser retention direction protects pending edits/receipts from
cache cleanup; it does not authorize deleting current local data while these
policies are designed. S0 records the current storage contract. S0A reviews its
interfaces; subsequent browser design and actual runtime evidence must establish
the remaining guarantees before reporting them as delivered.
