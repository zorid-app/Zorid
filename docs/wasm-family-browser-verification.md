# Family sync browser verification

On 2026-10-16, Chrome executed the real Rust/WASM worker fixture from
`core-wasm-integration` fixture commit `6f3ade8`, using the compiled Rust
artifact from `f79a294`. Independent source review approved both revisions.
The page at `http://127.0.0.1:8766/` visibly reported `ok: true` and ten
successful check groups. This is a transcription of the observed page result,
not an exported browser trace.

The six existing groups covered concurrent UTF-16 CRDT edits with duplicate
and reordered delivery, snapshot reconstruction, deletion-only updates,
invalid-input errors, Rust mutation planning, and exact idempotency checks
including decimal sequences above JavaScript's safe integer range.

Four new groups covered file-v2 text namespace authoring and common update
identity; authenticated peer namespace receive through opaque capabilities;
combined text/namespace preconditions, no-echo and tamper rejection; and raw
transport decoding with u64 strings and duplicate-field/numeric-cursor rejection.

The frozen Rust source also passed 15 native wrapper tests and the pinned
WASM release build before this browser run. The owned test tab was closed
and the loopback fixture server stopped afterward.

This proves in-memory browser execution of the tested boundary. It does not
prove IndexedDB atomicity, relay/CORS integration, cross-client convergence,
crash recovery, or production security. The candidate dependency snapshot
predates the main recovery bundle; current-main integration and the subsequent
namespace-metadata strengthening require their own validation.
