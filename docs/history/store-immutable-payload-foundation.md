# Immutable exact plaintext foundation

Current verification update (2026-10-17): Store library gate19472 passed86 tests,
0 failures,1 explicit ignored64MiB fixture. Earlier source-only/unrun wording
below records preparation state; the authoritative gate history and remaining
native/client gaps are in `docs/history/store-binary-streaming-activation.md`.

Status: additive source prepared; no builds or tests run. Owner
`/root/package_sol/cli_tests`, parent `/root/package_sol`; worktree
`store-binary-streaming`. Parent owns module/schema-11 registration and adapter
changes. This module alone does not remove existing body copies or activate
streaming commits, publication, reads or ingress.

`crates/zorid-store/src/immutable_payloads.rs` provides crate-private
`SCHEMA`, `PayloadHead`, `head`, `put_exact`, `read_exact` and `total_bytes`.
`immutable_payloads` has one exact plaintext BLOB per realm/vault/update key,
with family, byte count, SHA256 and optional files-v2 descriptor/summary digest.
The table has no ledger/stage FK because invisible staging must precede commit.
Its rows and restored metadata are not authentication capabilities. Callers must
bind independent ledger/stage metadata and own an IMMEDIATE transaction covering
quota checks, insertion and reference changes.

Bodies are limited to 1 MiB; file descriptors use the portable
`MAX_GRAPH_RECORD_BYTES` bound (1 MiB plus 4096 bytes). SQL checks persisted lengths
before loading Strings or bodies. File writes strictly decode the exact accepted
bytes and bind scope/update ID, exact payload digest and typed summary. Accepted
JSON whitespace is retained and committed as supplied, rather than replaced by
canonical reencoding. Text envelope validation continues to belong to the
existing caller; this module checks its supplied metadata commitment and stores
no file descriptor for Text.

Repeated same-key puts require the same metadata, descriptor and exact body.
Changed duplicates fail; no body or commitment is updated. Reads require
independent envelope metadata, then recheck exact hashes and file summaries.
An expected missing backing row is corruption, rather than a missing download.
Database triggers reject UPDATE, DELETE and duplicate-key INSERT, including
INSERT OR REPLACE, so another normal writer cannot invalidate a verified source
between verification and a later transaction. Fault fixtures explicitly remove
the update guard before deliberately corrupting stored bytes or metadata.

Quota is an injected positive finite u64 bounded by SQLite's i64 range, with no
default. Byte accounting uses all actual retained BLOB lengths, including
sources referenced only by aborted stages. Same-key exact retry consumes no new
quota and remains valid if the caller passes a lower positive cap. This module
contains no deletion or GC.

Six private SQLite-only fixtures are prepared: exact retry/changed duplicate,
whitespace commitments, missing/corrupt sources, input/stored bounds and quota,
independent scope/summary checks, and Text descriptor absence. They do not open a
Store or claim integration with stage, authored or graph ownership. Parent must
complete those shared references and run the granted serialized checks.
