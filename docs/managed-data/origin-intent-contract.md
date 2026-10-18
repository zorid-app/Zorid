# Private managed-record original intent — representation proposal

Initial documentation task `task_024636031e12`, dispatch `ctx_625ce9935826`; I1 correction task `task_af55755e956e`, author dispatch `ctx_fd9656ed1fe6`, worker `term_8cffbb5d-41df-477f-9526-d3a68d3dbb2f`. Root request `msg_c2bc0c496589`; independent representation review is required before root assigns implementation. The original /tmp successor corrected U finding `msg_f87083fb3e31` against prior freeze `68250f937a992d0d4f2bb492c2877ac331772e68a6889c916f2dc3e993ea0c47`; the separate WorkBlock contract and original review remain unchanged. Existing current-v1 WorkBlock S/W/D/H/P/V implementation is separately authorized; migration/intent implementation is not. The original dispatch made no repository/index/source/build/app changes; this recovery commits only the newly assigned durable document. Spaced repetition is removed entirely.

Authority: original migration contract `28a174ccfbcbc2a2466e03fc512578ff8c790307` plus approved no-row correction `d9fed142b0224237705742df4846d257f51c7c42`, read from `/Users/ctk/orca/workspaces/Zorid/managed-tasks-desktop-ui/docs/managed-data/migration-implementation-contract.md`; approval read from `/tmp/zorid-migration-contract-review.md`. Leave both unchanged. Root decisions remain full canonical first-party lineage <=16 declarations/1MiB, additive optional fields only, zero migration-authored operations, unchanged records/encrypted sync wire v1, and v2 only in tests until a product field is approved. This proposal selects local original-intent retention only, not arbitrary migrations or a production WorkBlock field.

## Durable recovery and review status — 2026-10-18 UTC

Recovery owner `term_0c6b395e-6d6b-4742-9d13-25e75280acd9`, task
`task_af55755e956e`, dispatch `ctx_820f7b820dbb`, isolated branch/worktree
`managed-intent-contract-recovery`. Coordinator instruction `msg_3f1a82c94013`
assigns only NEW `docs/managed-data/origin-intent-contract.md`; sole main
integration remains with the coordinator. No source ownership or implementation
permission is granted by this document.

The reboot removed the original /tmp contract and review. Recovery used the
read-only Codex session `01a14cfe-e6db-7d51-b1a4-7360ea45b7f3`, located with
Orca session search: the original complete document readback matched SHA256
`68250f937a992d0d4f2bb492c2877ac331772e68a6889c916f2dc3e993ea0c47`, and replaying
only its recorded textual I1 replacements in memory reproduced corrected bytes
SHA256 `a14edf25ff3a4a1028eb5e9fc23d3ca27562541aeb812600ba245d08ec645f1d`
exactly. The review text recovered from that same readback required I1 and found
no other concrete correction in its bounded assessment; it did **not** approve
the unreceived corrected successor. U message `msg_f87083fb3e31` was also read
from the durable inbox. No historical shell commands were rerun.

This durable successor preserves that corrected protocol and adds recovery
provenance/source observations; its final SHA is supplied in delivery receipts.
Historical attribution and evidence below describe the original dispatch, not a
claim that deleted /tmp artifacts were freshly read. The accepted direction is
also present in the unchanged canonical
[migration contract](migration-implementation-contract.md). Independent U review
of the exact successor and root selection of reserved namespace/budgets remain
pending. Existing S/W/D/H/P/V current-v1 WorkBlock implementation remains separate
and authorized; migration/intent implementation remains ungranted.

## Recommended representation and trust boundary

Use **existing local checkpoint storage as an immutable host-owned pending slot**, then the existing managed_local_operations journal as committed authority. No signing, bearer capability/token service, new token ledger/table, sync field or public API. An ordinary caller-supplied origin/version/bytes object is never trusted evidence of issuance.

Reserve one internal checkpoint client namespace (a single fixed UUID constant selected by source owner/root) exclusively for managed-record intents in each physical Store/IDB authority. Key is Rust canonical JSON tuple `['managed-record-intent-v1',realm,vault,owner,collection,operation]` (<=1024 UTF-8 bytes). It is vault/collection/operation-scoped across consumer clients, matching journal uniqueness and preventing another client from recapturing the same unresolved operation under a newer schema. Actual consumer leases still authorize every operation; this internal checkpoint client is not a lease, principal, enrollment or storage owner.

**Mandatory isolation:** normal client admission/claim must reject that reserved UUID; all generic checkpoint load/CAS/list/changes entry points must reject the reserved client namespace, while narrow internal host helpers alone access it. Prefix secrecy or a random checkpoint revision is NOT authority. Browser and renderer never provide checkpoint encoded_state or override origin; the host loads it by fixed key and verifies it with Rust. Same-origin application code/compromised OS/direct DB writes remain outside this first-party local trust boundary, as with existing receipts. No public plugin isolation claim.

Choose full canonical bytes as authority, not digest-only identity. Proposed private Rust structs (names proposed):

```rust
pub struct ManagedIntentRef { pub operation: Id, pub capture_revision: String }
// private fields; serde decoder used only on host-loaded checkpoint/journal bytes
struct LocalIntentV1 {
    format_version: u8,                 // exactly 1; private format, not wire version
    store_authority: String,            // actual physical Store/IDB authority, not peer-supplied
    capture_revision: String,           // host-issued checkpoint revision, also retained in journal request
    operation: Id,
    scope: Scope,                      // complete realm/vault/owner/collection/record/generation/restores
    origin_registration: Vec<u8>,       // FULL Rust canonical original registration + bounded lineage
    expected_revision: [u8;32],         // original witness, never refreshed on retry
    command: Command,                  // original canonical raw command, pre-default expansion
    semantic_request: Option<Vec<u8>>,  // exact canonical fixed WorkBlock DTO when using semantic wrapper
}
```

Actual canonical JSON encodes registration/semantic documents as UTF-8 strings rather than numeric byte arrays, avoiding 4x expansion; serde helpers keep their exact bytes. Fixed field order and recursively canonical registration/command encoding come from shared Rust. `admission::local_request` becomes a mandatory private format1 object containing **operation + complete LocalIntentV1**; retain exact original request bytes in both checkpoint and managed_local_operations.request. Do not accept the old tuple decoder as a fallback. Origin is full original registration including lineage, not random registration revision, active version number, digest alone, handle or current declaration. Current registration revision remains a separate commit/CAS authorization fence.

Capture revision is the existing checkpoint revision assigned on first durable issuance, retained unchanged; the reference only addresses retained bytes and never substitutes for current authorization. It enters the complete local canonical request together with authority+scope+operation+origin+witness+command+semantic request, so the committed journal alone can recover the same ref after pending retirement. Full canonical local request <=2MiB, matching current local journal row bound; reject oversized captures before any dispatch. Max32 live pending slots and16MiB retained pending bytes per physical authority are proposed bounded admission budgets, without evicting unresolved entries. Checkpoint history retains capture and retirement metadata only (at most two revisions per key); no GC redesign is proposed. Reserve at most4096 total intent keys (live plus tombstoned) and16MiB total reserved checkpoint-head/history metadata, in addition to live32/16MiB body limits. Check capacity for BOTH capture and its eventual tombstone before admitting capture; settlement must not be blocked by newer captures consuming its reserved retirement allowance. Tombstones never consume a live slot and are never evicted or reused. Exhausting the total historical-key/metadata budget explicitly rejects NEW captures, requiring a separately reviewed retention policy rather than unsafe tombstone deletion; this bounded slice does not promise unlimited distinct intents. Journal quotas stay unchanged. Implementers must account checkpoint encoding overhead within current checkpoint bounds.

## Shared Rust issuance, replay and preparation APIs

Propose NEW `crates/zorid-records/src/local_intent.rs`, with a narrow lib.rs export and reuse of approved compatibility/admission helpers:

```rust
capture_local_intent(registration: &ValidatedRegistration, store_authority: &str,
    capture_revision: &str,
    operation: Id, scope: Scope, expected: [u8;32], command: Command,
    semantic_request: Option<&[u8]>) -> Result<LocalIntentV1>;
canonical_intent_request(intent: &LocalIntentV1) -> Result<Vec<u8>>;
validate_retained_intent(current: &ValidatedRegistration, store_authority: &str,
    expected_operation: &Id, retained_bytes: &[u8]) -> Result<ValidatedLocalIntent>;
require_fresh_origin(current: &ValidatedRegistration,
    original: &ValidatedLocalIntent) -> Result<()>;
```

`capture_local_intent` receives registration loaded/authorized by the host and a freshly host-generated checkpoint revision, never renderer origin; the checkpoint write uses that exact revision. Validate canonical registration against trusted compiled first-party catalog. It captures before first **mutating apply dispatch**, without calling State::prepare or expanding defaults. Semantic WorkBlock capture uses shared Rust wrapper: Create derives original empty State bytes/digest with operation==generation; remove_ref reads original accepted state only when no retained capture/journal exists, derives observed add tags once, and stores exact raw command plus semantic DTO. Repeated capture first resolves pending/journal and never recomputes a removed-reference tag set. Other raw record callers supply canonical raw command; Rust validates input but owns all domain/default/merge logic.

`validate_retained_intent` verifies full immutable scope, physical authority, operation, canonical bytes, compiled historical declaration/lineage and semantic-to-command binding. A committed historical origin may be an authorized prefix of current compiled lineage; it need not equal active registration. This is validation of historical evidence, not permission to freshly prepare it. `require_fresh_origin` requires full canonical original registration bytes equal current semantic registration bytes; current random registration revision is excluded from semantic equality. An upgrade/version-only step therefore rejects no-row old intent even when state digest is unchanged. No JS comparison/default inference.

## Capture/apply/recovery protocol

1. **Capture:** require current actual client lease/admission, physical authority and collection handle/scope. In one serialized local SQLite IMMEDIATE / strict IDB transaction, authorize current handle, look up committed journal and reserved pending key BEFORE new capture. Existing matching capture returns same ref/bytes; changed scope/expected/command/semantic input under same operation => collision. Existing committed journal returns its original intent/ref association rather than reissuing under current schema. A previously retired pending tombstone with no journal => reconciliation_required; never recapture that ID.
2. If neither exists, Rust captures from authoritative current registration and supplied original input; persist immutable checkpoint slot before returning ManagedIntentRef. No apply is queued until durable capture acknowledgement. Capture response loss is recovered by repeating capture with the same operation and original input: host finds existing slot. If a capture never durably occurred, no apply could have run; a later successful capture is the first issued intent. This defines first dispatch precisely; no claim that an unsent UI form already had a schema origin.
3. **Apply:** reacquire current authority/handle first; resolve pending ref by fixed key, or recover complete committed journal evidence if pending was retired after acknowledgement. Wrong capture_revision/reference, missing/malformed origin, wrong scope/store/changed input => explicit rejection; caller origin bytes cannot replace missing state. Then construct original complete canonical request from retained evidence and query managed_local_operations by collection+original operation.
4. **Committed row:** compare complete original request bytes; mismatch=>operation_collision. Exact authorized replay returns original stored result/payload-operation binding BEFORE accepted-state digest/restore/quota/default preparation, even after active registration upgrade. No authored/change/outbox/sequence effect. Current authorization and historical-origin validation remain required, so stale handles cannot replay.
5. **No row:** missing/unverifiable evidence=>intent_origin_missing/intent_origin_invalid; origin differs from current=>intent_origin_mismatch, with explicit reconciliation. ALL precede accepted-state preparation and default expansion; equal old/current state digest does not relax this. Matching new origin proceeds to current revision/restore/source/quota/State::prepare and existing atomic journal+source+state+change+authored commit. Final registration revision/CAS remains required separately.
6. **Retention:** release/reacquire/restart keeps original pending slot and request bytes. After successful commit, keep slot until caller durably acknowledges original result; then tombstone it through existing checkpoint CAS, never silently replace it. Journal retains complete intent/capture reference association needed for later exact replay. Tombstone prevents ID reuse if no journal exists. For cancelled/rejected/no-row origin-mismatched intents, the explicit reconciled-uncommitted settlement below may retire via tombstone, never recapture same ID; it does not require a nonexistent commit receipt. Uncertain/IO/timeout never evicts. If bounds reached, reject new captures and retain old ones. Same physical authority supports fresh admitted client recovery after restart; no cross-store/DB copying/import of pending refs.

Checkpoint capture and domain commit are intentionally separate durable boundaries: crash between them leaves only recoverable pending intent; it does NOT claim atomic domain success. Apply transaction reads reserved checkpoint evidence and journal under the same commit boundary; changed/retired pending head or registration revision aborts held preparation. This final pending-head fence is required immediately before any domain publication in the SAME commit transaction, not merely at initial capture or plan creation: exact expected live capture revision and nondeleted body must still match. A retired ref may return committed journal replay but may NEVER enter fresh preparation. No transaction spans network waits. Pending checkpoint changes are local recovery metadata only, never managed_changes or sync payload.

## Explicit authorized settlement and retirement (I1 correction)

The tagged settlement API below REPLACES committed-only managed_ack_intent/ackIntent; it does not add automatic cancellation. Caller explicitly chooses acknowledged_committed with original receipt, or reconciled_uncommitted after reviewing a failed/cancelled intent. Both require current actual lease/admission, enrolled scope, authorized collection handle, exact original ManagedIntentRef and expected_pending_revision equal to that ref's capture_revision. A stale/ref-mismatched caller receives intent_head_conflict without effects; an arbitrary current head revision cannot replace the original capture association.

Inside ONE SQLite IMMEDIATE / strict IDB transaction, resolve the fixed reserved key and verify the live head, original capture revision/full canonical retained request, physical authority and current authorization. Read managed_local_operations by collection+original operation in that SAME transaction before writing the tombstone:

- **No journal row + reconciled_uncommitted:** retire by exact-head CAS from the live capture revision to one fresh host-issued checkpoint tombstone revision (encoded_state=null, expected_revision=original capture revision). Return retired only after durable completion. Free exactly one live slot and its pending-body bytes; retain the reserved key and capture-to-retirement metadata. No record/default/source/outbox/change/journal write and no ID reuse/recapture.
- **No row + acknowledged_committed:** reject receipt_missing; never fabricate a committed acknowledgement.
- **Matching committed row + reconciled_uncommitted:** return committed with ORIGINAL receipt/association, leave pending head/live accounting unchanged, and require a subsequent explicit acknowledged_committed call with that exact receipt. Never report cancellation/retirement of an unacknowledged durable success. A mismatched canonical journal request/ref is operation_collision/corruption, never retirement.
- **Matching row + acknowledged_committed:** verify exact original operation/revision/sequence receipt bytes and canonical request/ref association, then exact-head CAS to tombstone, free live accounting once, and return retired after durable completion. Domain journal/result bytes remain unchanged.

**Retry after lost settlement acknowledgement:** caller repeats identical original ref, original expected capture revision and same disposition/receipt; it need not know the newly issued tombstone revision. If head is tombstoned, validate retained checkpoint revision history proves precisely that key's capture_revision -> retirement_revision edge (and no intervening live replacement). Recheck journal under current authorization. No row + reconciled_uncommitted returns the SAME retired revision; matching row + exact acknowledged_committed returns SAME retired revision. Reconciled_uncommitted with a committed row returns committed, even on a tombstoned head, so it never implies durable success was cancelled. Missing/inconsistent history, changed ref/receipt, a foreign tombstone or unexpected successor fails explicitly. Repeated settlement never appends another revision or decrements counters twice.

**Apply/retire races:** if retirement commits first, apply's fresh transaction or final pending-head precondition sees deleted/changed head and rejects before domain authoring; no held plan can publish afterward. If apply commits first, retirement observes its exact journal row and returns committed unless caller supplies exact committed acknowledgement. SQLite serialization and shared IDB transaction store sets must include checkpoint heads/revisions, journal and relevant counters; separate journal checks or cross-transaction CAS do not meet this contract. A lost retirement response remains settlement-uncertain until this idempotent query/retry resolves it; it is not permission to issue a new operation under the old ID.

## Exact proposed adapter seams

Native Store additions in `crates/zorid-store/src/managed_records.rs`:

```rust
managed_capture_intent(&mut self, handle: &ManagedCollection, input: ManagedIntentInput)
    -> Result<ManagedIntentRef>;
managed_apply_intent(&mut self, handle: &ManagedCollection, intent: &ManagedIntentRef)
    -> Result<ManagedCommit>;
managed_pending_intents(&self, handle: &ManagedCollection, after: Option<&str>, limit: u32)
    -> Result<ManagedIntentPage>; // bounded <=32 entries, private recovery
managed_settle_intent(&mut self, handle: &ManagedCollection,
    intent: &ManagedIntentRef, expected_pending_revision: &str,
    disposition: ManagedIntentDisposition) -> Result<ManagedIntentSettlement>;
// disposition: AcknowledgedCommitted { original_receipt: ManagedCommit }
//            | ReconciledUncommitted
// result: Retired { retirement_revision: String }
//       | Committed { original_receipt: ManagedCommit } // not retired, requires exact acknowledgement
```

Internal helper in checkpoints.rs must operate within caller's existing transaction, without calling public methods that open nested transactions; maintain existing checkpoint head/history/revision invariants. Generic checkpoint APIs deny reserved namespace. File-oriented host_intents.rs currently requires EntryId/file CommitResult/HostMutationKind; do not overload it with managed records. Existing managed_apply becomes internal origin-aware engine entry or rejects missing intent evidence in new format; it cannot remain a bypass. NativeVault/WorkBlock session/lease stays intact: add first-party capture/apply RPC stages under existing admitted context; retained caller pending state stores only original immutable request and ref. Host dispatch ownership requires explicit root grant.

Private WASM extensions in `crates/zorid-wasm/src/records.rs`:

```ts
captureRecordsLocalIntent(registration:Uint8Array, authority:string, captureRevision:string, scopeJson:string,
  operation:string, expected:Uint8Array, command:Uint8Array,
  semanticRequest:Uint8Array|undefined): Uint8Array; // canonical complete intent request
validateRecordsLocalIntent(currentRegistration:Uint8Array, authority:string,
  operation:string, retainedRequest:Uint8Array): void;
canonicalRecordsLocalRequest(retainedRequest:Uint8Array): Uint8Array;
prepareRecordsLocal(factsJson:string, retainedRequest:Uint8Array): RecordsPlan;
```

These are **proposed replacement signatures** for new private format, not current APIs. Existing canonicalRecordsLocalRequest currently takes registration/scope/operation/expected/command; prepareRecordsLocal currently takes factsJson/raw command. `Facts.local` must carry retained immutable intent plus pending checkpoint revision in preconditions, rather than freshly binding current registration to an old command. prepare_local_inner validates retained intent, compares exact prior request/result first, calls require_fresh_origin ONLY if no row, then reuses existing state.prepare/planner/finalize. `validateRecordsStoredReplay` validates complete new request+original result/binding; keep its byte-preserving role, no raw auth booleans. Historical authenticated incoming plans remain unchanged; new origin metadata is LOCAL ONLY.

Browser `createBrowserManagedRecords` additions:

```ts
captureLocal(handle, input: ManagedLocalInput): Promise<ManagedIntentRef>;
applyIntent(handle, ref: ManagedIntentRef): Promise<ManagedCommitOutcome>;
pendingIntents(handle, after: string|null, limit: number): Promise<ManagedIntentPage>;
settleIntent(handle, ref: ManagedIntentRef, expectedPendingRevision: string,
  disposition: {kind:'acknowledged_committed';receipt:Uint8Array} |
               {kind:'reconciled_uncommitted'}):
  Promise<{kind:'retired';retirementRevision:string} |
          {kind:'committed';receipt:Uint8Array}>;
```

ManagedLocalInput remains original scope/operation/expectedRevision/command plus optional semantic DTO; no caller origin field. Rust capture runs synchronously against authorized CollectionRow.registration in strict transaction; retain via existing checkpoint_heads/revisions/control counters using internal transaction helpers factored from browser-checkpoints.ts. Add those existing stores to local apply transaction store-set; do not open nested IDB transactions or await inside callbacks. Existing apply(handle,input) must become internal or explicitly capture-then-apply ONLY for genuinely new calls; retained retries MUST use ref, and unresolved original input cannot be automatically reissued. BrowserStreamingManagedRecords facade exposes these methods only worker-internally.

Normal browser worker/host owns capture RPC stage, immutable pending refs and stop/drain; browser-core-runtime/client-admission forwards capture acknowledgement before apply under same admission/queue. On worker loss, reacquisition calls bounded pendingIntents; exact semantic request association permits recovering ref even if capture response was lost. Retained WorkBlock remove command is Rust-authored bytes, not recomputed by JS. No new auto retry/network loop, no public managed collection or checkpoint capability. Desktop native host/preload/binding similarly carries capture ref alongside immutable pending operation; public WorkBlockService mutation signatures can stay unchanged because two-stage capture is implementation-private. No Tasks UI dependency: Tasks remain file-authoritative.

## Source ownership proposal and physical changes

Root assigns owners; these are not grants. Portable owner: NEW records/src/local_intent.rs, records lib.rs module and admission.rs local_request; coordinate compatibility.rs lineage owner. Native storage owner: managed_records.rs plus checkpoints.rs transaction helper/reserved-scope guard; native session owner separately owns workblocks.rs/host workblocks dispatch narrow capture/apply/settle hunks. WASM owner: records.rs facts/canonical/prepare/stored-replay, optional workblocks.rs semantic capture reuse. Browser storage owner: browser-managed-records.ts, browser-checkpoints.ts internal helper/reserved namespace, browser-sync-streaming.ts facade/stores, browser-streaming-vault.ts existing-store transaction edge only. Separate platform owner: browser-core-worker/runtime/client-admission/client-lease reservation guard and native/desktop admission+binding reservation/transport. Shared lib/module hunks serialize with WorkBlock S/W/D/H/P batches; no overlapping worker ownership.

No SQL table/column or IDB store/index/version change recommended: existing checkpoint storage holds pending canonical bytes, current local journal request stores full identity including capture_revision, while result retains the exact existing receipt bytes. New mandatory local request format rejects old development rows explicitly; regeneration of disposable fixtures only after separate owner authorization. No automatic migration, clearing real vaults, schema/lineage change beyond approved contract or wire changes. Reserved system namespace and enforcement is a real additional seam, not an existing guarantee.

**Remaining root representation choice:** approve the fixed reserved checkpoint client namespace and its mandatory denial at generic APIs, with immutable pending32/16MiB limits and bounded4096-key/16MiB-metadata retirement retention, or assign a different existing host-owned recovery store. This recommendation is concrete; do not implement until final representation review. If root declines reserved-namespace enforcement, caller bytes alone are not an acceptable fallback. Exact UUID constant is mechanical after approval. No new public origin token design is implied.

## Minimal meaningful acceptance

- Shared Rust golden canonical bytes native/generated WASM: full origin+scope+operation+witness+command/semantic binding; historical lineage validation, scope/command/origin tampering, missing evidence, old tuple rejection. Canonical defaults/numeric bytes use approved migration rules, not JS equality.
- Real SQLite and generated WASM/strict IDB: capture v1 generic Create([]), prove durable pending but NO journal after precommit abort/lost attempt; upgrade test-only v2 with optional default, prove unchanged empty digest; reacquire/fresh apply with original ref rejects origin_mismatch BEFORE preparation with no domain/source/outbox/journal/change writes. Missing/forged/retired/mismatched refs also reject, including attempts through generic old apply or generic checkpoint APIs.
- Separate postcommit/lost-ack case: v1 commit, upgrade/restart/new current handle, exact original result/payload/sequence replay and no new defaults/echo; changed original identity collides. Held-plan registration CAS race is separate, not a substitute.
- Capture response loss, crash before/after capture completion, release/reacquire/new client same physical DB, concurrent clients trying same operation and altered input, reserved client claim denial, wrong vault/store rejection, pending capacity no eviction, explicit ack/tombstone and recovery enumeration. Prove checkpoint/private origin bytes cannot be overwritten through exposed generic entry points.
- I1 settlement in real native SQLite and generated WASM/strict IDB: fill32 live v1 slots with no journal, upgrade and observe origin_mismatch, explicitly reconcile/retire all32, then successfully capture a new intent. Old IDs remain unreusable. Assert exact ref/head/current authorization, committed association when a row appears, original receipt acknowledgement, response-loss retry returns identical tombstone revision, and counters free once. Hold apply/retire in BOTH serialization orders; retirement-first prevents publication, apply-first returns committed instead of false cancellation. Wrong head/ref/receipt and stale authorization have zero effects; all tombstone/history/key/metadata caps and reserved settlement capacity are enforced without evicting uncertain intents.
- WorkBlock create empty witness and remove-ref observed-tag capture/re-add/replay remain exact; no premature native session/lease rewrite. Normal product Worker and desktop admitted two-stage capture tests are composed service evidence; independent encrypted offline convergence and rendered Calendar remain separate gates. Origin metadata never changes wire-v1 operation bytes or authors migration operations.

Only documentation is delivered here. Root approval of representation, named source ownership, implementation and actual runtime verification all remain outstanding; Tasks delivery in other source worktrees is unaffected.

## Original narrow evidence freeze

Working source HEAD `edd94d07ae0613f4ea2ed6da7dcb1f3c527e0fcd`. Source witness SHA256 `23d7261ade9200ede499aab0d3a2172224b7d527c4bc7ee3677742920d7a0999` uses sorted relative path + NUL + file bytes + NUL over:

- `crates/zorid-records/src/admission.rs`
- `crates/zorid-store/src/checkpoints.rs`
- `crates/zorid-store/src/host_intents.rs`
- `crates/zorid-store/src/managed_records.rs`
- `crates/zorid-wasm/src/records.rs`
- `src/core/browser-checkpoints.ts`
- `src/core/browser-managed-records.ts`
- `src/core/browser-streaming-vault.ts`

Approved migration document working bytes SHA256 `3abec071b0300b31376612aa372e86dce8b8fd3f90e18e8c866e06f813686760`; existing correction review SHA256 `7b4913a3a4742c2a72f1bd6664682011a058a533bf0d9521bc4d6b2809a1ca1e`. Both were read only. No runtime tests or implementation acceptance follow from these hashes.

## Recovery source verification and required assignments

The isolated recovery source HEAD is
`22fad1b3c6e082fd72c76e715dcf66f7ff40e19c`. Recomputing the eight-file witness
above gives exactly `23d7261ade9200ede499aab0d3a2172224b7d527c4bc7ee3677742920d7a0999`;
all eight source files match the original evidence freeze. The current migration
contract likewise matches `3abec071b0300b31376612aa372e86dce8b8fd3f90e18e8c866e06f813686760`.
The recovered original review was read without recreating or modifying it.

Bounded actual-source observations supporting the proposed seams:

| Existing source | Observed behavior / required future change |
| --- | --- |
| `crates/zorid-records/src/admission.rs:249` | `local_request` still encodes only scope, expected digest and command. No trusted original registration is present; the mandatory retained format is a proposal. |
| `crates/zorid-store/src/managed_records.rs:453` | `managed_apply` authorizes within IMMEDIATE, queries exact local replay before state/default preparation, then commits state/source/change/authored/journal together. Add origin and live-head checks in this same transaction; do not separate journal check from retirement CAS. |
| `crates/zorid-store/src/checkpoints.rs:250` | Public checkpoint CAS creates its own IMMEDIATE/FULL transaction, checks exact expected head, and retains revision/expected-revision metadata after tombstone. Factor a narrow internal helper for caller-owned transactions; do not nest the public method. Existing metadata plus head proves the capture-to-retirement edge without retaining retired bodies. |
| `crates/zorid-wasm/src/records.rs:350` and `:438` | Canonical local request takes current registration plus original raw inputs; preparation facts compare prior request/result before state preparation. Proposed retained evidence/final live-head preconditions must replace that missing-origin input rather than merely add a stale-plan check. |
| `src/core/browser-managed-records.ts:337` | `apply` clones original input, authorizes, computes request, checks journal then prepares/publishes in synchronous callbacks. Add the existing checkpoint stores to the shared readwrite transaction; finish durability before reporting settlement. |
| `src/core/browser-checkpoints.ts:17`, `:45`, `:135` | Generic checkpoint scope presently validates a client string, uses strict durability, keeps head `previousRevision` and revision metadata, and CASes the exact head. Reserved-namespace denial, private in-transaction helper and admission counters are new requirements, not established guarantees. Preserve global sequence/history invariants. |
| `crates/zorid-native/src/client_admission.rs:60`, `src/platform/browser-client-lease.ts:15`, `src/platform/browser-client-admission.ts:30` | Named admission/claim owners must add the reserved-system-client rejection alongside generic checkpoint guards. This recovery only located/read these seams; it did not change or validate a reserved identity implementation. |

The source ownership proposal above is the minimum coordinated set, not an edit
grant: portable canonical intent/identity; native Store plus checkpoint helper;
WASM facts/plans; browser records plus checkpoint transaction facade; separately
named native/browser admission and product transport owners. Reconcile any
current-v1 worker edits before assigning overlapping hunks. No new table/store,
manifest/lockfile, migration source, application or build was changed here.
Validation is recovery SHA equality, bounded source inspection and documentation
whitespace/scope review only; every native SQLite/generated-WASM/strict-IDB case
listed above remains a future acceptance gate, and no integration/native/mobile
or reference parity claim follows from this documentation commit.
