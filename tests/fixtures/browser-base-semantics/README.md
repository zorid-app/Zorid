# Actual browser Base semantics proof

This page calls the actual generated Rust/WASM expression evaluator, snapshot
query reducer and `.base` source compiler inside a browser worker. It contains
transport and comparison code only, with no JavaScript formula engine or YAML
parser and no expected-value substitution.

Root owns crate wiring, dependency locks, builds and the heavy verification slot.
The only additional root-owned wiring is:

```toml
# crates/zorid-wasm/Cargo.toml [dependencies]
zorid-bases = { path = "../zorid-bases" }
```

```rust
// crates/zorid-wasm/src/lib.rs module declarations
mod bases;
```

The wrappers deserialize the shared engine's `DetachedRecord`,
`EvaluationOptions`, `BaseSnapshot` and `QueryOptions` directly. Snapshot identity
validation remains with the shared index type. This JSON transport accepts
**graph-less detached snapshots only**; shared deserialization must reject a
non-null relationship graph rather than trust a caller-authored resolver result.
Relationship-dependent Base queries require a later Rust-owned generation/graph
handle seam and their own actual-browser fixtures. A passing run here does not
establish relationship parity. The only local request envelopes
are `{expression, record, options}` and `{configuration, snapshot, options}`.
`compileBaseSource` takes a JSON-encoded source string and returns read-only
decoded semantic configuration; this output must never overwrite the `.base`
source. Shared diagnostics and compile errors are thrown as JSON unchanged.

Transport requests and encoded results have an initial 8 MiB ceiling, separate
from the shared engine's source, property and query budgets. Requested work,
scanned-record, row, group and output ceilings are clamped to the engine defaults;
callers can lower them. These are bounded invocation limits, not a vault-size cap.
Always JSON.stringify input before the `&str` binding so lone JavaScript UTF-16
surrogates become JSON escapes that Rust serde can reject without replacement.

After the root grants a runtime slot and builds matching current web bindings,
serve a checkout containing this fixture, the canonical accepted corpora and the
generated module/binary pair over local HTTP. For example:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory /absolute/checkout
```

Open `/tests/fixtures/browser-base-semantics/index.html`. Query parameters:

- `module`: defaults to `/target/browser-wasm/generated/zorid_wasm.js`.
- `wasm`: defaults to adjacent `zorid_wasm_bg.wasm`, relative to the module URL.
- `expressions`: defaults to `../document-semantics/bases/accepted-expressions.json`.
- `queries`: defaults to `../document-semantics/bases/accepted-queries.json`.
- `documents`: defaults to `../document-semantics/bases/documents.json`.
- `autorun=0`: prepare the page without automatically starting a run.

The Base owner's shared projector owns the accepted expression/query files. Each
accepted case must contain `{id, request, expected}` with optional `repeat` for
expressions. The worker fails visibly if a transport-ready projection is missing;
it never regenerates expectations or silently falls back to the legacy TS corpus
whose historical observations can contain lone surrogates. Source-compile cases
read the exact canonical `source` and check its declared `current.valid` only;
they do not claim source-editing or complete view-model parity.

Expression comparisons check accepted typed values/codes. Query comparisons check
selected canonical fields, including row paths, values, groups, counts and
required diagnostics, and require the returned shared snapshot identity to equal
the request's identity. Only comparison removes diagnostic message prose. Every
downloaded `{id, operation, result}` keeps the actual WASM outcome, including typed
errors and work counts. Expected data is never included as an actual result.

The visible report and `window.__zoridBaseSemantics` contain status, counts,
failures, elapsed time, each canonical corpus hash, the hash of the exact WASM bytes
used for initialization, and the hash of actual results. The page emits
`zorid-base-semantics-complete`, offers actual-results/report downloads, and
terminates its worker after completion. Passing also requires high/low lone
surrogate and wrong-input-type request checks to return `invalid_request`.

Use immutable generated asset URLs or keep the module/binary pair frozen during a
proof. Source syntax checks or a successful WASM build alone do not establish
actual-browser parity, native parity or production consumer migration.
