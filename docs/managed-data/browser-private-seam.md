# Private managed-record admission and browser binding seam

Status: A/B private seam agreed after B corrections (`msg_4cf5a7fc5f5a`).
Root source grant relayed by coordinator `msg_757109117acd` supersedes the initial
document-only scope. Implementation and focused native checks are now recorded
below; assembled browser runtime acceptance remains outstanding.
Owner A: `managed_records_wasm`, terminal
`term_d0800995-a776-4b09-b678-1d05fbb20009`, task `task_1c407e73c6d1`,
dispatch `ctx_a38e351b645a`; branch `tingkai-c/managed-records-wasm`.
Inspected base: `61e04f92ad20f7e0da120209599561fd8ee02aa4`.
Initial scope authorized only this NEW document. At contract freeze no source
changes, compiler, tests, lock edits or integration have been performed; the
subsequent source grant covers only the table below.

Authority: accepted foundation `browser-adapter-seams.md` at `df764648`, native
`2276582d7ae1074a77dfb3b1badc741d05aae8c0`, integrated main `f26eb0b5`.
The execution checkpoint and current native source were read. This document
narrows the map to an internal storage slice, not a public API or host grant.
Native's recorded 53 checks are prior evidence, not verification of extraction.

## Portable extraction: minimum responsibility and exact types

NEW `crates/zorid-records/src/admission.rs`, registered by one module declaration
in `src/lib.rs`. The names below are frozen consumer names after acknowledgement;
Rust visibility is public only as needed between internal crates, with no public
product/API compatibility promise. Reuse `Id`, `Scope`, `Schema`, `Policy`,
`State`, `Operation`, `Command`, and `wire::Payload` unchanged.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Accepted, WaitingDependencies, WaitingRestoreSource, MissingRegistration,
    IncompatibleSchema, PolicyMismatch, InvalidOperation, Capacity,
    IntegrityConflict,
}
impl Status {
    pub fn as_str(self) -> &'static str;
    pub fn retry_eligible(self) -> bool;
}
pub struct Registration { pub realm: Id, pub vault: Id, pub owner: Id, pub schema: Schema }
pub struct StateUsage { pub count: u64, pub used_bytes: u64, pub replaced_bytes: u64 }
pub struct Accepted { pub state: State, pub state_bytes: Vec<u8>, pub projection_bytes: Vec<u8> }
pub enum Admission { Retained(Status), Accepted(Accepted) }

pub fn check_scope(registration: &Registration, scope: &Scope) -> Result<()>;
pub fn received_gate(payload: &Payload, registration: Option<&Registration>,
                     conflicting_content: bool) -> Option<Status>;
pub fn restore_accepted(registration: &Registration, scope: &Scope,
                        bytes: Option<&[u8]>) -> Result<State>;
pub fn restore_ready(scope: &Scope, prior: Option<&State>) -> Result<bool>;
pub fn admit_received(state: State, payload: &Payload, restore_ready: bool)
                      -> Result<Admission>;
pub fn canonical_operation(operation: &Operation) -> Result<Vec<u8>>;
pub fn projection_bytes(state: &State) -> Result<Vec<u8>>;
pub fn state_fits(usage: StateUsage, state_len: usize, projection_len: usize) -> bool;
pub fn registration_change(old: &Registration, next: &Registration) -> Result<bool>;
pub fn local_request(scope: &Scope, expected_digest: &[u8; 32],
                     command: &Command) -> Result<Vec<u8>>;
```

`Registration` has the exact existing native field order/serde representation,
`deny_unknown_fields`, and no revision or authority. Native public
`ManagedRegistration` stays unchanged and is borrowed/converted at calls; do not
replace or alias the existing public type. `registration_change` returns false
for canonical equality; otherwise checks unchanged policy, strictly increasing
version and exact preservation of every old field. The caller still iterates
and restores EVERY accepted state using the new schema before replacement.

`received_gate` is deliberately NOT a complete classifier. It preserves order:
conflicting canonical content, missing registration, non-Synced policy, then
any nonexact operation schema version. Only after this gate may adapters load
accepted state. Existing accepted state with another complete immutable scope
is `integrity_conflict`; malformed accepted state or an incomplete accepted
projection remains an error, never a domain status. Native retains this scope
comparison before its existing `load` validation. `restore_accepted` preserves
`load` semantics, including key/complete-scope and pending-empty checks. Errors
must remain distinguishable by adapter context as corruption versus invalid
input; no SQL/IO error enters `Admission`.

After accepted-state checks, load the exact same-record prior generation only
if `restores` is present. `restore_ready` checks realm/vault/owner/collection/
record/generation, pending-empty and created+deleted. Missing or not-yet-deleted
prior returns false; mismatched identity/incomplete accepted evidence errors.
Native's existing restoration decode/error mapping is preserved.
`admit_received` checks restore readiness BEFORE union; maps union `Limit` to
capacity, other union errors to invalid_operation; successful union with pending
to waiting_dependencies; then serializes the same native projection. A candidate Accepted result is
converted to retained capacity if the subsequent `state_fits` check fails; only
after that check are its bytes publishable.
The complete immutable batch is unioned once, never operation by operation.

Read ordering matters: adapters must not eagerly read/decode later facts before
an earlier status is resolved. In native, retain the current quota SQL position
after union/pending; call `admit_received` before that query and `state_fits`
after it. Do not change observable errors or queries. Browser may prepare
outside IDB but must compare fresh facts at CAS.

Canonical operation comparison is equality of full `canonical_operation` bytes,
scoped by collection + record + generation + operation ID. Storage owners retain
all source bindings and query accepted AND waiting commitments. No new generic
commitment framework or SQL read abstraction. Retry excludes exactly accepted,
integrity_conflict and invalid_operation; native SQL iteration/continuation and
quarantine SQL stay untouched. `Status` decoding rejects unknown values.

`projection_bytes` preserves native's `created/deleted/fields/sets` object,
ordered candidates with `operation/cell`, and serde_json canonical byte output.
`local_request` encodes precisely `(scope, expected digest, command)`; digest is
serialized as the existing 32-byte array, NOT hex. Native and WASM hash complete
canonical state bytes with existing `zorid_file_sync::Sha256Digest::of`; no new
hash dependency in records. Local replay remains exact request-byte equality,
returning original result BEFORE checking current state revision/restore/source
history. No shared replay API is needed for this equality comparison.

Use portable constants for the existing domain predicates only: records1024,
state+projection32MiB, per-state/projection1MiB; receipt/local replay4096 and
16MiB independently, operation commitments16MiB, registration128/1MiB,
changes65536, query64/4MiB, retry16/1MiB. Constants may be named in admission;
SQL declarations and runtime reads stay native. Check arithmetic for overflow;
valid native SQL facts yield exactly the old predicates. Database-wide scope,
replacement subtraction and local replay's reserved4096 result bytes remain.
No new binding-count/ciphertext quota or cap relaxation is implied.

## Exact private WASM surface for B

NEW `crates/zorid-wasm/src/records.rs`. No constructors for authenticated incoming
objects; only existing `WasmSyncUpdate` from real AEAD open can prepare receive.
Binding names use the following JS spelling. `Uint8Array` always denotes raw
UTF-8 JSON bytes for canonical domain documents, not parsed JS domain values.

```ts
type RecordsStatus = 'accepted'|'waiting_dependencies'|'waiting_restore_source'|
  'missing_registration'|'incompatible_schema'|'policy_mismatch'|
  'invalid_operation'|'capacity'|'integrity_conflict';
interface RecordsPlan {
  checkPreconditions(actualFactsJson: string): void; // synchronous, throws stale
  resultJson(): string;                           // bounded metadata only
  payloadMetadataJson(): string | undefined;      // exact common local metadata
  nextState(): Uint8Array | undefined;
  projection(): Uint8Array | undefined;
  payload(): Uint8Array | undefined;             // exact wrapped authored bytes
  localRequest(): Uint8Array | undefined;
  operationBindings(): Uint8Array;               // Rust canonical binding rows
  free(): void;
}
// Exported internal Rust binding functions; B wraps with closure-private authority.
validateRecordsRegistration(next: Uint8Array, old: Uint8Array | undefined): void;
validateRecordsAccepted(registration: Uint8Array, state: Uint8Array): void;
recordsSnapshot(registration: Uint8Array, scopeJson: string,
                state: Uint8Array | undefined): RecordsPlan;
canonicalRecordsLocalRequest(registration: Uint8Array, scopeJson: string,
  operation: string, expectedRevision: Uint8Array, command: Uint8Array): Uint8Array;
finalizeRecordsLocalResult(operation: string, revision: Uint8Array,
                          sequence: string): Uint8Array;
recordsLocalReadSet(scopeJson: string, operation: string): string;
recordsRetryEligible(status: string): boolean;
validateRecordsStoredOperation(scopeJson: string, operation: string,
  update: string, canonicalContent: Uint8Array): void;
validateRecordsStoredReplay(collectionScopeJson: string, operation: string,
  request: Uint8Array, result: Uint8Array): void;
prepareRecordsLocal(factsJson: string, command: Uint8Array): RecordsPlan;
// Member of existing authenticated WasmSyncUpdate:
recordsReadSetJson(): string; // {scope,operations:string[]}, no values decoded in JS
prepareRecords(factsJson: string): RecordsPlan;
```

There is no `install`, durable-success method, JS-supplied auth boolean or
constructor for RecordsPlan. WASM may clone immutable private capabilities into
plans; B frees update/plan after completion, abort or replacement and never
serializes/reconstitutes a plan. Snapshot uses the plan read methods without
publishing or claiming a commit. B's private collection token binds DB authority,
trusted registration revision and scope; WASM validates data, not that authority.
Local/Cache plans never emit sync payload for enqueueing; operationBindings still
exists for local/cache durable commitment evidence. Local request and exact
replay result are returned without reconstructing native canonical JSON in JS.

`recordsReadSetJson` derives scope and operation IDs from the private
canonical/authenticated payload. `recordsLocalReadSet` returns `{scope,operations}`
with the new operation ID; existing accepted history remains opaque, with the
new ID lookup sufficient for local source-collision checks. Scope determines
same-record restore-generation lookup. `operationBindings` encodes exactly an
array `{operation:string,update:string,content:string}`, with opaque canonical
operation JSON in content. Local update equals operation ID, matching native.

After trusted registration authorization, canonicalRecordsLocalRequest checks
scope, validates operation ID and command, then returns exact native tuple bytes.
B compares a retained request and returns its original result BEFORE loading
accepted/restore/usage or checking stale revision. finalizeRecordsLocalResult
validates32-byte digest and canonical signed-i64 sequence then serializes exactly
native `{operation,revision,sequence}`; sequence remains text. These functions
confer no authority or durable-success proof.

`factsJson` is a strict bounded private DTO, with precisely these fields:

```ts
interface RecordsFacts {
  registration: string | null;     // raw canonical registration JSON text
  registration_revision: string | null;
  scope: { realm:string; vault:string; owner:string; collection:string;
           record:string; generation:string; restores:string|null };
  accepted: string | null;         // raw canonical state JSON text
  restore_source: string | null;   // raw canonical prior-generation state text
  operation_sources: Array<{ operation:string; update:string; content:string }>;
  local: null | { operation:string; expected_revision:number[];
                  prior_request:string|null; prior_result:string|null };
  usage: { records:string; state_bytes:string; replaced_bytes:string;
           receipts:string; receipt_bytes:string; operation_bytes:string;
           local_operations:string; local_bytes:string; changes:string };
  receipt: null | { status:RecordsStatus; revision:string };
  cursor: null | { epoch:string; position:string };
}
```

All fields required; deny unknown fields. Raw nested JSON **strings** are opaque
canonical byte documents decoded only in Rust; JSON.stringify of their string
container cannot round an embedded i64. `expected_revision` is exactly32 bytes,
validated integer0..255, never a JSON numeric i64. Null means absent evidence,
not an empty state. `local` is null on receive; payload's authenticated scope is
checked against scope. Source array is bounded by selected operation/history and
retention limits; every matching waiting commitment must be included. Source
row order is stable `(operation,update)` and exact canonical content is compared.
B must not pass a truncated commitment set as complete. Update IDs remain the
existing envelope-safe identifiers; owner/field/record IDs keep engine Id rules.

`resultJson` fields are exactly
`{status, revision, replay_result, payload_bytes, conflicting_updates}`:
status is the enum, revision null or32-byte digest array, replay_result null or
opaque canonical result JSON text, payload_bytes null or bounded u32. A replay
has original result text and no new state/payload writes; B returns its original
sequence/revision and no duplicate change. This is private prepared metadata,
not a durable result or a reason to skip receipt/outbox/cursor verification.
`conflicting_updates` is the sorted update-ID set across every binding of each
conflicting operation. Quarantine prior receipts except accepted/integrity_conflict;
invalid_operation CAN become integrity_conflict. This differs from retry eligibility.
Cursor epoch uses existing protocol ServerEpoch (opaque SourceKey), never numeric;
only cursor position is canonical decimal-u64. Receipt revision is opaque.

`checkPreconditions` compares the complete normalized facts used by preparation,
including exact state/registration/commitment/request/result/restore bytes and
usage/receipt/cursor. Facts are not authentication: B must independently reread
owner/session/local-store-id, enrolled configuration, exact common source wire,
ledger evidence, all relevant commitments and common counters in the SAME strict
readwrite transaction. Missing/extra source bindings or changed facts are stale,
abort and reprepare; no partial writes. B maintains exact local/received replay,
source accounting and cursor semantics from the accepted adapter map.

Counters cross JS as canonical nonnegative decimal strings; records sequence
ceiling is signed-i64, shared transport counters remain existing u64. Rust
canonical command bytes are strict typed round-trip checked; never produce
`Integer(i64)` commands by JSON.stringify of a JS number. Projection, state,
request/result and operation content stay raw bytes/text throughout persistence.
Consumers display integers through a separate lossless decoder or decimal text;
JSON.parse plus Number is not the projection contract.

## Family descriptor and existing-hunk request

Records common metadata has family `records`, format_version1, exact payload
length/digest, common key, and `text_binding:null`. Text/files stay version2.
Streaming descriptor is the existing version1 object with metadata and
`record:null, activity:null, summary_digest:null`. Records does not add a new
`file_summary_digest` field to the browser descriptor; any existing native
metadata field of that name stays null. Authenticated descriptor output for
records is `{kind:"records",record:null,activity:null,summary_digest:null}`.
No GraphRecord/activity or fake file graph count is created.

Exact proposed source ownership for A after root grants it (line numbers are
anchors at inspected base; function names govern rebasing):

| Existing file / anchor | Only requested hunks |
| --- | --- |
| `zorid-records/src/lib.rs` module area | Declare admission module only; existing engine/wire unchanged. |
| `zorid-store/src/managed_records.rs` imports/constants,187 check_scope,199 load,234 projection | Delegate pure checks/restore/projection; keep public structs and native error classification. Share existing numeric predicates/constants where used. |
| Same,298 write_state,318 check_restore | Delegate serialization/quota predicate and prior-state identity/readiness; preserve all SQL, query positions and writes. |
| Same,376 managed_register | Replace only policy/equality/additive predicate; native accepted-state loop, revisions, auth, retry and commit untouched. |
| Same,488 managed_apply | Replace tuple request encoding only; keep replay-before-stale, hash type, source checks, SQL, reservation and commit exactly ordered. |
| Same,767 bind_sources,789 equivocated | Replace canonical operation encoding only; no query/insertion/quarantine rewrite. |
| Same,820 activate | Delegate staged gate/union/pending/serialization/quota decisions in original read/error order; keep writes and accepted publication adapter-owned. |
| Same,653 retry_in_transaction | No SQL/continuation rewrite; use Status conversion only if necessary, preserving three terminal exclusions exactly. |
| `zorid-wasm/Cargo.toml` dependencies | Add only `zorid-records = { path = "../zorid-records" }`; coordinator owns lock edge. |
| `zorid-wasm/src/lib.rs` module area | `mod records;` only; no unrelated exports. |
| `zorid-wasm/src/sync.rs`502 AuthenticatedFamily,512 open_update | Add private Records payload+exact bytes capability created from OpenedEnvelope; family/version match explicitly records1/text2/files2. |
| Same,558 metadata,584 matches_payload,666 StoredMetadata,674 stored_metadata,686 validate_payload | Records format/null-binding/structural-context arms, exact matching; preserve existing text/files behavior. prepareRecords member implemented in records.rs if privacy allows; otherwise narrowly in this impl. |
| `zorid-wasm/src/sync/streaming/plan.rs`638 exact_plaintext,645 authenticated_descriptor_json | Exact records bytes/descriptor arms; existing metadata-file/text guards remain fail-closed; no graph-planner edits. |

Prefixes in table are `crates/`. New source files would be admission.rs,
records.rs and focused new tests only. `sync.rs` private capability visibility
may require `pub(super)` on the enum/fields for the sibling module, with no JS
constructor. No crypto.rs change is requested. No Cargo.lock/root manifest,
protocol/relay/public client API/worker host/UI/generated binding/build edits.
B owns browser adapter/dispatcher hunks under separate root grant. Root alone
integrates; this dispatch was extended to source by the explicit grant. Latest
user resource correction
relayed in `msg_a4a5d1316485`: explicit build slots apply only to iOS; focused
Rust/browser checks are not permission gated, and actual heavy load remains
coordinated. Focused compiler/test evidence is recorded below.

## Acceptance and agreement record

Native differential fixtures must cover each ordered status, malformed accepted
and restore evidence errors, equivocation before registration, exact schema,
whole-batch cycles/remove-tag invalidity, pending-empty acceptance, restoration,
quota boundary/replacement, canonical projection i64 extremes, request/replay
identity and unchanged native transaction rollback/cursor behavior. Run existing
53 native checks after extraction with actual heavy-load coordination. Source similarity
or pure unit tests alone do not establish native parity.

Actual rebuilt WASM plus browser IDB tests must subsequently exercise the full
accepted map: authenticated receive, strict completion/abort, mixed-family cursor,
authored self echo versus received duplicate, exact local/cache replay, retry
count/bytes/continuation, conflicting waiting forks, lease loss/reacquisition,
reopen and i64/sequence bounds. Worker lifecycle and product UI are later gates.
No actual rebuilt-WASM/IDB runtime check was run by A; the coordinator owns the
combined build after A/B assembly.

Owner B acknowledged direction in `msg_4cf5a7fc5f5a`; A accepted and incorporated
the read-set, binding-row and early-request/final-result corrections. Coordinator
relayed root existing-source grant in `msg_757109117acd` and isolated lock-edge
permission in `msg_91ae23a60ede`. The frozen commit and SHA are reported through
Orca; source implementation follows as a separate coherent commit.


### Implementation checkpoint

Source now implements the private seam and native pure delegation. The shared
projection has a `projection_value` helper so native callers never add a JSON
parse/reserialize step; `projection_bytes` serializes that same Value directly.
Read/error order and all native SQL/transactions/auth/replay checks stay native.
B additions `payloadMetadataJson`, `recordsRetryEligible`, and complete conflicting
update IDs were accepted through Orca after the initial contract commit.

Concrete baseline numeric defect: new
`authored_numeric_counterexamples_restore_and_wrap_exactly` failed with Codec on
State::restore for authored Number(51.248178375505404), due to default JSON float
parse drift. Coordinator/root explicitly extended ownership in `msg_6f435226da91`
and `msg_c58acfe16c19` to the records Cargo.toml serde_json `float_roundtrip` hunk
if reproduced. That exact feature is enabled, preserving canonical byte equality
and dependency versions. Cargo feature unification also improves parsing in
other serde_json consumers linked into the same process; this is a deliberate
observed codec fix beyond extraction parity, not a wire-format redesign. Direct
Value projection sharing remains necessary independently of that feature.

Final affected evidence so far (bounded `-j1`, tests serialized):

| Check | Observed result |
| --- | --- |
| records admission | 6 passed, including authored float restore/wrap and i64 tuple/projection |
| records wire | 13 passed, canonical rejection unchanged |
| Store managed records | 24 passed after projection/codec fix |
| Store family | 3 passed after feature unification |
| Store numeric persisted/reopen regression | 1 passed: counterexample f64 + object float + i64 extrema |
| Store common family ledger / immutable payloads | 7 + 6 passed, including exact wire/cursor rollback and file/text source validation |
| WASM crate native unit tests | 63 passed, including 12 new private-record traces and existing text/file bindings |

This is native-library and native-target WASM-binding evidence. It does not
establish actual wasm32 artifact, browser IDB durability, mixed-family browser
transport, worker lifecycle, desktop/mobile or UI acceptance. The coordinator
will build the combined frozen source using the existing shared wasm32 toolchain.

The isolated Cargo.lock change is exactly the `zorid-records` edge in
`zorid-wasm` dependencies, under coordinator `msg_91ae23a60ede`; no other lock
entry or root manifest changed. Final narrow commands (all passed):

```sh
cargo test -p zorid-records --test admission --test wire -j1
cargo test -p zorid-store --test managed_records --test managed_admission_parity --test family -j1 -- --test-threads=1
cargo test -p zorid-store --lib family_ledger::tests -j1 -- --test-threads=1
cargo test -p zorid-store --lib immutable_payloads::tests -j1 -- --test-threads=1
cargo test -p zorid-wasm --lib -j1 -- --test-threads=1
```

Build output has pre-existing Store dead-code/import and Bases unreachable/dead
code warnings; the new admission/records modules introduce no compiler warning.

Stored-row validation was added under `msg_16582c339d8b` /
`msg_a17338ea9151`. It checks canonical typed operation/static wire shape and
canonical native request/result tuples before startup or exact replay returns.
Replay collection input is `{realmId,vaultId,owner,collection}`; result requires
matching operation ID,32-byte digest and positive signed-i64 decimal sequence.
It never decodes domain values in JS or invents an authenticated capability.

Stored source operation identity compares exactly six row-key IDs, excluding
restores; the complete operation's own scope including restores independently
passes shared structural wire admission. This preserves native retained evidence
for conflicting restore links under one generation key. Root/coordinator agreed
in `msg_4f1d0a188c74`; regression checks both valid conflicting links, illegal
self-restore and wrong key. No source commitment equality is weakened.

Final source hashes (SHA256; source code, excluding this report):

- `crates/zorid-records/Cargo.toml`: `3a6d429a5d36d47d25ff21b3a0e802e7df5face69637a2a7ae9bd474e1455e92`
- `crates/zorid-records/src/admission.rs`: `36bb97fc5e1ffe2ddea8d90690d3466dc2fd5b4db01efc7b334498691ea5254f`
- `crates/zorid-store/src/managed_records.rs`: `91d93ed5e590fd554b0aa1c523160995b3c3b32339003d92c792e996623d52e2`
- `crates/zorid-wasm/src/records.rs`: `4afcf4a35b21f412a1f5a03a10a8ebf0c610cf5843a570f9f49c41d3fa6b5ed6`
- `crates/zorid-wasm/src/records_tests.rs`: `b5128649de9be5fcfe15d8b84b671ff74c22cdd3950cacfe5d1657a86ffbec19`
- `crates/zorid-wasm/src/sync.rs`: `4d1d36dc1def753666d867de86bd5f7af85772115fa0e416cdd5dc75889b2a1d`
- `crates/zorid-wasm/src/sync/streaming/plan.rs`: `501d9f8b2d529a14ed465f7eba6ec245009f558197c92ec095f295f5b78bdbd4`
