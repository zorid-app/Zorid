# Store binary-streaming foundation

Owner: `package_sol`. Isolated Orca worktree: `store-binary-streaming`, branch
`tingkai-c/store-binary-streaming`. Main integration remains with the shared-core
coordinator. This is an additive foundation, not a completed streaming client.

## Dependencies and ownership

The branch began at main `45f9fbe`. Scanner store seams `a8e970d` and their
explicit-import correction `7e114fa` are picked as `5496134` and `ec2bc3d`.
Portable metadata/streaming foundation `7edbb72` is picked as `65086ba`.
The portable owner reports its exclusive file-sync library gate passed 73 tests;
that does not establish store integration. Native scanner decoder counterparts
remain with `external_reconcile_sol`.

`cli_tests` owns the new stage module and its seven tests; `package_sol` owns the
descriptor index, ledger provenance, central schema/reservations and existing
store seams. `packaging_review` independently reviews the store candidate.
No one in this branch integrates into main.

## Implemented source

Schema 10 adds durable invisible binary stages and a descriptor index beside the
existing immutable exact `family_file_records` plaintext row. Earlier unreleased
schemas are rejected before WAL or database mutation; there is no migration.
File envelope metadata commits both the exact accepted plaintext digest/length
and the canonical typed descriptor summary. Authenticated receive derives the
summary from its authenticated capability; local authorship derives it from the
exact emitted bytes. A descriptor is metadata, never authentication or a cached
verification proof.

The descriptor loader reads bounded metadata and length/count aggregates. It
does not collect payload/wire BLOBs. The chunk resolver fetches one exact payload,
checks ledger and summary commitments, then returns at most 128 KiB. A descriptor
whose backing plaintext is missing is damaged storage. The portable trait adapter
preserves the original native storage error. Existing wire ownership checks,
including authored sealed-wire equality, remain in the metadata-only ledger head.

Stage operations are explicitly enrolled and store/client/operation/scope bound.
Exact begin retries and explicit resume recover the original locator. Appends
reserve update IDs, reject gaps, changed duplicates and noncanonical tails, and
persist one bounded exact emitted payload per chunk. EOF/page allocation is
durable before sealing. Sealing reads durable sources incrementally, re-emits
and compares exact local payload commitments, and checks the whole-file digest.
The opaque finalized reference has no public deserializer and is not a receipt.
Ordinary mutations/intents and received envelopes cannot consume staged operation
or update identities. No stage operation adds entries, receipts, outbox records
or projection jobs. Abort retains bytes and reservations and is not garbage
collection. See [stage details](store-binary-stage-foundation.md).

## Limits and activation gates

Fixed bounds remain 64 MiB per binary, 128 KiB per chunk and the existing 1 MiB
plaintext/wire payload contract. Stage quotas are explicit injected finite
`StreamingLimits`; there is no default enabled by this foundation. The existing
4096-record, 128 MiB legacy-state and whole-manifest verification-work limits are
not silently raised. Descriptor wrappers have the portable bounded 4 KiB overhead
allowance; this is a local descriptor bound, not a wire-format change.

The final portable metadata author/receive plan and manifest-backed binary event
planner must freeze jointly before a public binary commit exists. Activation must
share one immutable plaintext source across staging/authored/graph references,
replace legacy whole-state loading in status and mutation paths, replace inline
binary materializations/baselines/observations/projection copies with typed refs,
and retain the original receipt/outbox/CAS/cursor atomic boundary. Current legacy
consumers and their existing copies are still present; this foundation makes no
large-file activation claim. A tagged operation request must adapt existing
receipt decoders; an empty inline mutation is not a reference operation.

Before activation, jointly approve and test separate finite causal-event,
chunk/page, retained raw-byte and stage quotas. No pruning or hidden legacy-body
fallback is permitted. Read pins must retain exact metadata and selected content
identity across range reads; a final commit must recheck that exact state and
source commitments. Unknown commit results must replay the original operation
receipt/projection or typed rejection; a receiving stage is never automatically
sealed or committed after restart.

Stage seal verification currently holds an IMMEDIATE transaction while checking
up to 64 MiB. This bounds allocations and excludes concurrent stage mutation,
but can hold the database write lock during hashing. It is a known foundation
performance limitation, not proof of the planned short final publication commit.

## Verification record

Source formatted and `git diff --check` clean. Store compilation/tests have not
run yet. Prepared tests cover seven stage lifecycle/integrity cases, two descriptor
source-integrity cases, and the existing byte-preserving old-schema rejection
case extended to schema 9. Independent source review is in progress. Record exact
source freeze, command/handle/exit and observed results here after the serialized
gate; do not infer store or application runtime acceptance from portable tests.
