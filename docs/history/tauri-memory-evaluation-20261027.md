# Tauri memory evaluation follow-up

User authorization: further evaluation of RAM after the initial uncertain RSS
comparison, not production migration. Root owns `codex/tauri-benchmark` and its
isolated worktree. Probe owner: `benchmark_audit`; workload owner: `tauri_shell`;
runner, composition and interpretation: root. Prototype implementation `11b8ecb6`; evidence/commands `b833610e`.
Only reviewed findings/tracking are integrated into main; the prototype remains
isolated. Production Zorid and real vaults are unchanged.

## Decision and measurements

The shell-only experiment does not reproduce a general44% RAM saving. It also
**does not answer whether an optimized Node-free Tauri migration would save RAM**.
The user correctly challenged that distinction. The earlier recommendation against
migration was broader than this experiment supports. Retain the working production
app while evaluating the direct Rust candidate; do not use these figures to reject
Tauri as an architecture.

Eight serial runs reached all three requested states (24 state/source receipts),
plus one excluded smoke and one excluded initial-import timeout. The small-fixture
ranges below are the two run-level medians, not independent sample confidence
intervals. Electron uses owned-descendant footprint; Tauri includes its explicitly
uncertain new WebKit candidates.

|101-note fixture, repeat range of medians|Electron|Tauri estimate|
|---|---:|---:|
|One ordinary note|213–219MiB|195–200MiB|
|Eight ordinary note tabs|231–241MiB|244–262MiB|
|Nine tabs,271KiB note active|241–248MiB|265–274MiB|

Thus the small-fixture idle saving is approximately13–23MiB in these two runs,
not146MiB. Tabs/large-note states offset that saving. Excluding a likely unrelated
Networking candidate from the first Tauri large-note result lowers273.9 to267.9MiB,
still above Electron's241.1MiB. These remain bounded observations, not production
RAM forecasts.

|1,001-note B diagnostic, median|Electron|Tauri estimate|
|---|---:|---:|
|One ordinary note|266.31MiB|231.09MiB|
|Eight ordinary note tabs|314.93MiB|315.46MiB|
|Nine tabs,271KiB note active|315.08MiB|328.44MiB|

B removes the resumed-import asymmetry of the earlier A run, but not every other
limit: the single-note viewports differ and all its receipts retain a scan-limit
warning. Tabs/large B have equal1280×870@2 viewports. Earlier resumed Tauri A is
328.3/382.0/541.2MiB versus Electron A293.8/305.4/305.4MiB; those wide differences
are diagnostic, not a stable expected migration cost. Run medians and sample
ranges are preserved in `evidence/memory/summary.json` on the isolated branch.

## The missing optimized Tauri comparison

The actual tested path in both shells is frontend → common Node bridge → separate
Rust desktop host. Tauri's Rust shell currently opens a webview; it does not embed
Zorid's data core. Both usually involve six accounted processes (including the
three candidate WebKit services for Tauri); tests are serial, not accumulated
concurrent app instances. Extra unrelated WebKit candidates are identified
separately. Electron itself also carries a separate broker in this experimental
setup, so it is not an optimal production Electron integration either.

The measured Node broker accounts for approximately30–66MiB depending on workload.
A proper Tauri candidate can move its duties into the Rust backend, embed the
existing core and avoid the separate Node process/stdio-host boundary. This is
an architectural improvement not exercised here. Simply subtracting broker or
Rust-host footprint is not a prediction: their data, queues, validation, storage
and lifecycle work must live somewhere in the new process, with different copying
and allocator behavior.

The embedding route is feasible: `zorid-desktop-host::EmbeddedHost` exposes a local
host API already used in `mobile/rust/src/lib.rs`, and the native TypeScript adapter
is injectable. Full desktop parity is substantive adapter work, however: the Node
facade also owns window grants, client identity/admission, change delivery, runtime
scheduling, draft/work queues, checkpoints and close/drain handling. Raw embedded
`dispatch` currently rejects some desktop draft/work/Base-preview requests. Using
the mobile editor-only adapter unchanged would alter the tested feature set.

The current experiment already uses the installed production renderer and a
stripped release Tauri shell, not a Vite dev server. Its Rust shell was compiled
with opt-level1/codegen16 to bound first-build resources, rather than tuning a
production opt-level3/LTO profile; that difference is unmeasured. No direct Rust
embedding, Node removal, optimized native bridge/copying, WebKit renderer-memory
profiling or architecture-specific tuning was implemented. A fair next decision
gate is a bounded direct-Rust prototype with explicit capability matching and
exact note/save/reopen/close checks, then the same memory workloads.

## What was measured

Both shells use the identical installed renderer, common Node broker and Rust
host from the [initial experiment](tauri-benchmark-20261027.md). Electron44.8.0
and Tauri2.12.5 run serially on the same arm64 8GB MacBook Air, macOS26.6. There
are no concurrent benchmark apps or compilation jobs. Other user apps remain
running. The compiled Tauri shell is reused; no large Rust build is needed.

Two fixture sizes contain101 and1,001 Markdown files respectively. Ordinary notes
are approximately2.1KiB; `Large.md` is277,417bytes (~271KiB). The three cumulative
states are one ordinary note, eight actual note tabs, and nine tabs with the large
note active. Inactive tabs need not retain editor DOM instances; receipts report
both actual tabs and active editor DOM counts. This is a bounded larger-vault
comparison, not acceptance for huge vaults or all document types.

The UI script follows normal file-tree/tab handlers, checks actual tab titles and
counts, confirms the full admitted note count, and compares the active CodeMirror
document exactly with the durable source and SHA256. Newer runner receipts also
hash every physical fixture note before and after the workload. No notes are edited.
Read-only supplemental audit confirms identical complete physical small-fixture
content maps for the first pair, including its older Electron runner receipt.
All runtime/caches/recovery roots are disposable. Large-fixture note files are
reused read-only after import, with separate application/cache roots per process.

Each phase gets10seconds to settle, then ten kernel measurements approximately
one second apart. Sampling uses `proc_pid_rusage(RUSAGE_INFO_V4)` and records both
resident bytes and `ri_phys_footprint`, guarding PID identity before/after each
read. Unlike RSS, physical footprint includes compressed-memory ledger charges;
Apple documents the accounting in [XNU task.c](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c).
`footprint --noCategories --swapped -f bytes` independently measures selected PIDs
once after each phase. Raw per-process values, process paths/identities, tool
summaries, workload receipts and environment snapshots are preserved.

## Attribution and interpretation limits

Electron shell/helper, broker and Rust-host descendants are identifiable. macOS
launches WebKit GPU/Networking/WebContent through XPC. Its private read-only
responsibility query is available here but usually identifies the common launcher,
not the shell exclusively. Therefore candidate-inclusive Tauri numbers are
estimates: known descendants plus newly appeared WebKit candidates, reported
separately. Existing WebKit processes are retained as context, not silently charged
to this app. Candidate errors must not become zero-byte apparent savings; sample
completeness is checked across descendants and included candidates.

Creation during a test and disappearance after it support a lifecycle inference,
not exclusive attribution. One Networking candidate in the first small Tauri run
had different responsibility and survived shell cleanup. Sensitivity analysis
excluding it still leaves that run's large-note footprint above Electron. The
report does not call the inclusive total a strict upper bound or owned-only totals
a complete Tauri footprint. Per-process footprint sums are kernel-accounted charges,
not an exact union of all physical pages or whole-system incremental RAM.

These are post-action windows, not proven long-term idle plateaus. Background
indexing, garbage collection and caches remain possible; phase differences are
not pure costs per tab. The phases are cumulative and the large-note test follows
the eight-tab state. Memory pressure and swap changed materially while other user
apps stayed running. Physical footprint handles compressed accounting better than
RSS, but it does not remove environmental effects on GC and allocation behavior.
Report run-level medians and variation rather than treating ten correlated samples
as ten independent trials.

All measured UI phases are visible; document focus is recorded separately and is
usually false. This is a memory comparison, not a native foreground typing, IME,
frame-rate, battery or accessibility acceptance claim. Both shells retain the same
Node bridge: a future direct-Rust Tauri architecture may save additional memory,
but this experiment does not measure or promise that saving.

## Preparation and failed evidence

The first fresh1,001-note run exceeded the90second phase budget while import was
still progressing (700 admitted rows observed after cleanup). It has no accepted
memory phases. This is fixture preparation evidence, not proof of a Tauri rendering
failure. Root resumed that exact disposable physical vault instead of repeating
bulk import for every shell. The resumed Tauri process reached complete1,001-note
admission, but its receipt still records28 imports in that process. Its samples
therefore retain a preparation asymmetry relative to later zero-import runs.
The later B comparison on the already-admitted vault removes this import
asymmetry, while retaining the reconciliation and viewport qualifications above. No import performance fix or production core change was made.

The short Tauri smoke run uses1second settling and only two samples per state;
it validates instrumentation/state checks and is excluded from the comparison.
The initial RSS study's335/189MiB observation remains historical and is not combined
with the new physical-footprint metric.

All measured1,001-note B receipts list every expected note and show imported0,
but reconciliation says complete:false/finished:true with one scan_limit issue.
Some A receipts also retain this warning. Therefore the larger fixture is not
claimed as clean complete reconciliation or proven idle indexing acceptance.
No warning was waived to establish product correctness.

Viewport heights also vary: the first small A pair matches1280×870@2, while Tauri
small B is828px high versus Electron870. Larger A also differs; larger B matches
for tabs/large only. Exact active sources and tab counts match, but an exact uniform
layout/foreground benchmark is not claimed. Both frameworks usually report
false document focus despite visible windows.

## Evidence

The isolated branch preserves `prototypes/tauri-benchmark/memory-run.mjs`,
`memory-workload.js`, `memory-metrics.mjs`, `memory-probe.c`, raw JSON and source
manifests. The probe uses no task ports, process suspension or mutation. Its optional
private responsibility API is observational and is not production application code.
Original runtime directories are recorded in each result under `/private/tmp`.
No production app is installed/replaced. Owned Electron processes normally exit through their shell; the1,001-note B
Electron process required a scoped SIGKILL fallback. Tauri and some brokers are
terminated after the broker/core close request. Cleanup is verified by
exact tracked process absence; graceful native Tauri quit is not established.

Independent audits verified state/source parity and reviewed the metric interpretation.
All counted process reads are valid in accepted samples. All owned app/broker/core
processes are absent in final cleanup; one unconfirmed Networking candidate from
small Tauri A survives and is not killed or called owned. No production code,
app installation or native/mobile validation was changed by this evaluation.
