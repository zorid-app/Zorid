# Browser WorkBlock implementation contract — proposed review freeze

Task `task_94941a785e7c`, dispatch `ctx_33eef202d916`; author `term_8cffbb5d-41df-477f-9526-d3a68d3dbb2f`. Documentation only: coordinator/root must name owners after independent U review before any implementation or registry activation. Derived from `/tmp/zorid-browser-workblock-map.md`; that map remains unchanged. Spaced repetition is **removed from product scope entirely**, not deferred.

Observed checkout HEAD `edd94d07ae0613f4ea2ed6da7dcb1f3c527e0fcd`; sampled main `7716786aa8a7c233569ba3745bd74b62a6d4dfa1`. Targeted files below are unchanged from the map's inspected source `4db4ce3f5b7c339b48d717f965a9b9f7170a7f7e` (read-only path diff). No new broad audit, implementation, build, installation, app or network operation was performed. Native public DTO/error behavior and `src/core/workblocks.ts::WorkBlockService` remain the compatibility boundary.

## 1. Fixed contract and exclusions

Expose exactly create/read/windowPage/move/title/addRef/removeRef/delete/changes to normal browser `PlatformVault.workBlocks`, under its existing client/vault admission. Registration is compiled Rust `first_party::registration` with OWNER `zorid_firstparty_calendar`, COLLECTION `workblocks`, exact Synced v1 schema. Renderer messages cannot supply owner/schema/registration/collection/restore/enrollment handles. Keep private handles, raw states and collection APIs inside worker/storage closures.

Reuse `first_party.rs` validators, `State`, `admission::local_request`, existing WASM `RecordsPlan` and common-ledger atomic authoring. No JS semantic command construction, field/range/reference validation clone, merge, receipt preparation, public plugin API, general storage trait, alternate outbox/cursor, migration/lineage change, native lease/session rewrite, or Tasks/Calendar UI work. JS performs bounded transport capture and storage orchestration only. No dependency/lock/manifest change is needed by this contract.

Preserve strict native command serde: snake_case op, camelCase command fields, deny unknown fields; title command requires a string or explicit null; create title remains optional. Range fields are start_ms/end_ms/timezone. Decimal strings and opaque 32-byte revision arrays cross unchanged. Reads retain every range/title conflict candidate, task refs, created/deleted flags, null block for absent/deleted, and unknown unresolved status keys with canonical count strings. References use structural core EntryIds, never note paths or existence joins.

## 2. Shared Rust semantics and private WASM interfaces

NEW `crates/zorid-records/src/workblock_service.rs`, exported by a narrow `lib.rs` declaration. Extract only pure duplicated native DTO/view/semantic preparation pieces; existing `first_party.rs` continues owning every domain validator. This is justified by concrete second-consumer needs: native's strict command DTO, view conversion, observed-remove recovery and service window budget checks would otherwise be duplicated in browser JS/WASM.

Proposed Rust interfaces (internal inter-crate APIs, no public product stability promise):

```rust
pub struct WorkBlockRevision(pub [u8; 32]); // exact native serde byte-array representation
pub enum WorkBlockCommand { /* exact existing native variants and serde fields */ }
pub struct WorkBlockValue { /* exact native ranges, titles, task_refs DTO */ }
pub struct WindowQuery { pub from: String, pub until: String, pub limit: u32, pub bytes: u32 }
pub fn fixed_scope(realm: Id, vault: Id, record: Id, generation: Id) -> Result<Scope>;
pub fn empty_state_bytes(scope: &Scope) -> Result<Vec<u8>>;
pub fn command_for_new(input: &WorkBlockCommand, state: Option<&State>) -> Result<Command>;
pub fn command_for_replay(input: &WorkBlockCommand, scope: &Scope,
    expected: &[u8;32], prior_request: &[u8]) -> Result<Command>;
pub fn read_value(state: &State) -> Result<Option<WorkBlockValue>>;
pub fn validate_window(query: &WindowQuery) -> Result<first_party::Window>;
```

`fixed_scope` fixes owner/collection/restores=None. `empty_state_bytes` is State::new(first_party::schema(), scope).snapshot(). Existing native/WASM Sha256Digest hashes it; records needs no hash dependency. Create's original operation equals generation; it never derives its witness from current persisted state. Noncreate uses the caller's original expectedRevision without rebase.

`command_for_new` delegates create/set_range/set_title/add_task/remove_task/delete to existing first_party helpers. Only new remove_ref needs accepted State. `command_for_replay` canonical-decodes existing admission::local_request tuple `(Scope,[u8;32],Command)`, verifies re-encoding, complete scope, original expected witness and matching semantic command. For remove_ref it verifies exactly one Remove action on task_refs for the same task, then retains its ORIGINAL observed add tags. It must not recompute tags from later accepted history. For other ops it regenerates the fixed command and compares canonical request bytes. Corrupt journal encoding is storage corruption; valid but different target/generation/witness/command is operation_collision.

Native adoption is bounded: retain public native `WorkBlockCommand`, ManagedRevision, WorkBlockError, replies and session signatures; convert to/from shared helper DTOs if replacing native types would break Rust callers. Tiny pure helper delegation and byte-equivalence tests are permitted only in a separately named native compatibility batch. Do not move native locks, leases, session/cursor map, filesystem checks, transactions or Store paging into shared traits. Existing native remove_ref reads snapshot/history before Store::managed_apply, whereas Store itself replays before current-state preparation. The browser must meet the stronger journal-first ordering below; native's ordinary remove/re-add replay tests do not prove replay through corrupt current state. Native journal-preflight changes are excluded from this first browser batch and must not be silently bundled.

NEW `crates/zorid-wasm/src/workblocks.rs`, narrow `lib.rs` module declaration and `pub(crate)` access to existing records.rs decode/preparation helpers. Exact proposed JS bindings:

```ts
workBlockIdentity(): string; // {owner,collection,schemaVersion:1}, compiled only
workBlockRegistration(enrolledScopeJson:string): Uint8Array;
workBlockReadSet(enrolledScopeJson:string, request:Uint8Array): string;
// read set: {scope,operation:null|string,kind:'read'|'mutation'|'window'|'changes'}
workBlockReplay(enrolledScopeJson:string, request:Uint8Array,
  priorRequest:Uint8Array|undefined, priorResult:Uint8Array|undefined): Uint8Array|undefined;
prepareWorkBlockLocal(factsJson:string, request:Uint8Array): RecordsPlan;
workBlockSnapshot(scopeJson:string, state:Uint8Array|undefined,
  unresolvedRowsJson:string): Uint8Array; // native-shaped ManagedSnapshot bytes
workBlockRead(snapshot:Uint8Array): Uint8Array; // WorkBlockRead JSON bytes
workBlockChanges(rowsJson:string, after:string): Uint8Array; // native ManagedChangePage
```

All inputs/outputs bounded. `workBlockReplay` returns undefined only when BOTH journal fields are absent; one missing field is corrupt. It uses compiled registration, original empty digest for create or explicit mutation witness, shared command_for_replay and existing validateRecordsStoredReplay/finalization representation. Exact replay returns original receipt bytes without state restore, revision/quota/source preparation or another authored/change row. `prepareWorkBlockLocal` supplies shared semantic command and unchanged scope/operation/witness to existing `prepare_local_inner`; use existing RecordsPlan checkPreconditions, payload/bindings/state/projection/localRequest and finalizeRecordsLocalResult. Do not clone that planner. Pure Rust failures carry structured code, source and definite noncommit status, not text strings classified by JS.

`workBlockSnapshot` validates via existing admission/recordsSnapshot, hashes canonical state, projects all candidates and aggregates unresolved statuses in Rust into exact native ManagedSnapshot serialization. Its output byte length is the window accounting unit. `workBlockChanges` Rust-encodes native `record_key` JSON tuple `(record,generation)`, maps stored update identity `operationId` to `update_id`, preserves statuses, and returns next=last sequence or input after on empty page. No JS reconstruction of Rust wire JSON.

Private WASM `WorkBlockWindowSession` provides:

```ts
begin(queryJson:string, watermark:string): WorkBlockWindowScan;
// scan exposes afterKeyJson():string|null and watermark():string
// offer returns false WITHOUT advancing if the next snapshot exceeds remaining bytes
scan.offer(snapshot:Uint8Array, nextKeyJson:string): boolean;
scan.finish(eof:boolean, opaqueToken:string): Uint8Array; // WorkBlockPage JSON
scan.free():void;
session.close():void;
```

`queryJson` includes optional public cursor. Session owns at most eight opaque cursor entries bound to exact query+budgets+last consumed storage key+collection watermark. Worker supplies crypto.randomUUID token only when finish needs a new continuation, avoiding Rust WASM entropy dependencies. Existing cursor is validated against captured watermark; page finish cannot commit a stale fence. The host checks authoritative watermark before begin/reading and after scan; it publishes finish only when both equal the captured fence. Rust validates 1..64 scanned rows, 1..1048576 native snapshot bytes, at most31-day half-open Window, all-range-candidate intersection, filtered/deleted scan costs, and cursor reuse/eviction behavior. First row too large=>limit; otherwise rejected row is left unconsumed. EOF may require another empty scan as native does. Unknown/foreign/reopened/evicted cursor=>cursor_expired; changed query/budgets=>invalid_request; any collection mutation=>window_changed. Native cursors/sessions remain untouched.

## 3. Authorized atomic storage and concrete IDB/wire decisions

Extend `createBrowserManagedRecords` and `BrowserStreamingManagedRecords` private facade with:

```ts
applyWorkBlock(handle:ManagedCollectionHandle, request:Uint8Array): Promise<ManagedCommitOutcome>;
watermark(handle:ManagedCollectionHandle): Promise<string>;
exportOne(handle:ManagedCollectionHandle, afterKeyJson:string|null):
  Promise<{snapshot:Uint8Array;nextKeyJson:string}|null>;
```

`applyWorkBlock` factors existing apply's install path. One existing strict readwrite transaction performs: authorize handle/current registration -> Rust fixed read set -> collection+original-operation local journal lookup -> Rust replay -> if absent ONLY THEN readFacts/accepted/restore/sources/quota -> Rust prepareWorkBlockLocal -> checkPreconditions -> existing state/source-binding/change/finalize/common.authored/local-operation/result/counters writes. Transaction completes before success and fresh active guard. Existing common authored config checks and immutable source/outbox coordination remain mandatory. No await/network/WebCrypto inside live IDB callbacks; all failed preparation aborts without partial writes. Caller input copied before await. Remote-author operation reuse without local receipt remains operation_collision.

`watermark` uses existing managed_changes.by_collection reverse prefix cursor after handle authorization; return maximum collection sequence or '0'. Existing snapshot.changesAfter/global control sequence is NOT this watermark. `exportOne` uses managed_records compound primary key prefix `(realmId,vaultId,owner,collection)`; private continuation is canonical JSON `[record,generation]`, validated/encoded by Rust and used only as an IDB position. Listing order is IDB tuple order and stays internal behind opaque session cursors; do not claim it equals native JSON-tuple lexical order. External contract is deterministic bounded fenced coverage, not shared cursor bytes or cross-platform cursor portability. Fetch one row and bounded unresolved receipt metadata through existing by_retry collection prefix (existing receipt quota4096); Rust builds exact ManagedSnapshot bytes. No whole-collection materialization.

**No schema/index/database-version changes proposed:** existing primary keys and by_collection/by_retry indexes suffice. No migration/backfill/lineage changes. If implementation finds a missing bounded-read invariant, stop that hunk and return the concrete index/format proposal for review; do not improvise a migration. Managed wire schema1/family records format1, common encrypted envelope, outbox and network cursor stay byte-compatible. New private worker RPC only: operation `workblock-command`, payload `{schemaVersion:1,command:{op,...}}`; same command/reply shapes as native service, parent reply carries existing native semantic `{schemaVersion:1,op,value}`. No binary native framing emulation required across structured clone. Capture max16KiB request, bound response to4MiB, matching existing desktop limits. Public window budgets remain64/1MiB; generic Store export limits do not change.

## 4. Normal Worker readiness, queue/session/release and admitted binding

`browser-managed-records-registry.ts` replaces the empty array with `createBrowserManagedRecordConsumers(wasm)` returning ONE fixed WorkBlock entry from workBlockIdentity/Registration. Factory runs inside worker after same-origin WASM load and actual enrolled scope. Add optional private `opened(handle)` callback to ManagedHostConsumer, called once on authorized registration; service uses SAME host-maintained handle. No register/owner/schema RPC.

`browser-managed-records-host.ts` adds `initializeOnLocalTail():Promise<void>` for registration/attachment while open already holds the tail. It must not call host.local recursively. Existing trigger/coalescing/maintenance budgets and metadata callbacks remain unchanged. Normal worker awaits initialization after lease/scope/storage validation and before advertising `workBlocks:true`; missing required bindings fail closed for default browser, without memory fallback. Legacy/unregistered fixture capability may stay absent. Trigger maintenance after initialization using existing mechanism; do not await trigger from a currently queued operation (deadlock).

NEW `browser-workblocks-host.ts` owns execute/stop/drain and private WASM window session. `browser-core-worker.ts` adds capability flag and `workblock-command` dispatch on EXISTING local queue, never detached binary/network path. All commands check assertManagedActive inside storage callbacks and after awaits. Postcommit hints use existing parent/channel/refresh and event-driven maintenance; no new network loop. Window orchestration performs fresh collection watermark checks before and after bounded read and returns only fenced output. Exact session/config guards from `BrowserSyncWorker.recordsSession()` and common authored hooks remain; no browser-sync-worker.ts changes required. Local authoring stays independent of credentials; upload/convergence is separate.

Release retains existing synchronous closing + managed.stop + sync.revoke fence before queued cleanup. Stop WorkBlock admission synchronously too; drain accepted semantic work/current scan before disposing handle/session, closing storage or releasing lease. Transaction past final abortable callback may commit after closing: suppress stale notification, report mutation uncertainty and allow exact receipt recovery on reacquisition. No claim of rollback from late owner rejection.

NEW `browser-workblocks.ts` thin typed transport implements existing WorkBlockService, bounded descriptor-only immutable capture, at most32 unresolved mutation fingerprints without eviction, concurrent identical call dedupe, explicit same-ID retry, stop/drain. Domain validation and receipt/merge work stays Rust. Do not import desktop createDesktopWorkBlocks/codec, whose domain-like range checks would become a JS semantic clone.

`browser-core-runtime.ts` adds optional service/capability, private queued RPC, envelope checking and WorkBlock-specific error carry. **Response validation is bound to the immutable original request, not merely its envelope:** mutation receipts must return the original operation ID, a valid opaque 32-byte revision and canonical nonzero sequence; read must return the original record AND generation. Window replies must satisfy the requested scanned-row and byte budgets, nonnegative bounded counters, blocks no greater than scanned, nonzero progress when continued, cursor/incomplete agreement, valid watermark, and advancing continuation relative to the request; retained session/query fences remain Rust-owned. Changes must contain at most the requested limit, strictly increasing canonical sequences greater than the original after, next equal to the last returned sequence (or original after when empty), and valid native change identities/statuses. Preserve unknown status keys/strings. Do not independently redo domain range/intersection/ref semantics in JS: Rust owns those; the transport checks request association and bounded output consistency. Any malformed or request-mismatched mutation reply is commitUncertain=true and retains the exact immutable request for explicit identical retry; it cannot retire the pending fingerprint or be treated as a definite rejection. `browser-client-admission.ts` wraps every service method with existing invoke/pending/owner guard, adds optional workBlocks to BrowserClientContext, and drains its facade before runtime release. `browser-default.ts` returns consumer.workBlocks in PlatformVault. Existing optional PlatformVault property/selection in index.ts and existing workblocks.ts service need no change. UI/Workspace/mobile source excluded.

Errors preserve native names: invalid_request, invalid_workblock, stale_revision, operation_collision, client_not_admitted, stale_session, window_changed, cursor_expired, limit, workblock_failed. Preserve underlying browser storage failure distinctions. Sanitized service error includes `{code,source,commitUncertain:boolean}` (runtime currently drops this property). Pure decode/domain/stale/collision rejection or proven precommit abort=>false; lost/malformed mutation reply, timeout/worker loss or owner loss after possible durable commit=>true. Retain original immutable IDs/witness/request and never auto-rebase or invent retry identity. Reads do not imply a write. Unknown outcomes remain unknown until exact durable replay; local receipt success does not mean uploaded or all peers converged.

## 5. Nonoverlapping proposed ownership batches and dependencies

These labels identify contracts, not assigned live owners; root must grant exact files after U review. Prior W/B/H/A contacts and hashes remain in map. Sole canonical main integration stays root-owned.

| Batch | Exclusive owned files/hunks | Dependency / completion boundary |
| --- | --- | --- |
| S: shared Rust | NEW records/src/workblock_service.rs; records/src/lib.rs module declaration; NEW records/tests/workblock_service.rs | Freeze DTO/helpers with W/native owner; existing first_party.rs untouched. Native compatibility delegation deferred to N if required. |
| W: private WASM | NEW wasm/src/workblocks.rs; wasm/src/lib.rs declaration; records.rs narrow pub(crate) reuse; NEW wasm/src/workblocks_tests.rs | S API; exact structured errors, byte accounting/replay and private window session. No storage JS changes. |
| D: browser durable storage | src/core/browser-managed-records.ts; browser-sync-streaming.ts facade/type edges; browser-streaming-vault.ts WASM option type edge only if needed; tests/browser-managed-records.test.ts | W binding family; preserve transaction/common-ledger protocol; no schema/index/version hunks. No Worker files. |
| H: normal host | src/platform/browser-managed-records-registry.ts, browser-managed-records-host.ts, browser-core-worker.ts; NEW browser-workblocks-host.ts; tests/browser-managed-records-host.test.ts | W+D; shared private attachment contract; ready marker only after registration; preserve existing queue/session drain. browser-sync-worker.ts excluded. |
| P: admitted platform | NEW src/platform/browser-workblocks.ts; browser-core-runtime.ts; browser-client-admission.ts; browser-default.ts; NEW tests/browser-workblocks.test.ts | H RPC/envelope/ready flag agreed first; can prepare transport against frozen contract meanwhile. No desktop/index/core-workblocks/UI edits. |
| N: optional native compatibility | native/src/workblocks.rs pure helper delegation and focused native tests ONLY after separate W/root grant | S; no lease/session/Store preflight rewrite. Byte-equivalence evidence required if touched; not prerequisite for first browser service. |
| V: independent runtime proof | NEW tests/browser-workblocks-worker/** and corresponding results artifact/report | Frozen S/W/D/H/P assembly; no production source ownership. U reviews exact source and retained evidence. Calendar C/B/R retain separate rendered-source/verification scope. |

No overlapping lib.rs edits between batches: S owns records lib; W owns WASM lib. If type helper needs any currently excluded path/dependency, return specific hunk to root instead of expanding scope. Merge coherent reviewed batches via sole main integrator; a clean merge does not establish runtime parity.

## 6. Required evidence gates (separate claims)

1. **Focused source/contract:** Rust DTO serialization and pure helper fixtures, native reference parity vectors, canonical empty-create digest, strict nullable title, remove-ref original tags, exact journal replay BEFORE accepted/restore/quota access, collision/corrupt-journal distinction, all conflict candidates. Focused JS tests cover capture, request-bound responses (wrong commit operation, wrong read target/generation, invalid window budgets/progress/continuation, nonmonotonic changes/incorrect next), malformed mutation reply uncertainty, owner queue and drain; typecheck. If N touched, existing native+host WorkBlock checks pass unchanged. Unit doubles prove only source behavior.
2. **Actual generated WASM + strict IDB NORMAL product Worker authoring:** use actual BrowserCoreRuntime/admitted service/fixed registry/browser-core-worker, no synthetic registry substitution or external seeder authorship for claimed operations. Create/move/title/ref/delete/read/reopen; original receipt replay after newer local/remote state and restart; stale witness, target/generation collision, remove/re-add retry, rejected mutation zero partial journal/source/outbox/change writes. Exercise64-row/1MiB/31-day accounting, filtered/deleted/empty pages, oversized first row/nonconsumption, repeated/foreign/evicted/reopened cursor, unrelated-vs-same-collection watermark behavior and native-shaped changes. Hold real transactions across close/config revocation: prove drain, late commit uncertainty, no stale notification, foreground lost-hint catch-up and same-client reacquisition. Record source/glue/WASM/build digests and actual strict transaction witnesses.
3. **Independent encrypted offline convergence:** TWO normal product Workers/runtimes, distinct real IDB authorities/client leases, same authorized logical scope. Common baseline, disconnect transport, separate-field and same-range/title conflict edits, add/remove/re-add reference races, delete/edit; independent terminate/reopen then real encrypted common sync exchange. Require exact canonical state/projection/revision/candidate/tombstone convergence, unchanged original receipts/sealed bytes on restart, empty outboxes/shared cursor consistency and no receive echo. Wrong key/scope/revoked session must preserve local data/atomicity. HTTP1 evidence remains HTTP1; separately exercise supported gRPC/protobuf before claiming that path. No UI proof inferred.
4. **Later rendered browser Calendar:** separate C/B/R ownership must verify existing optional service in actual browser product UI and visual/accessibility behavior. Desktop-only Calendar/native evidence does not establish this gate. No mobile or broad browser-matrix parity claim from these bounded passes.

Existing map cites portable WorkBlock12, native5+host2, desktop42, browser storage eight actual groups, normal Worker five synthetic-consumer groups and independent adapter Worker four HTTP1 convergence groups. They establish reuse feasibility, not gate2/3 product WorkBlock completion. This documentation task runs none of those checks and authorizes no implementation.

## Frozen targeted source witness

SHA-256 `b47ad86362879f885a36bff96d0a4d4e0e1813db0bfb51cce73d8f295ff99494`, computed over sorted relative UTF-8 path + NUL + exact file bytes + NUL for each of these existing files (no generated assets involved):

- `crates/zorid-native/src/workblocks.rs`
- `crates/zorid-records/src/admission.rs`
- `crates/zorid-records/src/first_party.rs`
- `crates/zorid-store/src/managed_records.rs`
- `crates/zorid-wasm/src/records.rs`
- `src/core/browser-managed-records.ts`
- `src/core/browser-streaming-vault.ts`
- `src/core/browser-sync-streaming.ts`
- `src/core/workblocks.ts`
- `src/platform/browser-client-admission.ts`
- `src/platform/browser-core-runtime.ts`
- `src/platform/browser-core-worker.ts`
- `src/platform/browser-default.ts`
- `src/platform/browser-managed-records-host.ts`
- `src/platform/browser-managed-records-registry.ts`
- `src/platform/browser-sync-worker.ts`
- `src/platform/index.ts`
