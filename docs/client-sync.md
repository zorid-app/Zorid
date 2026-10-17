# Portable client text-sync planning

`zorid-client-sync` is the first reusable client planning layer, independent of
SQLite, IndexedDB, filesystem projection, HTTP and app runtime selection. Source
and test cases do not establish integrated sync or crash durability. The initial
scope is one explicitly bootstrapped plain-text document. It does not provide
namespace discovery, binary-file sync, enrollment, recovery or an editor binding.

## Identities and transaction boundary

`TextIdentity` contains realm, vault, stable entry ID and immutable bootstrap ID.
Matching paths/bytes do not identify the same document. The creator establishes
this identity, creates `TextState::empty`, authors seed content exactly once and
exchanges that update. A receiving adapter must establish the same identity and
empty state before ingestion. Never independently insert the seed on both peers.
Namespace creation/discovery will deliver this bootstrap descriptor later; a
remote payload must not silently create an arbitrary filesystem path.

`TextState` persists the identity, opaque local revision, Yrs update-v1 snapshot
and actor ownership registry. Local versions are not synchronized, compared with
another replica's versions, or derived from Yjs state vectors. Deletion-only
updates can leave a state vector unchanged. Snapshots include pending insertion
updates and pending deletes: Yrs 0.28.0 `encode_state_as_update_v1` calls
`merge_pending_v1`; switching to `encode_diff_v1` would lose that guarantee.

The host may plan outside its transaction. Before committing it must invoke
`plan.check_preconditions` against records re-read inside that transaction. These
preconditions compare the complete causal state/provenance, not just visible
bytes. A host may later replace full expected snapshots with a collision-resistant
version/digest scheme only if it preserves the same equality contract.

| Plan | Required atomic persistence |
| --- | --- |
| `AuthoredPlan` | local command receipt, next text state, materialized bytes/local metadata revision, projection intent, immutable authored intent |
| `ReceivedPlan` | exact received-envelope ledger, optional next text state/materialized bytes/local revision and projection intent, optional relay cursor advancement |

`ReceivedPlan` has no authored/outbox field. It must not be implemented by calling
the existing `Store::apply` or browser `mutate`. Existing `MutationRequest` and
`CommitResult` remain local command/retry contracts. Existing `{request,result}`
outbox rows are not wire payloads. A host checks local operation replay before
planning; successful replay returns the original receipt, including when file
publication remains pending. Actual filesystem publication is recoverable work
following the database transaction, not part of the AEAD or merge operation.

`AuthorRequest` supplies expected/next local revisions, a new UpdateId, registered
actor and sequential UTF-16 edits. A batch is validated before changing its
transient CRDT replica. `TextReplica::edit` captures only that transaction's
operations. `changes_since` can include historical delete sets, so it is not used
as the authored-event extractor. A local edit with no effective change still
produces an explicit authored intent in this first API; host command policy may
avoid such commands before allocating IDs.

## Wire payload, authentication and immutable retry

The encrypted plaintext is strict JSON with required `family: "text"`,
`format_version: 1`, `identity`, `actor`, and `update` (Yjs v1 bytes as a numeric array). Unknown fields, unsupported
versions and insertion blocks belonging to an undeclared actor are rejected.
The registration describes only this transaction's insertion actor; delete sets
may refer to other actors, including a prerequisite not yet received.

`AuthenticatedText::open` uses the private-construction `zorid-crypto::OpenedEnvelope`
authentication capability with independently chosen `ExpectedContext`, then runs
bounded payload decoding and payload/header realm/vault matching. A shared host
dispatcher can open once, inspect the required encrypted family and call
`AuthenticatedText::from_opened` (or the file family decoder) with that same
capability. There is no public raw-plaintext authenticated constructor. Unknown
families/versions and old family-less fixture payloads return `UnsupportedFormat`;
there is no trial-decoder fallback. These first-slice payloads are undeployed, so
this change does not silently migrate any existing authored intents. It does not manufacture
its context from the untrusted incoming header. The expected entry/bootstrap is
checked by the planner against local state. All key holders remain trusted vault
authors: a registration is not a device signature.

`AuthoredUpdate` is a durable plaintext intent. Sealing/queueing is a later adapter
step: allocate its UpdateId once, persist one resulting envelope before sending,
and retry those exact bytes. A second encryption with a fresh nonce under the
same UpdateId is a mismatch, even if the plaintext matches. Store pending/sent
local envelopes in the same identity-aware ledger or consult both ledgers before
remote ingestion, so a changed-byte self-echo cannot bypass collision detection.
Do not expose this host API, vault keys, or decryption to arbitrary plugin code.

`ReceivedRecord` contains realm/vault/entry/bootstrap, UpdateId and exact bounded
wire bytes. Index lookup is by `(realm_id, vault_id, update_id)` across the vault,
not only within the target document. The planner checks the complete record.
`None` in `expected_record` means that record must still be absent at commit.
Records and snapshots survive server-epoch changes. Compaction/GC is not supplied.

## Cursor, duplicate and pending update semantics

A receive plan separately records expected document state, expected dedupe record
and expected relay cursor. A duplicate can advance a cursor without changing the
document revision; host code must check all three preconditions atomically.
`ReceiveCursor` scopes a decimal u64 position to realm/vault/server epoch. A
`CursorAdvance` requires matching identity/epoch and strictly increasing position.
The transport must validate the actual ordered relay page; the planner cannot
prove absence of delivery gaps from two integers. It rejects an in-transaction
epoch change. Recovery establishes a new cursor explicitly, retains the ledger,
then replays safely. Upload acknowledgment never updates the receive cursor.

The no-cursor lane is for ingestion already accounted for by a separate delivery
mechanism; it does not implement P2P. A host must not use it to bypass failed relay
cursor checks. Schema/authentication errors commit neither cursor nor dedupe.
Missing CRDT dependencies are different: the pending update and actor registration
are saved in the snapshot/registry, allowing the cursor to advance safely even
when visible text does not change. A later prerequisite revalidates the integrated
plain-text roots/content. A malformed dependency chain remains an explicit error,
not an automatically skipped relay item.

## Actor ownership and independent writers

The interoperable Yjs 13/Yrs small-client contract uses 32-bit actor IDs. The host
allocates candidates with platform CSPRNG and checks the persisted registry; the
planner rejects an ID already owned by another replica incarnation before apply.
The registry includes actors whose updates are still pending. Random allocation
is not collision-free, especially over a long history. An offline collision is
retained as an explicit error for recovery; it is never merged silently. Stronger
enrollment/reservation and collision recovery remain required product work.

Processes/tabs may reuse a durable actor only when the storage authority serializes
all its authors against the newest committed CRDT state. State+receipt+intent CAS
is mandatory; a losing process discards its provisional plan. Two independent
replica databases cannot share that writer incarnation. Restore/copy/fork must
allocate a fresh incarnation/actor before writes. Actor identity alone cannot
detect two stale forks deliberately claiming the same incarnation.

When dependencies are pending, registered actors cannot be reused for authoring
until their contiguous history is restored; use a fresh actor. Otherwise a queued
block may have already occupied a clock absent from the materialized state.
Clock exhaustion and large-history compaction need a future rotation protocol;
this layer is not an unlimited-lifetime actor allocator.

## Explicit current-state whole-text commands

`plan_replace_text(state, desired_utf8, AuthorRequest)` handles ordinary managed
text writes whose caller supplied the current expected revision. It requires an
empty `AuthorRequest.edits`, validates UTF-8 without stripping BOM or normalizing
line endings, and shares the bounded character diff/UTF-16 authoring path. The
result has `expected_baseline: None`; it does not invent filesystem provenance.
Empty/identical replacements follow the existing explicit no-op intent policy.
A stale revision or changed commit-time causal state fails. The host must retain
that original command rather than silently updating its expected revision and
replacing concurrent edits. This differs from importing an external file edit
whose actual older projection baseline is independently recorded.

## External whole-text edits

`TextBaseline` contains the exact CRDT state and bytes that produced a successful
filesystem projection. Retain it in projection/external-observation provenance;
current database bytes are not a substitute. The adapter must prove that this is
the baseline of the observed file through its existing filesystem protocol.
A caller-created snapshot claiming to be an older baseline is not such proof.

`plan_external_text` validates baseline identity, bytes and actor provenance,
diffs baseline text against observed UTF-8, authors those changes on the baseline
under a fresh actor, then merges that update into the current state. It includes
the exact baseline in commit preconditions. It never replaces current text with
the observed file. A fresh actor is mandatory: reusing today's actor on yesterday's
snapshot can reuse clocks missing from that snapshot. UTF-16 indices reject split
surrogates; UTF-8/BOM/line endings are retained without normalization. Non-UTF-8
bytes belong to a future binary-file path, not lossy string conversion.

`plan_external_text_with_baseline` additionally returns `ExternalTextPlan` with
`authored` (the same merged `AuthoredPlan`) and `observed_baseline` (the branch
snapshot and exact bytes of the physical observation). Both come from one diff.
The observed branch retains only the old baseline's actor registrations plus the
fresh observation actor, including deletion-only edits. It excludes remote edits
that have not yet reached the physical file. This lets a subsequent observation
use the true physical baseline even after restart and before merged publication.

The host allocates a separate, historically unused observed revision; the helper
rejects reuse of the current, prior baseline or new merged revision. Persist the
observed branch history and physical baseline atomically with the merged current
state and **one** authored intent, using the original baseline CAS. Replace that
physical baseline with the merged state only after successful publication. The
observed branch is provenance, not a second authored operation or outbox item.
The original `plan_external_text` remains available through the same internal
branch planner for callers that do not need the additional snapshot.

Character diff uses pinned `similar = 3.2.0` Myers diff, with descending hunks
translated into Yrs edits. See the [official sequence-diff API](https://docs.rs/similar/3.2.0/similar/fn.capture_diff_slices.html).
This library decides which old characters an external replacement removed; Yrs
performs the actual concurrent merge. It does not invent arrival-order overwrite.

## Deliberate first-slice limits and remaining integrations

- Encrypted plaintext limit: existing protocol 1 MiB, including JSON byte expansion.
- Materialized text: 256 KiB; snapshot: 4 MiB; actor registry: 4,096 actors.
- Authored edit batches: 4,096 edits and 256 KiB total inserted bytes.
- Whole-text diff (explicit replacement and external import): 8,192 Unicode scalar values per side. Larger imports explicitly
  return `TooLarge`; there is no silent replacement fallback.
- Wire checks precede parsing. These bounds do not establish a hostile-input CPU,
  allocation or memory-safety sandbox for the upstream Yrs decoder. Browser
  wrappers must bound JS input before wasm-bindgen copies it. Integrated root
  validation rejects non-content roots, formatting and embeds; pending structures
  are checked again when dependencies integrate.

Native adapter changes depend on scanner/projection provenance and a common
origin-aware commit/projection log: current projection queues reference local
operations. Native v3 directory/scan work remains factual local observation;
absence is not yet a distributed delete and equal bytes are not a rename proof.
IndexedDB must atomically cover text state, metadata/content, local receipts when
applicable, sync intent/ledger, journal and cursor. No awaited network operation
may split that transaction. Neither adapter integration is implemented here.

Next validate real offline native/browser replicas through encrypted relay,
restart and lost-ack behavior. Then add causal binary revisions/conflict retention,
stable folder/move/delete semantics, encrypted chunk manifests for large files,
and recovery. Do not choose arrival-time overwrite, discard concurrent file
versions, or claim full-vault synchronization from this text slice. Dirty editor
buffers, IME, undo/history and remote editor transactions remain editor-owned
integration gates.

## Verification status and commands

Test source covers Unicode offline concurrency, reverse delivery, serialized
restart before dependencies, deletion-before-insertion, duplicate-only cursor
progress, exact-byte mismatch, actor collision, stale baseline multi-hunk imports,
UTF-16 batch atomicity, identity/version checks and payload/size rejection. It uses
real crypto with deterministic entropy isolated inside the test module. No file,
IDB, HTTP, actual browser or power-loss guarantee follows from these tests.

Prepared source only until the coordinator grants the shared build slot. In the
coordinator Cargo workspace (which owns manifests/lockfile), run:

```sh
cargo test -p zorid-client-sync -p zorid-crdt -j1 -- --test-threads=1
```

The standalone worker checkout has no root Cargo workspace manifest. The
coordinator must add this crate to its existing workspace and resolve the pinned
diff dependency; do not create duplicate heavy target directories to run it.

## Namespace-aware text v2

The additive `zorid_client_sync::v2` module requires encrypted `family: "text"`,
`format_version: 2`, and `namespace: { bootstrap_id, parents }`. The existing
`TextIdentity.bootstrap_id` continues to identify the text CRDT bootstrap;
`namespace.bootstrap_id` independently identifies namespace Create. Enrollment of
an existing text document allocates an explicit namespace binding to that original
text bootstrap. It never rewrites an old envelope or infers identity from a path.

Parents are a nonempty, sorted, unique frontier of at most 128 UpdateIds with no
self-reference. These are structural checks only. The file-v2 planner validates
immutable content binding, actual parent graph, antichain, and whether an activity
is admissible. Normal authoring after an observed Delete requires Restore. A
concurrent old physical observation can remain admissible using its old frontier.

`v2::AuthenticatedText::from_opened` consumes the existing single AEAD-opened
capability and produces private `TextActivity` evidence. Local v2 planners return a
private `AuthoredTextPlan` with immutable `plan()` and `activity()` getters; a
serialized legacy plan cannot mint activity. Activity exposes identity, UpdateId,
namespace context and exact plaintext bytes for immutable collision checks. It
represents the same single encrypted update, not a second authored envelope.
A file planner may persist normalized identity/context plus exact plaintext hash
and length; the host still retains and checks the global exact encrypted wire.

Hosts must commit both text and namespace plans under their complete state CAS in
one transaction, together with the original authored intent or received ledger,
cursor and projection obligation. A text plan alone is not permission to publish
at a path. Text receive can merge retained CRDT snapshots while namespace state is
tombstoned, missing dependencies or in recovery. It does not resurrect an entry,
create a normal file, or produce a received-to-authored echo. Namespace-only moves
and deletion preserve the text snapshot and actor provenance; local metadata
revisions remain fresh, host-allocated and globally fenced.

`TextPhysicalBaseline` persists `text`, `namespace`, and `location` together.
`location.path` is the actual saved physical path; `location.location_event` is
this entry's observed location lineage. A parent move may change a full path
without changing this event, so it is not sufficient to reconstruct a historical
path. The file planner checks event lineage; the filesystem host checks the exact
saved path, inode and parent provenance. Neither recomputes physical ownership
from the newest namespace state.

The external v2 planner retains that entire baseline as a precondition. Its
activity uses the baseline's old namespace frontier; the returned observed branch
has frontier `[new_update_id]` and preserves its physical location. The merged
current CRDT and actual observed branch remain distinct. The host persists both
atomically, and changes physical lineage only after successful publication. The
ordinary replace-text wrapper still uses explicit current text CAS; it never
silently retries an old whole-text command against newer content.

Legacy v1 decoding/planning remains explicitly available outside `v2`; the two
wire decoders reject each other's version. V1 never produces namespace activity.
After enrolling an existing v1 document into namespace v2, a late authenticated v1
update has no causal namespace frontier. The host must retain its exact wire and
an unresolved `legacy_namespace_context` obligation atomically with any accepted
cursor advance. It must not apply v2 visibility semantics, assign the current or
Create frontier, or relabel the envelope. Explicit repair/upgrade policy is still
required to resolve such staged legacy updates. Unenrolled legacy operation is
separate; this module does not implement storage migration or enrollment UX.

Source regressions cover distinct immutable bootstraps and strict version/field
rejection; canonical bounded frontiers; deletion-only updates arriving before
insert dependencies, restart and duplicate receipt; and repeated external edits
against old physical namespace/path witnesses with concurrent text. Runtime and
cross-family/native tests remain separate validation gates.
