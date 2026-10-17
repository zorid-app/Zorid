# Actual browser document-index acceptance

Source-only until the coordinator grants and records the serialized build/browser
slot. This page uses the real `BrowserCoreRuntime`, its production worker,
`admitBrowserClient`, normal file commands through `defaultBrowserAdapter`,
normalized IndexedDB authority, and generated Rust/WASM index/Base methods.
There is no semantic or storage double and no relay credential requirement.

Build only with coordinator-owned exact generated WASM artifacts:

```sh
ZORID_DOCUMENT_INDEX_OUTPUT=/absolute/disposable/output \
ZORID_DOCUMENT_INDEX_SOURCE=<fixture-commit> \
ZORID_CORE_WASM_DIR=/absolute/generated/wasm \
ZORID_CORE_BUILD_ID=<wasm-source-commit> \
node /absolute/main/node_modules/webpack/bin/webpack.js --config prototypes/browser-document-index/webpack.config.cjs
```

Serve that output over localhost. Open the page with a real supported browser,
click **Run fresh suite**, and retain the complete visible JSON report, served
bundle hashes and exact source/build revisions. The build config copies only the
allowlisted generated WASM JS/binary assets through the maintained root plugin
with its normal production export checks and content-addressed asset path.
It does not build Rust or write the source database format.

The suite checks exact raw UTF-8/BOM/CRLF and binary bytes, shared Rust metadata
and diagnostics, `.MD` parsing, binary-mode exclusion, resolver/backlinks, shared
Base graph evaluation, more than sixteen literal continuation pages, source
edits/moves/deletion, retained old text/Base definitions, stale source and
competing index publication, explicit rebuild/expiry, invalid Base preservation,
and persisted-generation restore through a fresh worker. Query snapshots and
source identities are checked independently. Inputs are disposable local vaults
whose database/client IDs remain in the URL. **Verify persisted cache** also
works after a browser page reload. **Release workers** closes test consumers.

This remains a harness, not a normal workspace UI migration, native/mobile
parity proof, browser power-loss test, performance comparison, or multi-tab UI
proof. Competing clients here are independent production workers in one page.
Raw source fingerprints are deliberately per-entry observations under serialized
fixture commands; they are not a new cross-file source snapshot API. Each suite
run uses a fresh database; no real vault, legacy migration or source reset occurs.
