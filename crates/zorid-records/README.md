# Internal portable managed-record slice

`zorid-records` is a pure, in-memory, one-record-generation engine. It is not a
public plugin API, durable receipt, storage adapter, sync family or namespace
sandbox. It uses existing serde/serde_json dependencies only. No I/O, allocator,
clock, random source, crypto, authorization, migration callback or Yrs state is
present. Source is based on the managed-data-foundation proposal
`docs/managed-data/portable-record-contract.md`, Git blob
`896bafd3d4b396d6f2c1df878c2ecc17d67aa2c3`, reviewed draft/results and coordinator
review `msg_7b646e579cc0`; no existing production source was copied or modified.

## Representation and semantics

The **typed immutable operation set is the portable authority**. There is no
redundant independent mutable Yrs field state. Direct canonical JSON encoding is
an internal codec decision, not a deployed wire protocol. Field candidates, set
membership, deletion and pending IDs are derived. Operation union converges only
within the compatible, non-equivocating, bounded domain. ID collision, schema
incompatibility and capacity errors are observable integrity/admission failures,
not first-seen-wins convergence or eviction policies.

The host supplies validated trusted `Schema`, authorized `Scope` and durable
unique operation IDs. All IDs are nonempty ASCII without whitespace/control,
at most 128 bytes; ordering is lexicographic ASCII byte order. The generation ID
also names its unique create operation, whose parents must be empty. Every other
operation must causally descend from that create. A second create with another
ID is invalid; rewriting the same ID conflicts. `restores` is immutable scope
metadata naming the old generation; the host must verify the prior tombstone and
authorize restoration. Concurrent restores into distinct generations coexist;
this engine does not choose a single live generation.

A field's current candidates are its causally maximal writes, even when later
unrelated writes change global heads. Candidates are ID-sorted; the last is the
**display winner**, never wall-clock latest or semantic resolution. Null and
unset are distinct candidates. Equal concurrent values retain both identities.
A write observing all conflicting candidates resolves the conflict without
removing losing operations. Atomic JSON objects are replaced as a unit; feature
code must validate complete domain invariants (including timezone/range rules).
Cross-field and cross-record invariants are not enforced by causal atomicity.

Set adds are tagged by operation ID within the field. Each operation may contain
only one action per field, so `(field ID, operation ID)` unambiguously identifies
an add action. Adding two members to the same field needs separate operations.
Remove names sorted unique observed add IDs and must causally observe each add
for exactly that field/member/generation. Concurrent unseen adds survive; member
IDs deduplicate membership. Removing all observed tags clears membership. Set
fields are intrinsically present and possibly empty; scalar/null/unset resets,
nullable sets and set defaults are unsupported. Empty sets may be omitted from
`Projection.sets`. Scalar unset remains explicit in candidate projections;
consumers should treat a winning unset as absence.

Deletion is monotonic per generation. Projection keeps all recovery fields/sets
but marks `deleted`; consumers hide the generation. Remote causally later edits
remain recoverable and never undelete it. New local edits to deleted generations
are rejected; exact prior command retry remains allowed.

Missing dependencies retain operations as observable `pending`; they cannot
contribute values, membership or deletion until their complete dependency closure
is accepted. Pending IDs participate in collision, schema, capacity and cycle
checks. Receiving a dependency revalidates its newly activated closure before
publication. If that closure contains an invalid remove, the **whole arrival
fails**, including the parent; prior pending state is unchanged. This can block a
record until a host-level recovery/quarantine policy is provided. This crate has
no silent drop, discard-pending or durable unresolved-receipt mechanism.

## Schemas, codec and plans

The host registration fixes collection, positive schema version, fields and
synced/local/cache policy. Positive future schema versions mean additive-only
field schemas under these same semantics; no maximum-version shortcut relabels
old operations. Supported unknown remote fields are retained and inferred types
must stay compatible across all history, including pending operations. Local
unknown writes fail. Known-field type changes fail; Number and Integer are
separate kinds. Required scalar fields must appear on create and cannot be unset;
null requires nullable. Local creation authors missing declared defaults once;
replay never inserts defaults. Sets have no scalar presence requirement.

`prepare` takes all accepted heads as parents and returns a private-field,
inspectable `Prepared`: complete expected canonical snapshot, validated next
state and authored payload intent. `install` is an **in-memory CAS only**, bound
to full history/pending/delete state, complete scope and exact registration
(including schema/policy). It replays/revalidates payload before publishing.
Exact local command retry reuses the original operation/parents, with no new
history. Actions and parents are ordered data; reordering a command is not exact
retry. Canonical operation bytes define identity equality, including signed zero.
`State`'s derived numeric `PartialEq` is not the ID collision authority.

Private plan fields do not authorize a host write. Adapters must recheck current
registration and authorization in their final transaction, and atomically commit
causal state, projection, durable sequence, and synced-only authored intent.
`payload()` is available for all policies to support inspection/local replay;
only Synced policy may enqueue it for transmission. Local/cache exclusion is a
host obligation, not verified here. Seal and persist exact ciphertext before
send; incoming exact-wire receipts/dedupe and shared relay cursor are separate
adapter obligations. No durable cursor, receipt, outbox or event is emitted here.

Snapshot/intent envelope format 1 is distinct from collection schema version.
Decoder requires exact canonical re-encoding, rejecting whitespace, duplicate
keys, alternative escaping/number spellings and unknown envelope/operation fields
or action/value variants. Objects use sorted maps under the existing serde_json
configuration (no `preserve_order`); enabling that feature requires codec review.
Snapshot operations are emitted sorted by ID; incoming operation vectors may be
reordered but must otherwise use the same canonical JSON encoding. Codec is
internal and strict; interoperability does not mean accepting arbitrary JSON.
Unknown semantic formats/actions reject atomically; host quarantine and receipt
progress policy is not implemented. JSON numbers must fit serde_json's supported
finite numeric representation; integer fields additionally require i64. Atomic
objects may contain arrays, primitive values and null. Object keys are at most
128 UTF-8 bytes and strings are bounded by the complete value budget.

## Limits and unsupported production cases

- 64 total field IDs across registration and all retained operations, including
  unknown/pending fields; 64 actions/operation; one action/field.
- 32 sorted unique parents/operation; 4096 sorted unique removal tags/action.
- 16 KiB encoded typed atomic value; maximum JSON depth 16 counting the atomic
  object as depth 1, including primitive leaves and alternating arrays/objects.
- 4096 total operations including pending, losers, deletes and removed adds.
- 1 MiB input payload/snapshot before decoding **and** 1 MiB complete canonical
  retained snapshot after union. Encryption/framing overhead needs a later relay
  budget; a full 1 MiB snapshot is not claimed to fit an encrypted relay message.

History cap and byte cap cause observable `Limit`, blocking further admission
without deleting history. Two replicas at 4096 operations may individually accept
their last concurrent write and reject their 4097-operation union. A pending-filled
budget may block its dependency arrival. These are bounded-domain backpressure,
not final convergence. More than 32 concurrent heads block local authorship;
there is no merge-only bridging command. History externalization/compaction,
capacity recovery and scalable ancestry indexing are required before production
long-lived records. No GC, old-generation tombstone disposal, schema migration,
provider operation semantics, task/calendar model or public plugin surface exists.

With N operations, E parent edges (at most 32N), A field actions and B retained
encoded bytes, admission clones O(B) state and serializes the complete snapshot.
Topological traversal uses sorted maps/sets; transitive ancestor storage is
O(N²) IDs in the worst case, with O(E*N*log N) conservative construction cost.
Projection additionally compares candidates within each field (up to O(A² log N))
and tracks observed add/removal tags. These are bounded correctness algorithms,
not measured performance budgets. Limits are not an untrusted allocation sandbox:
serde decoding/programmatic batches can allocate before semantic bounds are
checked; callers must budget input and protect their process boundary.

## Verification status

23 source-authored trace tests cover offline fields, same-field history,
field-specific ancestry, equal values, null/unset, atomic objects, sets and tag
theft, deletion/restoration, reordered/duplicate/pending dependencies, cycles and
pending activation failure, malformed codec/type/schema/ID/limit failures,
additive unknown fields, defaults/CAS, canonical full-history snapshots and
capacity divergence. These tests have **not been compiled or run** in this
worker: coordinator reserved compiler priority for native work. No runtime,
durable/native/browser/security/UI parity is claimed.

One bounded requested validation command (coordinator must grant a slot and
arrange any workspace lock update; this worker changes no lockfile):

```sh
CARGO_BUILD_JOBS=1 cargo test --offline -j1 -p zorid-records --test traces -- --test-threads=1
```

The workspace already includes `crates/*`; no root manifest change is needed.
A package entry in Cargo.lock must be reviewed/updated by its assigned owner;
`--locked` cannot be promised before that separate change.
