# Durable editor write integration contract

Coordinator decisions, 2026-10-16. This freezes the behavioral requirements for
the optional existing-text-file save path. Implementations and real-platform
acceptance remain pending. Ordinary adapters and editor transaction/history/IME
behavior are unchanged until their own integration gates pass.

## Ownership and identity

- Browser owner maintains shared types and browser persistence/wrappers. Desktop
  owner maintains its wrapper/transport. Native owner owns store identity,
  migrations, native operations and atomic sync ingestion.
- Editor session owns NoteBuffer and its new durable helper/tests, then narrow
  Workspace recovery admission. Core coordinator owns optional VaultAdapter and
  Vault queue/publication seams. No second mutation is allowed during publication.
- `vaultId` in a local plan/ref/checkpoint means the persisted local authority
  UUID, not a path, IndexedDB name, or logical remote sync-vault ID. A recreated
  store gets a new UUID. Moving a store retains it. Copying raw database bytes is
  not detectable as a fork; sanctioned restore/fork rotates local authority and
  writer incarnation while retaining the appropriate logical remote identity.
- A client ID is stable for one recoverable consumer across restart and distinct
  for concurrent windows/tabs. Production selection requires proven ownership of
  that client identity; caller-supplied aliases are not authorization. Explicit
  test clients may use separately assigned fixture identities.

## Coherent reads, plans and receipts

`readText(path)` returns content, stable entry ID and opaque revision from one
committed snapshot. Include the current path as a display locator. Add equivalent
`readTextById(entryId)` for recovery after rename, returning null for a missing or
deleted entry. A path-only read followed by stat does not establish coherence.

`planWrite` requires operation ID, path, expected entry ID, expected revision,
expected content and desired content. It rejects any mismatch before preparing
an intent; commit still performs the actual revision CAS. Revisions are equality
tokens, never timestamps or ordered numbers. Malformed UTF-16/UTF-8 is rejected;
BOM and line endings are preserved.

The immutable plan includes the exact host encoding and local authority/client
binding. Every retry preserves these bytes. A committed outcome must expose the
target entry ID and resulting revision from its persisted Rust CommitResult,
alongside operation ID and decimal-string sequence. This is a historical write
witness, not proof that the entry is still at that revision.

Vault owns serialized, non-writing reconciliation/publication: read committed
current state, compare its revision with the receipt witness, then update cache,
metadata and events. Never call modify/write again to publish an existing receipt.
Projection lag does not invalidate a committed database outcome. Peer advancement
or disappearance retains the latest local draft and a recoverable conflict.

## Durable local checkpoints

LocalStorage success is not accepted as the durable save-handoff checkpoint.
Provide an awaited core-owned local checkpoint store: SQLite FULL transactions
on native; IndexedDB strict readwrite transactions in the browser. Report success
only after commit/transaction completion; reject unsupported durability explicitly.
These are internal recovery-critical data, not disposable plugin-derived caches,
and are not emitted to the sync outbox.

Adopt the browser owner's scoped CAS proposal:

```
load(key) -> Checkpoint | null
compareAndSwap({key, expectedRevision, nextRevision, encodedState}) -> Checkpoint
```

Each checkpoint contains version 1, local authority ID, client ID, key, revision
and opaque encoded state. The caller supplies a fresh UUID nextRevision.
expectedRevision=null means never existed; encodedState=null creates a retained
tombstone. Do not delete the revision fence when clearing a checkpoint.

Rules beyond a simple last-value store:

- A retry with identical inputs returns success only while its nextRevision is
  still the current head. If another update advanced the head, return
  checkpoint_conflict; never overwrite it or authorize an old phase.
- Retain used revision IDs to reject later ABA/reuse, including after tombstones.
  Compact fencing metadata is sufficient; historical full draft payloads need
  not be retained solely for checkpoint idempotency. Changed reuse is rejected.
- Lost checkpoint ACK is independent from lost operation ACK. Retry the exact
  checkpoint request or load its current head; do not silently mint a replacement.
- Startup enumeration is bounded and includes all active checkpoints for this
  authority/client. Use opaque pagination with a stable high-water boundary;
  concurrent changes need a subsequent change pass. Lists expose metadata, not
  all draft bodies. Never silently truncate recovery work.
- Initially bound encoded state to 32 MiB of UTF-8 bytes and reject before host
  allocation/mutation; keep the existing 8 MiB encoded-plan limit. These are
  explicit first-consumer limits, not completed arbitrary-file support. Report
  size/quota failures without truncation or fallback to legacy writes.

Editor owns the versioned opaque state: baseline, latest local draft, exact write
snapshot, identity/revision, display locator, immutable plan, ref when known,
phase, terminal outcome and conflict state. Malformed/unknown versions preserve
raw recovery data and block execution instead of downgrading to legacy drafts.

## Save and recovery ordering

1. Read/validate coherent base and capture the accepted write snapshot. Typing
   during awaits remains a separate latest draft.
2. Persist the exact plan and draft checkpoint before prepare. A failed or
   uncertain checkpoint cannot authorize prepare/commit.
3. Prepare the inert host intent. Persist its matching ref in a commit-ready
   checkpoint before commit. Lost prepare reply retries the original plan.
4. A valid commit-ready checkpoint is explicit authorization to resume that exact
   operation after restart, subject to current vault permissions and entry CAS.
   Listing an orphan prepared intent alone never authorizes execution.
5. Commit/query the same ref. Uncertain outcomes never create a new operation or
   fall back to legacy writes. Native/browser core may replay commit_requested
   intents according to their already durable authorization.
6. Persist reconciled base, latest typing/conflict and exact pendingAck atomically
   before acknowledging a terminal outcome, even when the visible text is clean.
7. Exact ACK is idempotent. Retain queryable terminal outcomes and operation fences
   for this milestone; no automatic GC. A missing ref is an error, never success.
8. Clear operation metadata only after confirmed ACK, using checkpoint CAS and
   preserving any newer draft. Failed cleanup leaves a harmless retryable record.

Startup reconciles unopened checkpoints without mounting editors. Same-entry
rename changes only display location; a replacement entry never inherits a plan.
Old/new locator duplicates deduplicate by operation identity, not by path.

Keep the existing dirty/lifecycle guard true while a write or ACK is unresolved;
internally distinguish committed-but-recovering from unsaved content. Historical
outcome reconciliation may continue after a view validator retires, but that
validator must still prevent authorization of new writes to retired targets.

## Failures and acceptance

Only an authenticated/validated persisted terminal rejection is definitive.
Transport, decoding, checkpoint, post-commit read/publication and unknown response
failures remain uncertain. Persist a rejected outcome and retained draft before
ACK; never silently rebase/retry the rejected write against a newer entry.

Reference acceptance is the editor review's crash, typing, peer/identity,
persistence, lifecycle and real-platform matrix. Mock tests are necessary but
insufficient. Production selection stays disabled until real browser worker/tab
and desktop/CLI restart tests prove the protocol. Binary/create/move/delete
consumers and all-file sync remain required separate work, not covered by this
text-save capability.


## Editor key, typing mirror and publication decisions — 2026-10-16

The entry-keyed consumer checkpoint uses `note/v1/<entryId>` (within the shared
1024-byte key bound). The private editor checkpoint records a writer-incarnation
UUID and monotonic draft generation alongside its versioned draft/operation
state. These identify typing order within one admitted consumer; wall-clock
ordering is not evidence of authority.

The synchronous editor update may keep a separately labelled best-effort local
mirror for typing that has not yet reached an awaited strict checkpoint. The
mirror is scoped to local authority, client and entry, contains the checkpoint
revision it was based on, and never authorizes prepare/commit/ACK. Automatic text
recovery requires a provable exact current checkpoint anchor, matching identity
and baseline, and a newer generation in the same writer incarnation. Equal text
may deduplicate; ambiguous or divergent records preserve both alternatives.
Legacy path-only drafts must not retarget a recreated entry. Pending operation
state always comes exclusively from the durable journal. This does not promise
that an immediate process death before any persistence preserves every keystroke.

Vault's optional facade names are `readDurableText(path, validate?)`,
`readDurableTextById(entryId)`, `commitDurableWrite(ref, {validate?})`, and
`reconcileDurableWrite(ref, receipt)`. Reconciliation discriminates `current`,
`advanced` and `missing`, returning the coherent current observation when present.
The initial slice publishes only the witnessed current revision. Advanced/missing
observations preserve drafts and block new writes; they do not constitute complete
namespace cache recovery. Stable-ID coherent namespace refresh remains required;
watcher delivery alone is not acceptance evidence.

Consumer admission is platform-owned. The editor can implement against an injected
admitted context from `checkpoints.scope`; ordinary selection stays disabled until
stable restart identity and exclusive concurrent-client ownership are proved.
Explicit fixture UUIDs still require exclusive ownership when a consumer is active.
