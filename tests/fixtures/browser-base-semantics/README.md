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
zorid-index = { path = "../zorid-index" }
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
Relationship-dependent Base queries use the separate `queryBaseFromSources`
factory, which accepts exact source inputs, constructs a Rust-owned generation
and invokes shared `query_generation` on its derived resolver view. The report
separates these factory cases from graph-less detached cases; it does not claim
production persistence, incremental host indexing or full relationship parity. The only local request envelopes
are `{expression, record, options}` and `{configuration, snapshot, options}`.
`compileBaseSource` takes a JSON-encoded source string and returns read-only
decoded semantic configuration; this output must never overwrite the `.base`
source. Shared diagnostics and compile errors are thrown as JSON unchanged.

The bounded source-generation factory envelope is
`{source: SourceSnapshotId, snapshotId: IndexSnapshotId, entries: EntryState[],
sources: GenerationSource[], facts: FilePresentationFacts[], configuration,
options}`. It invokes shared `Generation::from_sources` and `query_generation`;
it accepts no graph, metadata overrides or JavaScript resolver output. The index
factory caps complete inventory at 32 entries and aggregate decoded text at
16 MiB; this fixture transport retains its stricter 8 MiB JSON cap. Index errors
are typed `{code: "index_error", error: <shared snake_case IndexError>}`. The
factory performs no storage publication and is separate from the production
browser index host's incremental pump/restore/search wrappers.

Transport requests and encoded results have an initial 8 MiB ceiling, separate
from the shared engine's source, property and query budgets. Requested work,
scanned-record, row, group and output ceilings are clamped to the engine defaults;
callers can lower them. These are bounded invocation limits, not a vault-size cap.
Always JSON.stringify input before the `&str` binding so lone JavaScript UTF-16
surrogates become JSON escapes that Rust serde can reject without replacement.

After the root grants a runtime slot and builds matching current web bindings,
serve a root-prepared allowlisted asset directory containing only this fixture,
the canonical accepted corpora and the matching generated module/binary pair.
Keep their documented URL paths when staging. For example:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory /absolute/allowlisted-fixture-assets
```

Open `/tests/fixtures/browser-base-semantics/index.html`. Query parameters:

- `module`: defaults to `/target/browser-wasm/generated/zorid_wasm.js`.
- `wasm`: defaults to adjacent `zorid_wasm_bg.wasm`, relative to the module URL.
- `expressions`: defaults to `../document-semantics/bases/accepted-expressions.json`.
- `queries`: defaults to `../document-semantics/bases/accepted-queries.json`.
- `generationQueries`: defaults to `../document-semantics/bases/accepted-generation-queries.json`.
- `documents`: defaults to `../document-semantics/bases/documents.json`.
- `autorun=0`: prepare the page without automatically starting a run.

The Base owner owns the canonical accepted expression, detached-query and
source-generation-query files, using the shared projector where applicable. Each
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
surrogate, wrong-input-type and caller-authored relationship-graph request checks
to return `invalid_request`. The graph check reuses a canonical valid detached
query and adds a non-null graph; silently ignoring it is a test failure. A source
revision changed in an otherwise canonical factory request must return the
shared index `stale_source` error before any result can be accepted.

Use immutable generated asset URLs or keep the module/binary pair frozen during a
proof. Source syntax checks or a successful WASM build alone do not establish
actual-browser parity, native parity or production consumer migration.
