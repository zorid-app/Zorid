# Managed records browser storage slice

Owner B: `term_8f92328c-7dcf-4e29-b2d3-3b2c8f4c1895`, task
`task_9a39a3f73dde`, dispatch `ctx_6eb7e997f771`, branch
`tingkai-c/managed-records-browser`, based on `61e04f92`. The coordinator alone
integrates main. Initial scope was new adapter/tests; coordinator message
`msg_a4cfa7909581` assigned the opener, shared family dispatcher/types and narrow
existing fixtures after direct A/B DTO agreement. No worker-host, public client,
UI, manifests, lock, generated bindings or native code changed here.

Authority is native `2276582d` / integrated `f26eb0b5`, foundation
`browser-adapter-seams.md` at `df764648`, and A's agreed private byte DTO in
`browser-private-seam.md`. A owns all Rust admission/classification/canonical
serialization. B found and reported the opaque server-epoch issue; A corrected
it. Canonical source binding/replay validation and source provenance use A's
new Rust exports; the coordinator owns the final structural
`recordsStoredReadSet` export. That structural readset is not authentication.

## Implemented storage boundary

- Fresh IDB format **8** creates six compound-key records stores in the existing
  authority DB. Formats 6 and 7 are rejected and retained. The opener checks exact
  key paths and index inventory. No second database, outbox or relay cursor.
- The returned `vault.managedRecords` is an explicit frozen facade containing only
  `register`, `apply`, `snapshot`, `retryPage`, `changes`. Authenticated receive,
  private prepared tokens/commit hooks, validation and key state stay inside the
  streaming engine. Records dispatch runs before any file/text graph dereference.
- Collection handles bind the factory closure and exact registration revision.
  Identical registration preserves revision; replacements use shared Rust checks
  and restore every accepted state against the replacement. Current authority and
  owner/session admission are checked by unchanged `normalizedTransact`.
- Local exact request bytes are made by Rust after registration authorization.
  Exact replay checks request equality and validates the retained typed result
  through Rust **before** reading accepted state, restore evidence, commitments
  or new-write quotas. State, projection, command, request, result and operation
  content remain raw bytes or opaque nested JSON strings. No JS i64 round trip.
- A new local write atomically installs complete state/projection, canonical
  source commitments, one durable change and local replay. Synced writes use the
  existing common immutable source accounting and authored outbox order;
  Local/Cache write no common sync rows. Rust prepares/adjudicates all semantics.
- Incoming private plans compare fresh complete facts in the final strict writer:
  registration/state/restore bytes, all same-generation source commitments,
  receipt revision, DB-wide usage and shared cursor. Exact common payload/wire,
  enrolled configuration and common received/authored evidence are rechecked.
  Rust-listed conflicts quarantine prior waiting **and invalid_operation** receipts
  while retaining accepted history. The whole batch is atomic.
- Exact incoming duplicate replay runs before accepted-state decode and fresh
  quotas, requires the received receipt or verified authored/local evidence, and
  advances only a supplied common delivery cursor. No received authored echo.
- Retry selects only receipt metadata in stable exclusive update-ID order,
  delegates status eligibility to Rust, and stops at 16 receipts / 1 MiB full
  plaintext lengths before fetching excluded bodies. It opens retained exact
  wire with an actual key and reads each selected stored plaintext exactly once
  in that receipt's separate strict CAS transaction. A bad child cannot roll back
  a committed parent. Continuation persists separately; crash reexamination is safe.
  No retry changes the already-consumed relay cursor.
- File/text and records additions, including first wire sealing, share the existing
  4096-row / 128 MiB metadata admission limits on authored/envelope stores. This
  is browser backpressure, separate from Rust's domain quotas. Failed admission
  rolls back immutable source bodies, family rows, counters, outbox and cursor.
- Startup revalidates accepted state/projection with Rust, canonical replay and
  canonical operation structure, then proves operation content against its exact
  common payload or accepted Local/Cache history. It checks reverse common ledger
  ownership, complete receipt scope/restores and all source-operation/local replay
  binding links, and recomputes records counters without scanning byte-body stores.
  `snapshot` returns current unresolved statuses and the durable change position.

Strict `oncomplete` is the only transaction success. A candidate `done` is not a
receipt. Lease loss while abortable aborts writes. Revocation between the final
callback and completion can commit; the postcommit guard may suppress the response.
That is response loss, and exact replay after reacquisition proves the durable
outcome. A close/versionchange cannot retroactively promise rollback.

## Session and missing consumer seam

The existing `sync.bindSession` child and parent share only a closure-private
records session context. Captured retry guard/key identity is carried through
prepare, IDB callbacks, common source checks, strict CAS, continuation and response.
A trusted internal opener option `managedRecordsSession()` may supply
`{key, sessionToken: stableObject, assertActive}` for retained startup proof. The
factory snapshots key/token/assertion, detects same-wrapper token/key rotation,
and fails if a configured getter reports absence. No key/plan/authenticated update
constructor is exposed through the facade or worker messages.

Normal worker lifecycle remains a separate assigned phase: install first-party
registration after lease, supply the actual current key/session at startup, schedule
coalesced startup/foreground/parent/registration maintenance, yield after bounded
passes, catch up durable changes after missed hints, and drain/fence on release.
The storage adapter does not start another sync loop or schedule unbounded passes.
Its retry return reports `changed`/`exhausted`; a no-progress sweep must wait for a
new host trigger. This slice does not establish autonomous normal-worker recovery.

## Verification and limits

Focused Node tests use staged injected-IDB and opaque Rust/key doubles. They prove
storage orchestration, not cryptography, CRDT semantics or actual browser durability.
The cursor double was corrected to count each deferred `continue()` request; this
lets nested exact source reads keep the transaction alive like real IDB.

Commands run without dependency installation:

```sh
node --test --test-concurrency=1 tests/browser-managed-records.test.ts tests/browser-normalized-idb.test.ts tests/browser-sync-streaming.test.ts tests/browser-streaming-vault.test.ts
/Users/ctk/Projects/Zorid/node_modules/typescript/bin/tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom,dom.iterable --strict --allowImportingTsExtensions --skipLibCheck src/core/browser-streaming-vault.ts src/core/browser-sync-streaming.ts src/core/browser-managed-records.ts
git diff --check
```

The tests cover held/failed completion, rollback, Local/Cache replay after newer
or corrupt accepted bytes, changed command/target/revision identity, private handles,
opaque i64 extrema, sequence >2^53 and signed-i64 exhaustion, exact duplicate cursor
progress, fresh commitment/cursor CAS loss, waiting/invalid conflict transitions,
16/17 and 700/400 KiB retry continuation, exact 1 MiB, one selected body lookup,
source/replay corruption and reverse links, actual bindSession key sharing,
post-AEAD callback session loss, same-object same-key token rotation, configured
provider absence, mixed-family ledger capacity including seal, retained prior
snapshot after rejection, old format retention and missing/extra records indexes.

Actual rebuilt A WASM + real Chrome IDB/worker, encrypted mixed-family reopen,
all Rust quota/restore/classification differentials and normal-worker lifecycle
are coordinator-owned remaining gates. No actual browser, desktop/native/mobile,
full product parity or Tasks/Calendar UI result is claimed here. This work ran no
Rust compiler, heavy build, iOS or simulator pass.

Final B focused run: **82/82 pass**, serial test concurrency (22 new adapter,
16 unchanged normalized foundation, 39 streaming sync, 5 opener). Scoped TypeScript
and `git diff --check` pass. Final review correction binds Local/Cache local-row,
commitment-row and accepted-row **complete** scope, including `restores`; received
bindings likewise match the exact source scope. No browser/native result is
inferred from these Node fixtures.
