# Family sync browser verification

## Updated integration candidate

Candidate `11d2544` includes strict file payload encoding for retries and exact
namespace metadata validation, with main's recovery crypto dependency reconciled.
Independent review approved `0bd1437` plus the browser test correction `11d2544`.
Focused native session49449 passed 30 client-sync tests, 17 WASM tests and one
compile-fail documentation test. Pinned release build session66465 exited0.
Actual Chrome again visibly reported all10 groups successful using that rebuilt
artifact. The new encoder and namespace regressions run within those groups.
The owned tab and server session82677 were closed after verification.

The exact WASM crate, fixture subtree and native exchange helper were then
staged into main; its native session22746 passed all17 wrapper tests. Core,
CRDT, crypto, protocol, file-sync and client-sync source dependencies match the
validated candidate. Cargo.lock adds only the new workspace crate entry.
Browser persistence and end-to-end relay convergence remain separate gates.

## Earlier boundary run

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
