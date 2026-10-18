# Module interfaces and consumer contracts

[Architecture](README.md) · [Roadmap S0A](../roadmap.md#s0a--modular-interfaces-and-feature-consumer-contracts)

## Purpose and current status

Features need clear service boundaries, not knowledge of where tables or caches
live. The user requests an explicit interface review stage for storage, indexing
and caching. S0A is planned: this page defines its review checklist, not a finished
new API or proof that existing bindings already satisfy it.

Review storage contracts during S0 design, then check the system-wide consumer
contracts before optimizing internals or resuming dependent features. Start with
existing Rust/TypeScript interfaces and concrete uses. No speculative general
plugin framework, arbitrary SQL endpoint or new API syntax is selected here.

## Supported-operation and consumer matrix to produce

| Service boundary | Operations/semantics to account for | Representative consumers |
| --- | --- | --- |
| Vault files and attachments | Read/list/stat, text/binary creation and witnessed edits, move/delete/restore, streaming, subscriptions and recoverable publication | Editor, file tree, embeds/Canvas, CLI, sync |
| Managed records | Scoped reads/queries, atomic mutations, revisions/conflicts, tombstones, subscriptions, retry receipts and sync eligibility | WorkBlocks/Calendar, first-party structured services, sync |
| Local recovery | Snapshot capture/dedupe, list/read/preview, restore, retention and explicit failure status | Save lifecycle and recovery UI |
| Disposable cache | Versioned scoped keys, get/put, miss/stale distinction, invalidate/evict/clear, bounded capacity and rebuild | Parser/index/search services, connected browser working cache |
| Parsing and index lifecycle | Source-aware extraction, incremental pump/progress, rebuild/cancel, version/freshness checks and safe publication | Native/browser hosts, CLI and feature-query services |
| Query snapshots | Bounded/paged search, retained source/query pins, links/backlinks and Base/task/calendar projections with coverage | Search/graph UI, Bases, Tasks and Calendar |

This matrix records required capability families, not a mandate for one generic
interface exposing them all. Split storage infrastructure from domain services;
features use semantic operations. In particular, a task-note edit goes through
the note/file service rather than inventing an authoritative task row just because
managed records exist. Provider operations retain their own authorization and
reconciliation semantics.

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

Desktop/mobile use durable native SQLite services. Browser joins an existing sync
group and retains local working data/indexes between visits for incremental
catch-up. Protect pending writes separately from refetchable cache; browser storage
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
