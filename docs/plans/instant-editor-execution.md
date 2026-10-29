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

The thread goal already exists but is marked blocked. On the user's request to
create a goal, create_goal rejected replacement because that goal is unfinished;
the tools cannot resume it. UI Resume is needed. This record tracks current work
while implementation continues; the objective is not complete.

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

| Scope | Owner / branch | State |
| --- | --- | --- |
| Floor benchmark | checkpoint_review / startup-editor-floor | `032c95b3`; independent review requires buffered event reporting and finer phase markers before reruns |
| Cooperative import/publication | maintenance_triggers / import-quantum | Actual old production-host RED; green implementation pending |
| Pump manifest lookup | index_redundancy / pump-manifest-lookup | `5352e93c`, `ff82369d`; 25 unit and 22 integration reported, independent review pending |
| Typed error transport | file_open_audit / durable-error-transport | `01076cf1`; focused 124 tests and independent source review accepted; packaged contextBridge gate pending |
| Creation continuation | checkpoint_dedup / managed-creation-continuation | `ecfb16cc`; reviewer found final async presentation retirement gap, successor pending; nested fire-and-forget path remains open |
| Independent reviews | startup_audit, binding_inventory_review, native_enrollment_review | Read-only review scopes; no overlapping implementation |

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
