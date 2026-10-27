# Tauri versus Electron: bounded desktop feasibility comparison

Date: 2026-10-27. User requested a prototype and benchmark, not migration.
Owner: root, `codex/tauri-benchmark`, `.worktrees/tauri-benchmark`, base `8507a855`.
`tauri_shell` implemented the standalone host; `benchmark_audit` independently
reviewed the common transport and the interpretation of early runs. Root owned
composition, measurements, final report and cleanup. Prototype and evidence are
committed as `83648415` on the isolated branch. Root is the sole main integration
owner for the documentation-only closeout; workers never edited main. No production
shell changed.

## Result and decision

The final matched synthetic-edit pass showed essentially equal startup, editor frame
timing and save readback. Tauri had lower sampled RSS in this pass; repeat samples
and earlier runs were inconsistent, so there is no validated general RAM saving.
Keep Electron for now. These results do not justify migration for performance
alone. Tauri remains an option for packaging or a future direct Rust integration.

| Final accepted matched workload (`focused4`) | Electron 44.8.0 | Tauri 2.12.5 |
| --- | ---: | ---: |
| Shell process launch to editable note | 2,587 ms | 2,641 ms |
| Broker start to editable note | 3,757 ms | 3,860 ms |
| Note open within loaded workspace | 52 ms | 53 ms |
| Median editor transaction to next frame | 16.6 ms | 17 ms |
| Final edit to exact core readback | 562 ms | 540 ms |
| Median of three post-workload RSS sums | 335 MiB | 189 MiB |
| Exact core readback and independent physical file bytes | PASS | PASS |
| Visible; same 1280×870 viewport, DPR 2 | PASS | PASS |
| Document focus immediately before synthetic edits | false | false |
| Broker/native/shell descendant cleanup | PASS | PASS |

These are observations from one matched synthetic-edit pair, not statistically
established differences or controlled cold-start/idle-memory benchmarks. The
22 ms save difference is smaller than the polling/transport and run variability.
The approximate frame interval is the display cadence, not physical input latency.

## Method

On the arm64 8 GB MacBook Air (macOS 26.6, build 25G72), the experiment loads
identical renderer assets extracted from the installed Zorid app. Both shells use
one common Node 26.10.0 broker and the exact installed Rust desktop-host executable.
The broker executes the existing desktop main/preload and admission/save/recovery
facades, with a small Electron window/IPC lifecycle shim. Both receive identical
HTTP/SSE and tagged-byte serialization overhead. No production bridge was edited.

Each invocation creates a fresh disposable 100-note vault, opens `Benchmark.md`,
applies 30 CodeMirror transactions, samples requestAnimationFrame intervals, waits
for exact core readback and checks independent physical note bytes. The final runs
set `ZORID_LOCAL_DATA_DIR` inside their disposable directory, so recovery/cache data
is isolated too. Existing user apps and real vaults are excluded. Initial smoke
runs preceded this explicit data-root override; they are not accepted measurements.

The compiler had stopped before matched measurements. Runs were serial, with
alternating order. Broker/core initialization precedes shell launch; the table
reports it separately and in the total. Epoch `performance.timeOrigin` aligns
renderer readiness with the runner's native launch timestamp. Fresh app/vault data
does not flush OS caches, and other user apps remained running. Disk headroom was
approximately 1.2 GiB after the first Tauri build, another environmental limitation.

Tauri is deliberately still backed by Node here. This isolates shell costs and
does not establish the size or performance of a future Node-free implementation.
Production package size was not benchmarked: comparing this tiny prototype binary
against the full installed Electron app would be misleading.

## Failed and diagnostic runs retained

The original `execCommand` synthetic-input test behaved differently in WebKit:
selection before a heading control inserted nothing, and later text-node selection
could introduce extra newlines. Those runs were rejected. The accepted workload
uses the exact same CodeMirror transaction API in both shells; browser-native
keyboard, selection, composition and IME behavior remain unverified.

Earlier `matched1` observations suggested 8.019 s Electron versus 3.432 s Tauri
startup, with median RSS 286 versus 95 MiB. Independent review found lingering
owned Electron processes after that pass; their exact PIDs were subsequently
terminated. `matched2` memory ordering reversed (98 versus 168 MiB), and Tauri did
not have document focus. Neither pair establishes a stable saving. The initial
preliminary numbers shared in chat are superseded by the qualified final result.

After native activation/focus and Electron termination fixes, `focused3` Tauri
passed but Electron timed out waiting for document focus. It is retained as failed
comparison evidence. The `focused4` pair passes exact data, visibility and cleanup checks
for both shells. The initial focus wait passed, but final receipt inspection shows
`document.hasFocus()` false immediately before synthetic edits in both shells.
The label does not establish sustained foreground focus. The earlier chat update
calling this pair focused was too broad; native foreground input remains unverified. The final recommendation does not average failed/contaminated runs
into the accepted result. Root's clean-pair interpretation is narrower than a claim
of general framework superiority.

RSS sums include broker/core/shell descendants plus separately recorded newly
appearing WebKit GPU/network/content XPC candidates. Their exclusive ownership is
not proved, shared pages can be counted more than once, and compression changes
RSS substantially. Stable total physical footprint and energy remain unmeasured.

## Evidence and remaining scope

Prototype source, Cargo.lock, source/binary SHA-256 manifests, raw reports and
cleanup receipts are preserved on `codex/tauri-benchmark` under
`prototypes/tauri-benchmark/`. `evidence/installed-inputs.json` identifies installed
inputs; `evidence/prototype-inputs.json` identifies the final benchmark inputs.
The final successful synthetic-edit receipts are `evidence/electron-focused4.json` and
`evidence/tauri-focused4.json`, with adjacent cleanup reports. Original disposable
runtime directories are recorded inside each receipt under `/private/tmp`.
The prototype README contains the exact serial build/run commands.

No migration, replacement app installation, mobile work or full-suite campaign was
performed. Large notes/vaults, indexing/search load, browser-native typing and IME,
accessibility, clipboard/drag/drop, multiple windows, native menus/dialogs, other
operating systems, packaging/update/signing and a direct Rust bridge remain outside
this experiment. A lightweight shell can still be worthwhile, but this experiment
has not demonstrated a consistent everyday performance improvement.
