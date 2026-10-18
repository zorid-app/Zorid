# Portable managed records: implementation contract proposal

Phase 1 internal first-party slice; proposed 2026-10-17. Not a public plugin API,
wire family selection, namespace sandbox or production acceptance. This makes the
[reviewed draft](internal-contract-draft.md) concrete enough to implement and
review. Existing file/text authorities and validators remain unchanged.

## Owned portable boundary

Proposed crate `zorid-records` owns stable IDs, bounded typed schemas, validated
operations, one-record causal state, deterministic projections and opaque payload
encoding. It performs no I/O, time/random allocation, authorization, secrets,
encryption or durable acknowledgment. Host supplies trusted collection registration
and an authorized scope; no caller-supplied namespace string grants permission.
Store, protocol, WASM/browser and native bridges are separate assigned consumers.

Use one generation of one record per causal document for the initial slice.
Identity is `(realm, vault, owner, collection, record, generation)`, all stable
opaque bounded identifiers. Restoring creates a distinct generation, explicitly
linked to the deleted generation; late operations cannot change that new record.
No path/title identity and no cross-record offline atomicity are promised.

## Schema and local commands

Collection registration includes stable ID, schema version, persistence policy
`synced | local | cache`, and a bounded ordered field map. Schema is host-owned;
changing a command field cannot change persistence policy. Initial field kinds:
boolean, string, integer, finite number, atomic JSON object, and stable-ID set.
Optional/required, nullability and defaults are explicit. Stable IDs differ from
mutable display labels. Defaults are applied once at local creation, never during
remote replay. No arbitrary semantic migration callbacks.

Local commands create, patch declared fields (set/null/unset distinguished),
add/remove stable set members, and delete. Sets use explicit add tags and removal
of observed tags. Reject unknown local fields and incompatible types before state
mutation. A complete invariant group such as start/end/timezone is one atomic
object; feature validation must validate the whole value before commit. A local
multi-field patch is one operation, but concurrent patches still arbitrate each
atomic field; cross-field invariants require an atomic group field.

## Retained causal operations, not winner-only state

Every authored operation has an immutable unique ID, sorted unique causal parent
IDs, origin schema version, exact record-generation identity and typed action.
IDs/actors come from the host's durable allocator; fixed fixture actors are not a
production allocation scheme. An operation ID reused with different content is an
idempotency conflict, not a new winner. Causal cycles/self-parenting are invalid.
Operation parents name observed heads, not wall-clock timestamps.

Retain immutable authored operations, including losing field writes, separately
from the winning projection. For an atomic field, discard causally superseded
candidates from the *current conflict set*, while retaining their operations.
Concurrent maximal candidates remain visible as conflicts; choose the greatest
stable operation ID only as a deterministic display winner. This tie-break is
explicitly not wall-clock latest or semantic resolution. A new write observing
all candidates resolves the current conflict set without erasing its history.
Equal concurrent values may display once while operation identities remain.

Sets are observed-remove/add-wins: each add has a unique immutable operation tag;
remove references only observed add tags for the same field/member/generation.
Concurrent unseen adds survive, and observing/removing all tags clears membership.
Stable member IDs deduplicate labels/options. No arbitrary raw-Yrs write may
rewrite another operation or tombstone. Record delete is monotonic for its
generation; ordinary patches cannot clear it. Concurrent edits remain retained
for recovery/export even while the generation is hidden.

Reordered operations with unavailable parents are retained as pending, excluded
from accepted projection until dependencies arrive. Pending is observable and not
final convergence. Invalid batch application is transactional in memory: validate
on a candidate state and publish only if all admitted operations pass. A rejected
operation must not leave a half-mutated state.

## Yrs representation decision gate

The successful probe established Yrs field-map feasibility and its failure modes.
A winner-only Y.Map field model is insufficient for promised recoverable conflict
history. First implementation should retain the typed immutable operation set as
portable authority, with a canonical operation-set join and deterministic causal
projection. A separate evaluated Yrs encoding may map immutable operation IDs to
atomic encoded operations; it must reject ID rewrites, alternate roots/shared
values and malformed operations before publication. Do not add a second mutable
field projection in Yrs alongside an independently authoritative operation graph.

The portable typed operation format/semantics are the immediate implementation
scope. Whether to encode that set in Yrs or directly in the new encrypted family
must be reviewed before sync framing: redundant Yrs state is not automatically
required merely because the note text engine uses Yrs. Both choices must satisfy
the same operation union, causal conflict, deletion/set and retention fixtures.
This is an explicit representation decision, not permission to weaken text sync.

## Versions, unknown fields and limits

Feature release, collection schema, operation causal identity, wire family and
local storage layout versions are independent. Initial schema is additive only.
Remote unknown stable fields with supported value encodings remain in causal
state/export and are preserved by older clients' known-field patches. Unknown
wire action/value types, incompatible known-field changes and unsupported semantic
versions are rejected without progress or durably retained unresolved under the
later dispatcher policy; they are never silently skipped. A schema version bump
must not relabel an old value as translated.

Initial admission limits (internal constants, subject to measured revision):
ID 128 ASCII bytes; 64 declared fields; 32 parents/operation; 64 actions/patch;
16 KiB encoded atomic field; JSON depth16; 4096 retained operations/record;
1 MiB encoded payload/snapshot maximum, fitting existing relay plaintext limits.
Bound input bytes before JSON decoding, count collections/depth before apply,
and reject nonfinite values. Exhausted retention is observable and blocks further
writes without discarding history; compaction/history externalization is a later
required gate before representative production data. These limits are not an
untrusted decoder allocation sandbox or product performance budget.

## Adapter obligations and acceptance

A prepared local change returns the validated next causal state/projection and
authored payload intent, keyed by expected revision and exact operation replay
identity. It is not a durable receipt. Native/IDB adapters recheck scope, schema,
policy, revision and operation identity inside the final commit, together with
causal state, query projection, durable change sequence and (synced only) authored
intent. Seal/persist exact ciphertext later before first send; retry identical
bytes. Incoming exact receipt/dedupe, accepted or explicitly unresolved state,
projection/change sequence and shared relay cursor advance commit atomically.

Portable acceptance: separate-field edits converge; concurrent same-field values
and causal resolution retain history; null/unset distinction; set add/remove
races; delete/edit and new-generation separation; duplicate/reordered operations;
missing-parent completion; malformed/cycle/ID-rewrite/schema/type/limit failures
leave state unchanged; older patches preserve unknown fields; canonical export
and snapshot restore preserve full retained history. Native/browser crash/retry,
local/cache exclusion, actual encrypted transport and subscriptions remain
separate Phase 1 gates, not proven by portable tests alone.

## Independent review resolutions for first source slice

The [independent concrete review](portable-contract-review.md) supports source
implementation now with these required invariants:

- Exactly one create root per generation. All non-create operations descend from
  it; unavailable create/parents remain pending. Field conflict maxima are
  computed among writes to that field, not only global heads. Canonical ID order
  and semantic operation equality are explicit.
- Set removal tags identify a particular add action (operation plus action
  ordinal if necessary) within the remover's causal ancestors, matching exact
  field/member/generation. Merely finding an add in local state is insufficient.
  Scalar/null/unset on set fields is rejected until reset semantics exist.
- Pending operations participate in ID-equivocation/cycle/resource validation.
  Arrival of a parent revalidates newly activated descendants transactionally.
  An invalid activation rejects the whole candidate application, leaving prior
  state intact; later adapter policy must expose this recoverable blockage.
  Different content for the same ID is an integrity conflict, never first-seen
  winning convergence.
- Limits cover accepted and pending operations, unknown fields, all tags and
  aggregate canonical snapshot bytes. Concurrent unions beyond capacity are
  explicit backpressure, not eviction or convergence. A resolving write needing
  more than32 parents reports a precondition failure or uses a separately
  specified merge-only operation; no parents may silently be omitted.
- Reject ambiguous duplicate keys/actions and invalid values; bound JSON arrays
  as well as objects. Logical snapshot capacity does not establish encrypted
  framing capacity; later family overhead needs its own exact byte gate.
- Additive unknown field-schema versions are distinct from unsupported semantic
  action versions. Preserve remote typed unknown scalar/object/set changes while
  rejecting local unknown writes; reject incompatible known types. Required
  fields cannot be unset. Defaults are materialized at create only.
- Restore-source generation/tombstone references are immutable. Cross-generation
  deletion proof is a host obligation; two distinct concurrent restores remain
  separate, without an implicit single-live-generation promise.
- Prepared changes bind full scope, base history/pending/deletion revision,
  registration/schema/policy revision and operation identity. Hosts validate or
  recompute; a caller-serialized plan is never authority. Exact duplicate incoming
  receipts must not emit duplicate durable change events.
