# Origin Store adapter inventory and execution checkpoint

Owner: `term_86d19693-a193-4149-bf35-439dccb61a49`, task
`task_b677f7629e9b`, dispatch `ctx_3bbc4d448052`; isolated branch/worktree
`managed-origin-store-adapter`. Main integrator is root only. Initial checkout
`a4ee37ea`; portable foundation inspected read-only at `8133fd2c` and current
main. Coordinator grant `msg1fca3cd1ba0d` authorizes the coordinated direction;
this checkpoint owns **only this new document** until explicit source grant.
Independent reviewer: `term_14a30a1f-d756-4393-bfcf-5ad804e31ed2`, task
`task_8241d6d5ec1d`, dispatch `ctx_4ef93249788f` (handles as supplied by coordinator).

Authority: canonical origin-intent-decision.md and origin-intent-contract.md,
portable local_intent.rs/workblock_service.rs at 8133fd2c. AGENTS, roadmap execution
checkpoint, findings, Store managed transaction/checkpoint code, native client
claim and current native WorkBlock caller were read. Calendar receipt summary
must remain intact. Existing public v1 adapters remain available in this staged
slice; it does **not** establish old-apply bypass closure or product cutover.

## Exact requested source ownership

| File | Proposed bounded changes |
| --- | --- |
| `crates/zorid-store/src/managed_records.rs` | Import portable local_intent/workblock_service; add types/methods below; factor existing managed_apply transaction body into an internal caller-owned transaction engine accepting the exact journal request; preserve original managed_apply request format/behavior. Add only origin-specific registration validation, checkpoint evidence, capture/recovery/accounting/settlement helpers. No changes to receipt summary, ingress, registration SQL/schema, sync wire or file operations. |
| `crates/zorid-store/src/checkpoints.rs` | Factor existing load/CAS mechanics into crate-private caller-transaction helpers; expose expected predecessor for exact retirement retry. Separate physical scope validation from ordinary-client denial. Every generic load/CAS/list/changes rejects reserved UUID via the portable guard, including empty pages and cursor paths. Preserve FULL, high-water/contiguous sequence, canonical revision, UTF8/body-size, latest-head and exact retry invariants. No new transaction inside internal helpers. |
| `crates/zorid-store/src/lib.rs` | Only reexports of new managed types (and portable ManagedIntentRef alias); no StoreError/schema/build/module restructuring. |
| `crates/zorid-store/tests/managed_intents.rs` (new) | Real SQLite public adapter capture/apply/reopen/retirement/bounds tests; fixtures use existing enrollment setup. |
| `crates/zorid-store/tests/checkpoints.rs` | Reserved generic load/CAS/list/changes rejection regression; ordinary existing checkpoint behavior preserved. |
| inline `managed_records.rs` test module | Only if needed for held-transaction race injection and test-only trusted v2 declaration; no exported production test catalog. See unresolved test-catalog dependency below. |

No client/admission/native/WASM/browser/UI file is requested by this inventory.
Native ordinary claim denial belongs to its separately named admission owner;
Store has no ordinary lease-claim entry point. End-to-end reserved admission is
a dependency, not an assertion this Store patch alone establishes it.
No Cargo, dependency/lockfile, table/column/schema/index/version or wire change.
Rebase/merge this isolated branch to the coordinator's chosen canonical source
before implementation; do not mutate another checkout or main.

## Proposed exact Store-facing types and APIs

These are private first-party host building blocks, not renderer/plugin APIs.
Methods use existing `zorid_store::Result` and stable intent error code strings
through existing contract-invalid reasons; no new StoreError variant is proposed.

```rust
pub use zorid_records::local_intent::ManagedIntentRef;
pub struct ManagedIntentInput {
    pub target: ManagedTarget,
    pub operation: Id,
    pub expected: ManagedRevision,
    pub command: Command,
    pub semantic_request: Option<Vec<u8>>,
}
pub enum ManagedIntentDisposition {
    AcknowledgedCommitted { original_receipt: ManagedCommit },
    ReconciledUncommitted,
}
pub enum ManagedIntentSettlement {
    Retired { retirement_revision: String },
    Committed { original_receipt: ManagedCommit },
}
pub struct ManagedPendingIntent {
    pub reference: ManagedIntentRef,
    pub request: Vec<u8>, // complete canonical bytes for private recovery
}
pub struct ManagedIntentPage {
    pub intents: Vec<ManagedPendingIntent>,
    pub next: Option<String>, // lexical fixed checkpoint key, not caller SQL
}
impl Store {
    pub fn managed_capture_intent(&mut self, handle: &ManagedCollection,
        input: ManagedIntentInput) -> Result<ManagedIntentRef>;
    pub fn managed_apply_intent(&mut self, handle: &ManagedCollection,
        intent: &ManagedIntentRef) -> Result<ManagedCommit>;
    pub fn managed_pending_intents(&self, handle: &ManagedCollection,
        after: Option<&str>, limit: u32) -> Result<ManagedIntentPage>;
    pub fn managed_settle_intent(&mut self, handle: &ManagedCollection,
        intent: &ManagedIntentRef, expected_pending_revision: &str,
        disposition: ManagedIntentDisposition) -> Result<ManagedIntentSettlement>;
}
```

Store methods enforce current Store/process/registration/enrollment authority.
They do not manufacture a lease proof: NativeVault's existing admitted wrapper
must validate current session/lease before invoking these later. Ref operation
plus collection identity determines the portable fixed checkpoint key (record
and generation are deliberately absent from that key); recover scope from the
retained canonical body/journal and validate it fully against the current handle.
An intermediate scope decoded from bytes confers no authority before full portable
validation. Ref alone never supplies arbitrary retained bytes or origin.

Origin capture currently accepts only the compiled first-party WorkBlocks v1
registration, comparing its exact schema/owner/realm/vault to the authorized
Store registration; arbitrary generic schemas remain on current v1 APIs. Optional
semantic bytes must be canonical Rust WorkBlock DTO bytes and pass portable raw
command/witness binding checks. Raw callers supply original raw command once.
For semantic remove-ref, the later service owner must first recover an existing
capture/journal before calling command_for_new against current state. No Store
call here recomputes retained observed tags. A semantic convenience capture API
is not silently invented by this inventory; see clarification request below.

## Transaction and persistence algorithm

All mutations use SQLite IMMEDIATE plus FULL and complete their transaction before
returning success. Internal checkpoint helper accepts `&Connection` belonging to
the caller's transaction and never commits. No durable stage spans network waits.
The reserved client is `f7bca1bf-2a2c-438e-b430-b3f05e5d9324`.
Checkpoint key comes only from `intent_checkpoint_key`; canonical full UTF8 intent
JSON is stored directly as encoded_state (no base64/JSON wrapper overhead).

Capture authorizes first, resolves existing journal and checkpoint key before
new preparation, validates canonical original evidence and compares original
scope/operation/witness/raw/semantic inputs using require_matching_input. A valid
existing journal recovers its original capture association; a matching live head
returns the same ref. An old tuple journal explicitly rejects; no permissive
fallback. Retired no-row key rejects reconciliation-required; identity is never
reissued. With neither present, host generates capture UUID, captures canonical
full original registration/authority/scope/op/witness/raw/semantic bytes through
portable helpers without State::prepare, checks budgets and writes one immutable
checkpoint capture revision. Its durable ACK precedes any mutating apply dispatch.

Apply authorizes, reads reserved live head and journal in the same IMMEDIATE
transaction, validates complete original evidence/current compiled lineage and
compares full journal request. Exact committed replay returns the original
receipt before state/default/revision/quota preparation, even after upgrade or
acknowledged retirement. Missing journal requires a live nondeleted exact capture
head and require_fresh_origin BEFORE state load/default preparation. Then existing
managed apply validation/publication writes state/source/change/authored/journal
atomically, with the new full canonical request in the journal and unchanged
receipt bytes. Recheck exact live head/body and current registration immediately
before first publication within the same transaction. A retired or changed head
cannot enter fresh preparation. Existing v1 apply retains its old path until a
separate full cutover grant; no bypass-closure claim follows.

Pending enumeration authorizes, validates bounded cursor/limit (1..=32), walks
reserved live heads, filters exact collection scope with canonical validation,
and returns immutable request/ref; different collections cannot be surfaced.
Use bounded historical key population (4096 max), bounded per-row SQL length
checks before materializing bodies and bounded aggregate live bytes (16MiB).
No automatic eviction, retry loop, mutation, refreshed operation ID or defaults.

Settlement requires expected_pending_revision == ref.capture_revision, exact
current authority and full original live evidence. Same transaction journal
lookup determines explicit disposition: no row + ReconciledUncommitted retires;
row + ReconciledUncommitted returns Committed with original receipt and leaves
head live; row + exact AcknowledgedCommitted retires; missing/wrong receipt
rejects. Retirement CAS appends a null-state checkpoint revision with predecessor
== capture revision, retaining history/key forever within this bounded stage.
Exact tombstone retry returns identical retirement revision; wrong predecessor,
foreign tombstone or unexpected successor rejects. No new tombstone on retry.
Journal request is the complete evidence after committed retirement. Uncommitted
retirement retains only key and original capture predecessor, sufficient to reject
reuse; no fresh preparation is ever allowed from it.

Apply/retire orders are serialized by IMMEDIATE: retirement-first prevents fresh
apply; apply-first makes reconciliation return Committed, never false cancellation.
Lost capture/apply/settlement responses preserve exact IDs and require exact retry
or bounded recovery. Unknown outcome never implies reconciliation or eviction.

## Accounting without new schema or control rows

Derive counters inside the serialized transaction from the reserved checkpoint
heads/revisions; do not add counter checkpoint keys that would themselves need
unbounded revision history. Limits are 32 live heads, 16MiB live UTF8 body bytes,
2MiB canonical request, 4096 distinct retained keys and 16MiB charged historical
metadata. Existing managed journal 4096/16MiB quotas remain unchanged and separate.

Per retained intent key, reserve both revision rows and one final head at capture.
Conservative logical charge in bytes:
`2 * (client.len + key.len + 36 + 36 + 8 + 8 + 1)
 + client.len + key.len + 36 + 8`.
This charges two UUID revisions, both possible expected UUIDs, sequence/state-byte/
deleted scalar storage and head framing; body bytes are separately charged live.
It is a logical metadata budget, not SQLite physical file-size accounting. Sum
this reservation once per distinct key regardless of live/tombstoned state.
Before capture, validate retained reserved rows have at most capture+retirement
and correct associations; malformed rows fail closed. Check proposed key, live
body and complete future retirement reservation atomically. Settlement cannot
consume another key/reservation and frees one derived live slot/body exactly
once; historical reservation never decreases. No GC, deletion or identity reuse.

## Acceptance and required dependencies

Real SQLite eventual acceptance must cover separately:

- Capture durable across close/reopen/new Store handle; lost response exact ref;
  collision on altered original scope/witness/raw/semantic; wrong Store/stale
  handle; no state/source/authored/change/journal before first apply.
- v1 empty Create capture, precommit abort/no journal, test-only optional-default
  v2 upgrade with unchanged empty digest: old ref rejects origin mismatch before
  defaults and leaves every domain/journal/outbox/sequence unchanged.
- Separate postcommit lost ACK followed by upgrade/reopen: exact original receipt,
  payload and sequence replay without new defaults/echo; old tuple rejection.
- Settlement both tagged cases, exact/wrong receipt/head/ref/auth; repeated lost
  response returns same tombstone; apply/retire both orders with real independent
  connections/held transaction; retired ref never freshly prepares.
- Fill 32 live slots, reject 33rd without eviction; upgrade/reject/explicitly
  retire all 32, then capture a fresh ID; old IDs never reusable. Exercise request,
  live-byte, retained-key and metadata caps and reserved retirement allowance.
- Generic reserved load/CAS/list/changes all reject without reads/writes; existing
  ordinary checkpoint tests still pass. Native ordinary claims are separate
  owner evidence required before composed namespace acceptance.
- WorkBlock semantic Create and RemoveRef observed-tag binding/re-add/exact
  replay. Existing receipt summary and v1 managed adapters remain unchanged.

Portable production validate_registration trusts only WorkBlocks v1. Its test
catalog validator is private to local_intent.rs cfg(test), so downstream Store
SQLite v2 tests cannot currently construct ValidatedRegistration with a v2
catalog. Coordinator must assign a narrowly test-only fixture seam to the portable
owner or explicitly approve a Store unit-test-only seam backed by that owner;
no production arbitrary-schema/catalog API will be added here. Likewise confirm
whether this first source grant includes a semantic Store capture convenience
method, or freezes the raw+semantic input seam above and leaves atomic semantic
retry/capture resolution to a later named service slice.

Execution status: inventory only; source grant/reviewer response pending. No
compiler, Rust tests, apps, native/WASM/IDB/UI or source activation run. Later
checks require coordinator load release and explicitly targeted SQLite test
commands with one build/test thread; no full suite is planned. Independent review
and actual validation remain separate from implementation and integration.

## Coordinator reply and canonical composition checkpoint

Coordinator answered the inventory ask: exact source scope above is granted
**subject to independent inventory review before shared hunks**. Exact canonical
`2120024d22e9b673858e05cb2f2fc8f6ffd166d2` was merged into this isolated branch,
retaining inventory commit `7d60b1e3`; no main checkout was changed. Current
portable/native foundation and their validation reports were read after merge.

The raw+semantic seam is confirmed sufficient for this Store foundation. No
convenience service API is authorized. A later semantic caller must recover
original evidence before command_for_new/tag reads: retry original raw input
through capture if retained, or enumerate bounded pending request bytes to recover
that raw input; committed operation lookup/service integration remains a later
named seam. No semantic product retry/cutover claim is made in this slice.

Real SQLite v1 transaction/settlement/denial cases are the initial implementation
scope. V2 trust access remains OPEN for separately reviewed portable ownership;
no fake engine, source copy, production arbitrary catalog, Cargo feature or
new dependency is permitted. Compiler remains owned by root; source-only review
and bounded formatting only until root releases load. Reviewer ctx_4ef93249788f
was sent exact inventory and this reply; shared source has not been edited.

## Fixed v2 fixture feature amendment — source review gate

Coordinator msg_0fb16764c640 conveys root msg94ba7da4d049 assigning this SAME owner
three additional exact feature hunks, subject to reviewer ctx_4ef93249788f approval
of this amendment BEFORE edits:

- `crates/zorid-records/Cargo.toml`: add nondefault empty `intent-test-fixtures`
  feature; no default change, dependency or lock change.
- `crates/zorid-records/src/local_intent.rs`: feature-gated fixed synthetic catalog
  helper `intent_test_registration(realm: Id, vault: Id, version: u32) ->
  IntentResult<ValidatedRegistration>`. Accept versions 1/2 only and fixed owner
  `origin-store-fixture`, collection `origin-store-fixture-records`: v1 empty
  fields, v2 adds one optional String with fixed default `new-default`. Build the
  exact prefix declaration internally and validate against exactly that compiled
  two-schema catalog. No caller schema/vector/lineage/catalog input or generic
  trusted constructor. Existing production validate_registration unchanged.
  Add feature-gated compile_error when debug_assertions is false: release builds
  cannot include fixture trust. Dependency cfg(test) is false for Store unit-test
  builds, so this helper is feature-gated in records, not cfg(test).
- `crates/zorid-store/Cargo.toml`: nondefault `intent-test-fixtures` forwards only
  `zorid-records/intent-test-fixtures`; no default feature change.
- Already owned `managed_records.rs`: private registration helper may invoke this
  fixed fixture catalog ONLY under `cfg(all(test, feature="intent-test-fixtures"))`
  and exact fixture owner/collection; compare complete current schema bytes.
  Ordinary compiledWorkBlocks-v1 validation stays production default.
  Inline unit tests under same cfg exercise actual Store SQLite empty Create v1
  capture/precommit-nojournal/upgrade-v2/origin rejection and a separate postcommit
  replay upgrade; settlement32/recovery and no new authored migration operations.

Feature-unification review must inspect workspace/native/WASM/default graphs for
any default or ordinary dependency requesting this feature; none is authorized.
Even when records' additive feature is unified by an explicit fixture test build,
Store's fixture-trust branch is absent outside its own unit-test cfg. Release
compile_error excludes fixture-enabled shipping artifacts. Default Store remains
first-party WorkBlocks only, and default native/WASM artifacts never enable this
feature. Before actual execution, coordinator separately approves bounded default
v1 checks and explicit `-p zorid-store --features intent-test-fixtures --lib` filter;
no full suite or speculative release compilation is requested. Source-only checks
verify exact feature forwarding, no default request, unchanged production validator
and cfg gates. Real SQLite v2 acceptance remains OPEN until actual tests pass.

Independent early review corrections: generic Store checkpoint IDs remain any
existing valid OperationId, denying ONLY the reserved UUID; committed replay
never invokes State::prepare, historical or fresh; reserved load verifies exactly
one capture or capture->retirement two-row history on every path, including
unjournaled settlement retry. Receipt is byte-canonical with exact original op,
positive canonical sequence, immutable source and accepted-change association.
The metadata16MiB cap is dominated by4096 retained keys at this charge/key bound;
no artificial impossible metadata-cap fixture will be claimed.
