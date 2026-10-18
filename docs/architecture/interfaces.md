# Module interfaces and consumer contracts

[Architecture](README.md) · [Roadmap S0A](../roadmap.md#s0a--modular-interfaces-and-feature-consumer-contracts)

## Purpose and current status

Features need clear service boundaries, not knowledge of where tables or caches
live. The user requests an explicit interface review stage for storage, indexing
and caching. This is a preparatory S0A inventory of source `776a8fd2` and its review
checklist, not a finished new API or proof that existing bindings satisfy the gate.
S0 remains open; this documentation does not accept S0A or advance feature/iOS work.
The explicitly labeled planning-error addendum below inspects post-baseline
desktop change `627dd8e4`; it is not silently included in the `776a8fd2` inventory.

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

## Named S0A gaps and core lifecycle ownership

The user has requested core-owned semantic parsing/indexing lifecycle. The
[document runtime proposal](document-runtime-interface.md) supplied in `97023f9`
records proposed responsibilities, not existing exported APIs. This inventory
keeps the following decisions and migrations open:

| Gap | Current source fact | Responsibility to settle at S0A |
| --- | --- | --- |
| Document runtime lifetime | [catchUpDocumentIndex](../../src/core/document-semantics.ts#L183) owns TS maintenance/coalescing/pump/rebuild policy; feature callers request it; native/browser hosts dispatch low-level operations | Shared Rust runtime owns semantic work admission, invalidation, coalescing, freshness/progress and bounded publication. Platforms own execution/wake/suspend/release capabilities; features request snapshots and refresh presentation. Reconciliation must work without a visible search pane |
| Observation and reconciliation | Vault subscriptions and worker hints exist; DocumentService has status but no runtime subscription handshake | Define initial observe+subscribe race closure, missed/reordered hint repair, independent CLI/sync/external change catch-up and retained-result refresh. Notifications cannot invent source state or overwrite dirty drafts |
| Typed parse/cache work | Native persistence is separated; current metadata rows still bind entry ID/revision. No shared pure-work/cache capability is exported | Review content-derived facts vs source-bound envelopes, semantic key inputs, bounded owned jobs/results, persistence/eviction and miss/corruption handling. Cache hits cannot supply mutation authority; no generic SQL framework is implied |
| Cancellation and scheduling | Features fence stale continuations, discard stages and close pins; native host requests/browser operation tails can still execute synchronous bounded work | Define executor/lifetime fencing and cooperative cancellation that can be admitted while work runs; prioritize interactive source work without bypassing commit/receipt serialization. Dropping a continuation is not CPU cancellation |
| Planning-error provenance | Post-baseline `627dd8e4` reconstructs `DurableWritePlanningError` only after a validated desktop planWrite envelope. NoteDurableState marks a definite inert `revision_conflict` as conflict only for that class. Browser [planWrite](../../src/platform/browser-durable-writes.ts#L106) instead throws BrowserVaultError for its local identity/revision check after reading through the worker; it does not construct the shared planning class | DurableWrites contract owner plus desktop/browser binding owners must align verified planning-rejection provenance and editor handling. Preserve the distinction from failed/unknown transport and commit/ACK uncertainty; do not classify errors by code alone. This browser planning rejection alone retains the draft as a save failure rather than establishing the same explicit conflict/recovery UI; no browser fix or all-platform completion is claimed |
| Binary convenience bypass | [defaultBrowserAdapter.binary](../../src/platform/browser-default.ts#L43) and its createBinary/writeBinary exports do not acquire Vault's transfer FIFO. No current first-party production direct caller was found; normal Vault/import/embed paths choose streams | Decide whether to route or narrow this surface before adding consumers. Current scheduling does not promise serialization for arbitrary direct low-level callers |
| Feature query reach | Shared TS queries expose metadata/search/backlinks/Bases/optional Tasks; WorkBlockService supports Calendar records, while richer Calendar join is native-only at this seam | Document supported binding coverage and unsupported operations explicitly. Complete Calendar/Google and native mobile delivery stay in their milestones; do not claim parity from core endpoints |
| Remaining TS semantics | [MetadataCache](../../src/core/metadata.ts#L74) and Vault still parse metadata for editor/legacy consumers; CodeMirror owns syntax/rendering/selection/IME/undo | Inventory each committed vs transient semantic consumer before migration. Rust semantic ownership does not move CodeMirror editing or rendering into the data core |

For the planning addendum, the [desktop preload](../../desktop/preload.cjs) and
shared [DurableWrites](../../src/core/durable-writes.ts) /
[NoteDurableState](../../src/ui/note-durable-state.ts) changes are inspected at
`627dd8e4`; browser behavior is read from this inventory baseline. No data loss is
inferred from the different error classes.

These are bounded interface review items, not approval to replace live consumers
before S0 exits. The proposal retains independent CLI runtimes, committed-source
queries, protected unsent edits and platform-specific storage. Its acceptance
flows cover late results, restart/missed events, cache rebuild and query pins;
implementation and measured performance are separate S1 work.

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
standalone local workspace, as the browser contract explains. Protect pending writes separately from refetchable cache; browser storage
is not a native vault directory and need not use OPFS. Rust owns shared semantics;
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
