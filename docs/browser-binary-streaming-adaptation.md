# Browser/WASM binary streaming adaptation — API preparation

Status: proposed consumer design, not an implementation or joint API freeze.
Owner `/root/default_lifecycle_review_sol`; source read at main `4a48a79`.
Portable owner `/root/desktop_default_sol`, store owner `/root/package_sol`,
root sole integration owner. No streaming source edits, builds or UI checks were
performed for this assessment. The separate explicit binary-create race fix is
not evidence of streaming support.

## Scope and dependencies

Use the approved shared-binary-streaming-plan: existing authenticated v2 wire,
128 KiB decoded chunks and explicit 64 MiB Binary file cap. Do not raise JSON
budgets, convert Text identities, introduce a JS verifier, or call a chunked IPC
wrapper bounded-memory storage. Current small Text budgets stay unchanged.

Portable metadata foundation supplies `MetadataState`, checked `GraphRecord`,
`BinaryManifestBuilder`, `BinaryContentRef` and private verification capabilities.
The portable owner agreed to add shared resumable verification sessions because
IndexedDB cannot provide synchronous `ChunkSource` reads:

- `ManifestVerificationSession::{new,next_chunk,provide_chunk,finish}`;
  requests derive sequence/scope/update/expected descriptor from captured metadata.
- `AllBinaryVerificationSession` visits all complete retained manifests, including
  hidden/history alternatives; requests also carry manifest index. `finish`
  returns the private verified set only after every requested chunk and final
  concatenated length/hash check succeeds. Existing synchronous helpers drive
  these same sessions through `ChunkSource`.

Exact signatures remain portable-owner pending. A second dependency is metadata
receive/author/family/Text-namespace plans and classification. The additive
metadata/builder foundation alone does not replace current `v2::State` planners.
Store-issued stage reference resolution, versioned Inline/BinaryRef operation
requests, pinned read semantics and quotas also need joint freeze before coupled
browser implementation. No empty fake MutationRequest may stand in for a stage.

## Concrete existing choke points

| Source | Required replacement |
| --- | --- |
| `browser-sync.ts load()` / `transaction()` | Every operation loads eight sync stores plus metadata/content/presentation/control/journal/intents/receipts with `getAll()`. Replace byte-bearing aggregate snapshots with metadata cursors and exact source-key reads. |
| `saveStates()` | Single `sync_state.graph` embeds all payloads. Store GraphRecord descriptors and activities separately; preserve exact state preconditions. |
| `materializations()`, `readRetained()`, browser-vault publication | Whole Binary bodies recur in classified JSON, retained history and current content. Replace them with exact content refs/witnesses. |
| `browser-vault inventory()/snapshot()/readEntry()` | Fetch/copy every file body, repeat complete sync validation, and search inventory even for one stat/read. Metadata-only inventory and indexed path/ID observation are prerequisites. |
| `sync/family.rs` requirements/plan/checks | Embed complete `v2::State`, command content and all authored payload arrays. Use metadata state + resolved stage target/ref; expose one bounded authored payload at a time. |
| `sync.rs` file AND Text plans | Both embed payload-bearing namespace State. Move both to metadata handles or large Binary still blocks ordinary Text saves. |
| `sync/classification.rs` | Classification/recovery materialize bytes into JSON under 8 MiB per-file/aggregate limits. Return BinaryContentRef and status, not Binary bytes. |
| `browser-default.ts`, `browser-file-commands.ts` | Full structuredClone, Array.from signatures, base64 checkpoint body and numeric JSON family command capped at 4 MiB. New stage checkpoints contain identities/expectations only. |
| `browser-core-runtime.ts` / worker | structuredClone then nontransfer postMessage duplicates bytes. Add bounded private snapshots and transfer lists in both directions. |
| `BrowserSyncWorker.sweep()` | Wraps whole receive in the sole `host.local()` queue. Run async verification outside that tail; queue only short snapshot/final-commit phases. |
| attachment import/preview/PDF callers | Whole arrayBuffer/readBinary/Blob chains remain. A stream capability or explicit bounded-preview state is required before claiming end-to-end large-file coverage. |

Current graph-to-ledger validation re-encodes `JSON.stringify(payload)` in
browser-sync. Replace it with the exact accepted plaintext commitment and checked
summary derived by the authenticated WASM update; accepted JSON spellings need
not re-encode identically.

## Proposed browser-facing types

Names below are implementation seams for freeze, not public product APIs.
`u64` lengths/offsets are canonical decimal strings; sequence/maxBytes are bounded
integers. References are lookup tokens, never caller-created verification proofs.

```ts
type BinaryTarget =
  | {kind:'create'; entryId:string; path:string}
  | {kind:'write'; entryId:string; expectedRevision:string;
     expectedContentEvent:string};
type StageRef = {localStoreId:string; clientId:string;
                 operationId:string; stageId:string};
type BinaryObservation = {
  entry:{id:string;path:string;kind:'file'|'folder';revision:string};
  presentation:unknown;
  content?:{kind:'text'|'binary';selectedEvent:string;length:string};
};
interface BinaryStreams {
  begin(input:{operationId:string;target:BinaryTarget;expectedLength?:string}):Promise<StageRef>;
  append(ref:StageRef,input:{sequence:number;offset:string;bytes:Uint8Array}):Promise<ChunkReceipt>;
  query(ref:StageRef):Promise<StageStatus>;
  seal(ref:StageRef,input:{finalLength:string;expectedDigest?:string}):Promise<SealedRef>;
  commit(ref:StageRef):Promise<string>; // Original durable operation receipt.
  abort(ref:StageRef):Promise<void>;
  openRead(input:{entryId:string;expectedRevision?:string;
                  expectedContentEvent?:string}):Promise<ReadRef>;
  read(ref:ReadRef,input:{offset:string;maxBytes:number}):Promise<{
    bytes:Uint8Array;nextOffset:string;eof:boolean}>;
  closeRead(ref:ReadRef):Promise<void>;
}
```

Expose this optionally through admitted BrowserClientContext, then
VaultAdapter.binaryStreams and Vault wrappers with separately coordinated shared
interface ownership. Every method invokes current admission/owner checks at call
entry AND immediately before queued worker dispatch. Worker checks client lease,
authority/scope and operation owner again. No raw runtime escape from admission.
`observeEntry(path)` is metadata only and returns coherent identity/revision/kind/
selected event; unresolved/conflicting entries return explicit status rather than
inventing a selected event from a hash. Rename/trash/delete/stat never read bodies.

Create remains explicitly Create end-to-end; update cannot adopt a replacement
with identical bytes. Existing writeBinary upsert semantics remain separate.
Existing readBinary is a declared small-file convenience: check observed length
before any whole read and reject stream_required above its frozen bound. The
64 MiB format maximum is not that preview/convenience bound.

## WASM boundary and source verification

Use opaque worker-local metadata/builder/plan/verification handles. Import bounded
metadata descriptor/activity rows individually into a metadata builder, validating
record summaries against immutable ledger commitments, then finish one captured
MetadataState. Do not serialize the complete graph again for each plan/check.
Metadata memory follows separately frozen event/page quotas, not stored bytes.

A `WasmAuthoredRecord` exposes descriptor JSON and one Uint8Array exact plaintext
payload. `WasmBinaryBuilder.pushChunk(id, bytes)` takes at most 128 KiB;
`flushPage(id)` emits the existing bounded v2 page. `finish` yields manifest
metadata only, never a durability proof. Stage cursor and each emitted payload/
reserved ID are persisted together before acknowledgment. After uncertain writes
query durable sequence; after restart rebuild transient builder/hash state by
streaming durable sources, not serializing a hasher memory layout.

The WASM verifier wraps the portable resumable session. `nextChunkJson()` exposes
only its next required immutable source key/descriptor. Worker resolves one exact
plaintext source, bounded by the existing wire plaintext limit. A
`providePayload(manifestIndex, sequence, exactPlaintext:Uint8Array)` wrapper checks
its exact payload length/digest and derived summary against the captured
GraphRecord/ledger authority, decodes one <=128 KiB chunk, then feeds the shared
portable verifier. This avoids a caller-declared verified summary and preserves
whole-file SHA validation. Received descriptors come from WasmSyncUpdate's exact
authenticated plaintext; authored descriptors come from checked emitted payloads.
`finish` returns an opaque verified set; there is no JSON proof constructor.

Plan results contain metadata deltas, outcomes and content refs. Bounded typed
accessors supply one authored payload or exact wire. Classification/recovery
returns refs/status for Binary; small Text uses its existing separate path. Every
read checks actual chunk bytes through the same shared verifier, even if sources
were verified earlier. A wrong historical whole-file hash must block the enabling
receive receipt/cursor just as a visible one does.

## Normalized IndexedDB and transactions

Use a new explicit local schema/state version on fresh disposable fixtures.
Reject unsupported earlier formats without deleting or silently rebinding them.
Exact version/name and startup disposition need root freeze; there is no approved
automatic conversion of existing browser data.

- Small root/config rows retain scope, graph revision, counts and canonical
  decimal commit generation. Generation is NEW and only an extra stale-work fence.
- Graph records/activities are keyed by scope+update ID and contain metadata,
  exact payload commitment, checked summary commitment and immutable source key.
- One immutable exact-plaintext source row per update/stage allocation, shared by
  stages/authored ledger/graph refs. Do not persist another full-file BLOB or a
  second raw-chunk copy merely for publication. Wire rows separately retain exact
  authenticated wire bytes. Get one bounded payload/wire by key.
- Authored/envelope headers reference source rows; indexed pending order selects
  bounded headers without historical bodies. Do not use booleans as IDB keys.
- Stage rows persist client/op/target/phase/cursor; sequence rows reference sources.
  Read rows pin exact event/manifest/source identity. Initially retain immutable
  sources; no GC algorithm is part of this increment.
- Current/retained/historical Binary publications contain refs and witnesses;
  bounded Text content stays separately represented. Add path index for exact
  observation. Journal paging must order canonical decimal sequences correctly.

Append: strict short transaction checks ownership, phase, exact sequence/offset,
byte cap and quotas; exact duplicates compare the existing bounded bytes; inserts
source/cursor atomically. Resolve only at transaction oncomplete.

Plan/receive: short readonly snapshot captures exact MetadataState, relevant Text
state, entry revision/event, cursor and source descriptors. Async verification
runs outside a write transaction and outside the worker's sole local queue, with
revocation checks between chunks. No IDB transaction spans an await.

Final commit: strict readwrite transaction chains indexed requests synchronously,
rechecks lease/session, generation AND exact MetadataState equality, relevant Text
state, target revision/selected event, cursor, stage phase/authorization and every
source's immutable commitment/existence. A version/hash-only check is insufficient.
Then commit graph/activity/ledger/outbox eligibility/publication refs/revision
fences/journal/receipt/intent outcome and cursor atomically. Stale work retries
without cursor or visibility advance. Missing descriptor-backed bytes are
corruption, distinct from genuinely absent graph dependencies.

Sealing and exact ACK use update-key lookups and existing two-phase winner checks.
Never reconstruct unrelated graph/history or weaken exact-wire duplicate rules.

## Recovery, transfer and release

Consumer checkpoint states must distinguish Receiving, Sealed and
CommitRequested. Persist original target/op before inert begin; replay begin with
the same op after a lost reply. Append/seal query/retry exact stage. Receiving or
Sealed imports with no input source after reload remain paused; they must not
silently authorize commit or block unrelated note editing. Expose a bounded
paused-import summary through command recovery; exact UI wording is separate.

Before commit, persist exact stage reference and target expectations as
CommitRequested. Stage terminal outcomes enter the existing intent/receipt/exact
ACK model; they must not be interpreted as text intents or bypass startup note
recovery. Unknown outcomes query the same op, never mint a replacement operation.
Checkpoint/intent discriminants and note-consumer filtering require joint freeze.

Each RPC owns one <=128 KiB private snapshot, transferred renderer->worker;
worker replies transfer a fresh bounded buffer rather than detach stored/cache
bytes. Caller buffers stay unchanged. Existing bounded request counts remain,
with one awaited append per producer; no file-size list of queued chunks.
Network wire/plaintext bounds stay independently enforced.

Release fences new dispatch, drains accepted bounded work, closes owned transient
read sessions/pins according to the frozen read policy, and retains interrupted
stages. It never silently aborts Receiving/Sealed work. Pagehide/restart retains
stable slots and client recovery ownership; copied active-tab identities still
fail closed. Long verification must observe release/revocation promptly rather
than hold the serialized local queue for the file duration.

## Freeze and validation gate

Freeze portable resumable session signatures; metadata author/receive/family/Text
plans; versioned stage intent/operation discriminants; read pin lifecycle;
metadata-only observation; schema/version startup policy; separate causal metadata,
byte, stage and preview quotas. These are concrete dependencies before browser
source implementation, not optional framework work.

One bounded integrated fixture should cover >16 MiB and exactly64 MiB binary,
wrong whole hash including hidden history, corrupt/missing sources, stale cross-tab
plan/event CAS, revocation during verification, abort before receipt/cursor commit,
lost append/seal/commit ACK/reload, paused unauthorized stage and exact retry.
Measure memory as file/history bytes grow; verify ordinary Text/rename operations
beside a large Binary do not enumerate byte stores. Actual browser import/export,
offline relay/reopen, two tabs and bounded-preview behavior require later serialized
production/runtime gates. This preparation claims none of them.
