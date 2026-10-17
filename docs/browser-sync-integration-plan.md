# Browser encrypted-sync integration: source audit

Read-only audit by browser_sync_plan, 2026-10-16. Main observed at
fbf55c07c3a28cca82c94a5cc427b2897b3c8e48; existing WASM implementation inspected
in .worktrees/core-sync-foundation (coordinator's 1a918a1 source lineage).
No builds, runtime validation or application code changes performed.

## Findings grounded in current source

* `src/core/browser-vault.ts` is IndexedDB schema 5, with strict readwrite
  transactions across metadata/content/receipts/journal/outbox/control/presentation/
  intents/checkpoint stores. Success resolves only in `tx.oncomplete`. It refuses
  nonzero old schema versions rather than silently migrating them.
* Its outbox rows are serialized LOCAL `{request,result}` receipts. These are not
  encrypted wire payloads and MUST NOT be uploaded. Current mutations do not
  author CRDT sync state. A post-save sync listener cannot repair atomicity.
* BrowserVaultWasm exposes only planMutation/checkIdempotency/validateSnapshot.
  Existing WASM additionally has raw WasmTextReplica and WasmVaultKey seal/open;
  Cargo.toml does NOT depend on zorid-client-sync. Raw Yrs alone bypasses the
  identity, actor provenance and authenticated-receive contracts.
* BrowserCoreAdapter says explicitly it has no remote-ingestion API. Runtime and
  worker only route local operations, checkpoint APIs and change hints. Each
  worker queue is local; IndexedDB transaction preconditions must coordinate
  different workers, not BroadcastChannel or a single-tab promise queue.
* `zorid-client-sync` already contains TextState, TextIdentity, AuthoredPlan,
  ReceivedPlan, plan_replace_text, plan_received_text and authenticated typed
  construction. Authored/received preconditions must run in the commit transaction.
* Native `zorid-store/src/text_sync.rs` is the integration reference: explicit
  empty binding/adoption; immutable exact-wire ledger; seal outside transaction,
  then compare-and-set a winning ciphertext; acknowledgments compare exact bytes.
* CLI transport validates raw JSON (including duplicate fields), hello negotiation,
  canonical base64, contiguous sequence, fixed high-water boundary, epoch and
  body limits before accepting a page. A browser JSON.parse replica would lose
  duplicate-field rejection unless the raw bytes reach a shared Rust decoder.
* Server `http.rs` already provides exact-origin CORS allowlist, GET/PUT and
  Authorization/Content-Type. New browser support does not require wildcard CORS.

## Required ownership and contracts

1. **Portable transport codec owner (new named scope):** extract pure hello,
   acceptance and pull-page decoding/validation from CLI transport into a
   portable Rust module (client-sync or separate module agreed with protocol
   owner). Keep reqwest in CLI. Browser passes bounded raw UTF-8 response bytes
   directly to Rust, preserving duplicate-field and integer validation. Outputs
   carry decimal-string u64s and bounded byte arrays, never JS Number counters.
   Coordinate with active text-v2/file-v2 owners; do not modify their payload
   schemas independently.
2. **WASM owner (`wasm_integration_prep`, after current preparation):** add a
   client-sync dependency and bounded synchronous wrappers for empty binding,
   replacement authoring and precondition validation; authenticated receive
   planning; protocol decoders. Receive wrapper must authenticate AND plan in
   Rust with WasmVaultKey. Do not offer a JS constructor accepting supposedly
   authenticated plaintext. Opaque authenticated handles are optional; a single
   call with exact wire, independent expected context and current state suffices.
   Expose materialization validation to audit persisted TextState on reads.
3. **Browser storage owner (new scope, coordinate admission owner):** owns new
   `src/core/browser-sync.ts` and narrow hooks/schema changes in browser-vault.ts.
   browser_adapter_review retains admission/runtime ownership until explicitly
   handed off. Share the existing transaction helper; never use an independent
   database for sync state. Add binding, text state, authored updates, immutable
   wire ledger and shared receive cursor records; prefer general family ledger
   names now so schema8 family work can extend them without two cursor systems.
4. **Browser transport owner (new disjoint scope):** new
   `src/platform/browser-sync-transport.ts`, bounded fetch transport only, plus
   test module. No editor or admission edits. Worker wiring is a subsequent
   owned integration change once browser_adapter_review hands off the seam.

## Atomic operations

### Binding and local edit

Bind an explicitly shared realm/vault/entry/bootstrap identity once; matching
paths do not establish identity. Empty binding requires exact revision and empty
bytes. Existing nonempty content must be adopted once, then its update shared;
independent seeding duplicates text. Fixture can create the same stable entry ID
on each client explicitly; this is not general namespace synchronization.

Persist replica/incarnation identity separately from local storage authority and
per-tab admission client ID. Follow native actor allocation checks, including
persisted actor provenance and collision rejection. No arbitrary actor reuse
after restore. Byte content and metadata must agree with materialized TextState.

For managed text writes: existing receipt replay first, then Rust core mutation
validation and client-sync planning inside the same strict IDB transaction.
Commit command receipt, intent outcome, metadata revision, bytes, presentation,
local change sequence, CRDT state and authored update together. Reuse the same
next revision for metadata and CRDT state. Before the family implementation lands,
managed text moves/deletes and unsupported operations must explicitly reject;
silently producing only local outbox rows would lose sync correctness.

### Upload

Read bounded pending authored records. Seal using worker-owned key outside any
IDB transaction. In a fresh strict transaction re-read immutable authored record,
scope/epoch and global ledger, then install the ciphertext only if absent; if
another worker won, return its exact bytes. Network PUT happens after durable
commit, never inside the IDB transaction. Validate acceptance with shared Rust
codec; atomically mark accepted only for the persisted exact wire. Lost reply,
worker termination or stale owner leaves the same update recoverable.

### Receive

Fetch and decode bounded page outside transaction, pinning negotiated server
epoch and page high-water. Authenticate wire before any state change; derive
expected realm/vault/key epoch from selected binding, not attacker header values.
Inside one readwrite transaction read current CRDT state, ledger and shared
cursor, run synchronous Rust receive plan/preconditions, then write merged state,
bytes, metadata/revision/presentation/change journal, exact received wire and
cursor together. No authored update is created for remote ingestion. Duplicate
wire can advance cursor without content changes. Ledger mismatch, unknown entry,
unsupported family or missing causal dependencies cannot be silently skipped.
Emit BroadcastChannel/UI notification only after transaction completion.

Never await fetch, WebCrypto or other asynchronous computation while IDB is live.
If planning happens outside IDB, full expected state/ledger/cursor must be checked
inside the write transaction and conflicts replanned, with bounded retries.

## HTTP and credentials

Use fetch `redirect:'error'`, `credentials:'omit'`, `cache:'no-store'`, an
AbortController deadline and streamed response reader with an enforced byte cap.
Check status and JSON content type before bounded raw decode; Content-Length is
not sufficient. Bound decoded bytes as well as JSON/base64 body. Do not put vault
keys or bearer tokens into URLs, localStorage, logging, error payloads or change
notifications. Pin endpoint origin and realm/vault/epoch; scope requests to it.
Test actual browser CORS preflight against an explicitly allowed fixture origin.

Initial fixture credentials can be explicitly imported into a trusted worker
session; hold key in a WasmVaultKey handle and token in worker memory, free on
close/revoke. Worker restart requires re-import/unlock while durable encrypted
outbox remains safe. This does NOT provide production credential persistence,
device enrollment or account recovery. Persistent key wrapping/storage must be
coordinated with recovery owner; ordinary IndexedDB storage of raw vault keys is
not an acceptable accidental substitute. JS copies cannot be guaranteed erased.

## Sequence that can proceed now

1. Agree binding/ledger/WASM API contracts with family-v2 and browser admission
   owners. Extract portable response codecs independently of browser persistence.
2. Implement pure Rust/WASM text planning and authenticated receive wrappers, plus
   fetch transport in disjoint files. Preserve compatibility policy for payload
   v1/v2 explicitly; do not assume active v2 changes are transparent.
3. Implement IDB text slice with exact-wire ledger and atomic mutation hook,
   based on fresh opt-in fixture databases. Explicitly reject old schema until
   reviewed migration exists. A schema bump alone must not imply data migration.
4. Wire fixture-only worker sync commands after admission ownership integration.
   Keep network waits outside normal local-operation dispatch so a slow server
   cannot stall editing. Lifecycle close must cancel fetch; ownership fences
   checked before persistence and notification. Cursor CAS protects multiple tabs
   even if both run sync sweeps; optional vault-level sync Web Lock reduces work
   but must not be the sole correctness mechanism.
5. Actual Chrome + standalone CLI + Electron-host fixture: agreed one-note identity,
   offline divergent edits, reconnect both directions, byte-identical final text,
   no echoed updates, lost ACK retry, reload and simultaneous tabs. Then integrate
   reviewed code. Editor durable consumer remains a separate acceptance gate.
6. Extend same ledger/cursor and ingress to schema8 namespace/text-v2/file-v2,
   attachment chunks, moves/deletions/conflicts and external edits. Text fixture
   is interim evidence only; full milestone still requires every file family.

## Required failure evidence

Aborted transaction before/after content write must roll back CRDT state/outbox/
cursor/receipt together. Test quota failure, stale concurrent worker, tab crash
after seal-before-upload, lost upload ACK, receive crash before/after commit,
duplicate/reordered/gapped delivery, bad AEAD, wrong realm/vault/epoch, unknown
required version, update-ID equivocation and wrong bootstrap. Browser restart
must rehydrate state from IDB, not in-memory replicas. Two offline browser stores
must converge via actual HTTP to native CLI (and actual Electron client in later
gate); two tabs sharing one IDB prove coordination, not cross-device sync.

Performance gap: existing mutation path loads all metadata AND all retained
content. Do not multiply that cost by every attachment chunk or sync item;
bound page processing and move targeted content reads into the integration work.
Current one-MiB encrypted payload cap also means arbitrary-size files cannot be
claimed from the text slice. Full binary chunk/streaming work remains required.

## Implementation stage

Portable transport codec extraction is being implemented on main-based
`tingkai-c/core-transport-codec` (base a75b6ad). Source stage only; no build,
review or runtime acceptance is claimed by this document.
