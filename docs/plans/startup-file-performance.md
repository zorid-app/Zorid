# Startup and file opening performance — 2026-10-28

User request: profile actual startup and ordinary note opening, identify longest
work, optimize it and build/verify/install the updated macOS app.

Owner: startup performance root, isolated `tingkai-c/startup-file-performance`
at `.worktrees/startup-file-performance`, base b0b09005. Main integration stays
with active database coordinator; scoped file ownership acknowledgement requested
through Orca. Rust recovery scanning belongs to existing coordinator worker.

Parallel scopes: startup_audit measures native startup; file_open_audit owns
`scripts/profile-navigation.mjs`; checkpoint_dedup owns dedicated regression and,
after shared-file acknowledgement, `src/ui/note-durable-state.ts`. Root owns
tracking, profile comparison, build/install coordination and final checks.

Source observations (not timing conclusions): every clean flush writes another
checkpoint; navigation has multiple flush callers. Startup eagerly recovers all
note checkpoints. Background maintenance shares native request queue.

Evidence: `tmp/startup-performance-20261028` (disposable fixtures only).
Implementation, measured native improvement, review, main integration and installed
verification remain separate pending gates. No Obsidian comparison measured yet.

## Measured baseline and reviewed frontend fixes

Native host100-note fixture: fresh1187ms handshake, reopens509/514/570ms,
read0.2–0.6ms. This measures process+vault initialization, not pure process spawn.
Partial1000-note import hits5s reconciliation budget, so those reopens are NOT
fully imported warm starts. Exact owned host sample2368 stacks:2350 inside
reconcile_external,899 in capture_observed_file→family_is_enrolled→graph_metrics.

Actual normal Electron100-note baseline (same installed host hash d4f8bb25):
phased existing-vault restored editor2672/3000/3688ms; core open1000–1282ms,
native open875–1121ms before ordinary RPC; renderer loadFile166–405ms.
Initial baseline simple-note switching30.2–49ms median32.5ms including2rAF.
These small notes do not reproduce the user's longer file-open delay; larger
vault/indexing contention remains to measure. No direct Obsidian timing yet.

Reviewed product commits: d18d02d9 + ae075e2b (dedup only without retained
operation; preserve ownership CAS before intent continuation),8c1fabb5 (clean
checkpoint deferral). checkpoint_review independent exact review: no remaining
must-fix after correcting initial P1. Focused109 tests and separate35 recovery
checks pass; selections overlap and do not imply native acceptance.100 clean
checkpoints reduce200 body reads/200 head loads/100buffers to0/100/0.

Main coordinator acknowledged source ownership and is sole integrator. Native
worker startup_audit owns only scoped enrollment-proof caller files in
startup-family-enrollment; Store validation remains unchanged. Other coordinator
owns recovery-scan implementation and serialized Rust test/build lane. Final
source composition, after profiling, main checks/package/install remain pending.

Native caller optimization775e67e6 is independently reviewed with zero must-fix.
It reuses full enrollment validation within the exclusive scan lock, checks
physical root/scalar identity per use and performs full validation at scan end.
Store status/enrollment and unscoped mutation/source checks remain unchanged.
Three new internal tests exist; Cargo execution is assigned to main coordinator.
Source `git diff --check` passes; no native timing gain claimed yet.

Profiling harness50914756 is retained in scripts/profile-navigation.mjs, normal
source desktop with memory-only temporary launcher timing wrappers. Before/after
will use same44.9.1 executable, identical fixture/profile,100visited checkpoint
notes, exact body checks and normal host/app shutdown. Earlier44.8.0 baseline
is separately labeled and must not be compared as same-runtime evidence.

## Representative scale correction

Read-only aggregate of installed saved-vault preference:2139visible files,
1362Markdown,11Base,7521246Markdown bytes,largest431981bytes. No private path,
filename or body was retained. User confirms slow opening affects both ordinary
notes and Bases. The100-note simple fixture is insufficient to close that report.
Final comparison expands to1000generated~5KB Markdown notes, one~432KB note,
100visited checkpoints and a Base overall1000notes. Complete normal native
startup import before timed UI runs; preserve that setup separately. Reuse exact
fixture/profile and44.9.1 runtime; use early paint observation, note/Base readiness,
per-RPC and source hashes. No actual vault mutation for this experiment.

## User goal correction — remove unnecessary work

Direct user instruction during profiling: "make sure all the unnecessary rescan
and unnecessary reindexing are removed. This is the goal." Focus now explicitly
includes scheduling/invalidations and unchanged-vault work, not only faster scan
execution. A thread-scoped built-in goal tracks this request; this repository
record remains cross-session authority. Preserve real external-edit discovery,
index freshness, durability/corruption guards and recovery.

Representative old baseline reproduced actual stalls: note switches3–10s and
Base8.889s. Long note stalls queue behind rescan executions7–10s and document
runtime_step2–3s; note reads themselves2–7ms. Two clean baseline launches with
same44.9.1/runtime+fixture show restorededitor14.872/13.690s; all1001source hashes
unchanged. Original attempt recorded failed teardown10s and is retained; successor
uses60sboundedgrace and exits0/no signals. Updated candidate measurement running.

## First combined candidate — NOT complete

Representative paired campaign completed5clean normal launches; all1001source
hashes identical. Before400switches p50~47.8ms/p95~93.6/max9766ms; after600
p50~31.5/p95~49.4/max11336ms. Startupbefore13.69–14.87s vsafter13.98–22.85s,
so no startup improvement. CAS626eachbefore vsafter0/1/0 (not universally zero).
BeforeBase6opens255–8889ms; after9opens219–931ms, no tail-fix claim from this.
After rescan5.83–10.59s still monopolizes sharedFIFO; native.open9.64–16.91s.
Candidate source a3159547/newhost73ad0c93, not installed as completed performance
work. Old failed teardown attempt remains failed; retry campaign passes2clean.
Persistent reports:tmp/startup-performance-20261028/representative.

Explicit user goal remains active: audit trigger suppression and full-index
status reconstruction before installing/completing. Need real external-change,
rename/delete, overflow/fallback/restart and index-corruption coverage alongside
no-change work-count and representative timing checks. Main coordinator retains
sole integration and heavy scheduling; startup workers request named extra scopes.

## Follow-up owners and findings (active)

- maintenance_triggers: `.worktrees/startup-maintenance-triggers` at a3159547,
  desktop/core-vault-fixture-service.cjs +desktop/document-runtime.cjs/tests,
  ACKmainowner. Healthy watcher+trusted enrolled point-reconcile for knownfiles,
  fallbackforunknown/missing/folder/blocked/error/overflow, one source notification
  afterjournalpaging, explicitretry/blockedrepair preserved. ExistingfamilyMode
  hadnowatcher, only30sfullscan; cannotblindlydisableexternaldiscovery.
- index_redundancy: `.worktrees/startup-index-admission`, ba416b79 test-first +
  a21b9a4c product, document_cache.rs/document_index.rs ACKmainowner. ONEfully
  validated publishedArc keyed cacheDBsnapshotstamp/head, freshauthority/control
  checks retained.6newregressions, Cargo red/greenpending; native_enrollment_review
  independentlyreviewing. Pumpglobalrestoration remains separate.
- startup_audit: updatedhost24151 profile normalclosed; startup9.882s,
  rescan7.895s. Rescan77.6%samples fs::exact reenumeratingparent percheck O(N²).
  Startup55.5%physical_bindings baselinepointreads. Request fs.rs+tests for
  directory-marker-bound exact-nameproof reuse (notweakeningalias/NOFOLLOW guards).
- checkpoint_dedup: nowread-only Storephysicalbindinginventorybatchproposal;
  physical_bindings.rs/family_external_namespace.rs ownershipACKpending.

No testapp/profiler/nativehost remains. Profilinglane released; mainowner must
serialize nextRustred/green/build. Mainnotmutatedbystartuproot; installationheld.

## Reviewed follow-up receipts

- Index cache ba416b79→a21b9a4c→a525e185: actualred Arcidentity assertion,
  green14/14cachetests(all6new)+22/22existingdocument-indexintegration. One shared
  target stale-binary attempt retained/excluded; forcechangedmtimes+verifycompile
  path/newtestlist when switching worktrees. Testfixturepaths canonicalized only.
- Maintenance3525263e:124/124focused+independent47/47. Bothreviewerszeroissues
  afterfixing lostconfirmed-source notification onscan/reconcilefailure and startup
  watcherrootreplacement. Nativeknown-hinttests6d09351d prepared/unrun.
- Filesystemb1397b5a HELD/REJECTED: timestamp-onlycache canmisscase-onlyrename
  oncoarsetimefilesystems. Replacementresearch usesfresh descriptor-relative
  nativecanonical-nameattribute andoriginalenumerationfallback; no target DBFD
  opened. Needs freshreview/testproof, donotintegrateoldcache.
- Bindinginventory9c4bb16a→1e13116c independentlyreviewedzeroissues; actualRust
  red/greeninprogress, onlyheavyjob. Fullcontentdecodeguards remain.

## Current checkpoint — combined remeasurement pending

Main integrator's isolated candidate now includes source-reviewed indexcache,
watcher, inventorybatch and finalcanonical-name code. Primarymain remains b0b09005;
no install/completionclaim. Native exact-name RED reproduced2,004,000entries;
finalGREEN7/7, enrolledhint8/8, SQLitelock2/2, namespace57/57, import9/9,
creation8/8, large17MiBcompoundexternalrestart1/1(release71s) allpass.
Combinedfrontend243/243 +TypeScript/nativefrontendbuild pass. Mainowner controls
finalnativehost/CLIrebuild andwillgrant profilelane afterward.

Latestnativecandidate headfe365743 (finalfsnetchange, no timestampcache) basedon
c287a8af maintenance +reviewed index/inventory/hintcommits. Verify current head
beforeanyactualrun, exactpackagematchesandmainintegration stillpending.

Harnessroot `.worktrees/startup-file-performance` retains OLD baseline dist;
run finalnewhostagainst `.worktrees/bases-edit-performance` builtfrontend instead.
Latestharnessf8f5806b: optionalfinal-launch35sidle, realexternalprobes, forcedaudit,
validruntimeeffectclassification, alwayssource/exitproofandrestorationonfailure,
actualepoch-overlap qualification. Peerreviewpendinglastcleanupdelta. Do not call
all runtimeSteps reindexing; Observe is classifiedseparately. Overflow notactually
forced, onlyunitcoverage; genuineunknown/rename/delete fallbackwillbeexercised.

Resource: mainowner ownsone-job combinednativevalidation/rebuild. Allstartup
subagentsholdCargo/apps. Rootremovedonly21task-createdcompletedStoretestexecutables
198.4MiB with exactinode/size/mtime/MachOverification; receiptunderpersistenttmp.
Mainowner reclaimedverifiedobsoletepriorbuildoutputs; libraries/installedapp/user
vaults preserved. No live ownedapp/nativeprofiler. Rootbuilt-in goal remainsactive.

## Whole-greeting R2 profile and lifecycle correction

R2 full campaign failed its activation deadline and is retained as failed. Bounded
retry proves exact432000-character note and37ms activation, but startup13.53s and
unnecessary2.515s startuprescan remained. Main composed lifecycle484bb892 as
0fa97c83: preserve pre-admission watcher through broker subscription; only real
polling pause closes it. Root136focused/adjacent checks pass. Short native UI proof
of zero startuprescan is running; full campaign still pending.

Whole greeting01282 host, exactPID6824, normalexit0/all1001hashes unchanged:
7.085s handshake. Active initialization3988samples (idle stdin frames excluded),
external reconciliation96.9%, recover3.1%; physicalbindings27.9%, Text-mode16.1%,
SQLite pager pread about68%. No extrapolation from earlier partial3s sample.
Source unchanged; artifacts current-native-r2-whole-startup under persistenttmp.

Main owner explicitly accepts narrower unchanged-observation contract: exact
filesystem/baseline proof may return without unused full CRDT mode probe. This
changes incidental CRDT scrub timing, not permission to consume corrupt causal
state. startup_audit owns minimal observer+tests; independent review assigned.
Changed-content imports/edits and direct mode probes retain full corruption checks,
as do baseline/physical/metadata/namespace guards. Require zero Text-revisionreads
and history writes on exactnoop. No cachePRAGMA/content-skipping Store changes.
Binding owner separately assesses sequential query layout with identical decoding
only if actual read-only timing supports it. Index owner audits one-request pump
restoration duplicates. Neither investigation authorizes broad redesign or builds.

Main/installedapp unchanged; whole sample lane released. Full acceptance requires
representative startup/open,35s unchanged idle and actual external edit/create/
rename/delete freshness, normal shutdown and exact source restoration.

## Exact post-ready scan trigger

Pure telemetry e0d21d89 actual run after-lifecycle-watch-reasons passes source/
path/normal-exit checks, host18322 gone. Late scan is NOT watcher maintenance:
healthy active watcher, no public hints, needsScan=false, audit not due. Native
startup reports incomplete; src/ui/import-status.ts autoRetry after1s invokes
explicit retryReconciliation and blocks Base5.49s behind5.21s rescan. All runtime
steps are Observe, not Pump. Do not suppress required first-import progress.

Native exact-noop c9a3c707 test-first +158f52b2 product is reviewed with no must-fix;
actual Cargo RED/GREEN remains with main owner. Final five tests include query
calibration, zero retained Text reads/no history writes, changed import and echo,
seven direct/changed causal corruption variants and selected physical guards.
Measure new host before changing retry scheduling; a completed initial scan needs
no autoRetry. Maintenance owner investigates continuation/repeated-inventory work.

Index owner has ACK for local per-Pump authority proof eliminating second identical
manifest capture, no persistent cache/public API. Independent design review
requires stamp from authority (not cache), ordered against initial lazy snapshot
and fresh final Immediate authority/control/header/source/publication checks.
Own/external/DDL/raw metadata changes recapture; race tests pending.

Optional sequential binding query stopped: no repeatable timing gain. Only task-
created196079616-byte database copy deleted; original and receipts retained.

## R3 actual bounded pass — no startup/navigation rescans

Native exact-noop actual RED selected query count[1,1] vs[0,0]; GREEN5/5.
Adjacent hints8, namespace57, imports9, creation8, databases15 and large compound
restart1/1 (67.35s) pass. Main sourcebc0737a8, frozenR3host SHA
fece2888428e451c0d44d61c64dacb71d454ba605aef8f9324b5e1d616d5e7a5.

Actual after-native-noop-r3-diagnostic/report.json passes: initial greeting
complete/finished/scanComplete true, observed1001/imported0/issues0. ZEROrescan
RPCs across startup/navigation/Base; complete initial coverage avoids UI retry
naturally. Startup12.106s/native.open8.187s remains substantial, not pure spawn.
Exact432000-character activation35ms; four switches45/81/29/81ms and Baseopens
271/181/174ms. Prior5.5s Base retry tail absent in this bounded pass. All1001
source/path witnesses exact, cleanupErrors empty, normalexit0/no signal, host30677
confirmed absent. Runtime steps Observe, not reindex. Full3run/idle/external
campaign still pending; no install/completion from this short pass.

Ready final source batch: index992d6e95 test-first→c997aece product (new isolated
startup-index-pump-admission; exact independent review closed no must-fix, actual
Cargo RED/GREEN pending); preserve independent-connection source/head gate.
Maintenance235b1e17 (above484bb892) independently reviewed,135focused pass,
explicitretry inflight sharing plus0healthy no-source index wake; real journal
and blocked repair each1wake. It does not share generic poll/retry scanNow calls:
those may carry different late hints/owner guards, so no identical-obligation
proof is asserted. Renderer retry policy unchanged; partial retries resume same
persistent inventory and remain required. Main owns next serialized validation.

## R4 external freshness gate still open — not installed

Exact integrated composition e696d420 independently reviewed zero must-fix.
Actual index RED(2,2)→GREEN(1,1);54Storeunit (all9new trace/races) +22index
integration including independent-connection source/head,141CJS,15NativeDB,
TS/frontend and release host/CLI pass. FrozenR4host46abbbe8b6179dafebba31cce1888f8a690326fdd28f9434c4b29a9f7f319485.

First full after-final-r4 failed Search preflight because harness omitted normal
Load more UI interaction. Navigation600switches remained valid observations.
Reviewed harness-only9a805db8 uses actual visible/enabled current-query pagination,
retains original60s deadline/completion/current/result assertions; no directpump.
Failed report retained. Successor after-final-r4-successor completed600navigation
switches without background rescans, strict35s idle with0rescan/runtime_step/
document_work/indexops and unchanged source, and explicit forcedaudit.

Successor OVERALLFAILED external Note0999 positive Search gate: exact physical
changed bytes+sameID read succeeded; UI completed0matches despite current index.
No create/rename/delete phases ran. Independent retainedDB proof confirms gen2/
source1003 logical adoption and index row correctly contain exact marker,5499bytes,
revision5e489494-118b-482c-a983-ea7391f16f93, correct manifest/textdigest.
Search rich_start117520ms preceded gen2publish134249ms, no new rich_start until
restoration185611ms. Diagnose UI pinned-snapshot/source invalidation timing; do
not claim index corruption or waive visible freshness. Proposed isolated author
native_enrollment_review; shared editor seams require main-owner ACK before edit.

All restoration actions independently pass, original5451bytes currentgen3/source
1004; all1001source/path witnesses exact, external.restored true, no restoration/
cleanup errors, all3apps normalexit0/no signals. All6ownedPIDs48955/48985/49321/
49351/49590/49619 confirmed absent, lane released. Native/app builds held as
undelivered; main integration/install pending complete external freshness gate.

## Search freshness source corrected; actual rerun pending

RetainedDB diagnosis receipt: tmp/startup-performance-20261028/r4-external-index-diagnosis.json
(reportSHA d000c7ade2bf6af11c8660da9a92cbb46bd69275a32118af81145e7fd5ea073a).
Rich Workspace admitted bounded catch-up whenever any snapshot existed, even
current=false; the controller kept that old pin with no publication-driven repin.

Named main-owner ACK assigned native_enrollment_review isolated worktree
.worktrees/search-external-freshness, branch codex/search-external-freshness from
e696d420. Scoped7bb45a7c changes only controller/Search Workspace callback +3test
files. Require current&&snapshot, owned source/published fence notifications, full
pin/source status witness before fresh output, publication-driven repin and no
progress/idle churn; no polling/rescan/pump loop. Independent exact review closed
zero must-fix, independent7/7new cases; author63/63adjacent (zero skips), actual
Workspace old-callback controlledRED retained. Main composed asd5f7e53a; combined
63/63 and TS/native frontend build pass. Rust/crates unchanged, retain frozenR4
host. Bounded real external edit/create/rename/delete rerun awaits main's source
freeze/lane release; full representative success, main integration and install
still unproven. Native post-edit delay is a distinct ongoing coordinator finding;
no new Store edit assigned by this root, sample attribution read-only.

## R5 bounded external pass exposed bridge origin mismatch

Source d5f7e53a/frontend c47430f5 with frozenR4host: actual external in-place edit
passes exact bytes/stableID/advancedrevision +positive Search/currentgen4/source
1005; unknown-file create passes newID/currentgen5/source1006 and conservative
rescan witness. Their total observed latencies28.292s/26.413s remain substantial;
Search portions20.382s/18.005s are not all backend execution time. Rename physical
operation and native read at newpath/sameID pass, then changes_after returns
invalid_response and aborts host. Delete phase not reached.

Retained journal cursor1007 has documented Rust
ExternalObservation {observation_id:bb3fd199-c11e-4348-ba95-cb62c9c0dddd}, fullreload
true/entriesempty; JS decoder whitelist omitted that origin. Exact diagnosis:
tmp/startup-performance-20261028/r5-journal-origin-diagnosis.json. Native namespace
authoring was not the failure; bridge compatibility was. Main ACK assigned
maintenance_triggers rust-vault-service.cjs+framedtests in isolated
startup-external-origin fromd5. Final89a9648e accepts exact two-field origin with
existing validID check; unknown/malformed stillreject. Independent reviewclosed
zeroissues,14/14framedjournal tests inclrename/tombstone/subsequentstatus/normal
shutdown pass. Initial1s fixturetimeout retained; newtestdeadline5s only. Actual
Electron successor remains required.

R5 report after-search-freshness-r5-external is OVERALLFAILED:1001physical source
hashes/pathset exact, but6logical restoration checks fail on deadhost, andElectron
requiresSIGKILL after normalgrace/SIGTERM. external.restored=false and cleanup
errors retained. All84914runner85434/Electron85457/host85481 finallyabsent. Lane
released. Do not call this normalshutdown or logicalrestore proof.

Additional measured duplicate: principal runtime2216samples partition capture633,
publishedadmission362(includesbuilder237), other/stagebuilder172(actualPump167),
initialadmissionother179, finalrecheck152, other718. Within capture633,
presentation510 includes duplicate metadata352; these nested counts do not add.
Capture already validates visiblemetadata in one bulkread, thenpresentation
pointreads that same metadata twice/entry in same heldTx. Main ACK index owner
startup-presentation-reuse fromd5. Reviewed638b8bf3(testfirst)→f798b5c1 reuses
checked metadata via privatehelper; publicpointreader/freshpresentation lookup and
all size/time/folder/corruption checks unchanged. Actual trace(1bulk,8point)→(1,0),
legacy exactmanifest equality and11corruption cases await serializedCargo. No
crossrequest cache/retag redesign. Allcode reviewed; main integration/build/real
external recovery+all4probes/fullcampaign/install stillpending.

## Final R6 acceptance passed; integration and installation pending

Frozen runtime source: `869c5d20`; crates tree `a05376fb`, desktop tree `efe78686`,
src tree `644ea3c7`. Host SHA-256:
`a1c862be131b9dec4fa5be0cec8f02fe4f0f770ee99d083779680e5830e14d2a`.
Electron 44.9.1 is the same binary as the baseline; renderer index SHA starts
`c47430f5`. The source-matched host/CLI build passed in 1m32s. Combined checks:
55 index unit, 22 index integration, 6 presentation unit, 9 presentation integration,
15 native database, 14 framed journal tests, TypeScript and native frontend build.

The final report is `after-final-r6/report.json`, SHA-256
`c7ed2de820400b9ddf154a03b2a047f2337828f6f9e107741f38ec9c31a01bfa`.
Root independently checked its pass status, all three complete greetings, three
normal Electron exits (0, no signal), restoration, empty cleanup errors, and all
1,001 source hashes and paths. The source corpus exactly matches both before/after
witness sets in `before-representative-retry/report.json`. Failed runs are retained.

| Measurement | Baseline | Final R6 |
| --- | --- | --- |
| Restored 432,000-character editor paint | 14.872 / 13.690 s | 9.168 / 7.315 / 7.498 s |
| Normal note switches | 400; median 47.8 ms; p95 about 95 ms; max 9,766 ms | 600; median 32.2 ms; p95 35.4 ms; max 176.7 ms |
| Base opens | 6; median 363.5 ms; max 8,889 ms | 9; median 168.3 ms; range 156.4–456.8 ms |
| Clean checkpoint CAS writes | 626 per launch | 0 |
| Rescans during normal navigation | 2 / 3 per launch | 0 in all three launches |

The 195 normal runtime steps were all Observe, with no begin/pump/publish work.
During 35.019 seconds of healthy idle, there were 47 necessary journal reads and
zero rescans, runtime steps, document work or index operations; source 1014 stayed
unchanged. The explicit audit completed in 6.054 seconds with no issues. A cached
note click took 120.2 ms with actual audit overlap; this does not establish
uncached-read responsiveness during an audit.

Real external edit, create, rename and delete passed exact bytes, stable identity,
revision/path/absence checks, complete current Search and conservative fallback.
Five real source changes, including restoration, produced exactly five begins,
160 pumps and five publications: source 1014→1019, generation 12→17. There was
no unchanged publication. Rename/delete needed discovery plus continuation while
incomplete; these were genuine namespace changes, not idle rescans. Full logical
restoration passed, all original files matched, and all six owned app/native PIDs
were absent after normal close.

The preceding bounded `after-external-origin-r6` run repaired the failed R5 run's
logical state. Its early 11.23 s note and 9.95 s Base delays were real recovery
retry stalls, not steady-state timings. It passed restoration and normal exit;
the final campaign began with a healthy, current fixture.

Limits: native initialization still takes 5.28–6.20 s. Complete current Search
takes 17.0–24.4 s, and external phases take 21.5–34.2 s; those are not claimed fast.
Cold/recovery/structural-change audits remain necessary and may queue work.
Overflow has unit coverage, not a forced desktop event. No mobile, browser,
Tauri or exact Obsidian parity is claimed. The coordinator's separate post-edit
Base latency finding remains open.

Main integration and installation are requested under the standing authorization.
The latest reviewed profiler includes pagination fix `9a805db8`; import its latest
blob along with this ledger. Package, installation and installed-app evidence must
be appended before the thread goal is marked complete.


### Main delivery and staged smoke checkpoint — 2026-10-28

Confirmed startup/opening batch integrated on main at `6ff5bc4d`. The verified
package uses Electron 44.9.1, ASAR `feebce14b112813c66e636efab0955bde2fc5de0b9437d63f20c88dd52a47b06`
and embedded host `a1c862be131b9dec4fa5be0cec8f02fe4f0f770ee99d083779680e5830e14d2a`.
Self-contained staged smoke passed in the disposable `profile-installed-final`
profile with no host/dev/run-as-node overrides: 11 slash/focus/Properties/embed
checks, ordinary-note and Base save, restart persistence, exact durable note bytes
and preserved entry body. Both owned launches exited normally with code 0; all
owned staged executable/host PIDs are absent. Evidence:
`tmp/bases-edit-performance-20261028/staged-smoke-receipt.json`.
The initial restart oracle incorrectly expected raw Markdown in rendered DOM;
the corrected rendered-text observation retained exact durable-byte checks.

Installation is **pending**, not accepted: the existing default-profile app
rejected normal Quit with `User canceled (-128)`. Main PID 71549 and its helpers
remain. The startup coordinator is requesting normal user closure once; this
thread will not duplicate that question or force/discard the real session.
Both installed fallback and verified staged bundles remain untouched. After
normal closure, the remaining gates are atomic replacement, actual installed
isolated-profile smoke and old-bundle deletion after acceptance. Broader Base
post-edit latency and external-to-Search latency remain open as recorded above.
