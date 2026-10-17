# Desktop bounded binary consumer

Owner: recovery_ui_sol, isolated `desktop-binary-streaming` branch based on
`ab7e44b`. Main integration and native runtime verification remain coordinator-owned.

The desktop consumer uses generated `zorid.stream.v1` protobuf commands and
results inside the existing admitted IPC and framed stdio transport. Each
request carries at most one 128 KiB binary chunk; the frame cap is 147,456 bytes.
Every chunk and commit reuses the existing dispatch-time client lease and window
generation checks. There is no listener, daemon, alternate storage authority,
whole-body base64 field or body-bearing binary checkpoint.

Renderer checkpoints retain immutable Create versus Write targets, operation and
stage locators, seal requests and explicit commit authorization. Receiving and
sealed stages remain inert at startup. Unknown commit outcomes query the same
stage and retain the original operation ID; terminal rejection settles recovery
without authorizing another operation. Native/Store owns original-receipt replay,
CAS, binary source proof and filesystem publication. The first-pass Store bound
is an exact 24 KiB serialized receipt checked before final commit; an oversized
receipt rolls back publication and durably records TooLarge. Create paths are
bounded to 4,096 UTF8 bytes so the receipt plus escaped checkpoint wrapper fits
within 64 KiB. Receipts are never truncated.

Read checkpoints persist a caller lookup ID before open. The returned server pin
token is distinct. Lost open acknowledgments retry the same lookup ID; startup
closes its recovered pin. Close is checkpointed before dispatch, and a lost close
acknowledgment can be retried without evicting another active reader. Native pin
resolution preserves the original selected content event and revision. A drained
renderer capability stays retired while exact client release is pending or its
acknowledgment is unknown.

Namespace planning and stat reuse the existing body-free list snapshot, retaining
entry identity/revision. Only Text expected-content CAS rereads bytes, with an
additional identity/revision check. Convenience binary reads inspect metadata
before reading and reject above 16 MiB with stream_required. Shared Vault source
and sink methods provide the chunked transfer API; this consumer patch alone does
not establish that every renderer import/export entry point uses it.

Dependencies, integrated separately by the coordinator:

- Shared capability `40b1104` and Vault/source/sink wrappers `5bf0ca7`.
- Generated OpenRead lookup ID at protobuf tag 4, `bcac42f`.
- Store functional activation `2921096` and native wrappers `d42f82d`, plus their
  ordered portable/content foundations.

Focused validation in this isolated branch:

- 69 Node desktop transport/admission/metadata/text-command checks passed.
- 10 renderer binary phase/read-pin recovery checks passed.
- 4 platform desktop checks passed, including uncertain release retirement.
- TypeScript noEmit and diff whitespace checks passed.
- Independent source review covered the host, bounded process fixture, renderer
  recovery and IPC/admission/platform seams. No native build was run here.

The added actual-stdio fixture generates 129 chunks (16 MiB + 128 KiB), verifies
chunk receipts, exact original commit retry, metadata-only inventory,
stream_required, stable open retry, old-token non-rebinding and typed ownership,
version and unknown-operation failures. It checks pinned bytes and the physical
file with incremental SHA256 and bounded buffers. This fixture is source-only
until the combined Store/native/host gate compiles and executes it. Native,
browser, CLI and mobile runtime parity is not claimed by the Node results.
