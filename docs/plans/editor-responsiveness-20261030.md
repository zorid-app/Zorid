# Editor responsiveness — 2026-10-30

Root owns `codex/snappy-editor` / `.worktrees/snappy-editor`. Concurrent recovery
coordinator retains sole main integration, GUI and install lane after explicit
ACK in `/private/tmp/zorid-snappy-coordination-ack.md`; root serializes its release
build and obtains a GUI slot before actual measurements. This resumes the performance work deferred
in the preceding instant-editor delivery; frozen recovery feature work stays frozen.

## Requested behavior

Nearly immediate launch-to-usable editor and Bases interactions. Work targets
earlier Rust startup, selected-note priority, overlapping configuration reads,
and remaining background cost. Backend readiness is separate from visible,
trusted editing. An 800ms result requires actual evidence.

## Ownership and source

- Startup sequence: `startup_sequence`, `codex/snappy-startup-sequence`,
  source `6b8fb5a3`; root-composed `404e1a1c`. Main reads overlap; primary
  native open precedes durable client-slot claim and window construction.
  Independent read-only review by `native_oracle` found no blocker.
- Note-property membership: `background_bases_audit`,
  `codex/snappy-property-targets`, source `9caa3d88`; composed `651f0218`.
  One vault event and initial setup no longer request duplicate membership
  reads. Genuine later invalidations still schedule successors.
- Native acceptance oracle: `native_oracle`, `codex/snappy-native-oracle`,
  source `11e720ec`; composed `1aa93ec3`. Permits the enhanced editor's own
  intentionally hidden backing textarea while requiring visible editable UI.
- Initial Rust quantum: `selected_note`, `codex/snappy-selected-note`;
  implementation and validation pending. This does not by itself implement
  priority import for an arbitrary missing selected path.
- Base post-query definition reuse: `native_oracle`; narrow scoped investigation
  and mounted regressions pending, with freshness/recovery barriers retained.

## Verification

Startup worker reports109 focused checks. Property worker reproduced two failures
before its fix and reports32/32 after. Oracle faithful fixture failed6/8 before
fix; focused composed oracle checks18/18 after. Root combined relevant startup,
main, property and oracle checks57/57, zero skips. These counts overlap.

Actual unchanged pre-change packaged baseline campaign:
`/private/tmp/zorid-packaged-startup-snappy-before-20261030-001`. Both launches
lost foreground during navigation, so the full campaign is invalid; dependent
reopens skipped. Candidate partial ordinary-note accepted edit464ms; startup
first edit observed by5083ms including launch/attachment/navigation overhead,
800ms indeterminate. No performance improvement claimed. Both owned apps and
Native processes normal exit with no remaining owned PIDs.

## Background findings

Prior paired002 candidate unchanged reopen audit2553.5ms spans188RPCs:
discovery1095.2ms, import1150.3ms, publication219.8ms, completion6.2ms. Installed
1532.1ms was one blocking request; candidate queued-read maximum45.4ms versus
installed1532ms. Preserve bounded yielding. Reducing total throughput cost needs
fresh profiling of repeated proofs/observations; this workload has no runtime
index owner and does not measure actual Bases input-to-ready.

## Remaining delivery gates

Independent scoped review, composed relevant validation, exact-source release
build/package verification, actual native terminal-summary rerun and startup/Base
measurement, main integration and installed smoke. Stage and verify replacement
before retiring the previous app. Preserve real vaults/preferences.

## Reviewed candidate and serialized delivery

Source `5add9180` includes independently reviewed startup404e1a1c, membership
651f0218 and Base schema5add9180. Base mounted regression demonstrates3->2 schema
RPCs per acknowledged cell edit; exact current configuration proof/source context
and successful settled load are required for reuse. External event refreshes stay
unconditional. Recovery coordinator will independently compose these runtime pins
with its recovery scope changes; root will not install an older candidate over it.

Root build001 passes release Cargo jobs1, full TypeScript, native Vite frontend,
and361-file packaged verification. App at `.worktrees/snappy-editor/release/
mac-arm64/Zorid.app`, manifest `.release/inputs.json`; unchanged Native SHA
`7eb957c8aaee17004c03160f88d2f3b658b6ee93cf42f644331297a855f72447`.
Shared `.worktrees/instant-editor/target/s1-release` now idle; no Rust source delta
in this package. Existing installed real app87800 remains untouched.

Initial1 experiment848ba5a8 is preserved in `codex/snappy-selected-note`,
NOT accepted for integration: budget-only deferral can increase the interval before
a selected external file change is observed. Unit1 and bounded framed16 pass;
full process initial14/17 had two obsolete continuation fixtures later corrected
and an unclassified60s large-stream failure, excluded from bounded16. No actual
selected-first improvement claimed. Next isolated owner `selected_note` at
`codex/snappy-selected-observe` owns explicit leased per-selected-ID observation,
using existing physical proofs without global recovery; no JS seam ownership yet.

Test-only benchmark fidelity/focus instrumentationb44bd5fe remains separate.
Correct key identities and passive capped focus chronology do not establish why
previous measurements lost foreground. No guard relaxation or repeated activation.

## Resumed sole ownership — latest user instruction

User says the other session completed and transfers all work to this session,
with no further coordination required. Root owns main integration, builds, GUI
and install. Continuation is `codex/snappy-continuation` from main59ce6b6a in
`.worktrees/snappy-continuation`. Current installed combined runtime4efdee5c
already includes startup/config overlap and both redundant-read fixes, plus
recovery simplification. Recovery native00627checks and installed save/restart
smoke accepted; previous bundle removed after proof, real87800 left untouched.
Do not install old precombined build001.

Corrected packaged timing campaign after-001 compares installed combined app
against preserved build014 package (not the removed prior installeda1c build),
with exact matching manifests,1000notes and disposable profiles/clones.

Reviewed pure-core selected observation8549814a is preserved, NOT wired into host
or desktop and NOT integrated.10focused checks pass. Its existing changed-file
observer still scans pending projection metadata, so it is not a scan-free or
app-performance result. Decide transport wiring after updated critical-path timing.

### Current observed startup and next candidate

Corrected after-001 remains invalid overall due genuine app deactivation before
window blur, despite explicit key identities. Both fixtures restored and app/native
normal0 with no owned processes. No800ms acceptance or wrong blame attribution.
Main-clock evidence confirms candidate native spawn491.69 precedes window
construction527.11–759.35ms; preopen927.90ms versus baseline service1210.89ms.
App-ready→initial windows528ms versus817ms in this pair; constructor times differ,
so not a controlled per-component speedup claim. Candidate native reconciliation
301ms remains critical; selectedfirst import remains unresolved.

Next source06baa578 composeddd730b09 moves config/preopen after singletonlock
but before Electron ready; actual UI/claim/IPC/menu remain after ready. Author117
focused checks; root composition pending. Native crate tree exactly unchanged
`e5e027d22dd04cfa88454a168c045e412dab6b6c` versus verified5add9180, binary7eb.
Reuse verified native while rebuilding/checking frontend and package; no Rust
experiment or transport wiring included.

Optional autosave-fixture benchmark experiment is under separate test-only work
to isolate shortcut-related focus loss; default Save/Undo behavior and all strict
foreground/source/receipt/cleanup gates remain. Cause not established.

## Current execution — Base index refresh, user sole ownership

Root now owns `codex/snappy-index-refresh` / `.worktrees/snappy-index-refresh`
from main59ce6b6a, keeping unproven pre-ready startup isolated on
`codex/snappy-continuation` atc07ed20a. Installed runtime4efdee5c remains accepted.
Root may integrate/build/verify/install autonomously under latest direct transfer.

Startup pre-ready002/003 confirmed early configuration but did not establish a
latency improvement: callbacks delayed actual preopen until afterReady; candidate
navigation also finished later. All owned packaged app/native processes quit
normally and fixtures restored; repeated foreground loss invalidated full timing
and dependent reopens. No800ms acceptance. Do not ship a presumed startup win.

User provided a quiet foreground slot. Actual Base performance001 stopped on an
incorrect relay operation-count oracle (opaque database bodies have no op tag).
Private002 reports unavailable op counts and preserves genuine byte/revision
checks. It completed four trusted edits with exact A/B/source/entry/member/file
readbacks:1698.2,1728.1,1597.7,1713.8ms, maximum frame gaps17.6–17.7ms. Fifth edit
lost foreground, so no full five-edit campaign acceptance; failure cleanup
SIGTERM0/leaked[] is not normal-close acceptance. Artifacts under
`/private/tmp/zorid-base-edit-performance-result-20261030-002`.

Each accepted edit made340–388observed requests:61runtime steps,~120runtime
observes,57–58Continue deliveries plus matching ACKs, one Base query and
4database requests whose operation labels are unavailable. Runtime owner commands
are reducer controls, NOT client lease reacquisition. Current native pumps32
records, yields after every pump; foreground budget8 then background budget1
adds Observe/Continue overhead. Do not bypass reducer ACK/selection fences.

Native-only authoritative fixture benchmark5/5: set_entry RPC57.47–86.20ms,
median64.45ms; fresh preparation<1ms, exact verification3.8–12.46ms.1000nonmembers
and two real collection members; unchanged B/IDs/revisions/no pending projections;
normal native/helper EOF/exit0; no GUI/index owner. Source receipt
`/private/tmp/zorid-snappy-native-base-20261030-001/receipt.json`. Import7.406s
separately. Thus derived freshness is the primary measured UI wait candidate.

Named implementation `background_bases_audit`, isolatedcodex/snappy-index-reuse:
index generation/snapshot/lib export +store document_index only. Separate128
total/32new extraction, existing1MiB source/output limits, soft8ms first-unit
progress, exactreuse/currentauthority/digest/finalcommit fences retained.
`native_oracle` independently reviews design/implementation. Focused Cargo jobs1
owned cache; root serializes release build. No global MAX_PUMP_DOCUMENTS increase
or batching of several issued effects behind one token.

`selected_note` prepares no-GUI production scheduler benchmark for warm runtime
refresh, using exact public Native lease/control/effect paths. Held until Cargo
slot free. `startup_sequence` found duplicate Continue-issued +step notifications
but JS deferred-notification change remains held until native batching is measured.

Pure-core selected-file8549814a remains unwired; fresh selected-path priority and
800ms full editor usability remain OPEN.128reuse implementation alone is not a
performance win until runtime/UI validation. Final delivery requires exact-source
release/package, affected native validation, normal app lifecycle and installed
smoke; no replacement of accepted installed app by old precombined package.

## Delivered speed/focus batch — latest user steering

User objects to expanding tests and asks to make the editor faster. Root stopped
new test/harness/selected-provider expansion and delivered the already implemented
speed and focus changes. Runtime3f43215a is integrated on main and installed at
`/Users/ctk/Applications/Zorid.app`; Nativec455811939642faac79eb8087d0ceb1e5f6f5113ae45ce537754aaf7648851ba.
Release Cargo/TS/Vite/package built;361files verified. Staged and installed
packaged trusted autosave/restart checks passed with both actual app exits0 and
all observed owned processes absent. Native kernel exit status in that smoke is
explicitly unknown; separate paired Native runtime runs have real normal EOF/0.
Receipt `/private/tmp/zorid-speed-install-20261030.json` confirms previous bundle
deleted only after installed proof; obsolete agent stage deleted; real running
user app, vaults and preferences untouched. Restart uses the installed update.

The measured public runtime median improved1583→683ms (~57%), pumps32→8–9.
Visible pre-focus-fix candidate accepted two edits635/948ms; third revealed real
DOM focus loss, not app deactivation: widget removed input while query admission
still blocked and dropped its one-shot completion. Reviewed18c6bfa8→3f43215a
retains exact accepted keyboard intent until admission, preserves earlier captured
user click and cancels on new focus/navigation/context. Existing composed checks
passed; no post-fix complete five-edit GUI latency acceptance is claimed.

Private smoke001 held its debugger open at quit;002 authenticated during partial
Node crypto initialization. Both failed and remain failed. Existing003 corrected
only those runner errors, then passed staged/installed save+restart normally.
No additional product policy was added to satisfy a harness.

Remaining selected-note-first and800ms launch targets stay OPEN. Pre-ready startup
is held on c07ed20a without a proved speedup. Selected provider b9c1a08e/fa51678b
stays unmerged: a real background-import-before-publication regression makes its
new selected route fail where legacy read returns fresh canonical bytes. One
uncommitted regression and logs are preserved on its worktree; all workers stopped
new checks at user instruction. Do not silently ship that route or initial1.
