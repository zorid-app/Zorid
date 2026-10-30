# Conditional source capture request recovery

Status: internal contract accepted for implementation after independent Store
and renderer/journal reviews; product verification remains open. This is a
required recovery fix, not a plugin API or sync protocol redesign. Root owns
integration in `codex/instant-editor-current`; the reviewed performance build is
source `d180c9b6`, package008. No implementation is claimed by this document.

## Observed failure

`DurableNoteState.captureConditionalSavedSource()` currently awaits
`captureSavedSource(witness)` before it knows a capture ID. Native generates that
ID only after reading the physical source. Store19 persists the guard before
returning it. If that first reply is lost, the caller cannot identify or release
the accepted guard. A fresh capture can consume another one of the shared eight
pending slots. A transport sequence number is not a durable request identity.

The existing guard survives a host restart correctly once its ID is known. Its
logical revision, physical inode/parent, length and digest checks must remain.
The fix must not replace an accepted guard with a fresh observation on retry.

## Request and ownership

Use the caller's immutable UUID as both request ID and returned `captureId`.
Introduce a distinct request type, even if its fields resemble a returned guard:
`{captureId, logicalWitness:{entryId,revision,path}}`. A request is a claim, not
physical-source authority. Native alone creates the saved guard.

The note actor generates the ID once before dispatch and retains the exact
request across retry. Every boundary copies and strictly validates plain data.
The host command adds required `capture_id`; the reply must match both that ID
and the exact logical witness. Different actors requesting the same witness get
different IDs. There is no deduplication by path, revision, or content.

Native verifies current kernel ownership and local-store/client scope before
looking up the request. A newly admitted lease of the same authenticated client
may resume that client's request; another client or copied/foreign store cannot.
Caller release remains by exact ID. An unknown ID release creates a durable
same-client tombstone, fencing a capture that reaches Native after cancellation.
Release of a foreign ID must not disclose or alter its record.

## Durable request states

Store20 adds a local request receipt ledger alongside the existing guard table.
Rows bind client, request ID and, where known, the immutable witness. States are:

- `pending`: one original accepted guard; charged once to pending quota.
- `attached`: the guard was consumed by the named exact host intent.
- `released`: explicit cancellation or exact lease retirement completed.
- `changed`: a definitive source-precondition rejection; it cannot recapture.

An initial accepted guard and its pending receipt commit atomically. Exact
pending retries are checked before fresh-admission quota, and return the same
identity only after rereading bytes against the original guard. All existing
logical, inode, parent, root, length and digest checks remain. A mismatch closes
the request as changed; it never refreshes the guard. Unknown I/O leaves the
request retryable and preserves any accepted guard. If no guard ever committed,
a retry may complete the first consistent capture; that is not replacing an
accepted observation.

A pending receipt exists iff its exact unattached guard exists. Pending-to-changed
atomically deletes that guard, frees its quota and records the terminal result.
An initial definitive source-precondition failure also durably records changed
before returning its negative reply; a lost negative ACK cannot later recapture.
New pending/changed/attached receipts require the exact immutable witness. Only
unknown-ID release tombstones and explicitly tagged legacy records may lack it.

Attach/consume, release and lease retirement update receipt status atomically
with their existing guard mutation. Attached/released/changed IDs cannot create
another pending guard, even when a delayed first command arrives. Exact terminal
retries remain terminal. Request-ID/witness or operation mismatches fail closed.
Attachment includes a prepared, committed or durably rejected named intent.
A prepare-time guard rejection that creates a rejected intent is attached to that
exact rejected intent, not an unbound changed receipt. Release or lease retirement
of attached IDs is an idempotent no-op preserving intent, source evidence and
receipt pointer. Attaching a different intent cannot borrow a prior attachment. Existing exact
host-intent replay remains authoritative and must not require recapturing source.

Keep shared eight-pending/32 MiB limits and selected guard validation. Split
transient shared exhaustion (`source_capture_capacity`, trusted host provenance)
from permanent per-request path/8 MiB limits. The available-budget-smaller-than-
source case is shared capacity, not an oversized request. Capacity failures never
record changed or replace an accepted guard; their exact original request waits
for cleanup/release or retries with capped backoff. Do not retry malformed or
individually oversized requests as capacity. Exact pending lookup precedes both
count and byte admission checks. Terminal
receipts carry no source body and are outside pending-byte quota. They cannot be
TTL-deleted: forgetting a tombstone permits a late request to capture again.
This creates durable small metadata growth; no speculative GC or arbitrary
receipt limit is introduced in this fix.

## Renderer protection and cancellation

Persist an immutable capture-request capsule through the independent draft
journal and receive its exact ACK before the first Native capture dispatch.
Without independent protection, do not issue a request that cannot be recovered
after process death. This ACK means the request/draft is protected, never that
the note is saved. Include the original note/client scope and witness. Both
clean-note shortcuts must account for request IDs: DurableNoteState's initial
clean-capture skip and NoteDraftProtection's coreCovered/retireClean paths cannot
skip or retire a live capture-only capsule. Dispatch requires an ACK whose
captured capsule includes that exact ID, witness and scope, even when newer drafts
coalesce; generic protected status or a saved core baseline does not prove this.

There can be multiple unattached captures. The capsule must retain every live
request ID rather than overwrite an earlier one; its bounded request collection
also coexists with the original checkpoint/write capsule. Preserve strict old
capsule decoding; introduce a versioned extension instead of accepting malformed
old records. Offering, acknowledging and retiring requests must not lose newer
drafts or uncertain checkpoint requests. A bounded capsule overflow rejects before
Native dispatch; it never evicts an unresolved ID.

Host/IPC interruption retains one original capture request and waits for positive
same-scope admission; typed transient storage faults retry with existing capped
backoff. Protocol, foreign-scope and definitive source conflicts do not authorize
automatic replay. Owner cancellation stops adoption immediately and joins exact
ID cancellation before retiring its journal responsibility. Late replies cannot
mount a view, release another request, or report success for a retired owner.

Cleanup computes reachability from the canonical checkpoint, the original
uncertain CAS encoded state and retained journal write capsules. An ID referenced
by any of those exact operations cannot be abandoned merely because the newest
canonical checkpoint lacks it. Settle/recover the original CAS or intent first,
then remove only the matching request after exact release/terminal ACK, keeping
newer drafts and other request IDs protected.

On app restart, a protected request with no accepted serialized transform may be
retired as abandoned while preserving the protected note/raw draft. Do not invent
or automatically author an unserialized UI transform. If a checkpoint already
contains an accepted write/intent, recover that exact operation rather than
recapture. Claim full app-crash coverage only after journal-before-dispatch and
restart cleanup are tested; RAM-only retained closures prove host recovery only.

Unopened notes must not strand all eight pending guards. A bounded owned-pending
ledger query (at most nine rows to verify the eight-slot invariant) supplies entry
IDs for targeted checkpoint/journal lookups. A same-client cleanup pass runs in
background after admission or before retrying a capacity-blocked capture; no full
vault scan or global journal-body enumeration blocks editor startup. It releases
only certified retired owners with no live request or retained operation reference.
Current-incarnation/live actors are not abandoned. Unknown/corrupt evidence stays
protected and cannot authorize cleanup. Terminal ledger history uses indexed
lookups and is not scanned on every capture.

## Migration and compatibility

Keep the exact schema checks and separate introduction versions for tables added
in18,19,20. Bumping the current version must not make the19 guard table appear
unknown or recreate18 database tables. Migration preserves existing19 pending
guards, quota, attached intent evidence and known-ID prepare/release behavior.
Migration atomically validates/backfills only the bounded19 pending guards
(at most nine rows to verify the existing eight-slot invariant), preserving
original lease/quota and checking indexed legacy-ID nonoverlap. It does not walk
or copy unbounded host-intent history on startup.

The existing UNIQUE capture-ID index in host_intent_sources and immutable
host_intents remain authoritative for legacy attachments. On a missing new receipt,
all capture/release/changed/registration paths consult that indexed union before
treating an ID as unknown. Fully decode/cross-validate the selected source and
joined intent: client/owner, operation/request/capture identity, Verified/Rejected
binding and state. A SELECT EXISTS result is not sufficient. Before creating any
new pending/tombstone/terminal row, recheck both the ledger and legacy attachment
inside the same Immediate transaction. Exact host-intent replay remains first.

Verified and rejected legacy bindings both resolve to exact attached receipts.
Historical rejected bindings may lack path/witness: tag them explicitly as legacy
rather than loosening new-record decoding. Optional materialization of a selected
legacy receipt must match its immutable attachment and can never rewrite it as
changed/released; release is a no-op preserving that attachment. There is no global
history scrub or terminal-ledger scan on open or every capture. Exact lease
retirement touches only that lease's pending rows, never attached or successor
rows. This bounded/on-demand design supersedes the initial all-history backfill
proposal after independent rereview against the startup budget.

Legacy server-generated IDs remain valid, but migration
cannot recover an ID whose old caller never received it. Do not silently discard
those guards or claim retroactive caller identity. The installed app predates
this unfinished19 implementation; agent fixtures are not evidence of a shipped
19 migration problem. Legacy limitations stay explicit in verification.

No generic checkpoint write, renderer-supplied proof, remote sync payload or
plugin capability may create or modify trusted request/guard records. First-party
bundled host/client capability validation must reject a mismatched implementation
before editing; no fallback to the vulnerable server-generated-ID path.

## Implementation ownership and gates

Root assigns named owners before product edits. Store/schema/transaction work,
Native/host/wire proof work and renderer/bridge/journal work use separate isolated
worktrees with the request shape above agreed first. Store and Native dependent
APIs are reconciled before Cargo; Root serializes full Rust compilation and app
verification on this machine. Base settings reconciliation owns different files.

Required evidence, using real seams and actual failing baselines where possible:

1. Lost initial ACK: repeated same request across host restart uses one original
   guard, one quota charge and exact source; eight distinct requests still hit
   the real shared limit. Temporary shared count/byte exhaustion automatically
   waits without misclassifying a per-request limit. Unknown I/O never replaces an
   accepted guard.
2. Exact cancellation before first Native dispatch and cancellation after a lost
   reply both fence delayed commands. Lost release ACK and repeated cancellation
   are idempotent. Foreign client/store and mismatched witness requests reject.
3. Changed bytes with restored size/mtime, changed inode/parent/logical revision,
   symlink/root changes and malformed receipts cannot author stale mutations.
4. Attach/release/revoke crash boundaries and lost replies preserve atomic status,
   exact intent replay and successor lease captures; no terminal ID resurrects.
5. Migration18/19 to20 preserves bodies, guards, intents, quota and strict schema
   rejection. Existing conditional-write and capture suites remain valid.
6. Journal ACK is held: no capture dispatch. Crash after ACK/before reply: restart
   finds the original request and safely cleans up or resumes accepted intent.
   Multiple pending requests, clean-note/coreCovered shortcuts, newer typing,
   cancellation and old capsules remain protected without false Saved or retirement
   of another generation. Unopened-note cleanup is bounded and never retires an ID
   reachable from canonical, uncertain-CAS or journal-write evidence.
7. Renderer/bridge tests preserve one request through positive fresh admission,
   strict transient classification and terminal scope/protocol rejection. Routine
   host interruption exposes no reopen-vault/manual-save-retry UI.
8. Independent review, integrated focused checks, actual desktop fault campaign
   and verified build/install remain delivery gates. Unit success does not prove
   native UI behavior,800ms usability, or completion of the broader recovery queue.

## Review record

Store/schema/status review: checkpoint_dedup accepted the clarified atomic
transitions, capacity split and legacy representation. Its followup accepted the
bounded pending migration plus indexed legacy-attachment union, superseding the
initial unbounded backfill recommendation. Renderer/journal review:
checkpoint_review accepted exact including-ID ACK barriers, clean-note handling,
full retained-operation reachability and bounded unopened-note cleanup. These
are contract reviews only; no schema20 or runtime acceptance is implied.
