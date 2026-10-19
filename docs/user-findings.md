# User findings queue

## S1 generated Base queries eagerly prepare the full graph — confirmed baseline limitation

`query_generation` prepares relationships even for a property-only query. Current
resolution charges/scans the namespace for each link. The frozen10k workload's
5,000 links and10,003 entries imply at least50,015,000 resolver work against the
normal2,000,000 query ceiling. Actual release execution now confirms all eight
queries reject preparation, after successful generation of10,003 records; timings
are rejection latency only, and the run is limited/incomplete. Evidence:
`/private/tmp/zorid-s1-generated-bases-release10000-ffaee3ad/generated-bases-report.json`.
The same generated tool passes all eight semantic oracles at100 notes; source and
binary hashes remain exact. Tool integrated `9235ab46`, not an engine optimization.

Keep the full linked fixture and existing limits. Later accepted S1.2 work can
address conservative dependency-aware graph preparation, indexed resolution and
bounded generation-keyed reuse, preserving tie/normalization semantics. No engine
optimization or budget change has been implemented here.

## S1 normal storage repeatedly validates metadata graph views — measured setup bottleneck

The first bounded normal-family10k baseline stops after32 passes with224 live
files admitted (inventory3030/unfinished), before indexing. Limits remain5s soft
per pass/30s hard per command; all10,003 physical source files and executable hashes
remain exact. Evidence:
`/private/tmp/zorid-s1-cli-family-release-d0de1c83-10000/report.json`.

One authorized1s setup sample attributes repeated work to
`family_materialization::candidate` → `check_retained_content` →
`MetadataState::metadata_view` during command preparation and commit. This is one
sample window, not a whole-run fraction. It differs from legacy import's full
SQL snapshot loading, so legacy partial-throughput gains are not desktop startup
speedup evidence. Owner `storage_recovery_impl` has isolated invocation-local
lazy immutable view reuse through `3b416f3b`; exact source review passes, including
valid-but-mismatched history and allocation rollback fixtures. Compiled tests and
runtime validation remain pending. Each validate/apply invocation
retains fresh graph/proof/head/CAS boundaries; no persistent authority cache. No
family-path optimization is integrated yet; no cache authority change is proposed.

## S1 native setup scales with repeated full-store work — two fixes integrated

The indexed unresolved-observation lookup is integrated through `2c53a98d`
(production `239e639e`, reviewed source `9d2d3704`). Scoped193 checks pass with one
existing ignored fixture; release build and normal-family100 source/query checks
pass. Same-cap legacy10k still stops during setup:3,383 entries in240.256s versus
the earlier2,378 in240.316s. Neither run reached indexing; no full-vault latency
or completion-speedup claim follows. All10,003 physical sources remain exact.
Evidence `/private/tmp/zorid-s1-cli-legacy-release-51060b1d-10000/report.json`.

One authorized1s setup sample now identifies repeated `Store::list` calls used to
find individual directory/file paths. `storage_sqlite_impl` prepared four
native selector replacements (`d0de1c83`) using existing indexed `read_path_metadata`
API, preserving selected-row validation, physical proofs, full recovery scans
and absence inventories. No new schema/cache/API is required. Independent source
review and35 focused native checks pass; release/runtime verification of this
follow-up passed and is integrated `56dd1de9`. Its same-cap legacy10k reached
6,167 entries in240.656s; still no index/query phase. Exact sources and binary
fences pass, all owned processes are gone. Evidence:
`/private/tmp/zorid-s1-cli-legacy-release-d0de1c83-10000/report.json`.
One87s setup sample now points to `apply_transaction_text` reloading the complete
metadata snapshot, especially N+1 metadata SQL reads. Audit full-loader efficiency
while preserving the complete transaction-current planner snapshot and all typed
checks; no subset planner or trusted disposable mutation cache is authorized.

The original incomplete setup evidence is retained at
`/private/tmp/zorid-s1-cli-legacy-release-80dfce28-10000/report.json`. Its global
observation scan motivated the first fix above; strict known12/13→14 migration,
typed proofs, retained history, replay and admission checks remain preserved.

## S1 baseline: imported binary coverage classification — open 2026-10-18

The first real 100-note CLI smoke also imports one PNG through public legacy
`init`/`rescan`. Its persisted index row is `Unreadable`: invalid UTF-8 is rejected
before binary exclusion classification. All 100 Markdown notes' expected literal
hits/ranges pass, but generation `coverageComplete=false` remains truthful in
`/private/tmp/zorid-s1-cli-smoke-c91106b2/report.json`. Do not omit the attachment
or relabel coverage to make the baseline pass. Record this profile separately from
normal desktop local-family admission; check the latter before choosing a fix.
Owner: S1.0 baseline investigation, then scoped shared classification correction
with source-mode/invalid-text cases if confirmed relevant. No production fix yet.

## Test scope and later E2EE group design — accepted 2026-10-18

User limits current runtime test targets to macOS and web; the independent CLI is
also a first-class macOS test target, including standalone operation and concurrent
Electron access. Windows/Linux/iOS/Android runtime checks are deferred, not passed.
Sync remains E2EE. Added S1A before S2 for a later discussion of sync-group
identity/membership, joining, leaving, key/data handling, pending edits and rejoin.
These policies are not selected by recording the stage; no one-day delivery or
immediate sync-design implementation is promised.

## S1 core-owned indexing lifecycle — accepted direction 2026-10-18

User requires multicore optimization on every platform where it improves measured
performance, persisted parse reuse through the caching interface, and shared-core
ownership of when semantic parsing/indexing runs. Platform clients subscribe and
refresh affected views; they must not duplicate invalidation/scheduling policy.
Keep CodeMirror's immediate interactive syntax state local. Unsaved semantic
analysis stays revision-tagged and separate from committed shared indexes.
The user accepts an engine-supported regex subset, clear unsupported-pattern
messages and equivalent rewrites only where meaning is preserved. Design and
implementation slices are updated; S0/S0A gates remain in force.

## CLI/editor conflict recognition — verified and integrated 2026-10-18

Main `0bbeb61b` preserves definite preflight conflict status across desktop IPC and
browser planning. Focused browser/retained-draft44 checks pass. Actual Electron/CLI
competition and host interruption/restart preserved both exact versions and saved
the retained draft through ordinary recovery-copy UI; evidence:
`/private/tmp/zorid-s0-concurrency-final-evidence/evidence.json`. Browser UI runtime
and seamless stale-editor merging are not claimed. Earlier failing evidence follows.

Reviewed actual concurrency harness on frozen `bf1feb0a` observed successful shared
cache/search, CLI competing commit, exact receipt replay and stale-CAS rejection.
The editor retained its exact draft but showed a generic save error with conflict
false instead of conflict/recovery actions within20s. Intentional host interruption
was not reached. Evidence:
`/private/tmp/zorid-s0-concurrency-bf1feb0a-evidence/evidence.json`.
All owned processes closed; source/artifact hashes unchanged. `storage_recovery_ui_impl`
owns isolated error-classification diagnosis and a deterministic regression before
any fix. No loss is established, and no user action is blamed.

## Candidate interrupted-rename recovery — reproduced fix integrated 2026-10-18

Main `0bbeb61b` adds exact-proof namespace responsibility succession (Store13) and
native recovery. Store105/1 ignored and namespace13 focused checks pass, including
restart windows, changed bytes and replaced parents. Original real vault remains
untouched and is not confirmed as the screenshot's historical cause. The synthetic
superseded-move failure is fixed; genuine competing evidence remains preserved.
Earlier read-only diagnosis follows.

Read-only inspection of the default recent vault found a captured, unpublished
namespace move whose destination was superseded by a later logical move. The
saved inode survives, while source, earlier target and current target are absent;
current target validation rejects the old recovery destination. Retries alone
cannot settle this candidate state. All 33 `.previous` files instead correspond
to completed attempts. One separate unresolved external observation remains.

Evidence: `/private/tmp/zorid-warning-candidate-mp5yzuln/metadata-summary.json`.
Inspection copied the database without opening SQLite or recovery in the original;
original metadata was unchanged. This is not confirmed as the screenshot's vault
or historical cause. `storage_recovery_impl` owns a synthetic regression and safe
recovery plan in isolation; `architecture_core_audit` reviews causal/identity proof
and preservation before any implementation. No cleanup or migration in the real
vault is authorized by this diagnosis. Root coordinates serialized validation.

Native window close and live-window AppKit quit passed on source `3eabc392`: exact
pending bytes were flushed and reopened, with normal no-signal exit and host drain.
Version history preview, explicit restore and restart persistence passed (22 runtime
checks): `/private/tmp/zorid-s0-live-appkit-evidence/evidence.json`. A separate
no-window shell did not exit after an AppKit request; that case remains open.

## Clipboard image transfer — fixed 2026-10-18

Integrated independently as main `a98cb04f`; main findings commit `81c2d47b`.
Concurrent attachment reads/paste upload collided with desktop command admission
(`binary_busy`) after files had committed. Complete-transfer FIFO preserves original
identity, caller inputs, cancellation and cleanup, while text writes stay responsive.
Independent core source review approved `fd87d9f0`; root 28 focused tests and desktop
TypeScript/build passed on main. No push performed.

Actual hidden Electron pass on composed source `bbf121ea`:
`/private/tmp/zorid-clipboard-final-verified/evidence.json`. Two exact PNG files and
saved embeds, unchanged seeds, four exact target acquisitions and 128×64 decoded
RGBA hashes passed in 4.544 seconds, without transfer errors. Test drives the actual
File/DataTransfer/ClipboardEvent path; it does not mutate the OS clipboard. Hidden
fixture eager/decode actions are explicit; no foreground lazy-loading parity claim.
CSP is unchanged. User reports the visible Playground has now been closed; it
was never targeted by automation. Its copied artifacts remain the older build.

Broader S0 hidden pass: `/private/tmp/zorid-s0-final-bbf121ea-evidence/evidence.json`.
Dirty renderer `window.close()` did not finish within fifteen seconds, while exact
edits subsequently autosaved. This does not establish OS-window-close/app-quit
failure. Subsequent native close, live-window normal quit and history checks passed as
recorded above; only no-window quit remains open. Root retains sole integration.
A prior clipboard poll observed temporary source-path absence during saving; it
later reappeared with exact bytes. Preserve this publication visibility limitation.

## Manual playground versus automated checks — 2026-10-18

User wants to keep playing with visible test apps. Automation uses its own hidden
app/profile/vault and exact-owned-PID cleanup. User-owned visible playground
PID66932 and isolated root `/private/tmp/zorid-manual-playground-dlko_ol6` are
excluded from automation cleanup. Pointer: `/private/tmp/zorid-current-manual-playground.json`.
The playground uses copied artifacts so ongoing builds do not replace its files.


## Dirty-close verification — 2026-10-18

The first dirty-close runtime pass contained fixture edits outside the harness,
so its timeout is inconclusive. It establishes neither a product defect nor a
passing dirty-close/normal-quit scenario. Retry with the exact-owned test app hidden
before editing, keeping pending-edit and precise close/quit witnesses.

## Large-file validation performance — 2026-10-18

Broader S0 verification exposed an overlong existing 17 MiB compound-stream
fixture (>8 minutes, stopped; not a pass). Owned process sampling showed repeated
immutable payload decoding/descriptor checks during manifest verification. The
large stdio stream case also reached its existing 60-second watchdog. Preserve
this as a Rust performance/validation follow-up; do not silently count these
stress scenarios as passing or weaken their content assertions.

## Automatic storage recovery — 2026-10-18

User authorizes S0 implementation and requires recovery to run automatically,
without technical details in product UI. Scoped implementation is in progress:
quiet bounded retry UI, checked SQLite, retained local snapshots, settled backup
retirement. Verification and remaining work are tracked separately in the
execution checkpoint; original user-vault warning cause is not yet reproduced.


## Confirmed query performance and browser persistence design — 2026-10-18

User confirmed the consolidated [S1 design](architecture/indexing-search-design.md):
shared Rust search/backlinks/Bases query capabilities, documented Obsidian language
semantics, persisted parse/search indexes, bounded memory Base/answer caches,
interactive-first adaptive parallel work, committed-source query freshness,
time-aware local/configured timezone refresh and marked partial first-build results.
Workload targets are 10,000 representative/100,000 stress notes, not speed promises.
S0 storage and S0A interfaces still come first; implementation is not started here.

Browser latest correction supersedes optional-only persistence statements below:
retain local working note data/indexes between visits and fetch incremental changes;
attachment bodies load on demand into bounded cache. Synced cache is refetchable;
unsent edits/receipts are protected pending data. Storage engine, exact offline/
reload and key-retention policies remain separate storage/browser design work.


## Maintained product roadmap — latest priority

**New interface milestone:** S0A follows S0 and gates S1/downstream feature work.
Review storage APIs during S0 design, then audit storage/indexing/caching contracts
against actual consumers: supported operations, scope, atomicity, statuses/errors,
subscriptions, cancellation/release and native/browser differences. The interface
review is planned, not certified by adding this documentation. See
[the review guide](architecture/interfaces.md). Existing stage IDs stay stable.


The [roadmap](roadmap.md) is the single high-level delivery order: **S0 storage,
saving and recovery is immediate**, then S0A modular interfaces before S1 Rust
indexing/search/cache performance,
then sync/managed foundations and complete desktop Bases/Tasks/Calendar/Google,
then hosted/web and native iOS. One milestone implements at a time with explicit
integrated exit evidence. This is planning, not new implementation acceptance.
Historical ownership and scope evidence below remain preserved.

Browser product flow: web.zorid.app offers Zorid Cloud login or self-hosted service
connection, then authorized sync-group selection/unlock and shared feature views.
After leaving, optional cache can remain. Returning revalidates cache and catches
up. Pending unsent edits are not disposable cache. Browser persistent-vault parity
is not required; close/reload/offline and credential-retention policies remain open.


## Current user steering — 2026-10-18

**Browser role correction:** browser joins existing sync groups; it is not expected
to own a persistent local vault like desktop/mobile. This supersedes the mandatory
browser SQLite/OPFS direction. Local working state/cache is allowed; persistence,
offline/reload and pending-edit policy remain to be designed. Current standalone
IndexedDB code is unchanged by this documentation correction. Native SQLite and
app-local per-vault cache/recovery placement remain accepted.

- **Sequence:** saving/recovery bug fixes and Rust indexing/search/cache performance
  first; then fully usable desktop Bases, Tasks, Calendar and Google integration;
  resume iOS implementation afterward. Preserve paused work. This supersedes older
  parallel mobile delivery requests below.
- **Open saving findings:** persistent import/reconciliation attention banner and
  accumulating `.previous` artifacts. Source mechanism inspected; actual vault cause,
  safe cleanup and changed save strategy remain unimplemented/unverified.
- **Accepted architecture:** shared native SQLite infrastructure; native authority
  stays in the vault and per-vault cache/recovery SQLite goes in app-local storage.
  Browser joins existing sync groups; SQLite/OPFS is optional, not a persistence
  gate. Current browser backend remains IndexedDB. Native snapshots follow the
  inspected Obsidian local retention behavior; they are not rebuildable caches
  and not synced history.
- **Documentation:** maintain platform-first [architecture modules](architecture/README.md)
  with current/target distinctions. This documentation task does not implement the
  storage migration, performance work or Google integration.

This queue supplements the full parity ledger. It records recent user steering;
older requirements remain in `parity.md` and `interaction-parity.md`. Implementation
and verification are separate. Work is sequenced by dependencies and user impact,
not by message arrival order. The user may keep sending findings without ordering
them or interrupting the current work.

| Finding / requested behavior | Current state | Next evidence or work |
| --- | --- | --- |
| Present recoverable storage errors in ordinary language | Actual Tasks15ff interruption screenshot shows raw remote IPC method/operation-ID instructions in the global toast, while the Tasks view correctly retains its unconfirmed capture. Root and managed lead independently observed the screenshot | Follow up with a human-facing error summary and actionable retry/recovery choices; retain technical detail for diagnostics. Do not alter frozen Tasks proof or treat this presentation issue as data-loss evidence |
| Keep selected-tab previous/current/forward pages ready; history belongs separately to each tab | Native relay msg_d1ae1ee1810c confirms the user requires two actual editor views visible during interactive swipe within one initialized WK runtime, each retaining document/cursor/scroll/undo. Snapshots do not satisfy live-editor behavior. Current staged navigation channel does not yet implement adjacent live rendering | Latest user supersession msg_f2da5c302596: one retained WebView owns document tabs/history/route commit; native owns physical host/chrome/gesture input. TS371 owns router/window, editor owner input fencing, native lead retained shell. Old native-authoritative ddbc83a7 is reference only and never compiled. Preserve bounded global warm budget, one active writer, durable quiesce, fresh authority/revision checks, fenced parked callbacks and safe eviction. Actual live transition commit/cancel and independent view-state/undo proof remain required; do not multiply vault/index/bridge initialization |
| Tabs belong only to the current vault, restoring separately per vault | Direct phone finding relayed by native owner;2f owns model/metadata partition and pending-ticket encoding in isolation | Native owner owns context/coordinator/factory integration. Use trusted vault identity; retain original pending operation/tab recovery without manufacturing a new slot |
| Home create button must work | Dev10 button has no creation callback; user reports it nonfunctional | Route via current-vault Pages and the same guarded New Note path, or choose/create vault if absent. Do not build a second create engine or rotate uncertain operation IDs |
| Loading uses skeletons, without loading words or technical details | Direct user steering relayed from phone session | Native owner owns Pages/Mobile presentation changes; keep actionable human error/retry. Caching/module overlap remains measured followup, with no recovery or authority bypass |
| Mobile Files header shortcut and history arrow necessity | User questions relayed by native owner; UX decision queued | Avoid redundant shortcut if a clear accessible parent/back alternative exists; retain discoverable accessible history controls while gestures are incomplete |
| Mobile link taps open the link without moving the caret | User finding relayed by native owner; stage4_contract_review owns source-only pointer/default-selection and mobile bridge audit | Name smallest edit seam after diagnosis; preserve desktop modifiers, IME and real navigation. Verify actual native tap and selection, beyond URL callback tests |
| Native route edge swipes | Requested via native owner; not implemented. Buttons/history composition precedes gestures | Reuse guarded root traversal after transition verification; no additional host or separate navigation engine |
| Native New Note must be usable, including occupied-name retry | Corrected b46a2e3e Simulator19 passes direct-create chrome, save/exact Rust file bytes, Back and loaded-editor reopen. Dev19 signing/install/launch succeeds on physical iPhone and app is left open; phone interaction itself is unverified. Canonical native source3cfff3f7 and JS successor24c4ec40 preserve Tasks; combined299Node/fullTS pass | In-flight create interruption/recovery remains unproved; bounded procedure prepared, not executed. Busy-skeleton polish3bd246bb remains separate from frozen Dev19/warm20. Unknown commit retains exact request/original tab; no replacement IDs. See native-main-integration-preparation.md |
| Implement managed data, Bases, Tasks and Calendar plan | New lead reports direct user authorization and active thread goal; durable plan in managed-data-tasks-calendar-plan.md. Coordinated Phase0/1 new-file contracts/Yrs feasibility starts independently of mobile shell work | Root retains main/heavy scheduling. Assign existing storage/protocol/domain seams before edits; old checkbox/tag task candidates remain superseded. Desktop and native UI delivery are explicit later acceptance stages, not fulfilled by backend fixtures |
| Preserve native editor back/forward history with root-owned tabs | Configured factory bypasses legacy Pages constructor that wires history; existing editor onNavigate and availability APIs can be reused. Native route-history proposal recorded, not implemented | Complete composed Swift typing first, then assign scoped existing history extraction and root traversal. Commit cursor only after validated target activation; retain source on failed close, exact retirement on actual close, no legacy pop fallback. Disabled arrows do not establish completed history support |
| Start Stage4 and native mobile in parallel (2026-10-17) | New shared-semantics goal active; Markdown/Base/index contracts and shared corpus preparation assigned in isolated Orca worktrees. Separate native-mobile owner acknowledged through run_3e72b2c9ab72 | Mobile shell/storage/editor can proceed before semantic APIs land; no duplicated Swift/Kotlin document engine. Root owns main integration/shared seams; heavy builds serialized. Implementation/parity remains to prove |
| Persist future improvements, including parallel indexing and P2P | Recorded in `docs/future-improvements.md`; P2P is deferred from this pass, and parallel indexing/scanning is a proposal using the shared Rust core on all clients | Preserve bounded workers, revision checks and complete-inventory deletion gates. JavaScript browser workers host Rust/WASM rather than duplicate indexing logic. Later roadmap milestones remain scheduled |
| Skip P2P in this implementation pass | User explicitly defers P2P; current pass focuses on server-backed E2EE sync | P2P is not an acceptance gate for this pass. Keep later consideration recorded. Server push/live editor updates are separate from the current unary gRPC migration |
| Use gRPC where it simplifies remote sync | Main4d3c12d actual Electron verification UI/private IPC/host RPC2, fresh normalized-v7 browser and independent CLI survive a real relay outage with independent edits, then converge to85 exact bytes; pending counts0 and browser complete. Earlier large-file/restore/isolation/version gates pass | Changed-path runtime gates and actual native composition smoke pass. No normal-editor sync controls or production enrollment claim; reconstructed observation/report limitations are recorded in browser-relay-verification.md |
| Adopt protobuf for streaming and reducing serialization work | Generated Rust/TS schemas, desktop binary frames and remote RPC2 are integrated main293df57 and pass actual host/browser/CLI checks | Plaintext mapping3dbcac1 remains a proposal; preserve exact bytes/hash/AAD semantics. Markdown/settings/CLI JSON stay readable; native local bindings remain platform-specific |
| Larger ordinary Text rejected by whole-document diff | Reviewed bounded-diff fix integrated4a48a79;39 client-sync tests pass. Actual standaloneCLI wrote/read41,800-byte Unicode note; rebuilt defaultElectron opened and saved41,819-byte note, physical/independentCLI bytes exact | See native-progress-verification.md. WASM larger-note runtime proof remains. Coarse middle fallback has less precise overlap merging; this does not implement deferred stale-editor auto merge or raise256KiB limit |
| Binary create must never become overwrite after peer creation | Explicit adapter.createBinary and Create intent integratedf62cd3e after39focused Node checks/typecheck/independent review; no upsert fallback | Unsupported legacy/mobile adapters reject clearly until implemented. Streaming Create must preserve the same absence semantics |
| Normal browser startup fails despite production build success | Fixed production worker rewriting integrated7bebe51. Normal default Rust browser startup/save/reload, nested create/rename/trash, competing-tab recovery/copy reload and duplicate fencing pass actual UI | See browser-normal-verification.md and current browser-relay-verification.md. Actual normalized-v7 binary import now passes; native actual IME passes separately. Forced browser-process crash and broader input-method coverage are not implied |
| Complete standalone headless vault access | Independent CLI embeds its own Rust core; search and foreground watch/rescan/sync pass. Current staged16MiB+17 stdin/file/raw/base64/retry process check, exact browser17MiB+17 receipt, namespace lifecycle and encrypted restore pass | Keep documented Text/Binary/file-size bounds explicit; production enrollment remains fixture-only. Stage4 retains indexed Markdown semantics. Legacy synced:false is no global barrier, not failed verified transfer |
| Seamless merging of stale editor drafts — defer until after all stages (2026-10-17) | User explicitly schedules this after stages1–6. Existing Yrs replication merges remain; local stale editor save retains its draft and offers recovery copy | Later bridge must derive user edit delta from original causal baseline, merge via existing Yrs, preserve active typing/undo/IME/selection and interruption recovery. Do not silently update CAS revision and overwrite latest text |
| Compound external folder move, edit and child deletion | Native fix integrated10479ea with fatal routing2cceb6e;51 focused regressions pass. Rebuilt independentCLI reconciles actual fixture with stable IDs, exact edits and deleted child; restart/rescan quiet. Follow-on >256directory progress integrated77bb43f after actualCLI+defaultElectron proof | See native-progress-verification.md and /private/tmp/zorid-compound-reconciliation-1017.json. Original CLI note/recovery bytes preserved. Large binary streaming remains separate pending work |
| Plan new-device joining with QR or copyable invitation (2026-10-17) | User requests a join plan and timing; recommendation is plan now, implement after current default-core/recovery integration | Roadmap device-joining section records QR/code shared flow, separate authorization/key access, resumable bootstrap, populated-vault reconciliation without destructive time winners; cryptographic/API details remain to design. Current sync enrollment is fixture-only |
| Improve Unable to open workspace screen (2026-10-17) | Current main4d3c12d normal default Electron reopens after verified app/host SIGKILL with exact54-byte retained draft, despite a competing53-byte CLI commit. Save recovery copy and independent physical/checkpoint reads preserve both versions and leave a clean checkpoint | Changed-path retained-draft recovery is verified; see native-progress-verification.md and tmp/shared-core-final-1017/crash-observation.json. This does not claim every workspace failure screen or editor surface is verified |
| Make Rust core the default (2026-10-17) | Rust is the main default for desktop and normal browser. Actual normal startup/save/reload works without credentials/backend; current native crash recovery and browser competing-tab recovery copy pass | Actual native undo/selection/Zhuyin composition/redo/restart pass; test apps closed. Keep local vault operation independent of credentials/backend; no mobile default or production enrollment claim |
| New file works, but rename fails (user reported 2026-10-17; subsequently confirms working) | User now confirms rename works. Full command candidate 4883a3b + 57ada91 passed focused checks, reviews and TypeScript/webpack build; matching native candidate 9c61837 passed its bounded checks | Root verified the actual window loads desktop-file-commands/dist/index.html and opened the fresh lockfixed fixture. Automated title/menu rename proof was interrupted; user confirmation is recorded separately. Integrate reviewed batch and retain restart/sync verification gaps |
| Later desktop edits must stay in Rust authority | POSIX lock fix is integrated. Current default Rust desktop saves match independent CLI while the host remains open; actual Store11 app/host crash, subsequent competing CLI write, normal reopen and recovery copy preserve exact draft/original bytes | Cross-process authority and current crash recovery evidence now pass. Preserve no-loss retained-draft semantics; automatic stale-editor merging remains deferred |
| New note button fails in Rust-backed desktop vault (user screenshot, 2026-10-17) | Actual user reports `zorid:write` / `Core vault fixture operation failed` while creating a file; existing-note integration does not cover ordinary create | Implemented in isolated candidate a29605b; actual rebuilt New note created Untitled.md, saved exact40 bytes, CLI uploaded and browser read identical bytes. Normal quit exited0. Integrated on main5d29c53; see browser-relay-verification.md |
| Discuss WebSocket/WebRTC transport | Current transfer is HTTP; proposed next step is WebSocket wake notifications with HTTP encrypted transfer, then WebRTC for P2P | Discussion only; no transport migration approved or implemented. Persistent sync must retain reconnect catch-up and durable acknowledgment independently of transport |
| Check LiveSync deletion behavior and apply relevant lessons | Rechecked deletion implementation, watcher reflection, conflict and GC specifications against pinned upstream sources; Zorid causal Delete/Recovery/Restore core inspected | Logical tombstones must survive offline peers; stale watcher events and lookup errors cannot authorize deletion. Preserve unseen concurrent edits and observed folder membership. Native physical deletion, recoverable UI and retention remain incomplete; quiet recovery UX is a recommendation, not implemented |
| Prioritize a usable complete build over production-grade testing | Latest explicit user direction: implement everything fast so the user can use it | Combine integration gates: compile/build, short real editing/sync smoke, and targeted data-loss/security regressions. Defer exhaustive compatibility, stress testing and repeated independent validation; do not add tests for low-impact reversible changes. Report remaining gaps without holding usable work for production readiness |
| Speed development; the app has no users yet | User explicitly authorizes pre-release development assumptions | Simplify unreleased schemas/protocols and use fresh disposable fixtures instead of unnecessary legacy migrations/rollout layers. Preserve sync correctness, data-loss/crash checks and real vaults; no silent scope reduction |
| Systematically examine edge cases already solved by Obsidian LiveSync | User explicitly requests learning from upstream fixes, not just its high-level design; source/test/changelog audit assigned | Maintain a pinned-source matrix linking each relevant scenario and invariant to an exact Zorid regression test or unresolved gap. Include interruption/retry, offline rejoin, stale delete/edit, moves, missing chunks, migrations and recovery. State inspected scope; do not claim exhaustive coverage without evidence |
| Use Etebase and Obsidian LiveSync as implementation references | User explicitly accepted selective reference/reuse into our Rust architecture and reaffirmed LiveSync alongside Etebase | Track pinned source provenance, licenses and transferable tests. Reuse suitable components; do not infer wholesale backend adoption or protocol compatibility. Etebase informs encrypted account/key/storage patterns; LiveSync informs vault reconciliation, recovery and P2P |
| Evaluate existing sync/E2EE infrastructure before expanding custom protocols | User explicitly requested Etebase evaluation. Independent source audits assigned; current Yrs and RustCrypto reuse verified from manifests | Compare native/browser/CLI support, CRDT update transport, durable retry/cursor semantics, key enrollment/recovery/revocation, encrypted history and complete server backup/restore. No adoption or migration decision yet |
| Prioritize the best Zorid UX; Obsidian is a starting point, not an exact parity requirement | Directly confirmed by user on 2026-10-16; shared instructions and execution checkpoint updated | Apply to subsequent design/review decisions; retain capability requests and correctness, accessibility, data integrity and native verification gates |
| Packaged Electron runtime security update | Dependency audit found all 36 GitHub alerts concern shipped Electron 31.6.0; Promise-returning preload bridge matches one conditional advisory prerequisite, with no exploit demonstrated | User preference requested for supported macOS minimum before runtime/lockfile upgrade; revalidate packaging, native editor and supported OS claims |
| Embed controls need type-specific placement and behavior | Packaged-reference per-type matrix committed in `c211dcc`; audio correction integrated | Implement distinct image, note, PDF/Bases, video and Canvas control policies; native behavior and exact appearance require separate checks |
| Audio embed looks unlike Obsidian: source button overlaps player controls and spacing looks excessive | `3a46189` removes the audio-only overlay and generic padding; 33 focused tests and native Play/Pause through 0:02 pass | Native screenshot capture is clipped; exact pixel comparison remains unverified |
| Use AGPLv3 for Zorid | User selected AGPLv3; `64a7eea` applies `AGPL-3.0-only` to LICENSE, package metadata and README, with no plugin exception | Preserve dependency notices and matching corresponding source in releases; plugin licensing remains a separate discussion |
| Public repository without leaking notes or credentials | Reachable-history provenance and credential audits found no confirmed private vaults or credentials; `90eeee6` sanitizes current documentation paths and adds artifact ignores | Historical home paths and Git identities remain; delta-scan release additions before publication |
| Tag-only signed macOS builds, drag-to-Applications DMG and Homebrew | Reviewed configuration integrated; source and tap public; six signing secrets uploaded with explicit approval. Unsigned arm64 app/DMG passed exact 328-file inventory, Applications shortcut and packaged native audio smoke | No release/tag created; signed/notarized builds and Intel remain unverified. Electron runtime update required before release; other platforms discussion-only |
| Standalone WAV opens “No viewer is available” | Fixed routing and sizing integrated; native controls, Play/Pause and playback through 0:02 verified | Broader codecs and native media menus remain |
| Still cannot type in Canvas or add embedded documents | Linked-note editor and text-card/insertion batch integrated; 1,573 tests pass. Native linked-note typing/save/undo and Add note/media file-node persistence verified | Native new-text-card typing and attachment playback remain unverified; rich-card accessibility repair and full text-card host services are under integration |
| No dash before task checkboxes; black bullets 25% larger with no visible underlying hyphen | Implemented; native screenshot confirms correction | Retain selection, source-reveal and theme coverage |
| Remove “No file is open” from new tabs | Removed in source (`4aa0fc9`) | Verify next built desktop checkpoint |
| Table right-click menus match reference, including delete row/column | Single-cell Row/Column/sort menus implemented and observed natively; active-cell formatting and popup focus fixes in progress | Complete active/selected-cell states, action verification and reference comparison |
| Whole row/column and multiple-row/column selection | Reference audit and implementation assigned | Implement handles/ranges, clipboard, keyboard and selection-dependent menus |
| Context menus match across all applicable elements | Parallel audits and modules assigned for workspace, properties, images/attachments, PDF, Canvas and links | Integrate and verify each surface and conditional action |
| Toolbar context menu opens far away from its trigger | Missing toolbar anchor identified; host repair assigned | Anchor to button bounds and verify native placement, window movement and zoom |
| Top-left chrome and file toolbar match reference; use a maintained prebuilt icon set | Dedicated icon and chrome layout worker assigned | Replace hand-drawn icons, match ordering, sizes and spacing; compare native screenshots |
| Sidebar open/collapse controls stay at the outer edge in the top tab bar, both open and closed | Integrated; native open/closed checks found and fixed duplicate legacy controls (`cb7a718`) | Verify split/tab-overflow geometry and exact reference placement |
| Empty top-bar areas drag the window; double-click expands it; tabs/buttons retain their own interactions | Chrome worker coordinating with native window owner | Implement platform window behavior and verify drag, double-click, and interactive exclusions |
| Right-click empty space in the left file list matches Obsidian's background menu | Integrated; native background menu showed New note, New folder, New canvas in order and New note created a file | Inline folder integration and broader conditional/reference checks remain |
| New-folder creation UX and dragging items in the file tree match Obsidian | Host integrated; native creation Enter/Escape and folder-click/F2 verified after focus repair | Native drag thresholds, hover/destination feedback, multi-selection and move outcomes remain |
| Math rendering matches Obsidian in Reading and Live Edit | MathJax 4.1.3 integrated; native inline/display formulas and nested Reading callout math/code verified; renderer lifecycle tests pass | Broader editing/IME, nested structures, geometry, performance and exact reference comparison remain |
| Clean Zorid plugin API; Obsidian plugin compatibility no longer required | User changed direction, then explicitly requested discussion before API design changes; registry work paused with no files changed | Discuss capabilities, lifecycle, extension surfaces and trust model before implementing a new API |
| Plugins register contributions at app-owned extension points, such as a bar action that opens the plugin's WebView | User proposed this UI model during discussion on 2026-10-16; not implemented or verified | Discuss host-owned action placement and presentation, plugin view isolation/lifecycle, and access to app-managed data; no API implementation approved yet |
| App-managed syncable plugin data and secret storage | Requested for architecture discussion; not implemented | Agree on data scope, conflict semantics, schema evolution, recovery and secret access/sync policy; no API redesign yet |
| Device-specific local data store alongside synced plugin data | User clarified that local device data is disposable and regenerable from durable plugin configuration, local documents and state; excluded from sync | Design derived-state storage, invalidation and rebuilding; do not place unique user content, unsynced edits or required credentials in this store |
| Sync ordinary Markdown/attachment files and structured plugin records through the Rust core | User accepted the proposed storage separation and requested sync design discussion | Discuss revision tracking, file reconciliation/renames/deletions, text and binary conflicts, record merge policies, durable outgoing changes, and server responsibilities before API implementation |
| Evaluate Yjs/Yrs and Self-hosted LiveSync as sync architecture references | User explicitly permits applicable critical LiveSync logic; pinned source audit and native/Node Yjs/Yrs fixtures completed on isolated core branch | Preserve stale-delete rechecks, projection provenance, durable ACK separation and retained-history GC invariants; actual browser/core sync and editor integration remain unverified |
| Sync should feel seamless, including setup and automatic conflict merging | User explicitly prioritizes effortless setup, automatic merging, and no routine conflict notifications; interrupt only for severe failures requiring attention | Design automatic retry/recovery, deterministic merge policies, retained recoverable versions and unobtrusive status; discuss default hosting/onboarding and distinguish saved locally from synced without routine prompts; implementation pending |
| P2P live sync alongside server-backed sync | User explicitly requests P2P live sync; implementation pending | Share document identity, merge and encryption semantics across transports; distinguish peer delivery from server persistence/backup, and address discovery, authentication, relay fallback and mobile lifecycle |
| Management web UI for the Rust backend | User asks whether Rust permits this; architecture discussion only | Rust can serve a browser frontend and authenticated management APIs; propose account/device/access, storage and backup administration while preserving content E2EE |
| Versioned shared sync protocol without requiring Protobuf | Rust protocol and required encrypted text/files family versions implemented on isolated core; boundary and authenticated decoding checks passed in workspace run34798 | Preserve separate transport/document/database versions; actual mixed-version client integration remains required |
| Assess implementation readiness and define the delivery plan | Implementation underway with two native/CLI batches on main and reviewed browser/desktop/backend candidates; active goal and current roadmap checkpoint track evidence | Finish coherent durable editor saves, atomic sync ingestion, actual web/Electron/CLI convergence and encrypted restore; later P2P/admin/mobile remain required |
| Durable coordination across context resets and concurrent editor integration | User requests written tracking and built-in goal; first shared-core milestone goal activated, execution ledger and integration rules recorded | Re-read checkpoint on resume; track owners/worktrees/commits/evidence separately; isolate core work and agree a single main-integration queue or common lock with the editor coordinator before core commits land; user transferred main integration to this core coordinator; editor relinquished at 2592ebb; heavy builds remain serialized |
| First sync clients are the web app and Electron desktop app | Web host/provider/Vault seams and explicit fixture/build wiring integrated on main `c369571`; candidate passed 2005 tests and actual Chrome host27/WASM6 checks, plus app save/reload/second-client read. Desktop host/native text-sync foundation is integrated in `6b450d7`/`13214dd` with 202 Rust, 6 protocol and 46 CJS passes; ordinary app selection remains pending | Durable checkpoint consumer (editor ownership currently paused in its session) and current authority/entry identity bindings must pass actual browser and Electron restart/peer-writer tests before activation; end-to-end sync remains incomplete |
| CLI for full headless vault access by agents | Standalone CLI embeds NativeVault; local files, folder creation and bounded rescans integrated on mainaada3b0 with 13 CLI checks within 109 combined passes; no daemon/IPC dependency | Native CLI text-sync fixture is now integrated and tested with offline independent processes; complete full-vault namespace/binary sync, moves/deletes and larger-file streaming. Retain machine-readable results, revision checks, exact bytes and concurrent desktop/process safety |
| Select a concrete sync stack and decide whether to build a Zorid backend | Axum/SQLite ciphertext relay, protocol and crypto integrated on main at `04bf12b`; main-based candidate passed 28 affected checks and 8 no-default crypto checks, including managed backup/restore | Finish atomic client ingestion and real app transports; hosted enrollment, management UI, deployment and complete recovery remain incomplete |
| End-to-end encrypted sync with version history and automatic backups | E2EE primitives and retained encrypted relay updates implemented; basic managed snapshot/restore checks pass on isolated core, including accounts/permissions and revoked restored credentials | Complete actual client restore, key recovery, history UX, backup scheduling/off-host retention and cross-client encrypted convergence; no deployment or complete product claim |
| Support both an official hosted service and an open self-hostable backend | User accepted the dual-deployment direction and explicitly notes hosted service must handle multiple users; implementation pending | Design one backend/protocol with account/device/vault authorization and user isolation in both modes, independent self-hosted identity, optional hosted billing/operations, E2EE/history/backups and migration portability; no deployment requested |
| Prefer a lighter backend database if PostgreSQL is unnecessary | SQLite backend schema, transaction authorization and managed consistent snapshots are integrated and tested as local fixtures | Finish client integration and deployment design; retain a migration path if hosted concurrency/availability needs exceed that model |
| Back up all recovery-critical server state, including accounts and permissions | Managed SQLite backup/restore implemented and tested on isolated core, preserving accounts/permissions/ciphertext while rotating epoch and revoking restored tokens; crash/publication tests pass | Add scheduling, off-host retention, operational config/secret recovery and real client restore; device-local-only data must not be uploaded implicitly |
| Review remaining architecture decisions before implementation | User requested architecture gap review; independent data and mobile boundary reviews completed, recommendations only | Resolve document/CRDT/file authority and durable save contract; encrypted checkpoints, retention and long-offline rejoin; key recovery and revocation-safe restore; schema evolution; enforced plugin isolation; versioned native/editor bridge and lifecycle. Validate a bounded end-to-end prototype before broad migration |
| Document ownership and sync granularity | User accepted Rust coordinating durable state and external file imports, followed by per-note CRDTs with stable IDs, associated path/deletion metadata, separate attachment blobs and bounded plugin-record grouping | Detail save/recovery and metadata semantics; decide plugin document grouping without exposing storage partitioning as a plugin responsibility; implementation pending |
| Define plugin data versus local data | User corrected the definition: plugin data is non-disposable configuration such as connection strings, colors and settings; local device data is disposable derived state | Preserve/sync/back up durable configuration; regenerate local derived data as needed. Distinguish secret-bearing configuration for secure handling without treating it as disposable; any additional durable plugin-content category needs discussion |
| Secret-bearing plugin configuration uses secret storage | User explicitly agreed that credentials in connection settings belong in protected secret storage | Define per-plugin secret access, device storage, explicit E2EE sync/backup and key recovery policies; secret storage acceptance does not decide whether credentials roam across devices |
| Prioritize a tight-knit first-party experience and show the overall architecture | Latest user steering pulls back from designing for hypothetical plugins; architecture discussion only | Focus on app shells, shared Rust core, local storage, encrypted sync and recovery; speculative extension frameworks are deferred, with no implementation requested |
| Encourage plugins to represent unique user-created content as vault files | Earlier discussion direction; detailed custom document framework deferred by latest scope correction | Revisit only when an actual feature requires it |
| Use Excalidraw as a concrete plugin architecture example | Hypothetical discussion now deferred by latest scope correction; no implementation requested | Do not let this example drive the current architecture |
| Consider JSONL for structured plugin document files | Hypothetical format discussion now deferred; no format selected | Revisit only for a concrete product requirement |
| Share Markdown metadata, indexes and Bases semantics in Rust | User accepted Rust property/tag/heading/link/task extraction, indexes/backlink/search queries, and Base definitions/formula/filter/sort/group evaluation. Added as next milestone wave4 in `shared-document-semantics-plan.md` | Prepare contracts/behavior fixtures alongside current wave3; begin implementation after real web/Electron/CLI storage/sync/recovery acceptance. Keep editor syntax/rendering in TypeScript; verify native/WASM/headless equivalence and rebuildable local indexes |
| Cross-platform Rust core for shared data services | Portable contracts and native SQLite/CLI foundation integrated on main; WASM/browser and sync components implemented separately with 201 combined Rust passes at b510194 | Complete app storage/receipt/checkpoint integration and atomic remote ingestion, then verify actual web/Electron/CLI behavior; mobile bindings remain later work |
| Native-owned mobile shell embedding the shared web editor, with plugin web screens behind registered actions | User explicitly chose this architectural direction on 2026-10-16 and requested further discussion; existing Capacitor scaffold remains | Discuss native navigation/lifecycle ownership, editor-host contract, app-managed data, and plugin views; framework/bridge choice and implementation are not yet approved |
| Mobile should feel very native; assess whether Capacitor plus native views is sufficient | User explicitly prioritizes native feel and is reconsidering whether a runtime replacement is necessary; discussion only | Compare native navigation/screens around the shared editor while retaining Capacitor against a custom host; assess keyboard, gestures, accessibility, lifecycle and measured performance before committing |
| Separate sessions/worktrees for plugins, sync/data and mobile | Readiness assessed: isolated research/prototypes possible, shared contracts not stable | Coordinate owners and contracts; discussion does not authorize independent public API redesign |
| Verify audio playback in the new isolated editor integration fixture | Candidate `6b96d1f` exposed Loading/Unable to play media accessibility labels; correction `a68cf0b` establishes that these labels alone do not prove failure or success | Controlled playback/media.error observation remains required; no speculative media fix from accessibility text alone |
| Local audio embed fails in packaged Electron | Fixed in `02f3421`; native Reading playback switched Play/Pause and advanced to 0:02, Live Edit retained controls | Other codecs, video, native menus and mobile playback still need verification |
| Deleting apparent blank line above audio makes player disappear | Native reproduction: underlying embed Markdown remains, but joins preceding heading; player loses normal controls/layout | Fix source-row/caret geometry and inline embed sizing; verify real blank-line deletion separately and retain playback/source |
| Canvas undo disappears after saving card text | Fixed in `c656637`; native Cmd+Z and toolbar Redo restored expected content, verified in actual Canvas file | Broader Canvas selection/drag/history and cross-pane cases remain in verification queue |
| Show file type in file tree only for types Zorid does not recognize | Implemented `13b11a1`; native tree hides `.md`/`.wav`/`.canvas` labels and retains `.unknown`/`.constructor`, with full-path accessible names | Other recognized suffixes covered by focused tests; direct viewers remain separately tracked |
| File click followed by F2 loses explorer rename focus | Repair integrated; native WAV file click followed by F2 opened inline rename with full filename selected; Escape cancelled | Broader navigation and focus-race cases remain |
| PDF embed appearance matches Obsidian | Native rendering/search/page-targeted Live Edit embedding verified; specific styling under implementation | Compact toolbar, sizing, border/background/spacing and Reading/Live Edit comparison |
| Clicking `</>` on an embed reveals its source while keeping rendered content visible | Integrated; native audio source reveal retained rendered controls | Verify selection geometry and source editing across all embed types, including the line-join layout defect above |
| Obsidian-style `[[` links and suggestions | Typography/spacing correction integrated; native popup rendered file rows and heading/block/display footer | Exact reference pixel comparison, placement edge cases and full result varieties remain required |
| Split views, including nested horizontal/vertical arrangements | Host integration and automated state/history tests pass | Native split, resize and restore checks; remaining docking/selection behavior |
| Drag tabs to pane edges to split; drag out to a new window | Focused reference audit and reusable drag controller assigned | Preserve dirty buffers, editor history, caret and tab identity across moves and windows |
| ⌘1–⌘9 selects tabs; ⌘T new tab; ⌘N new file; ⇧⌘N new Zorid window | Shortcut contract assigned to workspace keymap worker | Verify active-pane order, modifiers, focused inputs and native window lifecycle |
| Canvas appearance matches Obsidian exactly | Rich text-card Markdown integrated and natively rendered; own-save undo repaired; linked-note cards still incomplete | Linked content/editing, floating controls, connections, selection, typography and exact native comparison |
| Type directly inside Canvas cards, including linked note cards | User screenshot shows a selected note card with body content; current linked file cards are placeholders and text cards use a textarea | Render linked notes and reuse the shared live editor in-card; save to original note with conflict protection, preserve Canvas selection/scroll/drag and verify natively |
| Click blank note space to start typing, including empty/property-only notes | Reference sizing and focus behavior audited; focused repair assigned | Preserve property/title/embed interactions and verify native blank-space clicks |
| Enter after a new filename should focus the note body | Async rename/rerender focus race identified; repair assigned with blank-note focus | Wait for successful rename and focus the current editor; preserve newer user focus intent |
| Opening an existing file should not expose the first line's Markdown automatically | New inline renderer reveals syntax only for focused editor selections; opening-focus audit assigned | Verify sidebar open separately from intentional title-Enter and body clicks in next native build |
| Obsidian-style launch page and vault selection | Existing basic chooser; full launch/create/open/recent-vault flows queued | Audit reference flows and implement after higher-priority editor dependencies |
| Launch should reuse the previously open vault and workspace | Native relaunch restored the saved test vault, both tabs and contents; unavailable previous folder falls back to chooser | Complete broader startup/multiple-vault lifecycle reference comparison |
| Close agent-launched Electron after testing on the 8 GB MacBook Air | Persisted resource policy in AGENTS.md; latest native pass ended with exit zero and no Electron in app inventory | Keep heavy checks serialized and close test processes after each pass |
| Table drag handle shows repeated dots instead of Obsidian compact six-dot grip | Compact Lucide row/column handles integrated on main `f0898d8`; focused tests, typecheck and build pass | Packaged native controls mount; screenshot capture clipped, so exact appearance and pointer hit areas remain unverified. See `table-grip-reference.md` |
| Tab-drag split preview does not match Obsidian | Assigned isolated docking implementation and shipped-artifact preview/drop-zone audit | Verify preview position/size, tab insertion versus split transitions, committed drop result and native geometry |
| Resize Canvas cards from horizontal and vertical edges like Obsidian | Native horizontal/vertical edge resizing persisted on candidate `6b96d1f`; Base draft committed on blur without loss; evidence in `editor-native-base-canvas-check.md` | Verify all four edges, minimum dimensions, undo and focus retention; this pass does not establish all interaction cases |
| Configure hotkeys in Settings | Workspace bindings integrated; native conflict rejection, rebinding, disabled old binding and reset verified on `f0898d8` | Native Option-letter label defect assigned; editor formatting/folding integration and complete shortcut/menu/layout checks remain. See `native-editor-controls-checkpoint.md` |
| Use maximum useful parallel agents with good architecture and independent verification | Persisted in `AGENTS.md`; implementation, audits, integration and review assigned in parallel | Reassign available workers as useful scopes become independent |
| LiveSync-style easy default sync, FullCalendar and TaskNotes-style task/calendar features | Calendar/tasks remain deferred; user explicitly opened shared plugin-data/sync discussion, with API design changes on hold | See `deferred-product-roadmap.md`; do not infer approval of sync implementation from discussion |

Editor correctness remains the immediate priority: cursor/selection geometry,
complete live rendering, tables, properties, embeds, clipboard, keybindings,
recovery and performance. This queue does not certify complete editor parity.

## Scoped insertion-command request — 2026-10-16

The broader editor goal is paused. The user separately requested default editor commands such as Insert table and Insert callout. This scoped task adds table, callout, code block, math block, horizontal rule, Markdown link, image and footnote insertion through the existing command palette and configurable Settings hotkeys, without assigning new default shortcuts. Existing editor formatting/folding commands should also be discoverable in the palette when an editable target is available.

Implementation: isolated `tingkai-c/editor-insertion-commands`; shared insertion actions, command registration and guarded palette routing in progress. Validation and integration are pending. Acceptance covers useful initial caret/selection, selected-text preservation, one-step undo, read-only/composition protection, safe nested-editor handling and rejection of stale palette targets. Do not treat this scoped task as resuming paused Canvas or shared-core consumer work.

Editor insertion scoped validation (2026-10-16): isolated `editor-insertion-commands` from `30c1349` passed 101/101 serial targeted tests and direct TypeScript checking; independent source review cleared. Palette, Settings catalogue and context insertion share guarded actions. No new default shortcuts. Main promotion remains coordinator-owned; native focus/IME and rendered footnotes are not claimed.

## Easy account authentication — 2026-10-16

User asks to reuse an easy-to-set-up authentication solution. Discussion open; no provider adopted or auth implementation authorized by this question alone. Evaluate packaged Better Auth + SQLite with a standards-based OAuth/OIDC boundary to Rust, including desktop/browser/CLI login and hosted/self-hosted configuration. Keep vault permissions and device revocation in Rust; identity-provider login must not confer vault decryption keys. Include identity database and signing/configuration secrets in coordinated backup/recovery. Current backend has account/device/membership authorization primitives, not a finished end-user login flow.

## Domain layout — 2026-10-17

User confirms ownership of zorid.app and proposes it as the main-site entry, with a separate subdomain for hosted syncing. Proposed names discussed: app.zorid.app for the browser client, sync.zorid.app for the Rust sync API, auth.zorid.app for login. Exact subdomain names remain proposals; no DNS, hosting, credential or deployment changes authorized/performed. Keep self-hosted endpoint configuration and explicit browser-origin boundaries.

## Integration velocity and test scope — 2026-10-17

User questions whether excessive testing is delaying completion and asks for honest status. Coordinator acknowledged overly fragmented validation. Prioritize completing native/CLI and browser/relay flows, then batch meaningful integration checks. Keep regression tests for concrete data-loss, isolation, ordering and recovery bugs; avoid repeated unchanged component checks or new standalone audit projects. This does not reduce the original end-to-end acceptance requirements.

## Native mobile shell steering — 2026-10-17

Native mobile owner relayed direct user choices in durable messages
msg_febbf11dd950 and msg_74bd1ce89ebb: top-left Settings, a configurable
horizontal pill tab row, and native Recents and Files pages now. Home, Tasks and
Calendar remain later page inventory, not implementation scope. Selecting a note
pushes the shared web editor; Back returns to the originating native page. Use
SwiftUI, appropriate Liquid Glass and animations with system preference support.
The native session owns implementation and isolated evidence; source work does
not establish actual device/simulator UX. Shared-core coordinator granted only
the bounded initialPath/noteOpened workspace/platform seams in msg_77abcb590bc5.

User now physically connected an iPhone and explicitly wants to try the app.
Prioritize the native session's signed development build/install at the next
terminal boundary; root granted the exclusive slot in msg_6b654f918bbd after
all root checks stopped. Existing development signing/profile covers the device
per native owner, using separate app.zorid.notes.dev. Installation and actual
phone behavior remain to verify; source/TypeScript/library passes do not prove
them. Stage4 core source work continues independently without overlapping builds.

## Canvas and Bases UX scope — 2026-10-17

User replaced the active task with Canvas edit-button hit ownership, consistent
preview/Live rendering, smooth resizing and trackpad panning over cards, plus
responsive functional Bases layout and controls. See `canvas-bases-ux-goal.md`.
Reviewed implementations and scoped tests pass in `canvas-bases-ux-verify`;
combined production build and short native practical pass now passed (see
`canvas-bases-native-check.md`); main integration is queued. Broader native
resize/zoom/rich-block polish remains unverified. This scoped UI task does not resume the older fenced-Base work. The separate
core coordinator now owns the explicitly resumed Rust durable-save integration,
including its NoteBuffer/workspace seams.

### 2026-10-17 — mobile development verification permissions

Native relays msg_df11e44a6746/msg_03ea8ab884f1 carry explicit user directions:
physical iPhone Zorid Dev (`app.zorid.notes.dev`) data is disposable, including
reset/overwrite for builds without repeat confirmation; unrelated/production
apps are excluded. Keep the owned simulator booted between passes; test app or
automation streams may be terminated to reduce load. Recorded in AGENTS.md.
This is verification policy, not a product feature or completed mobile gate.

### 2026-10-17 — native mobile keyboard, loading and header follow-ups

Native owner relays actual phone findings: hide the extra WebKit previous/next/
Done bar; restore the native formatting toolbar after defocus/foreground; prevent
content jumps on keyboard focus; use loading skeletons throughout native and
embedded attachment loading; investigate slow vault opening. Latest screenshot
clarification is **shadow clipping at the hard header boundary**, not a request
to change spacing or shadow intensity. Do not close this by tuning the wrong
visual property. Owner: native mobile session, isolated branches; root granted
scoped foreground callbacks and attachment loading attributes, preserving source,
resource leases and shared Stage4 backlinks. Native reports 25 foreground/
lifecycle checks and type checks passing, but new runtime fixes remain unbuilt.
Current Simulator save/Back independently preserved exact53 bytes; that does not
verify these newer keyboard/loading/header changes. See msg_0fd7213f1e90.

### 2026-10-17 — mobile build 4 opening crash

Native owner reproduced the user's opening crash on phone and Simulator:
UIKit rejects the history-controls hosting controller's containment when its
view is placed in a navigation bar item. Build 4 is not accepted. Root granted
the exclusive iOS hotfix slot in msg_d40cc87b1ea0; native owns the minimal
containment fix and must verify actual file opening in the existing Simulator
before installing the replacement phone build. No storage repair is indicated;
implementation, build and runtime verification remain separate pending results.

Follow-up: native hotfix source `51d8b84f` (build5) passes actual Simulator
file opening, Back/Forward, typing and exact67-byte saved-content checks without
the containment crash. Generic phone build40602 succeeds and passes strict
signing/Dev identity checks. Build5 is **not installed on the phone yet** because
CoreDevice reports its tunnel unavailable; native awaits reconnect/unlock.
Keep the earlier glass-controls change paired with the containment fix during
integration. Native checkpoint `d7605a3e` records these separate outcomes; this
does not verify software-keyboard/foreground or PDF presentation follow-ups.

### 2026-10-17 — final Stage4 consumer and native coordination checkpoint

Root final consumer candidate701e107f passes normal browser Base Table/Board/List/
Cards/property save/reload/search, and rebuilt desktop Table/Board/property save
with exact63 physical bytes/search2/navigation. Desktop smoke exposed undefined
optional Base scalars crossing IPC; central omission fix independently reviewed,
strict admission retained, regression +actual rebuilt app pass. Main merge checks
TypeScript0 and92 focused tests. Final native/WASM evidence and limits are in
`shared-document-semantics-plan.md`; no mobile/runtime/security claim follows.

Native owner separately reports signed Dev build5 (51d8b84f) installed on physical
phone80513 exit0 and launched0. Simulator keyboard toolbar and PDF2pages/navigation/
save pass; focus-jump video remains inconclusive. New combined sourcef7d78f6d is
source-reviewed with240 focused checks/typecheck0; FFI752 actual10/10 source blobs
unchanged. This source is not yet main-integrated or verified on phone. Owner
relays new user steering: combine Recents/Files into one Notes page with heading
mode menu; Settings gear top-left on home root only. NativePages.swift assignment
remains isolated; root main/Stage4 seams unchanged.

### 2026-10-17 — mobile integration witnessed-rename guard

Independent pinned premerge review (msg017f3ce836d1, main308fc9ba against native
7cfabf0b) found mobile adapter rename drops the optional expected identity/revision
introduced by shared Base edits. A queued metadata race could select a replacement
or newer source instead of rejecting. This concerns the not-yet-integrated mobile
composition; canonical desktop/browser guards remain verified. Native owner has
named scope mobile-native.ts +focused tests to capture the immutable witness,
reject missing/replaced/revised source before move planning, retain persisted retry
identity and preserve no-witness rename. Source review and focused race checks
must pass before build6. Exclusive native slot remains with owner; root main has
no mobile source change. Finding remains pending exact fix/review/runtime evidence.

Follow-up22:32 UTC: frozen native829cd2c9 independently source-reviewed clean
(msg480b7b558291). Witnessed rename captures immutable primitive identity/revision,
rejects missing/replaced/revised source before planning and preserves exact pending
operation retries;14 added race/input cases inspected. Owner reports180 mobile
checks +scopedTS passing. Canonical contract/codec and workspace lifecycle/search
unions preserved. Source blocker closed; composed build/link and actual simulator/
phone behavior remain pending. Existing exclusive native validation grant continues.


### 2026-10-17 — native file long-press actions

User Downloads reference shows a native Files context menu. Requested layout:
Duplicate, Move and Share/export as three horizontal icon-and-label actions;
divider; Rename; destructive red Delete. Apply to native Recents/Files with
system lift/dismiss animation and haptic feedback. Only functional supported
actions should appear, with explicit folder applicability. NativePages371 owns
UI; d809 independently assesses existing Rust file-command/export seams. Preserve
stable-ID/revision witnesses, durable retry identities and same-host admission;
no Swift vault-file mutation or hidden web Workspace. Source implementation and
actual simulator/device behavior remain pending.


### 2026-10-17 — native destination loading, return appearance and tab rules

Vault and file taps must immediately navigate to their native destination, then
show the skeleton there while storage/editor readiness completes. The picker or
source list must not carry the destination skeleton. d809 owns vault-picker
NativeMobile section and explicitly reserved NativePagesCoordinator openEditor/
transfer functions plus private loaders;371 owns row/lending/model/UI elsewhere.
Back/cancel/stale callbacks must drain/close owned sessions and never open a late
or wrong file. User also reports all home rows briefly look opened/active after
returning from a file;371 audits row busy/pressed/appearance state. Source/runtime
fix acceptance is pending.

Superseding navigation configuration rule: the bottom navigation bar MUST retain
at least one implemented item. Empty/malformed/unknown saved membership restores
Notes; removing or dragging out the final item is rejected. Reviewedc1faeda1
importede0070be2; actual extracted Foundation preference/drop helpers34/34PASS.
Old empty-valid design and build8 removal behavior do not satisfy this rule.
Build9 native/UI proof pending.

User requested a document-tab overview matching supplied native thumbnail-grid
reference: top-right Show tabs replaces New note; a larger bottom-right floating
New note button; preview cards with close, bottom+, count, Done. User answered:
each tab one note/file; ordinary file-open replaces selected tab; separate Open
in new tab; + starts a Home placeholder, closing final tab leaves fresh Home.
Home is empty state until file chosen; Recents/Files remain native pages outside
document tabs. Root grants NEW NativeDocumentTabs.swift/NativeTabOverview.swift
source-first only. Existing editor/host lifecycle wiring requires concrete API
review; one active Rust host/editor lease and save/quiesce/close ACK are mandatory.
No implementation/runtime parity claimed.


Native9 follow-up: reviewed minimum-one implementation passed actual Simulator
final-Remove-disabled smoke and34/34 actual Foundation preference/drop tests.
Signed Dev9 built and installed on phone (install0); automatic launch refused
Locked, pending unlock/retry. No document-tabs/new-menu/destination-loader code
in9; those remain separate source/review/runtime work. Caret no-typing pixel
criterion still unverified after contaminated8 observation; source85 checks
alone do not close it.
### 2026-10-17 — Vite migration and mobile keyboard continuity

User explicitly authorizes migration to Vite, then Stage5; native mobile UX work
continues in parallel. Root owns package/lock/root renderer build configuration and
asset scripts in isolated tingkai-c/vite-renderer-migration (base4cdafd33). Asset
extraction worker owns isolated vite-asset-pipeline; source/packaging reviewers
read-only. Native owner freezes root build files and retains mobile source/UI.
Preserve validated Rust/WASM provenance, worker/vendor assets, relative local URLs,
Electron security and iOS dist/capcopy interface; verify actual affected clients
before default integration. No automatic runtime performance improvement claim.

User reports title→body focus while keyboard is already open collapses/reopens
keyboard. Expected uninterrupted keyboard visibility. Relayed msg5dc07b64e4ef to
native owner for scoped focus fix and actual software-keyboard verification,
preserving edits/title commits. Pending implementation and runtime evidence.
Phone6 source829cd2c9 installed/launched successfully per owner, build52508 and
install/launch24342 exit0; detailed interaction checks still pending separately.

### 2026-10-17 — Bases/tasks/calendar before Stage5

User explicitly requests Bases, tasks and calendar before Stage5. Accepted order:
active Vite migration → first-party Bases/task/calendar milestone → Stage5.
Earlier task/calendar deferral is superseded. Shared Rust Base/index semantics
remain the foundation, web/native presentation respects existing ownership. This
request is recorded for implementation after Vite, not marked complete by the
existing Stage4 query engine. Mobile UX work continues in parallel.

Mobile follow-up per owner msg9bf2f3292f1c: user asks silent refresh on Notes Files
page (remove Updating vault spinner while retaining list; keep initial skeleton
and actionable errors). NativePages source assigned371. Actual invalid-PDF build6
error appears but loading overlay clears only at8s editorTimeout, without ready;
source-only callbacks were insufficient. Native owner diagnoses bounded shared
presentation seam; root Vite pdf-view changes only import ignore comments. Neither
finding is complete until actual behavior passes. Search field leading icon toggle
confirmed for Zorid app actions, not shell commands; owner notified.

### 2026-10-17 — Native follow-up ownership and phone7

Native menu review23:53UTC (117/msg_ae023f00fdd1) withholds acceptance of5adb0e4a:
cross-folder Move discards selected destination folder identity before atomic
dispatch, permitting replacement-folder targeting; native pending action journal
is not recovered/gated on startup and every editor/import/new-note transfer.
371 owns native durable recovery/gate fixes, coordinating reserved loader seams.
Atomic destination precondition and compact original receipt/status for large
recursive results need exact Rust ownership proposals. Retain unknown operations
and same IDs; no path-based success inference. These menus remain outside build9.

Native document tabs source checkpoint23:51UTC: worker2f48a270, isolated
tingkai-c/mobile-document-tabs, ordered5824bbfe(model)/2d5e934e(overview), only two
new Swift files. Root reviewed complete drafted files and final bounded-metadata/
adaptive-appearance changes; no source blocker identified. Document tabs use local
vault UUID plus opaque store/file identity, acknowledged save/close transitions,
fresh Home on last close, explicit64-tab/128KiB caps and bounded decorative cache.
No compiler/tests/project registration/editor wiring or runtime acceptance yet;
not in build9. Existing lifecycle/project seams require named proposal first.

Simulator8 owner evidence23:41UTC (msg814cedb8c784): full native Settings push,
navigation configuration and back pass; Rust literal search returns two enabled
hits at lines7/9 and opens the matched note, with return/clear working. Notes was
restored after testing old empty-bar behavior. That behavior is superseded by the
minimum-one request below. Caret observation continues; phone8 intentionally
skipped. These results do not establish build9/minimum-one or phone acceptance.

Latest navigation correction23:38UTC: navigation bar must always contain at least
one item. This supersedes the earlier explicit-empty configuration. Native371
prepares a separate minimal patch: normalize empty/malformed preferences to Notes,
reject removing or dragging out the final item. Independent review/helper checks
and actual UI acceptance remain pending. Finish Simulator8 checks but skip phone8;
request exact reviewed build9 candidate before compiling/installing replacement.

Follow-up23:37UTC: opening a vault or file should navigate immediately to its
destination and show the loading skeleton there. Returning home currently makes
all rows briefly look active/opened. Native owner assigned destination loading to
d809 (picker section and NativePages openEditor/transfer/owned loader), with371
retaining row/menu/session-lending and return-highlight repair. Isolated source
work only, outside frozen build8; actual UX verification remains pending.

Native owner reports phone7 exact ce1e0ace signed, installed and launched on the
physical iPhone (build91966 and install/launch12016 exit0). This supersedes phone6;
full keyboard interaction acceptance remains pending. The heavy slot returned to
root via msg5e815eb955cf; no native compiler/helper/server remains active.

- Caret should become visible immediately after a tap/selection below the visible
  editor area, without waiting for typing. Native owner assigned investigation;
  exact shared-editor file ownership is required before edits. Preserve manual
  scrolling when the caret does not move. Runtime verification is pending.
- Full native Settings and configurable navigation bar: source ceef6006 remains
  isolated under native owner. Extracted production Foundation preference/drop
  helpers passed34 checks; UIKit drag, gestures, accessibility, empty navigation
  bar and restart acceptance remain pending. This is not included in phone7.
- External file/photo/video import: first Rust/native ABI source slice assigned
  to861, using existing durable stages and text creation, keep-both collisions,
  bounded streaming and existing64MiB binary limit. Host scope is
  crates/zorid-desktop-host/src/staged_import.rs plus minimal lib.rs seams;
  mobile Rust/header ABI belongs to861, native Swift hooks to native coordinator.
  Root owns manifests. No implementation or runtime acceptance claimed yet.
  Share extension/AppGroup/project/signing/CI changes require a subsequent scoped
  coordination decision; the existing wildcard profile does not prove readiness.

2026-10-18 native header finding: user requests removing the vault-name subtitle
above the Recents/Files heading (reference screenshot AhGuxX). Owner removed only
that decorative row in NativePages; vault identity remains in selection/settings.
Source review and current phone build verification pending; not yet deployed.

Vault subtitle removal compiled in signed Dev10 artifact at2add282b. Physical
install is pending reconnect (CoreDevice1011/tunnel unavailable); no actual phone
visual confirmation yet. Native Simulator tab flow passes are recorded separately
in native-mobile-integration.md; no broad keyboard/lifecycle parity claim.

2026-10-18 mobile followups: user asks for route swipes. Native edge gestures
are not implemented or verified yet; they must invoke the same guarded root
history traversal after transition verification, with no additional editor host.
User also requests that tapping Markdown links opens the link without placing
the caret there. Root assigned source-only diagnosis to stage4_contract_review
(0e1c0611ffda); shared editor/mobile bridge edits await named seam ownership.
Actual tap/navigation/selection/IME evidence remains required; no fix claim.

2026-10-18 native loading follow-up: user reports excessive note/vault loading,
requests no loading words or technical details, and asks to discuss dynamic
WebView reuse. Presentation source in native-vault-context removes transient
vault/search/checking/applying copy while retaining existing skeletons, trusted
rows on refresh and errors/retry. Syntax/diff checks passed; independent review
and actual visual verification pending. Source change is not a load-time fix.
Fresh WebView and whole-vault indexing are observed source paths; comparative
runtime costs and Obsidian behavior are unmeasured. Warm reuse/pooling remains
a proposal; no session-lifetime redesign has been implemented from discussion.

Vault-scoped tabs source: model/store6a composed with native picker/factory
callers in native-vault-context; trusted vault UUID partitions restored tabs,
no old-global fallback, prior context must fully drain before switching. Same
vault reuses its coordinator; Home Choose file stays in that vault. Source
review and syntax checks pass, including final deferred-alert guard ACK4127.
Actual A/B switch/restart isolation remains unverified; not installed on phone.


New-tab clarification: tabs belong inside the current vault. New Home must show
its native Recents/Files landing page like first entry, not blank Choose file or
vault selection. Factory/root activation follow-up remains open. Actual16 fresh
A/B Home-tab scope/IDs +B process restart pass, with separate unchanged0600 files;
that identity proof does NOT establish this newly requested Home presentation.

Scope correction (2026-10-18 03:17 UTC, direct user instruction relayed by managed owner): remove spaced repetition entirely from the implementation goal, rather than defer it. No active implementation was underway.

Mobile same-vault navigation review (2026-10-18 03:53 UTC): independent source
review found rejected expected-EntryId admission mutates NoteBuffer identity
before checking its loaded witness. Loaded A -> attempted replacement B rejects
but pins buffer to B, preventing later A/no-argument reuse. Root confirmed exact
note-buffer blob1c2de404 in isolated mobile-ios-shell; correction and focused
regressions assigned to restored navigation owner c8bf385c. Not main code and
not a runtime finding. Preserve source/draft state on rejected admission.

Navigation identity correction source accepted (2026-10-18 03:56 UTC): exact
4d04d082 passed293 focused cases/fullTS and independent delta review, integrated
as maina2d480e2. Pin changes only after successful admission, including queued
calls. All eight files match approved source. Paired native runtime remains open.

Mobile priority correction (2026-10-18 04:00 UTC, native user relay
e4fd2e594a5d): user confirms New File FAB still inert on physical Dev17. Native
source confirms missing onCreateNote/canRouteCreate binding. Dedicated isolated
native-new-note-ui worker now owns NewNote root/startup, Pages callback/borrow/
recovery, factory pending inspection and minimal helper/PBX wiring. Reuse reviewed
d9 helper; actual tap/create/edit/save/reopen remains required. FAB delivery first,
one warm runtime parallel, then composed per-tab/gesture/save/keyboard proof.

Durable publication identity fix (2026-10-18 04:08 UTC): root isolated
core-durable-identity-fix extracts C5c58850f's one-line current.entryId publication.
Direct cache/event identity regression fails old source9/10 then passes corrected
10/10; foreign readback identity still rejects before publication. Independent
review approved. Canonical main209368fb; Tasks real saved-body split proof remains
with the full UI batch, not inferred from these scripted core cases.

### 2026-10-18 — Base status labels expose option IDs

Managed Calendar coordinator directly observed the actual5ea desktop screenshot:
generic Tasks Base table/group labels show raw stable status option UUIDs, while
the Tasks destination shows To do/In progress/Done. Queued product UX gap, not
a newly verified regression. Typed Base rendering should resolve current option
labels/colors from Type configuration while preserving stored IDs, unknown values
and exact semantic filter/group identity. Implementation and actual UI verification
remain pending. Keep separate from the active Base save-freshness reproduction.
