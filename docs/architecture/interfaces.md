# Module interfaces and consumer contracts

[Architecture](README.md) · [Roadmap S0A](../roadmap.md#s0a--modular-interfaces-and-feature-consumer-contracts)

## Purpose and current status

Features need clear service boundaries, not knowledge of where tables or caches
live. The user requests an explicit interface review stage for storage, indexing
and caching. This page inventories current contracts at integrated source
`0bbeb61b`, plus the independently reviewed binary admission extension
`b843d4da`, and records the bounded S0A review disposition below. Desktop/browser
planning fixes are included in the baseline; the binary extension requires its
coordinator integration/checks before delivery. It does not establish browser/
mobile runtime parity, a new public API or S1 implementation. S0 is the prerequisite;
only the coordinator's execution record can accept the milestone against its
integrated verification evidence.

Review storage contracts during S0 design, then check the system-wide consumer
contracts before optimizing internals or resuming dependent features. Start with
existing Rust/TypeScript interfaces and concrete uses. No speculative general
plugin framework, arbitrary SQL endpoint or new API syntax is selected here.

## Current supported operations and consumers

These are implemented source surfaces, not claims of complete feature delivery or
platform parity. Optional capabilities must be admitted by the selected platform.
No single generic interface is required to expose every capability below.

| Current boundary | Supported operations and result identity | Actual consumers and limits |
| --- | --- | --- |
| [VaultAdapter](../../src/core/types.ts#L21) / [Vault](../../src/core/vault.ts) | List/stat/read, ordinary text/binary creation and edits, folders, witnessed rename, trash/remove and change subscription; optional capabilities remain explicit | Editor, file tree, Base file edits, Task note edits, embeds/Canvas and attachment import. Paths locate entries; admitted edits also retain stable entry/revision witnesses. A general undelete/restore operation is not in this adapter contract |
| [DurableWrites](../../src/core/durable-writes.ts#L55) and [editor state](../../src/ui/note-durable-state.ts) | Coherent text reads; plan, prepare, commit, query, list unacknowledged and exact-outcome acknowledgment; scoped checkpoint CAS | NoteBuffer owns drafts and original plan/ref/outcome persistence. Tasks edits use ordinary NoteBuffer flush. A queued editor update is not durable success |
| [BinaryStreams](../../src/core/binary-streams.ts#L45) and [transfer helpers](../../src/core/binary-transfer.ts) | Begin/append/query/seal/commit/abort stages; open/read/close retained reads; exact operation/entry/content-event identity, bounded chunks and decimal lengths | Vault, attachment resources/import, native/browser consumers. Receiving/sealed stages are inert; unknown commits retain original stage identity. Convenience small reads have a declared size ceiling |
| [Native managed Store](../../crates/zorid-store/src/managed_records.rs#L388) / [browser managed host](../../src/core/browser-managed-records.ts#L246) | Trusted schema registration, opaque scoped handles, snapshots, revision-checked apply, change watermarks/pages, export and unresolved-receipt retry | First-party WorkBlocks and sync admission. Portable `zorid-records` supplies semantics; Store/IndexedDB owns transactions. These are internal host APIs, not an arbitrary renderer collection/SQL endpoint |
| [WorkBlockService](../../src/core/workblocks.ts#L21) | Create/read/window pages; move/title/addRef/removeRef/delete; bounded changes after a collection watermark | Calendar UI and native/browser bindings. Record+generation and operation IDs are opaque; task references are file IDs. [CalendarController](../../src/calendar/controller.ts#L13) retains exact pending mutations and polls changes while subscribed |
| [Native recovery](../../crates/zorid-native/src/local_recovery.rs#L13) / [RecoveryStore](../../crates/zorid-recovery/src/lib.rs#L177) | Host-enabled local capture/dedupe/retention, bounded maintenance, entry-scoped list/read | Desktop save/startup maintenance and optional [RecoveryHistory](../../src/platform/bridge.d.ts#L12). Version preview is read-only; [restore](../../src/ui/workspace.ts#L2116) uses ordinary guarded NoteBuffer saving. No separate force-write restore or browser/mobile history parity is exposed |
| [Native document cache](../../crates/zorid-store/src/document_cache.rs#L12) / [browser index cache](../../src/core/browser-document-index.ts#L97) | Scoped/versioned index catalogue, generations, retained rows/pins and explicit rebuild through document services | Rust extraction/index/query hosts, desktop and CLI; browser has its own IDB host. Native cache is separate app-local SQLite with optional startup memory fallback; browser derived keys share the authority database. There is no public generic cache get/put/evict API |
| [DocumentService](../../src/core/document-semantics.ts#L90) / [native facade](../../crates/zorid-native/src/document_index.rs#L10) | Status/initialize/rebuild, begin/pump/publish/discard and open retained query pin | Sidebar search, Bases runner, linked mentions, Tasks and standalone CLI. Current TS catch-up policy drives low-level lifecycle; the proposed core runtime is not yet implemented |
| [DocumentPin](../../src/core/document-semantics.ts#L78) | Exact snapshot/source/coverage; metadata, paged literal search/backlinks, Base evaluation and optional Task query; explicit close | [Search](../../src/ui/workspace.ts#L1643), [Bases](../../src/bases/shared-query.ts#L115), [backlinks](../../src/ui/document-backlinks.ts#L146), [Tasks](../../src/tasks/controller.ts#L124). Native Rust also exposes resolution/query capabilities below this TS surface; no general Calendar join method is in DocumentService |
| [Native Calendar join](../../crates/zorid-native/src/calendar.rs#L516) | Bounded task/Base selection, WorkBlock window/membership and link labels with document snapshot, WorkBlock watermark, coverage and diagnostic evidence | Native host-facing API; the shared TS Calendar view currently consumes WorkBlockService. The join explicitly observes two sources, not a cross-Store atomic snapshot. Complete joined UI and Google provider operations are not established by this API |
| [Shared sync](sync.md) and [CLI](../../crates/zorid-cli/src/main.rs) | Scoped authored/received changes, retained outbox/receipt/cursor state, explicit remote acknowledgment; CLI embeds its own core for file lifecycle, read/write/search, rescan/recover/watch and explicit document-index commands | Desktop/browser/native hosts and independent CLI processes. Sync uses source/managed operations, not local history/cache databases. [CLI document queries](../../crates/zorid-cli/src/documents.rs#L137) do not implicitly build missing indexes |

Task notes remain ordinary files interpreted through Type definitions. Managed
records do not make Task rows independently authoritative. Providers need their
own reviewed authorization/mapping/reconciliation contract; no implemented Google
provider was found in this inventory. See [managed data](managed-data.md).

## Current transaction, result and lifetime contracts

| Boundary | Current contract | Review implication |
| --- | --- | --- |
| Source mutation and consumer recovery | Persist exact plan before prepare, returned ref before commit, settled outcome before acknowledgment. Prepared records are inert; failed checkpoints forbid advancing. Native/browser authority transactions couple source state with their receipt/outbox/publication metadata | Local durability, physical file projection, consumer acknowledgment and relay acceptance remain different outcomes. Unknown receipt/transport failures require original IDs; never silently replan or rebase |
| Native source/cache separation | [DocumentTransaction](../../crates/zorid-store/src/document_cache.rs#L106) reserves/pins cache before authority, commits cache before releasing authority, and rechecks publication witnesses | Cache may lag observed source. This is not cross-database crash atomicity, and cache contention must not reserve the authority while waiting. Cache errors must not turn an authoritative save into a failed source mutation |
| Browser persistence | Strict IndexedDB transactions settle on completion; source/receipts/outbox share the authority while index keys are a logical disposal class | [Browser storage contract](browser-storage-contract.md) records scopes, local vs remote ACK, slots/leases, release/pagehide limits and protected pending data. A whole database reset is not a cache-clear operation |
| Managed mutation | Native [managed_apply](../../crates/zorid-store/src/managed_records.rs#L482) validates the admitted handle/revision and retains original local operation receipt in its transaction; browser uses its guarded IDB host | Preserve registration, realm/vault/collection/record/generation and exact operation identity. Unresolved receipts/conflicting candidates remain observable; an empty/incomplete query is not evidence of absence |
| Query snapshots | Snapshot/source/version/coverage travel with results; continuation belongs to the retained pin/query. [Wrapper](../../src/core/document-semantics.ts#L134) validates envelopes and bounds; host APIs retain owned pins | Expired/rebuild-required/source-changed/unavailable are different from no matches. Pin close is owned and retryable; callers must not silently substitute the newest head or overlap close with an admitted read |
| Recovery snapshots | Separate optional local database; capture failure is best effort relative to authoritative save. List/read require entry identity; UI restore revalidates the clean current buffer | History is not synced, not disposable index data, and not a universal capture of every error/keystroke. Missing capability and stale/dirty/conflicted restoration stay explicit |
| Transfer admission | [Whole-transfer FIFO](../../src/core/binary-transfer-queue.ts) uses exact BinaryStreams identity; Vault captures input/identity before waiting and leaves pin/body I/O outside its metadata/text queue | Aliased Vault wrappers and platform binary recovery share the reservation. Rejection advances it; read failure closes its pin and aborts private output; retirement must preserve uncertain staged writes |
| Client/platform release | [Workspace](../../src/ui/workspace.ts#L422) flushes source consumers, retires feature views/pins and awaits platform release; [desktop](../../src/platform/index.ts#L95) drains admitted capabilities before host context release; [browser](../../src/platform/browser-client-admission.ts#L174) has guarded flush/drain/retry phases | Source edits/receipts cannot be discarded with derived work. Failed close/unknown release stays owned until reconciled; successful backend release is the final cleanup acknowledgment. Runtime shutdown is not just dropping UI callbacks |

The lower-level interfaces have domain errors rather than one shared generic
exception contract. Preserve codes and commit uncertainty where provided. Examples
include source revision/identity conflicts, binary retained-stage/publication
failures, managed stale revision or operation collision, document snapshot expiry /
rebuild-required / unsupported budgets, and unavailable optional history. UI copy
can be ordinary language while diagnostics retain the original evidence.

## Reviewed contracts, future seams and core lifecycle ownership

The user has requested core-owned semantic parsing/indexing lifecycle. The
[document runtime proposal](document-runtime-interface.md) supplied in `97023f9`
records proposed responsibilities, not existing exported APIs. This inventory
separates current contract corrections from later implementation:

| Review item | Current source fact | Disposition and implementation owner |
| --- | --- | --- |
| Document runtime lifetime | [catchUpDocumentIndex](../../src/core/document-semantics.ts#L183) owns TS maintenance/coalescing/pump/rebuild policy; feature callers request it; native/browser hosts dispatch low-level operations | Reviewed target: shared Rust runtime owns semantic work admission, invalidation, coalescing, freshness/progress and bounded publication. Platforms own execution/wake/suspend/release; features request snapshots/refresh presentation. S1.1/S1.4 implement this lifecycle, including reconciliation without a visible search pane |
| Observation and reconciliation | Vault subscriptions and worker hints exist; DocumentService has status but no runtime subscription handshake | Reviewed requirements: initial observe+subscribe race closure, missed/reordered hint repair, CLI/sync/external change catch-up and retained-result refresh. S1.1/S1.4/S1.5 implement these; notifications cannot invent source state or overwrite dirty drafts |
| Typed parse/cache work | Native persistence is separated; current metadata rows still bind entry ID/revision. No shared pure-work/cache capability is exported | Reviewed requirements: content-derived facts vs source-bound envelopes, semantic key inputs, bounded owned jobs/results, persistence/eviction and miss/corruption handling. S1.1 implements extraction/work persistence; S1.2 adds query reuse. Cache hits cannot supply mutation authority; no generic SQL framework |
| Cancellation and scheduling | Features fence stale continuations, discard stages and close pins; native host requests/browser operation tails can still execute synchronous bounded work | S1.4 implements the reviewed executor/lifetime fencing and cooperative cancellation admitted while work runs, preserving interactive source priority and commit/receipt serialization. Dropping a continuation is not CPU cancellation |
| Planning-error provenance | Desktop validates its planWrite envelope before reconstructing DurableWritePlanningError. Browser [planWrite](../../src/platform/browser-durable-writes.ts#L107) emits that class only for explicit identity/revision/decoded-content mismatch after a successful coherent read. NoteDurableState marks a definite inert revision_conflict only for that class | Current source gap resolved by `627dd8e4` / `75ec1737`; desktop/browser binding owners preserve this provenance contract. Backend/transport/quota/decoder errors remain unchanged, and commit/ACK uncertainty must not be reclassified by matching a code string. Focused provider-to-buffer checks do not establish actual browser runtime |
| Binary convenience admission | Independently reviewed `b843d4da` routes [defaultBrowserAdapter.binary](../../src/platform/browser-default.ts#L43) createBinary/writeBinary through the same exact-stream FIFO as Vault/recovery, including retained-stage/error reconciliation. Bytes/IDs, immediate scalar metadata selection and same-request deduplication are preserved | Current source seam closed by the extension; coordinator integration/checks remain delivery evidence. [Focused adapter checks](../../tests/browser-default-adapter.test.ts) cover active Vault reads, replacement paths, input mutation, held initial/retry outcome queries and rejection release. Arbitrary raw BinaryStreams callers still own their low-level sequencing; this is not actual browser runtime acceptance |
| Feature query reach | Shared TS queries expose metadata/search/backlinks/Bases/optional Tasks; WorkBlockService supports Calendar records, while richer Calendar join is native-only at this seam | Current coverage is explicit above. S6 owns joined Calendar bindings/UI, S7 Google and S11 native mobile delivery; do not claim parity from core endpoints |
| Remaining TS semantics | [MetadataCache](../../src/core/metadata.ts#L74) and Vault still parse metadata for editor/legacy consumers; CodeMirror owns syntax/rendering/selection/IME/undo | S1.1/S1.4 migrate inventoried committed/transient semantic consumers behind the reviewed runtime seam. Rust semantic ownership does not move CodeMirror editing or rendering into the data core |

## Review disposition and later implementation ownership

The operation matrix and existing semantic boundaries have been source reviewed.
This is a contract gate, not a request to implement every future capability before
S1. Representative checks live beside the current consumers; their exact passing
source, scenario evidence and remaining limitations belong in the
[execution checkpoint](../deferred-product-roadmap.md), not an inferred all-platform
acceptance from this table.

| Review area | Current disposition / boundary evidence | Remaining owning milestone |
| --- | --- | --- |
| Files, durable edits, receipts and external/CLI coordination | Vault/DurableWrites and native projection/reconciliation own source mutation; UI consumes typed capabilities. [Planning](../../tests/browser-note-planning.test.ts), [durable recovery](../../tests/note-buffer-durable-recovery.test.ts) and [actual desktop/CLI harness](../../tests/storage-electron-integration/concurrency.mjs) exercise those boundaries | Current source/receipt/lifecycle fixes are S0. Complete file history, undelete/admin and broader restoration remain S12 |
| Captured namespace responsibility and local snapshots | Native replay uses exact physical proof and [explicit successor delegation](../../crates/zorid-store/src/family_namespace_successor.rs), preserving predecessor evidence/competing bytes. History capture is separate and restore uses the normal save path; [history service/UI checks](../../tests/version-history.test.ts) retain identity/dirty/stale guards | Current recovery guarantees and actual native evidence are S0; this does not authorize sweeping unknown artifacts or native/mobile history parity |
| Binary transfer ownership | Vault owns complete transfers on the exact streams FIFO; reviewed `b843d4da` extends that ownership to direct browser adapter conveniences and uncertain-result queries | Current S0A source seam resolved by the reviewed extension, subject to integration/checks; no new S1 executor or browser-runtime claim |
| Existing document query lifecycle | DocumentService/Pin has explicit stage/source/version/coverage and close ownership; [maintenance](../../tests/document-maintenance.test.ts), [Bases binding](../../tests/bases-document.test.ts), [Tasks binding](../../tests/task-document-binding.test.ts) and [backlinks](../../tests/document-backlinks.test.ts) check representative typed consumers | Shared-core automatic maintenance, update subscription/reconciliation and migration of feature pumping are S1.1/S1.4; first-build/freshness/time refresh is S1.5 |
| Cache isolation and safe rebuild | Native cache reserves before authority; browser rebuild is prefix-scoped. [Native index storage](../../crates/zorid-store/tests/document_index.rs) and [browser index checks](../../tests/browser-document-index.test.ts) cover current source fences, retained pins and rebuild behavior. Features do not access private index/DB tables | Typed content-derived parse/work contracts and new persistence/reuse are S1.1; query preparation/answer caches S1.2; bounded executor/cancellation S1.4. Missing generic cache API is not a reason to invent a SQL framework |
| Managed records and feature reach | Scoped registration/handles, revisions, receipts, bounded changes and WorkBlockService are current host boundaries; [managed intent checks](../../crates/zorid-store/tests/managed_intents.rs) and [browser managed checks](../../tests/browser-managed-records.test.ts) exercise them. Rich Calendar join is not advertised by DocumentService | Managed consumer extensions S3; complete desktop Types/Bases S4, Tasks S5, joined Calendar S6, Google authorization/provider mapping S7 |
| Native/browser/CLI platform scope | [Browser contract](browser-storage-contract.md) explicitly separates local authority, sync group, pending state and disposal. CLI embeds native core; platform capabilities omit unsupported operations rather than selecting a replacement authority | Web connection/bootstrap/eviction/key-retention product policies S10; iOS runtime/feature delivery S11 after desktop completion. No broad browser/mobile runtime gate is passed here |

The [document runtime proposal](document-runtime-interface.md) defines the accepted
review requirements for work/cache keys, immutable binding, source reconciliation,
observe/subscribe race closure, owned query pins and late-result fencing. Exact
exported job/executor signatures will be implemented and rechecked in S1.1/S1.4
against their first consumers; the proposal is not an existing capability. Immediate
CodeMirror syntax/rendering stays editor-owned; S1 migrates shared semantic parsing
and transient draft analysis with separate buffer revisions.

S0A can close after S0 acceptance, integration/checks of the reviewed binary
admission extension, independent review of this matrix/contracts and a
coordinator record of the exact representative evidence. Future-owned capabilities above remain unsupported until
their owning milestone implements and verifies them. This contract acceptance
cannot be used as browser/mobile runtime, complete feature or performance acceptance.

## What every interface must explain

- **Ownership and identity:** who allocates/releases handles; vault/group/client/
  entry scope; immutable captured revision and request identity across awaits.
- **Success:** local durability, file publication and remote acknowledgment are
  distinct. Define pending, rejected and unknown outcomes and safe retry rules.
- **Atomicity:** which related changes commit together; reads/snapshots and conflict
  checks; ordering/retry across different databases. No implicit global transaction.
- **Results and limits:** bounded queries/streams, pagination/continuations, retained
  snapshot freshness, source coverage and invalid/missing capability reporting.
- **Lifecycle:** subscription delivery/unsubscribe, cancellation, draining/release,
  vault switches, shutdown/suspension and stale callbacks. Cancellation after a
  commit cannot pretend the mutation never occurred.
- **Failures:** cache miss versus source absence, busy/quota/I/O versus conflict,
  authorization errors and uncertain commits. Avoid lossy error conversion.
- **Versioning:** schema/parser/query versions, invalidation/rebuild and any
  compatibility the actual released consumers need; no speculative legacy layers.

## Index and cache boundaries

Keep pure extraction reusable; hosts provide source and publish generation results.
Parallel workers return revision-bound data; features consume coherent query
snapshots rather than scanning private tables or mixing generations. Retained
query pins must be released, and progress/cancellation must be observable.

Cache keys include all semantic inputs such as content hash and parser/schema/
options, with vault/scope isolation where needed. Cache clearing must not remove
source, unsent edits, uncertain receipts, provider mappings or retained history.
Cache failures must not prevent source saves. Define what can be regenerated and
how stale/corrupt entries trigger bounded rebuild rather than false empty results.

## Platform boundaries and proof

Desktop and native iOS data services use SQLite; that does not establish
identical feature/binding coverage or mobile lifecycle acceptance. The browser
product target joins an existing sync group and retains local working data/indexes
between visits for incremental catch-up; its current default opener remains a
standalone local workspace, as the browser contract explains. Protect pending
writes separately from refetchable cache; browser storage is not a native vault
directory and need not use OPFS. Rust owns shared semantics;
platform bindings
adapt execution and storage capabilities without implementing another parser,
query engine or sync policy. CLI remains an independent consumer of the native core.

Use existing consumers to prove boundaries: editor save/reopen and change delivery;
a Base or search query retaining/closing a snapshot; clearing/rebuilding cache while
source remains intact; record mutation and subscriber observation; native CLI/app
coordination. Reuse valid existing checks and add only tests that expose real contract
violations. This gate does not require starting unfinished iOS implementation or
pretend every future provider capability is already delivered.

Document concrete signatures/behaviors in [storage](storage.md), [SQLite](sqlite.md),
[saving/recovery](saving-recovery.md), [indexing](indexing.md), [search](search.md) and
[managed data](managed-data.md). Record actual owners, gaps, changes and acceptance
evidence in execution records. Later features extend these contracts only with
reviewed consumer needs; they do not bypass them when a capability is missing.
