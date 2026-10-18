# Normal browser pinned Tasks proof

Source fixture prepared on `browser-task-queries`, based on canonical `8e8732ea`.
No Rust compile, generated WASM build, or browser execution has occurred in this
worker's source turn. The coordinator owns the shared heavy validation slot.

The fixture authors synthetic files with `defaultBrowserAdapter`, reads its
normal `documentSemantics` capability through the admitted consumer, and uses
the unchanged product `browser-core-worker.ts`, actual generated Rust/WASM and
IndexedDB. It uses no alternate Worker, JS parser, injected registry, private
semantic operation, source seeder, or storage mutation. A second admitted client
checks foreign-pin rejection. All owned client leases and databases are released
and deleted; the runner cleans up its own Chrome PID/profile and Vite listener.

Five bounded groups exercise exact Type/task witnesses and snapshots, ordinary
checkbox exclusion, timezone/date-only Today, edits/moves/deletes with an old pin,
malformed YAML diagnostics, strict options/selectors, foreign-client pin denial,
close/rebuild expiry and reopening. They do not prove rendered Tasks UI, Calendar,
mobile or cross-browser behavior.

After independent source review and an explicitly coordinated validation turn:

```sh
cargo test -p zorid-wasm --lib document_index::tests -j 1
node scripts/build-core-wasm.cjs
node tests/browser-task-queries/run.mjs --expect-head FULL_40_HEX_COMMIT --runtime-authorized --out /tmp/zorid-browser-task-proof-RUN_ID
```

Use the coordinator's assigned shared Cargo cache when available; never run a
second full Rust build alongside its owner. The runner never compiles Rust or
installs dependencies. It rejects stale WASM fingerprints, mismatched generated
hashes, a missing `tasksJson` binding, and sources/artifacts changed during the
run. Its report contains source/artifact identities, actual results and owned
cleanup receipts. Existing `tests/browser-workblocks-worker/cleanup.mjs` supplies
the previously tested PID/profile/listener cleanup helper unchanged.
