# Shared binary streaming contract — proposal for review

Status: root reviewed sections1–3 on2026-10-17 and authorized the narrow portable
types/builder/verifier and metadata/chunk-source implementation. No runtime
streaming validation is claimed. Exact portable/store signatures must be frozen
jointly before coupled integration; quotas and later Text framing remain review
items. Store design owner is `/root/package_sol`; portable owner is
`/root/desktop_default_sol`. Branch
`tingkai-c/shared-binary-streaming`, Orca worktree
`/Users/ctk/orca/workspaces/Zorid/shared-binary-streaming`, base `890a9d4`.
Root remains the sole main integrator. Native build slots remain root-owned.

Latest integration update (2026-10-17): main2a78b40 contains the additive metadata
candidate, verified reference classifier and binary event mapper. Exact portable
source matches frozena661bf7; single-job lib gate50222 passed97/97, including six
mapper fixtures. Mainacda3ed contains metadata-only core content planning, source
e7827b0; gate33112 passed6new+12planning+5materialization checks. Private verification
proofs are rebuilt after reload; durable source commitments are not serialized
verification capabilities. Store stage/descriptor foundation passed29lib+3family
checks in isolation and is now composed in aggregateb86149e. Store schema10 is
not main; activation schema11 and client/native streaming remain pending. Current
main runtime still uses bounded whole-file paths and the existing v2 wire codec.

The first deliverable is bounded-memory binary create/read/update/import and
E2EE sync of files above 16 MiB. Keep the current authenticated 128 KiB chunk
wire and an explicit **64 MiB per-file format limit** for this increment. This
is not unrestricted file-size support. Text identity and large UTF8 limits are a
separate work item below; never silently convert existing Text into Binary.

## Current constraints this replaces

Source audit shared with `/root/external_reconcile_sol/external_scan_review`:

| Layer | Present representation / constraint |
| --- | --- |
| Native | `Options.max_file_bytes` 16 MiB; `fs::snapshot` reads a full Vec; external scan holds content for every observed file within its separate 64 MiB work budget |
| Store | `FAMILY_MAX_FILE_BYTES` 16 MiB; entry BLOB plus whole content in commands, observations, projection targets/baselines and retained JSON records |
| Portable file sync | 64 MiB format limit; 128 KiB chunks, 128 chunk refs/page, 128 pages/manifest; State retains chunk bodies; 4,096 records and 128 MiB encoded graph; view rebuild revalidates retained complete manifests and allocates legacy blob state |
| CLI | `input_bytes` reads cap-plus-one into one Vec; reads return a complete StoredEntry |
| Desktop | stdio body limit 16 MiB, checkpoint body 32 MiB; `text-create.cjs` base64-encodes entire binary bodies and checkpoints them; readBinary returns a whole Uint8Array |
| Browser/WASM | command JSON 4 MiB; reusable state JSON 8 MiB; input/output JSON 32/64 MiB; classified materialized output 8 MiB aggregate; graph stored as one record and snapshot reads all sync/content rows |

These are cumulative constraints. Raising a single limit or sending an existing
whole Vec in smaller IPC messages does not meet this contract.

## Ownership and integration order

| Scope | Named owner / files | Dependency |
| --- | --- | --- |
| Shared contract and portable binary semantics | `/root/desktop_default_sol`; this document, then agreed `zorid-file-sync/src/{binary_stream.rs,v2.rs,mutation.rs,materialization.rs}` and narrow core content-reference types | Root approves API/data shapes before edits |
| Native scan/physical publication | `/root/external_reconcile_sol`; native fs, native/family/namespace/publication_handoff/external_scan/host_intents | Shared refs and store API; native scan-progress work remains independently owned |
| Store persistence/ingress | `/root/package_sol`; `zorid-store/src/{lib.rs,file_state.rs,family_ledger.rs,family_commands.rs,family_materialization.rs,projection.rs,family_observations.rs,family_external_create.rs,family_external_namespace.rs}` plus a new blob/stage module | Shared metadata state and verification contract; first reconcile the native owner's scan-progress checkpoint/proof helpers; no parallel schema ownership |
| Standalone CLI | `/root/package_sol`; CLI main and focused process checks | Native streaming interface, not an independent filesystem importer |
| Browser/WASM | Current browser owner, with exact files assigned by root; wasm sync/family/classification and browser-sync/worker/runtime/adapter | Portable metadata/ref APIs and immutable indexed chunk storage |
| Desktop consumer | Root must assign exact owner before edits; host main/family, rust service/admission, text-create/checkpoints, preload/bridge/platform mapping and Vault binary wrappers | Same native stage/ref API; renderer ownership explicitly coordinated |
| Large text | Portable owner may delegate the scoped8Kdiff repair in an isolated worktree; larger framing remains proposal only | Keep current256KiB budget and immutable Text identity; no new wire framing or raised Text/snapshot limits without review |

Read-only subworkers `chunk_metadata_contract` and `text_limit_contract` assess
specific transition invariants; they own no source edits or builds. Both completed
read-only reviews at890a9d4; their exact-plaintext/whole-hash and bounded-diff/Text
framing findings are incorporated below. Adapter work
may proceed independently once the shared contract is agreed. Heavy checks stay
serialized. No broad cross-layer rewrite is authorized by this document alone.

## 1. Data identities and byte ownership

Rust names below are proposed additive APIs, not existing callable methods.
Existing `Scope`, `EntryIdentity`, `UpdateId`, `Revision`, `Manifest`, `ChunkRef`
and `ContentWitness` remain the vocabulary. All byte counts/offsets are u64 in
Rust and canonical decimal strings at JS/JSON boundaries. Chunk sequence is a
bounded u32. Fixed digest values remain SHA256; introduce no encryption primitive.

```rust
// Durable local identity, never an OS pathname or a credential.
struct BinaryStageRef { local_store_id: OperationId, client_id: OperationId,
                        operation_id: OperationId, stage_id: OperationId }
enum BinaryTarget {
    Create { id: EntryId, path: VaultPath },
    Write { id: EntryId, expected_revision: Revision,
            expected_content_event: UpdateId },
}
struct BinaryStageRequest { target: BinaryTarget, expected_length: Option<u64> }
struct StageChunkReceipt { sequence: u32, offset: u64, bytes: u32,
                           digest: Sha256Digest, accepted_length: u64 }
struct BinaryStageStatus { state: StagePhase, accepted_length: u64,
                           next_sequence: u32, finalized: Option<StagedBinaryRef> }
enum StagePhase { Receiving, Sealed, CommitRequested, Committed, Rejected, Aborted }
// Store-issued reference. Private proof fields; no public Deserialize capability.
struct StagedBinaryRef { stage: BinaryStageRef, manifest: Manifest,
                         source_commitment: Sha256Digest }
// Causal identity is essential even when another head has identical bytes.
struct BinaryContentRef { scope: Scope, entry: EntryIdentity,
                          selected_event: UpdateId, manifest: Manifest }
struct BinaryReadRef { read_id: OperationId, content: BinaryContentRef,
                       entry_revision: Revision }
```

A bare hash, path, caller-declared digest or metadata-only graph is not a verified
content capability. Reference serialization is diagnostic/persistence data; a
renderer must not reconstruct a trusted StagedBinaryRef or verification proof by
submitting JSON. Local references are resolved and revalidated by their owning
store. Scope, client, target and operation identity are checked on every call.

The StagedBinaryRef fields are private. Its source commitment binds canonical
ordered chunk/page keys, their exact payload commitments, staged allocation and
manifest. The owning store resolves the stage record and rejects forged/stale
references. Read IDs pin those exact content sources until close. CLI constructs
its own core-side stage owner, without requiring desktop IPC or an Electron
client lease; the CLI owner must freeze its stable resume identity before adapter
implementation. Electron/browser enforce their existing client admission in
addition to the shared local stage checks.

Length is optional at begin for stdin. The stage enforces the 64 MiB cap before
persisting bytes beyond it. Zero-length files are valid. Stable chunk/page/update
IDs are reserved durably as needed, not allocated from whole-file memory.

## 2. Streaming stages and exact retries

Proposed shared native/store surface:

```rust
begin_binary_stage(client, operation_id, request) -> BinaryStageRef;
append_binary_chunk(stage, sequence, offset, bytes: &[u8]) -> StageChunkReceipt;
query_binary_stage(stage) -> BinaryStageStatus;
seal_binary_stage(stage, final_length, expected_digest: Option<Sha256Digest>)
    -> StagedBinaryRef;
commit_binary_stage(stage) -> existing durable receipt + ProjectionStatus;
abort_binary_stage(stage) -> (); // explicit only, before commit authorization
open_binary_read(id, expected_revision: Option<&Revision>) -> BinaryReadRef;
read_binary_chunk(read_ref, offset, max_bytes) -> bounded bytes + EOF;
close_binary_read(read_ref) -> ();
```

- Maximum body for append/read is 128 KiB. Clients coalesce short reads into
  canonical full chunks; only the final chunk may be short. Seal supplies EOF
  when file length is an exact multiple of the chunk size. Empty files have no
  chunk payload. The store rejects gaps, overlap, changed duplicate bytes,
  append-after-seal and inconsistent length/digest.
- A repeated begin with identical operation/request returns the same stage.
  The same operation ID with another target or request is an idempotency error.
  Each successful append acknowledges **durable stage bytes only**, not a file
  mutation, projection, remote receipt or backup.
- Seal incrementally hashes durable chunks in order and returns an inert
  reference. It does not make the file visible or publish an outbox. Rebuilding
  hash state after restart may reread staged chunks; it must not assemble a Vec
  or persist an unversioned cryptographic hasher's private memory layout.
- Commit first durably records authorization; then its final transaction checks
  original target/revision/selected event, immutable stage, current namespace and
  storage quotas. It exposes content refs, causal event, outbox eligibility and
  the original operation receipt atomically. Uploading a file does not freeze
  unrelated vault edits for its entire duration. The short final planning step
  uses current graph metadata and the original target expectations.
- Unknown append/seal/commit outcomes query/retry the same stage and operation.
  No uncertain commit is replanned under a fresh operation ID. Existing close,
  switch, checkpoint and per-client ownership rules apply. An interrupted stage
  survives process death and native client retirement; release is not deletion.
- An explicit abort cannot delete committed or referenced data. GC must preserve
  unacknowledged stages, operation receipts, baselines, history/conflict heads,
  pending projection/outbox and pinned read/verification references. Initial
  implementation may retain unreferenced chunks; unsafe reclamation is excluded.

The existing inline `Mutation`/FamilyCommand APIs remain bounded convenience
entry points. Binary wrappers stage their bytes and use this same commit path;
there is no second receipt/authority model. Large binary operations use the
reference form and never serialize body_base64 into a command/checkpoint.

## 3. Portable state transition and verification

Preserve v2 encrypted envelope shape and strict authenticated decoding. Replace
only the local aggregate state representation, under an explicit new local
state/schema version on fresh disposable fixtures. Reject earlier unsupported
local formats; do not silently migrate real vaults or weaken wire negotiation.

Proposed metadata state separates `Payload` (bounded wire bytes) from
`GraphRecord` (local immutable descriptors):

```rust
enum GraphRecordBody {
    Chunk { bytes: u32, digest: Sha256Digest },
    Page { page: ChunkPage },
    Events { events: Vec<v2::EntryEvent> },
    ObservedDelete { events: Vec<v2::EntryEvent> },
}
struct GraphRecord { payload_bytes: u32, payload_digest: Sha256Digest,
                     body: GraphRecordBody }
struct MetadataState { scope: Scope, version: Revision,
    records: BTreeMap<UpdateId, GraphRecord>,
    activities: BTreeMap<UpdateId, StoredActivity> }
trait ChunkSource {
    // Resolve only an authenticated immutable scope/update key. The consumer
    // checks actual length/digest; the provider cannot declare verification.
    fn read_chunk(&mut self, scope: &Scope, id: &UpdateId,
                  expected: &GraphRecord) -> Result<Vec<u8>>;
}
```

`read_chunk` returns at most 128 KiB. A sink accepts one verified chunk plus its
immutable descriptor and exact authenticated-wire provenance. Chunk bytes live
in normalized rows keyed by scope/update ID; a digest alone is not provenance.
The expected descriptor comes from MetadataState, not from the reader's caller.
Derive payload_digest/payload_bytes from **exact accepted plaintext**, never from
re-encoding an accepted Payload (valid JSON spellings can differ). Derive chunk
summary from authenticated decoding while its bounded bytes are available. Bind
that checked summary to immutable ledger authority in the same transaction; add
a graph-summary commitment or equivalent checked authoritative record. Existing
ledger metadata's payload digest cannot independently prove an invented derived
chunk summary without decoding the bytes. Metadata loading must query descriptor
columns directly; current `file_state::metadata()` loads authored/wire blobs.
Duplicate ID with different exact wire/descriptors is still rejected. New local
chunks retain operation/stage allocation lineage before becoming authored wire.

Add a portable incremental manifest builder and verifier in `binary_stream.rs`:

- `push_chunk(id, &[u8])` emits one current-v2 chunk payload and retains only its
  reference/hash; `flush_page(page_id)` emits a bounded existing ChunkPage;
  `finish()` produces a Manifest and a private verified staged capability. The
  host persists each emission before advancing its resumable stage cursor.
- A verifier consumes manifest pages/descriptors through ChunkSource, checks each
  actual chunk length/hash and the final concatenated length/SHA256, and binds
  the result to the exact manifest plus source key/descriptors/payload digests.
  Memory is O(one chunk + bounded manifest/page metadata), not O(file/history).
- Metadata classification returns a `BinaryContentRef` or explicit pending/error,
  never `VerifiedContent.bytes`. Materialized text remains separately bounded.
  Publication/read uses the verifier and an output sink. No path gathers all
  chunk payloads into legacy blob_state or re-encodes all retained payload bytes.
- **Preserve ingress validation:** today view rebuild verifies every retained
  complete manifest's whole-file hash. Per-chunk hashes do not prove that final
  hash. Initially stream-verify **all complete retained manifests**, including
  hidden/history alternatives, before committing the enabling receive receipt/
  cursor. Optimize to newly complete manifests only after a trustworthy prior
  verification capability is introduced. The first implementation reverifies
  rather than adding a durable verification-cache format. `missing.is_empty()`
  alone must never become a verified-content result.
- Verification proofs are private typed capabilities bound to exact graph
  metadata and immutable sources; no persisted boolean substitutes for verification.
  Browser async reads may occur outside a final IndexedDB write transaction, but
  final commit rechecks exact planned metadata State and source existence/
  immutability/pins. Stale proof/input yields retry without advancing cursor or
  visibility. A metadata chunk record with missing backing bytes is corruption/
  I/O failure, not another missing download. Native may resolve synchronously
  within its bounded transaction or use the same checked plan.
- Existing expected-graph/entry preconditions remain explicit. Exact MetadataState
  equality initially replaces exact State equality, preserving revision, record
  commitments/events/pages and activities. This is not a weaker version-only
  check. Checking only file bytes or a selected hash cannot authorize another
  causal head or namespace revision. Every output read also verifies actual
  chunk bytes; a corrupted chunk cannot become valid because an old proof exists.

Chunk storage/quota and wire-byte limits remain distinct from causal metadata
limits. Keeping a 4,096-record limit that counts all retained chunk bodies can
still exhaust a modest vault. Count/limit retained causal events/pages explicitly
and account normalized bytes separately. Do not prune history/conflicts to make
this fit. Finite declared quotas are acceptable; memory must not grow with all
stored bytes. Exact metadata quotas are a root-reviewed policy, not a reason to
raise the current 128 MiB JSON-state constant.

## 4. Store, filesystem and client adaptation

Store: entries, baselines, projection targets/attempts, external observations,
namespace evidence, family operations and durable commands use content refs for
Binary. Normalize chunk bytes and authored/received payload access; outbox sealing
reads one bounded payload at a time. Do not load every retained chunk to rebuild
a graph or return every authored payload in one MutationPlan. Preserve the same
atomic receipts, authenticated ingress, exact duplicate handling and immutable
physical-publication witnesses. Small Text state uses its existing separate path.

Native: add descriptor-held incremental capture/staging and sink publication.
Retain before/after inode, parent, len/mtime/ctime and final pathname checks;
hashes are not filesystem authority. Stream target bytes into the existing private
stage, fsync it, and use the existing displaced/rename/directory-fsync journal.
Compare existing files through streaming hash/proof, retaining changed bytes in
staged observations. Old open-handle writes, previous inode, namespace handoff
and interrupted publication must retain their historical content refs. Do not
compare only with the latest desired remote content or assume equal hashes imply
equal causal/physical ownership.

External scanning: separate finite metadata coverage from resumable content
capture. A content work budget can pause a large file stage without turning an
unobserved path into absence. Final observation revalidates source/parent/root
proof before committing its content ref. Persistent directory progress beyond256
held directories stays with the native owner; this proposal does not relax its
absence/deletion proof or claim retries already solve that limit.

CLI: copy stdin/file into native stages with one chunk buffer; export/read writes
one pinned chunk to stdout/file. All explicit binary create/update commands and
external file imports use the same native authority. JSON status reports declared
file/storage/work limits and stream-required errors. No mandatory desktop process.

Desktop: stdio keeps its existing bounded frame sizes; add one-chunk stage/read
commands with per-client lease and generation reauthorization immediately before
transport dispatch. File command recovery checkpoints store target expectations
and stage/ref identity, not bytes/base64. Replace command planning's `readPath`
with metadata/identity lookup so even rename/trash/delete does not read a large
file into memory. Renderer File/Blob input uses stream/slices, one admitted chunk
at a time. A native resource URL/export capability may stream a pinned read ref;
it must not expose arbitrary filesystem paths or bypass the vault authority.

Browser: keep chunk rows/indexes separate in IndexedDB; use typed-array chunk
bindings and transferable buffers between renderer, worker and WASM. Replace
whole graph JSON, `Array.from(bytes)`, `getAll()` of content and aggregate
classification output. Read indexed pages/chunks through bounded cursor work.
Stages/proofs survive reload and preserve cross-tab client ownership. Existing
`readBinary(): Promise<Uint8Array>` remains an explicitly small-file convenience;
add an optional binary-stream capability to VaultAdapter and its Vault wrappers.
Attachment/PDF preview and import/export callers must choose a streamed resource
or an honest bounded-preview state, rather than allocate a large arrayBuffer.

## 5. Large UTF8/Text is separately constrained

Current Text replacement is effectively limited by `diff_edits` to8,192 Unicode
scalars for old/new whole text, visible state256 KiB, CRDT snapshot4 MiB and
per-envelope1 MiB plaintext. Browser JSON/reusable-state/materialization limits
are additional constraints. Auto selects Text for valid UTF8 without NUL except
known binary extensions, including large custom files and Markdown; streamed
Binary does not solve that path.

Practical separate sequence:

1. Within the current256 KiB visible limit, repair the8,192-scalar replacement
   failure: scan equal prefix/suffix on UTF8 boundaries while deriving UTF16
   positions, run Myers only on changed windows fitting the existing work budget,
   otherwise delete/insert the complete changed middle span on the same Yrs
   document. Equal large input returns no edits. Ordinary replacement retains
   exact revision CAS. External replacement diffs the persisted physical causal
   baseline with one fresh actor and merges into current state; it does not replace
   current state with observed disk bytes. Coarse middle replacement can produce
   less precise concurrent merges and needs explicit regression evidence.
2. Beyond256 KiB, propose a separately negotiated required Text framing version
   with authenticated fragments of **one logical encoded Yrs update**. Arbitrary
   byte slices are not independent valid v2 Yrs updates. A bounded batch commitment
   binds Text identity/actor/namespace, batch ID, indexed part IDs/count, total
   encoded length and full update digest. Every part remains within the1 MiB
   envelope after encoding. Parts alone cannot create Text activity or authorize
   a partial publication. Final validation requires all parts, the valid assembled
   update and satisfied dependencies; the existing published Text remains until
   one atomic operation/state/activity/publication commit. One actor per batch,
   not per part. This wire change is proposed only for the Text followup; Binary
   keeps current v2 wire.
3. Candidate resident Text limits are16 MiB visible UTF8 and64 MiB encoded
   snapshot, subject to measured acceptance and separate update/history quotas.
   Export a typed TextLimits object rather than scattered constants. Store Text
   snapshots as bounded binary BLOBs; WASM uses opaque state/plan handles or binary
   snapshot arguments/results. Do not raise JSON8/32/64 MiB budgets to carry them.
   Keep bounds on CRDT actor/edit count, diff work and total concurrent materialized
   output. Reserve aggregate output **before** materializing text (current
   materialization text path allocates first), and avoid repeated whole-text
   preview copies/shifts in `zorid-crdt::edit`.

This is bounded resident Yrs/editor work, not O(chunk) Text memory. Its source
scope is client-sync lib/v2, crdt edit, file-sync mutation/materialization,
store family_commands/family_observations/text persistence and WASM sync/family/
classification. Root names a separate implementation owner and reviews the
required Text feature before that work. Binary streaming must not claim it.

Until that followup is implemented, Auto must report a retained unsupported Text
import with exact disk bytes, not silently create Binary, truncate content or
claim import complete. Explicit `--binary` may choose Binary when creating a new
identity if the user requests it; it never changes an existing Text binding.
Large Markdown editor rendering and CRDT-memory verification remain explicit
acceptance work rather than an implication of binary streaming.

## 6. Acceptance and next review gate

One coherent implementation gate, with local heavy jobs serialized:

1. Portable/store: exact64 MiB random/custom binary via stage/read and inline
   wrapper; >16 MiB creates/updates; interruption at append/seal/authorization/
   receipt boundaries reuses the same IDs; stale revision or same-bytes/different
   content-event rejects without overwriting; no visibility before final commit.
2. Integrity: missing/reordered/corrupt chunks and a wrong whole-manifest digest
   never publish or advance the enabling cursor; duplicates retain exact-wire
   semantics; hidden/history complete manifests receive the same verification.
   Quota exhaustion/cancel/unknown outcome retain staged and prior content.
3. Native/CLI: bounded RSS as file length grows; old/new bytes survive crashes at
   stage/fsync/displace/rename/baseline phases; external edit/move/delete,
   old-open-handle edits and independent desktop/CLI access preserve witnesses.
4. Desktop/browser: real >16 MiB import/export/offline relay transfer/restart,
   browser reopen/cross-tab, per-window leases and failed close/switch; many
   independent files exceed earlier graph JSON byte limits without all-content
   allocation. No preview silently calls whole-file read for a streamed file.
5. Text follows its separate declared budget/batch tests, including large UTF8
   Auto behavior, unchanged Text identity and non-ASCII edits/IME/undo semantics.

Next: root review of sections1–3, assignment of the store/desktop/browser API
owners, and explicit agreement on local state-version replacement and quotas.
Only then implement the narrow portable types/builder/verifier and adapt one
native/store path. No broad file edits or native builds have started.

## Implementation checkpoint — portable foundation

Root approved the narrow contract; committed `7edbb72` in this worktree. Named
STORE owner is `/root/package_sol`; browser/WASM owner
`/root/default_lifecycle_review_sol`; desktop consumer owner
`/root/recovery_ui_sol`; native ownership remains `/root/external_reconcile_sol`.
Exact GraphRecord/builder/restoration signatures were sent to those owners before
their coupled changes. No store/native/desktop/browser files were edited here.

Implemented additive modules `metadata.rs` and `binary_stream.rs`:

- Checked exact-plaintext GraphRecord descriptors and immutable ledger-bound
  restoration; explicit local metadata format1. Descriptor JSON has a separately
  checked1 MiB+4 KiB wrapper bound; payload/wire bounds stay1 MiB. No public
  Deserialize for MetadataState, GraphRecord or verification/content capabilities.
- MetadataState role/causality validation, unverified MetadataView and retained
  BinaryContentRef. Shared validation extracted from v2 without changing its
  public APIs; legacy v2 retains original encoded-state limits and byte/hash path.
- Incremental manifest builder emits one exact current-v2 payload at a time.
  Its BuiltManifest is explicitly not proof of durable stored bytes.
- ManifestVerificationSession and AllBinaryVerificationSession support async
  IndexedDB hosts through exact per-chunk requests/provide/finish. Synchronous
  helpers drive the same code. Private VerifiedManifest/VerifiedBinarySet bind
  exact metadata and whole hashes, including all complete hidden/history heads.
- Stream output pre-verifies then rechecks actual source chunks while writing
  only a private sink; corruption prevents sink.finish. No large-file consumer
  or filesystem publication is implied by these portable helpers.

Independent `chunk_metadata_contract` source review approved the foundation and
its descriptor-wrapper boundary fix. Root granted one exclusive heavy slot.
Verification at exact `7edbb72` (base890a9d4), process handle47442, exit0:

```sh
CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR=/Users/ctk/orca/workspaces/Zorid/core-default-integration/target cargo test -p zorid-file-sync --lib -- --test-threads=1
```

73/73 tests pass:9 new integrity cases plus64 existing file-sync tests. The new
cases cover exact raw commitments and near-limit descriptor restoration, bounded
builder retry, synchronous/resumable agreement, changed metadata, wrong whole
hash, incomplete dependencies versus damaged backing storage, corrupt dominated
history, changed source during output, and empty content. Compilation20.89s,
tests3.18s. Heavy slot released to root. No >16 MiB actual client/RSS/native/CLI/
WASM or relay streaming proof is claimed. Existing chunk/record/work quotas remain
conservative and activation still requires root quota review.

Next joint API proposal (sent STORE/browser/root, not implemented): private
MetadataCandidate from authored/received/Text-activity metadata planners;
verification_state() feeds the shared all-history driver; finalize requires its
private VerifiedBinarySet, yielding a MetadataPlan with exact metadata and prior
wire preconditions. Add manifest-backed binary final-event mapping and reference
classification before any active store switches from legacy State. No hidden
all-blob rehydration fallback is acceptable.

Separate root-approved Text work is source commit`25f6745` in
`text-bounded-diff`: only bounded prefix/suffix/window diff and coarse fallback
under current256 KiB/4 MiB limits. Independent source review approved its edit-
count fallback. Its runtime gate is root-owned and is not included in73/73 above.
No larger Text cap or new Text wire framing is implemented by this checkpoint.


### Metadata candidate phase — source freeze

Root approved the additive metadata planner/ref-classifier/final-event phase.
`metadata_plan.rs` now implements a bounded exact-emission descriptor collector,
combined authored namespace/Text-activity batches, authenticated received overlays,
and opaque candidate→all-history proof→finalized plan. Authored new causal or
binary-content dependencies must resolve; received dependencies may stay Pending.
Exact duplicate collector pushes are idempotent; IDs already in the expected
state are rejected for new authorship. Received replay compares exact prior wire
and exact accepted-plaintext descriptor, including changed-nonce rejection.
Finalized plans retain full expected metadata and prior-wire preconditions; hosts
still own immutable source-row pins, separate Text state, receipts/cursors and the
atomic transaction. No payload byte collection is retained by the batch.

Independent `chunk_metadata_contract` source review approved the module and the
narrow authored missing-content correction. Six new focused tests are written;
they have NOT run. The legacy APIs are unchanged. Reference classification is
separately owned in two new files and remains unexported until its Text temporary
buffer handling is finalized. Root explicitly accepts one existing bounded
256 KiB Text materialization temporary for this phase, followed by retained-output
budget checks; this is not allocation-free preflight or permission to enlarge Text.

User adopted protobuf discussion direction after this phase began. A separate
schema owner owns new versioned codec work. This planner remains codec-independent
at its public boundary; current files-v2 wire encoding is unchanged, and no
protobuf payload may be substituted under that existing format version.


Reference classification is now source-reviewed and exported in
`reference_materialization.rs`, with12 focused source fixtures. Exact metadata
and all-history VerifiedBinarySet are checked before classification; every Normal
binary result retains selected-event/manifest identity and returns BinaryContentRef.
Equal bytes do not merge causal witnesses. Pending/missing/hidden/tombstone and
Text identity behavior follows the existing classifier. Normal Text results use
one existing fully validating client-sync materialization temporary, then enforce
file and aggregate retained-output budgets. This explicitly does not claim a
preallocation or total CRDT decoder memory bound. These12 tests remain unrun;
there is still no activated store/client streaming consumer.


### Candidate/classifier verification

At clean frozen `67493c4` (candidate source `c319e8d`), root granted the next
exclusive heavy slot after Store lib29/29 and family3/3 completed. Process96342
exited0 with91/91 file-sync lib tests, including6 candidate and12 reference
classification cases. Exact command is the same single-job/single-test-thread
file-sync command above; compile4.45s, tests3.19s. Formatting and diff checks also
pass. No source edits occurred during this gate. Shared target slot released.

This verifies the additive portable semantics, not active large-file clients,
store publication or protobuf transport. The next approved source-only mapper
retains BinaryTarget Create{id,path}/Write{id,expected_revision,
expected_content_event}, exact expected metadata entries, stable staged IDs and
one final bounded event emission. Store independently accepted its signature.
A separately assigned metadata-only core helper is required before activation
can atomically return Create/Write EntryChanges with correct ancestor revisions;
fabricating an empty-content legacy request or receipt is prohibited.


### Binary event mapper — source freeze

`binary_mutation.rs` implements the jointly agreed mapper-only foundation. It
checks original BinaryTarget Write revision and selected content event, exact
current live-entry graph kinds/paths, historical Create identity reuse and logical
destination occupancy even if binary bytes have not been materialized. The stage
must contain exactly the Manifest's new chunk/page closure, with no unrelated
records, activities or repeated IDs. Every observed retained/missing reference
reserves its ID against stage/final-event allocation. One existing bounded v2
AuthoredRecord is emitted for the final event; all other payloads remain immutable
stage source references. The result retains exact expected entries/metadata and
requires normal private candidate finalization. It does not author core metadata
EntryChanges, an operation receipt, filesystem authority or a protobuf encoding.

Independent `chunk_metadata_contract` source review approved these checks and the
behavior-equivalent private AuthoredRecord constructor extraction. Six focused
mapper regressions are written but unrun. Store activation dependencies remain:
operation-bound stage lookup, immutable source pins, historical revision/ID
allocation fences, a metadata-only core helper with ancestor revisions, and one
atomic metadata/graph/outbox/receipt transaction. No active client path changed.
