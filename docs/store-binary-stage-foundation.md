# Durable binary stage foundation

Current verification update (2026-10-17): Store library gate19472 passed86 tests,
0 failures,1 explicit ignored64MiB fixture. Earlier source-only/unrun wording
below records preparation state; the authoritative gate history and remaining
native/client gaps are in `docs/store-binary-streaming-activation.md`.

Status: the original additive foundation passed its scoped store tests. The
subsequent normalized-source and Capture changes are prepared and unrun; no
application streaming activation or native-client acceptance is established. Owner
`/root/package_sol/cli_tests`, parent `/root/package_sol`; branch/worktree
`store-binary-streaming`. Parent owns central schema registration, exports,
global operation admission and envelope reservation integration. The portable
builder/descriptor dependency is present at `65086ba`.

The original increment implemented only durable invisible staging in
`crates/zorid-store/src/blob_stage.rs`. The subsequent source-only activation is
tracked separately in `docs/store-binary-streaming-activation.md`; its commit,
entry visibility, projection, pinned reads and ingress changes are not yet
compiled or verified. Seven original module tests passed; nine adapted/expanded cases are
now prepared for the next gate. No unrestricted file
size or bounded-memory end-to-end claim follows from this foundation.

## Public Rust surface

```rust
begin_binary_stage(&mut self, client: &OperationId, operation: &OperationId,
                   request: &BinaryStageRequest, limits: StreamingLimits)
    -> Result<BinaryStageRef>;
begin_binary_capture(&mut self, client: &OperationId, operation: &OperationId,
                     request: &BinaryCaptureRequest, limits: StreamingLimits)
    -> Result<BinaryStageRef>;
resume_binary_stage(&self, client: &OperationId, operation: &OperationId)
    -> Result<Option<BinaryStageRef>>;
append_binary_chunk(&mut self, stage: &BinaryStageRef, sequence: u32,
                    offset: u64, bytes: &[u8]) -> Result<StageChunkReceipt>;
query_binary_stage(&self, stage: &BinaryStageRef) -> Result<BinaryStageStatus>;
seal_binary_stage(&mut self, stage: &BinaryStageRef, final_length: u64,
                  expected_digest: Option<Sha256Digest>) -> Result<StagedBinaryRef>;
abort_binary_stage(&mut self, stage: &BinaryStageRef) -> Result<()>;
captured_binary_ref(&self, stage: &BinaryStageRef) -> Result<CapturedBinaryRef>;
```

`BinaryStageRequest` contains Create { entry ID, path } or Write { entry ID,
expected revision, expected selected content event }, plus optional expected
length. Staging requires the existing authority scope and existing family graph
head; it never initializes enrollment or loads the legacy aggregate file graph.
The later commit path must check those original target preconditions against
current namespace/content authority. Beginning a stage does not establish them.

Capture is a separate inert purpose: `BinaryCaptureRequest` contains a path,
known expected length and SHA256. It creates no fake entry, revision or causal
event. The same operation ID cannot change purpose or request. Seal must match
the capture's original length/hash. A sealed capture releases its active-stage
slot while retaining all bytes, records and operation ownership. It cannot be
aborted after issuing stable source references. Parent command commit admission
must reject Capture; retaining its bytes never authorizes publication.

`BinaryStageRef` and `StagedBinaryRef` have private fields, getters and diagnostic
serialization, with no Deserialize or public constructors. Resume resolves the
persisted client/operation through the current local store. Every operation
rechecks local-store identity, client, operation and scope against the stored row.
An adapter must additionally enforce its caller admission/lease policy. The
inert sealed reference is never an operation receipt or verified publication.
`BinaryStageRef::locator()` returns serializable identity only. Resolving any
locator checks its complete owner against the current store. Capture metadata
resolution revalidates the sealed source and returns only its chunk/page records,
without namespace entries or events.

Public byte counts/offsets use u64 in Rust and canonical decimal strings in JSON;
sequence and per-chunk byte counts remain u32 numbers. Caller request and quota
deserialization rejects numeric, signed and noncanonical decimal byte counts.
The finalized manifest diagnostic serializer also converts file/page lengths.
The versioned internal source commitment uses canonical Rust serialization; it
is not a transport or public wire format.

## Persistence and bounds

`binary_stages` owns exact target request, owner, scope, policy snapshot, progress,
phase and optional seal request/manifest/source commitment. Each stage operation
ID is globally reserved. `binary_stage_allocations` durably reserves chunk/page
update IDs by scope and stage. `binary_stage_chunks` and `binary_stage_pages`
retain independent payload lengths, exact digests and typed summary commitments,
plus their stage/sequence/update IDs. They store no body or descriptor copies.
Each exact files-v2 plaintext and descriptor lives once in `immutable_payloads`;
reads check it against the independent stage commitments. Pages gain references
only in the successful seal transaction.

Fixed bounds are 64 MiB per file, 128 KiB per canonical chunk and 1 MiB per exact
payload. Empty files have no chunk/page payload. Only the last chunk may be
short. Append rejects empty bodies, gaps, overlap, changed duplicates and any
append after EOF/seal has been requested. An identical earlier append returns
its original receipt, including the accepted length at that append.

`StreamingLimits` has no Default. Callers inject positive finite
`max_active_stages`, `max_stage_records`, `max_staged_bytes`, `max_chunk_records` and
`max_page_records`; activation uses the root-approved shared `DEFAULT_STREAMING_LIMITS` (8 active,
4096 retained stages, 512 MiB exact source, 4096 chunk rows and 256 page rows). Limits are captured
at begin and retained on identical begin replay. Byte accounting measures exact
stored payload BLOB lengths, including JSON encoding overhead. Record and byte
quotas include retained aborted stages/allocations. The separate stage-record
quota counts every retained stage row, including empty aborted stages, so
begin/abort loops cannot evade finite metadata accounting. Identical begin and
resume remain available at that cap. Abort releases the active
stage slot but does not delete data or make operation/update IDs reusable.
Stage byte usage joins shared immutable rows once; a separate 512 MiB cap covers
all retained immutable plaintext sources, including aborted-stage-only sources.

Append atomically reserves its update ID, stores its exact payload/descriptor and
advances progress. It never inserts into authored envelopes, operations, outbox,
entries or graph records. Parent integration must make both ordinary operation
admission and envelope allocation consult this module's crate-private
`operation_reserved` and `update_reserved` helpers.

## Seal and restart

The first short transaction persists the exact seal request and all required
page IDs. The phase stays Receiving while `seal_requested` freezes further
append. Interruption therefore resumes the same EOF request and page identities.
Changing the seal length/digest after that durable authorization is an
idempotency conflict; a wrong digest requires explicit abort, rather than a new
plan under the same operation ID.

The second transaction reconstructs the shared portable manifest builder from
one durable exact chunk payload at a time. It redecodes payloads, rederives and
checks descriptors, validates immutable allocations, and verifies whole-file
length/hash. Bounded manifest/source metadata binds stage identity, scope,
request, exact ordered payload commitments and manifest. Page persistence and
the Sealed transition are atomic. No private hasher memory is persisted.

Seal retries and queries that return finalized references repeat actual source
verification, including exact stored page payload comparisons. A persisted
manifest/hash alone never becomes a verification flag. Abort is idempotent for
Receiving, Sealed or already Aborted command stages; Capture allows abort only
before sealing. Authorization/committed phases reject abort.
CommitRequested/Committed/Rejected belong to the parent command integration;
Capture can never enter those phases.

## Prepared acceptance and remaining gates

The nine module tests cover ownership/exact begin/restart, independent store
rejection, append limits/gaps/tails/exact retries, quota retention and reserved
IDs, bounded empty-stage abort loops and invalid persisted quota rejection,
existing enrollment/global host-operation conflicts, canonical decimal
requests, empty/exact-chunk seal/restart, durable failed seal request/page IDs,
source corruption revalidation and absence of visible operations/outbox/entries.
Capture cases additionally check expected hash, purpose/request conflicts,
stable owner-bound locators, metadata with no namespace events, sealed-reference
retention, active-slot release and shared bodies without stage copies.

Variable staging metadata is bounded by retained stage/chunk/page record quotas,
a 1 MiB request bound, per-stage 512 chunks/four pages and bounded immutable IDs.
Request paths are checked before encoding; payload/descriptor and persisted
stage metadata lengths are checked before body loading. Manifest reconstruction
retains at most the fixed per-file descriptor/page metadata, not file bodies.

The original seven tests passed in the 29-case store library gate at source `ada6e8b`
(handle `30523`, exit 0). Parent integration includes reciprocal operation/update
collision checks and schema-10 registration. The three-case family transaction
suite passed (handle `32902`, exit 0), including byte-preserving rejection of old
schema 9. See [full gate record](store-binary-streaming.md).
The normalized/Capture changes and schema-11 registration need the next granted
serialized gate; no new checks were run by the stage owner.
Actual >16 MiB native/client input, commit, publication, read, crash/recovery,
encrypted transfer and memory measurements remain future integrated gates.
