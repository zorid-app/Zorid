# Zorid with an embedded Rust core in Tauri

This working prototype uses the shared web editor and the actual `EmbeddedHost`
Rust data core on a dedicated serial worker inside Tauri. The app runs no Node
runtime, localhost server, or child Rust host. Its local production assets are
embedded in the executable.

The counterpart uses the **same renderer and native adapter capabilities** in
Electron, with Electron's main process talking directly to a Rust child. That
child is built from the exact same core library and Cargo dependency graph as the
Tauri app. There is no additional Node broker in either candidate.

Both preserve the shared native lease, durable-save, checkpoint and namespace
contracts. The full desktop UI is shown. Desktop draft/work runtime, work blocks,
Base previews and binary-stream capabilities are not advertised by this adapter.
This is a genuine note/workspace integration, not full desktop migration parity.
Production remains on Electron.

## Build and try

From the repository/worktree root:

```sh
node prototypes/tauri-native/build-frontend.mjs
CARGO_BUILD_JOBS=1 cargo build --release --bins --manifest-path prototypes/tauri-native/shell/Cargo.toml -j 1 --locked
node prototypes/tauri-native/launch.mjs
```

The launcher opens an editable disposable vault and exits. Its Node process is
not an app host. The same interactive vault is retained across launches under
`/private/tmp/zorid-tauri-native-play-*`; its location is printed. No existing user
vault or production app is changed. Roots are deliberately restricted to these
owned disposable fixtures while the adapter is evaluated.

The release profile uses opt-level3, no debug information, stripping and disabled
incremental compilation. Build one job at a time on the8GB machine. The first build
compiles the complete Rust dependency chain; subsequent asset rebuilds reuse it.

## Functional and memory checks

```sh
node prototypes/tauri-native/bench/run.mjs tauri save check
node prototypes/tauri-native/bench/run.mjs electron save check
node prototypes/tauri-native/bench/run.mjs tauri memory C
node prototypes/tauri-native/bench/run.mjs electron memory C
```

The save gate edits Unicode text through the actual editor, creates another note,
requests a native close while that edit may still be dirty, checks exact physical
bytes, reopens with the same native client identity, rereads both notes and closes
normally. Both shells use the existing workspace lifecycle flush before native
lease release and host teardown. No success is inferred from a mocked store.

The memory workload opens one note, eight tabs, then a ninth tab containing a
277,417-byte note in a101-note fixture. It fixes the workspace at1200×760 for both
engines, waits30seconds initially/10seconds after subsequent actions, then records
ten one-second kernel physical-footprint samples. All note hashes must remain
unchanged, including after normal close. WebKit XPC ownership uncertainty and
system-pressure snapshots are retained in the JSON receipts.

An editing-disabled banner and trusted-input capture guard protect **only automated
memory windows** from manual trials. Synthetic test clicks follow the normal app
handlers. Interactive mode, save tests and normal product builds remain editable.
The external Node collector is a measurement tool and is excluded from app totals
for both candidates; it is not part of Tauri's runtime architecture.

Run serially with the compiler stopped and reverse order for repeats. Original
receipts are under `/private/tmp/zorid-tauri-native-*`; retained evidence and the
qualified verdict are linked from `docs/history/tauri-native-experiment-20261027.md`.

## Current limits

There is one fixture-bound window and no general vault picker, packaging/updater
or migration of production data. Same-window reload, faulted-startup close,
periodic external-file refresh and full desktop feature parity need further work.
No new mobile validation is claimed. Neither shell's memory figures establish
unmeasured foreground typing, IME, energy, large-vault or other-OS performance.
