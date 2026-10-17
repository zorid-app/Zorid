# Durable relay RPC adapter execution

Owner: `/root/grpc_server_sol`. Branch `tingkai-c/grpc-relay-adapter`, Orca
worktree `/Users/ctk/orca/workspaces/Zorid/grpc-relay-adapter`, base `5050db9`.
Main integration remains exclusively `/root`; no main or root lockfile writes.

Scope: `crates/zorid-sync-server` adapter, startup, manifest and focused fixtures.
Dependencies: schema owner's `zorid-sync-rpc` generated Tonic service and
`zorid-sync-protocol::rpc` DTO validators. Contract frozen with schema/native
owners on 2026-10-17. Root owns root Cargo lock and integrated verification.
Proposal: `prototypes/grpc-web-proof/REMOTE-SYNC-PROPOSAL.md` at `7b5dea9`.

## Implementation

- `rpc::router(store, origins)` and `rpc::serve_loopback` mirror the named HTTP
  reference APIs. Native HTTP/2 and binary gRPC-Web use one generated service,
  three unary methods and the real existing `RelayStore` connection/database.
- `admission.rs` extracts existing blocking execution and exact-origin validation.
  The HTTP reference's storage behavior is preserved. RPC acquires eight inflight
  and eight blocking permits before body/frame/Prost decoding. Cancellation
  releases only work that has not started; admitted SQLite closures retain their
  own work permit until completion. No independent queue or idempotency cache.
- Before Prost, incrementally bound one five-byte frame prefix, declared method
  payload size, total body size, message count, raw header bytes/count and URI.
  Never reserve a peer's declared length. Reject compressed/text/unknown frame
  modes, request trailers and additional frames. Incomplete bodies have a ten
  second deadline. Prost/domain checks still validate field presence, controls,
  identifiers, offered versions, exact wire bytes and limits.
- Standard protobuf unknown/singular merge behavior remains accepted. Frame caps
  bound total encoded input; postdecode control validators do not establish a
  4096-byte preallocation cap inside an Append. Schema owner/root are assessing
  adversarial decoded-memory amplification before claiming resource acceptance.
- Every handler maps directly to existing `identity`, `append` or `pull`; no SQL,
  account, auth, duplicate lookup, transaction, cursor or snapshot logic changes.
  Exact ZSE1 bytes remain unchanged. Sanitized typed protobuf error details carry
  stable classifications without SQL, credential or ciphertext diagnostics.
- Default fixture startup is gRPC2/binary gRPC-Web. `--http1-reference` is an
  explicit transition fixture; no automatic fallback, public provisioning,
  deployment/TLS or plaintext codec migration is introduced.

## Evidence and remaining gates

Source-only initial checks: `rustfmt --edition 2021` passed for owned Rust files;
`git diff --check` passed. No Cargo build/test run before root's heavy slot.
Independent source review by `/root/default_lifecycle_review_sol/browser_client_slots`
approved `a615f92` + `f4c23d3` with no scoped source blocker. It confirmed unchanged
transaction/auth/duplicate rules, predecode permits/frame bounds, cancel-held work,
sanitized status details, shared native/Web router and preserved HTTP semantics.
It did not compile, execute fixtures or establish actual browser acceptance.
Follow-up `3088871` only strengthens the maximum-size fixture: encrypted payload
and authenticated header reach the exact `MAX_WIRE_BYTES` cap. Worktree is clean
at this freeze; source batch order is `a615f92`, `f4c23d3`, `3088871`, then this
execution evidence update.

Focused pending checks:
`cargo test -p zorid-sync-server -- --test-threads=1` under the root's serialized
slot, with generated schema/service dependencies integrated by their owner.
Fixtures cover real native HTTP/2 durable exact retry and full-size ciphertext,
byte-bounded snapshot continuation, account/vault/read-only/revoked-before-dup
ACK, immutable conflict, bad epoch/features/presence, deliberately lost reply,
binary gRPC-Web exact wire/CORS, malformed/oversized/multi/compressed frames,
and permits held before decoding/after canceled database requests.

These fixtures do not establish actual normal-browser/Electron/standalone CLI
sync acceptance. Root's integrated clients, retained-outbox/cursor/restart and
actual browser frame guard gates remain separate. No production readiness claim.
