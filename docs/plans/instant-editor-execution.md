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

## Current execution checkpoint — 2026-10-30

Root remains sole integration/build owner in `codex/instant-editor-current`;
main remains `7d8006b8` and the installed application is unchanged. User repeatedly
resumed this work. The goal tool's stale blocked status is not an execution stop.

Capture identity contract `774cf2d8` is composed through `367a174d`: Store schema20,
caller-owned IDs, exact independent-journal ACK, bounded pending lookup, restart-safe
cancellation, native/host wire, renderer claims and sealed cleanup. Store GREEN009
passed41 focused checks. Native GREEN010 passed181 across six native/host groups;
Rust source unchanged, digest73159ecba79fb78e5a3400d10e26e299eb96e527efbf8cc71818196219d21d91.
Native/host test leaves used opt-level0 to bound compilation; functional evidence,
not production timing. Receipts: tmp/instant-editor-validation/capture-request-
{store-green009,native-green010}*. Native RED003 reproduced four lost-reply/cancel
failures before implementation. Independent source reviews do not establish UX.

Root Main retirement certificate/trusted journal binding reviewed; focused checks
pass. First composed JS gate366/371: four fake-main binding omissions corrected,
focused checks pass; unchanged one-second fake-host timeout passed isolated.
Second composed JS run passed385/385, zero skips. Reviewed ordinary-open cleanup
follow-up10fd7ffa also passed46/46 after composition; healthy note admission now
queries no pending-capture inventory. Optimized production host build011 passed
with unchanged Rust inputs; SHA256
6c385c3ed3296cc4fff1366b83940d7c8c41f497c5ed7d60fad5c3561a3edaaf.
Packaged startup harness pure checks42/42 pass; no GUI timing claim. Raw settings through4be56035 passed254 focused
checks andTS. Base configuration/summary/inline/reference continuation remains owned
by base_config_recovery in its isolated worktree, producta5fcf278 awaits review follow-up for a held post-save query race.
Additional confirmed note Properties submitted-set_entry recovery gap is owned
by checkpoint_review in .worktrees/managed-properties-recovery, Properties plus
narrow Workspace managed-property callbacks and dedicated test only. Canvas
post-recovery failed-save latch is under scoped reproduction by capture_note_ui_finish.
capture_note_ui_finish owns removing ordinary-admission pending-request discovery,
keeping before-capture cleanup and exact release wake/claims intact.

Earlier disk-full native attempts produced no behavioral verdict. Only closed,
rebuildable agent app bundles were removed after identity/process checks. Some
old binaries were deleted rather than archived: exact cleanup receipt at
 tmp/instant-editor-artifacts/retired-builds/cleanup-receipt.json.
Vaults/preferences/installed app/fixture reports preserved. Disk now~7.5GiB;
heavy builds serialized. Production host/new package/actual GUI timing and faults/
main integration/install remain required. Package008 predates recovery changes.

## Package009 measurement checkpoint — 2026-10-30

Reviewed Base batch7e1aa050/a5fcf278/9d351261 composed as504731ad/1d35dec3/
26c39aec. Root new configuration/raw/inline group33/33 passes. Package009 passed
TS/Vite/361-file verification, unchanged runtime inputs. ASAR
1b57047938892f80eaba0d655ae7b255a53ed0d6b72e1ee76dac1051eb066927;
Native6c385c3ed3296cc4fff1366b83940d7c8c41f497c5ed7d60fad5c3561a3edaaf.
Frozen tmp/instant-editor-artifacts/candidate009 retains ASAR/host/dist/manifest/
source inputs/build receipt; build-receipt SHAa270a0d98e55b5028a4e4181a77a31f501cef1b4020cb35c9d26f4a9959ef1c3.
Actual-host framed integration996c0c32 composedc050ec8c; Root1/1pass0skip. Checks
original guards after EOF restart/offline same-size+mtime mutation, exact replay,
sticky Changed and cancel tombstones. Normal EOF exits; no crash/lostACK/UI claim.

Actual campaign /private/tmp/zorid-packaged-startup-capture009-20261030 is NOT
accepted overall. Candidate trusted ordinary input upper185.991ms, large432000
upper293.694292ms: both per-case valid target-met. Firstimport input~8.3s is
indeterminate with late main4.62s/renderer6.40s attachment, not valid800ms verdict.
Candidate Base failed: Profile.base tree row unavailable before navigationdeadline
while namespace import still incomplete. Baseline Base failed focusloss; earlier
commentary misattributing candidate focusloss was explicitly corrected. Both
reopens skipped dependent first-import return preparation. Both app/native exits
normal0/nullsignal, ownedprocesses gone, testclones removed. Fixtures/reports kept.
Initial part overlapped bounded worker checks; no whole comparative speedup claim.

Trace296 rescan RPCs contain only5scanIDs; these include bounded incremental
quanta, NOT296fullscans. Last249 calls continued one scan to observed849. Native
owner capture_native_finish tracing why5scan starts overlap owned save/undo;
no new reset optimization approved yet. checkpoint_dedup owns deferred unrelated
checkpoint startup hydration; checkpoint_review owns note Properties exact pending
set_entry recovery; capture_note_ui_finish owns Canvas truthful recovered save-state
plus narrowly ACKed Workspace factory wiring. Active Base owner retains reviewed
follow-ups/legacy compatibility. Source-only progress is not native acceptance.

## Prior verified performance delivery — runtimed180c9b6 / harness7d954b57

Current acceptance: d180c9b6, independently reviewed; Root140Native +52frontend
focused checks pass, package008 TS/Vite/361file verification pass. ReversedNative
pairs show fullimport13–17%/explicitunchangedaudit17–23% faster than prior598c.
No actual800ms/wholeGUI/faultcampaign/mainintegration/install acceptance. Exact
currentreceipt/artifact/ownership details are in Current verified performance
delivery below; preceding measurements preserve historical comparisons.

Goal ACTIVE. Main remains7d8006b8; installed app remains the prior verified Notion
bundle. No800ms startup claim, no main integration or new installation. Root is
sole integration owner and does not coordinate with the finished other session.

Current reviewed source includes automatic typed note-load continuation,
unadmitted per-view cancellation and guarded fresh-admission wakeups. Root
composed JS004:631/632 pass plusTS pass, unchanged source. The remaining old
immediate-load canonical-settlement assertion was strengthened in812acd96 with an
actual held recovery CAS; its full11-test file passes while retaining exact plan,
one-commit and final canonical-body assertions. Cancellation author165tests and
independent review pass. Already-dispatched serial Vault provider reads still
await settlement; no underlying provider cancellation claim.

Native no-op revision writes fell from1310–1349 to698 across two unchanged
inventories (~47%). Its first timing sample regressed to12.31s startup completion /
10.26s audit; this is NOT a latency win. Followup1c83cd65 removes duplicate JSON
allocations and fixes the real scalar-readiness private-recovery-capture regression.
Actual Root73scan+2capture+57namespace tests all pass, including the previously
failing postcommit preservation and strict full/selected corruption controls.
Release host9febfe217ae6909d9980742867ae69355b3dd3fac4f00f27f79fa2401e433c76,
Native source1c83cd65, unchanged Rust input digestd95b15e2…; receipt
`tmp/instant-editor-validation/native-inventory-followup-green004.json`.

Native hello008 measured916ms:20ms vault open,9ms recovery/cache,344ms initial
reconciliation,543ms unattributed loader/framing/parent scheduling. Native004–008
ran under DEFAULT sandbox. Separate same-binary CLI validation (no vault opened)
measured first557ms then4–5ms default; later warmed escalated3.7–7.2ms. Cache/order
confounds prevent isolating sandbox/loader. Do not describe half a second as Rust
runtime initialization. Cold SQLite COUNT68ms, warm0.003ms does not establish a
new schema optimization requirement. Large external maps are NOT packaged;
profiling may use only external maps tied to exact packaged JS and pinned hashes.

New6c7ff9e8 fixes a concrete unnecessary rescan trigger: a healthy authenticated
paused runtime retains its existing bounded metadata watcher while Native polling,
indexing and history remain paused. Known changes queue until resume; real gaps,
failed grants, last owner teardown, watcher failures and overflow retain recovery
scan duties. Author independent review and Root124focused CJS checks pass.
Build006 passedTS/Vite/package/361-file verification with unchanged runtime inputs:
ASAR11ccd1cb8166c25a32ec6ab15404993ac93b0832b1504e49bbf9613c11398059;
Native9feb… unchanged; source6c7ff9e8. Receipt build-006.json SHA
5f88af176cfb668a6ae2a8e02eab8d233442c26c07162c4e8d3ff512ece19d33,
manifest SHA2d0895893256155393109331a9d2a367edba467371c931ffc5dc5c1695b6264a.
Minimum free disk7.09GB during build; later6.6GiB available.

Packaged pilots001–005 remain FAILED/INVALID evidence. Final005 got real trusted
ordinary input candidate527ms vsbaseline682ms, large968ms vs731ms, then bothBase
checks failed with hidden/unfocused windows. Both owned apps/native hosts normal0,
dependent reopens skipped; no whole-run performance acceptance. Earlier003/004
exposed observer starvation and hidden RAF; no negative snapshot can prove an800ms
miss without continuous eligibility coverage. Reviewed harness now polls readiness
observationally, includes normal activation in original clocks and confirms focus
passively, aborts on interference, and captures Base/visibility diagnostics.
Root42pure harness checks pass; original source/body/receipt/clock guards remain.

One CPU diagnostic006 failed before profiling because focus was lost after initial
activation; cleanup normal quit timed out and owned app was terminated. All102
fixture files and app/map hashes unchanged, no owned PIDs remain. This is NOT a
normal-close/performance pass or established product defect. Preserved report:
`/private/tmp/zorid-packaged-startup-cpu006-authorized-20261029/report.json`.
file_open_audit owns ignored CPU script preparation only, correcting initial joint
renderer/window confirmation and failure evidence before any Root quiet run.
maintenance_triggers owns a bounded fresh1000-note Native-only comparison with
frozen baseline/newhost and new fixtures; no GUI or source implementation there.
Serialize the Native comparison and any actual CPU app pass. No other heavy lane.

Additional authoritative evidence: escalated fresh0091000-note pair normal0/all1001
bodies exact, baselinehello6.30s/full11.76s vsnewhello1.60s/full14.25s. Candidate
longest FIFOread203ms vs5453ms, but totalcompletion21%slower. Fresh010 then used
the ORIGINAL9feb executable, no newcopy: emptyfreshhello93ms, fresh1000hello97ms,
selectedCorebody0.32ms, phasevaultopen32/reconcile58ms. No completion/UI claim;
copy/first-exec/cache/environment effects remain confounders, not an inherent
Rust initializer cost. Source reports under import-quantum native-workloadtmp.

Escalated sample011 succeeded(earlier default-sandbox samples had failed): late
import828samples, wholephysical_bindings304(36.7%), baselineJSON193(23.3%total),
fullproofload34(4.1%),noopguard11(1.3%). Early import durablecommits/fsync remain
necessary. maintenance_triggers now owns isolated namespace-candidate-metadata,
base6c7ff9e8: scheduling-only binding metadata then strict full selected/member
validation. No Source mutation authority may come from that metadata. Root composed tests097f5e22 and corrected-scope c3944a77. Actual RED002
finished101: intended already-processed positive acknowledgement fails on unrelated
baseline JSON; four selected-corruption/folder/restart controls pass. The correction
does not promise unrelated namespace mutation can bypass Store global transaction
validation. Product implementation/review is still pending; no latency win claim.
Log: tmp/instant-editor-validation/namespace-candidate-red002.log.
Product1c65c690 plus explicit-import correctiona576 composed0beed631/626a14b9.
Independent final review accepted. GREEN005 failed compilation on the missing
PhysicalBinding import (preserved receipt); GREEN006 is the corrected serial lane.
79scan/candidate +2capture +57namespace checks and host build all pass, Rust
inputs unchangeda2eba327e0a97a153f976de5ca80a01c44379246cf6682263c63bf35c13c0b91.
New host598c4ba046570a0ba2311362accfac63c8b88949565c66563434b969792750ae.
Actual paired fresh012 then reversed013 both normal0/all1001 bodies exact,
source/IDs/revisions/cursor unchanged during explicit audit and zero auditimports.
Fresh012 candidate-first: full12.03→11.26s, audit5.59→4.92s.
Fresh013 baseline-first: full11.01→11.93s, audit8.80→5.46s.
Thus repeated audit work improved in both pairs; first-import total improvement is
NOT established (opposite directions), no800ms editor claim. Original executable
paths, one --help warmup each; cache/memory/order remain uncontrolled. Reports under
.worktrees/import-quantum/tmp/native-workload-20261029/fresh-012 and fresh-013.
Package007 passedTS/Vite/macOS unsigneddir/package361file verification, runtime
inputs unchanged; Native598c and unchangedASAR11ccd1cb8166c25a32ec6ab15404993ac93b0832b1504e49bbf9613c11398059.
Receipt build-007.json SHA f92cf0793879fa50fabda6368e4b4dfea4132aef3e73c0e56ca67edbf13dd3c9.
No app launched for007; main/installedapp still untouched. maintenance_triggers
owns one bounded optimizedaudit Native CPU diagnostic, noCargo/GUI; Rootheavy
lane free until that diagnostic is terminal. file_open_audit owns read-only
large-note repeated-computation audit, no execution or scope expansion.
Known remaining cost: metadata enumeration/sort per quantum and selected folder
member validation are still unbounded by one scheduling unit; no800ms claim.

Quiet CPU006 retry ran under Root blocking command, no agent notifications; still
lost focus before any mousepress/CPU capture. It DID close normally (app/native0,
no forced/no ownedPIDs), all102 source paths and product/map hashes unchanged.
Report `/private/tmp/zorid-packaged-startup-cpu006-quiet-20261029/report.json`.
Failure timeline shows joint native/documentforeground confirmed then hide/blur
before the second navigation guard. Cause is not established. The async user
question for30seconds of uninterrupted foreground is pending; do NOT run dependent
GUI work before an actual availability reply. Continue useful non-GUI Native work.

Remaining REQUIRED: trustworthy actual startup/ordinary/large/Base measurements,
first-import Native completion comparison, actual fault recovery campaign,
main integration/build/install, caller-owned pre-dispatch capture request identity,
and the preserved recovery scopes/raw Base settings/date batches not yet composed.
Do not silently drop these or mark the whole goal complete from the green checks.

## Followup baseline — now implemented in current verified delivery below

Nativeaudit014 is terminalnormalEOF0/reaped79331, sampler0; newdisposable1000-note
fixture only. Sampledaudit5330.7ms;1001bodies before/after exact, IDs/revisions/
cursor/head andphysicalnamespace unchanged, zeroimports.762mainthread samples:
Paths.verify406(53.3%), file_snapshot260(34.1%), confirm_snapshot214(28.1%);
inclusive counts overlap. Fullbaseline decode now18(2.4%), wholebodylist hotspot
absent from this window. Source reveals confirm_snapshot internallyfile_snapshot
then positivefileloop repeatsfile_snapshot for same immutable inventoryproof.
maintenance_triggers owned minimal per-attempt snapshot reuse and adversarialrace
controls in namespace-candidate-metadata; now closed and composed as recorded below.
No broader pathguard refactor.

file_open_audit owns codex/large-note-copy-cost, isolated from626a14b9. Bounded
realEditorState counterreproducer shows plain432000note causes full-text copies
in Base/callout collection despite neitherfeature present, and Bases repeats on
selection/effect-only updates. This is proven unnecessary work, not an attribution
of pilot005968ms. Root test-only1c1cb4e5/d4137212 both actualRED, logs
live-bases-copy-red001.log/live-callouts-copy-red001.log. Subsequent product/review/gates are recorded below; acceptance requires actualBase/callout match before wholetext capture, preserve syntax-tree,
selection/focus/exclusion changes and exact containing-document/occurrence guards.
NoGUI/rust execution by frontendauthor; Root serializes any newheavyNativechecks.

## Current verified performance delivery — d180c9b6 / package008

Native3b5f7e7e tests composed99b02ba0 actualRED: onceproof2vs1 fails, six
post-capture inode/parent/same-size+restored-mtime race controls pass. Product
af5058b0 composedd180c9b6 independently accepted. RootGREEN00781external+
2capture+57namespace=140pass plusreleasehostbuild, Rust inputs unchanged
cb898cdcaf0fdd1579bbf15791e1604a8fc56e582f9cb0cde69a896c6992f90b.
Nativecba21d7165925473c6ccb31939f9d8f1b15978072700403fe1e0887aaa0a09e2.

Front22bfd7f0/bbd09165 composed6614c86e/cc19e3fa, independent review accepted.
Root52focused Base/callout/parser/exclusion/sourceauthority tests pass, zero skips.
Both actualRootRED logs preserved; plainnotes/ordinaryfences avoid these fulltext
copies, selection/effect-only Base updates reuse exact spans while doc/tree/
exclusion changes still refresh. This does not establish actual GUI latency.

Nativefresh015 failed argument-only baselinewarmup3s before any vault launched;
Python subprocess.run killed/waited the timed-out child. Preserve failed report+
failure-envelope; no performance verdict. Fresh016 was prepared but not run.
Corrected017/018 extend only warmupbound15s (not vault/measurementcaps), andboth
normalEOF0/all1001body checks/sourceIDs/revisions/cursor/namespace pass, zeroaudit
imports. Baseline fixed existingpackage007598c, candidate originaltargetcba; one
--help perbinary, no cache/order equivalence claim. Candidate-first017full
11.994→9.959s, audit4.903→4.080s. Baseline-first018full10.803→9.399s,
audit4.942→3.828s. Thus this fixture shows fullimport13–17% and explicitaudit
17–23% faster than preceding598c inbothorders; not editor800ms acceptance.
Reports .worktrees/import-quantum/tmp/native-workload-20261029/fresh-017,018.
Package007baseline path was kept unchanged throughbothterminal pairs, then
replaced bypackage008; runtimehashes checked before/after eachcase. No retained
598c executable artifact claim; source626a14b9 and build007 receipt preserved.

Package008 passed RootTS/Vite/macOSunsigneddir/361fileverification, inputs
unchanged. Source/NativeSourced180c9b6, ASAR921780c98c8ea5219ea2d4581ac293444b7060b5987cd31ebeacc62d8b48e95e,
Nativecba21… above. Receipt build-008.json SHA92a4bc3c25dd2e97ba4df9d6d369b74e84a76b52f3b5c6018f8d658110b37f01;
manifest1be44910687cfac0431bf868ba8474928ca0b778020de7bc85669107a331c232.
Minimum available3.025GB. Frozen native+ASAR+inputs+receipt+externaldist/maps under
Roottmp/instant-editor-artifacts/candidate008, manifestperfilehashes verified.
All Rootheavy commands terminal; no app launched for008. Main7d8006b8 and installed
priorapp untouched. Existing external-map GUImanifest describesolder006, must
regenerate exact008 JS/maps before use. Foregroundavailability question still
unanswered; do not start dependent GUI work before actualreply.

Knownrequired recoverygap remains: capture request has no caller UUID before
firstdispatch; initiallostACK can orphan guard/quota. Prior auditwasmessage-only,
not schema20 code or contractapproval. binding_inventory_review now owns DOCS-ONLY
codex/capture-request-contract/.worktrees/capture-request-contract fromd180;
currentcode authoritative, proposedminimalcontract mustbe Rootreviewed before
implementation. This resumes preserved automaticrecovery work after a measured
performancebatch; no speculative pluginAPI or broadarchitecture redesign.

## Delivery checkpoint — 2026-10-29, source f08e63d7

User reports unacceptable elapsed time. Freeze scope expansion and prioritize a
measured performance delivery; all remaining recovery requirements stay open.
No new version has been installed and the 800 ms target is not yet established.

The former candidate exposed a real regression: 1000-note first-import host hello
fell from 5667 ms to 222 ms, but full import rose from 18.6 s to 84.2 s and unchanged
reconciliation exceeded the 180 s cap. Sampling identified repeated full family
status/graph metrics in scope-only readiness checks. The new scalar readiness
implementation removes those traversals while preserving dedicated full-status
corruption checks and selected-source authority validation.

Actual Root validation: readiness 10/10; Store capture/migration suites 83/83;
Native conditional recovery 22/22; host conditional recovery 7/7. Receipt
`tmp/instant-editor-validation/native-composed-green003.json` confirms unchanged
Rust inputs. Release host build004 exited 0; binary SHA-256
`418f91a0e2afbb3401fc13db47277e0dac36737df043d72dc5f90affdd361d6a`.
Same physical 1000-note workload remeasurement is next; this binary has not yet
been verified in a packaged app. Schema19 durable pre-prepare capture is composed
and these tests pass; caller-owned capture request identity remains an open gap.

The previous packaged pilot is INVALID, not accepted: a malformed Base fixture,
canceled-quit observation and stale debugger binding invalidated receipts. All
four owned apps exited normally and were cleaned up. Reviewed harness repairs
are composed through f08e63d7, with 21/21 Root checks. Protected-draft late-owner
panel guard has its mounted regression passing. No native fault campaign or final
800 ms/install acceptance is implied by these focused checks.

Pending, preserved recovery batches include raw Base settings/readable dates and
load-continuation ownership; remaining review issues must be resolved before
integration. Do not start further recovery architecture while delivering the
bounded performance measurement/build. The installed app and real vault data
remain unchanged.

## Measured package checkpoint — 2026-10-29, build004

Release build004 (source b924b55e) passed TypeScript, native Vite build, unsigned
packaging and package verification with unchanged tracked inputs. ASAR SHA-256
`db43870180a48bab42591a5253c10734a186496ab0777f897e4bd00da46d3c04`;
host SHA-256 remains `418f91a0e2afbb3401fc13db47277e0dac36737df043d72dc5f90affdd361d6a`.

Same physical 1000-note workload: first new-host reopen included schema18→19
migration (hello1289ms). Second reopen hello755ms; full inventory8440ms,
explicit unchanged audit9182ms/267quanta/4013units, zero imports. Baseline
hello4229ms and blocking unchanged audit5540ms. All1001 logical bodies and
physical bytes matched, source head unchanged1002, all3 hosts normal0. The
>180s regression is fixed, but total unchanged audit is still slower than the
baseline. This is native evidence, not editor800ms acceptance.

Packaged pilot002 terminal exit1, preserved under
`/private/tmp/zorid-packaged-startup-20261029-pilot002`. All4 apps and their
native children exited normally; clones cleaned up. First-import ordinary note
trusted-input134ms and432KB note662–685ms met the per-open800ms target in that
run; baseline56ms/350ms was faster. Startup first-import input observed7674–7678ms
is indeterminate for the800ms deadline because observer attachment was late;
main inspector itself attached4784ms after spawn. Do not claim startup acceptance.

Candidate Base navigation exposed another harness defect: Profile.base was absent
from the current file-tree DOM and immediate selector click failed. Root source
renders all currently known rows, so the screenshot alone does not prove
virtualization; cooperative namespace import may still be incomplete. Since the normal
return-to-Note0000 step was skipped after that failure, the subsequent reopen
restored the large note and failed the expected-document oracle. Neither is a
passing whole-run receipt. The isolated harness owner is fixing normal UI
navigation while rows become available or are outside the viewport; no direct
Workspace/bridge opening is permitted.
Native owner is measuring the remaining unchanged-audit cost; no additional
architecture or feature scopes are approved by this checkpoint.

## Follow-up implementation checkpoint — source93c0f3f7

Actual RED for redundant inventory writes is now reproduced on Root: 4 controls
pass, 2 fail; a healthy no-delta import tail appends3 checkpoint revisions, and
repeating already-confirmed acknowledgements also appends3. Frozen tests composed
asded3d4cc; log`tmp/instant-editor-validation/inventory-noop-red001.log`.
The narrow fix must preserve read-only revision/scope/corruption/path checks even
when avoiding mutation. Existing restart, present-proof and retirement controls
remain required. No-op product fix is not yet Root-composed or validated.

Reviewed load continuation batch is composed throughc1efd719. Confirmed canonical
content can mount before held recovery acknowledgments, exact original requests
retain their continuation, and new journal offers wait for content admission.
Both reentrant-callback ordering and canceled pre-admission duplicate-branch
regressions were reproduced and fixed. Workspace93c0f3f7 broadcasts only a fresh
matching admission before dependent view settlement and disposes only unadmitted
failed loads. Root106focused checks plus1mountedorderingcheck passed; per-view
initial-read cancellation wiring remains incomplete. No package/install proof is
claimed for these newly composed load changes.

## Inventory no-op validation — sourced161468b

The reviewed no-op product fix is composed. Its6 focused native tests pass;
no-delta acknowledgements append zero revisions, while real changes/restart,
foreign revision, corruption, present-proof and explicit retirement checks hold.
A broader native external filter ran73 checks:72passed,1failed. The existing
`enrolled_scan_full_boundaries_reject_graph_corruption` still expects the old
whole-graph status traversal at scalar readiness boundaries. The owner must
reconcile this oracle with explicit full-status and selected-source integrity
checks; it is not a passing suite yet.

An earlier overly broad97-test filter was stopped after entering an unrelated
large-binary fixture while free disk fell to1.6GiB. Owned testPID64526 received
SIGTERM; preserved run is failed/aborted, not accepted. Its preceding namespace
postcommit observation test also failed on exact rerun and remains under source
investigation. Do not dismiss it as preexisting without evidence. No user app or
vault was touched. Native host rebuild/performance remeasurement for the no-op
fix is still pending. Root Workspace cancellation work is owned by
native_enrollment_review in a separate new worktree; current Root TypeScript
identified private buffer.vault access in93c0f3f7, assigned to that batch.

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
