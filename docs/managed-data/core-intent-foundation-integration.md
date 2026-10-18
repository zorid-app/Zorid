# Portable WorkBlock and retained-intent foundation integration

Root isolated `core-intent-foundation-integration`, base canonical `f8d7a99b`,
2026-10-18. This batch provides portable Rust helper modules only. It does not
activate browser WorkBlocks, origin-aware storage adapters or schema migrations.

Ordered originals: S `88bf6c70`, Limit parity `79d5a775`, retained intent
`2c18532e`, test successor `e19ac304`. Isolated equivalents: `c7cdc381`,
`96edef75`, `c23d3e92`, `60c80b1c`. The S documentation modify/delete conflict
was resolved by retaining the exact complete report from79d5, without source
adjustments. Both new modules and focused fixtures byte-match their original
reviewed targets. Existing records lib/admission/first_party/manifest match the
original22fad source base; lib changes consist only of the two module exports.
No dependency, lock, schema, index, wire or adapter change is included.

Independent root composition reviewer stage5_history_inventory approved exact
60c80b1c after verifying all four new files against original blobs, only two lib
exports and unchanged entire records crate/source dependencies from22fad to main.
No product callers exist outside helper/tests. Transient tuple reuse is semantic
validation only; retained decoder remains strict IntentDocument with no fallback.
This composition review ran no tests/builds and changed no files.

Independent source reviews are retained in browser-workblock-composed-review.md
(S79d5) and origin-portable-review.md (2c185 production plus e19 tests).
The original S report records its historical unexecuted state; subsequent
browser-workblock-wasm-results.md records actual native-target S11 pass and
reviewed S/W composition. It is not generated-WASM/browser acceptance.

Root independently read and hashed both persistent retained-intent logs:

| Actual native-target scope | Result | SHA256 |
| --- | --- | --- |
| local_intent private unit fixtures | 5 pass | 6e6c4663dc2bd434b32f4ee521518cd1fb0b5f260530f37384e575a3736027ba |
| local_intent integration fixtures | 8 pass | 2ed1a86c939bd23301ef5bf7eaa20f8640f9c8dac4f95742ed5a175e573da034 |

Logs remain at `/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-wasm/tmp/origin-portable/local-intent-lib.log`
and adjacent local-intent-integration.log. Source paths/counts and results match
independently reviewed evidence95b4f6c. Root did not repeat compiler/test runs.

Shared WorkBlock commands preserve Rust domain semantics, original remove tags,
strict DTOs and bounded window validation. Retained-intent helpers preserve
canonical original request/registration/witness identity and reject changed
fresh origin even when empty-state bytes match. They do not issue authority.

Storage integration remains required: durable host-issued capture, replay before
current facts/defaults, atomic state/journal/outbox, namespace denial on every
generic path, actual quota/accounting, settlement and unchanged intent after
response loss/restart. Existing adapters are unchanged, so this batch must not be
represented as complete origin-aware cutover or removal of old apply bypasses.
Generated-WASM equality, strict-IDB, SQLite vertical slices, encrypted convergence,
rendered Calendar and mobile retain their separate gates.
