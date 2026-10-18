# Managed records browser storage verification

The internal Rust/WASM and normalized IndexedDB records slice is implemented and
independently source-reviewed. This is a storage milestone, not whole Phase1,
normal-worker activation, plugin API, product UI, desktop or mobile acceptance.
The complete implementation goal remains active.

## Final assembled source

Feature branch `tingkai-c/managed-records-integration`, tested browser HEAD
`ad6481b708073a301b55836b3146882cd96bd73a`; final product source
`39880fbe98fffdc6dea50e0085b109354ab0ec7a`. Main integration remains owned by
the shared-core coordinator. Source work was assembled/tested here first.

Records remain a separate model and encrypted payload family from files/text.
They reuse the common exact immutable source ledger, authored outbox, AEAD
transport and relay cursor. Accepted state is causally complete; unresolved
receipts, losing history and operation commitments remain durable and bounded.
Local/Cache policies create no sync outbox work.

The native admission extraction preserves SQL, transaction boundaries, host
authorization, replay ordering and restore checks. Private WASM plans preserve
canonical bytes and i64 values. Browser commits use the existing strict IDB
authority, private receive capability/context, full precondition CAS and
post-completion success. Fresh development schema8 rejects old formats intact.
See [private seam](browser-private-seam.md) and
[browser storage contract/evidence](browser-storage-seam.md).

## Observed checks

| Check | Exact scope and observed outcome |
| --- | --- |
| A native/portable/binding checks |125 pass at frozen e99ecef5: portable admission6+wire13, Store managed24+family3+numeric reopen1+ledger7+immutable6, native-target WASM65. Exact commands/source hashes in private seam report. |
| Final helper changes |Integration62a40 records binding subset16/16 pass, session85887exit0, `/private/tmp/zorid-records-final-helpers-4ee71410.log`. Includes two new structural readset/positive-sequence traces; does not mean125+16 unique tests. |
| Browser unit orchestration |83/83 serial Node checks at B9692e1bf:22 adapter+16 normalized+40 streaming+5 opener. Injected IDB/Rust tests; commands and limits in browser storage report. |
| Full project TypeScript |Exit0 session33721, zero diagnostics, `/private/tmp/zorid-managed-records-full-tsc-ad6481b7.log`. Existing main dependencies reused without installation/lock changes. Initial attempt lacked links in the isolated checkout; no source fix was needed. |
| Actual wasm32 artifact |Exit0 session55965,22.01s, `/private/tmp/zorid-managed-records-wasm-62a40caf.log`, pinned Rust1.95/bindgen0.2.129. |
| Actual Chrome155 + WASM + IDB |Eight groups pass at ad6481b7, terminal session22166exit0; exact sources/artifacts checked before/after.69 strict completes,8 abort events,7 disposable DB deletions and owned Chrome/server/profile cleanup verified. |

Production browser bundle result is recorded in the final integration checkpoint.
No full Rust/Node suite campaign was launched for this feature.

## Concrete defects caught and corrected

- An introduced projection JSON parse could round f64 values. Shared projection
  Value avoids that parse. A separate authored snapshot->restore test reproduced
  an existing Codec failure for51.248178375505404; the records crate enables
  serde_json float_roundtrip. Canonical equality stays strict; native/binding
  fixtures validate the deliberate process-wide parser feature unification.
- Raw receive/commit helpers escaped through the browser facade. Only the five
  intended trusted-host methods are exposed; authenticated receive hooks remain
  closure-private, with exact opened-object enrollment context.
- Shared ledger admission, including sealing, now preserves existing scan limits
  across files and records, avoiding durable states that cannot reopen.
- Startup validates canonical replay, complete scope, source/history provenance
  and reverse receipt/binding coverage. Local/Cache restores metadata matches
  validated accepted state; six-component storage keys still exclude restores.
- Retry pins scalar key/token/session guards through callbacks and CAS, including
  in-place token rotation. Final receive compares the full enrollment context
  captured before AEAD, for fresh, duplicate and retained receives.
- Local result creation and replay now reject zero consistently with persisted
  validation, while positive signed-i64 sequence boundaries remain exact.

Independent source/test-logic reviews by separate workers approved frozen A e99,
final A helper62a40, B9dcf correction slices and B9692 context followup. Exact
hashes and review scope are retained in execution.md and orchestration messages
msg4f062445cca2, msg8298ff27f982, msge318b4b37562 and msgc644dda618b2.
Reviewers did not claim runtime execution.

## Actual browser proof

[Final proof](../../tmp/managed-records-browser/artifacts/final-ad6481b7/proof.md),
[raw report](../../tmp/managed-records-browser/artifacts/final-ad6481b7/report.json),
and [artifact checksums](../../tmp/managed-records-browser/artifacts/final-ad6481b7/SHA256SUMS.json)
are preserved with the reproducible fixture/runner. The eight groups cover
lossless i64/f64 reload and authenticated wire; late exact replay after newer
state; Local/Cache no-outbox behavior; one encrypted records/files/text cursor;
tamper/scope/format/cursor refusal with all stores unchanged; dependency/invalid
child recovery; actual post-AEAD enrollment races on fresh, duplicate and
retained paths; and real abort after a state write with reopen verification.

The enrollment-race cases compare all31 stores to a snapshot taken after only
the explicitly injected config mutation; every downstream record/source/receipt/
cursor mutation is rejected. No fake capability or transaction proves this gate.

Rust build fingerprint: a4027f128c91099071a2744f90a599b9151ee623599f3e4b7c4846283a16e0f8.
WASM SHA256: b8e316e2a8d4e8a498c0e8f2d48b844d3b3db4ca51513bbd000674f26283ae2e.
Glue SHA256:1145a203bda8c72a6e017e87f0adda6df4b5c9d992d802c56ece864538ffae31.

## Remaining required work

Real-browser full retry count/byte/continuation, quota/replacement, generation
restore/equivocation, signed-i64 exhaustion and cross-tab lease matrices remain.
Normal worker trusted registration, startup/foreground retry, subscriptions and
shutdown draining are separate next ownership seams; the fixture's private
trusted host is not proof of autonomous worker operation. Independent deployed
clients/relay, desktop/native/mobile delivery and all later plan phases remain.
General semantic migrations and public plugin API are not implemented by this
slice; incompatible schema operations remain durable unresolved receipts.

Read-only comparison against main2edada5b found no changes since feature base
61e04f92 in crates, src/core, src/platform or Cargo manifests/lock outside this
feature. Main's separate native UI/history work is preserved. No merge into
main by this feature coordinator is authorized or claimed here.
