# Actual Tauri integration with the embedded Rust core

User request: create a new worktree, actually embed the core in Tauri, and measure
whether it is better. Root owns `codex/tauri-native` / `.worktrees/tauri-native`,
base `9c0567e4`. Implementation is `fd6a40ca`; evidence/provenance is `dc3ebbaf`. `tauri_shell` owned the Rust shell;
`native_frontend` owned the platform seam; `benchmark_audit` owned the Electron
counterpart and independent review; root owned builds, verification and composition.

## Result

The native integration works for the tested note/workspace scope. Tauri embeds
the actual Zorid Rust core on a dedicated worker inside its process, loads local
production assets, and runs **no Node bridge, HTTP server or child Rust host**.
The counterpart uses Electron's own main process directly with a matching Rust
child. Both use the same renderer, native frontend capabilities, Rust source and
compiled dependency graph. This supersedes the earlier shell-only experiment.

Two serial, counterbalanced pairs give a repeatable but modest baseline saving:

|101-note fixture, run-level medians across C/D|Electron|Embedded-core Tauri|
|---|---:|---:|
|One note|158.22–158.29MiB|137.49–137.78MiB|
|Eight note tabs|189.79–190.48MiB|186.40–188.58MiB|
|Nine tabs,271KiB note active|188.99–192.95MiB|196.64–198.99MiB|

The paired single-note saving is20.51–20.73MiB, approximately13%. Eight tabs are
near parity (Tauri1.90–3.39MiB lower); the large-note state is3.69–10.00MiB higher
in Tauri. The direct-Rust candidate lowers the measured baseline, while browser/editor work still matters.
These observations do not establish a broad performance win, full-app production
RAM forecast or foreground typing/CPU/energy improvement.

## Real integration and functional proof

`src/platform/tauri-native.ts` binds the existing leased native frontend adapter
to Tauri commands and retains the desktop workspace chrome. `createPlatformAdapter`
selects it only when the trusted prototype marker is present. The normal Electron,
browser and mobile selections remain the default otherwise. No shared Rust storage
semantics or mobile trust guards were changed.

The standalone Rust shell owns `EmbeddedHost::open_local_with_data_root`, all
requests, lease release and teardown on one serial thread. Rust supplies trusted
fixture/data roots and a persisted client UUID; the renderer cannot choose roots.
Native close requests use the workspace's real lifecycle flush, then native code
releases the exact captured core lease and drops the core before allowing exit.
Failed/uncertain release retains the window rather than acknowledging success.

The save gate ran in the actual Tauri app and the actual Electron counterpart:

- Open an existing note and edit Unicode text, including Greek, CJK and emoji.
- Observe exact durable readback; create a new note through the actual sidebar UI
  and edit it, then request native close while it may still be dirty.
- Verify both physical note files exactly after process exit0.
- Reopen with the same persisted native client UUID, reread both notes, and close
  normally again. Both launches per shell exit0 with no owned process remaining.

The inspected records are `tauri-save-reopen.json` and `electron-save-reopen.json`.
The production frontend/native source stayed fixed while benchmark-only integrity
instrumentation was strengthened afterward. The initial external observer also
hit a Node26 log-handle garbage-collection error; explicitly closing that observer
handle fixed it. That failure is not a Tauri storage or app-runtime result.

## Same-ground comparison

The Electron counterpart uses `zorid-native-host-comparator`, a second binary in
the same Cargo package that calls `zorid_desktop_host::run_stdio`. It links the same
compiled core dependency graph as Tauri. It has no additional broker process or
localhost service. Both load exactly the same production renderer directory.

Both adapters expose the same capability subset. Desktop draft/work runtime,
work blocks, Base-preview streaming and large binary-stream services remain
unadvertised. This does **not** compare a reduced Tauri app against a fully enabled
production Electron app, and it does not establish full desktop migration parity.
Removing `editorOnly` selects desktop chrome; it does not claim those absent
capabilities have been implemented.

The release shell uses opt-level3, debug0, stripping, no incremental compilation
and one build job. The first complete build took9m05s; later asset-only rebuilds
took roughly34–39seconds. The compiler was stopped during accepted measurements.
TypeScript checking, production Vite compilation, Rust release compilation and
source diff checks pass. Existing unrelated Rust warnings are retained; no broad
core suite was rerun for unchanged core semantics.

## Measurement and integrity gates

The fixture contains101 Markdown notes, including a277,417-byte (~271KiB) note.
Each candidate receives identical physical note contents, fresh app data and a
fresh disposable vault. States are one ordinary note, eight tabs, then a ninth
large-note tab. Receipts prove actual titles/counts,101 admitted notes and exact
active CodeMirror/durable-source equality.

Both workspace rectangles are1200×760 inside1280×870@2 windows. Engine-specific
natural text heights differ slightly; pixel-identical rendering is not claimed.
The collector waits30seconds for the initial state and10seconds after each later
action, then records ten one-second kernel physical-footprint samples. It also
captures the independent macOS `footprint` summary and pressure/swap context.
Footprint includes compressed-memory charges; this is not the earlier RSS metric.

Every accepted run requires all physical fixture hashes to match before sampling,
after sampling **and after native close**. All four C/D runs pass, with12 exact
state receipts, zero traced input/document changes and no new host write intents.
All four exit normally with no owned processes remaining. A benchmark-only input
guard blocks manual interactions during memory measurement and displays an editing-
disabled banner. Three keydowns were blocked in Electron C and Tauri D; none
propagated and no non-cancelable events were recorded. Normal interactive mode,
save tests and product builds remain editable.

Tauri has four constant accounted PIDs: its combined native/core process plus
WebKit GPU, Networking and WebContent candidates. Electron has five: its main
process, matching Rust child and three Chromium helpers. The external Node
collector is a measurement tool outside both app totals. No Node or Rust-host
descendant exists inside the Tauri app topology.

WebKit XPC responsibility still points to the common launcher here. Candidates
appear during each Tauri launch and disappear after normal close, supporting
lifecycle attribution without proving exclusive ownership. Totals remain qualified
estimates. Other user apps remained running; pressure, GC, caching and swap vary.
These are two run-level repetitions, not ten independent trials per state or a
controlled long-term idle/huge-vault acceptance campaign.

## Rejected measurements and diagnosis

Initial unprotected A/B runs are excluded. A detected changes to Benchmark's final
newlines; read-only forensic inspection found four explicit frontend write intents
(48→49→47→48→47bytes), not a Rust read/projection transform. A small two-note focus
probe did not reproduce the change. The later B trace records real trusted keyboard
input and a note rename during measurement. It proves that run was being edited,
not that the core silently altered text. It does not retrospectively prove A's
trigger. No core/editor bug fix is claimed.

The harness now uses the normal CodeMirror `view.focus()` API, records bounded
integrity traces, and protects automated measurements from manual edits. The C/D
hashes, zero input/document changes and zero write intents are the acceptance
evidence. Old A/B figures are not averaged into the table.

## Review, use and remaining work

Independent review verified source contracts, close ordering, all C/D receipts,
file hashes through close, process topology, read validity and numerical results.
No critical normal-path blocker remains for this opt-in prototype. The installed
production app and real vaults were not replaced or edited.

Root is the sole main integration owner; workers remained in the isolated tree.
Reviewed opt-in source and records are integrated coherently without selecting
Tauri as the production default. The new worktree retains its compiled executables
and renderer; launching from main requires building there first. Run:

```sh
cd /Users/ctk/Projects/Zorid/.worktrees/tauri-native
node prototypes/tauri-native/launch.mjs
```

The launcher exits after opening an editable disposable prototype vault. Its Node
process is not an app host. Build/reproduction commands are in the prototype README.
Raw C/D receipts, functional receipts, executable/Cargo/source/asset hashes and
summary values are retained under `prototypes/tauri-native/evidence/`.

Full migration still needs the remaining desktop services, vault selection,
faulted-startup/reload handling, periodic native external-file refresh, packaging,
updating, broader native input/IME/accessibility and other-platform validation.
Neither full desktop parity nor a production migration decision is established.
