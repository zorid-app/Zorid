# Document runtime interface — S0A preparatory audit

Status: proposed interface responsibilities, not implemented APIs or milestone
acceptance. Static audit of source `776a8fd221c70a9c4ccce12c0446e85cffc7afe3`
(2026-10-18); source links below refer to that revision's paths and line locations.
Owner: `s1_execution_audit`, branch `tingkai-c/s0a-document-runtime`, worktree
`s0a-document-runtime`. No builds, app runs or performance measurements were made.

The [accepted S1 design](indexing-search-design.md#latest-user-requirements--2026-10-18)
places indexing and semantic parsing lifecycle in the shared Rust core. S0 storage
acceptance and S0A interface review still precede replacement of live consumers.
This document identifies the seam needed for that replacement. It does not change
CodeMirror ownership, CLI query behavior, source durability or mobile scope.

Implementation update (2026-10-19): the identity-free parser and scoped
extraction/key/result/binding plus bounded admission contracts are now integrated
and tested in S1.1. See [current indexing architecture](indexing.md). Native and
browser facts-persistence adapters are integrated with focused checks; matching
WASM and real-client persistence acceptance remain pending. Runtime-owned
scheduling, subscriptions and migration of feature-owned pumping below are still
unimplemented; this source-specific audit is not evidence those APIs shipped.

## Current responsibilities and callers

`DocumentService` exposes status/initialize/rebuild, begin/pump/publish/discard,
open and pin-bound metadata/search/backlinks/Base/optional Tasks queries. Its
TypeScript wrapper validates transport envelopes and identities; it contains no
Rust parser or evaluator. `catchUpDocumentIndex` nevertheless owns lifecycle
policy in TypeScript: shared maintenance per service, pump budgets, coalescing,
restarts, rebuilding, staging and publication. Work continues only while at least
one attached caller remains current. Stage state survives a bounded return, and
lost publication acknowledgements are reconciled against the published identity.
See [service contract](../../src/core/document-semantics.ts#L90) and
[maintenance implementation](../../src/core/document-semantics.ts#L183).

| Current consumer | Current lifecycle responsibility | Migration gap |
| --- | --- | --- |
| [Sidebar search](../../src/ui/workspace.ts#L1602) | Calls catch-up, owns bounded search pages/pins, checks lag after results, offers refresh/continue | Subscribe to runtime status; retain coherent old results while refresh runs; preserve paging and identity checks |
| [Bases runner](../../src/bases/shared-query.ts#L115) | Calls catch-up and requires current status before opening; cancels its own continuation | Request/query a runtime snapshot under declared freshness policy; refresh visible results from updates; keep stale action witnesses |
| [Linked mentions](../../src/ui/document-backlinks.ts#L146) | Calls catch-up, exposes continue/rebuild, owns run/pin cleanup | Subscribe to affected snapshot changes; remove feature-owned pumping/rebuild decisions |
| [Tasks controller](../../src/tasks/controller.ts#L124) | Coalesces refreshes, calls catch-up, requires current status, closes pins before reuse | Keep view refresh coalescing, move index work/coalescing into runtime; preserve pending drafts and close protocol |
| [Standalone CLI](../../crates/zorid-cli/src/documents.rs#L137) | Explicit build/rebuild resumes/pumps/publishes; read commands only query an existing published snapshot | Embed the same runtime policy for explicit builds; preserve documented read-only query semantics until a separately reviewed CLI contract change |
| [Desktop host](../../crates/zorid-desktop-host/src/documents.rs#L400) / [browser Worker](../../src/platform/browser-core-worker.ts#L152) | Dispatch low-level client-driven index operations | Host runtime lifetime and bounded execution; expose read/query/subscription operations instead of client-owned maintenance policy |

Native operations already delegate to Store and preserve retained pins; see
[native facade](../../crates/zorid-native/src/document_index.rs#L10).
The browser's IDB host has its own generation catalogue, source fences, retention
and Rust/WASM builder calls; see [browser pump](../../src/core/browser-document-index.ts#L245).
Replacing only the TypeScript helper would leave platform lifecycle policy split.

## Durable source reconciliation

A source notification wakes the runtime; it is not authority to create metadata,
apply a deletion, assign a revision or advance coverage. Native index source
identity is local-store identity plus the validated durable `local_changes` head.
The captured manifest also includes exact entry/content/presentation facts;
publication checks source, derived head and captured manifest again. See
[source capture](../../crates/zorid-store/src/document_index.rs#L383) and
[publication fences](../../crates/zorid-store/src/document_index.rs#L516).
Watermark equality alone must not replace these existing compound checks.

Existing native [listing/change APIs](../../crates/zorid-store/src/presentation.rs#L345)
and [native facade](../../crates/zorid-native/src/native.rs#L169) provide durable
reconciliation inputs. Desktop [polling](../../desktop/core-vault-fixture-service.cjs#L155)
handles a typed journal discontinuity with a coherent full listing; it does not
skip arbitrary corruption. Its [subscription and scanner](../../desktop/core-vault-fixture-service.cjs#L119)
are currently activated by listeners. Runtime liveness cannot depend exclusively
on whether a particular search view subscribes to these existing UI events.

The browser [refresh path](../../src/platform/browser-core-worker.ts#L54) reads
`changesSince(sequence)` after strict commits and after sync callbacks.
[BroadcastChannel hints](../../src/platform/browser-core-worker.ts#L117) are
serialized with operations; [visibility repair](../../src/platform/browser-core-runtime.ts#L64)
refreshes committed state after possible lost hints. Incoming hints are not trusted
source data. [CLI watch](../../crates/zorid-cli/src/watch.rs#L112) separately performs
bounded external discovery/reconciliation and optional sync.

Proposed runtime flow:

1. Attach to one admitted local authority and reconcile its durable source state
   against retained derived state before declaring freshness. Adopt no caller path
   or JSON snapshot as a query capability.
2. Receive commit/reconcile/version/wake hints and read actual durable changes.
   Include editor saves, independent CLI commits, sync application, externally
   imported content, rename/delete and presentation changes relevant to queries.
3. Coalesce work by stable identity and exact content/extraction dependencies.
   Preserve the current complete generation while preparing its successor. A new
   source change makes obsolete work ineligible to publish, even if extraction
   remains reusable as content-derived cache data.
4. Capture immutable bounded inputs, perform pure extraction outside database
   transactions, bind results to the captured witnesses, then publish only after
   coordinated source/head/epoch checks. No worker result supplies write authority.
5. On restart, reconnect, foreground/wake or journal discontinuity, reconcile again.
   A bounded host wake/checkpoint mechanism must repair missed notifications even
   if no new event arrives. Never infer unseen deletion from incomplete discovery.

The runtime owns retry/coalescing policy. The platform owns how it wakes a
suspended process or reports an unavailable capability. A one-shot CLI can stop at
its declared budget and report incomplete progress; this does not require a daemon.
Separate processes can host separate runtimes: source/cache coordination and
publication CAS remain decisive, not a mandatory single global runtime process.

## Proposed consumer seam

The following are responsibilities to settle at S0A, not new exported signatures:

| Operation | Required behavior |
| --- | --- |
| Observe runtime state | Return authority identity, observed durable source, published snapshot/covered source, semantic versions, freshness, build progress, explicit coverage and recoverable availability state |
| Subscribe | Deliver versioned invalidations/progress/publication hints; allow unsubscribe; never carry mutable source buffers or synthetic revisions |
| Request freshness / explicit maintenance | Express foreground demand or an explicit bounded build/rebuild; runtime selects and schedules work; waiting is cancelable without erasing source commits |
| Open query snapshot | Admit a retained immutable generation with explicit freshness/coverage; return an owned pin with the existing exact-snapshot query semantics |
| Release runtime/client | Revoke admission, cancel uncommitted derived work, drain admitted operations, close owned pins/subscriptions and return an acknowledged release outcome |
| Analyze draft | Separate transient request keyed by buffer identity/revision and parser versions; return no durable shared-index publication |

Subscribe and initial observation need a handshake: registration plus a versioned
state observation (or equivalent atomic host admission) must close the race where
publication occurs between a status read and listener registration. Subscribers
detect skipped/reordered notification versions by reobserving state; notifications
need not be a durable replay log. After reconnection, old subscription handles
cannot authorize the new lifetime. A source commit remains successful if an
observer fails or disappears.

UI consumers keep the last coherent result while updating. On publication they
requery affected visible data; an invalidation may conservatively cover the whole
generation until narrower dependencies are proved. Search/Bases/backlinks/Tasks do
not implement their own indexing retry timers. Navigation/mutations continue to
validate current stable identity/revision rather than trusting old result paths.
An update event must never overwrite a dirty NoteBuffer.

First-build coverage needs an explicit reviewed representation: current
[GenerationBuilder::finish](../../crates/zorid-index/src/generation.rs#L340) requires
a terminal record for every file. Missing rows cannot simply become a published
complete generation. Coherent partial results need declared indexed/unindexed
coverage and truthful counts, separately from source/extraction exclusions.

## Typed work and cache boundary

Use the S0A caching interface for lookup/store/eviction and platform persistence;
clients do not access cache tables or choose eviction policy. Reusable parse facts
are distinct from identity/path/revision/publication envelopes. Current
[DocumentMetadata](../../crates/zorid-document/src/types.rs#L152) embeds entry ID and
revision, while [IndexRecord::rebind_unchanged](../../crates/zorid-index/src/generation.rs#L166)
only admits unchanged entry state in the same store. Arbitrary content-hash reuse
therefore needs explicit typed extraction and binding, not edited serialized IDs.

Required work/cache inputs and validation:

- Content-derived key: scoped authority/cache domain, exact content digest and
  byte length, extraction mode, parser/dialect/schema versions and any other
  extraction configuration. Identical bytes renamed `.md` to `.txt` can select
  different extraction modes. Cross-vault sharing is not authorized by hash equality.
- Pure job: opaque job/lifetime identity, bounded owned source bytes, versioned
  extraction request and cancellation/budget inputs. Workers receive no Store
  connection, path-write capability or active database transaction.
- Result: typed content-derived facts/diagnostics, versions and key correlation.
  A separate validated binding step supplies the captured entry witness. Cache
  hits undergo the same bounded structural/content checks as equivalent misses.
- Cache outcomes distinguish hit, miss, unsupported version and unavailable or
  corrupt optional cache. Recompute supported facts when safe; do not turn a
  missing index into lost source or silently treat source corruption as a miss.
- Derived parse/search state is disposable and bounded. Recovery, unsent edits and
  receipts are outside this cache. Existing
  [checked schema/scope](../../crates/zorid-store/src/document_cache.rs#L52) and
  [cache→authority lock/snapshot order](../../crates/zorid-store/src/document_cache.rs#L106)
  remain required through schema evolution and new cache operations.

Query preparation reuse also retains complete dependency keys: generation,
semantic versions, Base bytes/configuration/view, file presentation, relationship
facts, current entry and captured time/timezone as relevant. A cached answer must
not bypass invocation budget/cancellation checks or keep generations pinned without
bound. Cache reuse is never source mutation authorization.

## Execution capabilities and cancellation

Core selects priority, coalescing, invalidation and job admission. Platforms supply
bounded execution and completion delivery, available-memory/core/power hints,
clock/timer/wake and suspend/release signals. These capabilities describe actual
availability; they promise no measured speedup. Native threads and browser Worker
pools are alternative executors for the same pure Rust extraction semantics.
Browser workers use transferable bounded inputs/results with version/job fencing;
this design does not require SharedArrayBuffer or a production SQLite/OPFS VFS.
Small jobs can run sequentially where worker overhead outweighs benefit.

Native desktop currently permits [one in-flight host request](../../desktop/rust-vault-service.cjs#L344).
Browser [dispatch](../../src/platform/browser-core-worker.ts#L252) uses one operation
tail. A large synchronous query or pump can therefore delay saves. Adding workers
inside one synchronous pump is insufficient to prove interactive priority. Runtime
execution must return control between bounded source/commit steps and provide a
control/completion lane that can admit cancellation while pure work executes.
Do not bypass storage/receipt serialization merely to add concurrency.

The evaluator already has
[OperationCancellation](../../crates/zorid-bases/src/lib.rs#L136) and cooperative
[expression checks](../../crates/zorid-bases/src/expression.rs#L444). Exposing those
hooks requires actual cross-executor signaling and lifetime ownership; dropping a
UI continuation is not computational cancellation. Cancelling a query never rolls
back a durable save. Cancelling derived work cannot publish stale results, and
late completions must be fenced even when execution cannot stop immediately.

Existing query pins own an exact retained snapshot and cursors remain query/pin
bound. Do not silently substitute a newer head on expiry. Keep pin close from
overlapping an admitted read where the platform contract forbids it; failed close
acknowledgements retain ownership until retry or acknowledged client release.
Runtime shutdown must distinguish optional derived-work cancellation from pending
source-edit flush/receipt recovery, which retains the S0 close protocol.

## Committed semantics and transient editor analysis

The committed runtime indexes successful durable saves. Draft metadata uses a
separate request namespace including editor/buffer lifetime and monotonic buffer
revision; stale replies are dropped and cached parse facts can be reused only
through the same validated content-derived boundary. Unsaved results cannot
replace committed search/Bases rows or supply a durable edit witness.

Current TypeScript [MetadataCache](../../src/core/metadata.ts#L74) still parses
metadata for legacy/editor consumers, and
[Vault initialization](../../src/core/vault.ts#L100) indexes loaded Markdown.
[NoteBuffer](../../src/ui/note-buffer.ts#L20) owns dirty/save state;
[workspace buffer updates](../../src/ui/workspace.ts#L1275) preserve immediate editor
changes and view revisions. Migrating semantic consumers needs a consumer inventory
and explicit asynchronous pending/stale behavior. CodeMirror syntax trees,
rendering, selections, composition and undo remain editor owned.

## Acceptance flows before live replacement

| Flow | Required evidence |
| --- | --- |
| Save while query/index work runs | Exact durable save/receipt remains responsive within measured budgets; no source lock held during pure parsing; obsolete completion cannot publish |
| CLI/sync/external change with visible search/Base | Durable source advances; runtime catches up without a feature invoking pump; old result remains coherent; next result carries correct new witnesses |
| Lost event/restart/suspend | Reconciliation catches changes without another commit; duplicate/reordered hints cannot regress state or manufacture deletion |
| Cache restart/clear/corruption/version change | Verified reuse or bounded recomputation; source, receipts, pending edits and recovery remain exact; unsupported schema is handled through checked ownership policy |
| Rename/duplicate bytes/change extraction mode | Reuse content facts only when key permits; bind current path/identity/revision; preserve resolution and mutation guards |
| Rapid draft edits then commit | Latest buffer revision wins transient display; no draft enters shared index; dirty editor is not overwritten by commit notifications |
| Cancel/close/release with late work | Ownership/pins drain or remain explicitly recoverable; cancelled derived jobs cannot publish; admitted source commit is not erased |
| Initial build and ongoing changes | Partial coverage/counts are explicit; missing rows are not deletion; coherent old generations remain queryable until valid replacement/expiry |
| Native and browser executors | Same semantic corpus and witness checks; bounded worker resources/cancellation tested in real bindings; platform performance reported separately |

The interface gate is ready only after source ownership, notifications and
reconciliation, typed cache/work contracts, query/pin lifetime and these flows have
reviewed contracts. Implementation and measured performance remain S1 deliverables.
