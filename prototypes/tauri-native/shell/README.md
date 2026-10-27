# Embedded Rust Tauri prototype

This disposable-vault prototype loads the real Zorid editor from bundled assets
and calls `zorid-desktop-host::EmbeddedHost` inside the app. It starts no Node
runtime, HTTP server, daemon or child Rust host.

One dedicated Rust worker owns core initialization, every framed request,
reconciliation, lease release and core teardown. The renderer uses the existing
native vault adapter and its document semantics. This does not broaden core
capabilities: embedded draft/work and Base-preview requests retain their existing
rejections.

Build the prototype frontend into `../dist` first, then serialize the Rust build:

```sh
cargo build --release --manifest-path prototypes/tauri-native/shell/Cargo.toml -j 1
```

Launch against agent-created disposable paths only:

```sh
ZORID_NATIVE_VAULT=/private/tmp/zorid-tauri-native-example/vault \
ZORID_NATIVE_DATA=/private/tmp/zorid-tauri-native-example/app-data \
ZORID_NATIVE_BENCH=1 \
  prototypes/tauri-native/shell/target/release/zorid-tauri-native-prototype
```

The vault must exist. The app creates the data root and persists its client UUID
in `native-client-id`. Both canonical roots must be under `/private/tmp` and
contain `zorid-tauri-native-`; the renderer cannot select or change them.

## Native adapter contract

- `tauri_context()` returns `{name, clientId, reconciliation, documentSemantics:true}`.
- `tauri_refresh()` returns `{reconciliation}`.
- `tauri_request({input:{header,body}})` accepts a JSON header string and base64
  payload and returns the same shape. It uses the core's eight-byte big-endian
  header/body length prefix internally. Only the native-owned client UUID can
  claim a lease. Header limit is 1 MiB; body limit is 16 MiB, or 32 MiB for
  checkpoints. The bounded FIFO admits at most 32 messages / 64 MiB of encoded
  request bytes. Post-dispatch transport failure fences the host generation.
- `tauri_lifecycle_ready()` enables close requests after listener registration.
- Native close emits `tauri:lifecycle` with `{id,reason:'switchVault'}`. The
  existing frontend lifecycle handler flushes and saves its session, then calls
  `tauri_lifecycle_ack({input:{id,ok}})`. A positive ACK queues native release of
  the captured exact client lease, validates that release, drops the core on its
  owner thread, then allows close. A negative ACK keeps the window open.

Only the `main` local application webview may invoke these commands. Navigation
stays on the local Tauri application origin. No external URLs or plugins are
enabled. `window.__ZORID_TAURI__` is set before editor startup.

## Fixed-file benchmark transport

Only trusted `ZORID_NATIVE_BENCH=1` enables
`window.__ZORID_NATIVE_BENCH_ENABLED__` and these commands:

- `tauri_bench_control()` reads `ZORID_NATIVE_DATA/control.json`; missing control
  returns `{phase:null}`.
- `tauri_bench_report({input:object})` writes `phase-single.json`, `phase-tabs.json`
  or `phase-large.json` for the corresponding `input.phase`. `phase:'save'` or an
  absent phase writes `report.json`. Other phases are rejected. Serialized JSON
  is bounded to 2 MiB and reports use a temporary file followed by rename.
- `tauri_bench_close()` requests an ordinary native close. It preserves the real
  frontend flush / native lease release / worker teardown handshake.

The external collector owns control/sample files. These commands do not expose
arbitrary filenames or roots and are unavailable without the benchmark switch.
All runtime results and migration conclusions require the actual verification
receipts; compiling this shell alone does not establish editor or save parity.
