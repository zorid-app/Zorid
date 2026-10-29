# Instant editor and automatic recovery

## Active objective — 2026-10-29

Make the correct editor usable within 800 ms: visible viewport, trusted typing,
and protected edits. Apply this to reopening, first import, and large-note restore.
Full namespace import, metadata parsing, Search, and offscreen rendering may finish
later. Eliminate unnecessary rescans, repeated import work and reindexing. Recover
routine storage/session interruptions automatically without asking users to reopen
the vault or manually retry a save/load. Preserve identity, CAS, conflict reporting,
and honest durable-save status.

User explicitly authorizes self-integration now that the other session finished.
Do not coordinate with that session. Root owns this isolated branch
`codex/instant-editor-current` in `.worktrees/instant-editor`, based on main
`7d8006b8`, with previously reviewed recovery pins `1a70bc4d` and `14f4ac52`.
Only reviewed, validated batches go into main. Completion includes a verified macOS
build, staged replacement and installation at `/Users/ctk/Applications/Zorid.app`.

The user resumed the existing thread goal: it is active. The objective is not
complete. Earlier create_goal replacement was rejected while the unfinished goal
was blocked; that is historical, not a current execution blocker.

## Implementation and evidence gates

1. Establish an honest packaged editor benchmark. Separate process launch from
   folder-selection acceptance. Require the correct document, real trusted input,
   caret/frame readiness and acknowledged edit protection. Record failed and
   invalid runs. The fixture journal benchmark is not production core validation.
2. Make native reconciliation cooperative. Preserve scan inventory and publication
   progress across bounded turns, yield to foreground reads/saves, and retain
   recovery, external-edit and cross-connection authority fences.
3. Remove repeated index manifest traversal per Pump without weakening freshness
   validation. Gate background generation rebuilds against useful source progress;
   foreground demand and already-valid publication must remain possible.
4. Move full-vault reconciliation, all-checkpoint hydration and hidden view work
   off the startup path. Bootstrap the active document with valid client/storage
   authority and its own recovery. Never substitute a blank editable document for
   a restored note whose identity/body is still unknown.
5. Carry typed errors across contextBridge, renew logical-session IO, preserve
   drafts independently of a dead host, and replay only retained exact operations
   whose commit outcome requires resolution. Creation presentation must retain its
   committed identity across asynchronous loading. Do not just suppress errors.
6. Compose, independently review, run focused correctness checks and paired native
   workloads, then verify the packaged production paths and install. No 800 ms or
   complete recovery claim until those production gates pass.

## Current owners and acceptance state

Latest composition: `49c9177c`, then bounded journal idle cleanup `efd2aa6c`.
Successor performance candidate source `cd480ee7` composes independent note
protection and its exact-receipt/drain/provenance review corrections, continued
transient autosave, deferred selected-note counts and concurrent lazy editor
prewarming. Corrected Notes `312d5dd6`, autosave `175b9400` and editor split
`59d885c8` have independent source acceptance. Counts review remains open.
The composed 159 checks passed with no skips; TypeScript and native-mode frontend
build passed. One prior 151-check run failed because an emoji fixture reported
UTF-16 length instead of UTF-8 bytes; only that fixture was corrected, preserving
the failed log and strict production proof validation.

Actual packaging retry `build-002.json` still FAILED: the new staged workspace
boundary permits the first empty collection, but electron-builder then falls back
to the development root and encounters the incompatible pnpm lockfile. The earlier
collector regression was too shallow to cover this fallback. The package owner is
correcting the complete invocation path. No verified app or install from either run.
Build 002 source remained unchanged; native binary SHA-256
`3f1a37a5d4a52a59b709df723941c3f400c8fc323162118d655ec0a0b5594a8b`
was compiled at `49c9177c`; later changes are renderer/desktop/tooling only.

The interim build at `49c9177c` passed native release compilation, TypeScript,
frontend generation and desktop module allowlisting. Packaging failed in the
pnpm dependency collector with `ERR_PNPM_BROKEN_LOCKFILE`; it did not produce a
verified candidate or replace the installed app. Source hashes matched before
and after the build. Receipt: `tmp/instant-editor-performance-build-20261029/build-001.json`.
Disk remained above 7 GB, so this failure is separate from the earlier disk blocker.

Reviewed cooperative import/publication, import-aware background indexing, idle
history maintenance, passive Backlinks and selected-pane-first startup changes are
composed. Their focused checks do not establish packaged latency. Journal idle
cleanup passed 15 integrated focused checks after composition.

Active remaining scopes: file_open_audit owns NoteBuffer independent protection
and exact pending canonical replay; startup_audit owns RAM capture/restore of
unsubmitted property/table/title controls across a fresh admission; checkpoint_review
owns the narrow package collector fix; maintenance_triggers owns paired native
workload measurements using the new release host; index_redundancy owns a real
packaged startup oracle; checkpoint_dedup audits eager optional renderer imports.
No other session is involved. No 800 ms, recovery completion or installation claim.

| Scope | Owner / branch | State |
| --- | --- | --- |
| Packaged benchmark | index_redundancy / packaged harness | Real-app harness in progress; no 800 ms production acceptance |
| Cooperative import/publication | maintenance_triggers / import-quantum | Reviewed `27628f75` composed; paired new-release-host measurements running |
| Pump and background index scheduling | root composition | Reviewed lookup and import-aware scheduling composed; real idle/freshness gates pending |
| Typed transport/read renewal | root composition | Reviewed and focused checks passed; packaged interruption gate pending |
| Creation continuation | root composition | Reviewed regular/nested handoff fixes composed; packaged gate pending |
| Independent note protection | file_open_audit / note-independent-protection | `8c644e04` composed; 75 composed checks + TS pass; independent review requires receipt/protection-drain corrections |
| Continued transient autosave | root `175b9400` | Controlled RED then 58 green checks; independent source review accepted; no healthy idle work |
| Raw form admission recovery | startup_audit / raw-admission-recovery | Mounted unsubmitted-value regression RED; component implementation in progress |
| Package workspace isolation | checkpoint_review `3643433d` → root `40c668a4` | Actual collector regression fixed; 19 author checks and independent source review clear; real packaging retry pending |
| Deferred note counts | native_enrollment_review / workspace-deferred-status-counts | Mounted critical-path regression RED; bounded scanner implementation in progress |
| Renderer editor split | checkpoint_dedup | Optional eager import audit complete; small concurrent prewarm experiment in progress |

Heavy builds are serialized on the 8 GB machine. Focused desktop checks need no
per-check permission. No agent may mutate or discard another branch's work.

## Measurement limits

The valid selection-clock editor-floor receipts were 70/78/60 ms for 8 KiB,
0.5 MiB and 5 MiB notes. They exclude application/module bootstrap and production
core authority. Reopen receipts missed their fixed 800 ms probes and are invalid
as complete acceptance runs. Their later trusted input observations are retained,
but spawn totals include an old pre-spawn report-write clock gap. Synchronous
event-report writes also contaminate phase timings. Main-entry to later trusted
input was approximately 1408/669/1014 ms; this is diagnostic, not an Electron
lower bound. Correct the harness before attribution or repeated measurements.
50 MiB is unrun. Evidence remains in
`/private/tmp/zorid-editor-floor-second-20261029`.

The index optimization reduced counted manifest visits from 501500 to 32032 in
the 1000-note benchmark. Its single unoptimized timing changed by about 2%; that
does not establish a meaningful startup or navigation latency gain.

## Obsidian reference — shipped static evidence

REA inspected cached Obsidian 1.14.5, artifact SHA-256
`3a349274f789b62c5b35ad19de10311909a94e8783033569c2210a4bac491780`,
app.js SHA-256
`95b9fd3944625c3b88116878b03d655147fed8cdfe6ddf931f2064ead78ccd5b`.
Targeted REA evidence: `ev_f56103a467bb6188e376c4c5697b539d32bcf961247f394a268bdd9e36d48e43`.
Private extraction/provenance stays outside source under
`/private/tmp/zorid-obsidian-rea-20261029`. These are static findings, not measured
runtime behavior or a complete application call graph. Cached runtime selection
was not observed. No proprietary recovered source is committed.

Transferable findings, with original app.js byte offsets (end exclusive):

- Startup awaits namespace enumeration; Obsidian does not prove constant-time
  startup. Metadata initialization reuses persisted mtime/size/hash metadata and
  queues stale content for worker processing without waiting for worker drain
  (1759964–1762552, 1765845–1770212).
- Layout forces visible deferred views and conditionally defers hidden views
  (2915232–2917539). Ordinary text views still read the full file string
  (2814142–2814700, 1428073–1428487, 554072–554387); chunked disk reading is not
  demonstrated by this artifact.
- Save requests coalesce over two seconds; the default scheduling helper does
  not reset on each keystroke. Save failures can show persistent notices and
  request an unawaited backup (2812380–2814052, 549457–550065). This does not meet
  Zorid's requested automatic recovery UX or prove crash durability.
- Adapter queues continue after rejection, which prevents queue poisoning but
  does not retry a failed write (569823–570039). File recovery separately stores
  IndexedDB snapshots, ordinarily five-minute interval and seven-day retention;
  pending paths retry periodically (3460161–3460195, 3460731 onward,
  3465962–3467408). It is not evidence of per-keystroke durable operation replay.

Adopt metadata reuse, cooperative parsing and deferred views where appropriate.
Keep Zorid's stronger identity/CAS and durable publication protections. Independent
draft protection and automatic renewable bindings remain implementation work.

## Integrated candidate checkpoint

All changes below are in the isolated candidate, not main or the installed app.
Source review and focused checks do not establish packaged acceptance.

- `4f60473c` reduces Pump manifest lookup work; `df98bfd0` retains generic durable
  error fields across contextBridge. Independent reviews accepted both.
- `302cc0f3` + `5191ddcd` overlap Chromium navigation and vault opening behind an
  authenticated IPC barrier. Actual-main tests cover early requests, failed
  opening, reauthentication and synchronous navigation exceptions.
- `ce33313b` + `eb98603b` separate namespace readiness from committed metadata
  hydration. Actual Workspace editing/saving proceeds with a metadata page held.
  `41cce2ee` renders the selected pane first; other visible panes remain awaited.
  All have independent source approval. This does not establish 800 ms launch.
- Creation continuation is composed through `f1afc233`, including actual nested
  child presentation, retained parents and accessible failed-close drafts.
- Read renewal is composed through `a80b02fd`: authoritative retirement wakes
  owned recovery, one repair budget survives delegation, explicit release rejects
  held calls, and late successful old-host replies are discarded. Cross-review
  caught that last race; successor tests prove it. Native acceptance is pending.
- The independent journal storage, selected-entry inventory, coordinator and
  document admission are composed through `75000120`. These reviewed foundations
  remain unwired. Journal ACK means its storage barriers completed, never a Core
  save. Main/preload/provider wiring belongs to checkpoint_dedup; NoteBuffer and
  DurableNoteState protection belongs to file_open_audit.
- Cooperative native reconciliation remains in maintenance_triggers' isolated
  branch. Ten unique Native quantum/namespace checks passed; five Store epoch
  checks passed. The old real-host RED imported all 32 notes in one request;
  the new process test imports a bounded partial batch, permits a leased read and
  checkpoint CAS before continuation, then completes with exact checkpoint bytes.
  Public copied-vault controls found a rejection-starvation bug; its fix and final
  guards are still being verified. No final batch integration or speed claim yet.

Corrected benchmark source through `1e8602de` buffers timing events and supports
seeded repeated order. The preceding corrected two-case package still produced
an invalid reopen receipt (missed fixed probe; later input 5694 ms), and valid
selection-clock input at 171 ms. Construction was about 58/84 ms, respectively.
Those are fixture-editor results, not production authority. Evidence:
`/private/tmp/zorid-editor-floor-corrected-20261029`. The late diagnostic latch
was corrected afterward; that successor has not run in a package.

Disk exhaustion stopped a Store test compilation before execution. Its own
process group was canceled and verified absent; the failed run is preserved.
The user then freed space; actual available space was measured at 6.5 GiB and
verification resumed. Only rebuildable caches/dependencies were reclaimed.
The old isolated performance fixture is preserved in a byte-verified archive
`performance-preserved.tar.gz`, SHA-256
`b50046ee65e2b94b96d632624531cdb24e699fc35ba2f7a2364bd042ce75994d`,
with its 1070-file verification receipt under the previous save-platform-prehint
worktree's `tmp/isolated-recovery-20261029`. No vault or real app data was removed.

Additional foreground work was found by source audit: periodic history runs before
hello and read replies, loads bodies before cadence/equality decisions, and prunes
on opening/capture. checkpoint_review owns a separate deferred-maintenance and
metadata eligibility implementation. Host scheduling waits for the quantum batch
to release its overlapping host/service files. This is not yet a measured cause
or a completed change. index_redundancy separately audits background index work
during import; explicit foreground demand and cleanup must remain possible.
