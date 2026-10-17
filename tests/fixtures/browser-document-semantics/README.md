# Actual browser document corpus proof

This isolated fixture page fetches the canonical Markdown corpus by URL and calls
`parseDocumentMetadata(JSON.stringify(request))` from the real generated
Rust/WASM module in a browser worker. Expected metadata is used only for comparison;
it is never substituted for actual output. No JavaScript Markdown/YAML parser or
precomputed native result is used.

Root owns WASM crate wiring, dependencies, builds and the serialized runtime slot.
The wrapper requires these two root-owned changes:

```toml
# crates/zorid-wasm/Cargo.toml [dependencies]
zorid-document = { path = "../zorid-document" }
```

```rust
// crates/zorid-wasm/src/lib.rs module declarations
mod document;
```

After the root builds the current generated web bindings, serve a checkout
containing this fixture, the current canonical corpus and those generated assets
over local HTTP. For example, after an explicitly granted verification slot:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory /absolute/checkout
```

Open `/tests/fixtures/browser-document-semantics/index.html`. Defaults are:

- `module=/target/browser-wasm/generated/zorid_wasm.js`
- `wasm=zorid_wasm_bg.wasm` (resolved relative to the module URL)
- `corpus=../document-semantics/markdown/corpus.json` (relative to the page URL)
- `autorun=1`; use `autorun=0` for a manual start.

All URLs are configurable query parameters. Prefer the root's immutable hashed
asset directory when it is available. The module and binary must be the matching
generated pair. The worker explicitly initializes the module with the exact WASM
bytes included in its SHA-256 report; changing assets during a proof is unsupported.

A completed run exposes `window.__zoridDocumentSemantics`, emits the
`zorid-document-semantics-complete` event and displays corpus/actual-result/WASM
hashes, counts, elapsed time and individual failures. `status: "passed"` requires
all canonical cases and all four malformed-request checks to pass. Bootstrap,
fetch, missing-export, extraction or comparison failures remain visible failures.
Work runs off the UI thread; the page terminates its worker after completion.

Download actual results as exactly `[{"id": case.id, "result": actualMetadata}, …]`
for independent comparison with:

```sh
node tests/fixtures/document-semantics/markdown/verify.mjs --results /absolute/browser-document-results.json
```

The report additionally records the actual thrown JSON for invalid IDs/revisions
and high/low lone UTF-16 surrogates. Always JSON.stringify request objects before
the `&str` binding: JSON escaping makes those invalid Unicode requests observable
to Rust serde, avoiding TextEncoder replacement of a directly passed JS source.
The Rust binding checks a separate bounded transport size before deserialization,
then the shared parser enforces its decoded 16 MiB source cap and YAML budgets.
Malformed YAML remains a successful metadata result containing diagnostics.

This page is a verification harness, not production consumer integration. A source
checkpoint or successful build alone does not establish native/WASM/browser parity.
