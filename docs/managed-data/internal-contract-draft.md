# Internal managed-record slice: provisional decisions

**Historical proposal; current scope superseded (2026-10-22).** This draft does
not define the current Bases architecture or require named note Types. Follow
[the Bases implementation goal](../plans/bases-implementation-goal.md) and
[the roadmap](../roadmap.md). Notes and Bases remain file-backed; optional rich
property definitions are independent of named Types. Retained Tasks/Calendar
Type consumers need reconciliation before their deferred implementation resumes.
The managed-record experiment below grants no current implementation ownership.

Status: Phase 0 proposal, not a frozen public API or implemented persistence.
Read alongside [the historical plan routing page](implementation-plan.md) and the
[execution checkpoint](execution.md). No new wire version is selected here.

## Separate authorities, shared infrastructure

Initial local transaction scope is one record plus its associated receipt,
outgoing work and change rows; no cross-record offline serializability is promised.

A managed collection is scoped by vault and host-assigned first-party owner;
collection, record and field identities are stable opaque IDs. Client-supplied
owner strings do not grant access. The host resolves schema and persistence
policy from trusted registration and authorizes reads, queries, export,
subscriptions and writes. Namespace separation alone is not a plugin sandbox.
Notes, attachments, Types and Bases retain
the file authorities specified in the plan. Indexing a note never makes its SQL
projection authoritative. File sync and managed-record sync have distinct typed
payload validation; receiving one must never route it through the other.

The first experiment evaluates one record with independent atomic field values.
A range such as start/end/timezone is one atomic field, so concurrent patches
cannot mix components from different concurrent values. Validate each complete
range before accepting it. Unknown fields survive patches. Missing,
explicit null, and field removal must have distinct encodings. Whole-record
replacement is not the default write primitive.

## Policies to evaluate before implementation

- Independent fields merge independently; concurrent writes to the same atomic
  field converge deterministically, without relying on wall clocks. Document
  the actual Yrs winner and UI conflict policy after the experiment.
- Deletion is an explicit retained tombstone. An edit racing deletion must not
  silently resurrect the record. Recovery/export must retain the authored edit;
  visibility and recoverability are separate requirements. Restore is explicit.
- Set membership uses explicit add/remove operations with a documented concurrent
  policy. Replacing an entire array is not a substitute for set operations.
- Schema version is distinct from record causal revision and wire version.
  Additive unknown fields are preserved. Incompatible edits are rejected or
  retained unresolved, never silently discarded. No arbitrary migration callbacks.
- Synced, durable local and disposable cache policies are explicit at collection
  declaration. A caller cannot change a record policy to smuggle local/cache
  values into outgoing sync. Durable pending edits/receipts are not cache.

## Durability and adapters

An acknowledged write means durable local success. For synced collections, one
local transaction commits record causal state, exact operation/replay identity,
projection and durable change sequence, and authored payload/outbox intent.
Local/cache collections create no outbound work. Encryption may follow this
commit. Before transmission, persist exact ciphertext together with sealed
status; retries reuse those bytes. Failed sealing leaves retriable durable intent,
without a false sync acknowledgment. A deferred projection must carry a causal
revision and explicit pending state rather than acknowledge inconsistent queries.

One incoming transaction commits authenticated exact-wire receipt/dedupe, record
causal state (or explicitly retained unresolved state), projection/change sequence
and expected shared relay cursor advance. Recheck scope, compatibility and plan
preconditions at commit. Unsupported family rejection advances no cursor; durable
unresolved acceptance requires an explicit observable policy. A second record-only
progress stream or independent checkpoint CAS is not equivalent.

Native SQL tables/indexes are core-owned. Browser starts with the existing
normalized IndexedDB adapter and shared Rust/WASM validation/merge plans. Async
prepare/decrypt/network work runs outside write callbacks; final authority,
admission and CAS checks plus record/receipt/outbox/cursor writes share one strict
transaction. Success is emitted only on completion. No JS replication authority
or automatic second SQL-WASM database is introduced. Abort/quota, owner loss,
stale plans, restart and notification/re-subscription must be tested. Durable
change sequence supports catch-up after notification loss. Adapter shortcomings
require an explicit decision, not weaker semantics hidden behind the same API.

Derived indexes can rebuild; operations, tombstones, conflicts and pending
external mutations cannot be discarded with them. Resource bounds are required
for records, fields, payloads and indexes. Feature release, schema semantics,
record causal revision, wire protocol and local DB layout are separate versions.
Local incompatible writes fail before mutation. Remote incompatible changes are
rejected without progress or retained unresolved under the chosen ingestion
policy. Unknown fields must survive causal-state serialization and export;
defaults must not repeatedly rewrite incoming values.

The experiment must report same-field winners, losing-value recoverability,
remove/add policy, stable membership identity and restore versus delayed old
operations. Restore names the tombstone/generation it supersedes. Winning CRDT
projection alone is not recoverable history: retained authored/conflict history
must survive restart/GC before promising recovery, or the gap remains explicit.

## Smallest meaningful proof

Synthetic records only, with no credentials or private calendar entries. Offline
replicas patch separate and identical fields, modify sets and race delete/edit;
exchange duplicate and reordered changes and compare converged state. Reload from
retained state and verify unknown fields survive. Ensure existing text validation
still rejects maps/rich content. These experiments establish merge feasibility
only. Phase 1 remains incomplete until native/browser persistence, atomic outbox,
encryption, incoming checkpoints and application subscriptions are integrated and
verified under restart/failure. Native and desktop UI delivery are later explicit
gates, not implied by passing Rust fixtures.
