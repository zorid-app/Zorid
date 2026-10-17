# Actual browser consumer admission fixture

Source-only preparation. The coordinator owns compilation and Chrome verification;
no passing browser result is claimed here. This harness imports the actual
`BrowserCoreRuntime`, its bundled application worker, the admission facade and
shared Rust/WASM assets. It does not select app storage, mount an editor, modify
browser-vault/browser-sync, or implement another persistence layer.

The five checks run with multiple real workers in one browser page:

1. Duplicate authority/client acquisition fails before startup replay. The fixture
   persists an exact `commit_requested` crash marker alongside an inert prepared
   intent, then proves a rejected duplicate neither applies it nor changes phases.
2. A distinct client holds a concurrent lease and reads shared notes, while its
   checkpoint namespace cannot read the other client's recovery record.
3. Ordered release permits the same client to reacquire its persistent authority,
   retain its checkpoint, replay the authorized operation, and leave prepared
   content inert. Recovery receipt is explicitly acknowledged afterward.
4. Abrupt runtime close terminates the actual worker without running a consumer
   flush gate. Reopening the exact client preserves checkpoint/content and the
   inert preparation. This is worker restart, not browser/OS process-crash proof.
5. A real IndexedDB readwrite transaction stalls the real worker. An inventory
   request times out; a queued checkpoint must never be posted. Reopening the same
   client verifies that checkpoint is absent and the prior document is unchanged.

Fault injection is confined to a newly generated database with prefix
`zorid-core-vault:admission-fixture-`. The marker changes only the exact prepared
row's phase, preserving request bytes. Timeout is shortened to 250 ms **after**
real worker/WASM initialization. The harness observes the real worker's outbound
`postMessage` calls through a forwarding wrapper; it does not replace or mock the
worker. Only for the timeout phase, the harness removes that runtime's optional
visibility refresh listener and drains pending calls before tracing, so switching
browser views cannot introduce an unrelated refresh into the fault assertion.
The transaction-stall pump makes read requests only and is stopped in a
`finally` path. All runtime workers are closed, their authority lock disappearance
is checked, and only this run's database names are deleted on success or failure.
A blocked deletion or retained lock makes the final result fail.

## Build and serve (coordinator slot required)

Use the existing repository dependencies and already generated WASM artifacts.
The fixture has its own webpack configuration; no production build files change.
Set the two source IDs separately: the fixture commit and the commit used to
produce the WASM artifact may differ and are both reported.

```sh
node node_modules/typescript/bin/tsc --noEmit -p prototypes/browser-admission/tsconfig.json
ZORID_ADMISSION_OUTPUT=/private/tmp/zorid-browser-admission-dist \
ZORID_ADMISSION_BUILD_ID=<fixture-commit> \
ZORID_CORE_WASM_DIR=<absolute-generated-wasm-directory> \
ZORID_CORE_BUILD_ID=<wasm-source-commit> \
node node_modules/webpack/bin/webpack.js --config prototypes/browser-admission/webpack.cjs
python3 -m http.server 8768 --bind 127.0.0.1 --directory /private/tmp/zorid-browser-admission-dist
```

Open `http://127.0.0.1:8768/`, click **Run browser admission checks**, then read the
visible final JSON or `window.__zoridBrowserAdmissionResult`. Acceptance requires
`ok:true`, `passed:5`, the five named check results, `cleanup.workersClosed:true`
and `cleanup.databasesDeleted:true`. Record source IDs, WASM manifest hashes,
user agent and the complete observed result. Close the owned tab and static server
after verification. The fixture can be rerun; it generates fresh database/client
identities and does not reuse earlier results.

No actual two-tab lifecycle, worker power-loss durability, production tab-slot
allocation, paused NoteBuffer consumer, native mobile or network sync is proved
by this page. The Web Lock checks use real separate worker contexts on one origin.
