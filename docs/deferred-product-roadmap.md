# Product discussions after the editor foundation

## Execution checkpoint — shared-core coordinator

**Full supported Notion database interactions — frontend candidate; core gate pending (2026-10-28).**
Root `codex/notion-interaction-match` from `e4c8a6d0` holds reviewed composed frontend
at `253de0fa`: slash/source creation, focused schema picker, toolbar/settings,
Table/List/Board, page peek, supported property editing, keyboard/focus handoff
and tooltips. Actual Electron/REA verification caught and fixed missing inline
save witness, empty-database readiness, native date normalization, empty page
value hit targets, Board height/opaque option labels and failed-option cancellation.
Latest 262/262 focused checks + TS/native frontend build pass; earlier frozen
322/322 pass remains a separate receipt. Existing 17 neighbor-suite failures also
reproduce on original `e4c8a6d0`; no full-suite/parity claim.

**Acceptance blocker:** actual native option creation after a nullable Multi-select
exists triggers core destructive confirmation: schema update normalizes null to [].
No frontend confirm bypass. Reviewed proposal and required regressions are in
[core remedy](plans/notion-nullable-multiselect-core-fix.md) and adjacent patch;
Rust source remains unchanged. User exception requested to the explicit frontend-only
build limit; no response yet. Core fix, source-matched host build, remaining native
clipboard/all-type/restart checks, main integration/package/install/replacement
remain unfinished. Current installed app and main `e4c8a6d0` are untouched.
Temporary main lane returned to coordinator while awaiting the exception; reacquire
and reconcile before integration. No test app remains, push/iOS/Tauri work or Rust
build. [Reference/evidence](reference/notion-database-interactions-20261027.md).

**Bases refresh/select flashing fix installed — 2026-10-27.** Product `86466ce8`
is on main after scoped independent review, 59/59 main checks + TS, frontend build,
9/9 Rust refresh-hints +12/12 source checks and source-matched native build.
Explicit-source static views now have no one-second deadline; genuine time
expressions retain theirs. Equal schema revalidation retains Select DOM/drafts
and write guards; foreground Updating waits 350ms for slow refresh. Actual native
select save/body preservation and installed restart/idle checks pass within
bounded scope. Updated `/Users/ctk/Applications/Zorid.app`; previous bundle
deleted, no test app remains. No iOS/Tauri/full-suite claim or push. Main/Rust
lanes released on completion. [Evidence and limits](history/bases-refresh-stability-20261027.md).

**Notion-inspired Bases first pass installed — 2026-10-27.** Product `399591a5`
is integrated into main using the acknowledged temporary root lane. Named view
tabs, explicit Create/Cancel with inherited source, direct settings/column menus,
quieter grid/primary New, readable property labels through refresh and database-only
Properties are delivered. Final 162/162 focused, TS/native frontend, 356-file package
verification pass; main 63/63 + TS pass. Installed
`/Users/ctk/Applications/Zorid.app` passed bounded normal-renderer restart/view/column/
ordinary-note checks; previous app bundle deleted, vaults/preferences preserved.
AGENTS.md records automatic build/install/replacement after completed requests.
No Rust/iOS/Tauri build or push. No test app remains; lane released on completion.
[Reference and limits](reference/notion-database-ux-20261027.md),
[delivery receipt](history/bases-notion-ux-20261027.json).

Current as of2026-10-26. Read this summary first; dated execution evidence below
is historical where it conflicts with this checkpoint. The maintained stage
sequence is in [roadmap.md](roadmap.md); S1 scope is in
[plans/indexing-search.md](plans/indexing-search.md).

**Latest: local collections integrated — 2026-10-27.** This supersedes the
earlier dated pending cutoffs below. On the user's direct instruction to integrate
itself, root obtained the previous owner's acknowledged temporary serialized lane
and fast-forwarded clean main `c36c4b0e` to `ae5cb5d4`. Main then passed **99/99
focused checks, TypeScript and the native frontend build**. The frozen basic
create/edit/filter/delete/restore/restart scope and deleted-view source recovery
have actual desktop/CLI and bounded untyped-browser receipts in the
[tracker](plans/types-properties-implementation.md). No Tauri work or push.
Browser collection CRUD, installed production-package and broad platform parity
remain unclaimed; sync/collaboration stays deferred. Completion notice releases
the temporary lane back to the standing main owner.

**P008 bounded native PASS; P009 presentation pending — 2026-10-27.** Root
`dd6c0b7f`: main-owner successor source review Standards 0/Spec 0, independently
closed; root 52/52 focused + full TS/native frontend005 PASS. Actual **normal
source-mode Electron** now passes recovered managed schema/hidden identity/Date
controls, managed 8→9 and ordinary rating 4→5 clean acknowledgement, normal
quit/reopen persistence 9/5/null/exact bodies. Typed filter 9/New inherits 9/edit 0
hides while retaining editor/file; collection browser 3 vs view 1, Trash confirms
all 3 including 2 hidden, unrelated data preserved, Restore exact 3IDs/9-null-0/bodies
and filtered 1 returns. `desktop-acceptance-002.json` + `restored-final-data.json`
under the disposable desktop evidence directory record bounded actual proof.
All foreground sessions through 51898 normal exit 0; no live owned test app.
P006/false postcommit refresh CLOSED within this actual scope, prior failures kept.

P009 is the one assigned remaining presentation gate: known deleted collection
shows duplicate raw Durable editor error/repair-source hint alongside working
Restore. local_ui owns session/Workspace hint only, collection_ui_review reviews;
source/results pending. Require fresh authoritative tombstone Trash card with
Restore/Change source, real failures preserved, exact captured Restore command
surviving rerender/uncertain retry. See [P008/P009](plans/types-properties-implementation.md#p008--2026-10-27--recovered-controls-and-clean-saves-bounded-native-pass).
Main unchanged c36c4b0e; sole owner awaits clean final branch/evidence and root's explicit
integration request to that owner. No installed production-package/full platform acceptance;
browser untyped only, collections unavailable. No Tauri actions.

**Latest user scope freeze — finish basic local delivery.** Complete basic
create/edit/filter/delete/restore/restart and the already-coded truthful Trash
card/working Change source. Final review expanded too far into secondary edges;
finish only current implemented UI/controller seam and focused verification, then
clean handoff/root integration request. No further exploratory edge work or new
gates. Broader untested variants remain scope limits, not core-delivery blockers.

P009 owner/dependency: local_ui session/Workspace card/Restore retry has 9 focused
cases + TS PASS; view_source_model controller+tests fixes narrow source repair
blocked by current.error and stale/initial-empty source on error refresh. Preserve
coherent parsed readDefinition/witness/epoch and existing CAS/identity/stale-draft/
preview/property-write guards; collection_ui_review reviews both. Current seams
are implemented, combined focused verification/composition pending. No acceptance
claim from UI-only passes or appearance of a Change source button.

**FINAL P009 core-flow verification PASS; integration pending — 2026-10-27.**
Code HEAD 05b73d5a08dc7c9a083041071d376b54020a71f9, product 262939e6,
controller cd17f237/tests 2708115e; all independently reviewed zero must-fix.
Final composed002 99/99 PASS 0 skip, full TS/native frontend006 PASS. Preserve first
001 98/99 FAIL: obsolete unsupported untyped-cell editing oracle; test-only
successor uses supported Results Limit draft guard/browse-only/Cancel assertions.
Actual normal source Electron 70282 PASS: Delete 3 including 2 hidden produces one
clear Trash card/Restore/Change source, no raw error/repair hint; card Restore
works; second Delete/Change source saves explicit untyped. Restore old collection
from browser preserves exact 3 IDs/9-null-0/full hashes while selected view stays
untyped with ordinary file-only results/no property/group/add controls. Normal
quit 70282 exit 0, all owned test apps closed. Receipt:
`/private/tmp/zorid-local-collections-desktop-20261027/deleted-source-final-smoke.json`,
readback `restored-final-data.json`. [Final P009/handoff](plans/types-properties-implementation.md#p009--2026-10-27--deleted-source-core-flow-verified)
links source/CLI/native/browser bounded receipts and matched native Rust artifact
receipt. Core frozen scope CLOSED; main c36 still awaits clean evidence handoff and
root's explicit request to sole main owner, no product merge yet. No installed
production-package/full platform claim; broad untested variants remain limits,
not new delivery gates. Browser collections/previews unavailable; no Tauri work.

### Latest execution update

**P007 successor — reviewed source, actual corrected startup pending.**
P007 successor source: `4daa7e2b`→root `d02246e2`, recovered-only first-bind fix,
independent exact review CLOSED/no must-fix. Worker 44/44 + final 13/13 overlap and
pass. Root 13 recovery +24 target +10 setter tests (47), full TS/frontend004 are
running in session 78982; corrected actual startup is not yet run. Old failed input 78
escaped/reset 7/error cleared, session 58193 normal quit exit 0; no live test app.
Earlier 73fa actual FAIL remains historical and held until P008 actual evidence.

**Earlier P007 gate — native P006 failed at73fa; bounded browser PASS — 2026-10-27.**
Root 73fa41c9 composes e37 coherent-target fallback, owner 24/root 34 source checks,
full TS/native frontend003 and independent review PASS. Actual P006 retest still
FAILS: generic controls and normal property edit errors before lookup at
Workspace:1322. Two source audits confirm recovered checkpoint buffers have no
`bufferEntries` binding after replaceVault/cache reuse; file token stays undefined.
`managed_editor_saves` owns recovered-only eligible first binding + genuine
checkpoint-start regressions (red 0/4 before fix), reviewed by collection_ui_review.
The fallback fixes a separate valid bug, not this native gate. At the failed
observation, session58193/PID89085/host89129 had user interaction and draft78 with
saved7 unchanged. The successor update above records subsequent normal cleanup;
corrected actual startup proof is still required, feature/main held.

WASM002 PASS 3m26 offline one job, 454 unchanged build inputs; owned-cache cleanup
freed 1.17 GiB with 4,258 protected hashes unchanged, no Tauri/other-owner caches.
Actual normal browser CUA PASS bounded: fresh-origin untyped file-only Base,
metadata filters/sort, immediate New inherits 4, edit to 2 hides/keeps note, reload
persistence; collections explicitly unavailable and Cancel preserves view.
Owned browser tab closed; Vite 92227 exact-owner TERM/exit 143, user tabs untouched.
[P007](plans/types-properties-implementation.md#p007--2026-10-27--native-retest-fails-source-cause-and-bounded-browser-pass)
records exact root tmp receipts (`browser-ui-observations-001.json`,
`wasm-build-002-receipt.json`, `cleanup-cache-receipt-001.json`) and scope limits.
No browser collection CRUD or native P006 acceptance inferred; no Tauri work.

**Local collections P2 closed; P006 restart finding — 2026-10-27.** Root
`7a810bb5` composes `fc72f099`, independently reviewed with no must-fix findings.
Root P2 regression 10/10, full TS and native frontend002 PASS; unavailable-tsx
first launch ran no tests. Bounded actual normal Electron P2 PASS: UI-created
Tasks/two notes, Status→Number, ordinary-note correction In progress→7 and
Not started→null remove warnings, preserve exact bodies and persist through normal
quit/reopen/raw-YAML checks. Receipts:
`/private/tmp/zorid-local-collections-desktop-20261027/p2-ui-observations.json` and
`p2-disk-after-normal-quit.json` in the same directory. All three foreground
sessions 79092/13222/42387 normal exit 0; user finished testing, no live test app.

New **P006** actual restart defect remains: collection notes render generic
editable `_id`/`_type` and inferred-null JSON controls instead of managed schema
controls. Values/bodies and Base membership (two entries) persist; observations
and note switching do not settle it. `managed_editor_saves` owns read-only diagnosis;
cause/fix unestablished. Feature/main integration remains held. See [P005](plans/types-properties-implementation.md#p005--2026-10-27--datatype-correction-source-finding)
and [P006](plans/types-properties-implementation.md#p006--2026-10-27--managed-note-controls-after-app-restart).
Browser WASM never compiled: 186MiB free <1.5GiB prerequisite. No matched browser
artifact or browser acceptance; no Tauri actions, and main ownership unchanged.

**Local collections review correction — 2026-10-27, P005.** Independent main-owner
review reports zero documented standards violations and one P2: retained
Select/Status values cannot be corrected or cleared after conversion to Number
in ordinary note properties. `local_ui` owns the scoped fix/regression,
`local_core` advises the projection contract, `collection_ui_review` reviews it.
Entry/schema and stale-note guards remain required. Main integration is held;
prior CLI passes do not cover this case. WASM compilation did not start because
only 186 MiB was free; its build lane is released. User's active disposable
Electron window remains untouched. No Tauri work. See tracker P005.

**Local collections actual CLI/live Electron cutoff — 2026-10-27, P004.**
Root `06696a2c` contains test-only oracle correction `ab538c71`, no product change.
Final narrow source/UI review closes through this HEAD with no remaining must-fix
or source edits pending; actual UI acceptance remains separate.
Original actual CLI failed at 29 executed commands on numeric 0 vs Native Status
string `"0"`; retained receipt remains failed. Strict corrected successor
**PASS 30 commands/13 checks/all 7 scenarios**, with valid retained local outbox
`"24"` and pending projection `"0"`. Exact original/successor receipt paths and
exclusions are in [P004](plans/types-properties-implementation.md#p004--2026-10-27--actual-cli-successor-pass-live-electron-user-test).
Normal Electron was launched with disposable profile/vault and matched host;
initial background launcher did not persist, then foreground launch succeeded
(PID 30213/host 30256, exec 79092). CUA observed source onboarding only. User actively
uses the test window, so root holds UI automation and preserves that session;
full UI/quit-reopen acceptance is not claimed. Launch receipt:
`/private/tmp/zorid-local-collections-desktop-20261027/launch.json`.
Native frontend TypeScript/Vite passes; actual browser and main integration remain
open. Main ownership unchanged; local-only scope and no further Tauri work remain.

**Local collections artifact/CLI cutoff — 2026-10-27, P003.** Root HEAD
`d7a033b7`; final query24/24, native query-facade3/3, CLI3/3 + phase1/1 and
compatibility2/2 PASS. Matched arm64 CLI/host artifact build and native frontend
TypeScript/Vite build PASS. Root receipt
`tmp/local-databases-20261027/final-products-receipt-001.json` retains exact source,
closure and binary hashes: Rust closure starts at `d7aecf48` and is unchanged at
`d7a033b7`; Vite config changed during compilation and is recorded separately.
Actual CLI driver is **running**, `/private/tmp/zorid-local-collections-cli-20261027`;
no terminal acceptance yet. Actual UI/browser and main product integration stay
open. See [P003](plans/types-properties-implementation.md#p003--2026-10-27--matched-artifacts-actual-cli-driver-running).
Latest user instruction: **do not work with Tauri; finish local collections first**.
No further Tauri activity is part of this pass. Main retains its acknowledged
sole owner; root serializes validation. Historical failures remain intact, and
source/artifact passes do not establish installed-app, browser or sync acceptance.

**Local collections composed checks — 2026-10-27, P002.** Root source
`2d5aa427` plus dirty committed-error compatibility source `8d0a0b2b`; query catalog
`a128` not composed during Rust freeze. Current selected Store 64/64 and native 32/32
checks PASS; host001 fails compile before tests, compatibility successor host002
PASS 4/4. Composed JS 61/61 and session 5/5 PASS. CLI3/3 now PASS; separate phase1 terminal
receipt pending; full
query 12/preview 12/native-query 3 await the root lane. Source-review must-fix findings
are closed for reviewed slices; UI/model source includes the latest template,
creation, stable-ID/deleted-view/repeated-label fixes. Historical 132-case UI
131PASS/1 stale-oracle failure, initial core 28/30 and native 24/25 failures remain
recorded separately from successors. See [P002](plans/types-properties-implementation.md#p002--2026-10-27--composed-source-checks-actual-acceptance-pending)
for exact logs and limits. Actual matching artifacts and CLI/UI journeys remain
unrun; no main integration/app acceptance. Main `c36c4b0e` retains sole owner
`term_d8b43288-7bf1-464c-af5f-b779721982e3`. Root exclusively holds host/CLI/Rust
validation, release offline `-j1`; no parallel heavy builds. About 1.1 GB free;
regenerable Tauri-cache cleanup requested from its owner, no root cleanup action.
The compatibility error arm adds no sync feature; local-only scope is unchanged.

**Local collections source/native cutoff — 2026-10-27.** Root continues
`codex/local-databases` at `223d3733` plus native-owned dirty fixes/copied
`bb06db81`; main remains under sole shared-core integration ownership, no product
batch integration claimed. Core/native/query/model/save/transport/driver batches
are composed. UI source `b952bf81` is clean/committed on its worker branch, not
composed at receipt; exact-source review/CSS wiring pending. Its 132-case focused
cutoff is 131PASS/1 stale view-ID oracle failure; corrected oracle targeted 1/1PASS,
full TS PASS. Core/source safety followups remain active. Native first compile failed 3 type errors; corrected
`native-databases-002.log` FAILS24/25 on idempotent `_type` repair and is under
correction. Valid external status/body/unknown-frontmatter cases pass only within
that bounded failed run. Core prior 31 source checks pass;23 retained-value cases
and current query/preview/native followups are authored/unrun. Stable view IDs and
hidden-sort fixes are source-composed; scoped previews remain disabled safely.
See [P001 continuation](plans/types-properties-implementation.md#p001-continuation--source-composition-and-native-failure-cutoff)
for exact commits, overlapping TS/source receipts, branches and root
`tmp/local-databases-20261027/` logs. Root owns the exclusive native/Rust slot in
shared target, release offline `-j1`; no parallel heavy builds. No installed app,
driver execution, final integrated acceptance or sync completion is claimed.

**Local collections implementation resumed — 2026-10-27.** User explicitly says
"ok start" after the Base/view/type and untyped-browsing design handoff. Root owns
`codex/local-databases` / `.worktrees/local-databases`, main baseline `c36c4b0e`.
The shared-core main owner acknowledged sole integration at 16:56:08 UTC from
`term_d8b43288-7bf1-464c-af5f-b779721982e3`; docs `bc006f23` are queued, not yet
integrated. Root does not mutate main. [Tracker P001](plans/types-properties-implementation.md#p001--2026-10-27--local-implementation-resumed-underway)
records named core/native/query/UI/view-model/transport/save owners, dependencies,
source checks and pending results. Query owner has the sole Rust slot, root
`tmp/local-database-target`, release offline `-j1`; first compile failed on a new
QueryOptions field, was corrected, and the retry PASS 6/6 is recorded. Query owner
released the lane to root; no parallel heavy command is authorized by this entry.
View-model and focused registry TS checks pass as separately recorded; no
integrated/native/app verification or feature acceptance follows. Local only;
no import, cross-collection move or detach; raw managed edits rejection and
unique-name legacy view routing remain explicit E18/E09 gaps. Body composition,
trusted typed-query membership and guarded native projection are in progress.
Collaboration/sync remains roadmap work. The stopped documentation entry below
is historical and is superseded by this explicit resume.

**Local collection design/tracking — 2026-10-27.** User authorizes documentation
of the agreed Base/view/type model and edge cases, plus a tracker for long passes.
Product implementation remains stopped for discussion; previous local-database
worker drafts are unreviewed and are not resumed. Discussion coordinator owns
`codex/database-collaboration-design` / `.worktrees/database-collaboration-design`.
See [design](design/types-properties-sync-discussion.md) and
[tracker](plans/types-properties-implementation.md) for current scope, paused
worktree inventory, dependencies, acceptance cases and handoff receipts. Local
only; collaboration/sync requirements are deferred in the roadmap. No product
integration or runtime pass is claimed. This isolated documentation batch needs
the current main owner's integration; other-session staged main work is untouched.

**RAM evaluation follow-up — 2026-10-27.** User explicitly requests more evidence on RAM savings. Root resumes `codex/tauri-benchmark`; physical-footprint probe owner `benchmark_audit`, UI workload owner `tauri_shell`, root owns serial runner and interpretation. No Rust/Tauri rebuild or production source edits required; compiled shell and installed renderer/core artifacts are reused. Two fixture sizes and three UI states are measured with settling windows, compressed-memory charges and lifecycle evidence for otherwise ambiguous XPC candidates. Eight successful serial runs/24 exact state-source receipts are retained; results and limits are in `docs/history/tauri-memory-evaluation-20261027.md`. User challenges the retained Node bridge: these results establish only shell-swap observations, not an optimized direct-Rust Tauri migration verdict. Direct embedding is feasible but remains unimplemented.

**Tauri feasibility benchmark — 2026-10-27.** User explicitly requests the proposed isolated shell prototype and matched comparison. Root owns `codex/tauri-benchmark` / `.worktrees/tauri-benchmark`, base `8507a855`; production shell remains Electron. Common installed editor + Node broker + Rust host isolates shell differences, with disposable vault/data roots. Tauri shell worker owns only the standalone prototype; audit worker owns transport review. Results, evidence, limitations and commits are recorded in `docs/history/tauri-benchmark-20261027.md`; prototype code stays isolated from main.

**Native filesystem identity repaired — 2026-10-27.** User explicitly requested
fixing the cause, beyond compact warning UX at `460f8dbc`. Native owner
`bases_fixture_admission` delivered reviewed `b935857e`, composed as `64e605e4`;
`bases_final_spec` approved the exact implementation. Idle, content-equivalent
bound files/folders are revalidated and rebound atomically; old device numbers no
longer imply permanent ownership. Historical proofs and live write/race guards
remain intact. Changed/missing bound files or active writes conservatively block
the batch; extra untracked files can be imported normally afterward.

Four focused public native cases PASS (actual red reproduced first), matched host
build exits0 and355-file arm64 local package verifies. Installed/reopened normal
`~/Applications/Zorid.app` automatically recovers the actual vault:11/11 original
bindings current, compared with1/11 before; all original logical IDs preserved,
no schema change or data reset. A later live snapshot has12/12 current, zero
content/state mismatches and zero pending work. Native UI shows the normal Base
and no availability warning. Ordinary acknowledged Test1 writes and another file
creation occurred during live validation, so no blanket unchanged-file claim is
made; nine other original files are unchanged at the first check. The user explicitly confirmed testing those edits. Hashed snapshots, pre-repair DB backup,
write timeline and build/test/install receipts: `tmp/native-identity-fix-20261027/`.
See [repair closeout](history/native-file-identity-repair-20261027.md).

**Local installation/cleanup follow-up:** main `6f7237ed` produced the verified
355-file arm64 local app at `~/Applications/Zorid.app`. User requested worktree/
cache cleanup: all105 extra worktrees are removed; only main remains. Four dirty
test files, patches, branch refs and earlier validation evidence are preserved in
`tmp/worktree-cleanup-backup-20261026/`. Build caches, duplicate apps/binaries and
disposable test data were removed; normal vaults and app data are retained. Free
space is9.1GiB. No new functional test campaign was added. See the closeout's
follow-up section for relocated evidence and installation receipt.

**Local desktop Bases closeout — 2026-10-26.** Root owns integration from
`codex/types-bases-model` / `.worktrees/types-bases-model`; canonical main's
integration parent is `e7d655e1`. Reviewed product source is `be163101`, with
Rust namespace/cache fix `b9037d59`; later commits through `4c71a4a6` correct
only the desktop driver. Integration uses a fast-forward, preserving the exact
reviewed implementation. No push, mobile, task/calendar or new sync work is opened.

The heavy-user workflow is covered in retained stages, **not one uninterrupted
all-green campaign**: heavy005 reaches55checks/366actions; continuation001 covers
New recovery/Cards/List; continuation003 covers actual Chromium Kanban move,
keyboard move, split consistency and sidebar context; continuation004 verifies
exact inline configuration and stale-write protection; continuation005 PASSES
8checks/18actions, external discovery, exact note/Base/template-body restart and
two normal quits (exit 0, no leaks). All source/artifact freezes verify. Passed
stages were not restarted after the user's explicit no-unnecessary-tests steering.

Confirmed defects fixed: computed reverse/rollup values falsely required raw
editable source; trash files incorrectly remained live relation targets; successful
New-item Retry lost focus and prevented Escape. Focused checks pass (three derived
renderer checks, two Rust namespace/cache regressions,21popup checks). Matching
native/CLI rebuild, matching WASM rebuild and desktop016 TypeScript/build pass.
Browser/CLI runtime
receipts and their older-source limits remain recorded separately. Native uses
its existing30-second external scan; the final driver waits45seconds for discovery.
No rescan optimization or broad suite/reference-matrix expansion was added.

See [desktop closeout](history/bases-desktop-closeout-20261026.md) for evidence,
artifact identities and retained limits. Earlier interrupted campaigns below are
historical; they do not become blanket acceptance claims. Complete pixel parity,
unexecuted safety/filter/config matrices, supplemental web Worker identity and
other-platform runtime remain unclaimed. Original receipts/archives are retained.


Latest completed cutoff (2026-10-26, archive010; source throughc73b0805):
Config001/e184/frontend009 FAILS1/1 at929/1023 durablefiles after180029ms.
Config002/c0f5/frontend010 still FAILS1/1, but unchanged1023files/12Records/
1005Export admission completes34408ms. The rendered twelve-record baseline then
fails with an indexing-wait error despite published generation6/watermark1026
matching the core. Reviewed metadata/index refresh fixes and desktop011/95338
PASS333files producerc73 need a fresh runtime pass; desktop010/19330 also passes.
Both completed config cleanups0/null/no leaks and exact provenance verify.

Normalweb007/bd870 passes all five UI phases/11actions but FAILS read-only Worker
Inspector Runtime.evaluate deadline; no waived identity proof. Normal Chrome/
Vite cleanup and final provenance pass. Current reference bootstrap005 PASSES3/12;
full typed005 PASSES13phases/111checks/856trustedCDP inputs incl native Date/
DateTime exact fields/source/membership/reopen. Final restart verifies cleared
baseline only; final reference SIGKILL/no leaks/private stale socket remains.
Visual003 FAILS after baseline1/23plannedstates/3pointerrequests at stale Views
selector. Active Visual004 is excluded. Vendor code/captures stay private.

Saved composed source42/42, web/property42/42 and import23/23 logs all pass0skip;
they establish source checks, not native acceptance. Append-only archive010
preserves the exact completed evidence and nine selected reference metadata
files; parts001–009 remain unchanged. Preserve all archives before retiring this
worktree. Full safety/heavy/layout/filter/config/sidebar/visual/web-identity and
reviewed main integration gates remain open; current reference typed pass is
bounded to its authored protocol and does not establish Zorid parity.

Coordinator update: composed implementation through02e34894 on isolated
codex/types-bases-model; main remains e7d655e1 and sole integration ownership is
unchanged. Reviewed typed-list preservation904e7145, unresolved relations9a5972ca,
exact view-name source mutation7a493f52, null/current identity4f91c461, and import
continuation f3b0c2ba/02e34894 are integrated. New composed source tests42/42,
web/property oracle tests42/42, import/service tests23/23 PASS. Desktop010/19330
PASS including TypeScript, producer02e34894; matching receipt010 is in the private
products directory. Rust tree07265/native403cbeb8/CLI8e4e61e4 unchanged.

Current Obsidian1.14.5 full typed-filter campaign005 PASSES13phases/111checks/
856trustedinputs, including native Date/DateTime values before blur and exact
saved source/membership/reopen. Both receipt audits accept the bounded result.
Final restart verifies cleared baseline, not an active filter; final cleanup
uses SIGKILL fallback, no owned processes, private stale socket remains. Real
user socket/source/framework identity protections pass. Visual003 stops after
one of23states on a stale Views selector; immutable source successor pending.

At that earlier checkpoint Config002 was next; its completed result is above.
The fixture keeps unchanged1023physical files,1005export
records,180s admission limit. Config001 genuinely stopped at929files: UI retry
progress omitted durable inventory and periodic rescan used a rejected leased
command. Both causes have reviewed causal fixes, not native acceptance yet.
Metadata-only filter advice, sidebar pin UI, nested-definition retention remain
isolated pending review/integration. All remaining safety/heavy/layout/filter/
configuration/sidebar/visual native gates remain open. Do not stop on status
questions; continue the authorized implementation, verification and main merge.


Next completed cutoff (2026-10-26, archive009): desktop009/10844 PASSES333files,
producer22feac9d. Filter004/e184f114/frontend009 FAILS83actions/23checks after
THREE complete String cases. Fourth negated starts-with exact source/membership
pass, but reopening shows raw expression instead of structured controls. Cause
remains under diagnosis; no65-case or restart acceptance. SIGTERM0/null/no leaks,
837Git/333dist hashes and source freeze verify. Archive009 preserves originals;
parts001–008 unchanged. Active Config001 is excluded from this factual cutoff;
its launch or source fixes establish no runtime pass. Full outstanding acceptance
and reviewed main integration remain separate.

Next completed cutoff (2026-10-26, archive008): Safety008 on4a7fc7b5/frontend008
FAILS161actions/28checks after SIX passed scenarios. Named-reference recovery copy
and retry now pass their exact source assertions. Seventh mounted-file rename
writes the requested name but normalizes unrelated flow-array spacing, failing
the preserved exact-source oracle; six later scenarios are unexecuted. Two normal
quits plus final SIGKILL cleanup, no leaks and verified source/artifact freeze.
Normalweb006 on6d7b981d passes all five UI phases/11actions but whole campaign
FAILS strict current product-Worker identity: one current generic Worker still
has blank URL/title. Normal browser/Vite cleanup and final proof pass. A source
successor is not runtime acceptance. Archive008 preserves originals separately;
parts001–007 are unchanged. Full safety/C2/heavy/filter/current reference/web
identity and final integration gates remain open.

Next completed cutoff (2026-10-26, archive007; frozenad898/frontend008):
Clipboard001/57404 PASSES92actions/24checks for actual OS clipboard/custom-MIME
paste, input/undo ownership, Chromium composition, pointer resize and row height.
Normal quit0/null, clipboard restored, no leaks, freeze verified. Composition
coverage uses the Chromium protocol; physical macOS IME parity is not claimed.

Heavy001/69687 FAILS306/43 after real CUA purple/blue color selections and broad
config/property/paste-undo checks. It expects Ada count35, but captured36 includes
the literal template; physical36relation members and unfiltered registry support
a stale count oracle. Preserve original failure and strict later expectations.
Layouts001 FAILS28/1 at file-context-menu locator; actions alone establish no
layout-case pass. Both SIGTERM cleanups0/null/no leaks/freeze true. All three
match837frozenGit/333frontend hashes. Archive007 preserves these completed results
separately; parts001–006 remain immutable. No full heavy/safety/filter/current
reference or final integration completion is claimed.

Latest factual cutoff (2026-10-26, archived part006): rootad8983d5 composes the
reviewed bottom recovery-notice placement; desktop008 passes333files, producer
ad8983d5. Safety006 on406c/frontend007 fails117actions/22checks before dispatching
tab-close; Safety007 onad898/frontend008 advances through FIVE passed scenarios,
including actual unobscured close/unapplied-draft guard, then fails the named
recovery-copy locator135/24. Its capture contains a visible copy control in the
second notice; the frozen helper searches only the first scope. No copy/retry or
later C2 publication acceptance is claimed. Each run has two normal quits plus
forced final SIGKILL cleanup, no leaks and verified freeze.

Filter003 on406c/frontend007 fails251/71 after11 complete String cases: twelfth
negated-any source/membership pass, structured reopen fails with raw expression.
Normalweb005 on406c passes all FIVE UI phase statuses/11actions but the whole
campaign fails explicit product-Worker identity: three captured workers have
empty URL/title. Browser/Vite cleanup and final provenance pass. Current reference
bootstrap003/004 stop before input at Page.enable timeout; no loaded-script or
private-socket identity completion, no current visual/logic pass. Owned processes
are cleaned up without leaks. Full safety/filter/heavy/current reference and
final integration remain open. Later completed campaigns are recorded separately
after this immutable archive cutoff; no running campaign is counted as passed.

Part006 preserves exact reports/source/dist checks and excludes all owned
profiles and vendor captures/code. Preserve ignored archives001–006 before
retiring the implementation worktree. The coordinator's94/94 and31/31 composed
focused passes below are stdout-only facts, with no saved logs. See
[the factual runtime history](history/bases-resume-validation-20261026.md).

Current coordinator update (2026-10-26): reviewed fixes composed at 24b71f94:
full-workspace recovery notice 099cbf5b→931cc40a, accepted sidebar write drain
8e874073→ecc4cee0, browser frame observation 7ddbbde0→c087c33a, shared panel
close fad35d28→8110962b, Config controls 9149f989→9d577061, and genuine Layouts
checkpoint faults b5e9e6ef→24b71f94. Composed focused checks: 94/94 plus
31/31 PASS, zero skipped. Desktop007/8948 PASS including TypeScript, producer
24b71f94; receipt `/private/tmp/zorid-bases-20261026-products-001/frontend-receipt-007.json`.
Rust/native/CLI unchanged. No new native acceptance is inferred from these tests.
At that earlier checkpoint Safety006 was next; its completed result is above.
Root retains ownership of the sole app lane; reference workers are source-only.
Main remains clean at e7d655e1. Continue through the remaining runtime gates and
reviewed main integration; status questions do not pause the authorized work.


Checkpoint prepared after Safety005 on frozen root `c483d861`. Reviewed scalar
failed-save focus restoration `c48a217a`, genuine inline checkpoint-fault relay
`ec2fe727`, passive native failure receipts `00e893df`, and normal streaming
observer `c483d861` are composed. The observer's25 focused tests pass0skip.
Desktop006/17513 passes including TypeScript,333files, producerc48a217a; later
changes before this freeze are harness-only. Receipt
`/private/tmp/zorid-bases-20261026-products-001/frontend-receipt-006.json`.
Native403cbeb8/CLI8e4e61e4 and Rust07265 remain unchanged. Main remains e7d655e1;
no full-feature acceptance or main integration is claimed.

Safety004 FAILS110actions/22checks, four scenarios passed. Actionable path-reuse
feedback and exact retained8/file protection pass, but Escape fails to dismiss
the editor and later configuration stays blocked. Actual key-time focus was not
recorded; the focus-loss cause has separate regression evidence. Safety005/54587
is now TERMINAL1, not running:135actions/24checks, first FIVE scenarios passed.
It captures actual owned input8 focus before one Escape, then passes cancellation
and the unapplied-draft close guard. The sixth named-reference scenario stops
at absent Save recovery copy in .native-document-notice while the view rename
retry remains visible. Seven later scenarios are unexecuted: no current C2
publication runtime acceptance follows from the new relay's source alone.
Both runs have two normal quits followed by SIGKILL cleanup, no leaked children
and source/artifact freeze verified. `bases_path_reuse` owns isolated diagnosis
of the named-reference recovery route; do not invent its cause from the selector.

Normalweb003 enters Workspace and issues one New note action, then its legacy
version6 observer rejects the source-declared version8 streaming contract.
Normalweb004 on c483 advances through the initial v8 note/source check and five
UI actions, then its renderer-evaluated rename readiness expression throws a
SyntaxError. Neither run completes a phase: one failed/four unexecuted each.
Both owned Chrome processes exit 0/nullsignal, Vite closes, cleanup failures are
empty and final provenance verifies. Schema source audit/observer25test passes
remain separate from normal-web UI acceptance. `bases_acceptance_audit` owns the
isolated readiness-expression diagnosis. Root coordinates further serial app
passes; workers have no independent runtime/build grant.

Completed evidence now has append-only archive parts001–005 under ignored local
`tmp/bases-validation-20261026/`, with per-file/archive hashes and profile
exclusions. See [the factual runtime history](history/bases-resume-validation-20261026.md).
Preserve those archives before retiring the implementation worktree. Historical
failures remain failures; safety beyond scenario5, all typed-filter cases,
heavy-user, current reference/visual, normal-web completion and final integration
remain open. Recovery002's three authored protocols, Properties001, CLI and
browser semantic passes retain their exact recorded source limits.


Earlier coordinator state: root92887ca4 composes reviewed filter advice76bcf6db
as43b21f6f, reviewed public filter-close acknowledgement4da3a735 ascf00a2a2,
and reviewed definitive saved-source changed-message931280fa as92887ca4.
Root21 advice tests and10 close/message tests PASS 0 skip. Desktop005/1538 PASS
inclTypeScript, producer43b21f6f; later changes are test/docs plus desktop preload
message handling, not renderer source. Receipt
`/private/tmp/zorid-bases-20261026-products-001/frontend-receipt-005.json`.
Native/CLI remain403cbeb8/8e4e61e4, Rust07265 unchanged. Mainclean e7d655e1.

Recovery002/42961 PASSES36actions/36checks/all 3protocols, five normal quits plus
one intentional lost-create SIGKILL interruption, no leaked children/freezeTRUE.
Properties001 PASSES188/65 before the final summary-Tab/filter-advice changes.
CLI125/17 and browser19groups/162typed expectations PASS. Durable factual history
[and archive manifests](history/bases-resume-validation-20261026.md) preserve
all results/limits. Parts001–004 are under ignored local tmp; preserve them
before retiring this implementation worktree.

Safety003/73430 FAILS107actions/22checks: first FOUR scenario statuses pass,
then actor path-reuse error feedback does not match accessible changed-file
message. Both replacement6 and retiredoriginal3 physical bytes are exact; input8
remains visibly retained. Generic host error code was NOT captured; inode/native
source diagnosis is separately labelled inference. New preload message fix is
reviewed/tested but needs actual rerun. Fresh partial-clear acceptance follows
normal restart/freshness; it is NOT exact native replay of the earlier stale9/
physical7/late-import7null race. That source guard has separate causal tests.

Filter002/58096 FAILS315actions/99checks after15Stringcases and list-exact
remove/re-add checks; close-key pending-ack phase is a tested causal model,
not captured 002internalstate. Fresh advice+close readiness need native65-case
acceptance. Normalweb002/8977 reaches actual Workspace but fails all5phases
unexecuted because uncorrelated favicon404 was classed as a runtime error;
module-loading failure is gone. A strict correlated ambient-error/fatal-wait
TEST-only successor is under review; no retroactive pass or asset substitution.

Current Obsidian1.14.5 bootstrap001/30590 stopsPREINPUT on an unsupported
page-title version guard,0phases/0inputs. Owned cleanup/real-user socket identity
monitor pass; actual owned private-socket lsof gate was unexecuted. Successor
source records target metadata plus exact loaded script identity before any
input. No full13/visual reference runtime acceptance or concurrent app grant.
Root starts fresh Safety004 next; workers remain source-only in isolated trees.


Current root update: reviewed enhanced-summary explicit Tab commit78cc48f9
composes a8086315; root19 relevant tests PASS 0 skip, independent30/30 approved.
Desktop003/5716 PASS inclTypeScript, receipt
`/private/tmp/zorid-bases-20261026-products-001/frontend-receipt-003.json`.
Reviewed reproducible normal-web harness3478b100 composesb9a60f39, actualruntime
pending. Root now owns the sole app lane for fresh Recovery002; no other app or
heavy build is running/authorized.

Actual Properties001/22470 PASSES188actions/65checks, all four layouts and C1
shared summaries, exact sources and restart on9e589589/frontend002/native403.
It precedes the enhanced-summary Tab fix; no full heavy/safety/recovery acceptance
claim. Safety002/87569 FAILS6actions/1check in setup: expected grid rowcount3
omitted actual summary footer (two records+header+footer=4). NoAinput occurs;
clean SIGTERM0/no leaks/freeze true. bases_safety_setup owns correction plus real
renderer regression; original synthetically constructed test missed the footer.
The independent product navigation fix remains valid and separately tested.


Latest 2026-10-26: CLI99317 PASSES125commands/17checks, browser 30342 PASSES
19groups/162typedexpectations/16Q3diagnostics on currentRust07265/core products.
Fresh reports are archived under ignored local
`tmp/bases-validation-20261026/fresh-validation-001.tar.gz` with verified per-file
manifest. Raw historical evidence absence is not repaired by these fresh passes.

Safety001/41873 FAILS7actions/1check before ordinary editor setup: explorerA
click13ms after Split right command, twoBases remain; ownedSIGTERM0/no leaks,
freezeverified. Independent actualWorkspace regression proves an uncovered
initial destination-render navigation race; reviewed fix0e628f31 composes as
7e12ab41. Reviewed explicit split/note-mode setup7eb2609f composes11c246a9.
Root25 composed navigation/setup tests PASS 0 skip; desktop002/90921 PASS incl
TypeScript on74dcc2a9. Current frontend receipt
`/private/tmp/zorid-bases-20261026-products-001/frontend-receipt-002.json`.
Reviewed visual provenance63262c21 composes74dcc2a9; actual current reference
capture and visual comparison are still pending.

Recovery001/7413 FAILS28actions/24checks: genuine checkpoint failure/original
retry/automatic newerB continuation plus exact restart PASS, then held acceptedA
plus newerB/close retains B but enhanced editor Tab cannot resubmit. User sent
native close-blocked dialog screenshot during this disposable-vault campaign;
it is data-preservation behavior, not a full recovery pass. Last owned app
requiredSIGKILL cleanup/no leaks; first two normal quits exit 0; freezeverified.
`bases_recovery_close` owns the causal native-fallbackPASS/enhancedRED commit
bridge fix; `bases_seam_review` owns independent review. No native acceptance yet.
Filter001/38152 FAILS88actions/33checks after five full String cases; immediate
operator model rejectsnotEndsWith after changing property, readiness diagnosis
owned by bases_filter_readiness. Expected exact sources/members remain unchanged.
Root starts fresh Safety with reviewed navigation/setup on the new frontend;
other workers remain source-only in isolated worktrees, no concurrent app/build.


Resume 2026-10-26: root isolated branch composes ordinary property physical
source guard `b2ff6666` (reviewed originalff7750e7) and published table-history
readiness `4453e584` (reviewed original641559da), plus historical reference006
recordf4524757. Root63 focused tests pass0skip, including actual shared-buffer
paste/history lifecycle, property guard/retries and registry reconciliation.
Desktop build6367 and cached native/CLI rebuild both finish0; Rust remains
07265b1d. Fresh receipts and preserved executables:
`/private/tmp/zorid-bases-20261026-products-001/{frontend-receipt,native-receipt}.json`.
Native SHA403cbeb8 and CLI8e4e61e4 match earlier products. No new Rust runtime
changes or full-suite acceptance are claimed. Main stays clean e7d655e1.

Most historical /private/tmp evidence, native copies and private normal-web/
reference harnesses are no longer available after the interruption. Committed
records remain historical. Do not reconstruct missing raw artifacts as observed
facts. Current Obsidian is1.14.5; `bases_reference_resume` owns explicitly new
bounded REA reference provenance and later capture recovery; no app launch grant.
`bases_acceptance_audit` owns isolated reproducible normal-web harness authorship.
Root owns the sole native app/build lane and begins the fresh safety campaign
with original exact conflict/recovery assertions and reviewed freshness setup.
No worker may launch an app/heavy build concurrently. Full completion and main
integration remain pending.


Latest root update: isolated `f10da606` composes independently reviewed split
navigation `e852ff26` (original14663e60), registry physical saved-source Apply
`29128ef6` (original8c216414), and top-level Null display `f10da606`
(originalae08febe). Independent composed seam review finds no issues; root42
focused tests pass,0 skipped; desktop frontend012/36280 terminal0 including
TypeScript. Receipt `/private/tmp/zorid-bases-final-fixtures-desktop-build-20261022-012-receipt.json`.
Matching native/CLI96560 finished0, Rust tree07265b1d, native403cbeb8/CLI8e4e61e4;
receipt `/private/tmp/zorid-bases-final-native-07265b1d/receipt.json`.

Actual selection003/2985 PASSES60actions/11checks, including caret and nonempty
selection preservation across frontmatter length changes, full source checks,
and normal quit/restart. Frozen75270dc8/current native/frontend011; both normal
quits exit 0/nullsignal/no leaks and source/artifact freeze verified.
Actual safety011/33817 fails44actions/7checks at top-level Null displayed as
literalnull after correct durable partial clear. Reviewed display fix above
preserves storage/coercion and all original blank-cell assertions.

Fresh safety012/36388 FAILS44actions/6checks BEFORE that display assertion:
A physical score is string `7null`, not Null, after shared-body/history and real
independent CLI B conflict setup. Evidence
`/private/tmp/zorid-bases-safety-current-20261022-012/result.json`; original
oracles unchanged, source/artifact freeze true, owned SIGKILL cleanup/no leaks.
This is a new observed data-integrity blocker, not a completed safety pass.
`bases_controller` owns isolated causal diagnosis. `bases_relations` separately
audits same-session clean registry buffer refresh after genuine external
reconciliation; `bases_e2e` identified unsupported immediate fresh-reopen
precondition. No authority to weaken CAS or adopt captured physical text.

Private typed reference005 passed baseline, String operator catalog, prefix/
inverse and containsAny, then failed a source YAML read on containsAll; remaining
scenarios unexecuted. Source-reviewed typed006 manifeste813269f receives a
once-only runtime grant to bases_ui_review after safety012 cleanup; it owns the
sole app/heavy lane. No other app/build is authorized concurrently. Native
option probe001 failed after nested AX selection plus Return closed the dialog;
no native SELECT acceptance is claimed. Full safety/recovery/typed UI/heavy-user,
visual/client refresh and main integration remain unfinished. Main remains
`e7d655e1`; no integration or full acceptance claim.


Latest validation update: root `4b7b0fe3` includes reviewed Store TEST-only
corrections18b1db50 (original35c162d7), selection readiness9146037b (original
b1e8d058), and strict public CLI envelope parser4b7b0fe3 (original68a88dcc).
Store run4429 PASSES269 tests across all5 requested targets,0 failures and2
pre-existing ignored cases: all four failed targets from full62319 plus the
guard regressions. Receipt
`/private/tmp/zorid-bases-store-corrected-validation-20261022-001-receipt.json`,
Rust tree07265b1d344e89cd84c2fae143c4c4ab8678c2ca. Other full62319 targets had
already passed. Do not relabel the historical62319 exit101 as a passing run.
Current matching native/CLI rebuild96560 is active, log
`/private/tmp/zorid-bases-final-fixtures-native-cli-build-20261022-001.log`;
no owned app is running and no other heavy lane is granted.

Actual safety010/1162 still stops39actions/6checks. Its independent CLI writer
really commits successfully, but the helper incorrectly reads commit from the
root of the public version1 response instead of result.commit. New strict
parser is independently32/32 passing and replays the retained actual stdout;
core/source/checkpoint/intent/cleanup checks remain unchanged. Actual010 stays
failed; main app required SIGKILL cleanup, no leaked children, freeze verified.
Properties009 passing evidence is now recorded in
[its factual history](history/bases-native-properties-009-20261022.md).
Private reference005 is source-approved at manifest5c4d406f: owned popup uses
one Shift+Enter, owned closed suggestion state uses one ordinary Tab blur.
No reference005 runtime grant/execution yet; both literal routes retain all13
source/member oracles and prior evidence/profile/vault/catalog guards.

Latest acceptance update: root `9f7b1b69` composes reviewed standalone config
guardffcf4d8c (originalf81d305e), inline guard18e5d170 (originald5f36d6b),
picker-actionability cd841779 (original8aaf3cac), and selection campaign9f7b1b69
(original25227afb). Composed TypeScript11690 passes;34 focused Node2106 pass.
Frontend010/76384 passes on this exact root,333files; receipt
`/private/tmp/zorid-bases-conditional-desktop-build-20261022-010-receipt.json`.
Actual properties009/75682 PASSES188actions/65checks, all4layouts, C1 shared
summaries/four-reference rename/delete and two normal quit/restart passes.
Report SHA6dca1f17c8331d5d73f73cd3a0ef6a602aa2a1702aed52a1a9c0cc4882b61898;
both app lifecycles exit 0/nullsignal/no leaks; source/artifact freeze verifies.
This is bounded rich-property acceptance, not full heavy/reference/main acceptance.

Full Rust62319 is terminal101:1164 passed,7 failed,2 pre-existing ignored cases,
50nonemptytargets. All Bases/native259/host87 pass. Four Store targets fail;
source audit attributes obsolete v2/3/4 fixtures/revision expectations/corrupt-FK
injection/fullsnapshot-test routing to pre17 code, and the oneMiB snapshot has
only the new empty host_intent_sources table difference. Test-only reconciliation
is isolated with bases_inline_core, independently reviewed before Cargo; no
runtime migration policy or planner changes authorized. Full raw receipt
`/private/tmp/zorid-bases-conditional-composed-rust-20261022-003-receipt.json`.
All30 new guard cases pass within this run. This is NOT a full-suite pass.

Actual selection001/18791 fails45actions/3checks after its first caret mapping
and exact physical source pass. Its second ordinary double-click fires while
the Base query is updating; no input opens. Source/artifact freeze and owned
SIGTERM exit 0/no leaks verify. bases_e2e owns test-only readiness correction;
nonempty range preservation remains unexecuted. Reference004 verifies baseline
and exact14-item String operator catalog, then Enter chooses existing alpha-one
instead of intended literalalpha; private005 uses shipped Shift+Enter literal
behavior and awaits independent source review/runtime grant. All prior reference
owned apps/profile/vault/catalog restoration pass; no owned app remains running.

Reviewed real CLI conflict fixture original476d8b32 is composed next: unchanged
strict core/source/intent/checkpoint checks, accurate retained external conflict
classification (reload OR planning), normal body append instead of duplicate
frontmatter input. Actual safety run must explicitly pass matching CLI path/hash.

Latest resource/resume update: observed free5898764KiB after the user status
request; no additional cleanup is attributed to this session. Native/CLI
build76433 ended101 at ENOSPC in clap_derive; fresh serialized build19034 is
running with restored headroom, log
`/private/tmp/zorid-bases-conditional-native-cli-build-20261022-002.log`.
Root `ed225fae` composes independently reviewed sidebar race campaign87c1630b;
16 independent protocol/fixture tests pass, actual race remains unexecuted.
Earlier proposed live-summary failure fixture51b772d1 is WITHHELD: review proves
ordinary summary saves lack the conditional source check, so public parent
permissions would permit logical commit plus pending projection. Author now
owns a revised test-only genuine checkpoint-I/O fault against the disposable
vault.lock; no production guard is being added to make the fixture work.
`bases_core_review` separately audits ordinary config stale-physical-save safety.

Continuation update: isolated root `7d925c33` includes independently reviewed
props007 diagnostics (`cf6ab67f` original), preserving every campaign input,
coordinate, wait and assertion. Independent and composed runs both pass16/16;
composed session69137 terminal0, log
`/private/tmp/zorid-props007-diagnostics-composed-001.log`.
Composed conditional Node62414 is terminal0,134/134 passing.

Rust53036 compiles all affected targets successfully in12m19s, then stops at
two existing loopback binds denied by the sandbox. Escalated rerun82532 passes
those9 fixture tests,15 process tests,87 host unit tests (including5 new wire
tests), and the earlier Bases targets. It later exhausts disk during native
filesystem suites and exits101; its truncated log is NOT full-suite acceptance:
`/private/tmp/zorid-bases-conditional-composed-rust-20261022-002.log`.
Focused executions of the same compiled products separately pass all11 native
conditional-source tests (38270) and14 Store guard tests (84146), logs
`/private/tmp/zorid-bases-conditional-native-focused-20261022-001.log` and
`/private/tmp/zorid-bases-conditional-store-focused-20261022-001.log`.
All30 new Rust guard tests have therefore executed successfully; the broader
affected suite still requires a clean finish. Owned completed23 test executables
retired214940304B, receipt
`/private/tmp/zorid-bases-completed-test-exe-retirement-20261022-004.json`;
no active cache/source/evidence/user data removed. Matching native/CLI build76433
is active, log `/private/tmp/zorid-bases-conditional-native-cli-build-20261022-001.log`.
No owned app is running. User explicitly requests continuing with available space.

New test-only authoring owners: `bases_summaries` owns six recovery-campaign
files for genuine prepared-reply hold + actual precommit filesystem-I/O failure
with newer live-summary input; `bases_controller` owns a new sidebar-race
campaign and its minimal fixture admission registration. Both are isolated from
`7d925c33`; no app/build/Cargo permission or runtime acceptance is implied.

Latest composition/validation update: isolated root `9d133333` now composes
reviewed typed toolbar/provider/campaign through `6c12a6a5` (TypeScript95070 and
220 integrated Node tests89689 pass), plus reviewed conditional-source batch:
Store92639e8f→d0a583b1, Nativecd8f5889→00d1f1e1,
Buffer39a78ee3/aafe1dcf→cb69f001/8e6cda85,
desktop9cdbbf78→9d9b9d03, history3f0c5aee→9d133333.
Store/Native reviews cover30 NEW Rust tests, still uncompiled at composition;
Buffer80, history60 and bridge75 focused author tests pass with independent
source reviews (reviewers personally replayed72/60/75 respectively).
Composed TypeScript87596 passes. Root serialized cold-cache Rust run53036
is ACTIVE: all targets in zorid-store/native/desktop-host/bases, release/offline/
locked/j1/test-threads1; log
`/private/tmp/zorid-bases-conditional-composed-rust-20261022-001.log`.
Composed scoped Node62414 also active, log
`/private/tmp/zorid-bases-conditional-composed-node-20261022-001.log`.
No native/runtime acceptance follows from source composition.

User requests continuing with available space. Completed native compiler cache
retirement5591 files/812021468 logical bytes preserves all26 product hashes,
receipt `/private/tmp/zorid-bases-resume-native-cache-retirement-20261022-003.json`.
Actual free space at this retirement was4526202880→5287358464B; the cause of
the earlier independent space increase is not established. Current observed
2548872KiB. Compiler caches were retired, so run53036 is intentionally cold.
Preserved host/CLI/WASM products remain usable; no source/user data retired.

Desktop build008/55320 passes on typed root6c12a6a5. Actual properties007/45626
fails75actions/17checks at first Kanban status picker after earlier edits/relation/
Cards/List pass. Padding hit has no combobox focus, generic DIV focus disappears
16ms later; no cause proven from current diagnostics. App closes SIGTERM0/no
leaks/freeze verified. `bases_properties` owns only causal regression + bounded
passive target/admission diagnostics in isolated branch; no product fix authorized
without proof. This run does not validate C1's picker fix or restart.

Owned Obsidian reference typed001 stops before target discovery; typed002 admits
exact target/version then baseline locator incorrectly requires A instead of the
shipped SPAN internal-link. Both runs have0 semantic inputs; full owned cleanup,
original18files/3configs and old51-capture catalog restoration verified; unrelated
Obsidian remains untouched. Corrected private003 is source-approved by root at
manifest34b9a48a (exact names+paths, original13 scenarios unchanged), NOT granted
execution while Rust53036 owns the heavy lane. No owned app is now running.

Current continuation update: root `7e66e619` includes independently approved
C1 picker lifecycle fix `12869443` (44 scoped +6 dependent tests pass) and
audited [browser011](history/bases-browser-actual-011-20261022.md). WASM build73113
passes, preserved `/private/tmp/zorid-bases-resume-wasm-e38e2461/receipt.json`;
fingerprint9273555a, WASM c1298e7c. Actual browser4342 passes19/19 groups,
162 typed expectations/16 diagnostics, source/assets/cleanup verified.
Desktop build007/19495 passes on picker source12869443. Properties005/8244 and
006 both stop BEFORE launch at unchanged1GiB disk guard,0actions/0checks.
Owned completed WASM cache retirement1243files/450453613 logical bytes preserves
26 product/source hashes; receipt
`/private/tmp/zorid-bases-resume-wasm-cache-retirement-20261022-002.json`.
Free854667264→1270030336B at retirement, later685492KiB observed. User resource
question requests2–3GB more; no native/compiler app is currently running.
Do not repeatedly retry the guard without changed resource evidence.

Safety007/92421 fails33actions/6checks AFTER durable Base undo/redo successfully
preserves unrelated external content. Next touched-property case changes physical
score9→7 before the30s family rescan. Base history correctly routes but accepts
logical core9→1 against stale core/buffer; physical source7 remains protected
and exact (SHA3bb9062e), with pending projection. Read-only native diagnostic
receipt `/private/tmp/zorid-safety007-core-readonly-001/diagnostic-receipt.json`
SHA b3415213 records intent66 and unchanged originals. App SIGTERM exit 0,
no leaks, freeze verified. No physical overwrite or full Undo safety acceptance.

Approved conditional-history boundary now being implemented in isolated branches
from12869443: `bases_inline_core` owns Native/host/Store guarded saved-source
capture (Store child owns additive schema17/table/migration fixtures);
`bases_relations` owns desktop/platform wire; `bases_guarded_buffer` owns shared
DurableWrites DTO, NoteBuffer/DurableNoteState exact-plan/retry plumbing;
`bases_controller` owns existing controller.ts history/mutation-host sections.
Physical source has separate DTO from logical core witness, never replaces
original CRDT base. Compare touched fields against physical capture and latest
draft, revalidate capture before logical authorship, persist proof with exact
prepared intent, retain idempotent/uncertain retry and final no-clobber guards.
No generic mutation/receipt redesign; no Cargo/runtime grants yet.

Typed toolbar7dd46aa7 has147 focused tests passing but independent review holds
three confirmed issues: preserved datetime seconds validity, unknown-category
comparison operand retention, and chip-removal keyboard focus. Author fixes
pending. Provider ordered 0a809ff0→cf557a74→7229c4e1 has15 author tests passing;
latest review pending, including readonly Vault.isMetadataRetired getter and
same-frame wrapper/stale-construction/empty-frame retirement cases. Independently
approved typed native campaign e9453d19 has65 authored cases/9 offline checks;
not yet composed/executed. Private13-phase reference helper is independently
approved but not granted/runtime-executed. All these remain unverified source
work; main is still untouched e7d655e1.

Latest resumed results (supersede running/pending statements below): root
`6fcd58a2` includes reviewed relation lifecycle fix `ef383205` and canonical
recovery fixture correction `e38e2461`. Rust library run47903 passes205 Bases
tests and80 existing host tests, but its two new recovery tests fail strict
SQLite admission through macOS `/var` alias. Test-only canonical-root correction
preserves production guards/all assertions; focused run58881 then passes both
tests, terminal0. Frontend check85529 and desktop build006/62175 both pass.
Matched native+CLI build55913 passes; preserved receipt
`/private/tmp/zorid-bases-resume-native-e38e2461/receipt.json`, crates tree
`dbfc92218e82c6ecb8aeb23027366c37f096f80a`, host SHA3eebb68a/CLI fca404ed.
Frontend006 producer `ef383205`,333 dist files; receipt
`/private/tmp/zorid-bases-resume-desktop-build-20261022-006-receipt.json`.
Actual independently verified [CLI008](history/bases-cli-actual-008-20261022.md)
passes125 commands/17 checks/162 typed expectations/16 Q3+10 legacy diagnostics.
Current-v9 WASM build/browser validation remains pending.

Native properties003 fails18actions/4checks after status-padding click. Passive
trace proves that click hit the status cell; its missing picker cause remains
unknown. Separate Alpha click9.6s later is confirmed user interaction. Safety006
fails7actions/1visibilitycheck before opening ordinary A; no durable safety phase
accepted. Both apps close SIGTERM exit 0/leaked[], freeze verified. User confirms
interacting and agrees to leave subsequent tests untouched. Fresh properties004
then passes124actions/32checks through P1–P6: ordinary relation opens Ada without
rewriting alias, relation add/remove, actual property edits across all4 layouts,
and derived readonly controls. It stops at C1's acknowledged custom-summary editor
return-to-picker assertion. Full C1/restart remains unexecuted, not passed.
`bases_summaries` owns read-only causal diagnosis. Properties004 closes SIGTERM
exit 0/leaked[], freeze verified. No owned app remains running at this checkpoint.
Typed-filter toolbar/provider/campaign batches remain isolated pending review/
composition; provider `0a809ff0` has independent10/10 tests and source approval.

Resume update, 2026-10-22: user explicitly resumed the paused implementation.
Root isolated HEAD `307f801f` composes reviewed host rescan recovery
(`9e46750e` → `87eab7dc`) and Date/String comparison
(`3a312aff` → `307f801f`); both await actual Rust acceptance. Serialized
release/offline/j1 library checks for `zorid-bases` and `zorid-desktop-host`
are running in session47903, log
`/private/tmp/zorid-bases-resume-core-20261022-001.log`. No other heavy build or
owned Electron app was running at admission; free disk3982880KiB.
Main remains untouched. Last verified products remain Rust8074/build004;
new source is not yet represented by those products.

Since the older notes below, reviewed File filter UI, saved-vault operand
provider, immutable typed group projection and scoped harness routes were
composed through `b3e4a300`. File UI has93/93 independent focused tests and4/4
edge probes passing; provider6/6 and harness3/3 pass. Desktop build005 stopped
at TS2352 in filter group projection; `1d7b1ada` fixes that with8/8 focused
model tests, but desktop rebuild remains pending. Native safety005 established
a physical-file publication gap after conditional Undo (core/UI score1,
physical score9), addressed by the pending host fix above. Properties002
still fails ordinary-note relation rendering. Private real-metadata replay
isolates self-cancellation during same-frame stale/current notifications;
`bases_embeds` owns the manager + focused tests on isolated
`codex/bases-property-target-lifecycle`. `bases_toolbar` owns the next typed
filter controls on `codex/bases-typed-filter-ui`, with `bases_session` owning
the separately coordinated readonly descriptor seam. `bases_e2e` owns the
single CLI fixture inventory assertion146→162. No runtime acceptance is
implied by these assignments or source reviews.

Current as of2026-10-22: isolated branch `codex/types-bases-model`, worktree
`.worktrees/types-bases-model`; root is sole main integration owner. Main remains
`e7d655e1`. Full [implementation goal](plans/bases-implementation-goal.md) is active,
not complete. Ordinary files/properties replace mandatory named note Types;
deferred Tasks/Calendar Type consumers and their data remain intact.

Current Rust tree `8074eabf01c55cf4e53f01c02a5a384197875a24` has **361 tests /
20 nonempty targets passing**, including the unchanged500,000-step preview.
Full log `/private/tmp/zorid-bases-date-final-full-composed-002.log`, SHA
`de189d3ce6f8bfc02a1dc7fe96b2682ab3adab601a2b821beb28c21be155920f`.
Matching native/CLI build9637 and WASM build48653 both completed successfully.
Preserved product receipts:
`/private/tmp/zorid-bases-final-native-8074eabf/receipt.json` and
`/private/tmp/zorid-bases-final-wasm-8074eabf/receipt.json`.
Native host SHA6e04fb5f, CLI 3fdcdbdc, generated WASM8f9d8d63;
WASM build fingerprint6041e8e6. Older958 and5e products are historical evidence.

Current-core standalone [CLI007](history/bases-cli-actual-007-20261022.md)
passes125 commands/17 checks/146 typed assertions, exact16 Q3 plus10 legacy
warnings. Actual [browser010](history/bases-browser-actual-010-20261022.md)
passes all19 groups/146 typed assertions/16 Q3 diagnostics with no unexecuted
groups and verified source/assets/cleanup. Normal supported-web
[003](history/bases-web-ui-actual-003-20261022.md) passes5 actual note UI phases:
create, trusted edit/durable save, reload identity/source, search and reopen.
These are scoped client acceptance, not full rendered Bases/native parity.

Reviewed C2 own-save publication/selection fix is composed at `f7e3bf4a`;
independent full scoped Node tests89/89 pass. Exact host/fence/lease handoff,
per-attempt durable-publication holds, and exact retained generic-save retry
preserve dirty/foreign/stale guards. C2 native campaign now13 phases including
Hover/New failure/retry; C1 multi-view references and C3 live group preview/
cancel/focus/failure scenarios are also authored, actual native acceptance pending.

Expanded Hover portal followup is isolated with `bases_inline_core`, independent
review owner `bases_controller`: exact toolbar/session/manager ownership chain,
connected owned-node revalidation, stable New origin host with original geometry
anchor, and exact New editor portal outside/Escape handling. Source/tests frozen
for final review; not integrated or native-verified yet. No broad portal exemptions.

Root desktop build002 passes (TypeScript plus native Vite bundle), log
`/private/tmp/zorid-bases-date-c2-desktop-build-002.log`. Reviewed `36b170d7`
fixes a readonly group alias assignment immutably;33 focused checks pass.
This build consumed that exact source diff before its commit; subsequent
`68ff762c` is a history-only record. Root next owns a frozen native color-select
probe with this frontend and host6e04fb5f. No other owner may build or mutate
this worktree during the runtime freeze. Latest measured free disk2158260KiB,
above the unchanged1GiB guard; recheck at each launch.

Latest prior heavy Electron016 reached244 actions/29 checks on OLD Rust5e010112 /
host176fcff5, then native color SELECT failed expected purple readback. Rich
property durable edits passed there; current-core full native behavior remains
unproven. Complete fresh heavy run, safety13, properties/C1, config, layouts14,
actual clipboard/IME/recovery,23 matched visual states and main reconciliation/
integration are still required. Do not infer native completion from Node/client
passes. Production app47540 and unrelated user vaults/apps remain untouched.

Latest composed followup `0d660bb1` integrates reviewed Hover ownership source;
independent141+3 focused cases pass. Fresh desktop build003 session22473 is
terminal0 (TypeScript and native Vite), private receipt
`/private/tmp/zorid-bases-date-c2-desktop-build-003-receipt.json`, SHA
`333613bc5bbf321f56f22b9a17dd11e1f381a1331160700566371613534e20fe`.
Actual native-select-current003 on pre-Hover `ba37415b` reproduces strict purple
readback failure:45 actions,23 passive frames show connected enabled focused
SELECT with menu open but unchanged default value through CDP keys. Input-route
cause remains unproven; optional computer-use checkpoint is being prepared by
`bases_e2e`, independent reviewer `bases_core_review`. SIGKILL cleanup has no
leaked owned processes; frozen source/artifacts verified. No app-product fix is
inferred from this automation failure.

Actual safety-current002 on `0d660bb1` uses default hidden window, fails11actions /
0durable checks at first Base cell while showing Loading saved results. Source
suggests hidden renderer refresh suppression; report lacks renderer visibility,
so exact causality is not established. Visible-window003 advances through23
actions /4 durable checks (shared dirty-body+property write, editor undo/redo)
then fails exact cell text readback after unrelated external edit. Both reports
and failed traces retained under `/private/tmp/zorid-bases-safety-current-20261022-*`.
`bases_controller` owns causal followup; no weakened checks or product bypass.
Visible003 app cleanup requires SIGKILL, no leaked owned processes; freeze verified.
All owned apps are now closed. These are partial failed runs, not safety acceptance.

Visible safety003 followup: controller reproduced a product focus bug in the
real Table+property widget composition. Widget click prevents default and opens
its input; the sibling cell listener nevertheless focuses the cell, so Escape
cannot cancel its editor and text readback remains empty. `bases_controller`
owns a minimal `table-view.ts` defaultPrevented guard and regression, independent
review `bases_inline_core`; no source correction composed yet. Preserve range
capture and existing widget actions; do not weaken cell-value assertions.

Visible properties-current001 on same build003 (docs-only source `0f81c1e5`)
passes34 actions /10 durable checks through text/tags/plain links/status and
picker-created select/multiselect options, then fails ordinary-note relation
readback: last Alpha tree click is followed by Properties.yaml viewer rather
than Alpha. Native closes SIGTERM exit 0, no leaked owned processes; freeze
verified. `bases_embeds` owns causal investigation, no confirmed cause/fix yet.
Do not mark remaining property/layout/relation/restart scenarios passed.
Optional CUA native input checkpoint remains isolated with `bases_e2e`, review
`bases_core_review`; it must preserve normal default campaign behavior and
strict selected-value/save/file oracles. No owned app is currently running.

Current source includes reviewed rich-cell focus fix `f6731180` and optional CUA
checkpoint `81dfeb1e` (26 independent checks pass). Desktop build004 session92808
is terminal0; receipt `/private/tmp/zorid-bases-date-c2-desktop-build-004-receipt.json`,
SHA `d3fd606ed7c9af9354f5222722a5309341533d82611792add464a4f182608add`.
Frontend producer f673; later81df changes harness only. Safety004 aborts before
launch at unchanged1GiB guard,0actions/0checks.

Owned-cache retirement93570 completes:1283 reproducible WASM compiler/test files,
609860424 logical bytes; free526991360→1087651840 bytes. All8 preserved product
hashes unchanged. Source and evidence untouched. Receipt
`/private/tmp/zorid-bases-date-v8-cache-retirement-20261022-001-result.json`, SHA
`ac0c9ec2413a1957b6e87012e02f86a82c4daeb1987c9dec3ebdc640fc3dded6`.
No compiler was running; these caches require rebuilding if invoked again.

Actual native-select-cua-current001 on81df/build004/host6e04 fails18actions /
1visibilitycheck: exact owned Electron96184/window5258 verified; CUA original
Home,8Down,Return reaches **blue**, not strict requiredpurple. Four passive
frames and adjacent CUA receipt retained. No fallback/value assignment or Apply;
durable checks remain unexecuted. Freeze verified, SIGKILL cleanup has no leaks.
Next separate usability probe must inspect/select the actual visible Purple item.

Disk falls again:335692KiB then121344KiB observed. Native guard unchanged; root
requests2–3GB free through asynchronous user resource question. A heredoc-based
checkpoint write fails before edits due temporary-file ENOSPC; this smaller patch
records the state. All owned apps are closed. Continue source-only review where
possible; do not mark full goal blocked from this first resource failure turn.
Properties-only passive observer remains isolated with `bases_embeds`, review
`bases_duration_review`; main/visual prep review owner `bases_core_review`.

Further source-only progress: root `dc97b3db` integrates independently reviewed
properties-only passive navigation tracing (10 checks pass). Original campaign
actions/oracles remain byte-identical behind a wrapper; bounded/redacted events,
UUID ownership, nonfatal observer diagnostics and cleanup uncertainty are explicit.
No navigation cause or actual rerun is established. Reviewed visual23-state plan
`af35cf39` and pinned main-reconciliation report/383-file blob manifest `deefaa9c`
are composed. Main remains untouched; captures/runtime acceptance remain open.
Reviewed `accb163f` aligns goal wording with latest best-Zorid-UX steering while
preserving capability, reference comparison and correctness/verification scope.

Fresh focused REA confirms a required Filter UI gap: File hasLink/inFolder/
hasTag/hasProperty plus inverses, variadic tags, and a local initial blank row
that does not save/change counts or membership. Rust already supports methods.
Evidence `ev_fb9e582334192943dc316a609f2e7216fc4f4e8cda4b6e0fc8578dbd3e1be86e`:
four derived13,402-byte files parsed, no failures; graph explicitly partial.
Private provenance `/private/tmp/zorid-bases-filter-reference-20261022/provenance.json`.
`bases_toolbar` now owns isolated `codex/bases-file-filter-operators` in reused
`.worktrees/bases-toolbar` fromaccb163f: toolbar/config, new filter/draft/operand
helpers, focused tests and narrow CSS. `bases_session` owns ONLY additive
session.ts snapshot wiring plus tests in a separate isolated branch. Contract:
optional `filterOperands()` readonly files/folders/tags/properties plus honest
metadataStatus; no TS body parsing or new authority cache. New incomplete rows
stay local; invalid edits to existing accepted clauses preserve authority/block
unsafe save. Advanced/nested filters and stale/CAS/retry guards remain required.
Implementation/review/runtime acceptance are pending. Full goal remains active.

User reports clearing disk space. Root observes1779772KiB and starts direct
Purple CUA probe002 on `ac58c039`/build004/host6e04. Ready proof owns Electron22766 /
window5452; first CUA AX observation already lacks Property settings and shows
Book topic Writing rather than fixture Design. Root sends NO input, records
this observation and signals control-flow continuation only. Strict run fails
18actions/1visibilitycheck; no Purple/Apply/durable acceptance. Freeze verified;
normal SIGTERM exit 0, no leaked owned processes. Raw owned files independently
show Writing and saved Research option withoutcolor; those changes are not
represented by recorded campaign inputs. Cause remains unproven; asynchronous
user question asks whether they interacted with the test window, answer pending.
Preserve this trace; do not attribute changes to an app or driver without proof.

Free disk later730544KiB, below unchanged1GiB launch guard; do not repeatedly
relaunch. `cc6c7168` integrates independently reviewed optional per-native-select
CUA checkpoints (29 focused checks pass), default UI journeys/oracles unchanged.
Full heavy requires just2 native color handoffs; generalized runtime remains
gated on a successful direct visible Purple probe. Other select controls in
current campaigns use custom widgets. Source-only File filter work continues.

User subsequently confirms they interacted with the earlier test window. Treat
that as explanation for probe002's extra changes, without assuming the cause of
other runs. Disk recovers to about4GiB; no guard was lowered. CUA003 rejects an
incorrect supplied frozen HEAD before launch (root input mistake); corrected
CUA004 on319389/build004/host6e04 **passes19 runner actions/5checks**, plus a
separate explicit CUA reopening/recreation workflow. Visible Purple item+Return,
strict readback, real Apply, complete registry, exact unchanged note/Base and
normal quit0/no leaks pass. Reviewed record now [CUA004](history/bases-native-select-cua-004-20261022.md).
It does not accept the original CDP/key recipe or prepared-panel continuity.

Full heavy017 on319389/build004/host6e04 fails240actions/29checks: root's second
Return prematurely applies/closes the settings panel; strict SELECT readback
finds0matches. Recorded as operator-input failure, not a product color defect.
All partial evidence retained; reviewed [heavy017](history/bases-electron-heavy-017-20261022.md).
Next handoff must inspect a screenshot and avoid blind extra Return. Normal
cleanup SIGTERM exit 0/no leaks is not normal-quit acceptance.

Instrumented properties002 fails34actions/10checks on same source:182 passive
events/0drops prove Alpha remains active and author relation is unresolved /
nonclickable, with no later navigation. `bases_embeds` owns read-only causal
investigation of ordinary-note/core relation integration; no pointer fix is
justified. Safety005 onac4fdf/build004 advances past the fixed cell-focus issue,
then fails26actions/4checks: conditional Undo UI shows score1, while physical
A.md remains score9 for45seconds. `bases_inline_core` owns read-only shared
durable-undo/publication investigation; preserve exact disk assertions, no
weakened oracle or TS relation fallback. Both apps close normally via SIGTERM
cleanup0/no leaks, frozen source/artifacts verified. No runtime is now live.

File-filter implementation candidate `da1fee56` is frozen,88 focused checks pass;
independent full source review `bases_controller` active. Preserve authored empty
groups and exact-ack node promotion; new incomplete rows never save. A whitespace
tag-input edge is queued for the correction bundle, not silently waived.
Session operand provider `1d73d472` is independently approved6/6, awaiting matching
toolbar API composition and TypeScript/native validation. Additional typed-visual
operator completeness audit is read-only with `bases_ui_review`. Full goal and
all remaining runtime/visual/main gates remain open.

### Superseded checkpoint snapshot — retained evidence

### Latest execution update

Current Bases branch/worktree: `codex/types-bases-model`,
`.worktrees/types-bases-model`; root remains sole main integration owner.
Main is unchanged `e7d655e1`; the full goal is **not complete**. Current goal:
[implementation pass](plans/bases-implementation-goal.md). Ordinary files and
optional property definitions are independent of named note Types; retain the
deferred Tasks/Calendar Type consumers and their data.

Current date-v8 Rust tree is
`8074eabf01c55cf4e53f01c02a5a384197875a24`. Full run80276 is **terminal0:
361 tests/20 nonempty targets pass**, plus empty doctests. Log
`/private/tmp/zorid-bases-date-final-full-composed-002.log`, SHA
`de189d3ce6f8bfc02a1dc7fe96b2682ab3adab601a2b821beb28c21be155920f`.
First run52969 is retained:198 library cases pass, then two legacy percent-error
expectations stop corpus at6/7; reviewed e509ef71 replaces them with exact typed
`%1`/`%` results, preserving numeric/budget guards. No further source correction.
Root owns sole heavy native/CLI build9637, pinned/offline/locked/release/j1,
log `/private/tmp/zorid-bases-date-final-native-cli-build-001.log`.
No matching date-v8 product/client acceptance yet. New shared fixtures expect
146 typed assertions (same19 browser groups/125 CLI commands), inventory test
updated105bf344; `bases_expressions` prepares CLI007, runtime grant still pending.

Previous complete core/client closure is Rust tree
`958b19aca4666414e956fbb2f406558af5a18366`:

- Full pinned/offline Rust run: **359 tests/20 nonempty targets pass**, plus
  empty doctests. Unchanged500,000-step preview passes. Log
  `/private/tmp/zorid-bases-g9-final-full-composed-001.log`.
- Matching native/CLI build passes. Preserved host SHA8e818002 and CLI SHA39ac0029
  receipts: `/private/tmp/zorid-bases-final-native-958b19ac/receipt.json`.
- Standalone CLI006: **125 commands/17 checks/133 typed assertions pass**;
  exact16 Q3 plus10 legacy diagnostics. See
  [CLI006 record](history/bases-cli-actual-006-20261022.md).
- Actual browser009: **all19 groups/133 typed assertions/16 Q3 diagnostics pass**,
  no unexecuted groups. Frozen checkout `caec33ecb9752979922ae008ab3caffd37194669`.
  Report `/private/tmp/zorid-bases-browser-actual-20261022-009/report.json`, SHA
  `ee24aebc4ad96028addd7223ea82ce6f2ea83c0e9f4031a60f2cc750d36ad221`;
  adjacent postproof verifies source/module hashes unchanged, normal Worker and
  exact asset loads. Chrome67075 exits0, profile absent, Vite55741 closes,
  fixture DB deletes, cleanup/artifact failures empty. Build fingerprint
  `36809d020fb8c1ad52736417717d9b1418b866547f99d62cf347bfbee6250e9b`,
  WASM SHA79563768; preservation receipt
  `/private/tmp/zorid-bases-final-wasm-958b19ac/receipt.json`.
  `bases_expressions` owns the independently reviewed009 history record.
- Normal supported-web002-retry: **5 phases pass**, current module/core,
  normal browser adapter/storage, trusted edit/reload/search/reopen. See
  [web002 record](history/bases-web-ui-actual-002-20261022.md).

These accept the stated core/client campaigns, not full rendered Bases UI,
visual equivalence, native recovery, mobile, sync or stress behavior.
Failed browser006/007/008 are retained; strict reviewed test corrections handle
published Error data's exact 30 diagnostics and omitted authored-empty summary
maps. No production semantic change or relaxed populated-summary checks.

Reviewed source now includes C3 live manual-group preview, cancel/focus ownership
and property-alias preservation (`499acedd`, root33 focused checks pass).
C1 multi-view summary/name guards, C2 mounted/nested/fenced rename and C3
preview/failure scenarios are composed; root fixture/protocol checks10+3 pass.
Their native runs remain pending. `bases_inline_core` owns the remaining C2
selection fix: `src/ui/base-embed-sessions.ts`, `src/editor/live-bases.ts` and
minimal inline-host callback in `src/ui/workspace.ts`, plus focused tests.
A focused actual-Workspace UI test shows own-save acknowledgement alone is
insufficient: CodeMirror constructs the new widget while the old entry is still
attached. Scope now includes stable mapped-fence occurrence identity and a
single-use successful-own-save handoff with exact host/scope/identity/fence/
surrounding-source validation. A binding lease must prevent the old widget's
later disposal from detaching the new owner; consume the handoff before DOM
transfer. No foreign/stale/external cache reuse or dirty-guard relaxation.
`bases_controller` approved this design and is independent source reviewer;
implementation/tests remain in progress, no final source approval yet. No other
worker owns this Workspace/editor seam.

Latest heavy Electron016 reaches244 actions/29 checks on **old Rust5e010112 /
host176fcff5**, not the current359-test core. Rich-property durable edits pass,
then native color SELECT readback fails. Passive diagnostic probe001 aborts
before launch at its disk guard; prepared 002 remains unlaunched. A fresh current
frontend build paired with a newly rebuilt matching date-v8 host is required
for final current-core native acceptance. Existing source-corrected safety/config/
properties,14-phase layouts, clipboard/recovery and23 matched visual states also
need actual runs and review. Main integration/reconciliation remains required.

Disk recovery is now **observed**, not assumed: measured7098920KiB free before
builds,6678268KiB after the full Rust run, above the unchanged1GiB native guard.
Rebuild matching native/CLI and WASM serially, then rerun expanded client campaigns.
Preserved host8e818002 and module36809d are old958; do not use them to claim
date-v8 acceptance. Original raw WASM is byte-preserved beside958 generated files.

C2 independent review also found Hover/New source subscriptions can publish
buffer updates before durable flush/ack; a scoped per-attempt publication hold
and exact generic-retry continuation are required before approval. Named
ownership expands to minimal `src/ui/base-new-item-popover.ts` body/editor defer
hook plus Workspace relevant subscriptions/retry hook; no NoteBuffer edits or
generic Vault suppression. Preserve status/controls, release on foreign text,
and never let an old attempt release a newer hold. Existing delayed-close input
test fails identically on immutable499 baseline and candidate; source causality
is not established, and its normal readiness/ack test must be diagnosed without
weakening admission. `bases_controller` is independent reviewer; Node checks
are bounded/serialized while root Cargo compiles. No native/browser test app is
live. Keep production PID47540 and unrelated applications/data untouched.

### Earlier execution updates — historical where superseded

Named C2 seam ownership: `bases_inline_core` may edit
`src/ui/base-embed-sessions.ts` and the minimal inline-host forwarding/callback
in `src/ui/workspace.ts`, plus focused tests. `src/editor/live-bases.ts` is the
actual renderer path; prefer no edit if exact own-save acknowledgement suffices.
The optional manager callback must run only after successful durable flush and
before peer editor text publication, validating host identity/incarnation,
original fence position/shell and byte-identical surrounding content. It may
advance only that retained entry's exact inline request, preserving the existing
session/selection across its own clean remount. Foreign/stale/external edits,
failed flush and retry remain guarded; no generic source-key relaxation or DOM
selection replay. No other worker owns this Workspace seam.

Browser008 is **terminal1**: all9 original groups now pass, including the strict
30-diagnostic malformed-rollup/restore case and retained-pin/restart sequence.
First Q3 group fails only at its empty overall-summary field expectation;
9 later Q3 groups remain unexecuted. Source contract inspection finds Rust
intentionally omits empty summary maps (`serde skip_serializing_if`) and TS
marks them optional; the CLI oracle already handles this empty default.
`bases_expressions` owns a narrow undefined-only empty-map correction plus
negative cases and preassert capture; independent review is required before009.
Populated summaries, null/wrong types, extra values and all typed/group/diagnostic
checks remain strict. No product semantic fix or WASM rebuild is needed.
Report `/private/tmp/zorid-bases-browser-actual-20261022-008/report.json`, SHA
`6a1a7f48346eae78f0b14f7d94c07d5e4f67ff1f048513f50e58ca963e7840b8`.
Postproof preserves37574722/source/module hashes; Chrome58784 exits0, profile
absent, Vite closes, DB deletes, cleanup/artifact failures empty. Runtime released.

Reviewed C3 production fix is composed as499acedd: live existing-DOM manual
Group preview, explicit keyboard controls, no-write cancel/focus restoration,
external-focus relinquishment and unchanged group-property alias preservation.
Root composed focused run1220 is terminal0,33/33 checks; log
`/private/tmp/zorid-bases-composed-group-reorder-20261022-001.log`.
C3 actual scenarios/helpers are d9f3f031; combined C1/C3 fixture/protocol checks
pass10/10. These are source/contract checks, not native UI acceptance.
C2 acceptance scenarios are composed09cb2326 (3/3 narrow contracts), with strict
file/nested draft/selection and fenced logical-selection checks. Source inspection
finds clean own-fence rename may remount and lose the selected property;
`bases_inline_core` owns a scoped live-bases/base-embed-sessions fix, preserving
foreign/stale occurrence and dirty draft safety. Native matching-artifact
execution remains pending. Reviewed supported-web history is6fefe508.

Browser007 capture-only run is **terminal1 at the unchanged old assertion**,
8 original groups pass/10 Q3 remain unexecuted. Actual payload confirms30 exact
diagnostics:2 author-filter `type` errors (`Cannot convert Error to number`)
and28 property `unavailable` errors (`Rollup relation has invalid or unresolved
targets`) across14 known paths. Empty rows, malformed metadata witness,
metadataComplete=false and relationshipsAvailable=true are preserved. This
confirms the old filter-code expectation is stale under published Error data;
`bases_expressions` owns an exact multiset oracle and negative cases, requiring
independent review before the full008 rerun. No production semantic fix.
Report `/private/tmp/zorid-bases-browser-actual-20261022-007/report.json`, SHA
`4fac737ef889b338891be7ec4080ad278dca99dfc1e520b62a18ea27e73bd600`;
post-run-verification receipt is adjacent. Frozen source955f719e/module36809d
and asset hashes match before/after; Chrome50507 exits0, profile is absent,
Vite closes, fixture DB deletes, cleanup/artifact failures are empty.

Reviewed C1 authored scenarios are composed as1e96b884/83ed8ace: four shared
summary references across two views/properties, exact rename/delete propagation,
unrelated selections/configuration preservation, blank/collision no-write
checks and restart. Actual property campaign acceptance is still pending.
C3 production review found keyboard reorder keys could capture another focused
control after focus leaves the Group dialog; `bases_table` must close this
ownership gap before approval/integration. No source/UI acceptance yet.

Completed supported-web cache retirement is terminal0:700 generated files from
7 exact campaign cache roots removed, actual free-space rise57.08984375MiB;
all271 raw storage/IDB/evidence files remain byte-identical. Receipt
`/private/tmp/zorid-bases-web002-retry-cache-retirement-20261022-001.json`.
No native UI grant;1GiB guard still fails and the user space request is pending.

Actual normal supported-web002-retry now **passes all5 phases**, terminal0,
frozen checkout `099d94edbbfbee7e79160872d1a62bb55e7601a5`, current Rust958b19ac
and matching generated WASM36809d/795637. It uses the normal app's browser
adapter/default vault, not fixture mode: create/title, trusted keyboard durable
source, reload identity/revision/source, rich search and exact result open.
Report `/private/tmp/zorid-bases-web-ui-actual-20261022-002-retry/report.json`,
SHA `256df1ee94d1a8a9635fc99db877c9b218694c127e341b919468e6af9e487758`.
Source/artifact/harness/Chrome postproof matches; owned Chrome38277 exits0 via
Browser.close, server closes, zero renderer exceptions. Initial002 remains a
0-phase sandbox-listen EPERM result. This is supported-web smoke acceptance,
not full rendered Bases acceptance. `bases_docs_model` owns its history record.

Actual browser006 is **failed**:8 original groups pass, ninth fails its expected
unavailable filter diagnostic; all10 Q3 groups are unexecuted. Exact current
WASM was loaded through normal dedicated Workers and source/module postproof
matches. Chrome32183 exits0, Vite closes, fixture IDB is deleted and profile is
absent; no artifact/cleanup failure. Report SHA
`81ec51ba1829ca819f0da6ae7dbaa66d58c82d886fb88fd57e4ca4cde5e299b8` at
`/private/tmp/zorid-bases-browser-actual-20261022-006/report.json`.
`bases_expressions` investigates with independent `bases_duration_review`:
source suggests intentionally published Error data now produces a conversion
`type` diagnostic, while property `unavailable` diagnostics remain. Actual local
payload must be captured before any oracle correction. Original failing
assertions remain; no product regression or correction is established yet.

Completed WASM cache retirement is terminal0:304 reproducible intermediates
removed; actual free space rises363.25390625MiB during that measurement window.
All976 protected files remain byte-identical. Receipt:
`/private/tmp/zorid-bases-completed-wasm-cache-retirement-20261022-001.json`.
Later actual free space falls to 242660KiB; cause is unknown. Native1GiB guard
is unchanged. `bases_controller` may retire only completed web campaign generated
caches, preserving raw profile storage/IDB and evidence; no user/system data.

Acceptance audit identifies three genuine scenario gaps, now owned in isolated
branches: `bases_summaries` C1 multi-view custom-summary references/name guards;
`bases_embeds` C2 mounted/nested/fenced rename binding; `bases_layouts` C3 group
menu/header preview/focus and failed column-order save reconciliation. C3 also
reveals missing production Group-menu live preview/cancellation and unchanged
property-alias preservation; `bases_table` owns toolbar-groups.ts/toolbar.ts and
focused tests. No actual acceptance is implied. Root retains main integration;
main is unchanged `e7d655e1`. Other supplemental/visual/recovery/fullheavy gates
remain open.

Latest actual CLI006 is **fully passing**:125 commands,17 checks (7 original
plus10 Q3),133 typed-value assertions,16 Q3 diagnostic entries plus10 exact
legacy Delta warnings. Frozen checkout is
`5796d3a5b9f75e5ac112a818d30fd34ed683cb5f`; build source `f95ab6be`, Rust tree
`958b19aca4666414e956fbb2f406558af5a18366`, preserved CLI SHA39ac0029 as below.
All250 output/error stream hashes,29 stdin hashes,54 exports and14 physical Q3
sources reverify after terminal0. All125 children close with no signal
(121 exit 0;2 expected exit3;2 expected exit4); no host, Electron or IPC starts.
Report: `/private/tmp/zorid-bases-cli-actual-20261022-006/zorid-bases-cli-m3XxfB/report.json`,
SHA `5b78c104af8bd0c36bad1558ff6acb81e5c15756b8b58542dbe9a02c48149d7b`.
Its post-run-integrity receipt is adjacent. Failed004/005 stay unaltered.
This accepts the expanded standalone CLI campaign, not Browser/WASM/UI/mobile
or complete expression/platform equivalence. `bases_embeds` owns a reviewed
evidence-only history record.

Matching WASM build99325 is now **terminal0** (3m01s), using pinned offline
release tools and one compiler job. The current generated module fingerprint is
`36809d020fb8c1ad52736417717d9b1418b866547f99d62cf347bfbee6250e9b`;
WASM SHA `79563768b5c7c5795bba32daecd67c048e2b882882784251f84c84c59bd6dd37`.
All five generated files and the raw product have preservation/hash receipts at
`/private/tmp/zorid-bases-final-wasm-958b19ac/receipt.json`; source Rust tree
remains `958b19aca4666414e956fbb2f406558af5a18366`. This proves the matching build,
not browser acceptance. `bases_controller` owns bounded completed WASM compiler
cache retirement with all source/products/evidence protected; `bases_expressions`
prepares the expanded actual19-group browser campaign, with no runtime grant yet.
The independently reviewed [CLI006 evidence](history/bases-cli-actual-006-20261022.md)
is composed as `98bceba7`.

UI probe002 remains frozen and unlaunched because the unchanged1GiB native runner
guard is not met. Latest measured free space is268748KiB. A request to free2–3GB
has been sent asynchronously to the user; no reply or disk recovery is assumed.
Main remains unchanged; complete desktop, visual, recovery, supported-web and
matching browser acceptance remain open.

Earlier artifact/runtime evidence follows:

Latest runtime/artifact update: full current Rust closure remains359/20 passing,
crates `958b19aca4666414e956fbb2f406558af5a18366`. Matching native/CLI build72852
exits0 in4m22s. Preserved artifacts and build/source/linkage receipts are under
`/private/tmp/zorid-bases-final-native-958b19ac/`: host SHA
`8e818002330fd37dd64ca316d2b657145e4f7bb7044e66a7b0979326ba4457b0`,
CLI SHA `39ac002915dc6a17c9fd58d477ffb5d3a3dd52b6bc37684c33224a38a6080d3c`.
Both dynamically link only system iconv/libSystem. Reproducible static compilation
caches were retired after terminal/byte receipts; source, products, fingerprints,
raw fixtures and logs remain.

Actual CLI004 stops102 commands/7 original checks on a known diagnostic from the
authored Grace-deletion fixture. Reviewed oracle correction `6513e19b` (root
`c9560248`) requires that exact Delta warning alongside the complete Q3 multiset.
Fresh CLI005 then stops110 commands/15 checks: eight Q3 groups pass, but the
provenance group's ordinary Link DTO path differs from its canonical-path
expectation. Independent source review confirms ordinary inferred Link DTO path preserves
raw spelling, with canonical identity in its witness/asFile; configured relation
display is separate. Reviewed `90ea41e3` corrects that expectation and adds six
explicit raw/canonical checks, bringing authored typed oracles to133 while
retaining125 CLI commands,19 browser groups and16 Q3 diagnostics. A fresh006
run is required; no product code or weakened diagnostic guard is involved. Both failed reports remain
unaltered, all children closed, and artifact/source/stream hashes verify. No full
125-command or127-oracle/16-diagnostic acceptance is claimed. Reports:
`/private/tmp/zorid-bases-cli-actual-20261022-004/zorid-bases-cli-QAGBqc/report.json`
and `/private/tmp/zorid-bases-cli-actual-20261022-005/zorid-bases-cli-5Set89/report.json`.

Native-select001 aborts **before app launch**,0 actions/0 checks: a separate
preflight showed1,219,813,376 free bytes, but the unchanged1GiB runner guard then
failed. Its exact failure-time free bytes were not recorded; no SELECT evidence
exists. Passive guard receipt correction `7cde1237` now records the sample before
the same assertion. Exact compiler/profile cache retirements are terminal with product/protected
file hashes unchanged. Git objects were repacked with `--keep-unreachable`: all
38335 objects remain, with main unchanged and no ref/reflog/pruning operation.
Free space remains roughly58MiB short of the1GiB app guard. `bases_controller`
completed the bounded pure-text dependency compression probe: it stopped after
the first file because actual free space did not improve. All logical bytes and
metadata verify; the other two candidates are untouched and no expanded pass
ran. Receipt: `/private/tmp/zorid-node-text-compression-probe-20261022-001.json`.
Actual space is roughly920MiB; do not infer recovery from allocated-block estimates.
No system/swap/snapshot/user-data changes. Prepared probe002 is frontend
`e6891aa6`, same333 artifacts/native176; it needs a new grant and the unchanged
guard after verified space recovery.
Main remains `e7d655e1`.

Most recent source is `8f18b965`: the reviewed borrowed-name projection fix
passes **196 library tests and all10 preview tests**, including the unchanged
500,000-step small-prepared-subset case. Pinned compiler/rustdoc focused run18736
exits0; log `/private/tmp/zorid-bases-g9-named-key-focused-001.log`. Full current
suite session28887 now exits0: **359 tests across20 nonempty targets**, plus the
zero-test doctest target, all passing. Log:
`/private/tmp/zorid-bases-g9-final-full-composed-001.log`. The complete Rust tree
is `958b19aca4666414e956fbb2f406558af5a18366`. The exact20 passing test executables
were retired only after terminal/hash receipts, preserving source, products and
logs, to recover actual space:
`/private/tmp/zorid-bases-passing359-test-executable-cleanup-20261022.json`.
Root now holds sole heavy build session72852 for matching `zorid-desktop-host`
and `zorid-cli`, pinned tools/offline/locked/release/j1; log
`/private/tmp/zorid-bases-final-native-cli-build-001.log`. No app may overlap.
Artifact/runtime acceptance remains pending even after a successful build.

Actual016 advances to 244 actions/29 checks: multiselect, status, rooted relation,
date/datetime, priority and plain-list mutations all pass durable-file oracles.
The new generic enabled-state driver (`60c7fc46`, root `8cc941cd`) preserves the
journey and all assertions. The next native option-color select fails its
keyboard value readback after Home/eight Down/Enter; its pointer receipt is
enabled, but per-key value/focus/open state was not captured. Cause remains
unproven.016 is terminal with exact owned processes[]; all 333 reused015 artifact
hashes and provenance match. `bases_ui_review` owns its independently reviewed
evidence record; `bases_e2e` owns passive select frames and a minimal normal-UI
native-select diagnostic campaign, with no recipe change or value injection.
Its actual run must wait for root's Cargo slot. Main remains `e7d655e1`.

Earlier composed-source and diagnostic evidence follows:

2026-10-22 isolated root `60c1d4fd` composes checked Object stringification,
captured Link raw coercion, bounded immutable clone preparation and pinned English
ICU numeric/base-sensitive List sorting, in addition to the regex/File/title/date
changes. ICU dependencies fetched successfully and the complete new library
compiled. First execution passes183/185 library tests; the only failures are two
expected JSON numeric representations (`1.0` versus the existing integer `1`
projection). Reviewed fixture-only correction `8704d3c7` is composed as
`e8a37c86`; rerun passes **185/185 library tests**, log
`/private/tmp/zorid-bases-g9-composed-lib-003.log`. No production conversion or
assertion strength changed. The full current suite terminates101 in
`/private/tmp/zorid-bases-g9-full-composed-001.log`: library185 pass, but the
unchanged preview budget regression fails again at comparator scratch after
the G9 conversion integration. `bases_summaries` owns source/metering diagnosis
with the conversion owner advising. Independently reviewed `67f16e52` is now
composed as `1e9a7f25`, consuming an already-admitted String property key without
a second rendering copy; its five new cases and unchanged preview need actual
execution. Root focused run45711 now terminates101: all190 library tests pass,
but preview still ends9/10 with the same budget failure. `bases_summaries` owns
the completed query-only A/B diagnosis with pinned tools: current comparator
total507857 versus baseline497182, identical admission486120. The10675-step
delta exactly matches1525 checked literal String imports. Baseline final total
is498540. Both temporary probes are stripped and their logs/source receipts are
retained under `/private/tmp/zorid-bases-g9-cost-*`. The next authorized source
optimization uses lexer-safe named query properties and borrowed AST names to
eliminate real projection-key allocations, retaining arbitrary-name quoted
fallback and actual scan/cancellation/import guards. No product or test ceiling
has changed. Preserve the existing500,000 ceiling and
real work/cancellation/allocation checks. Later targets are unexecuted in this
run. Library success is not a complete current-core pass.

The preceding core at `b13a449f`, Rust tree
`5648d13caedc5b75eba763fba602c9d103de42b4`, passes the complete suite:
**317 tests across20 targets**, plus the empty doctest target. Both RUSTC and
RUSTDOC were explicitly pinned in the successful final execution:
`/private/tmp/zorid-bases-regex-file-title-full-composed-005.log`. This includes
the unchanged500,000-step preview regression; duplicate admission charges were
removed without changing that budget. Earlier wrong-rustdoc/partial runs remain
historical evidence, not the final result.

Actual015 at frozen frontend `eeb8646a` / old core5e / preserved native176 now
terminates at180 actions/22 checks. The previously failing numeric edit and the
following checkbox both pass independent durable-file oracles. Numeric frames
show no new rejection and finish ready/no editor. The next topics click fails to
open its combobox; click-time aria-disabled/admission was not captured, so a
closed-gate explanation remains unproven. `bases_table` and `bases_e2e` own
source reproduction and generic driver-actionability review. Preserve the exact
journey/oracles while diagnosing. Run2527 exits1; cleanup proves exact owned
processes[] and the production app untouched.015 evidence record is owned by
`bases_ui_review`. Root focused Cargo session45711 (`--lib --test preview`) is terminal101:
190 library pass, preview9/10. Log:
`/private/tmp/zorid-bases-g9-keymove-focused-001.log`. The measured-probe slot is now released. `bases_summaries` owns the
next named-property source optimization; actual rerun remains pending. `bases_e2e` owns a generic
CDP enabled-state actionability correction plus passive point receipts; no
journey-specific waits or weakened picker/value assertions are authorized.

Actual [Electron014](history/bases-electron-heavy-014-20261022.md) stops at178
recorded actions/20 checks. Its passive receipt identifies a
`configuration-commit` invalidation (epoch61→62) while stale is already true;
versions and cached file witnesses remain equal. Those cached witnesses do not
prove host-authoritative unchanged bytes. A composed controller reproduction
confirms the save lifecycle can expose a current query before its configuration
continuation finishes, admitting a cell edit that its own continuation rejects.
Saved rating1 and draft5 remain preserved; no write guard is weakened.

`bases_table` owns a full configuration-lifecycle readiness barrier plus gates
for beginning new cell edits, preserving accepted drafts, resize queues and all
stale/CAS checks. Independent review found a retained checkbox retry must bypass
the new-begin gate for its own draft; the owner closed that exact regression. Reviewed commit `eeaec9d1` is composed
as root `60c1d4fd`; root new tests pass9/9 and frontend bounded closure passes34/34.
No015 build or app has started. The frontend lane is frozen at `eeb8646a`,
with old Rust tree `5e010112` and preserved native
SHA176fcff5. All owned014 processes are closed. The unrelated installed Zorid app
is untouched. The interim015 frontend lane does not establish new-core or complete heavy-user
acceptance. It remains frozen independently of root Rust changes.

Transport fixtures now contain127 explicit typed row oracles/16 diagnostics,
retaining19 browser groups,14 files and125 CLI commands. Matching final native,
CLI and actual WASM builds, expanded runtime campaigns, supported web smoke and
complete desktop/visual/supplemental acceptance remain open. Main remains
unchanged at `e7d655e1`.

Space recovery preserves source, evidence, fixture data and product binaries.
The exact 30 fingerprinted test executables and13 compiled examples were retired
with hashes, process-use checks and retained source/logs/fingerprints; four clean
completed worktrees were removed while retaining their branches. Receipts:
`/private/tmp/zorid-bases-exact-old-test-executable-cleanup-20261022.json`,
`/private/tmp/zorid-bases-example-vite-cache-cleanup-20261022.json`, and
`/private/tmp/zorid-bases-completed-worktree-retirement-20261022-005.json`.
Lossless compression preserved exact bytes/metadata but allocated-block savings
initially did not translate to free space. Read-only evidence then proved38
owned toolchain files have byte-identical, same-volume originals. Their owned
copies were restored with no-fallback APFS clonefile, preserving original owned
metadata and leaving all source originals untouched; this recovered actual free
space to1,315,323,904 bytes. Receipt:
`/private/tmp/zorid-toolchain-clone-restoration-20261022-001.json`. The unchanged
1GiB actual-run guard still must pass before launch and at completion. Builds
stay serialized; no system snapshots or user data were changed.

2026-10-22 current isolated core candidate `8c2d4c35`, Rust tree
`513fe752302763b12c5658755f2b301a30e3bc05`, passes the complete Bases Rust
suite: **288 tests across17 targets**, zero failures. Retained log:
`/private/tmp/zorid-bases-q3-full-composed-003.log`. Three focused native
property-target tests also pass in
`/private/tmp/zorid-bases-q3-native-targets-001.log`. This supersedes the
compile-not-ready state below; matching product native/CLI/WASM artifacts and
actual expanded transport campaigns remain pending. No build/app is live after
the native test exit. The unrelated installed Zorid app remains user-owned.

Actual Heavy011 stops at171 actions/20 checks. ArrowRight width91 and Home
override removal both pass; the first numeric edit is rejected by the client
stale-result guard and original saved rating1 remains intact. Exact native
timing is unclassified. See [the retained evidence record](history/bases-electron-heavy-011-20261022.md).
All owned test processes are closed. Reviewed passive controller/render/widget
version markers and seven read-only numeric-edit frames are prepared in the
frontend lane at `5082a703`; actual012 has not built/launched. Preserve stale
and durable-save guards while determining whether the result was stale before
opening or advanced during editing.

REA independently confirms a remaining regex construction-phase defect:
malformed literals invalidate an expression even in untaken branches in the
reference. `bases_expressions` owns checked AST literal admission on isolated
branch `codex/bases-regex-admission` from `8c2d4c35`; `bases_summaries` advises
prepare-once/query/summary seams, `bases_docs_model` records the primary evidence.
Admission must retain cancellation/work/memory limits and distinguish malformed
supported syntax from valid JavaScript features unsupported by the portable
engine. No new runtime acceptance follows from this reference audit.

Disk is about222MiB free after completed native tests, below the actual-run
1GiB guard. Recovery is scoped to reproducible owned caches; preserve source,
reports/screenshots and product artifacts. Older verified native/CLI binaries
are cloned with hashes under `/private/tmp/zorid-bases-preserved-native-5e010112/`
so later builds cannot silently change the frontend lane's artifact association.
`bases_ui_review` is investigating additional safe recovery read-only; no build
or app slot is granted. Main remains unchanged at `e7d655e1`.

2026-10-22 root core integration is now `ec313e7f` before this record: reviewed
Duration, collection/Regex identity, exact-source prepared formulas and captured
relation provenance are composed. This frontier is **not compile-ready yet**:
`bases_summaries` is rebasing its owned checked runtime-shape/query/grouping and
prepare-once plumbing onto that exact closure. No native/WASM artifact is claimed
to match it. Before this later composition, the full Bases library passed105
tests, and24 composed resize-queue/UI cases passed. Broader public tests then
found one real relation target-filter sentinel regression (39/40 in that target),
now source-fixed/reviewed in the composed batch; rerun remains required.

Actual visibility bootstrap002 at `2cb72057` passes2 checks with normal quit,
exact owned-process cleanup and unchanged fingerprints. It intentionally uses
the older verified native artifact and establishes **harness visibility only**,
not new-core/Bases acceptance. Native activation results remain diagnostics;
actual owned onscreen/unhidden window and visible document are required.

To continue UI verification independently, `bases_ui_review` owns
`.worktrees/bases-frontend-validation`, branch `codex/bases-frontend-validation`,
frozen `f567857b582ba06ea8eb4af773a0defd7ea4714d`. Its Rust tree remains exactly
`5e010112661da69eb290d6a5edb72d4906e844a1`, matching native SHA `176fcff5…`;
it composes the reviewed new resize queue and visible-window/hover UI. Desktop
build and120 focused UI tests pass. Actual Heavy011 is running in that lane with
`--show-window`, evidence `/private/tmp/zorid-bases-heavy-20261022-011/`.
Root may compose source in its separate core worktree, but no additional app or
heavy build may overlap this slot. This interim lane cannot accept new Q3
semantics or replace the eventual final integrated native/WASM/CLI/UI reruns.

2026-10-22 current isolated candidate `90c7e253` composes reviewed Object/Tag
base and call contracts (`c8be1aed`, `50d47bdd`, `f62174a7`, `8c7f8455`).
Serialized Rust compilation succeeds. The full Bases library passes98 tests,
including14 call-contract tests; the separate public Object/Tag target passes13.
Logs are `/private/tmp/zorid-bases-object-call-lib-composed-001.log`,
`zorid-bases-call-contracts-composed-002.log` and
`zorid-bases-object-tag-composed-001.log`. The initial call-test invocation used
a wrong filter and selected0 tests; it establishes compilation only, superseded
by the exact14-case run. These counts overlap and do not establish full-core or
native/WASM acceptance. Existing native/CLI/WASM binaries still represent the
older `5e010112` closure and must be rebuilt for this changed source.

Reviewed filename hover anchors and genuine visible-window mode are composed.
Properties002 stops before campaign actions on a native CFArray bridge bug;
`90c7e253` fixes that adapter and passes its real read-only native test with
desktop access. Full visible-window startup remains unexecuted. Its source
reviewer's default-sandbox probe failed due to desktop access; the escalated
probe passes without opening/activating apps or recording window content.

Configuration001 stops at initial0 rows. Independent fixture-byte checks confirm
valid notes; the durable namespace had admitted726 of1023 fixture files, with
no Records notes yet. The source owner is adding a bounded read-only admission
precondition while retaining the initially observed UI and unchanged12-row
assertion. Eventual notification refresh and full config campaign remain open.
The UI's unqualified0 during incomplete namespace admission is a separate
recorded UX limitation, not proof of a query/filter defect. All owned002/config001
processes are closed; no heavy process is live at this checkpoint.

Pending isolated work includes strict collection/Link identity, Duration,
group/summary runtime provenance and rapid width-command acknowledgement.
Independent review has caught no-op, failed-query and hidden-query queue cases;
do not mark that resize fix accepted from its first unit tests. New semantic
transport fixtures are being authored independently. Main remains unchanged.

2026-10-22 current composed candidate `a11e0491` includes reviewed editable
hover, exact property-popup ownership and ordinary/New property draft retention.
Root composition passes69 focused hover/property/runner/recovery checks and the
desktop build. The optional visual/properties/layouts/recovery campaigns and
strict fixture/provenance/process guards are composed; their source readiness
does not establish actual acceptance. Main remains unchanged.

Actual Electron010 at `2f0d77a4` reaches166 actions/18 checks: summary selection,
focused ArrowRight resize and the prior focus defect pass. Home reset then leaves
width91 instead of removing the override. A focused pending-save reproduction
loses the second resize command; `bases_table` owns explicit acknowledged-update
serialization and regressions. Exact fingerprints match and owned processes are
closed. Full desktop acceptance remains open.

Properties001 at `a11e0491` reaches34 actions/9 checks, then fails ordinary-note
filtered relation display. Source probing confirms the runner's AppKit-hidden
window suppresses initial note-property target queries: hidden calls0, normal
visible wake calls1. This is a test precondition mismatch, not accepted product
failure or a passed relation scenario. `bases_e2e` owns an explicit genuinely
visible-window mode; the expectation stays intact. Safety001 reaches15 actions
and stops on an exact body newline mismatch, with dirty-overlap preconditions
observed; its author is investigating caret/input versus product cause. Both
campaigns retain evidence and all owned processes are closed.

Browser005 passes all9 groups on the existing Rust closure `5e010112`, including
malformed-metadata diagnostics, exact restoration and retained snapshots; its
evidence record is `57f672f7`. The complete80-registration expression audit is
`2f0d77a4` / `history/bases-expression-completion-audit-20261022.md`; it identifies
real remaining G1–G9 gaps rather than extending the prior194-test result to them.
Named isolated owners are `bases_summaries` (Object/Tag and actual-value shape),
`bases_expressions` (String/List/Number and strict identity), `bases_inline_core`
(Duration), `bases_docs_model` (signatures/special calls/ancestry) and
`bases_relations` (derived identity propagation). These successors remain
uncompiled/unaccepted until coherent review, serialized core checks, rebuilt
native/WASM artifacts and matching actual host scenarios. No heavy process is
live at this checkpoint; root retains the next runtime/build slot.

2026-10-22 actual Electron009 at `cfe5627e` reaches160 actions/16 checks and
verifies expanded Summary actions/deletion in the real app. It then stops at
keyboard resize. Independent reproduction proves a product defect: a same-view
summary/result refresh replaces the focused header/separator, leaving BODY
focused and ArrowRight ineffective. Reviewed fix `857438a0` preserves the same
surviving property/control without stealing outside focus;7 root regressions
pass. Harness `c4f48bca` additionally waits for the exact saved/published summary
selection and records key focus. Actual rebuilt retry remains required. All
owned009 processes are closed and source/artifact fingerprints agree.

Final-artifact CLI003 at `cfe5627e` passes85 commands/7 checks/30 exports;
independent verification checks all10 authoritative files byte-for-byte,
hashes, expected exits and summary oracles. Record: `98c6fda8` and
`tests/bases-cli-integration/acceptance-20261022.md`. Browser004 passes groups0–5
then catches an invalid fixture expectation: deliberately unreadable metadata
correctly makes reverse aggregates unavailable. Tests-only `db0f477e` now
separates healthy rollups from a malformed-source stage, explicitly verifies
unavailable diagnostics/plain-link choices, restores exact valid bytes and
rechecks retained snapshots. A complete matching browser rerun remains pending.

Source-only hover helper/factory review continues, including pending mount abort,
binary lease disposal and ordinary property-draft retention. A test-only genuine
native stdio relay campaign is being authored by `bases_relations` to prove held
accepted writes/newer drafts and uncertain-create restart recovery without fake
acks. Shared runner path/provenance/relay seams remain `bases_e2e`-owned. No new
production bridge reconnect is authorized; a fatal transport still requires
restart and must be reported honestly. Main remains unchanged.

2026-10-22 reviewed source composition and rebuild: Rust closure
`5e010112661da69eb290d6a5edb72d4906e844a1` passes194 tests across13 core targets,
native property-target3 and native-compiled WASM property-target2. The first
compiled new null-summary regression exposed optional-key pattern errors;
tests-only `76f5a682` corrects them, and the complete rerun passes. Release host,
CLI and actual WASM builds succeed; private receipt
`/private/tmp/zorid-bases-plain-link-artifacts.json` records hashes and source
association. Root logs are `zorid-bases-core-plain-link-check-2.log`,
`zorid-bases-native-plain-link-check.log`,
`zorid-bases-wasm-adapter-plain-link-check.log` and
`zorid-bases-plain-link-{native,wasm}-build.log` under private tmp.

Standalone Base source recovery `233f074e`/`fd1a67c5` is composed after review of
durable-conflict retention, inactive-tab targeting and close rollback;43 root
source/embed cases pass. Summary geometry `a40a4341` passes8 composed cases;
List file-drag `45b4aa77`/`3fb3b4c5` passes6 dedicated cases. The separate root
plain-link/sidebar/widget composition passes90 cases. These overlapping scopes
are not an aggregate frontend total or actual UI acceptance. Base hover helper
and workspace factory remain isolated/unaccepted; independent review found and
is resolving pending-mount cancellation. Supplemental safety/config/clipboard
sources and browser plain-link oracles are composed, but runner path/provenance
hardening and actual campaign execution remain pending. Native renderer rebuild
and new browser/CLI/Electron campaigns follow this closure; main is unchanged.

Reference hover002 has now observed a modifier-bearing trusted mouse popup,
rendered content, editable body, unmodified-mouse retention and outside-click
dismissal. A later physical-Meta phase reaches a DOM-evaluation deadline without
a final capture; do not claim that sequence passed. Exact owned-process cleanup
and fixture/config/catalog restoration were confirmed. The reference owner is
preparing its precise evidence addendum; no test app remains running.

2026-10-22 actual Electron008 at `e1817cb0` reaches154 actions/15 checks. The
corrected custom-summary oracle passes all4 independently scoped groups, exact
member paths/counts, explicit blank/null and overall214. It then exposes a real
popover geometry defect: Summary actions expands below the viewport, leaving
Delete summary unreachable. `bases_session` owns the narrow placement fix and
regression. Source/artifact fingerprints remain identical; exact owned-process
checks confirm the app/native host are closed. The complete heavy-user journey
remains open. Disk initially blocked launch; disposable coordinator test binaries
and12 verified-clean obsolete worktrees were removed, retaining branches,
commits, runtime evidence and product binaries (cleanup receipt in private tmp).

Reviewed source composition now includes sidebar rename/newer-selection teardown
`bc22d072`/`8f7377ec`, plain-link candidate/current-display identity guards
`1d01d893`/`acda8704`, and all-null group regression `062d0335`. Focused TS
composition is running; changed Rust/native/WASM artifacts are not yet rebuilt
or accepted. Standalone source recovery is independently reviewing; editable
Base hover integration and List file-drag gaps have named layout/workspace owners.
Reference-only hover runtime is owned by `bases_docs_model`; heavy builds remain
serialized behind that app slot. Supplemental campaign sources remain unexecuted.

2026-10-22 browser/WASM003 at `6808bf5e` passes all9 semantic groups with no
unexecuted groups, runner error, artifact mismatch or cleanup failure. The report
retains dedicated Worker observations, completed normal Worker GET200 and exact
WASM asset receipts; before/after source and artifact fingerprints agree. Chrome
exited0, its profile and disposable database were removed and Vite closed. This
is actual Worker/WASM/IndexedDB evidence, separate from rendered Base UI. Normal
web Workspace smoke001 at the same HEAD passes5 phases: create/title rename,
keyboard edit/durable save, new-document reload/exact source, rich Search and
exact result open; owned Chrome exits0 through Browser.close. It uses normal
Vite startup and does not claim production-bundle, mobile or full Bases UI parity.
Reports: `/private/tmp/zorid-bases-browser-actual-20261022-003/report.json` and
`/private/tmp/zorid-bases-web-ui-actual-20261022-001/report.json`.

Electron007's null-group mismatch is now classified as a harness oracle error:
the actual core result contains an explicit null summary without diagnostics;
focused REA confirms reference all-null sum/null arithmetic/blank rendering.
The harness must preserve blank strings rather than coerce them through Number.
Standalone invalid `.base` source recovery and plain-link picker choices are
confirmed source gaps, with named owners `bases_controller` and
`bases_relations`; corresponding scoped source/regression work is in isolation.

2026-10-22 actual final-artifact campaigns: CLI002 at `9d086a97` passes85
commands,7 independent checks and30 JSON/raw exports; every child exit and
retained evidence hash was independently rechecked. Browser/WASM002 passes
groups0–4, then rejects the fixture's body-only/CRLF inline request. The actual
editor producer confirms the full-fence/LF contract; tests-only `6193e21f`
corrects that request while retaining forged-source/span/actor rejection checks.
The browser campaign still requires a complete rerun. Electron006 reached no UI
because its launcher lacked required sandbox permissions; exact owned-process
cleanup was checked separately. Escalated Electron007 at `992ac56a` reaches144
actions/14 checks, including Results CSV export and custom-summary live editing,
then stops at an all-null group's blank custom summary versus the authored
numeric1 expectation. Root cause/reference oracle remains under investigation.
Its source/artifact freeze passes and all owned processes are closed. Neither
partial campaign establishes the full acceptance gates.

Supplemental source-only harness owners cover gaps beyond the main journey:
`bases_e2e` matched reference states/shared launch seam; `bases_session` stale
writes/history/pending lifecycle; `bases_toolbar` configuration/export breadth;
`bases_properties` ordinary-note and cross-layout rich controls; `bases_table`
native clipboard and input ownership. `bases_embeds` investigates a clean sidebar
Base rename retaining its old mounted path. Root owns composition and serialized
runtime grants; none of these authored scenarios is accepted before execution.

2026-10-22 frozen final-source preparation at `9d086a97`: the retained composed
frontend log reports **671/671 passed**, zero failed/cancelled/skipped. The final
Rust closure reports **192/192 across 13 targets** (82 library plus 110 integration
cases). Separate adapter checks pass native3 and native-compiled WASM2; separate
saved/inline group-origin checks pass native1 and native-compiled WASM1. These
sets are not an aggregate total or actual WASM execution. Full release host/CLI
and browser WASM builds completed. Exact logs/hashes and limits are recorded in
[the reference/evidence ledger](history/bases-pass-reference-20261021.md#frozen-source-verification--2026-10-22).
These results supersede the earlier “grouping still implementing/two corpus
expectations open/build pending” status for this closure. Actual final Electron006,
browser/WASM002 and CLI002 campaigns remain pending in this prepared record;
their outcomes must be recorded separately by the runtime owners. Normal web
UI proof, final visual comparisons and main integration remain open.

The frozen source includes native date/custom-checkbox/table numeric presentation
`317741b3`, nullable/pending checkbox focus fixes `2062ffd2`/`8156a410`, Results
continuation `698e767d`, view-control invalidation `350a0dd1`, and Base file chrome
`9d086a97`. Focused static REA corroborates native property control structure and
CSS; it does not establish a captured locale display or exact table alignment.
All of these changes still require corresponding final actual UI evidence.

Readiness disposition using the [63-ID audit](history/bases-acceptance-audit-20261022.md):
the [named-Type inventory](history/bases-type-retirement-inventory-20261022.md)
completes the source-scoped inventory in R2, preserving deferred Task/Calendar
consumers; named ownership/worktrees are established for R3. The
[host policy](history/bases-query-host-policy-20261022.md) completes Q7's policy
inventory: service-present hosts use Rust and do not fall back after errors;
no-service compatibility remains explicitly bounded. Actual normal-host routing
evidence remains part of A4/A5, including the distinction between a Rust-storage
fixture and a Rust Base query. R1 main reconciliation, R4's remaining reference
scenarios, R5 matched captures, all functional/layout/lifecycle requirements and
A1–A7/C1–C3 runtime/review/integration gates remain open. Source, test or build
completion does not automatically check those goal requirements.

2026-10-22 actual Electron005: matched host/renderer at `09cd214e`,106 actions
and7 durable checks before stopping ahead of CSV export. Filter focus, view
workflow, formulas, search, limits and independent summary values30/213 passed.
Exact summary-name acknowledgement was missing in the harness because both old
and new summaries returned213; `bfd2578e` corrects that synchronization and adds
Results state diagnostics. Source review also confirms a real Results-menu UX
gap: a summary-only save acknowledgement can close a newly opened Results panel.
Toolbar owner is fixing it. Provenance verified; owned Electron/native processes
closed with no leaks. The full journey remains unaccepted. Visual comparison
flagged native-blue checkboxes, number alignment and raw date presentation;
property owner is aligning these using focused REA/native-control evidence.

2026-10-22 subsequent verification: actual standalone CLI campaign001 passed85
commands,7 independent oracle checks and30 JSON/raw exports against the matched
`44d9ae46` Rust closure; see
`tests/bases-cli-integration/acceptance-20261022.md` for hashes and supported
surface limits. The saved-relation endpoint's native3 and native-compiled WASM2
focused cases pass. Actual browser/WASM campaign001 ran the admitted Worker and
passed its first ordinary-note semantic group, then stopped at a harness-only
assumption that every raw value appears in differential `editValues`; corrected
in `ef72ff8b`. Cleanup passed. This is partial evidence, not a passing campaign.

The latest bounded frontend closure passes640/640 cases and TypeScript. Explicit
core subpath consumption and identity-guarded asynchronous note opens are wired
and independently reviewed; the Rust subpath producer remains under development.
First-match grouping compiles and passes69 library and37 property/relation
cases; two old query-corpus expectations require reference-aligned manual-slot
IDs and loose grouping updates before all remaining targets can be accepted.
All changed Rust/native/WASM artifacts require a fresh matched build and actual
campaign reruns. The63-requirement frozen audit is
`docs/history/bases-acceptance-audit-20261022.md`; its snapshot predates these
new results and does not grant acceptance or main integration.

2026-10-22 acceptance checkpoint: the isolated coordinator branch has all four
layouts and the workspace/editor integration assembled. A bounded composed
frontend run passed581/581; a separate31-case group capability/preview run and
31-case desktop transport run pass (overlapping scopes, not a combined total).
Corrected core closure `f9a4ad80` passes67 library and32 property/relation cases.
The additive ordinary-note relation-display endpoint `5e837fcb` is source-reviewed;
native and native-compiled WASM checks are running, not yet accepted. Actual
Electron campaigns001–004 executed against earlier frozen builds;004 found a
real filter focus/Escape bug, fixed in `76be6d1b`, awaiting a full rerun. Earlier
campaign failures also corrected automation assumptions about native select-all,
duplicate-view continuation and the filter editor. The complete heavy-user
journey has not passed. Matching native/renderer builds, actual WASM/browser and
CLI campaigns, screenshot comparison and main integration remain open.

REA reference coverage includes51 runtime capture pairs and focused shipped-code
evidence. Latest grouping evidence requires first-match comparison of hydrated
keys, with different chooser and displayed-result pipelines; the Rust owner is
implementing that behavior in isolation. Further source audit found that target
rename must preserve rooted escaped relation links and include saved frontmatter
references; controller owner is fixing this before the next frozen run. Ordinary
note typed relation labels are being connected through exact saved-revision/raw
baselines. No reference, native/mobile, or final-source acceptance is implied.

2026-10-21 composed implementation checkpoint: isolated branch now includes all four layouts, configuration/creation commands, rich widgets/settings, formulas/summaries, relations/rollups and file/fenced embeds. Root owns the remaining workspace and transport composition. A 505-case bounded composed run passed504 with one obsolete Electron startup fixture; its9-case file passes after fixture correction. Subsequent rich/query/editor composition40/40 and property-target/raw-value projection19/19 pass. These test sets overlap and are not an aggregate count. Independently reviewed toolbar retry continuation now preserves newer drafts after failed saves. Native validation at corrected Rust closure `f676a5fb` passed17 focused cases: native4, host9, native-compiled WASM adapters4; this is not actual WASM runtime or final-source acceptance. Later ordinary frontmatter inference, group previews and exact raw edit-value transport are still being composed and require fresh validation. Actual full Electron heavy-user campaign, screenshot comparisons, web/CLI affected paths and main integration remain unperformed. Reference evidence/deviations: [Bases pass reference](history/bases-pass-reference-20261021.md).

2026-10-21 goal activated: execute `docs/plans/bases-implementation-goal.md` until
complete, including an actual heavy-user Electron E2E automation campaign and
reference screenshots. Obsidian is both UI/UX and logic reference; use REA for
ambiguous behavior, retaining approved extensions. Implementation coordinator is
current root in `codex/types-bases-model` / `.worktrees/types-bases-model`, not a
new main integration grant. Scoped workers: controller/document/creation and
Vault captured-create addition (`codex/bases-controller`, nested worktree under
coordinator); property definitions/widgets (`codex/bases-properties`); Rust
summaries/query/expression/preparation (`codex/bases-summaries`); table/common
presentation (`codex/bases-table`); Cards/List/Kanban (`codex/bases-layouts`);
Markdown/live fenced embeds (`codex/bases-embeds`); Rust relation/property modules
and graph factory (`codex/bases-relations`); toolbar/config/CSS
(`codex/bases-toolbar`); native/WASM/host inline queries plus shared document fence
verification (`codex/bases-inline-core`); session/view-actions/export/property
settings UI (`codex/bases-session`); actual-user harness (`codex/bases-e2e`). Root
owns workspace/shared-query/TS transports, build manifests, composed validation
and branch integration. Reference worker `bases_docs_model` owns bounded REA
reference evidence. Workers send additive contracts early; heavy builds remain
serialized. No implementation/compiled/native/visual acceptance yet.

2026-10-21 current implementation pass is defined by
`docs/plans/bases-implementation-goal.md`. User requests a durable goal file and
cleanup of superseded Bases designs. Named note Types are removed; rich property
definitions, multiselect and relations remain. Match Obsidian's appearance and
interactions, with one deliberate change: New copies the full template note
(frontmatter and body), literally. Earlier frontmatter-only behavior is reference
evidence, not Zorid's target. Old combined plans/dispatches are routed to the goal
or clearly historical; later non-Bases milestones remain in the roadmap.
Documentation owner: current root with independent docs worker
`bases_docs_model`; branch/worktree unchanged below. Main integration remains
unperformed under the existing sole-owner protocol. No feature code/runtime
acceptance follows from this documentation pass.

2026-10-21 subsequent direct decision supersedes the earlier Types proposal:
remove named Types, Type editor and mandatory Type/schema assignment from the
product plan. Follow Obsidian-style Bases over ordinary files/properties.
`type: book` is optional ordinary frontmatter, with normal property filtering;
it does not require a Type registry. Property value types/editing controls remain.
Owner/branch/worktree remain the research batch below. These are documentation
changes only: existing Type-dependent source is not removed or migrated here.
Deferred Tasks/Calendar contracts must be reconciled before their implementation.

2026-10-21 direct user priority correction: build local Types and Bases now;
defer broader managed-data, Tasks and Calendar work. S4 no longer waits for the
whole S3 stage or synced structured data. Owner for this research/tracking batch:
current root; branch `codex/types-bases-model`, worktree
`.worktrees/types-bases-model`, baseline `e7d655e1`. Scope: official Obsidian docs,
REA/static artifact inspection, roadmap correction and findings only. No runtime
feature code, schema migration, main integration or feature acceptance claimed.
Research is recorded in `docs/reference/bases-mental-model.md`. Sole main
integration ownership remains with the existing shared-core coordinator; this
isolated batch has no integrated commit yet. Older “S3 next” text below is
superseded by this direct steering.

Latest S3 design correction (2026-10-20): work blocks, time entries and similar
first-party user content are note-backed; SQL/index representations are derived.
Reconcile existing record-backed WorkBlock prototypes before feature delivery.
File schemas/granularity remain open; no implementation/migration is authorized
by this correction. S1 acceptance is unchanged; S3 remains planned.

**S1 accepted for bounded ordinary functionality — 2026-10-20.** The user
explicitly deferred further optimization, performance budgets and large-vault
stress. Final product source is610ada26; root retains sole main integration.
Stop the S1 campaign here. S3 managed-data services/contracts is next in delivery
order; no sync/mobile or new feature implementation was opened by this closeout.

Current native release CLI/host, matching WASM, TypeScript, desktop renderer and
normal production web bundle build successfully. The396-input Rust/WASM closure
and measured artifact hashes are retained. Actual normal web UI006 passes create,
title rename, accepted keyboard input, exact durable save, a genuinely new-page
reload, rich Search and exact result opening. Final Electron create002 passes22
save/quit/reopen/history checks; actions005 passes save/Search, three stable-ID
renames, pasted PNG byte/pixel verification and normal quit/exact reopen. Actual
browser storage lifecycle passes5 phases; standalone CLI100/full-query oracles
pass; Base003 passes128-row table/filter/source refresh/time-formula checks.
Independent CLI/Electron concurrency003 passes6 CAS/replay/conflict/interruption/
recovery checks onb28a29b8, before the final rename-only change; final current
Electron regression and58 focused/adjacent save checks cover that last change.
Find/Search has69 passing focused checks. No full-platform/full-language claim.

Two demonstrated bugs were fixed, independently reviewed and integrated:
bbaee0cf routes the two local CommonJS boundaries through Vite's dev optimizer;
610ada26 preserves typing while adopting a known rename with matching stable
identity, destination and saved content. Generic conflict/receipt/CAS protections
remain strict. Owner finish_normal_indexing used isolated branches
codex/s1-vite-local-cjs and codex/s1-browser-rename-save; reviewer
preview_integration_review approved exact candidates37ff1dc9 and4b48e202.
Root performed matching builds and actual app verification. Evidence index:
`.worktrees/s1-evidence/functional-closeout-evidence-final.md`.

Retained unsuccessful runs distinguish actual regressions from fixture issues:
dirty-query/partial-preview timing witnesses are deferred, hidden title selection
and reload readiness were corrected, a redundant-publication assumption was
replaced by strict current/complete checks, and the injected clock now fires its
actual scheduled deadline. One concurrency attempt hit the1GiB disk guard and
was rerun successfully. Reports, screenshots, exact temporary adapters and source
hashes remain; owned test apps are closed and user data is preserved.

Deferred: multicore; further compute/latency/memory optimization; representative
10k/100k workloads; contention/partial-preview timing witnesses; unexecuted broader
Rust cache/time matrix (65 of86 not run in that campaign); other OS/mobile runtime
and complete Obsidian language/visual parity. These are explicit limits/backlog,
not claims of passing or hidden blockers to the revised functional acceptance.

The user-requested one-full-storage-capture follow-up is implemented, reviewed,
integrated and measured. Implementation owner `s1_browser_capacity` used
`codex/s1-browser-incremental` / `.worktrees/s1-browser-incremental`, baseline
`e8faff3a`; independent reviewer `preview_integration_review` approved final
`c9acd4fa`. Root integrated the exact five-file closure as7751eb22/12efdbf8/
0b460599/47c0a06c/c99b1b2f. Final77 focused checks and TypeScript pass; all source,
test and compiler-config inputs match the reviewed/validated isolated candidate.
Evidence: `.worktrees/s1-evidence/browser-one-capture-integrated-result.json`.

Actual matched100-note import plus exact103-file readback and final automatic
current/complete wait takes13.956s, down from26.637s (47.61% less elapsed, one run
per version). Full storage captures221→1; state restorations217→3. Startup plus
binary readback are INCLUDED. The same persisted database also passes startup
query, warm reopen, one offline edit and incremental reopen/search; each separate
open records exactly1 capture. Query samples11.8–21.6ms. Offline edit may close
before indexing settles; incremental reopen verifies final current/complete state.
All five owned Chrome processes exit 0 without signal; live disk guard minimum
2,489,638,912bytes. Reports/screenshots/guard/comparison are retained in
`.worktrees/s1-evidence/browser-one-capture-benchmark-6df77a14/`.

The three browser production files exactly match main; the matched diagnostic
retains the same older Rust/WASM baseline, not final-main/native/10k/S1 acceptance.
No schema, general framework, or native work was added. Owned commits advance
retained state only after actual transaction completion with the outer receipt
sequence; failed/stale/aborted operations cannot promote it. Ordinary warm writes
avoid full storage/publication/ledger scans; selected actual rows, source bodies,
ancestor/destination paths, allocations, receipts, cursor and quota checks remain.
Explicit audits/recovery and foreign logical changes can require another capture.
Unrelated same-stamp raw physical corruption is checked at audit/read-on-use,
not claimed detected during every unrelated save. Rust classification/output and
in-memory bound validation still scale with vault state. Other S1 campaigns stay
stopped; this scoped result does not complete S1.

Latest follow-up fixes existing browser storage repetition, without a storage
redesign. Root retains sole main integration. Three reviewed changes are now
integrated:3d64a8b2 removes the second next-state graph clone per mutation;
784c13ac skips exact unchanged metadata/presentation puts while retaining inline
body writes/deletes that repair stale content;1a702c8f/bdcab7b7/e0b9a01e replace
managed-host scope-only full graph inspection with fresh configuration/head point
reads. Scope changes, protocol IDs, config/head consistency, authority and owner
retirement remain checked. Final mutation captures/preconditions remain unchanged.
Normal Markdown readback already uses point reads; prior wording attributing
whole-vault captures to each text read was too broad.

Owners: `s1_browser_capacity` on `codex/s1-browser-next-head` in
`.worktrees/s1-browser-next-head`; `preview_integration_review` on
`codex/s1-browser-publication-skips` in `.worktrees/s1-browser-publication-skips`.
Root reviewed both leaves; preview independently approved final scope53a9495f.
The composed72 checks pass onbdcab7b7; the final owner-guard successor passes
its2 affected scope regressions on e0b9a01e. Final TypeScript result and exact
source/evidence correspondence are recorded in
`.worktrees/s1-evidence/browser-storage-repetition-main-result.json`.
User-requested remeasurement now passes on matched benchmarkc648fb06: same
100-note batch plus exact103-file readback and final automatic current/complete
index wait takes26.637s versus30.672s (13.15% less elapsed, one run per version).
Storage captures330→221; state restores326→217; final source/covered watermark107.
Import/readback alone26.327s, final wait0.310s; total phase27.742s includes startup.
Owned Chrome72770 exited0 without signal; live disk guard stayed above1GiB
(minimum3,762,688,000bytes). Evidence/report/comparison are retained in
`.worktrees/s1-evidence/browser-storage-benchmark-c648fb06/`.
The three browser production files exactly match main; Rust/WASM remain the same
older matched baseline. This is diagnostic evidence, not final-main/S1 acceptance.
User correctly challenges221 remaining full captures: per-write preparation and
final-writer full scans remain, approximately two per commit. This fix removed
the unnecessary scope inspection, not the main repeated storage scans. A target
of one initial full capture plus incremental updates/targeted writer checks is
not implemented; do not imply these scans are eliminated or inherently required.
Other S1 campaigns remain stopped.

Latest user steering reopens only the measured browser redundancy issue:
“Bro just don't do those excessive repeated work please.” Keep other S1
campaigns and native optimization stopped. `s1_browser_capacity` owns the
source-only proposal for coalescing redundant advisory source notifications;
`preview_integration_review` reviews Rust ownership, foreground latency and
bounded delivery/retirement. Root retains sole integration and runtime ownership.
No storage redesign, new API/framework or broader acceptance campaign is opened.

This narrow follow-up is now implemented and measured. Reviewed host-only change
05d7fcb8 batches payload-free source hints at500ms quiet/1000ms maximum timer
eligibility; Rust still chooses indexing effects, foreground freshness bypasses
the batching, rejected requests retain hints, and retirement cancels delivery.
Eight regressions fail before the fix;66 focused checks plus 28 runtime checks
and TypeScript pass afterwards. Only the host and its test file changed.
Matched100-note import plus exact103-file readback and final automatic complete/
current wait improves36.786s→30.672s in one diagnostic run each. Generations
108→37; full index source captures660→259; pumps220→102. Final source and covered
watermarks are107 with complete/current coverage. Final wait grows0.151s→0.996s
and is INCLUDED in the comparison, so this is not just deferred work. Owned
Chrome exited0 and no heavy slot remains active. Evidence:
`.worktrees/s1-evidence/browser-hint-benchmark-391b7e2c/comparison.json` and
`browser-hint-batch-source-review-b094293d.json`. This uses a matching isolated
old Rust/WASM baseline, not final-main/reopen/10k acceptance. Bulk import remains
slow overall. No further work is opened by this result; other S1 work stays stopped.
Post-run free disk was800,332KiB, below the1GiB floor; no in-run disk-floor trace
was captured. Do not launch more runtimes/builds without recovering headroom.

**User scope freeze, 2026-10-20:** finish only the running browser measurement,
report the results/outstanding checks, and stop opening work. That measurement
is now terminal; all owned test browsers are closed and no heavy slot is active.
The reviewed two-file browser fix is integrated as7b12c1e7 (120 adapter checks
and TypeScript pass). Matched100-note import plus exact103-file readback improves
77.16s→36.63s in one diagnostic run per version; source captures11371→660.
Evidence: `.worktrees/s1-evidence/browser-point-fence-benchmark-1ff7aad6/comparison.json`.
This is a matched isolated37ed Rust/WASM baseline, not final-main/10k acceptance.
Native optimization remains test-only0d1d7ebd, with no production change or RED
execution. Do not automatically resume optimization, new architecture, builds,
or remaining campaigns from older instructions. S1 remains open.

2026-10-20 follow-up: actual Chrome100 normal-core run on frozen37ed616e passes
all five phases and complete literal/range/order oracles. Evidence:
`.worktrees/s1-evidence/acceptance-web-main-100/report.json`. Warm query samples
12–32ms; import plus exact readback83.3s; component fixture DOM, not full workspace.
Actual normal10k browser import fails the300s deadline at172/10003 files, with
owned Chrome cleanup exit 0; evidence `acceptance-web-main-10000-red/report.json`.
This is a practical import timeout, not an observed4096-source rejection. Root
retains those failures and is narrowing whole-vault reconstruction, autonomous
indexing during import, and per-operation serialization/storage hypotheses.

Graph88934488 is independently source-approved for normal Text and schema16,
and its exact 33-file closure is integrated asf427885f. Original136 RED
result86pass/50fail is preserved; narrowed paired-authorship reservation correction
retains all original owned-byte/work limits. Fresh138/138 checks pass naturally.
The tiny-body10k Store/cache test reports1 passing test, including exact query,
reopen and9998 unchanged records reused, but its outer timing envelope remains
RED: `/usr/bin/time -l` fails a sandbox sysctl after the Rust test summary. Direct
child exit was not independently captured; retain the split classification in
`graph-focused/88934488-normal10k-001/classified-result.json` rather than calling
this a clean terminal pass or platform acceptance. Diagnostic timings:33.1s
creates,121.0s cold index,108.3s incremental index,153ms/34ms first/last writes.
A2s sample attributes much active time to repeated full-manifest verification
and builder restoration. `finish_normal_indexing` owns an isolated narrow
`document_index.rs` proposal; full publication and preview validation must remain.
Browser ON/OFF cost probes run against separately frozen37ed sources/assets;
their instrumented results are diagnostic, not client acceptance. Root serializes
all heavy runtimes/builds.

Desktop-only architecture cleanup8dc9e83e is reviewed and integrated as51db29e0:
normal desktop requires matching Rust document maintenance, with actionable
failure/cleanup instead of silent fallback. All56 focused checks freshly pass.
Matching actual desktop verification remains open; mobile stays paused until
desktop and sync are solid. Only root mutates main.

Fresh219 focused Node cache/preview/clock checks pass on37ed616e, with source
closure and coverage map in `.worktrees/s1-evidence/cache-preview-clock-map/`.
Existing Rust/cache checks are mapped but not rerun by that worker. Narrow
remaining real component/core and desktop foreground harnesses are independently
source-reviewed and integrated asab497705/162b077d; actual runtime is pending.
The desktop dirty-query allocator issue and swallowed Base observer assertions
were corrected before integration. Indexing-overlap absence remains inconclusive.
The86-check focused Rust cache/time campaign has21 actual passes:9 extraction
checks and12 Store checks. Its initial Store compilation stopped at the1GiB disk
guard; the12 then ran directly from the retained source-identical graph executable,
with all411 Rust/Cargo input hashes and binary correspondence verified. Remaining
65 checks are unrun. Native test-only pump-counter compilation was refused below
its2GiB admission floor; no retry or production optimization occurred. Evidence:
`cache-preview-clock-rust86/ca6a4fe3-{001,direct-store12}/` and
`pump-recapture-red-0d1d7ebd/terminal.json`. Existing native binaries and generated
WASM predatef427885f and must be rebuilt before claims against current main.

Reviewed acceptance harnesses are integrated: desktop foreground162b077d,
Base component/coreab497705, full CLI pagination34371e41 (9 focused checks).
Their actual client campaigns remain unrun; they are tools, not acceptance.
Final matched builds, normal10k desktop/web/CLI and remaining lifecycle/preview/
clock/performance gates remain open. Stop here under the latest user steering.
Obsolete compiler/test-profile/generated-bundle cleanup records are retained in
`.worktrees/s1-evidence/`; source, current binaries, user playgrounds and private
unsaved-note backup remain intact.

The following update is historical where superseded by the results above.

User requests completion of the remaining S1 tests (2026-10-20), confirms the
manual playground is closed, and authorizes continued execution. Keep its data
and unsaved-note backup; use fresh owned fixtures for tests. macOS Electron,
actual Chrome/WASM/IndexedDB and independent macOS CLI remain the targets.

Current source includes reviewed harnesses756bec5d/a63b889c: explicit CLI pump
budget (11 checks) and opt-in actual browser core lifecycle verification
(16 checks). Runtime Rust/WASM source is unchanged from the validated1 MiB batch.
Current CLI100 representative-smoke setup/cold index/warm restart/all8 complete
literal oracles pass with exact source preservation and process-resource records:
`.worktrees/s1-evidence/acceptance-cli-main-100/report.json`. This is100 notes,
not10k acceptance or Electron/web foreground responsiveness.

Large-vault owner `finish_graph_path` has isolated, source-reviewed schema16
freeze d6f16758 in `.worktrees/s1-graph`, including schema15 Text compatibility.
Its136 focused checks are running serially before the ignored10k Store/cache
capacity/reuse test; neither is yet accepted. Root owns all main integration and
actual client execution. Normal web10k has additional source-audited whole-graph,
Text/publication and ledger bounds; no successful normal web10k proof exists.
`finish_normal_indexing` owns harness-only work; `preview_integration_review`
provides independent review; `s1_browser_capacity` has a read-only platform audit.
Do not treat cap increases, raw fixture seeding or a Store-only test as client
acceptance. Retain failed/incomplete outcomes.

The finite remaining campaign is fixed to S1: normal10k admission; matched native
and WASM builds; macOS/web save→fresh query/reopen and bounded foreground/cancel
checks; declared cache/query invalidation matrix; first-build partial/coherent
results and time-context checks; independent CLI updates/concurrency; representative
5-run/20-query measurements and one100k stress/limit observation. Reuse unchanged
focused evidence rather than expanding into new features or indiscriminate S0
suites. Full S1 remains open.


Current integrated source includes the reviewed size-fix batch through
`2d5df2f3` (2026-10-20); previous normal-workspace proof is atf237ebfa.
Normal Electron100-note save → core indexing → visible Search result → reopen
passes on candidate6fe36157, whose relevant runtime/tool sources match main.
Evidence: `.worktrees/s1-evidence/native-save-index-query-003/report.json`.
Normal web/WASM build passes (`web-current-build.log`); user-owned desktop and
web playgrounds were opened for the user; the user now reports them closed.
Preserve their profiles/vaults and private backup; never repurpose them for tests.
Desktop/browser product sync joining is not ready and S2 is not being started.

S1 remains open. Normal large-vault targeted storage correction is isolated
(`codex/s1-finish-graph`,cefb4901), not integrated or verified at10,000 notes.
Complete browser persistence/performance and standalone CLI acceptance remain
open. Passing the normal100-note desktop slice does not establish these gates.

The oversized browser Markdown save finding is resolved with an explicit1 MiB
UTF-8 Markdown authoring cap and actual supporting storage capacity. Source
2d5df2f3 composes browser/editor8714ddf9, table consistencyb6b7216f and Rust
44ba278c.169 focused Node checks, TypeScript,33 Rust checks, normal WASM/web
builds and native host/CLI builds pass. Actual Chrome fixture1 MiB Unicode create
and edit both survive exact readback and storage reopen. The original2.94 MB
clipboard paste leaves editor/durable content unchanged with a plain limit notice.
Native NoteBuffer/admitted host1 MiB save, filesystem readback, cap+1 rejection
and new-process reopen pass. Evidence lives in `.worktrees/s1-evidence/`:
`one-mib-core-gate/report.json`, `one-mib-browser-final-tests.log`,
`buffer-save-{7DvTkR,qyhZSg,5J5NF7}/report.json`,
`native-one-mib-FUd11j/report.json`, its `cli-report-fixed.json` (independent
CLI read/edit/new-process readback) and the named build logs.
The user's frozen desktop/web playgrounds and private unsaved backup are intact;
this does not establish full normal-workspace or large-vault S1 acceptance.

Store14→15 widens only the immutable Text payload constraint; relay1→2 widens
the envelope constraint. Both migrate verified predecessors transactionally.
This collides with the held graph branch's schema15: graph owner acknowledged
that its correction must reconcile this migration and advance toschema16
before any later integration. S1's remaining implementation and acceptance
gates listed above are unchanged.

The older update below is historical where superseded by this checkpoint.

Current integration `a43e7055` (2026-10-19):

User authorized obsolete-build cleanup and resumed execution on2026-10-19.
Cleanup removed719 exact generated files,628,330,496 allocated bytes combined;
current outputs, warm dependencies, source, vaults and evidence were preserved.
Observed free space after the second cleanup was3.05GB (point-in-time reading).
Evidence: `/private/tmp/zorid-repo-older-builds-cleanup/terminal.json` and
`/private/tmp/zorid-obsolete-generated-files-delete-20261019/terminal.json`.

Canonical buffer64032dc6 passes62 focused Node checks and full TypeScript;
its exact six-file boundary is integrated through2759322c. Editor hook successor
8fb4670e passes113 focused Node checks and full TypeScript; its exact seven files
are integrated througha43e7055. The original b5 five-test failure remains recorded:
four fixture counters measured the persistent transport subscription instead of
buffer consumer subscriptions; the ABA fixture expected draft facts after returning
to saved text. Independently reviewed test-only corrections retain real consumer
cleanup and dirty ABA assertions; all19 new hook checks actually reran green.
Evidence: `/private/tmp/zorid-s1-f-buffer-hooks-8fb4670e/terminal-result.json`.
No normal runtime activation or actual app verification is implied.

All166 planned Rust checks pass on60e868ac, plus12 incidental search-preview
passes reported separately. The exact29-file Rust/Cargo composition is integrated
through6d59c8d6; other381 source inputs matched. Source410, natural exits and
process cleanup are verified. The original filter-count mismatch, SQL test-only
i64 correction and real strict empty-command decoder failure/fix remain recorded.
Evidence: `/private/tmp/zorid-s1-canonical-f-preview-aea13f96/aggregate166.json` and
`integration-plan.json`. Hosted-WASM checks do not establish actual wasm32/browser
binding acceptance. Remaining reviewed browserF13 source composition with current
main is owned by `s1_browser_runtime_review`; preview remains separate.

Disk headroom was restored enough to execute the remaining gates by retiring the
unused secondary Electron44.8 generated copy and14 native-only debug library
payloads outside the pending WASM dependency packages. Primary runtime, current
binaries, third-party dependencies, WASM-needed variants, source, data and evidence
are retained. Proofs: `/private/tmp/zorid-secondary-electron-cleanup/terminal.json`
and `/private/tmp/zorid-post145-wasm-package-cargo-proposal/terminal.json`.
Free space remains tight; keep checks serialized and revalidate before builds.
Optional Rust HTML removal reclaimed only15.3MB, not812.5MB summed allocation.

Store sealed preview prerequisite01bd11d0 is independently source-approved, with
7 new checks and6 affected producer checks pending. Native/host and WASM/browser
preview implementation/review continue isolated; frontend Bases preview consumption
is owned by `s1_rich_desktop_transport`, reviewed by `s1_rich_ui_review`. Preserve
prior coherent published results and read-only partial first-build classification.
Both actual generated-WASM and rebuilt app verification remain open.

Remaining implementation ownership is isolated from the frozen validation tree:
`s1_query_audit` owns the sealed Store preview prerequisite; `storage_sqlite_impl`
owns native/host preview; `s1_desktop_scheduler_review` owns WASM/browser preview
and the common preview DTO leaf; `s1_desktop_runtime_review` implements the independently reviewed schema15 durable
graph correction (A+B+C) in isolation; facts/migration alone do not clear normal10k. Heavy checks
remain serialized. These implementations and actual platform acceptance are open.
User asked to stop the size investigation and focus on delivery; no broad rewrite
or additional abstractions are authorized by that earlier concern. Historical
resource-hold statements below are superseded by this update.

- Common/desktop F adapters are integrated as the23-file `8a6d20d0` subset.
  Full TypeScript passes on that exact subset;190 applicable common/desktop
  checks carry from validated `93c0b133` with exact selected dependency closures.
  Evidence: `/private/tmp/zorid-s1-f-desktop-subset-8a6d20d0/terminal.json`.
  The full36-file Node composition passes374 checks and TypeScript; its browser
  portion remains isolated because it needs the held Rust/WASM exports. Original
  framed failure is preserved: a real transport allowlist rejected valid raw
  draft-facts replies. Reviewed one-condition fix admits only facts-read replies
  to the existing strict decoder. No size/identity checks or fixtures were loosened.
  `/private/tmp/zorid-s1-f-canonical-node-93c0b133/aggregate374.json`.
  Existing activation stays OFF; missing native F support keeps the legacy path.
- Buffer projection owner `s1_rich_search_controller` has a staged standalone
  boundary source-approved by `baseline_resources_impl` at `5f2ebcb3`. Canonical
  `64032dc6` on `tingkai-c/s1-buffer-draft-canonical` in the existing
  `/private/tmp/zorid-s1-buffer-draft-projection ` contains its exact six files atop
  main `6678eadd`; all other tracked inputs match that main freeze. Review fixes
  cover exact-view reuse, renewable private core leases, observer/cleanup promise
  reservation, bounded single-use facts decoding and same-service engine restart
  recovery. Old replies cannot poison a renewed analysis interval. Text revisions
  still change only with text; core anti-replay policy and durable saving are
  unchanged. NoteBuffer/Workspace hooks remain untouched pending this gate.
  The rebound plan is62 focused Node checks plus TypeScript,29 newly authored and
  33 affected existing checks. Composition proof, source manifest, static counts,
  review and plan: `/private/tmp/zorid-s1-f-buffer-canonical-64032dc6/`.
  No execution is granted: latest free space is about1.12GB, below its1.3GB start
  requirement. Do not expand into dependent hooks/preview implementation or
  repeat tiny cleanup attempts while those validation dependencies are held.
- Preview platform plans are preserved, without implementation, at
  `/private/tmp/zorid-s1-native-base-preview-scope.md` and
  `/private/tmp/zorid-s1-browser-base-preview-scope.md`. Browser's bounded current
  writer-fence audit is `/private/tmp/zorid-s1-browser-preview-writer-fence-audit.md`.
  A sealed postcommit Store registration/read bridge and actual platform/query
  retention ledgers remain required. These plans do not establish acceptance.

- Vault/Workspace metadata consumption is now integrated as `9988b0c1`,
  `cf97f170` and `b3930388`, matching canonical `28567494`. All132 focused
  Node checks and full TypeScript pass. Completed121 checks carried forward
  only after their unchanged dependency closures were confirmed; the remaining
  checks ran on the final source. Evidence:
  `/private/tmp/zorid-s1-vault-workspace-node-03093422-validation/aggregate132.json`.
  The original Node constructor-syntax failure and stale warning fixture failure
  remain recorded. The fixture now asserts existing quiet automatic recovery;
  production recovery behavior did not change. Both metadata paging and a real
  maintenance subscription are required, so normal activation remains OFF.
  Main's seven consumer files match the accepted source and all 378 Rust/Cargo
  inputs match `2bf929f9`; proof:
  `/private/tmp/zorid-main-b393-consumer-integration-proof.json`.
- Next canonical Rust source `aea13f96` composes independently reviewed portable
  F transfer, native host, WASM F, stable allocation and retained preview producer
  changes. All scoped owner source acknowledgments are received. Its166 focused
  checks are unrun: Core2, Index56, Store8, native40, host31, hosted WASM21 and
  Bases preview8. Owner `storage_recovery_impl` prepares the single serialized
  gate in the existing `s1-canonical-draft-store` worktree. Compilation is held:
  current disk headroom cannot cover observed link peaks above the1GiB floor.
  Sequential disposal of passed test executables alone does not prove safety.
  Retiring20 proven must-rebuild first-party library payloads reclaimed110 MB,
  preserving third-party dependencies, Cargo metadata, source and44 held actual
  artifacts. It permitted the bounded Node checks above; Rust166 and matching
  app builds still need more disk headroom. Cleanup evidence:
  `/private/tmp/zorid-s1-changing-local-cargo-output-proposal/terminal.json`.
  A later transient2.52GB reading permitted a conditional Rust grant, but fresh
  preflight found only1.45GB then1.30GB, below the1.5GB package-start requirement.
  No Cargo/test child launched; source410 and actual44 matched. The grant is
  withdrawn pending fresh clearance; heavy slot is released. Evidence:
  `/private/tmp/zorid-s1-canonical-f-preview-aea13f96/execution-preflight-resource-hold.json`.
  All workers are terminal after source preparation/review. The resource blocker
  audit is `/private/tmp/zorid-s1-resource-blocked-audit-20261019.json`; no S1
  completion is claimed.
- Repeated Search/Find screenshots reaffirm the existing UI contract. The retained
  REA report and desktop32 evidence were reused; six view/style files matched the
  accepted desktop source before the small follow-up. Reviewed `57baa7f1` fixes
  Reading Find dark-theme highlight contrast and exact singular Search counts.
  No matching rebuilt app pass is claimed. The subsequently validated platform
  composition and its integrated desktop subset are recorded above. The matching
  generated-WASM/browser UI pass remains pending, independently of those Node
  checks and held Rust `aea13f96`.

The following entries retain the earlier batch evidence; the updates above
supersede their pending consumer and source-review statuses.

- Main includes the pure foundation (`4da43cf7`, 216 checks), work arbiter
  (`24eca3a2`, 15 new +27 reducer checks), browser Search ordering correction
  (`48d81168`, 63 focused Node checks, full TypeScript and three real-WASM
  controls), and Rust E2/Bases preview batch (`40a71dce`, 114 checks). The
  arbiter runner's expected-40/actual-42 mismatch is preserved separately;
  the two extra embedded reducer tests are identified, with both commands
  naturally exiting 0 and all tests passing. No rerun normalized that report.
- The 114-check batch covers Bases preview/library/corpus/query/generation/
  refresh (75), native metadata (15), host metadata (14), and hosted WASM (10).
  Exact 11 owner files compose canonical `40a71dce`; source stayed stable,
  all owned groups exited, minimum free disk was about 1.25 GB. Evidence:
  `/private/tmp/zorid-s1-e2-preview-validation/verification.json`.
  These are focused source/binding checks, not actual app activation or speed.
- Actual desktop's 32 functional phases passed on `bc013e3b`. Browser 003
  reached Search but failed its first rich request. A bounded diagnostic proved
  indexing/publication/open succeeded, then Rust rejected mismatched file-fact
  order. The real-WASM two-file reproduction and Unicode controls support the
  once-per-pin canonical ordering fix now on main. Full matching browser rebuild
  and functional rerun remain pending; held old artifacts keep their old source
  labels. Diagnosis evidence and source handoff:
  `/private/tmp/zorid-s1-browser-search-order-handoff.md`.
- E2 client adapters are integrated through `4887a970`: common strict metadata
  decoding, desktop capability/transport and browser actual-pin/cursor fencing.
  Canonical 275 focused Node checks and full TypeScript pass. Complete phases
  carried forward only with unchanged dependency closures; four original failed
  fixture attempts remain recorded. Evidence:
  `/private/tmp/zorid-s1-e2-canonical-node-4887a970/aggregate275.json`.
  No actual generated-WASM/browser activation is established by these checks.
  Vault metadata migration owner `baseline_resources_impl` and display/lifecycle
  owner `s1_rich_search_controller` work in isolated branches; their changes
  are not yet integrated. Browser fresh epochs force resets; the required S1
  incremental-computation audit is tracked in `docs/user-findings.md`.
- F native executor and additive exports are integrated as `b270f26c`/`8917d66c`
  from reviewed `89e1b58a`. All18 draft executor and22 runtime checks pass,
  source unchanged and owned groups gone. Evidence:
  `/private/tmp/zorid-s1-native-f40-89e1b58a/verification.json`.
  The reviewed portable executor extraction `5035e456` and Store duplicate graph
  validation removal `9ea3cb5d` are now integrated through `2bf929f9`. All67
  focused checks pass: native18+22, portable10, Store6+11. One portable case is
  relocated coverage. A resource preflight paused after56; only the remaining11
  ran later against the same built Store binary. No passed cases were rerun.
  Evidence: `/private/tmp/zorid-s1-canonical-draft-store-2bf929f9/aggregate67.json`.
  The subsequent transfer owner `s1_lifecycle_core` has source-approved
  `89e88d73`: actual uploads/encoding remain in the shared owner, charged through
  conversion and growth overlaps until actual disposal. Its26 shared and40
  native checks are not yet run. Host framing owner `storage_sqlite_impl` and
  desktop facade/scheduler owner `s1_rich_desktop_transport` implement its frozen
  reader/writer contract in isolation. Embedded/mobile F remains unsupported.
  Actual host transport, WASM/browser drafts and buffer projection remain open.
  Durable saving/NoteBuffer state is outside this transient semantics change.
  Main integration proof binds the25 client and seven native owner files to
  their separately validated sources:
  `/private/tmp/zorid-s1-e2-native-main-integration-8917d66c.json`.
- Normal runtime activation flags remain OFF. Base preview platform/UI mounting,
  per-pane visibility/configured clocks, actual liveness/fairness, independent
  CLI concurrency and S1.6 retained workloads remain open. Overall S1 is not
  accepted. Stop after S1; later desktop features and sync remain deferred.
- Next frozen source batches: Vault `3440e40d` and Workspace ordered `a9519456`
  then `5a2d1210` are independently reviewed; canonical `ad7e932e` prepares132
  focused Node checks plus TypeScript. Vault's new path requires both metadata
  paging and a maintenance subscription, preserving normal legacy behavior while
  runtime activation is off. Stable browser allocation `5190017e` is reviewed
  but its23 new checks/real WASM-IDB acceptance are pending. Preview producer
  ordered `d1569800`/`055cab31` is reviewed with11 new checks unrun; backing
  capacity admission is the next prerequisite before native preview retention.
- The normal10k admission limitation is a confirmed whole-graph capacity gate,
  separate from historical throughput:4096 combined records/activities cannot
  hold at least20,000 members needed for10k Markdown notes. A thin paged reader
  cannot preserve the existing global identity/conflict/causal validation.
  Feasibility is recorded in
  `/private/tmp/zorid-s1-source-backed-graph-feasibility-34ae20c7.md`; a durable
  graph-index/writer contract remains unresolved, not silently replaced by a cap
  increase or disposable authority cache. S1.6 is not accepted.
- Builds/apps and heavy checks stay serialized. After the earlier15 executable
  cleanup, nine passed Rust E2 test binaries were reclaimed with ownership/hash
  proofs (about265 MB); libraries, actual artifacts, source and evidence remain
  intact. Subsequent verified cleanup removed22 MB of closed owned browser
  caches (not IndexedDB),536 MB of unreachable Cargo library variants and passed
  test executables, while preserving the155-node reachable warm graph and44 held
  actual runtime artifacts. The67 batch reached about1.106 GB minimum free disk;
  no hard-floor breach or forced termination occurred. Test cache cleanup after
  acceptance leaves about1.19 GB free. Before a cold matching WASM/native build,
  reassess headroom; never close user/manual apps. Hard floor is1 GiB.

The earlier update below records its own source and verification points.

Current main `cce43207` (2026-10-19):

- Actual release Electron acceptance on `bc013e3b` passes all 32 functional
  phases: grouped Search, case toggle, six automated semantic sorts, dense
  counts/display limits, source/filename/property navigation, pending-edit save
  before navigation, and Live/Reading Find options, navigation, focus, caret and
  painted matches. Root visually confirms Find above the note title/Properties.
  Zero renderer exceptions; normal quit exits 0 with no forced termination;
  owned app/native processes are gone. Evidence:
  `/private/tmp/zorid-s1-rich-electron-bc013e3b-001/terminal-verification.json`.
  Physical native picker and OS IME remain unverified. This small fixture does
  not establish workload performance, autonomous scheduling or complete S1.
- Normal browser production build passes on `cce43207` with real generated WASM
  and stable source/artifacts. The only change since desktop acceptance is a
  build-only Cargo.lock dependency ordering normalization plus `--locked` and
  its regression assertion; three build checks pass. Both installed Cargo
  versions accept the unchanged lockfile offline. Evidence:
  `/private/tmp/zorid-s1-rich-web-build-cce43207-001/validation-summary.json`.
- Actual browser attempt 001 stopped at the disk floor before functional checks.
  After reclaiming verified disposable caches, attempt 002 completed production
  fixture writes and loaded the normal workspace, but stopped at the dedicated
  worker target-count assertion. Production worker/WASM requests were served;
  the report lacks raw target snapshots, so a real worker failure versus CDP
  detection remains unresolved. No browser Search/Find pass is claimed. Node and
  Chrome groups are gone, server closed, source/artifacts unchanged. Evidence:
  `/private/tmp/zorid-s1-rich-web-watch-dfure_bj/acceptance-terminal-summary.json`.
  Browser owner `storage_recovery_ui_impl` and reviewer
  `s1_desktop_scheduler_review` diagnose source only; no blind rerun.
- Rust lookup/CLI/preview-capture/Base refresh changes through `b3719af0` retain
  223 focused passing checks. Frontend Base clock/cancellation/retained-view
  changes through `9226e866` pass 71 checks and TypeScript; actual main additionally
  passes 83 cross-seam checks and TypeScript. These remain scoped results.
- Pure next composition owner `architecture_platform_audit`, branch
  `tingkai-c/s1-pure-facts-composition`, checkout
  `/private/tmp/zorid-s1-pure-next-composition`, frozen `b6d11e69`, combines reviewed
  phased draft parsing/reducer, metadata paging and Store registration fence,
  rich first-build preview query and borrowed preview facts. The 215-check batch
  is authorized, not yet a pass. Dependencies: platform adapters and Base preview
  queries follow passing pure checks. Main integration remains root-owned.
- E2 and F platform wiring, Base first-build queries, normal core runtime
  activation, actual fairness/liveness and S1.6 workload measurements remain
  open. Normal runtime activation flags stay OFF. Workspace per-pane Base
  visibility/configured clock wiring also remains open.
- Obsolete generated Cargo caches and compressed cache payloads were reclaimed
  only after exact ownership/hash/handle proofs. Held desktop/CLI/browser
  artifacts, source and evidence remain preserved. Current free space after
  browser attempt 002 is about 2.85 GB; hard floor remains 1 GiB. The next pure
  batch rebuilds one debug profile with jobs 1; no concurrent heavy builds/apps.

Older execution entries below are historical where superseded by this update.

Integrated D/E1 foundations through `1cc636ef`: common facade `f2a1a54d`,
native/host delivery `8505127a`, desktop scheduler `c23026db`, desktop frontend
`6b4a454b`, browser delivery `d50ee1ca`, and owned consumer cancellation
`1cc636ef`. All50 owned files match canonical `030b7cda` byte-for-byte;
403/403 affected Node checks and full TypeScript pass. Evidence:
`/private/tmp/zorid-s1-d-canonical-2fbrarkk/rerun-process-proof/validation-summary.json`
and adjacent `main-integration-proof.json`. Activation stays OFF; these checks
do not establish actual platform liveness, fairness or generated-WASM acceptance.
The Find-opening math-focus correction is integrated `b6985fd3` after independent
review,25/25 focused checks and full TypeScript. Actual app rerun remains pending.

Latest verified work after frozen `b9d4f069` (supersedes older pending counts):

- Electron scoped005 verifies grouped results, case controls, dense count/display
  limits, exact source navigation, filename/property safe-open and pending-edit
  save followed by fresh search. Live Find reaches counts, previous/next,
  case/word/regex, focus/caret and painted matches. A real renderer exception
  remains: live-math's synchronous blur dispatch re-enters CodeMirror while Find
  mounts. Owner `s1_rich_search_controller` fixes that bridge in isolated
  `s1-live-math-focus`; independent review and actual rerun remain required.
  CDP's untrusted composition-end event does not establish failed text commit;
  physical IME, Reading Find, native sort selection and normal quit remain
  unverified. Actual screenshot also exposes Find below Properties rather than
  the requested top-of-note position. Preserve these separate acceptance gaps.
  Evidence: `/private/tmp/zorid-s1-rich-electron-find-b9d4f069-005/report.json`.
- Matching b9 frontend build and actual screenshots verify the integrated search
  toolbar/scroll/highlight polish. Its source and all frozen artifacts remained
  exact after scoped005; owned app/native processes are gone. Main is unfrozen.
- Validated isolated D/E1 batches: common `9d5a4367` 92 Node + TypeScript;
  native `c52c1521` 22 Rust; host test-only successor `1ef639a5` 11 Rust;
  scheduler `3f763282` 124 Node; desktop delivery composition `61be3e1d`
  77 Node + TypeScript; browser `e83cf312` 110 Node and corrected/common-composed
  `53bb7c27` TypeScript; consumer cancellation `83bb4b7d` 145 Node + TypeScript.
  Base clock/cancellation `6105979b` passes30 Node + TypeScript. Root delegates
  canonical D/E1 composition/checks to `s1_execution_audit`; normal platform
  activation remains OFF until complete integration and actual runtime gates.
- CLI visibility correction `35bc72e7` is source-approved; execution remains
  pending. Core clock/refresh hints, inode lookup and eight preview-capture tests
  remain unexecuted. `architecture_core_audit` prepares one canonical Rust batch;
  this is not authorization to run overlapping heavy checks.
- The exact rebuildable `target/stage4-verified/debug` cache was evicted after
  process/handle ownership proofs, recovering2.85GB. Held actual CLI binaries,
  release/WASM caches, source, archives and evidence remain intact. Free disk was
  about3.15GB after scoped005; hard floor remains1GiB. Future Rust checks require
  recompilation. Never close user/manual apps to recover resources.

Current integration update after `a38416db`:

- Actual matching release Electron `d38af6cf`: import34/34, grouped33/33
  results/counts/continuation and case/group controls pass. Runs002/003 stop at
  native HTML select input: trusted keys reach the focused select but no change
  event/value change occurs. This is an inconclusive native automation gate,
  not an established product sort defect. Dense navigation and Find remain
  unexecuted in this pass. All owned processes are gone; normal final quit was
  not attempted on these failure paths. Evidence
  `/private/tmp/zorid-s1-rich-electron-d38af6cf-003/report.json`.
- Actual screenshots exposed unrelated file toolbar, scrolling search controls
  and low-contrast default marks. Source-reviewed two-file polish is integrated
  `a38416db`; actual repaint/scroll acceptance still pending. Existing matching
  native release artifact remains unchanged; frontend needs a new build.
- S1.4D source approvals: native/host `c52c1521` (22 native+11 host authored,
  unexecuted), desktop scheduler `3f763282` (35 authored; bounded Node validation
  currently assigned to `storage_recovery_impl`), desktop delivery `70538446`
  (final focused/TypeScript unexecuted), common `1ac083c5`/`8f8fa08b`/`dfd64181`/
  `608840c9` (initial20 Node checks only). Common type-only `9d5a4367` awaits
  review/execution after10 TypeScript narrowing errors were exposed. Browser
  `e83cf312` passes110 Node checks; full TypeScript failed, owned nullability
  fix `3a4c7766` is source-approved. All normal runtime activations remain OFF
  until coherent adapters, capable catch-up/rebuild and caller cancellation pass.
  Do not infer actual no-listener liveness or fairness from these source reviews.
- CLI runtime migration `3f2d3f9d` awaits its narrow visibility correction and
  execution. Inode owner lookup `864710be` is source-approved atop earlier
  `a6d57cb9`, with combined native/Store checks and same-cap measurements pending.
  Clock boundary fix/tests `0278d835` and core refresh hints `cbdd3139` are
  source-approved but unexecuted. Frontend temporal refresh owner `s1_query_audit`
  works in isolated `s1-base-refresh-view`; first-build preview remains missing.
- Resource floor remains1GiB. Exact obsolete compiled caches (100 old library
  files, old `stage4-wasm-verified`,10 rebuildable test executables) and three
  closed agent Chrome profiles were evicted after ownership/handle/source proofs;
  prior archives, source, current libraries, actual CLI/release artifacts and
  evidence were preserved. Tests whose executable caches were evicted require
  relinking. App runs use the latest explicit1.70GB start gate. OS swap was
  observed at7.5GiB total; the earlier unexplained disk drop is not attributed
  without a before sample. Never close manual/user apps to free resources.

The older summary below remains historical where this update supersedes it.

Main through `ee7821a6` integrates grouped search/controller, common transport,
pure rich paging, native binding, real WASM/browser binding, standalone rich CLI,
pure lifecycle reducer and the measured transient snippet projector. The older
detailed batch notes below describe their original execution points.

- Rich core reference:75 focused/dense checks. Projector successor:22 snippet
  tests, unchanged dense oracle,49 integration and8 native rich-search tests pass.
  The4MiB/8192-match case uses10 pages/40MiB reads versus128/512MiB; debug single
  observations~1.7s versus26–27s. This is measured pure-engine work reduction,
  not actual app latency. Exact-source evidence lives under
  `/private/tmp/zorid-rich-projector-reviewed-56pwwu5n` and
  `/private/tmp/zorid-projector-consumers-d134-r3_ff0qn`.
- Browser/WASM binding:26 hosted Rust checks,66 Node checks and full TypeScript
  pass; the latter checks pass again on main. Actual generated wasm32/browser
  acceptance remains pending. CLI4 unit+7 actual process checks pass on frozen
  `9a9a78d2`; source is main `1690ddb3`. Evidence
  `/private/tmp/zorid-cli-rich-fcntl-8q7rtifc`. macOS pipe status test correction
  preserves production flag restoration and exact UTF8 output.
- Desktop transport:3 native-backed checks pass on frozen `9e5d7c91`;43 JS/TS
  and6 framed checks plus full TypeScript pass again on main `6c0b6d52`. Actual Electron
  grouped search/Find/sort/navigation/input acceptance remains pending. Owner
  `architecture_core_audit` prepares one canonical all-up validation branch from
  current main in the existing `s1-search-parser` worktree; root integrates main.
- S1.4A pure scheduler:27 checks pass with public module exported; main
  `4cbd4be5`. Store recovery is integrated `0311c7ce`:8 new,22 existing and5
  cache-snapshot checks pass on exact `82ed5aec`. Native driver is integrated
  `ee7821a6`:17 checks pass on exact `ef08da08`, including the test-only missing
  fixture-directory correction. Browser driver is integrated `69bf1577`:6 hosted
  Rust checks pass on strict-decoder successor `5dcd492b`;82 Node checks and full
  TypeScript pass again on integrated main. Original failing test evidence is
  retained. Native/browser adapters remain lazy; automatic host scheduling,
  common freshness/subscription facade and refresh-only frontend migration are
  the next S1.4D–F work. These checks do not establish actual no-listener liveness,
  foreground service, partial first-build results or platform cancellation.
- Four additional targeted native path lookups `a6d57cb9` are independently
  source-approved, with40 scoped native checks pending. No measured10k admission
  gain is established. Native10k/actual100k factory and broader S1.5/S1.6 gates
  remain open; no multicore or later product implementation is authorized here.
- Heavy checks remain serialized with1GiB disk floor. The approved cleanup of
 12 exact agent-created disposable fixture payloads is complete; reports,
  manifests, screenshots, logs, source, binaries and all archives were preserved.
  Evidence `/private/tmp/zorid-s1-strict-fixture-retirement-nd9gqvqk` records
  exact ownership/tree/process checks; five held fixtures remain untouched.
  Matching release Electron artifact preparation is next; preserve manual apps.

- **Active goal boundary:** latest explicit user objective is "Complete the full
  roadmap S1. Stop after that." Complete every applicable S1 slice and its actual
  platform/performance gates, with multicore excluded by latest steering. Stop
  at S1 acceptance; later feature/sync/mobile stages remain planned. Preserve the
  full scope rather than treating parse caching or a resolver fix as completion.
- **Latest steering:** user accepts saving latency after trying the visible app;
  avoid further save-performance detours and continue the maintained roadmap.
  Skip multicore implementation; reduce unnecessary computations. This supersedes
  older multicore requirements below. Core-owned lifecycle/scheduling remains.
  Deliver managed-data foundations and usable local desktop Types/Bases/Tasks/
  Calendar/Google integration before sync-group design and Zorid sync services.
  Stable existing stage IDs remain, but [roadmap.md](roadmap.md) table/section order
  defines delivery; S3 depends on S1, desktop S8 excludes S1A/S2, sync design S1A
  follows S8. Keep local storage sync-ready without requiring transport for local
  feature acceptance. Later sync verifies remote feature/provider-job behavior.
- **Stage:** S0 bounded native delivery and S0A contracts accepted; S1.0 retained
  baselines have explicit large-vault limitations. S1.1 parser/extraction contracts
  and native/browser facts-persistence code are integrated with focused checks.
  Bounded real-client parse-cache acceptance passes Chrome, macOS Electron and
  standalone macOS CLI. S1.2 resolver and preparation/program reuse source and
  binding checks are integrated; evaluated-answer reuse core is integrated with
  focused correctness checks, while host wiring and measurements remain pending. S1.3
  parser/rich-search evaluator and independent find UI are integrated. Rich paging,
  grouped-result mounting and full client
  acceptance and core-owned scheduling remain pending;
  multicore is deferred, not a delivery requirement.
- **S1.2 current scope:** cold resolver and bounded shared Bases preparation/program
  reuse are integrated; conservative answer reuse core is integrated. Baseline relationship resolution
  repeatedly scanned the namespace per link, preventing generated Base10k queries.
  Prepared source-ID and normalized-basename lookups now charge
  actual construction/bucket visits/sorting/cancellation, preserve all matching/
  ordering/ranges and complete graph semantics. No raised budgets/dropped links,
  schema, authority cache, language redesign or new benchmark framework. Implementation
  implementation owner `s1_query_audit`, isolated `s1-generated-bases` worktree on
  `tingkai-c/s1-prepared-resolver` from253b1433; reviewer `architecture_core_audit`. Root
  retains sole main integration. Sources `8a16ed9b`/`b9cb0d4c`/`9a1accdd` are
  integrated `15946258`/`080a6ca7`/`8b17233e`, all affected Rust/Cargo/fixture
  hashes exact,27 focused tests pass and matching release example builds17.88s.
  Existing generated Base100 and10k now pass all eight unchanged full semantic
  oracles;10k has10003 complete records, max1,404,011 steps under unchanged2M,
  query observations65–88ms (one pure-engine sample). This is not native admission,
  UI, cross-query cache reuse or full S1.2 acceptance. All owned processes exited;
  source clean/runtime slot released. Evidence:
  `/private/tmp/zorid-s1-resolver-9a1accdd-focused/verification.json` and
  `/private/tmp/zorid-s1-resolver-release-8b17233e-build/terminal-summary.json`.
  Handoff `/private/tmp/zorid-s1-query-preparation-handoff.md` sections2/3 remain
  the next contract; section1's old resolver map is historical. Manual app untouched.
  Independent S1.2 shared Bases preparation/cache owner `storage_sqlite_impl`
  prepares a minimal typed API first in isolated `storage-parse-cache`, new branch
  from current main; then owns Bases graph/query/program/cache internals and
  focused Bases tests. Resolver public matching contract stays unchanged. Host
  wiring now has separate owners after shared API agreement: `s1_query_audit`
  owns native NativeVault init/cache lifecycle and document_index consumers;
  `architecture_platform_audit` owns WASM document_index and required browser
  document-index adapter wiring. Each uses an isolated new branch from current
  main, composes the shared cache candidate before validation, and coordinates
  exact APIs with the Bases owner. No Store schema/root build/frontend Workspace
  changes; Cargo feature changes require root acknowledgment first. Reviewers
  respectively `architecture_core_audit` and `s1_execution_audit`. This does not
  authorize competing heavy checks or automated control of the user app.
  Root owns shared API decisions and main integration; shared Bases reviewer
  `baseline_resources_impl`. Use session-owned bounded immutable data, full
  generation/facts/source/version keys, current invocation context and explicit
  expiry; never retain a query pin or source-write capability. Existing handoff
  defines accepted contracts; no new authority cache or query language framework.
  Shared source `8317e4c5` plus corrected successor `8a8dcc08` is independently
  approved and integrated as `6037cc9a`/`e66ce9c7`. Initial candidate had6 pass/1
  invalid fixture failure and review blockers; successor fixes the fixture, removes
  repeated hot snapshot/graph serialization and immutable ID/path validation,
  and corrects optional probe/copy admission. All26 focused tests pass (10 cache,
  corpus7, query5, generation4), source hashes exact, no ignored tests or owned
  processes remaining. Evidence:
  `/private/tmp/zorid-bases-preparation-8a8dcc08-71zxmxlv/validation-summary.json`.
  This establishes shared source/focused correctness, not client or performance
  acceptance. Static byte proof belongs to the sealed factory; detached
  query validation and dynamic context/limits/cancellation remain mandatory.
  Optional maintenance gets a separate finite2M-unit allowance per prepare call
  (one typed visit plus each64-byte block), independent of unchanged semantic
  max_steps and32MiB/count caps. Pre-admit complete copies and use checked/
  saturating arithmetic, including wasm32. Actual optional work remains observable;
  successful hit proof carries into evaluation only when no more costly than the
  sealed cold-preparation cost. This preserves tight-valid cold behavior without
  retrying evaluation or raising the query ceiling.
  Native consumer `a0300474` on `tingkai-c/s1-native-preparation-cache` is source
  approved, including exact shared composition `4bc57d48`; all12 focused native
  tests pass and wiring is integrated as `db7b3229`. Evidence:
  `/private/tmp/zorid-s1-native-preparation-4bc57d48-focused/verification.json`.
  WASM/browser `2b73fb3f` plus awaited-pin
  hardening `15c24a13` is source approved, composed with the corrected shared
  dependency as `b0109a1a`;46 Node checks, TypeScript and20 hosted Rust checks
  pass, integrated `03097217`/`ec554b04`. Evidence:
  `/private/tmp/zorid-s1-wasm-preparation-b0109a1a-dtc28hrx/summary.json`.
  Owned test processes exited and the heavy slot is released. Neither binding
  has actual client runtime acceptance yet. One client lease release retires its pins,
  while bounded capability-free data may survive in a still-live shared native
  vault owner; actual owner retirement clears it. Browser owner retirement frees
  its cache and pending calls must not recreate it after an await.
  Root approved typed cache API/LRU policy:32MiB total cache-owned generation data,
  8MiB compiled programs,4/64 entries,5min idle expiry via explicit portable
  monotonic milliseconds; backwards time clears optional entries. Exact actual
  generation data and presentation-facts equality protect same-ID aliases; every
  deep comparison remains charged/cancellable. Externally retained Arc handles
  are caller-owned and must not become host query pins. Native/WASM wiring must
  independently validate pin/source admission before and after evaluation.
  `s1_query_audit` additionally owns a separate reviewed follow-on in index
  resolver/relationships/lib: sealed owned namespace projections with short
  borrows, one matching implementation and no self-reference, enabling Bases to
  reuse preparation rather than rebuilding it. Cold/follow-on commits separate.
  S1.3 source handoff: `/private/tmp/zorid-s1-search-handoff-5ed9b53c/handoff.md`.
  Latest screenshot request adds grouped search UI/case toggle and top in-note
  find bar to S1.3. Reference owner `architecture_platform_audit` completed REA
  static Obsidian evidence; frontend owner `storage_recovery_ui_impl` delivered the
  independent CodeMirror/Reading find panels in isolated branches, owning new find
  modules/styles/tests, narrow editor/Workspace integration and stylesheet imports.
  This presentation work does not depend on the new shared search evaluator and
  can overlap S1.2 validation without changing index policy. Vault-search
  implementation waits for its shared paged-result DTO.
  No proprietary recovered code enters source; user manual app remains untouched.
  Completed static REA reference handoff:
  `/private/tmp/zorid-obsidian-search-static-hznlv_yk/handoff.md`, hash477e08b5.
  Actual cached Obsidian1.14.4 archive hash146ef847, focused REA Evidence
  `ev_0ef7bc2c3b1071afa170b476125a7930b5c0f86d561d97b80e4fb55767df0ada`.
  Full AST attempt exceeded512MiB; seven focused inert components parsed with
  explicit partial/unbound limits. No app/vault access or runtime parity claim.
  Preserve reference count nuance: overall includes filename matches, per-file
  badge excludes filename; choose/document deliberate Zorid behavior instead of
  guessing from snippets. Six sorts and default case toggle off are confirmed
  statically. In-file standard reference has no options; requested options remain
  a deliberate Zorid requirement. S1.3 DTO/UI addendum:
  `/private/tmp/zorid-s1-search-handoff-5ed9b53c/ui-addendum.md`.
  After shared/native/browser preparation source and focused correctness passed,
  independent S1.3 pure search and parser-facts work starts while remaining S1.2
  answer reuse and measured/client gates continue. This overlap avoids idle source
  work without accepting either slice or changing active storage/client paths.
  `s1_query_audit` owns new index search modules, narrow index exports and the
  pinned existing regex dependency; `architecture_core_audit` owns document parser
  facts and proposes explicit metadata-version/validator changes first. Their
  schema/API agreement precedes edits; `storage_recovery_impl` reviews search.
  No new shared-search platform migration starts before the pure contract passes.
  Parser schema agreement adds typed block/list-item intervals and explicit task
  itemRange while preserving existing checkbox/text ranges. Document schema2
  intentionally invalidates old extraction keys; no SQL/index-schema bump or
  silent schema1 migration. Parser owner additionally owns document initializer,
  index restore validation, typed TS metadata DTO and focused affected tests;
  frozen historical49 fixtures remain checked through explicit test-only legacy
  projections, with new schema2 raw-source interval fixtures tested independently.
  Parser source `4b8a7aa0` plus restore-topology successor `824dfeec` is independently
  approved:22 initial focused checks/TypeScript and13 affected successor checks
  pass with frozen fixtures unchanged. Parser and strict restore successor are
  integrated as `f7a2280f`/`d5098749`; version-only baseline bridge `0cd1cc24`
  is integrated as `48cb6c77` alongside schema2.
  Pure rich search `b2b73a60` is independently source-approved and compiled;
  first run11/13 tests pass, including all19 accepted target and36 Unicode cases.
  Two new test assumptions need correction (optimized literal regex memory and
  unquoted negative comparison grammar); old literal phase correctly did not run.
  Dense large-note literal work accounting is also being checked before acceptance.
  Evidence: `/private/tmp/zorid-rich-search-b2b73a60-focused-oxevq553/verification.json`.
  Rich paging/result proposal `/private/tmp/zorid-s1-rich-page-contract.md` remains
  under review, including honest counts, retained sorts and snippet provenance.
  `storage_sqlite_impl` separately owns conservative answer reuse in Bases only;
  `baseline_resources_impl` owns the opt-in existing generated-Base preparation
  measurement path and reviews the answer cache. Neither changes existing frozen
  defaults/oracles/caps or claims that a cache unit test establishes UX improvement.
  Preparation measurement `055c82c1` integrated `d70e93c0`: matching release
  example builds19.53s;100 and10k each pass all24 full-result comparisons and8
  unchanged oracles.100 has1 miss/15 hits (13,396 cold preparation units versus
  3,193 hit proof units; ordered hit observations0.017–0.027ms).10k remains
  Uncached on all16 attempts; no10k preparation reuse gain is established. Both
  reuse compiled programs. No cap/oracle changes or client-speedup claim. Evidence:
  `/private/tmp/zorid-bases-cache-observation-055c82c1-k_blpv0b/acceptance-summary.json`.
  All owned processes exited. Read-only diagnosis reproduced690,032 optional
  maintenance units: prepared allocation admission alone exceeds32MiB before
  proof copies; shared namespace was counted twice. Answer successor includes
  factory-proven unique namespace accounting and early bounded admission, still
  independently reviewed and focused-tested; new same-workload measurements are
  still required before any gain claim.
  Top editor find source `0fad2065` is independently approved and integrated
  `b3df4514`,42 focused checks plus TypeScript pass. User screenshot layout is
  implemented using existing icons/styles and CodeMirror commands, not painted
  verified yet. Reading source `4e76fa21` is independently approved/integrated
  `c746914c`;17 focused checks/TypeScript pass. Proved stale lifecycle expectation
  is separately corrected `b6def323`/`50cac67d`,9/9 lifecycle checks pass. Vault-search
  result UI remains pending rich-engine transport. Do not claim screenshot parity.
  Painted editor-only Chrome attempt stopped at disk floor before results; no
  screenshots/acceptance, all owned processes exited, manual apps untouched.
  Completed50 Cargo test executables are now verified lossless gzip archives,
  reclaiming711MiB; source/reports/release binaries and100 fingerprint/depinfo
  files remain exact. Archive proof:
  `/private/tmp/zorid-s1-owned-test-archive-qh52me5a/terminal-summary.json`.
  Free space recovered to1.44GiB. Keep heavy checks serialized with1GiB floor;
  no active heavy slot after completed focused checks. Don't remove archives
  or assume their old test executable paths still exist without restoring them.
  Subsequent exact rich candidate `76d8e9d9` passes14 rich tests plus unchanged
  literal baseline (19 target/36 Unicode cases; literal19 cases at page1/100).
  All8192 exact occurrences in a4MiB control pass ordinary/quoted/plain-slash
  forms at387,455 work units under unchanged2M/10k/1MiB limits. This fixes false
  quadratic literal accounting, not a measured CPU-speedup claim. Evidence:
  `/private/tmp/zorid-rich-search-76d8e9d9-focused-x8ge2hpk/verification.json`.
  Exact reviewed eight-file matcher source is integrated as `a24a4fa5`; this is
  pure-engine correctness, not paged transport or actual-client acceptance.
  Coordinated DTO freeze: `/private/tmp/zorid-s1-rich-search-dto-freeze.md`.
  Follow-on page owner remains `s1_query_audit`; presentation owner
  `architecture_platform_audit` delivers isolated unmounted `1dfe2430` plus
  `8b72c803`,10 checks plus TypeScript, independently source-approved by
  `storage_recovery_ui_impl`. Generation/query/output coverage stay independent;
  snippets render supplied ranges and counts. No
  Workspace/transport migration is accepted yet. Root approves initial separate
  64M order-preparation work ceiling from a deterministic100k comparison model
  (duplicate-name control59.84M); actual Rust bounds/order tests remain required.
  It does not raise the2M per-document evaluator ceiling; sorting must yield.
  Final answer candidate `56e558e3` is independently source-approved and its exact
  six-file source integrated as `af29b01f`. All40 focused checks pass (24 units,
  corpus7/query5/generation4), none ignored; source/fixtures remain exact and
  owned processes exited. Evidence:
  `/private/tmp/zorid-bases-answers-56e558e3-vatyawa7/validation-summary.json`.
  Native answer wiring owner `architecture_core_audit` uses isolated
  `tingkai-c/s1-native-answer-cache` from `af29b01f`; WASM owner
  `architecture_platform_audit` uses a separate isolated branch from that main.
  Both preserve sealed lookups, unchanged wire results and pre/post admission
  fences; no client acceptance or answer-cache speedup is established.
  Native exact `8d89d55e` is independently approved and integrated `2cfe17be`:
  all12 focused native checks pass, including actual cross-pin answer hits,
  changed context/view/clock, cancellation/budget and late independent rebuild
  expiry. Source/Cargo/fixtures remain exact; owned group exited, minfree2.016GB.
  Evidence `/private/tmp/zorid-native-answers-8d89d55e-u493gjqq/summary.json`.
  WASM exact `3998e64c` is source-approved but first hosted run is21/23:
  two new fixture assumptions need correction (a Call-containing query was
  assumed clock-independent, and a YAML Boolean was used where a filter
  expression is required). Do not infer accepted wiring or force cache hits.
  Source remained exact and owned processes exited.
  Evidence `/private/tmp/zorid-s1-wasm-answer-3998e64c-3wlijk3m/result.json`.
  Measurement owner `baseline_resources_impl` uses isolated
  `tingkai-c/s1-bases-answer-observation` for the existing opt-in100/10k workload,
  unchanged frozen oracles/caps. Root retains sole main integration. Earlier failures
  exposed oversized test String capacity and an expanded-year cold-clock panic.
  Test fixtures are corrected without weakening caps; optional cache declines
  unsupported clocks. Cache eligibility alone did not fix the underlying panic;
  it was tracked separately rather than ignored as pre-existing.
  Minimal cold-clock correction `9301db0a`, owner `storage_sqlite_impl` and
  reviewer `s1_execution_audit`, is integrated `da9b31eb`. All41 focused checks
  pass (25 preparation plus corpus7/query5/generation4), including valid year
  boundaries, unsupported epoch diagnostics across cold/prepared/live cache,
  lazy ignored rows and unchanged file timestamp behavior. Source/Cargo/frozen
  fixtures remain exact, groups exited; evidence:
  `/private/tmp/zorid-bases-clock-9301db0a-rkg0fuhh/validation-summary.json`.
  Native/WASM runtime boundary acceptance remains separate. WASM test-only
  successor `0874604f` is independently approved;23/23 hosted checks pass,
  with all1545 source hashes exact and owned group exited (minfree1.965GB).
  Ordered wiring/fixture sources are integrated `f3a5799c`/`1b38c14b`;
  no product semantics changed to force fixture hits. Evidence:
  `/private/tmp/zorid-s1-wasm-answer-0874604f-r0ue6fvy/result.json`.
  Actual generated wasm32/browser acceptance remains pending. Measurement
  source `b6f1e69d` is independently approved,18 Node checks pass; composed
  source `b6b428a4` includes main `da9b31eb` with identical three-file patch.
  Matching release example builds20.566s; both100/10k pass8 direct+16 prepared+
  16 answer full-result comparisons and all8 unchanged semantic oracles. Source,
  Cargo, fixtures, harness and immutable binary remain exact; owned processes
  exited and slot released, minfree1.879GB. Measurement is integrated `c2341a8b`.
  At100, preparation has15 hits/1 miss; answers4 hits/4 misses/8 uncached.
  Hit calls observe0.009–0.029ms versus ordered seed misses0.404–0.845ms;
  these are not controlled speedup or CPU measurements. At10k, both preparation
  and answers remain uncached for all16 attempts; cold queries65.7–88.6ms,
  preparation37.2–44.1ms and813,977 optional work units. No10k reuse gain is
  established; keep this practical limitation in the S1 acceptance gate.
  Evidence:
  `/private/tmp/zorid-bases-answer-observation-b6b428a4-ubi2uu_w/acceptance-summary.json`.
  Separate measured10k admission prerequisite owner `storage_recovery_ui_impl`
  uses isolated `tingkai-c/s1-family-entry-cse` from `0d0bb27d`, solely
  `family_metadata_transactions.rs`: reuse checked entries through one immutable
  read transaction instead of loading them twice. Observations retain their fresh
  read and final writer/physical/authority/CAS checks remain unchanged. Reviewer
  `storage_sqlite_impl` independently approves exact `4dd311a2`, integrated
  `078d877d`. All18 focused Store checks pass, including SQL-count1 instead of2,
  malformed/missing/path/revision mismatch, corruption and independent writer
  invalidation. All356 source/fixture hashes remain exact and owned group exited.
  Final process-inventory permission failure prevented serializing minimum disk;
  floor never tripped, terminal free1.819GB, minimum honestly unavailable.
  Evidence `/private/tmp/zorid-entry-cse-4dd311a2-dkw4l0mz/validation-summary.json`.
  This removes one duplicate load, not cumulative whole-vault scans. Normal-family
  client/performance acceptance and measured gain remain pending.
  S1.4 current core-lifecycle source handoff:
  `/private/tmp/zorid-s1-core-lifecycle-handoff.md` (no implementation yet).
  Concrete ownership and closed reducer-contract refinements:
  `/private/tmp/zorid-s1-lifecycle-execution-breakdown.md` and
  `/private/tmp/zorid-s1-lifecycle-reducer-contract.md`. These are preparatory;
  native captured-stage-source/bounded discovery and legacy TS metadata/draft
  parsing remain real migration gaps, not accepted runtime behavior.
- **Latest S1 integration/ownership update (2026-10-19):** main through
  `3dd5f7b7` additionally includes rich DTO/order `ca7be8bd`, Manifest ordinal
  lookup `91db7aa8`, early optional proof admission `afe0469c`, and Store's
  shared immutable pin-generation bridge `3dd5f7b7`. Combined Manifest/proof
  candidate `48e92919` passes74 focused checks; the Store bridge passes5.
  Existing pin/source/owner fences remain mandatory; retaining the generation
  Arc does not retain a query pin or source capability.
  Matching post-admission observation at `afe0469c` passes the same40 full-result
  comparisons and8 unchanged oracles for both100 and10k. At10k optional work
  falls813,977→588,280 units (27.7%); mandatory work remains1,320,196 and all16
  preparation/answer attempts remain uncached. Preparation median37.72→37.39ms
  does not establish meaningful timing/CPU improvement or attribution to either
  individual change. Evidence:
  `/private/tmp/zorid-bases-post-admission-afe0469c-hkak32xx/acceptance-summary.json`.
  Pure rich paging owner `s1_query_audit` has source `38224a00` under review;
  native owner `architecture_core_audit` has `80c155ce` including callback-safe
  retirement. Compose scoped rich-search files rather than merging divergent
  branch ancestry, preserving integrated Manifest/resolver and Store fixes.
  Pure compilation, dense4MiB/8192-match paging and native tests remain pending.
  Browser binding owner `architecture_platform_audit`; common facade/decoder and
  Worker forwarding owner `baseline_resources_impl`; desktop transport owner
  `s1_rich_desktop_transport`; CLI owner `storage_recovery_ui_impl`; frontend
  controller owner `s1_rich_search_controller`. Each works isolated; root remains
  sole main integrator and grants serialized heavy validation. Common decoder
  successor review and browser implementation are not yet accepted. Desktop
  `58cdb305`/`c198d5fa` is source-approved with focused JS/TS checks, but Rust
  host and actual Electron acceptance remain pending. CLI `76a8431e`/`fdee79c8`
  is source-approved and uncompiled. Frontend through `c84bd79f` is independently
  source-approved with69 focused checks; final cross-page validation and common
  dependency composition remain pending. None of these pending batches is main.
  Grouped-view painted wide/narrow fixtures show the requested pill/Aa/sliders
  layout; actual native sort input is unverified. Component paint does not
  establish mounted normal-app search/Find or platform/performance acceptance.
  Follow-on integration: grouped presentation `b039d6e4`/`38858887`/`7d922a1c`,
  approved common facade/decoder through `15a66cd4`, and approved controller/
  Workspace through `8968632f` are now main. All76 composed focused checks pass
  again on main; owned source files match their approved feature candidates.
  Real browser methods, native/desktop/CLI composition, full TypeScript and
  actual client acceptance remain pending. Pure/native scoped composition
  `501c34b1` passes the bounded index-library check (7.13s), with366 source and
  49 frozen JSON/Cargo fences exact; minimum disk1.290GB and owned group gone.
  This is compilation, not native runtime proof. The reviewed successor adds
  explicit evaluation-versus-output coverage and a4MiB/8192-match dense paging
  oracle before broader validation. S1.4A pure lifecycle owner `s1_lifecycle_core`
  works isolated at `/private/tmp/zorid-s1-lifecycle-core` on
  `tingkai-c/s1-lifecycle-core`, new runtime module/tests only; shared exports and
  platform migrations await named coordination. No lifecycle implementation
  acceptance yet; heavy validation remains serialized.
  Rich core `a161b921` is now integrated `d51f64dd`:49 focused integration
  checks,25 embedded search units and the dense three-form full-range oracle
  pass on frozen composition `06d0de82`. No source/fixture/Cargo drift or owned
  process remains. Dense correctness exposes128 body reads per query (512MiB),
  tracked in user-findings; parent `s1_query_audit` owns the transient projector
  follow-on, with snippet implementation isolated from the frozen reference.
  Native testing caught initializer typo `fresh()`→existing `new_op()` (source
  `2b70cd57`) and missing fixture folders (`4043c899`). Six of8 native checks
  pass; remaining test assumptions about optional query capacity and binary
  metadata coverage are being corrected, preserving production limits/fences.
  Native batch is not yet main or accepted. Browser/WASM `ab62e058` is under
  independent review, including post-await owner and failed-admission cleanup.
  Browser admission four-method forwarding `984b23c1`/`98f654cd` is independently
  source-approved; composed real adapter passes full TypeScript and64 focused
  Node checks, not yet integrated or actual-engine acceptance. Source lifecycle
  `6b1bd605` is independently approved (27 authored unexecuted tests), no shared
  export/consumer changes; `Continue` avoids redundant status reads while real
  wakes remain dirty and uncertainty retries are bounded. Native reconciliation
  source audit owner `storage_sqlite_impl` implements only four remaining targeted
  path reads in isolated `s1-family-live-lookup`; no claimed10k timing gain.
  Baseline276files/32passes predates Store CSE and is not a post-CSE measurement.
  Disk headroom recovered only by verified lossless archives of12 old Store
  libraries and8 disposable completed test executables; source/build metadata,
  previous archives and unrelated/user data remain intact. All future heavy
  checks retain the1GiB floor and exclusive slot.
- **Integrated:** scoped observation-lookup fix through `2c53a98d`,193
  focused checks/1 existing ignored fixture, release build and normal-family100
  source/search checks pass. Small Base17 semantic-baseline tool is integrated
  through `da536a82` and passed real release execution. Four native indexed path
  selectors are integrated `56dd1de9`,35 focused checks and family100 pass.
- **Current limitation:** legacy10k still stops at import,6,167 entries/240.656s
  versus3,383/240.256s and initially2,378/240.316s. No native10k index/search result or completion gain
  is established. Pure-core10k and actual-browser100 passed within their stated
  scopes. Generated Base100 passed all eight semantic oracles;10k generation completed,
  and all eight queries now pass after the resolver prerequisite above. Native
  full-vault admission and the broader S1 performance gate remain unresolved.
- **Active owner/slot:** focused test slot released. Shared extraction core
  `effeb61f` is integrated `ae227303`,37 tests pass. Native facts persistence
  `0ba607c1` is integrated `cbba5096` after exact-main composition `effbffad`
  passes34 checks (12 new +22 existing), no failures/ignored, hashes exact,
  owned processes gone. Evidence:
  `/private/tmp/zorid-native-cache-composed-0ba607c1-2f799pin/validation-summary.json`.
  Browser/WASM through `8ce4509d` is integrated `b4cf40f2`:42 Node checks +tsc
  pass, and16 native-hosted Rust checks on identical Rust source. Evidence:
  `/private/tmp/zorid-s1-browser-a29622a0-validation-p7usgo95/rebuild-per-pump-result.json`.
  Both use generation-only rebuild preserving facts and per-pump new counters;
  old reuse-counter semantics stay unchanged. Normal matching WASM build and
  generated-binding TypeScript check pass on frozen `6f2b177b`. Actual Chrome100
  passes all five phases; the tiny nine-phase cache cohort passes restart/rebuild
  hits with same-entry reuse zero, new identity/rename binding, byte/mode/scope
  misses and same-length valid-JSON checksum-corruption fallback. Public metadata,
  ranges/search/backlinks and source/checkpoint/receipt fingerprints remain exact.
  All owned Chrome processes/servers exited; source/artifact fences unchanged.
  Evidence `/private/tmp/zorid-s1-browser-cache-6f2b177b-build/final-proof.json`,
  `/private/tmp/zorid-s1-web-cache-100-6f2b177b-evidence/report.json` and
  `/private/tmp/zorid-s1-browser-cache-tiny-6f2b177b-evidence/report.json`.
  Matching native release `255caa28` passes in104.363s; desktop frontend and
  unchanged normal Electron100 pass all five phases, including exact save,
  checkpoint, search and retained warm generation. Three normal quits drain
  native hosts; no owned processes remain. Read-only inspection validates103
  source-corresponding fact versions, not observed cache hits. Evidence:
  `/private/tmp/zorid-s1-release-255caa28-retry-4icis0if/build.json` and
  `/private/tmp/zorid-s1-cache-desktop-255caa28-evidence/acceptance-summary.json`.
  Shared Cargo artifacts initially contained older parser exports; metadata-only
  workspace invalidation preserved source bytes and fixed the matching build.
  Later Electron launches still record reconciliation scan-limit warnings and
  guarded read errors; these remain open, not an error-free runtime claim.
  Standalone CLI14-phase cache acceptance now passes frozen `44181d1c` with
  matching immutable `255caa28` binary: restart/rebuild hits with same-entry reuse
  zero, contextual binding, invalidation, disposal/corrupt/unsupported fallback
  and exact receipt replay. All source/authority/history/receipt/recovery and
  other-vault cache fingerprints remain exact;240 invocations exit normally and
  owned processes are gone. Evidence:
  `/private/tmp/zorid-s1-cli-cache-acceptance-runtime-7XcZbG/acceptance-summary.json`.
  Earlier tool/disk failures remain retained, not credited as passing tests.
  This accepts bounded reusable-facts correctness, not performance or full S1.
  Desktop transport compatibility fix `f22d162f` is integrated `a70c8202`:
  permit validated optional native `parseCache` counters and preserve them in
  frontend progress. Owner `storage_recovery_ui_impl`, isolated
  `tingkai-c/desktop-parse-cache-transport` / `storage-recovery-ui`; independent
  reviewer `storage_recovery_impl`. Parent-source regression has two intended
  failures; candidate11/11 and TypeScript pass. Four integrated file hashes match
  validated source; Rust/browser inputs are unchanged from the tested freeze.
  Evidence `/private/tmp/zorid-desktop-parse-cache-validation.json`. Actual
  matching CLI cache acceptance and Electron compatibility now pass.
- **Native read fixes — integrated, mixed app result:** remove capture's duplicate metadata validation
  within the same transaction (`entry_content.rs` / `document_index.rs`). The
  current Electron100 observation is5.7s cold search and1.8s post-save index
  refresh; these are single observations, not a performance comparison.
  Source audit confirms capture validates/decodes the bounded metadata scan,
  discards it, then rereads each row. Reuse only that invocation's checked rows;
  retain every fresh stage/publication capture. No new authority cache/API.
  This small native indexing prerequisite precedes S1.2 Base preparation work
  because it targets the observed ordinary app flow. Owner `storage_sqlite_impl`,
  independent reviewer `s1_execution_audit`; isolated
  `tingkai-c/s1-index-capture-cse` / `storage-parse-cache`. Source `578d4e31` plus
  test-only correction `f17d3bae` is integrated `89fb84c5`;31 focused checks pass.
  Four-entry regression records16 point metadata reads before versus8 after,
  retaining presentation validation. The interrupted1GiB-floor run is not credited;
  final22 pass with source-bounded512MiB floor, minfree740MB, no survivors. Evidence:
  `/private/tmp/zorid-capture-cse-f17-index22-uni_o3qm/validation-summary.json`.
  Existing before binary and Electron100 harness provide comparison;
  no new benchmark framework. Audit:
  `/private/tmp/zorid-s1-native-index-source-audit-255caa28/audit.md`.
  The independent next selector change replaces only enrolled-family
  `observe_streamed_file`'s `list().find(path)` with the existing fresh targeted
  metadata read. Integrated `56dd1de9` already establishes unrelated-row isolation
  as intended; physical ownership/inode/parent/CAS guards remain unchanged.
  Owner `baseline_resources_impl`, reviewer `architecture_core_audit`, isolated
  `tingkai-c/s1-family-observe-lookup` / `s1-index-extraction`. Source `9930d3d8`
  is integrated `b57e6f5a` after composed `7f30b2d5` passes48 focused checks and
  old-selector regression fails as intended. All five integrated Rust files match
  the tested composition. Evidence:
  `/private/tmp/zorid-family-lookup-7f30b2d5-v79uygow/validation-summary.json`.
  These fixes pass a matching native release build on `fa76b894` and unchanged
  normal Electron100 comparison. All five correctness phases pass; three normal
  quits drain hosts, no survivors, source/native/frontend hashes exact. Single
  observations: cold search5.706→1.042s, post-save search1.838→1.018s, but durable
  save1.994→6.657s and editor-input→visible3.873→7.713s are worse. Import/opening
  is roughly unchanged; reopen scans still hit limits, now notes88/90 versus55/52.
  Do not claim an overall speedup or attribute all phase changes to these fixes.
  Evidence `/private/tmp/zorid-s1-release-fa76b894-cgo65brr/build.json` and
  `/private/tmp/zorid-s1-cache-desktop-fa76b894-evidence/comparison-summary.json`.
  The subsequent complete metadata-only trace does not reproduce active rescan
  contention: rescan finishes163ms before input. Save window12.155s includes200
  full snapshots totaling11.208s; commit RTT710ms. Source-backed candidate is
  per-note `readMetadata(path)` using `list_snapshot`; trace has no caller stacks.
  Integrated fix is payload-free indexed `stat_path` through Store/native/host
  and desktop client, preserving existence/size/revision guards. Rust owner
  `storage_sqlite_impl` in isolated `storage-parse-cache`; desktop bridge owner
  `storage_recovery_ui_impl` in isolated `storage-recovery-ui`. Branches respectively
  `tingkai-c/s1-stat-path` and `tingkai-c/desktop-targeted-metadata`. Reviewers
  `architecture_core_audit` and `s1_execution_audit`. Rust source `191ea1bc` is
  integrated `33b84512`,17 focused checks pass/one existing64MiB test ignored;
  CJS `bcad864b` is integrated `03642609`,82 checks pass. All integrated files
  match validated candidates. Matching release build passes74.735s, followed by
  unchanged Electron100 five-phase correctness and three normal quits/host drains;
  no owned processes remain. Evidence:
  `/private/tmp/zorid-stat-path-191ea1bc-lnbgn8fq/validation-summary.json`,
  `/private/tmp/zorid-desktop-stat-path-validation.json`,
  `/private/tmp/zorid-s1-release-03642609-rgolk1bk/build.json` and
  `/private/tmp/zorid-s1-electron-stat-path-after-diagnostic/summary.json`.
  One traced comparison: edit→durable12.155→1.917s, edit→visible13.726→3.110s,
  full snapshots during save200→1; no stat calls inside that window. Background
  reconciliation differs; initial import worsens37.941→65.630s, cold search
  1.044→1.587s, warm121→145ms. Do not claim a universal/overall speedup. Native
  commit RTT824ms and pre-submit973ms remain; small-save<100ms target unmet.
  Root retains sole main integration; no scheduler redesign or editor-internal
  change. Next diagnosis: bounded native commit profiling (platform owner,
  independent `storage_recovery_impl` review) and read-only pre-submit timer audit
  (`storage_recovery_ui_impl`). No new runtime granted until profiling plan review.
  Native source handoff for remaining global recovery/planning candidates:
  `/private/tmp/zorid-commit-intent-source-handoff-917f62fa.md` (not timed attribution).
  Pre-submit source audit identifies hidden-app timer throttling as a confound:
  harness hides AppKit app; default backgroundThrottling remains true, and400ms
  debounce resets across three edits/78ms. Timer firing was not observed. Do not
  present1.917s as established foreground latency or973ms as entirely active work.
  Independent after-result review confirms raw pairing/counts and saved data;
  save app uses200 stat calls outside the save window and only4 full snapshots
  overall (prior330); current save window has one full snapshot, zero stat calls.
  User-requested manual app is visible: PID37059/native37123, isolated source
  snapshot175f7b6c with accepted nativece73, root
  `/private/tmp/zorid-manual-latest-GXjJD5`, vault `Zorid Latest` (11 disposable
  notes), profile/data under that root. Normal desktop path, no instrumentation
  or automation. `/private/tmp/zorid-current-manual-playground.json` points there;
  preserve prior manualPID66932 as well. Exclude both from automated control,
  sampling and cleanup. User owns this window; do not close it after verification.
  Next profiling plan is independently reviewed at
  `/private/tmp/zorid-s1-native-commit-sample-plan.md`; platform owner may prepare
  a minimal private implementation for review only. Competing app/profiling/build
  runtime is not granted while the user is trying the manual app. Independent
  source preparation/review continues; this does not pause the roadmap goal.
  Evidence `/private/tmp/zorid-s1-electron-fifo-diagnostic-7caf7cd4/summary.json`.
  The app/runtime slot is released. Frontend313 required inputs/dist333 files are
  unchanged from accepted `255caa28`; raw main CJS changed deliberately and is
  separately hashed; native Vite mode excludes WASM, so reuse that frontend.
  Build owner `storage_sqlite_impl`, app owner `architecture_platform_audit`;
  no new framework or unrelated rebuild.
- **Combined native result:** release `b3ed4400` passed build115.545s and family100
  correctness (all eight full literal oracles, complete coverage, exact physical/
  authority sources and watermark108). Rust inputs match integrated `2fb58f33`;
  later parser facts remain separately validated. Same default family10k profile
  stops at32 passes with 276 live files versus prior224, no index/query phase.
  Host5.166s +rescans180.081s; external run197.420s. Inventory2385/unfinished
  differs from prior3030 and prior run included one observer window: partial
  admission progress is not full-vault or desktop-startup speedup acceptance.
  All10,003 physical files, executable/tool hashes exact; owned processes gone.
  Evidence `/private/tmp/zorid-s1-cli-family-release-b3ed4400-10000/report.json`,
  `/private/tmp/zorid-s1-candidate-release-b3ed4400/build.json`.
  Remaining native admission scalability is still required for S1 acceptance.
  Further import architecture changes remain a separate scoped review; this
  batch selects no new authority snapshot cache or batch API.
  Composed family24-test +old-red/restored-source proof remains at
  `/private/tmp/zorid-family-view-validation-61fa/summary.json`.
- **Loader integration:** reviewed source through `028bc96d` is integrated
  `667c4f48`.202 unique scoped checks pass/1 existing ignored. Three broader test
  expectations fail identically on unchanged main: schema3 presentation migration,
  schema2 scan migration, and historical directory-baseline revision equality.
  These remain explicit test debt, not a full-suite pass or a policy expansion.
  The initial new backing-corruption fixture hit an immutable trigger before its
  reader assertions; its reviewed fixture-only correction now passes. Evidence:
  `/private/tmp/zorid-metadata-loader-028bc96d-validation-q3dn7zjm/validation-summary.json`.
  All tracked hashes remain exact;19 owned Cargo PIDs are gone.
- **S1.1 ownership:** parser facts `ae342a51` is source reviewed and integrated
  `343a6c1b` after19 focused parser/corpus/bounds tests pass, no ignored tests;
  hashes exact and owned processes gone. Evidence:
  `/private/tmp/zorid-s1-parse-facts-ae342a51/verification.json`. Typed scoped
  extraction/key/binding and bounded cache policy are integrated;
  `storage_sqlite_impl` owns new
  native cache-only persistence, `architecture_platform_audit` browser/WASM
  adapter and optional validated cache counters. These are now integrated with
  focused checks and bounded actual Chrome/CLI/Electron correctness; multicore
  and overall S1 performance acceptance remain pending. Preserve existing
  parser output, source fences and separate authority/cache schemas. Root sole
  main integrator; no push.
- **Residual admission CSE:** `397e011c` is integrated `5bb1d4f0` after24
  focused checks pass. Old two-load preparation fails the intended real SQL-count
  assertion (2 versus1); exact source restored before green. All four Cargo
  groups gone. Private validation returns its own complete checked Text vector;
  final writer still reloads and compares fresh authority. No new cache/schema/
  public API/batch semantics or measured gain. Evidence:
  `/private/tmp/zorid-retained-text-cse-397e011c-validation-4a9jkbtx/validation-summary.json`.
  Fold into the next combined client build; no separate benchmark campaign.
- **Desktop verification:** corrected normal100 passes exact save/file/native/
  checkpoint, fresh search and retained warm index/revision gates. Three apps quit
  normally; source/build hashes unchanged, no survivors. Evidence:
  `/private/tmp/zorid-s1-desktop-100-071b8500-evidence/report.json`. Harness integrated
  through `8a03b0d5`; earlier CDP multiline-loss diagnosis is retained separately.
  This is hidden macOS correctness scope, not10k or foreground performance parity.
- **Baseline tooling:** generated-Base tool `ffaee3ad` is integrated `9235ab46`;
  Node10 checks, real release100 semantic gates and honest10k budget outcome are
  recorded. Opt-in Darwin process CPU/RSS tooling is integrated `66cd9728` from
  reviewed `8741c686`:15 resource/lifecycle tests, existing default checks and
  real core100/Base17/CLI1 legacy+family smokes pass.36 selected measured
  invocations retain exact raw sidecars/source/binary proofs; owned groups and
  PIDs absent. Small instrumentation smokes are not representative speedup or
  memory-distribution acceptance. Evidence:
  `/private/tmp/zorid-s1-process-resources-c2f2b75a-syq_b62c/validation-summary.json`.
- **Boundaries:** serialize heavy builds/timing on the8GB Mac. Current runtime
  targets are macOS Electron, web and standalone macOS CLI. Native mobile and
  other OS checks stay deferred. Sync remains E2EE; new group-lifecycle policy
  discussion waits for the user. Original real vault remains untouched.

Current component ownership (all depend on reviewed parser/index contracts;
source approval is distinct from compilation and real-client acceptance):

| Owner | Branch/worktree under `/Users/ctk/orca/workspaces/Zorid` | Verification |
| --- | --- | --- |
| `storage_sqlite_impl` | `tingkai-c/s1-index-capture-cse` / `storage-parse-cache` | Capture CSE integrated `89fb84c5`,31 pass; next matching combined native build |
| `architecture_platform_audit` | `tingkai-c/s1-browser-parse-cache` / `s1-browser-parse-cache` | Integrated `b4cf40f2`;42 Node +tsc +16 hosted Rust pass; actual matching WASM/Chrome100 +tiny9 pass on `6f2b177b`, slot released |
| `s1_execution_audit` | `tingkai-c/storage-retained-text-cse` / `storage-retained-text-cse`, base `2f37f56c` | Integrated `5bb1d4f0`;24 focused checks +old-red/restore pass; no measured gain |
| `baseline_resources_impl` | `tingkai-c/s1-family-observe-lookup` / `s1-index-extraction` | Selector integrated `b57e6f5a`,48 composed checks pass; actual app comparison next |

Disk maintenance: three completed legacy10k fixture `vault`/`local-data` trees
(`80dfce28`, `51060b1d`, `d0de1c83`) were archived after no-open-file checks to
recover space. Their `disposable-data.tar.gz` archives are byte-verified against
per-file hashes in each `fixture-retirement.json`; reports, manifests and raw logs
remain unchanged. No shared targets, real vaults or manual playgrounds were removed.
Old evidence paths now require archive extraction for live fixture access.
The same verified retirement now covers the `vault`/`local-data` children of
normal-family10k `b3ed4400` and `d0de1c83`, and only `vault` in pure-core10k
`3f41fe08` and generated-Base10k `ffaee3ad`. Each root retains its complete
`fixture-retirement.json`, compressed archive and unchanged top-level evidence.

Detailed evidence, ownership and limitations follow. Earlier checkpoint sections
retain their original dated decisions and are superseded by this current summary.

## Active S0 execution — 2026-10-18

User authorizes implementation and requires automatic recovery with no technical
details in product UI. Ambiguous competing versions must still be preserved.
Storage coordinator owns sole main integration under native relay msg_d791657afb5c,
starting clean d07a869b; no push authorization. iOS/features remain paused.
Integration worktree: `storage-foundation` / `tingkai-c/storage-foundation`.
Workers: `storage-sqlite` owns checked SQLite open + Store seam;
`storage-recovery` owns local snapshot module and settled publication cleanup;
`storage-recovery-ui` owns quiet automatic retry UI + desktop-host hookup.
Root owns native snapshot integration, dependency lock and combined validation.
Independent core/platform reviewers inspect scoped changes. Heavy Rust checks
serialized. Implementation commits and integrated verification will be recorded
here; module-level tests alone do not establish desktop runtime acceptance.


### S0 active verification batch — 2026-10-18

Root isolated integration is now `storage-foundation` /
`tingkai-c/storage-namespace-integration`, application source `687d44f0` plus
main documentation reconciliation `8be5ea8a`. Native Store/native handoff is
`0ebd760e`/`048d7a5a` with synthetic repro `af8b07cb` and typed assertion fix
`41f67afd` (worker sources `c80c2792`, `dd156457`, `dacca86b`, `738f2c27`).
Independent core source reviews approved the explicit delegation and schema12→13
migration. Original candidate vault remains untouched.

Verified after composition: Store handoff8, Store library105 +1ignored, native
family namespace13, document-cache integration22, CLI commands13, desktop-host
library35, frontend planning10 and existing durable-draft/witness guards16; all
passed. Initial filename-based Store filters selected zero tests and are not
credited; compiled test discovery identified `namespace::family::successor::tests`
and all eight then ran. Host/CLI native build and desktop frontend/TypeScript build
passed. These are focused checks, not full Rust or large-file performance acceptance.

Desktop conflict fix `687d44f0` (worker `627dd8e4`) preserves definite planWrite
errors across contextBridge and marks only verified inert planning conflicts.
Independent source review approved; actual concurrency rerun remains mandatory.
Browser preflight normalization is a separate UI-owner follow-up, currently under
review/implementation; no browser runtime parity claimed. Platform auditor owns
actual hidden lifecycle/concurrency runs after the artifact freeze; no other app
or heavy Rust build may overlap that slot. No real-vault recovery is run.

S1 direction is settled in main `776a8fd2`: all-platform beneficial multicore,
cached parsing through shared interfaces, core-owned index/semantic-parse lifecycle
and clients subscribing to updates. Reviewed preparatory runtime and baseline docs
are integrated as `f20905e6`/`2c05902d`/`2f633393`; S0/S0A gates still precede live
S1 replacement. Root retains sole main integration, no push.

### Latest integration checkpoint — 2026-10-18

Main `0bbeb61b` now integrates the independently reviewed superseded namespace-move
recovery, definite planning-conflict handling (desktop and browser), next-turn
desktop quit and CLI competition/interruption harness. Production source is
identical to frozen runtime `24a728e3`; reconciliation changed docs/tests only.
Store schema13 explicitly journals successor responsibility without rewriting
predecessor evidence. Unknown/competing bytes or replaced parents remain preserved.

Recorded focused results: Store105 passed/1 ignored, namespace native13, cache22,
CLI13 and host35; browser planning/retained-draft44; reconciled shell/editor-core8.
Actual macOS lifecycle/history42 passed at
`/private/tmp/zorid-s0-quit-fixed-evidence/evidence.json`: dirty native close,
no-window and live-window AppKit quit, exact reopen and history preview/restore.
All four apps exited0 without cleanup signals. Actual independent CLI competition,
exact receipt replay/stale-CAS rejection, retained conflict, targeted host SIGKILL,
restart and recovery-copy gates passed at
`/private/tmp/zorid-s0-concurrency-final-evidence/evidence.json` (six checks).
Hashes remained frozen and owned processes were closed. This does not establish
power-loss, traffic-light input, browser UI, phone or other-OS runtime parity.
Original user vault remains untouched and its historical warning cause unconfirmed;
the reproduced superseded-move failure is fixed with focused exact-proof checks.

S0's bounded native delivery gate is accepted on the above integrated evidence;
the original historical-vault diagnosis remains explicitly unconfirmed. S0A is
accepted as a contract gate after independent operation/consumer-matrix review
(`4c51e5d5`), browser planning provenance checks, and the reviewed direct binary
helper FIFO correction integrated `d102dbe2`. Main focused transfer/admission50,
planning15 and TypeScript checks pass. Browser contract wording is reconciled.
The audited future runtime/cache/executor/notification seams belong to S1, while
feature binding reach remains in S3–S7/S10/S11/S12; they are not current APIs.

S1 is now implementing S1.0 only. Main `66c65aa2` freezes the language matrix and
19 search cases with separate current-literal/target expectations; real Rust
Generation/LiteralPageBuilder passes those cases at page sizes1/100, and main
Node comparison21 passes. No production query behavior changed. Reviewed native
workload tooling is integrated through main `36fbc997`; main `d02cf0d6` adds the
independently reviewed actual-browser harness. Main tooling7 checks pass. The
CLI tool separately labels legacy versus normal desktop local-family admission,
validates exact query source watermarks and fences executable hashes at run
boundaries. Actual100-note legacy CLI smoke used
the frozen verified binary,18 commands exit 0, exact expected text hits/ranges and
five authority samples, all103 physical files unchanged. Evidence:
`/private/tmp/zorid-s1-cli-smoke-c91106b2/report.json`. Existing inline imported PNG
is classified Unreadable, so coverageComplete=false is retained despite full text
scan completion.

Actual browser100-note smoke passes all five phases at frozen `5aa0f9da`:
`/private/tmp/zorid-s1-web-100-5aa0f9da-evidence/report.json`. Chrome155.0.8059.80,
real product Worker/Rust/WASM/IndexedDB; all103 files imported/read back exactly,
eight full paginated literal oracles with revision/range checks pass cold/warm,
and the independent-edit marker passes on catch-up. Warm process reopen retained
the exact current snapshot with zero pumps; catch-up advanced source107→108 and
reused102/103 records across four pumps. Five client/pin/stage releases acknowledged;
all owned Chrome children exited0 and the server port is closed. Exact source/
artifact proof remained unchanged. No Runtime.exceptionThrown; only favicon404
and Vite connection logs. This is a source-driven fixture, not normal editor UI,
Safari/other-engine, eviction, peak-memory or browser-multicore acceptance.

Native local-family100 setup initially exposed a tool guard that watched only
finished inventory counters while content imports continued. That run is retained
as incomplete setup, not a product/index performance failure. Reviewed fixes are
integrated through `f3867a92`: public live-file tuple growth, final-map continuity
and count/hash summaries bound evidence memory; main tooling9 checks pass. A fresh
normal desktop local-family rerun passed at `b5527cc6`:
`/private/tmp/zorid-s1-cli-family-smoke-b5527cc6/report.json`. All63 commands exited0;
eight full text oracles/source-watermark checks pass with complete coverage,
all103 physical sources and five authority reads match, executable hashes stay
stable. The PNG is Binary in this normal path; legacy classification remains a
separate limitation. These are development-build correctness results.

Optimized native build at main `a200ef44` passed with exact unchanged Rust/Cargo/
proto inputs, HomebrewRust/Cargo1.99.0, jobs1/offline, and a monitored1GiB free-disk
floor never crossed. Evidence `/private/tmp/zorid-s1-release-a200ef44/build.json`.
Release CLI SHA `d927dd299b59290b4b6bcdb9c7ed4b4802d51ff31c502fea8e5aa46b851f7988`;
host SHA `28379b3f6fc9d52127d655d4ee2bfc46b0341327da7092a69c009030b25f9bcc`.
Release100-note local-family smoke passed all eight full oracles, exact warm/source
witnesses and preservation checks, all commands exit 0:
`/private/tmp/zorid-s1-cli-family-release-80dfce28-100/report.json`. Cold index941ms,
queries89–97ms including process startup; setup is separately recorded. One small
sample and a compiler-profile change are not an algorithm speedup or10k acceptance.

Pure-core baseline source `3f41fe08` was independently reviewed, release-compiled
and passed actual100-note full external oracles before integration `066c67e7` /
`6b7c1c4c`. Evidence `/private/tmp/zorid-s1-core-release100-3f41fe08/core-report.json`.
Main tool checks: native10, core protocol12 plus three synthetic process/report
lifecycle cases (the latter are explicitly not Rust execution). The first10k
pure-core observation passed all eight complete external oracles (20,554 hits,
2,504 pages,10,003 records), exact source preservation and complete declared
coverage: `/private/tmp/zorid-s1-core-release10000-3f41fe08/core-report.json`.
One sequential release sample observed setup1.649s (source reads1.528s), composite
extraction445ms, binding100ms, insertion123ms, literals78–225ms. Each literal still
scanned the full corpus; this isolates engine work and excludes client/SQLite/
source-admission costs. It is not a repeated distribution, speedup, Base-query or
normal-client10k pass. Normal Electron harness `3d528d03` is source reviewed but
still isolated pending actual runtime. No complete S1.0 acceptance or engine
optimization gain is claimed by these tools/smokes.

The first10k legacy release CLI attempt stopped as designed after its explicit
240s untimed setup budget (rescan240.316s,2,378 entries). Init/rescan exited0; the
harness exited2 for incomplete setup. No index/query phase ran. All10,003 physical
sources and binary hashes remained exact; exact owned PIDs are gone. Evidence:
`/private/tmp/zorid-s1-cli-legacy-release-80dfce28-10000/report.json`. A single1s
setup-only sample found `record_external_transaction` fetching/decoding all
retained observations before checking the requested path/unresolved state. This
is not a whole-run percentage or an indexing profile.

Measured S1.0 setup dependency: `storage_sqlite_impl` owns isolated
`storage-observation-lookup` / `tingkai-c/storage-observation-lookup`, base
`378afb3f`, source-approved `9d2d3704`. Scope is an indexed exact-path unresolved
candidate lookup, streaming typed comparisons, retained proofs/history/capture
replay and unchanged write admission; no new per-path quota. Additive authority
schema14 strictly migrates both known12 and13, with unknown/partial/malformed
legacy schema rejection before WAL. Owned files: Store projection/lib and three
existing successor-test fixture/version adjustments. Independent core review
approved source; Rust checks and comparable actual runtime remain required before
integration. No live authority/vault was changed by this isolated work.

Normal Electron100 first run passed automatic import/all-source readback and cold
unique search, then stopped on a harness title-before-editor-body readiness race
before any keyboard edit. Evidence
`/private/tmp/zorid-s1-desktop-100-378afb3f-evidence/report.json`. All owned apps/
hosts are closed. Source-only successors `86d7ed4d` / `82d5e76f` wait for the actual
focused body and use passive DOM search observations with one post-visible status
probe (exact publication time remains unavailable). Original save/source assertions
stay intact; the corrected normal-app pass is still required.

Corrected Electron retry at frozen `ca84ca45` passed automatic import/all-source
readback and cold unique search (one observed1.360s visible result; post-visible
status probe3.24ms), then failed the harness's exact-save assertion. Live Edit's
properties filter protects YAML from body selection: selecting all and inserting
the entire original file duplicated YAML inside the body. This is a demonstrated
harness replacement-scope error, not an established product save regression.
Evidence `/private/tmp/zorid-s1-desktop-100-ca84ca45-evidence/report.json` and
`post-run-provenance.json`; source/dist/native hashes remained exact, no renderer
exceptions, and all exact owned app/host PIDs are gone. Platform owner is preparing
ordinary end-of-document navigation plus suffix-only insertion; exact source,
checkpoint, index and warm-restart assertions remain required. No save/warm pass
is claimed. Root released the frozen-main hold after terminal cleanup.

The serialized resource slot now belongs to `storage_sqlite_impl` for the scoped
old-function red / exact-approved-source green checks of `9d2d3704`, using the
existing1.99 `target/stage4-verified` cache, jobs1/test-threads1 and1GiB disk floor.
Release candidate build and comparable10k runtime have not started. Independently
source-approved Base semantic-baseline tooling `18722402` remains isolated in
`s1-bases-baseline` / `tingkai-c/s1-bases-baseline`: seventeen pinned existing
corpus cases, explicitly partial declared-field oracles; Node validation/lifecycle
checks pass, actual Rust compile/execution is queued after Store checks. It adds
no language/cache behavior or representative Base-performance acceptance.

Scoped Store validation is now terminal green, candidate final
`51060b1ddc52d8a6ca6741447a5d268174d8529a` (production unchanged from reviewed
`9d2d3704`). Evidence `/private/tmp/zorid-observation-9d2d3704-validation-aw4ubom9`:
old-function regression failed on unrelated retained payload decoding, then exact
approved source was restored; Store unit109 pass/1 ignored, unchanged-production
boundaries53 pass, native successor13 plus cache/source/history1 pass. Test-only
successors `b951cca6`, `2b9156c8`, `51060b1d` repair stale typed-content fixtures
and schema1 success/error expectations to the already-existing rejection policy;
independent core review approved each. Affected projection6 and transactions11
pass on final source. This is a composed scoped result, not a rerun of every suite
on the final SHA. All owned check processes exited. Base17 release compile/runtime
now owns the serialized slot; native candidate CLI/host build and family100 plus
same-caps legacy10k follow before integration. Corrected Electron suffix-only
harness `f8bafbac` is source approved; its next pass will use matching integrated
candidate native binaries to verify the actual final app rather than repeat an
extra old-native save pass. No native setup speedup or full S1 gate is claimed yet.

Base semantic-baseline `18722402` passed its actual release build and seventeen
declared corpus assertions (ten detached, seven generation queries;32 returned
rows). Evidence `/private/tmp/zorid-s1-bases-release17-18722402/bases-report.json`
and build provenance; exact corpus and executable hashes stayed stable and all
owned children exited. It is integrated through main `da536a82`; main Node checks
pin17 cases and reject14 adversarial protocol cases, with integrated tooling bytes
identical to reviewed source. These small fixtures are not representative Base
performance or independent full-result oracles. The serialized slot now belongs
to `s1_execution_audit` for frozen `51060b1d` native CLI/host release build, normal
family100 and same-caps legacy10k; baseline binaries are preserved before rebuild.

The representative generated-Base tool is separately assigned to `s1_query_audit`
(new example/wrapper/oracle/docs only). It preserves workloadv1 and normal limits,
with independent arithmetic expectations for sparse/filter/formula/group/link/
current-entry/view/time cases. A read-only audit predicts the eager full-graph
preparation will exceed normal query work at10k, even for property-only filters;
this is not yet a runtime observation. Keep links and budgets intact and report
any actual rejection as limited/incomplete. Dependency-aware preparation, indexed
resolution and bounded reuse belong to accepted S1.2, not this baseline tool.

First measured setup fix is integrated through main `2c53a98d` (production
`239e639e`, reviewed `9d2d3704` plus test-only successors). Exact frozen candidate
`51060b1d` release build passed; CLI SHA
`eaecfb89c69c2b24c22c998a67582564b9a402172a2eceb60b8c7d8e41238821`, host SHA
`26bbd6bbd7ad8bad90a60c6abb8a1f70f4e203d02caf6d369213f32cbcf5a143`.
Normal-family100 passes all eight full query/source oracles, complete coverage,
all103 physical sources and five authority reads,23 normal exit 0 commands:
`/private/tmp/zorid-s1-cli-family-release-51060b1d-100/report.json`.
Same-cap legacy10k is terminal incomplete, rescan240.256s/3,383 observed entries,
normal command exits, no index/query phase; all10,003 physical sources and binary
hashes exact. Evidence `/private/tmp/zorid-s1-cli-legacy-release-51060b1d-10000/report.json`.
This is partial progress versus2,378/240.316s, not a completion-speedup or10k index
result. All owned build/runtime PIDs are gone. Prior release binaries remain
verified immutable copies under `/private/tmp/zorid-s1-baseline-native-release-a200ef44`.

The single authorized setup sample at96s now points to repeated full-store
list/find operations for individual paths. Follow-up owner `storage_sqlite_impl`
has four native selector replacements in preparation, using existing
`Store::read_path_metadata`, no schema/API/cache addition. Independent core review
is assigned; old full recovery/absence inventories and typed/physical checks must
remain intact. No follow-up build/runtime is credited yet. Corrected Electron100
on matching integrated source/native is next in the serialized slot.

Electron100 at frozen `1d3add34` again passes automatic import/all-source readback
and cold search, but exact save verification fails on one newline before the
marker after multiline CDP input. YAML/body are otherwise preserved; source input
mapping versus product behavior is still unclassified. Evidence
`/private/tmp/zorid-s1-desktop-100-1d3add34-evidence/report.json` and post-run proof:
all frozen hashes exact, no renderer exceptions, all owned PIDs gone. Failure
cleanup required SIGKILL for the second app, so no graceful-save/restart claim.
Do not adapt the expected bytes to the result. Platform owner is preparing a
bounded one-note input diagnosis (events/caret/source before/after, multiline
injection versus ordinary Enter/typing); no product edit is approved by this
finding alone. Main/dist hold is released after terminal cleanup.

The follow-up native four-selector candidate `d0de1c83` is independently source
approved in `native-import-lookup` / `tingkai-c/native-import-lookup`, base
`51060b1d`; no Store/API/schema/cache changes. Five scoped native regression
groups are prepared. `storage_sqlite_impl` now owns the serialized old-red/green
slot; builds and runtime remain separate gates. Generated-Base tooling `ffaee3ad`
is independently source approved, Node10 checks pass, Rust100/10k not yet run.
Optional native resource-helper tooling through `21b81827` is source approved in
`s1-process-resources`; default process paths stay unchanged, actual child/time
tests and measured smokes remain queued. These source-only tools establish no
resource measurements or performance acceptance.

One-note input diagnosis at frozen `8060f275` resolves the save mismatch:
`/private/tmp/zorid-s1-input-multiline-8060f275-evidence/report.json` shows EOF caret
and original renderer/source exact, but multiline CDP insertion loses one LF in
the actual CodeMirror document before persistence. Ordinary Enter, single-line
marker insertion, Enter preserves the unchanged expected source in renderer,
physical file, native readback and checkpoint draft/base:
`/private/tmp/zorid-s1-input-enter-8060f275-evidence/report.json`. Four apps across
both diagnoses exited0 through normal AppKit quit without signals; all eight
owned app/host PIDs are gone, no renderer exceptions, frozen hashes unchanged.
This diagnoses simulated multiline input, not Rust save loss or OS clipboard
parity. Source-approved harness `c58c1383` uses the proven ordinary input sequence
and retains all original full-source/save/index/warm gates; full100 remains queued.

Follow-up native `d0de1c83` now passes35 focused checks, no ignored cases. Two
old-selector tests fail on unrelated typed corruption, followed by exact tracked
source restoration; all before/after tracked hashes match and21 Cargo PIDs are
gone. Evidence `/private/tmp/zorid-native-lookup-d0de1c83-validation-yjo6psd_/validation-summary.json`.
This reuses prior unchanged Store proof rather than rerunning it. The serialized
slot now belongs to `s1_execution_audit` for exactd0 release build, family100 and
same-caps legacy10k. Prior51060 CLI/host bytes are preserved separately under
`/private/tmp/zorid-s1-baseline-native-release-51060b1d`. No second-fix performance
result or complete normal-app save/restart acceptance is claimed yet.

Owners: `s1_execution_audit` owns workload/native CLI baseline tooling;
`s1_query_audit` owns the integrated language fixtures;
`architecture_platform_audit` owns actual browser/normal Electron measurement
harnesses (browser100 passed; Electron source preparation underway);
`storage_recovery_impl` independently reviews workload/oracle/resource handling.
Root retains sole main integration. Heavy work stays serialized; no push. Open
sync-group policies await the user; no new design discussion is started.

Latest user steering: current runtime verification targets are macOS Electron,
web and the independent CLI on macOS; defer other OS/mobile runtime verification.
CLI must be tested both independently and alongside Electron, not treated only as
a harness. Preserve all-platform architecture without claiming untested parity.
Sync is E2EE. Roadmap S1A now reserves a later discussion/design gate for sync-group
creation/membership, joining and leaving/rejoining before S2 enrollment work.
Group/key/data/pending-edit policies remain open; this is not a request to start
that implementation or a one-day completion expectation.

Earlier main `eb6d6bb21e3e277745990eaa1b5d6645bda53eac` integrates the reviewed cache/history
batch. Application source (`src`, `desktop`, `crates`) was verified identical to
reconciled integration `bf1feb0a`; reconciliation with main changed documentation
only. The matching frontend build passed on main. Earlier clipboard delivery is
`a98cb04f`; browser contract is `1b4bb432`. No push by this coordinator.
The entries below retain the earlier open-gate history; namespace recovery,
no-window quit and CLI/interruption checks are superseded by the verified batch
above. Component checkboxes alone never establish milestone acceptance.

### S0 continuation ownership

First batch integrated as main `b9f29cc93f12233608036632266661fd0b51c5e2`;
main tree was checked identical to reviewed integration `af7ce394`. No push.
Root reuses `storage-foundation` on `tingkai-c/storage-cache-integration` from main.
`storage_sqlite_impl` owns `storage-cache` independent cache connection + Store/
native cache facade + host/CLI enable seam. Root owns snapshot maintenance batching
(`local_recovery.rs`, native queue field, host snapshot helper), Cargo.lock and
serialized checks/integration. `architecture_platform_audit` owns only the actual
Electron dirty-close/normal-quit harness successor. These continuations are not yet
accepted by the first batch's runtime evidence. Existing worker review/correctness
requirements and sole main ownership remain in force.

Additional continuation owners: `storage_recovery_impl` reuses `storage-recovery`
on `tingkai-c/storage-recovery-history` for entry-scoped native history reads and
host frames (`8ac6235b`). `storage_recovery_ui_impl` reuses `storage-recovery-ui`
on `tingkai-c/storage-history-ui` for optional desktop history preview and ordinary
NoteBuffer restoration. Root integrates both only after focused checks and review;
they do not add arbitrary SQL/path access or a separate force-write path. Browser/
mobile hide the optional desktop action. UI must reject dirty/conflicted/stale
restoration and keep technical diagnostics out of presentation.

### S0 second batch — source reviewed, runtime gates pending

Root integration `storage-foundation` / `tingkai-c/storage-cache-integration`
continues from main `b9f29cc9`. Independent disposable document cache extraction
(`a5ccf3fd`) keeps source authority in `.zorid/vault.sqlite`; desktop/CLI explicitly
opt into app-local `cache.sqlite`, while bare Store remains memory backed. Optional
cache startup failure keeps an in-memory fallback. Cache lock ordering is
cache→authority and cache read snapshots are pinned before authority snapshots;
publication still validates source witnesses. Unknown schemas/scopes are rejected
before WAL. Native history reads (`6e4cda2b`) are entry scoped; desktop history
(`b071f25a`, palette `7195a8ff`) restores through ordinary NoteBuffer saves with
stale/dirty/conflict guards. Snapshot maintenance is bounded to sixteen notes per
interactive batch (`5841afc2`); the metadata inventory remains once per cycle and
this is not a measured latency bound.

Scoped checks passed: Store library 97 (+1 ignored), document-index integration22,
native document index7, CLI commands13 + documents3, host document consumer1,
local recovery/cache-boundary7, host history2, history UI/IPC145, and TypeScript /
desktop frontend build. These are focused suites, not the complete Rust suite.
Independent core source review approved cache lock/snapshot ordering and history
service boundaries; platform review approved history transport/restoration.

New user clipboard report is a blocking S0 save/attachment finding. Actual hidden
Electron reproduction at `c47d9717` caught `binary_busy` in
AttachmentResources→Vault.readBinary→desktop openRead. Both PNG payloads and note
embeds committed; image reads collided. Red evidence:
`/private/tmp/zorid-clipboard-diagnostic-attempt3/evidence.json`.
`storage_sqlite_impl` implemented complete-transfer scheduling in isolated
`storage-cache` / `tingkai-c/binary-transfer-scheduling` (`fd87d9f0`, root cherry-pick
`36d0a0a9`); core independent review approved exact source. Two real desktop
consumer tests failed before the fix; worker TypeScript +100 focused checks and
root28 integration checks passed afterward. Original identity/revision selection,
caller-input capture, cancellation, cleanup and text responsiveness are preserved.
Actual clipboard runtime passed on composed source `bbf121ea`:
`/private/tmp/zorid-clipboard-final-verified/evidence.json`; both exact pasted PNG
files/embeds, unchanged seed bytes and all four decoded target pixel hashes matched
with no transfer errors. Hidden eager/decode fixture intervention does not establish
OS clipboard/foreground lazy-loading parity. Final source-reviewed harness commits
`a34fecfa`/`a0f77881` use CSP-safe pixel hashes and record transient missing-file
observations without relaxing final exact-file checks. Clipboard fix was integrated
independently into main `a98cb04f` with 28 focused tests and desktop build passing on
that base; no push. Main findings record `81c2d47b` preserves delivery status.

The broader S0 pass stopped at dirty renderer `window.close()`: dirty witness and
unchanged disk, close27ms later, window/host still alive15s later, exact edits then
autosaved. Evidence `/private/tmp/zorid-s0-final-bbf121ea-evidence/evidence.json`.
This is not an OS-close/app-quit or data-loss finding. Diagnose whether Chromium
beforeunload vetoes this test action before the native close handshake; verify the
native close path and normal AppKit quit before accepting those gates. Version
history runtime was not reached. Prior clipboard polling also observed temporary
source-path ENOENT during saving, then exact final content; continuous filesystem
visibility remains unverified. S0 is not accepted.

`architecture_platform_audit` owns hidden clipboard and save/dirty-close/quit/
history runtime harnesses; `storage_recovery_ui_impl` independently reviews the
clipboard assertions/owned cleanup. User-owned visible Playground PID66932 is
excluded from all automation, artifact replacement and cleanup. Root retains sole
main integration; no push is authorized. S0 remains implementing until runtime
and remaining exit scenarios are recorded. S0A/S1/features/iOS stay deferred.

### S0 runtime continuation — 2026-10-18

At frozen source `3eabc392`, native API window close flushed dirty bytes after a
47ms pre-debounce request, produced guarded→allowed→closed events and drained its
host. The separate live-window normal AppKit quit/history run passed 22 checks:
`/private/tmp/zorid-s0-live-appkit-evidence/evidence.json`. Exact dirty bytes reopened,
all apps exited normally without signals, real command-palette history preview
left source unchanged, explicit Restore saved exact historical bytes and survived
quit/restart. Hidden CDP + native API close does not establish OS traffic-light
input; actual live-window AppKit quit is separately observed. All owned automation
processes are closed. User confirms their manual Playground is now closed too.

No-window AppKit quit remains a separate open gap; the Mac shell stayed running
15s after its window/host had closed. Renderer JS `window.close()` dirty veto is
not a failure of the subsequently proven native close handshake. Runtime harness
source `63cff35c`/`98bcc6e8` independently reviewed and integrated into this branch.

Read-only recent-vault candidate found a captured namespace move superseded by a
later logical move. Original vault untouched; metadata evidence remains in
`/private/tmp/zorid-warning-candidate-mp5yzuln/metadata-summary.json`; not confirmed
as the original screenshot cause. `storage_recovery_impl` owns native synthetic
repro `dacca86b` and native OS proof; `storage_sqlite_impl` owns a newly assigned
Store transactional responsibility-handoff contract/schema/API; core reviewer
requires immutable predecessor evidence, explicit delegation, exact causal/claim/
baseline CAS and restart-safe retained/destination proof. Native-only retarget is
rejected. No implementation before concrete contract review; no Rust check runs
until root grants the serialized slot. Separate concurrency/interruption harness
`e1f65a35` awaits independent review and coordinated runtime. S0 stays implementing;
S0A/S1/features/mobile do not advance. Root retains sole main integration; no push.

### S0 first verified batch

Frozen source `736eddcd1a59f4c7a79402d0aee6c66e3787bf2a`: checked native SQLite,
app-local retained history, desktop/CLI path resolution, settled `.previous`
retirement, automatic discovery→recovery and ordinary-language note storage UI.
Scoped source reviews approved; capture ABA/schema validation/enrolled-save gaps
were corrected before delivery. Worker UI ownership additionally covers narrow
Workspace note save/load/recovery presentation (editor polish remains paused).

Focused final checks: native local-history 4, core save/crash/identity 59,
SQLite/recovery 18, Store-open policy 2, host library 33, host subprocess 14,
CLI commands 13, historical-parent regression 1; all passed. Frontend build/TS
and 84 UI tests passed. These are scoped results, not the full Rust suite.
The old CLI late-open-handle test now checks the documented finite-retirement
contract; a stale historical-parent test now reads immutable payload storage.

Actual Electron evidence: `/private/tmp/zorid-s0-electron-evidence/evidence.json`
(22 checks, screenshots and frozen hashes): normal create, five keyboard autosaves,
exact disk/bridge bytes, normal window-close host drain, restart/reopen, no settled
publication artifacts, retained external snapshot bytes and quiet UI passed.
Owned app/host processes closed. Mac no-window Electron shells needed forced
cleanup after their hosts drained; graceful app quit is not established.

Broader large-stream checks are explicitly incomplete: stdio stream hit its
existing 60-second watchdog; native compound-stream run was stopped after >8 min.
Sampling points to repeated immutable payload decoding/validation; see findings.
No stress/performance pass, mobile/browser parity or original user-vault diagnosis
is claimed. No real vault artifacts were swept.

Next S0 slice: `storage_sqlite_impl` owns isolated `storage-cache` extraction of
rebuildable document caches, preserving source fences with independent SQLite
connections. The subsequent source review corrected the lock order to cache→authority: never hold an authority reservation while waiting for a disposable cache lock. Root retains sole main integration
and Cargo.lock/build coordination. Cache extraction/history interfaces and broader
S0 exit checks remain open; S0A/S1/features/iOS do not advance from this batch.


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


## Latest sequencing and architecture correction — 2026-10-18

**Browser role correction:** browser joins existing sync groups; it is not expected
to own a persistent local vault like desktop/mobile. This supersedes the mandatory
browser SQLite/OPFS direction. Local working state/cache is allowed; persistence,
offline/reload and pending-edit policy remain to be designed. Current standalone
IndexedDB code is unchanged by this documentation correction. Native SQLite and
app-local per-vault cache/recovery placement remain accepted.


User now prioritizes saving/recovery correctness and Rust indexing/search/cache
performance, then complete desktop Bases, Tasks, Calendar and Google integration,
then iOS implementation. Preserve existing native work; older parallel mobile
execution notes below do not override this order. No storage/backend migration or
performance improvement is established by the documentation update.

The maintained [architecture manual](architecture/README.md) records the platform
paths and Rust systems. Accepted SQLite/cache/recovery placement and implementation
gates are in [decisions](architecture/decisions.md). Keep execution ownership and
verification here rather than growing the architecture pages into another diary.

## Historical execution checkpoint — shared-core coordinator

Updated 2026-10-17. Read this section before resuming after a context reset;
earlier discussion restrictions below are historical where superseded here.

Direct user confirmation on 2026-10-16 sets the product priority to the best
Zorid UX, with Obsidian as a starting point rather than an exact parity target.
Older reference/parity ledgers remain evidence and capability inventories, not
requirements to reproduce every interaction or visual detail. This does not
relax correctness, data integrity, accessibility or native verification gates.

Latest development priority: the user confirms there are no app users yet and
asks to speed development. Treat unreleased schemas/protocols as replaceable;
prefer fresh disposable fixtures to migration machinery serving only earlier
development artifacts. Avoid production rollout compatibility layers now. Keep
explicit format rejection, required protocol-version checks and meaningful
data-loss/convergence/crash tests. Do not delete or migrate real user vaults.
Existing full milestone requirements remain intact; this changes sequencing and
implementation complexity, not the evidence needed to claim completion.

The user requested durable written decisions, execution tracking and a Codex
built-in goal. The first integrated Rust core + web + Electron + standalone
full-vault CLI + E2EE server-sync milestone has passed its implementation and
runtime gates; see [final acceptance](history/shared-core-milestone-acceptance.md).
The built-in goal is being closed against that requirement audit. Subsequent P2P,
full history/backups/admin and native mobile milestones remain required in the
sequence below; completion of the first goal must not close those requirements.

### Device joining — proposed UX and implementation slot (2026-10-17)

User explicitly requests planning new-device joining, suggesting a settings QR
code or copyable key/code, and asks whether implementation should follow later.
Recommendation: settle the bounded flow now; implement immediately after default
Rust local startup, external reconciliation and retained-draft recovery gates.
Do not interrupt that active integration or imply enrollment UI already exists.

- Existing device Settings > Sync > Add device displays a short-lived one-use
  invitation as QR plus a copyable invitation code/link; both enter the same flow.
  New device registers its own identity/credential, chooses vault/destination and
  obtains authorization plus encrypted vault-key access. Trusted-device approval
  and supported recovery-key unlock are candidate key-access paths, not final
  cryptographic/API designs. Use reviewed established primitives/protocols; never
  expose raw reusable vault keys or long-lived device tokens in the QR/code.
- Treat account authorization, key access and initial file reconciliation as
  distinct gates. Hosted and self-hosted use the same vault protocol, with explicit
  server identity. Device-local derived data and local secrets are not implicitly
  imported/synced. Recovery key is distinct from a temporary invitation code.
- Empty destination: download a complete bounded remote snapshot/history, verify
  dependencies, then materialize; local absence does not authorize remote delete.
  Persist progress and resume interrupted setup. Do not start ordinary scanning
  against an incompletely bootstrapped database.
- Existing local files: capture a recoverable local snapshot first, stage remote
  state separately, then reconcile identities. Existing same-vault causal history
  permits normal merges. Path+identical bytes can be reconciled as a duplicate
  under an explicit identity-import plan; local-only files remain. Without shared
  ancestry, differing same-path content must retain both versions; do not infer a
  safe CRDT merge or choose destructive mtime winners. Existing independently
  enrolled local vault scopes require an explicit import/rebind plan, never silent
  logical-scope replacement. Show one setup summary; avoid per-file prompt storms.
- Acceptance before enabling join: empty and populated destinations, interrupted
  fetch/restart, wrong/expired/replayed invitation, wrong server/vault/key, absent
  dependencies, offline device/tombstones, initial upload failure and revocation;
  all preserve local work and prevent accidental remote replacement. Test the
  selected implementation with actual web/desktop/independent CLI clients.

Reference checked 2026-10-17: LiveSync quick_setup.md + tips/fast-setup.md on main
separates first-device initialization from subsequent-device Fetch. Setup URI
carries encrypted settings/credentials. Fast Setup offers newer-wins or remote-
wins plus separate handling of extra/deleted files. It suspends reflection during
fetch and retains progress/selected policy after failure. Adopt resumable staged
setup and explicit direction; do not copy mtime winner policy as our default.
Sources: https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/quick_setup.md
and https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tips/fast-setup.md .
This discussion records recommendations; no public enrollment API is frozen.

### Resume procedure and status rules

Store/browser task delivery checkpoint (2026-10-18 13:59 UTC): root combined
candidate `a2634d61` is accepted for canonical integration after independent
source and exact-runtime review. Store source6078 matches exactly, original18
SQLite checks are verified and affected existing managed_records target24/24
passes. Browser query Rust10/10, current generated WASM build, combined fullTS
and five actual normal adapter/admission/Worker/WASM/IDB groups pass. Both initial
test/harness failures are retained and narrowly corrected. Integration installs
exact tested generated assets, preserving functional browser defaults. See
managed-data/store-browser-composition-checkpoint.md and browser-task-current-evidence.json.
No Tasks UI/mobile/provider/cutover completion is inferred from these bounded gates.

Type module/host and desktop draft binding work survives the interruption in
isolated worktrees. Former internal workers are no longer live; root reassigned
them explicitly to type_configuration_recovery and type_draft_binding_recovery.
The Type IME multi-control finding still requires exact successor review before
integration. Core pure draft validation source is frozen943c/a93/c70, actual Rust
and host runtime gates pending. No new iOS build is claimed; external native
owner continues retained physical root fixes and same-client typed transport.


Mobile bridge checkpoint (2026-10-18 05:26 UTC): root composition `7f97d7f1`
exactly matches approved finalf42b5dcb across five source/test files. The retained
9/9 focused log and root combined fullTS exit 0 are recorded in
mobile-web-routing-bridge-integration.md. Bounded command admission and original-
only receipt semantics are accepted. Workspace activation and paired actual
native behavior remain open; no new iOS build or physical result is claimed.


Recovery helper checkpoint (2026-10-18 05:23 UTC): root composition `9acab0ad`
exactly matches independently approved6c80a893+bcc02aa0. Retained9/9 focused
checks cover completed inventory owner/client/vault retirement with no extra
body reads. It is a bounded read-only metadata/passive-preview helper, not a
Workspace recovery activation. See mobile-note-recovery-integration.md.
TS371 is actively implementing the paired Workspace consumer; native lead owns
physical retained-host/Pages/PBX composition. Changed command-ID payloads must
be admission-dropped without emitting a stale receipt that could settle the
original native request; only exact duplicates coalesce. No wire change needed.


Browser delivery checkpoint (2026-10-18 05:20 UTC): canonical `2972911c`
integrates the root browser candidate `46e7360e`, which combines the reviewed33-file browser WorkBlocks implementation
with canonical `2120024d`. Its actual current-input WASM build and full TypeScript
check both exit 0. Fresh Chrome/IndexedDB/WASM run passes12 selected groups with
443 strict transactions,43 atomicity snapshots and10 causal ordering pairs;
Chrome/Vite/profile and12 databases clean up, then runner72675 naturally exits0.
Independent exact-artifact review approves this bounded source/runtime composition;
main now has the exact tested generated assets. See
managed-data/browser-workblocks-main-integration.md and its compact evidence JSON.
No rendered Calendar/mobile/gRPC/full-matrix result follows from this subset.

Canonical follow-ups supersede older pending checkpoints below: portable router
is integrated at `9e4a755f` after20 component checks and independent lifecycle
review; native Calendar query foundation at `aab1d5c8` retains explicitly split
native/stdio results; passive actual CodeMirror host at `2120024d` passes7 component
cases. These are source/component foundations, not activated retained WebKit
navigation. TS371 owns optional bridge/recovery/Workspace composition; bridge
changed-payload reuse and recovery helper scope fixes are accepted separately
above; consuming Workspace integration remains open.
Managed lead owns the next reviewed Electron Calendar retry, root starts no heavy
job concurrently. The original UI attempts failed driver selectors; no full
Calendar GUI case is accepted from those attempts. Dev19 remains the phone build.


Recovery host checkpoint (2026-10-18 05:01 UTC): canonical `c128785f` integrates
exact independently reviewed e3e29142 desktop main/preload/client-slot foundation.
Root32/32 affected Node checks, three CJS syntax checks and exact source comparison
pass. It reclaims only the original authenticated same-vault window/client scope;
no Workspace caller or journal rewrite/resume is added. Actual original-window
renderer journal proof stays with composed Calendar acceptance. See
managed-data/calendar-recovery-host-integration.md. Root native Calendar candidate
`8857efcd` remains isolated pending its final large-vault fixture and composed
result review; no duplicate Rust compilation was run by root.

Portable router checkpoint (2026-10-18 04:57 UTC): TS371 freeze af3b6538 has
16 component checks/fullTS0 but independent review WITHHOLDS source approval:
async resume outside the route queue can overwrite a newer selected document and
restore the wrong writer. Owner has the held-resume-A/open-B counterexample and
must serialize/fence that lifecycle path. Earlier strict literal decoding and
retryable cleanup findings are fixed. Exact blobs, log hash and consuming state-
before-result publication obligation are in mobile-web-router-source-review.md.
This component is not on main and does not establish actual live editor rendering.

Retained editor checkpoint (2026-10-18 04:55 UTC): canonical `e4d6b297`
integrates independently approved interaction source047d5687. Root isolated
composition exactly matches the entire approved src/tests tree;91 focused cases
and fullTS exit 0 are recorded with commands, source hashes and retained logs in
`docs/verification/mobile-editor-interaction/`. Native/TS owners were notified.
Opt into canMutate/interactionState at construction, including the first active
editor; revoke writer before setter. Per-editor menus abort and validate epoch
before effects; default unmanaged desktop native menus remain unchanged.
This closes the earlier editor source blockers, not the router/live WebKit/IME
or physical mobile gates. See mobile-editor-interaction-integration.md.

Portable core checkpoint (2026-10-18 04:52 UTC): main `8133fd2c` integrates
reviewed WorkBlock service helpers (`6f864a31`/`a4389f5f`) and canonical retained-
intent helpers (`8e06da2c`/`c38ff2e6`). Independent composition review confirms
exact original source, only two lib exports, unchanged domain/admission/dependencies
and no product adapter activation. Original focused S11 result and root-read,
hash-verified portable5+8 logs are retained in
`managed-data/core-intent-foundation-integration.md`. Browser transaction/runtime,
origin capture/issuance/namespace/accounting/settlement and no-old-apply-bypass
cutover remain separate required work. No repeated root compiler campaign ran.
Native Calendar check was explicitly incomplete after4 cases while its expensive
1,001-file fixture was corrected; do not count it as a complete passing suite.

Latest checkpoint (2026-10-18 04:48 UTC): user mobile architecture supersession
relayed in `msg_f2da5c302596`, acknowledged by root. ONE retained initialized
WebView per vault owns logical document tabs, selected document, history, live
editor window and route commit. Native owns physical vault host/session, outer
Files/Recents/settings/chrome and gesture input, without a second document cursor.
New Note and native data actions use the existing web Workspace/Rust adapter and
same client. See [current source plan](mobile-live-editor-window-plan.md).
The native-authoritative `ddbc83a7` candidate is superseded/reference only; its
Simulator20 preflight stopped BEFORE compilation, and its slot was released.
Do not build it as a prerequisite to the new architecture. Dev19 remains installed
and open on the phone; no new physical UI or live-swipe result is claimed.

Named parallel source: TS371 `mobile-web-router` at base `a4ee37ea` owns router,
three-editor window and optional platform/Workspace adapter; native lead owns
retained host/plugin and gesture presentation; editor owner `mobile-editor-interaction`
owns interaction fencing with its existing independent reviewer. Editor successor
`ec8ca471` has69 focused passes but remains unapproved for stale menu-role and
control-event delivery seams. Root granted narrow owned-menu platform guards,
not a general menu rewrite. Native Pages external services have an approved
ownership direction; exact paired service DTOs must agree before shared edits.
No new Rust/NoteBuffer/storage APIs are authorized by these mobile seams.

Calendar backend foundation is canonical at `a4ee37ea`: Store receipt summary
`d9c2b801`, saved-Base-before-task projection `5b71573d`, context validation
`ba6eb9b8`, and corrected bounded test fixture `bf722de1`. Exact reviewed Store
5/5 and projection17/17 execution evidence is recorded in
`managed-data/calendar-foundation-integration.md`. Native join/desktop binding and
rendered composed Calendar remain separate gates. Browser WorkBlocks actual
`3b555af6` passed CRUD/ref/replay/restart and Rust semantic-abort normalization,
then failed a cursor-eviction fixture assumption; full browser gate remains open.
Managed lead owns the single cached native Calendar/desktop-host Rust turn.

The checkpoints below retain historical evidence; the latest supersession above
controls mobile architecture and sequencing.

Native delivery checkpoint (2026-10-18 04:33 UTC): main `3cfff3f7` integrates
reviewed nonwarm native/NewNote source and `24c4ec40` approved JS reattestation,
preserving desktop Tasks. Composed299Node/fullTS0 and exact isolated-tree match.
Simulator19 direct-create chrome/save/Back/loaded-editor reopen passes; Dev19
signed/installed/launched successfully on physical iPhone, intentionally left open.
Root inspected actual artifacts; physical UI and in-flight create recovery remain
unproved. See `native-main-integration-preparation.md` for scope/hashes.
Root isolated `native-warm-main-candidate` at `ddbc83a7` composes the separately
reviewed helper/packets/native consumer atop `8e438ca5`; exact independent
composition approved. It is NOT on main. Next exclusive iOS slot granted to native
after managed bounded Store/projection Rust checks return; compile then actual
positiveACK/rejectedready/source-reattest/lifecycle proof. Two actual adjacent
editor views during interactive swipe remain a required subsequent slice. NewNote
busy-skeleton polish is separately source-owned and excluded from frozen Dev19.

Desktop Tasks delivered (2026-10-18 04:22 UTC): canonical `aa0a2f37` integrates
isolated `7dda4aa1`. All13 production/test files byte-match actual-tested15ff377b;
main enhanced core identity assertions are preserved. Root44/44 affected checks,
fullTS/diffcheck0; actual Electron three groups and independent R acceptance cover
capture/properties/body/save/split, dirty/stale protection, retained close drafts,
restart and interrupted create with no automatic duplicate. Exact raw/provenance
and limitations are in `managed-data/tasks-main-integration.md`; final owner
runtime/review reports are being imported separately. This is ordinary desktop
Tasks, not mobile/browser parity, durable form crash recovery, exact-once capture,
scheduling joins or complete Tasks/Calendar delivery. Next corrected Base Calendar
contract31aafe8f has independent approval73dee4a3; named shared seam table pending.
It includes receipt-only unresolved evidence, current-source fencing and one
bounded continuation owner, without Store schema/index/wire changes.

Coordinator checkpoint (2026-10-18 04:14 UTC): NewNote18 frozen native candidate
9cf7fe9f includes current main c233362a and byte-matches reviewed4e390d70 app/project
source. Native owner holds the acknowledged iOS slot; Xcode25844 was observed
live. Actual FAB/create/edit/save/reopen/interruption remains required. Separate
paired warm-navigation review found source reattestation missing after rollback;
see mobile-finite-navigation-source-results.md. Do not fold that unfinished code
into NewNote18. Tasks corrected-identity actual4cbf now passes normal save/split;
its stale check stopped on transient-alert visibility, not established data loss.
Reviewed successor15ff377b checks retained exact draft/guidance and authoritative
bytes, with the next actual pass serialized after native load.

Next Tasks/Base Calendar contract c2760a2f is accepted for routine first-slice UX:
shared Calendar canvas, linked WorkBlock membership from exact saved Rust Base
selection, all-time inverse membership with honest unknown coverage, and durable
create/link continuation. Managed lead prepares independent source-only review
and named seam table; shared source grant follows that review/current Tasks gate.
This desktop slice does not replace required generic file-date calendars. Browser
joint2834c783 reports generated wasm32/real-WASM Node and77Node/fullTS success;
normal product Worker/strictIDB/encrypted convergence proof remains unrun.

Core repair delivery (2026-10-18 04:08 UTC): main209368fb preserves validated
current.entryId during reconcileDurableWrite publication. Root isolated b0c80ab5
adds direct cache/event identity regression: oldsource9/10 fails, fix10/10 passes;
independent source approval, no guard/replay change. Core-only extraction avoids
unintegrated Tasks-test dependencies. Tasks owner retains real save/split proof.
Next exclusive iOS slot assigned to native owner for source-reviewed priority
NewNote18 after coherent freeze/composition; actual FAB/edit/save/reopen required,
unfinished warm source excluded. Coordinate live browser proof/compiler before
starting, preserve booted Simulator and existing development-phone permission.

Intent/migration assignment (2026-10-18 04:03 UTC): recovered reviewed docs
903ecfe7/86bd56f9 are canonical; origin-intent-decision.md selects reserved
host checkpoint namespace, explicit tagged settlement and32live/16MiB plus
4096 historical-key bounds. Managed coordinator names isolated portable/native/
WASM/browser/admission/transport owners after corresponding current-v1 freezes;
no overlapping source or permissive generic-apply bypass. V2 stays test-only,
no DB/index/wire/dependency change. Actual SQLite/generatedWASM/strictIDB gates
remain required. Finite replay/retirement retention is recorded as future work,
not unlimited product history. Tasks actual split failure includes product
identity error, not just driver readiness; source owner diagnoses projection/ID
admission before another acceptance claim.

Mobile priority (2026-10-18 04:00 UTC): direct user finding relayed by native
owner confirms Dev17 New File FAB inert. Dedicated native-new-note-ui owns only
NewNote-specific root/startup/Pages borrow/recovery/factory inspection/PBX hunks,
reusing reviewed d9 helper. Native-warm-editor separately owns same-host channel.
Native coordinator serializes shared-file composition and later iOS verification;
FAB first, warm runtime parallel, then combined per-tab/save/keyboard proof and
next phone delivery. Root has independent reviewers available for frozen UI
successor; no additional permission is needed for already-authorized wiring.

Physical Dev17 delivery (2026-10-18 03:58 UTC): root inspected persistent
phone17-build2.exit 0, signature_verify_exit 0, bundleapp.zorid.notes.dev build17
and binary SHAa1933a0e385b35c736cefc38e3a2aa562ce630d0b7ac4117c6a7441a3c2d1a60.
Actual devicectl install and launch JSON both outcome success (separate exit 0),
launched PID10215. Evidence under /Users/ctk/orca/artifacts/zorid-native-20261018.
Source native649b3acc/reviewed2ccce; one-WK channel absent. No gesture/Home/runtime
acceptance inferred; prior Simulator startup remained inconclusive. Current phone
app stays open under user request. Heavy Xcode phase ended, allowing reviewed
Tasks successor frontend build/proof; no requirement to wait for phone UI approval.

Finite navigation source delivery (2026-10-18 03:56 UTC): maina2d480e2
integrates approved4d04d082 optional-capability TypeScript slice; all eight files
byte-match freeze.293 focused checks/fullTS pass, independent source/delta review
accepted corrected failed-admission pin and stale/link/lifecycle ordering. Report
mobile-finite-navigation-source-results.md records limits. No listener/service
is enabled without native sameVaultNavigation:1. Paired Swift and actual one-WK
navigation remain unproved; current phone17 build predates this channel. Main
frozen offline pnpm12 install restored seven missing Calendar packages without
lock/source change. Tasks UI proof remains separate, native owns phone Xcode.

Recovery progress (2026-10-18 03:50 UTC): Stage5 source preparation is saved
in stage5-enrollment-inventory.md and stage5-history-backup-inventory.md; existing
local-scope enrollment prevents a simple fixture-config Settings join wrapper.
Backup library and clean-client recovery acceptance are real, product operator/
history/join surfaces remain missing. Older recovery/relay docs reconciled;
Tasks/Bases/Calendar still precede Stage5 implementation. Managed recovered exact
62c6 host and Electron without compilation; actual Tasks proof resumes. Native
Simulator17 startup remained inconclusive after reboot, no gesture acceptance;
user requests physical Dev17 now. Native owner retains exclusive iOS slot for
owned Simulator cleanup then reviewed-source phone build/sign/install/launch,
coordinating with live Tasks proof and preserving booted Simulator. No phone17
success or same-host navigation completion yet.

Restart recovery (2026-10-18 03:44 UTC): machine reboot confirmed; temporary
builds/evidence and old process handles were lost. Main remains clean0e9c1174.
Root restored terminal084947b9, native d8fdd76f, managed62fd2871; durable run
addresses unchanged. Native reports build17 four steps/install/launch completed
before restart and installed Simulator artifact survives, raw temporary evidence
lost: revalidate artifact identity then bounded NO-BUILD pass under its existing
iOS slot. Managed Tasks assembly cc1fbf80 source/fullTS/Vite preserved, actual
Tasks proof never launched; restore matched host/Electron before runtime proof.
Missing workers are recovered from terminal_missing/abandoned receipts, not
silence. Existing source grants remain. All future evidence must persist outside
temporary directories. Root independently inventories existing Stage5 enrollment
source read-only; no new cryptography or implementation direction inferred.

iOS slot checkpoint (2026-10-18 03:30 UTC): native owner term_bbf1787b has
exclusive build17 plus bounded Simulator validation, followed by healthy Dev
phone delivery under existing authorization. Reviewed candidate c4fc1acd includes
paired strict8/Pages/editor gestures, Home/header/picker/per-tab source and the
source-reviewed scene reactivation fix. Reconcile main before freeze/build; no
runtime success yet. Same-host one-WK navigation is separate and still being
implemented. Worker371 also owns interface-only optional PlatformVault navigation
property; Tasks owner coordinates additive eighth openNote expectedEntryId arg,
preserving existing callers and immutable identity before recovery.

Browser implementation assignment (2026-10-18 03:26 UTC): reviewed current-v1
WorkBlock contract retained at d1940545; managed coordinator run_7a10da5526b5
is authorized to name isolated S/W/D/H/P/V workers exactly within the contract
ownership table. Freeze shared Rust DTO and worker/client RPC early. No native
compatibility, migration, DB/index/wire version, dependency or UI scope added.
Tasks delivery remains priority. Generated WASM/strictIDB through the normal
admitted Worker, bounded encrypted convergence and later rendered Calendar are
separate acceptance gates; source assignment is not browser completion.

Scope correction relayed by managed owner (2026-10-18 03:17 UTC): direct user
instruction removes spaced repetition entirely from this implementation goal;
it is not a deferred requirement. No worker was implementing it. Historical
goal/objective wording does not restore that scope. Managed owner supplies its
matching implementation-plan amendment; other accepted work remains unchanged.

Navigation implementation ownership (2026-10-18 03:17 UTC): revised one-WK
contract accepted for a first bounded Markdown same-vault slice. Worker371
owns mobile-native.ts finite optional request/result channel, mobile-only
Workspace staged stable-ID navigation, and note-buffer.ts/note-durable-state.ts
immutable expected-ID admission before recovery. Native owner owns paired
plugin/root/factory/history validators and physical-host versus logical-route
generation fences. Source flush and target admission precede visible commit;
native cursor advances only on correlated fresh validation. Path-keyed buffers
must reuse/rekey the witnessed stable-ID writer atomically or reject drift
before recovery. Preserve retained drafts and normal revision reconciliation.
Three real retained views/adjacent preparation is a subsequent scoped slice;
Native Files shared-host service is separate. No generic pool or editor-internal
rewrite. Tasks C retains separate Workspace capture and Vault.create optional
synchronous pre-dispatch validation hunks; managed R reviews the queued-refresh
race fix. Owners coordinate hunks directly, preserving canonical Calendar.

Native isolation delivery (2026-10-18 03:15 UTC): main35f38950 integrates coherent
per-vault model/store/picker/factory batch d7265e54. All four Swift files match
built/tested51fad6d8 exactly. Combined16 build passed; actual fresh-vault A/B
Home-tab IDs remained disjoint, original IDs restored on switches and B process
restart, separate metadata stayed unchanged and0600. Runtime evidence is in
native-mobile-integration.md. Picker hidden-bar required an explicit unchanged-
artifact restart workaround; its fix and new current-vault Home presentation
are not proved here. File-body tabs/swipes/keyboard remain outside this pass.
Owned Simulator app/helper closed; iOS slot returned, phone remains Dev15.

Canonical delivery checkpoint (2026-10-18 03:13 UTC): Task query binding and
retained Type sources are integrated at f62fa48a/9ed74f18. Desktop Calendar is
integrated as seven scoped commits 43093c57..3e4c3ae9; all22 changed source,
test, dependency and report files exactly match reviewed assembly4c5b7478.
Independent24 focused cases and actual3-process Electron proof cover creation,
title/atomic-range edits, pointer move/resize cancellation, four views, split,
reopen and durable deletion; final light/dark/narrow screenshots accepted.
See managed-data/calendar-desktop-results.md and calendar-desktop-review.md.
No repeated build was needed for identical source. Calendar currently presents
standalone WorkBlocks; Tasks joins, Google, browser and mobile are not claimed.
Managed owner continues Tasks UI close/uncertainty fixes and actual proof, plus
read-only browser WorkBlock seam mapping before any activation approval.

Native owner retains native-vault-context composition: combined16 compiled but
fresh A/B vault runtime checks remain underway. Reviewed picker navigation-bar
fix93205742 and editor header removal92ce0376 are not in that running artifact.
Per-tab history registry55ec6eb6 has52 actual-source host assertions and scoped
independent source approval; root caller composition/runtime remains native-owned.
Latest user clarification: new tabs open the current vault's native landing
page, never a vault picker. Independent Rust/native/TS audit recommends one
persistent current-vault host and warm WK/Workspace/client lease: existing
openNote/followLink avoid per-navigation Vault.initialize. Owners must reconcile
a narrow ticketed stable-ID navigation/ACK contract before implementation;
bounded actual adjacent editor state is still required, previews alone do not
establish warm readiness. No broad multi-realm protocol or new Rust authority
API is approved by this checkpoint.

Canonical service checkpoint (2026-10-18 03:06 UTC): main4f768f9f..f2988dee
integrates exactly17 N+B native WorkBlock/desktop binding/proof commits, excluding
the feature merge and separate Task query/Calendar slices. Root compared26 changed
source/test/build files with tested6e915 assembly: byte-identical, diff check pass.
Final independent review and actual3 Electron launches/26 commands cover scoped
bridge/storage create/edit/reopen/replay and observer-interruption exact retry.
Real contextBridge error-field loss was fixed with a validated plain envelope;
failed initial proof retained. Two launches needed owned SIGKILL; native children
exited. No graceful UI-close, rendered Calendar, network/mobile or whole-goal claim.
Root mobile lock refresh adds only serde_json/records edges to NativeVault, offline
resolution plus locked verification; no versions changed. Separate Tasks query
and actual Calendar UI batch is awaited, Tasks create-uncertainty fix remains
owned. Disk recovered enough for bounded proof; no broad build campaign needed.

Resource/lifecycle checkpoint (2026-10-18 02:56 UTC): ENOSPC at184MiB left the
desktop host truncated despite Cargo success; it was never launched. Managed
owner removed only old generated feature caches (~1.8GiB); root removed9 obsolete
stage4 test executables (285MiB logical), preserving current libraries/host/cache.
Headroom ~2GiB; rebuilt host44MiB arm64 Mach-O verified, frozen Electron proof may
proceed. Native owner inventories only owned obsolete iOS copies, preserving16,
phone15 and proof/toolchain. Combined16 build passed current Rust/Swift; no A/B
runtime proof yet. User now explicitly requests selected-tab back/current/forward
warm pages and separate per-tab history. Native owner owns lifecycle/routing,
371 shared TS suspend/rebind after strict8 freeze; agree minimal contract/prototype
with one active writer, bounded pool, durable quiesce/fresh reactivation and stale
callback fencing before changes. This supersedes discussion-only intent, not the
existing save/recovery guarantees. User Files header removal source is separately
reviewed with accessible fallback; no warm lifecycle code exists yet.

Phone/combined-build checkpoint (2026-10-18 02:49 UTC): Dev15 signed build20613,
install/launch23417 all passed on the physical test phone; it remains open for
the user. Exact recovery3d80209a/runtime11c91da1 source, no diagnostics or unreviewed
per-vault/strict8/quiet-loading changes. Link touch behavior is still unverified,
not a passed Simulator interaction claim. Native owner has next bounded iOS slot
for coherent d7265e54 per-vault source after reconciling current main, then A/B
vault switch/restart. Root refreshed mobile/rust/Cargo.lock offline: only missing
zorid-records package and Store edge, reusing already locked dependencies. Older
native branch/core builds do not validate this combined source; no repeated85
host tests are required unchanged. Native WorkBlock/Task query/desktop service
and Calendar UI ownership is active on isolated managed desktop integration;
shared Workspace changes must preserve371's disabled-state initializer.

Canonical domain and test-candidate checkpoint (2026-10-18 02:46 UTC): main
319c2238..62e7ad8e integrates all9 Types/Tasks domain/config commits through
fc711906, exact affected trees, independent source review/21 Node/scoped TS and
unchanged11 Rust checks. It does not activate task capture/UI. Main e317c196+
ac2d6763 integrates the paired89/91 link patch; five files match both reviewed91
and clean build14 source.90 focused checks/scoped TS and actual Vite/copy/Xcode
build pass, but matching native tap/caret test remains INCONCLUSIVE because
automation selected folders/audio instead. Do not mark link UX complete. Root
supersedes its earlier automation-before-phone gate: native owner may deliver one
clean reviewed Dev phone TEST candidate under existing authorization, recording
artifact/receipts and explicit unverified behavior, with no diagnostics. Stop
repeating the unreliable AX campaign. Quiet-loading copy is canonicalf135dee1,
visual/VoiceOver unverified, no speed claim. Other native paired/scoped source
remains isolated until caller composition; no WebView reuse authorization.

Composition checkpoint (2026-10-18 02:37 UTC): WorkBlock portable batch is
canonical main5ab6d54f..7d375ab4, matching8351b8e8/631dbd28. Domain checks pass,
not yet desktop service/UI delivery. Native WorkBlock worker owns new services
and native.rs/lib.rs dispatch plus necessary dependencies; desktop binding owner
also owns editor-core/client-admission guards and bridge/platform injection, all
under existing client/window/vault leases. Routine module placement needs no
repeat grant. Native6a5a6d74 per-vault model/store passed85 actual-source host
checks but is NOT merged alone: callers require adaptation. TS6d0145e8 strict8
state passed206 focused/full TS and source review, held for matching Swift paired
composition; old strict4 consumer rejects it. Link14 clean build/install passed,
but matching WK tap/caret remains unverified due interaction tooling/route misses.
Native owner may do one visible short fixture probe; report inconclusive honestly.
WebView reuse/pooling is discussion only, no lifecycle refactor authorized. Current
phone remains proven Dev10; newer device build remains conditional on final proof.

First-party implementation checkpoint (2026-10-18 02:26 UTC): root read the full
5fb80202 consumer map and authorized independent Types/Tasks domain files in
zorid-bases plus task preset/config modules, and WorkBlock compiled validation in
zorid-records with narrow Store/WASM admission hooks. Same records owner may add
zorid-core and already pinned chrono/chrono-tz dependencies/feature lock edges;
root still integrates main. Local/incoming/retry/restore all share validation;
tasks remain Markdown files, never managed mirrors. Existing export64-page limit
must not silently rise to the proposed UI200-row aggregate. Host/desktop/Workspace
activation hunks need named ownership later, no new framework. Schema guard is
integrated mainafb3947c..87efd9db; replica fixture/proof52c3cf55..e5a5405b closes
bounded independent adapter-worker HTTP1 convergence, not normal product authoring.
Native371 bridge contract is strict8 fields; only Workspace disabled initializer
hunk is shared. Unsafe state always cancels without resetting producer high-water
revision; native owner alone owns Swift matching consumer. Per-vault model/store
API uses trusted UUID and throwing v2 restore, with no silent old/global fallback.

Mobile steering checkpoint (2026-10-18 02:19 UTC): user phone findings require
vault-scoped tabs/restore, functional Home create, route gestures, and skeleton-only
loading without technical text.2f owns isolated NativeDocumentTabs/MetadataStore
partition + pending-ticket encoding; native owner owns context/coordinator/factory
and NewNote caller integration. Home routes through the same guarded Pages create
flow, choosing a vault if absent.371 owns additive TS editor gesture eligibility
fields after direct API agreement; native owner alone owns Swift consumer/gesture
hunks. No generic plugin/framework or extra host is implied. Link91cb90dc cleanup
successor passed independent source review and owner90 focused checks/scoped TS;
matching WK retest remains required, diagnostics excluded. Actual13 original
failure and before/after regression evidence remain retained.

Canonical worker checkpoint (2026-10-18 02:18 UTC): mainbf575275..547036a7
integrates exactly five normal-worker commits through38539b42. Root verified
source/tests/results trees byte-identical and raw report SHA616b4bd9 matching,
read independent final review and actual proof; diff check passes. Actual normal
Worker + WASM + strict IDB five groups,17 focused and full TS pass. Startup
retained retry, network-parent child recovery, foreground missed-hint catch-up,
release/reacquisition and held real transaction drain are covered; not all race
interleavings. Product registry is empty; no product/UI/public authoring or
two independent normal-worker offline author convergence completion. The latter
has a separately owned new fixture/proof followup. Optional-only registration
guard is separate bounded source work, not included here. Overall goal remains
active; later native/mobile consumers and type/task/Base/Calendar UX remain.

Runtime checkpoint (2026-10-18 02:15 UTC): diagnostic13 actual touch trace proves
the fallback cleanup microtask runs before CodeMirror's actual touch-end handler,
clearing the saved gesture; no default-guard relaxation is justified. d809 owns
cleanup-order fix/regression, native owner owns reviewed WK retest. Temporary
diagnostics must be fully removed before final source/assets freeze. Phone has
reconnected: exact signed Dev10 installed and launched successfully7774, replacing
the earlier pending-connectivity status; it does NOT contain the failed link fix.
Native owner has next device build/install slot after final link WK proof and
current cleanup, no duplicate approval loop. Browser normal-worker phase reports
five actual Chrome groups +17 focused/full TS pass at804c9fd5; final exact source
and proof review pending, not integrated yet. Loading module-overlap followup
workspace.ts hunk assigned2f via native owner, separate isolated source; no speed
claim or recovery/listing bypass. NewNote caller exact model/coordinator/Pages/
Mobile/factory/project hunks are authorized to native owner on future successor,
with durable prospective snapshot and same-session startup inspection preserved.

Canonical browser-storage checkpoint (2026-10-18 02:04 UTC): main901c6ff3..
b5d9d510 integrates the13 reviewed managed-records browser commits through
8bf1ca06. Root verified all affected crates/src/scripts/manifests/lock/harness/
managed-doc trees byte-identical to that candidate; no relevant main overlap and
diff check passes. Separate native history work is preserved. Evidence includes
portable/native/WASM125 checks, final helper subset16 (overlapping), browser83,
full TS, actual WASM/Vite builds and eight real Chrome/WASM/strict IDB groups.
See docs/managed-data/browser-record-results.md and retained raw proof; this is
an internal storage subset, not whole Phase1/worker/UI completion. The numeric
round-trip defect has concrete reproduction and float_roundtrip fix, canonical
validation retained. Managed lead is authorized to implement minimal trusted
normal-worker registration/startup/foreground retry/change catch-up/shutdown
draining in named browser-core-worker/browser-sync-worker hunks from the reviewed
map, on isolated integration branch. Record owner/contract directly; no redundant
approval loop or exhaustive test campaign before functional host delivery. No
public plugin API, new replication loop or product UI is implied by this grant.

Actual WK checkpoint (2026-10-18 02:03 UTC): link candidate5bc70762/89be64c8
frontend/copy/incremental build12 passed, but actual single rendered external
Markdown link tap with a separate body caret and visible software keyboard FAILS:
the label becomes Markdown source and no external app opens. Pan remains in the
source; long-press nonactivation passed. This supersedes any inference of native
completion from86 Node checks/source review; candidate is NOT on main. d809 owns
same scoped source followup and temporary numeric-only touch/selection validity
diagnostics; native owner owns retained iOS build/runtime slot. Do not commit or
ship diagnostics. Identify actual WebKit timing/guard failure before changing
gesture semantics. User also questions Files shortcut/arrow controls; queue UX
decision, preserve accessible parent/back fallback before removing controls.

Canonical integration checkpoint (2026-10-18 01:54 UTC): main71c2bb7d..a49d6d72
integrates reviewed native history + durable tab metadata batch through1f7ecc59,
including readiness correction2cdbd86f. Root verified the entire ios/App tree
byte-identical to that candidate; project/plist lint and diff check pass. Only
documentation conflicts were resolved, retaining both sessions' findings. Native
owner reports actual Simulator Back/Forward/exact folder return, nonregular
metadata activation block + Retry, typed Rust save/reopen, malformed metadata
explicit error and healthy restart preserving tab UUID/body all pass. App/helper
closed; Simulator remains booted. Software keyboard toolbar is NOT proved (its
control lookup failed); no broad mobile parity, NewNote/import/edge completion.
Separate link candidate5bc70762 (exact89be64c8) is NOT included; native owner
holds next iOS slot for frontend/copy/incremental build and actual WK proof.

Actual UI checkpoint (2026-10-18 01:39 UTC): Simulator11 confirmed native Files,
folder/nested note, header removal, durable tab metadata save and editor Back
availability. Back restores the exact folder but Forward stays disabled: root
fresh restoration runs before Pages listing/menu loan becomes idle; no later
readiness notification resumes the retained traversal. Native owner owns narrow
Pages readiness property/deferred existing callback plus root guard, with focused
2f review and rebuild/reverification authorized under retained iOS slot. Preserve
this correction when composing371 edge gesture hooks. No typed-edit/no-loss or
complete history UX claim follows from this partial pass. Link89be64c8 passed
independent source review plus owner86 focused checks/scoped TS; matching actual
WK tap/caret/gesture verification remains required before mobile completion.

Progress checkpoint (2026-10-18 01:36 UTC): native Simulator11 full build95537
passed on c8fd423c (runtime bytes equal reviewed588bc), app UI verification is
active under native owner; no final UIKit/metadata failure-retry proof yet.
NewNote helper d9f5cfb6/e720f5ed and actual-helper harness fbf954a4 passed source
review and31/31 bounded macOS host cases, using controlled framed I/O boundaries,
not the Rust host/UIKit. Native owner is authorized to compose helper, minimal
project registration and caller durable-metadata/exact-loan handoff after the
frozen current UI pass. Do not claim working NewNote UI yet. Pages edge routing
source assigned371 on isolated588bc successor, iOS16+ only initially; iOS15 keeps
arrows, editor gestures remain outside scope. Managed A/B private seam recorded
2e6544f8; independent review and source proceed on isolated integration branch.
B's reviewed opener/dispatcher/type hunks authorized after direct A/B DTO
agreement; worker-host/public API/UI remain later, main integration only root.

Latest resource steering (2026-10-18 01:31 UTC): direct user clarification relayed
by managed-data lead says build-slot permission applies ONLY to iOS. Rust/browser
workers run bounded focused checks independently; do not gate them on iOS slot
return or repeated coordinator ACKs. Preserve actual resource awareness on this
8GB machine and existing live processes, main integration and shared-file owners.
First browser A/B source wave in df764648 is independently approved: A owns
portable admission/native behavior-preserving delegation and private WASM;
B initially owns new adapter/tests, existing dispatcher/host comes later. A/B
agree minimal raw-byte DTO directly and record it, without another grant loop.
Native15 typecheck passed on588bc; actual Foundation history193 passed after
explicit macOS SDK/target command correction (initial harness compile failure
retained). Native owner now has Simulator11 build+focused history/metadata UI
slot, including disposable metadata-only failure/retry checks. No app UI proof
yet; NewNote/link/swipes remain separate source work.

Native follow-up checkpoint (2026-10-18 01:24 UTC): configured history source
review accepted Mobile4ab5cdec / Coordinator e46b3ec9 / Factory9d41f71c after
all three transition/background/supersession corrections. No compiled/runtime
history claim yet. Next compiler slot awaits frozen combined typing/harness
commands. Native owner assigns d809 isolated mobile-rendered-link-touch from
main07415616, only live-inline/native-caret-visibility plus minimal editor.ts
native capability; touch admission must preserve pan/long press, not assume
mousedown alone covers WebKit touch. Actual WK tap/caret proof remains required.
For New Note, source audit established a minimal native-owned rejection journal
protocol; no core cancellation/schema change is needed. bd57 may extend only
NativeNewNoteRequest: completed parsed invalid_request/false followed by exact
same-loan not_committed, with serial exclusive dispatch and no outstanding call,
permits generic rejected retirement. Persist per-CID terminal first, then current
terminal; all replay paths consult per-CID terminal. Unknown dispatch/status/CAS
or release retains the gate. Fresh IDs require both terminal writes verified and
exact loan release/fence ACK. Retain old CID rejection; this is not a universal
core tombstone. Implementation/review/runtime acceptance remain pending.

Integration checkpoint (2026-10-18 01:24 UTC): managed wire/native Store batch
is now on main8f0f0c43..f26eb0b5, corresponding exactly to reviewed2276582d.
Root verified Cargo.lock and both changed crate trees byte-identical to that
candidate and inspected terminal logs: wire13, family3, managed24, ledger7,
immutable6 all pass (53 total). Independent2276 review approved the metadata-only
publication-cache identity guard. The earlier failed regression is fixed without
weakening its assertion. Compiler slot returned; native history checks are next
after corrected source freeze. This establishes the native library adapter, not
browser host wiring, cross-platform runtime or Tasks/Calendar UI completion.

Latest coordination checkpoint (2026-10-18 01:21 UTC): managed adapter1597c1ed
source review passed; actual wire13/13 passed, but focused family tests failed
2/3 because missing family_materializations was not detected by family_status.
Batch96924 exited101; managed24/ledger7/immutable6 remain unverified. Managed
lead retains exclusive bounded diagnosis/fix/retry slot; replacement owner
term_03e6cf14 owns only family_store.rs in the isolated Store worktree. No main
adapter integration yet. Native owner queues combined Swift/history checks after
explicit slot return. Independent reviews approved metadata library94fa86b8 and
Pages history hooks1915f58f, not their complete runtime wiring. Configured history
review found temporary transition flags clobber availability and backgrounded
installed Pages can strand a traversal; native owner fixes both before freezing.
stage4_native_consumer owns source investigation of minimal New Note terminal
cancel/rejection; stage4_contract_review audits mobile link tap/caret behavior.
Phone Dev10 artifact remains ready, but device tunnel unavailable; no physical
installation proof. Preserve2add header removal while composing Pages patches.

Latest reuse review: the user explicitly requested evaluating Etebase before
expanding custom sync/E2EE infrastructure. `livesync_audit` owns the source-based
comparison; `crdt_interop` independently reviews Yrs transport and security
lifecycle fit. Current Yrs/RustCrypto primitives remain in use; no backend switch
or migration is approved. Compare complete requirements, including browser/core
portability, independent CLI, durable ingestion, key recovery/revocation and
encrypted restore; library encryption alone does not establish protocol safety.
The completed source assessment is in `docs/history/etebase-reuse-assessment.md`;
it includes independent Yrs/browser review and no runtime/security-audit claim.

Subsequent user clarification: use Etebase as a reference and selectively reuse
or adapt its logic into Rust; Obsidian LiveSync must remain a reference too.
Retain the Rust/SQLite architecture. Evaluate transferable account/key/storage
patterns from Etebase and vault synchronization/recovery/P2P patterns from
LiveSync against our own requirements. Record pinned provenance and applicable
licenses for copied code, plus tests for adopted behavior. This is not approval
to invent encryption primitives or a claim of compatibility with either system.

The user additionally requires systematic review of LiveSync's solved edge cases.
`mobile_readiness` owns a pinned source/tests/changelog matrix, consulting the
prior `livesync_audit` findings. Relevant cases must map to Zorid regression tests
or explicit gaps; source inspection alone is not verified coverage. Target
artifact: `docs/history/livesync-edge-case-matrix.md`. Record audit scope and uninspected
areas rather than claiming that every upstream edge case has been exhausted.

1. Read AGENTS.md, this checkpoint, the accepted decisions/sequence below and
   relevant rows of `docs/user-findings.md`; inspect the active built-in goal.
2. Inspect current git status, main HEAD, worktrees and live agents. Verify task
   ownership against actual files/commits; do not recreate work that already exists.
3. Resume the first unblocked task. Every assignment must name scope, owned files,
   dependencies, worktree and acceptance checks. Shared interfaces have one owner.
4. Update the ledger after decisions, assignments, commits, verification, failed
   attempts and integration. Record exact commit, command/result and environment
   for evidence; keep implemented, reviewed, integrated and verified separate.
5. At handoff/context reset, record unfinished operations, next action and blockers.
   Reconcile stale statements rather than treating chat summaries as authoritative.

### Integration checkpoint — 2026-10-17

01:18UTC: finaladapter1597c1ed independentlySOURCEAPPROVED native library slice,
including 24fixtures+checkedpendingaggregate+testcleanup; wireblobs exact9dda.
Actual53checks remainpending, samegrantedslot, no browser/host/UIclaim. Native
Pageshistoryhooks1915f58f source-ready, rootreviewassigned exact58+/7- delta; owner
composespatchpreserving2addheader, no fullfileoverwrite/newcompiler. Metadata
94fa86b8 source reviewactive, no sourceapproval/runtimeclaim yet.

01:17UTC: exclusive recordsadapter53focusedchecks GRANTED managedlead860c8b64
afterknownfailpointfixturecleanup fix+newSHAfreeze (beforefirstexecution). Exact
four serialcommands wire13/managed24+family3/ledger7/immutable6, official1.95
sharedstage4-verified/offline/locked-j1/threads1. No oldportable33/fullsuite/network.
Native_consumer source review tracks860c+smallfixturefix, wire9dda approved.
Retainhandles/logs toterminal+explicitreturn; nativehistorycompilerwaits, existing
Dev10device-onlydeployment unaffected. No compiler waslive beforegrant.

01:15UTC: managed nativeadapter1c8d76bf+semanticwire9dda source-ready; root
independentStore/native_consumer and wire/markdown_contracts review active. Final
composedSHA+filtercounts forthcoming, boundedwire13/managed23+family3/affectedledger
andimmutable tests queued, no compilercurrentlylive. Native configuredhistory
wiring scope ACKddfa107bf45a:371 scopedPagescallbacks/availability/restore; native
owner coordinator/picker/loader/factoryonNavigate (bd57metadataonly). No editor/
Rust/manifests; ONEticket/validatedcursor and existingrootlifecycle required.
Dev10device-onlydeployment remainsunconfirmed; artifactunchanged, no rebuild.

01:14UTC canonical native integration: maina56c2d16 merges exact2add282b after
independentcombinedsourceapproval, Simulator39003 build+focusedFile/HomeflowPASS,
signedDev10build21794+strictartifactverificationPASS. AlliOSfilesbyteidenticalto
candidate, plist/projectlintOK; mergedbothledgerspreservingmanageddatawork.
No newtypededit/failurepath/keyboard/background/fullparity claim. History/NewNote/
import-router/share/duplicateUI stillrequired; staticimportrouternil. Phoneinstall
notconfirmed CoreDevice1011connection, nativeownerdevice-onlyretryexistingartifact.
No compilerlive, rootheavychecksnotneededforunchangedsource; nextadapterworkisolated.

01:12UTC: signedDev10build21794 terminal0 frozen2add282b, verifiedDevbundle/
version10/development/iPhoneOS+strictcodesign/entitlements. Installattempts both
terminal1 CoreDevice1011/tunnelunavailable, notsigningfailure; useralreadyasked
by nativeowner to reconnect/unlock. NOinstall/launchsuccessyet. Allcompilersclosed/
simcleanupconfirmed, rootreleased compiler slot; ownerretainsdevice-onlydeployment
and existingartifact, no rebuild/newpairing/profile/accountchange. No rootheavyjob.
Managed sourcecorrects wrapperper-opstructural vsStorecontextinvalidclassification
and record/gen-scoped operationcommitments; sameapprovedcontract, no newgate.

01:11UTC: rootreconciling merge-ready native2add282b tocurrentmain. Merge-tree
dryrun CLEAN d6b1d8b6...,14native/docpaths only; integration source review assigned,
no Rust/rootmanifest/editor changes. Preserveownerphonebuild21794/sourcefreeze.
bd57 NEWNativeTabMetadataStore API approvedfixedappsupportZorid json/128KiB,
atomicfile+dirsync/explicitpostrenameuncertainty/no vaultpaths/migration/fallback;
sourceonlynewfile, pickerintegrationlaterreview, no livecandidate mutation.

01:10UTC: rootfocusedread corrected durable-adapter-contract SHA2567c638a6c01bc565d5042a94c7e81ac1bd5c454b277e0dff52ed97f7a76b2e0fb
APPROVED for isolatednativeimplementation. All explicitgenerationtarget/unique
key+priorcommittedtombstone/replay-beforefreshrevision/exactschema/faircontinuation
corrections included. NamedStore6307/ctx856 existingfilegrantff87 reaffirmed,
wirecf5NEWmodule/testsscope unchanged. No furtherapprovalloop forunchangedsource
scope; actualdurableimplementation/review/tests beforemain/Phase1acceptance.
Nativephonebuild owns heavyresources, no new compiler granted.

01:09UTC: uservaultsubtitle6line removal independently source-approved, final
NativePages SHAa41bac48..., committedphonecandidate2add282b (otherSimfb1csource
unchanged). SignedDev10 buildstartingunderextendedgrant, pinnedpnpm/Rust/jobs1,
existingDev9automaticwildcardprofile/no provisioningupdates, privatecontractonly
team/device, fresh/private/tmp/zorid-ios-v10-phone-20261018. No install/launchproof
yet, phonepreviousversionuntilactualsuccess. Native retains slot/sourcefreeze.

01:08UTC actualSimulator10 focusedFile/HomePASS: nativevault/Pages→existingnote→
quiesce/closeoverview→newHome→HomeShowtabs→twoTabs→originalnote/bodypreserved→
ReturnFiles usable. No typededits inpass (notnewedited-saveproof). Screenshot
/private/tmp/zorid-mobile-v10-tabs.png, ownedapp/helper77553cleanupterminal0.
Userdirectvaultlabelheaderremoval queuedtinyreviewedPageshunkbeforephonefreeze.
Phonepreflightstoppedbeforebuild oldcontractproductionbundle mismatch; existing
Dev9automaticwildcarddevelopmentsigning allowedwithteam/device/bundleverified,
no newprovisioning/account/networkchanges. Native slotretained, actualphonebuild
pending. Rootrequestedcoherentconfirmedmainbatch/dependencyreviewinventory.

01:07UTC: managed Storeowner term6307/ctx856 named source grant now includes
narrow StoreCargo/lib/schema, family_ledger/family_store Recordsarm,
immutable_payloads records/nullfiledescriptor, family_ingress exhaustive isolation
only ifneeded, records/lib wire registration and Store->records lockedge. Purewire
cf5 ownsNEWwire/tests, coordinate one dispatcherowner. Mandatoryreviewcontract:
explicitrecord/gen target; restore immutable relation notkey and exactsame-record
prioraccepteddeletedgen; authorizehandle then exactreplay beforecurrentrevision;
registered schemaversion equality initially, mismatchunresolved; fairretrycursor/
wrap beyond16blocked; same durable receipt/state/sharedcursor+localintent/sealing.
No crypto/proto/relay/browser/native/publicplugin/rootmanifest scope. Isolatedsource
mayproceed, independentreview+affectedchecks beforemain; no heavyjob while native
Simulator/phoneowns slot. Sourcegrant doesnot mean implementation/integration done.

01:05UTC managed namedowner: records-store/dispatcher term_6307fc89-12c7-4bd1-a490-27eb41bc87ef
task_2448039200d5/ctx_856b7fa4e164 isolatedmanaged-records-store owns NEWmodule/tests;
wire term_cf5aebc1/ctx_3cacb97fdb34 isolatedmanaged-records-wire owns NEWwire.rs/tests
unregistered. Existinghunks conditional oncontractreview. Rootreview confirmed
existingledger/AAD fit, found host restore requires exactsame-record priorgeneration
committedtombstone lookup, and managed_apply explicitrecord/generation target.
Both sentlead27f071dac468, reviewfinishing boundedretryfairness/quota details.

01:04UTC: native Dev10 exactcommand/private signingcontract use ACKed underuser
phoneinstall extension; no provisioning/accountchanges, afterfocusedSimpass.
ActualSimnoteopenPASS, tabclose/Home checks71219 pending; native stillowns slot.
History77018b63 source-ready, rootreviewassigned. Importrouter cancellationreceipt
refinement ACKed scopedowners; path-only selectedfolder has realreplacementrace.
Beforefolderimportexposure use explicitroot-only initialdestination OR propose
minimal core parentID/revision atomicbinding; UIrelisting isn't atomicproof.
No newRustimplementationgrant yet. Managed durable-adapter-contract readinfull,
independentrootcontractreviewassigned; existingStore/family edits conditional on
namedworker+review, newunregisteredmodules sourceallowed. Native frozencheckout
isolatedfrommanagedbranch; rootnoheavychecks duringSim/phone verification.

01:03UTC direct user phone request reported by nativeowner: installupdatedDevapp.
Exclusive native slot EXTENDED afterfocusedSimulatorpass for same reviewed
fb1c04d7 signeddevelopment build/install/launch app.zorid.notes.dev, existing
key/profile/devicecontract only. This supersedes earlier agentkeepDev9 choice;
known NewNote/history/import incompleteness communicated, not reason to block
requestedtry. No AppStore/TestFlight/account/production changes. Exactredacted
command/handle/artifactsignature+bundle/version+install/launch evidence required;
closeownedSimulatorapp/helper, leaveuserphoneapprunning, returnslotafterterminal.
Actual Simulatorinstall/launch67686 terminal0, focusedUIpass stillongoing.

01:02UTC actual Simulator10 build39003 terminal0 BUILD SUCCEEDED, frozenfb1c04d7.
Ruststaticlib+fullXcodecompile/link passed; artifact
/private/tmp/zorid-ios-v10b-sim-20261018/DerivedData/Build/Products/Debug-iphonesimulator/App.app.
Command/log /private/tmp/zorid-ios-v10b-sim-{command.json,build.log}. Nativeowner
retains exclusive slot through1274 install/launch/focusedFile/HomeUI+cleanup;
results pending, no rootheavyprocess/phone9replacement. NewNote/history/import
remain explicitgaps; buildsuccess isn't nativeinteraction/wholeUX acceptance.

01:02UTC: history helper mayretain one boundedscene-level evicted-prefix pageorigin
to preserve folderReturn beyond100entries, samevault/store/reset, no pertabstack.
Native NewNote UIhandoff gap: UserDefaults.set isn't throwing durability barrier.
Later narrow NativeTabMetadataStore.swift app-owned <=128KiB atomic/syncedmetadata
plus picker persistenceclosure scope ACK, no liveSimulator source changes, broad
migration/vaultwrites/RustAPI/framework. NotesremainRustdurable independently;
failedUIhandoff retains exactCID/entry/metadata retry, neverrecreatesnote.
Actualsourcecontract/review required; occupied-name escape remainsopen.

01:01UTC: native pinnedpnpm12.14 existingabsolute executable verified; isolated
offline frozeninstall 36802 terminal0 in2.5s, no lock/manifest edits/sharedtree
mutation. Homehook source cherry fb1c04d7, reviewed coordinator/Mobile unchanged.
FullSimulator10 retry39003 LIVE frozenfb1c04d7, exactcommand
/private/tmp/zorid-ios-v10b-sim-command.json, log/private/tmp/zorid-ios-v10b-sim-build.log,
freshoutput/private/tmp/zorid-ios-v10b-sim-20261018, Rust1.95/jobs1. Native retains
slot, no rootheavyprocess; phone9 unchanged. Earlier broken-lock assertion was
pnpm9 parse error and retracted, canonicalmulti-doc lock remains intact.
Managed durableStore/dispatcher seam reservation sent41943ca81d2d, concrete
contract+namedworker required before existingfile edits; no productionwire grant.

01:00UTC: Simulator10 fullscript16736 terminal1 BEFOREcompilation, pnpm dependency
workspace verification rejected sharednode_modules. Native retains exclusive slot
for boundedprep/retry; verify pinnedpnpm12.14/rootcwd --dir (known9.15cwdtrap),
then owner-only symlinkunlink+isolatedoffline frozeninstall ifneeded, no sharedtree
mutation/bypass/network/lockchange. Rootread/approved HomeShowtabs d7e77c3c narrow
source; maycompose beforefreshretryfreeze sinceoldprocess terminal. No buildproof
or phoneupdate; actual newHEAD/command/handle forthcoming. FullSHA73da corrected
by owner, rootused actualGitobject73da2173e01167ac8789d9e326ea8fc84f49005c.

00:59UTC canonical integration: mainf7dc7569 merges exact73da2173 portable records
batch, all11 source/docs/lock files byte-match candidate. Actual33tests17018pass,
independent root library review approved; no repeatedtests or productionwire/store
integration. Managed lead next proposes exact family/AAD/adapter transaction APIs
and existingfile ownership nativefirst/equivalentIDB; no existingseam edits yet.
Native fullSimulator10owns exclusiveslot; d809 read-only importdestination router
proposal ACKed (explicitvault/folder/existingloan, no newhost/implementation before
APIagreement), bd57 importprefix/371Pages/rootnativeowner ownership preserved.

00:58UTC: nativeowner03fc0424 exactreviewed rootwiring committed. Exclusive FULL
Simulator10 build/install/focusedFile/Home UI slot GRANTED afterrecords17018
returned. Freeze reviewed HomeShowtabs factory successor ifincluded, reportHEAD/
commands/handles beforebuild; no hiddenHomehost. ios-build.sh simulator, freshowned
/private/tmp/zorid-ios-v10-sim-20261018, officialRustlocked-j1 +Vite/capcopy+Xcodejobs1
serialized; existing1274Simulator only. No phone9replacement/TestFlight; NewNote/
history/import remain gaps. Root source-only records integration allowed, no heavy
overlap. Native retains slot through terminals+ownedUIcleanup andexplicitreturn.

00:57UTC: records1842c15e granted tests17018 exit 0,33/33 pass (9adversarial,
24traces), no source/lockchanges; log /private/tmp/zorid-records-1842c15e-tests.log.
Root independent actualsource review approved library slice, programmaticbatch
caller memory bound remains documented; productionstorage/wire adoption separate.
Slotexplicitly returned, no compilerlive; native fullSimulatorpriority available.
InitialFile/Home rootwiring sourceaccepted exactcoordinatord6b0a0a9... and
NativeMobile130cb790..., awaiting frozencommit/buildrequest. NewNote/history/import
not covered; phone9 stays. Recordsresults/doc batchintegration forthcoming.

00:56UTC: corrected immutable13source Swiftfrontend25349 terminal0, zeroerrors,
concurrency warnings remain. Artifacts /private/tmp/zorid-connected-tabs-retry-20261018
{command.json,source-hashes.json,result.log,exit-code.txt}, manifestd1aff3f4...
includes factory/root/getter/latch/privatealert+foregroundcorrection, not link/UI.
Nativeowner explicitly returned slot. Root grants managed1842c15e queued33crate
tests exclusive now; no nativecompiler untilterminal/return. Native source review
2f active, frozen accepted wiring will precede fullSimulatorbuild request.

00:55UTC: managed corrected candidate1842c15e source-frozen,33crate tests
(24+9) queued for next Rustslot AFTER native13retryterminal. Root independent
actualsource review assigned base_reuse (library-only merge/causal/delete/tags/
resources and Yrs comparison), no compiler by reviewer. Native owner terminalread
shows active immutable retry preparation, priorgrant preserved; no takeover or
overlappingRustbuild. Finalrecordstestcommand uses existingofficial1.95 cache,
--offline --locked -j1 --test-threads=1, no broader suite/network/dependencychanges.

00:52UTC: native13 typing30104 terminal1 with single showMessage fileprivate
access error; fixed privately in coordinator. One continuation13source retry
granted after frozen corrected snapshot, no other compiler. Final foreground
recovery source review remains separate. NewNote f00ebadc independently approved
library-only; root delayed-CID handoff must honor returned originaltab/creationID,
occupied-name escape unresolved before UIexposure. Managed engine source active
5e1c78f3+adversarial2cb47716 (32tests unrun), ancestry resourcefix underway.
Root inspected/approved isolated6cdbd6c8 Cargo.lock exactly8new package lines,
existingserde/serde_json only; no production merge-engine/integration approval.

00:50UTC: native13 immutable snapshot typing started (handle pendingreport),
no competing compiler. NewNote NEWhelperf00ebadc source-ready, independent root
review assigned native_consumer: exact same-intent/CID checkpoint CAS, freshloan
ack, originalstatus/freshID, no collisioncode invention. Not exposed/compiled;
occupied-name rejection escape remains explicit functional gate before usable
NewNote. Per-CID completed checkpoint retention unbounded count is known, no GC
framework in this slice. Initial File/Home candidate continues independently.

00:49UTC: nativeowner granted exclusive bounded13source Swiftfrontend typing
on immutable /private/tmp/zorid-connected-tabs-source-snapshot, ae81678d plus
recorded dirty rootwiring snapshot, actual Cheader/cachedSDK26.2 flags. No Rust/
assets/fullXcode/install; handle forthcoming, slotretained untilterminal/return.
New factory+getter+latch/root APIs included, unlike earlier12sourcepass. Source
safety review remains separate: priorwireblockersclosed but latest9100 review
requires retained foreground-safe nativefailure recovery after actual Pagesclose
and postUIKit navigation rejection; no autoreopen/navigation. NewNote/history
still known incomplete, no phone9replacement or UXacceptance implied.

00:48UTC: managed newcrate source uses existing crates/* workspaceglob. Named
isolated Cargo.lock ownership grant for managedlead ONLY new zorid-records
package/edges to alreadylocked deps; no existing versions/checksums/edges changes,
network or rootmanifest edits. Exact lockdiff review before integration; compiler
still separately serialized with nativepriority. Typed authored operation-set/direct
encoding proposal remains provisional, not production merge-engine approval.
Require concrete comparison with existingYrs+retainedhistory and causal/delete/
resource negative cases before persistence/wire integration; no second authority
or unreviewed custom CRDT choice merely because plan doesn't mandate Yrs.

00:46UTC canonical integration: main3322d30b merges exact reviewed1a350fd2
(a2702e5+aadda867) managed-data feasibility fixture+7docs, byte comparisons pass.
All12 tests50530 exit 0; log /private/tmp/zorid-managed-record-feasibility.log.
Independent source review approved meaningful negative controls/actualTextReplica
firewall/provisional contracts. No production records/storage/sync/UI implementation.
Next NEW crates/zorid-records/** reserved managed lead; root/source manifests and
existing seams still unassigned. Native compiler priority next, no compiler live.
NewNote source audit: actual occupied-name create rejects precommit as generic
invalid_request/false, not typed collision; not_committed isn't durable rejection.
ExactemptyText create/status replay supported; current recovered file opens by
stableID/store, not oldfilename. Fresh binding needed after ready loan finishes.
Audit relayed helper; no unsupported collision phase or automatic new IDs.

00:42UTC resource: managed lead run7a10 granted one exclusive bounded
managed_record_feasibility fixture run (11+TextReplica firewall case, finalSHA
forthcoming), official existing Rust1.95 binaries/shared stage4-verified, offline
locked -j1/threads1. No fullsuite/manifest edits; retain handle to terminal and
explicit slotreturn. Native owner notified msg_00962db333f2; next composed native
typing/build priority after fixture terminal. Native source review proceeds only.

00:42UTC: actual native picker/root/factory File/Home/Showtabs/Settings/Return
wiring under2f source review; no compiler. Initial Simulator File/Home candidate
may verify known incomplete flow, phone9 stays until NewNote/history gates covered.
Minimal history followup ACK:371 owns NEW NativeRouteHistory.swift and scoped
Pages validated native-page/folder-restore adapters; nativeowner retains coordinator
integration. Scene-RAM existing100cap/cursor/pending target, stablevault/store/file
or folder identity, explicitroot nilfolder; no tabmetadata/newframework/persistence.
Cursor commits only validated target after root-owned close/install, not presentation.
Concrete APIs proposed first, source review before exposure; heavy jobs serialized.
NewNote helper assigned bd57, existingRustcreate+journal, no JS creation replay.

00:38UTC: native NewNote proposal source-confirmed existing create_text and
file_command_status reconstruct identical empty Text FamilyCommand. Narrow NEW
NativeNewNoteRequest.swift helper scope ACKea787cadb5de; nativeowner assigns one
worker, exact checkpoint-before-dispatch, same-ID uncertain retry/status and no
JSnewNote/doublecreate, rootfolder only. No compiler grant; file/Home composition
continues independently. Full helper still requires review and UI handoff recovery.
Managed lead may instead own NEW crates/zorid-crdt/tests/managed_record_feasibility.rs
plus docs/managed-data/** (no existing library/manifest edits) for bounded Yrs
semantics probe. Source first; send testcount/command for exclusive compiler slot,
native composedtyping retains next priority. No production merge policy frozen.

00:37UTC: full Pages09a4→cb097→f9c7→62c7381d independently source-approved,
all scoped blockers closed; native typing/runtime still separate. No compiler live.
Managed lead run_7a10da5526b5 isolated managed-data-foundation base d06eccd9 owns
docs/managed-data/** and experiments/managed-records/** new feasibility files only.
Production path/API/layout remains proposal, existing storage/crdt/protocol/root
manifest/native/editor seams unassigned. Source-only inventory workers active;
prior task/Base/calendar overlap details sent msg_ed36fec8c488, scope confirmed
msg_08ddf638682e reply. Native owner retains next composed validation reservation.

00:36UTC authorization/ownership update: managed-data lead
term_959a4f02-747c-4b9d-820e-3672def55e49 reports direct user authorization and
active thread goal for the managed-data/Bases/Tasks/Calendar plan. Read/copied
handoff to docs/managed-data-tasks-calendar-plan.md. This supersedes earlier
discussion-only hold for its coordinated Phase0/1 track; old checkbox/tag task
candidates remain superseded. Lead owns NEW internal contracts/structuredYrs
feasibility files in isolated worktree (exact path forthcoming), no existing
Store/schema/crypto/proto/manifests/browser/editor/native seams without assignment.
Root retains sole main integration/heavy scheduling; existing mobile owner keeps
shell/tab/import/menu scope. Shared-core review/meaningful validation still required.

Actual composed Swift54060 terminal0 on frozen c39f525c:12sources+canonicalCheader,
warnings remain (Swift5 concurrency/Sendable), no errors. Slot returned, no compiler
live. Artifact directory /private/tmp/zorid-mobile-composed-typing-c39f525c contains
command.json, source-hashes.json, result.log. Factory/projectlink/UI excluded.

00:35UTC: native owner starts reserved composed Swift frontend typecheck frozen
c39f525c,12 app sources+actual canonical Rust Cheader, iOS15 arm64Simulator
SDK26.2/cachedSim9 module cache/products. Exact command/sourcehash artifacts
/private/tmp/zorid-mobile-composed-typing-c39f525c/{command,sourcehash}.json (owner
reports adjacent sourcehash JSON; confirm actual filename before consuming).
No Rust/assets/fullXcode/install; owner solecompiler, handle/result forthcoming.
Factory excluded this pass; root3acc5818 sourceapproved, exactblob a9a2d9a3.
Pages ever-configured latch remains required; sourceacceptance/typecheck/runtime
are separate. Main runtime unchanged since bb155f3a and combined Rust check.

00:34UTC: root approved staged factory narrow correction (no scanComplete gate,
weak installed-owner toolbar bridge), commit pending. Settings callbackf9c7 and
UUIDfixcb097 ready; exactf9c7 still lacked ever-root-configured latch, correction
reiterated371 msg_ce240626bb8a. Nativeowner prepares isolated current-main/import
composition for reserved Swift typing; no compiler started. Configured editor
history is a required functional followup, proposal msg_e3a6384fb4a1: reuse existing
onNavigate/availability and bounded native route history, no legacy Boolpop.
No new history implementation before composed typing; arrows accurately disabled
until wired, not a completed feature. Do not lose this gap or Newnote factory work.

00:32UTC: native owner found factory scanComplete API incompatible with current
NativeVaultListing.reconciliationComplete. Remove global completeness gate only
for positively fresh-validated live file open; exact store/stableID/live witness
required, no absence/deletion inference or missingtarget fallback. UUID witness
fixcb097b8b source-inspected. Next exclusive bounded composed Swift typing slot
reserved nativeowner: freeze corrected candidate and report command/handle, no
Rust/web asset rebuild or installation. Actual composed API check prioritized
over further speculative source loops; latch/Settings/history UX gates remain.

00:31UTC: native coordinator exact accepted content SHA256a83c45cb... committed
875fc451 plus minimalPBX membership; not main/runtime verified. Root683f90dd
header source review approved, configuredhistory remains external route gate.
Factory a83fda5d source review underway. Pages09a4 review found clearing all
callbacks can reenable legacy routes after root ownership; lifetime latch/failclosed
correction requested371 msg_00e7c461860f. Fourth onChooseVault callback ACKed in
371 scope; Settings must use actual rootdrain. No native compiler requested yet.

00:30UTC source checkpoint: Pages tabs09a4ab41 atop09734eb4 source-ready, root
independent review assigned. Editor hooks683f90dd after5742+a02 source-ready,
separate root reviewer assigned. Both isolated/uncompiled; Python assertions do
not establish native execution. Configured history must route original intent
through coordinator; SettingsChoosevault needs explicit root callback/drain in
Pages before global composition. Coordinator latest didInstall quarantine bug
must preserve reservation cleanup when Showtabs opens; review gate relayed
msg_de7a1905e017 along with prior exclusive afterSaving publication fix. No compiler
live; main Rust integration complete, mobile candidate acceptance remains pending.

00:28UTC canonical integration: mainbb155f3a merges tested583cebce native-menu-wire.
Final17/17 pass: host6 /private/tmp/native-menu-wire-host-bounded.log, portable2
parent-retry, Store7 authority-final and Store2 summary-final. Eight source files
exact tested branch; hostlib differs only earlier import module/export/leasefield,
reviewed automatic composition. Root combined main cargo check11217 terminal0,
log /private/tmp/native-import-menu-composed-check.log. No compiler live; slot free.
Rust endpoint/core verification does not establish composed Swift/mobile behavior.
Coordinator review prior two retry blockers fixed; last synchronous afterSaving
publication overwrite sent owner msg_e476c70c4fd3 for one-hunk correction/review.
Pages/editor header/history/factory source composition remains isolated.

00:26UTC: Pages history cursor stays unchanged on root-routed opens; generation-
bound actual-close query ACK52d427e4, no navigation authority. Narrow d809 scope
ACK88c9206ba107 adds native tab/return callbacks and explicit-foreground recovery
for alreadyclosed unconfigured legacy container; configured routes stay root-owned.
No Scene/project/compiler grant. Coordinator corrections under final2f source
review; file/Home factory remains separate from unresolved Newnote creation mode.
Optimized host35070 terminal101,5/6 passed: >1MiB full reply/status/count proof
now works; fixture incorrectly assumed projection pending, actual settled. Worker
corrects assertion to documented settled|pending and reruns six only; no production
logic change, no pass claim yet. Core pending/settled evidence covered separately.

00:24UTC: host38747 bounded at2m11s/terminal101 SIGTERM, no pass claim;
expensive repeated native recovery during setup is being replaced with public
Store setup on one connection, closed before real leased host endpoints. Preserve
actual >1MiB reply/status/compact assertions. Next log
/private/tmp/native-menu-wire-host-optimized.log; Rust worker retains slot.
Latest native coordinator draft audit msg_472295a52a0c still has concrete route,
foreground epoch and recovery corrections; owner notified msg_23227ec2562a.
Native owner assigned bd57 new-file-only NativeTabDestinationFactory.swift for
file/Home preparation; API ACK msg_d0577b80284b conditional on exact coordinator
signature agreement. No adapter navigation/hidden Home host; buffer fresh identity
until root registration if needed. Newnote factory mode remains separate proposal
until existing durable create identity/uncertain retry behavior is reviewed.

00:23UTC: root independently source-approved fcdb2a78/e0704c2f. Corrective
portable2 tests passed; final host run38747 live, log
/private/tmp/native-menu-wire-host-final.log (old retry log records failures).
Strict-input checks now pass; real >1MiB receipt recovery still executing.
Native a02 retirement correction fixes the tab seam in source, but global
composition remains conditional on legacy returnToVaults/traverse recovery or
complete configured-owner routing. Gate relayed msg_06a7ef702f84. Owner composing
5742+a02 source-only; Pages callback/drain/witness implementation active, coordinator
draft still awaits review and native validation. No overlapping native compiler.

00:22UTC: d809 correction a02b7397 after5742f382 source-ready; independent root
review assigned. Exact-owner terminal retirement receipt and covered-scene
background correction remain uncompiled; coordinator consumption still required.
Rust host retry17697 compiled,4/6 passed: exposed real Root witness unknown-field
decode bug (fixe0704c2f), and invalid oversized fixture (worker correcting to
bounded components while retaining actual >1MiB reply assertion). Portable2
tests rerun in27292, then host corrective run; worker retains exclusive slot.
Root independent review assigned fcdb2a78/e0704c2f before integration. No failed
host check is treated as acceptance; main runtime unchanged since import library.

00:19UTC: core authority focused checks11/11 passed (parent2, Store authority7,
compact summary2), logs /private/tmp/native-menu-wire-{parent,authority,summary}.log.
Compile fixfcdb2a78 reexports types through existing Store dependency, no manifest
change; host retry remains with exclusive Rust worker. d809 terminal retirement
receipt proposal ACKed msg_f2cac98dc7cf: exact container/owner/session close fact
distinct from navigation permission; failure without proof retains reservation.
Scene observer correction and coordinator consumption require source review.
Share fixtures57d98193 preserved unregistered/unrun; no extra test-target work.

00:18UTC followup: NativePages-only correction batch4a1e1381+6b67a887+09734eb4
atop5adb source-ready; independent117 review requested msg_a839409c4848. Requires
atomic core/wire, no legacy unguarded Move fallback; not compiled/native verified.
Host Rust session29195 terminal101 before tests: native reexports file-sync
without declared Cargo dependency. Worker coordinates narrow fix with base_reuse
and continues independent11 core checks serially, retaining compiler slot.

00:18UTC: native coordinator draft review msg_2c163f17af15 blocks composition
at SHA7ac8685389cb71233b774bd6750ebe74e91acb0d4426d69d4cd53bf093273df2:
activation quarantine must survive malformed/stale results; source needs explicit
role/tab/document witness; metadata persistence failure needs gated retry; recovery
controls must be executable; scene epoch and UIKit transition/pop ownership must
be guarded. Relayed native owner msg_2e26bf1ee3d0; source correction only, no build.
Rust menu worker owns compiler session29195, host focused checks in progress,
log /private/tmp/native-menu-wire-host.log. No terminal result yet.

00:17UTC: actual frozen527 two-file iOS frontend57718 terminal0, empty diagnostics;
Swift5 arm64 iOS15 Simulator target, SDK26.2 and cached Sim9 modulecache. No
project/build/runtime proof; successor883d and coordinator excluded. Native owner
explicitly returned slot; stage4_native_consumer now owns exclusive bounded Rust
core/menu-wire focused checks in native-menu-wire, no overlapping native compiler.
Independent root review confirms5742 background-after-actual-close returns a
generic failure indistinguishable from retryable live source. Composition held
until exact-owner terminal retirement and foreground navigation are distinct.

00:16UTC: d809 froze NativeMobile-only tab seams5742f382; root independent
source review assigned against reachable Git objects. Requires371's exact
recordNoteOpened(path:entryId:isCurrent:onValidated:completion:) fresh-listing
witness, guards before/after callback and the frozen NativeTabDocument fields.
Dependency relayed via msg_7704fa11daad. No standalone Swift compile/runtime
claim; Python assertions are source/model evidence only. Existing native owner
frozen527 frontend slot unchanged; no additional compiler grant.

00:15UTC: main d1ceed0a integrates the reviewed native staged-import library/ABI
from d9836528. All six integrated source files compare exactly with the tested
candidate. Corrected host module50497 exit 0,10/10; ABI63416 exit 0,5/5; logs
tmp/native-import-host-fixed-test.log and tmp/native-import-abi-test.log. Earlier
authorization collision failure is fixed by querying the same durable stage
after authorization error; no uncertain outcome allocates replacement identity.
This is library verification, not Swift provider/import UI acceptance.

Native owner has exclusive frozen527fe77e two-file Swift frontend typecheck slot
via msg_d0a63534c94f; no Xcode/Rust/assets/install authorized by that slot. Host
menu wire44497c7f and core12933f3c independently source-approved, focused tests
await slot return. Tab successor9ecedf6f+873b4989 independently source-approved;
prepared successor harness remains unrun. Native owner owns new coordinator and
minimal catalog/picker hooks after bd57 reconciliation, preserving Pages371,
container/plugin d809 and import/session bd57 scopes. Source work remains isolated.

00:10UTC source checkpoint: import runtime boundary fix5a226480 independently
reviewed, targeted reproduction101→fixed58276exit 0/1pass. Root composed only fix
as d9836528 in native-import-integration; no duplicate dependency change. Host
module rerun awaits native two-file frontend check slot return, not main yet.
Atomic menu authority12933f3c independently source-approved, uncompiled; composed
as3e88c1da in native-menu-wire. stage4_native_consumer owns only hostfamily/narrow
lib wire endpoints file_command_compact/status, strict leases and bounded original
root status. Exact snake_case wire frozen to371; UI retains full selected parent
witness and same operation journal. No new compiler or schema by source workers.

Tab source integration grants:2f owns only model active-document binding/Home
replacement and overview busy/error callbacks;371 Pages header/FAB/new-tab/read
drain;d809 NativeMobile editor close/snapshot/current validation; native owner
assigns single root/catalog coordinator hunk owner after bd57 reconciliation and
owns minimal five Swift project registrations. No JS/Rust/entitlement/CI changes.
New-note unknown outcomes never auto-create another file; metadata retry retains
the live editor. Existing two-file527fe77e remains frozen during its typecheck.

00:06UTC resource checkpoint: actual-source tab model harness42964 compiled/ran
terminal0 PASS207 assertions for exact5824bbfe; log tmp/native-tabs-model-harness.log.
This is model/metadata/persistence proof only, no SwiftUI or editor lease proof.
Verified861 idle despite queued failure mail; one explicit prompt22a4c192 actually
started its import collision fix turn.861 owns exclusive single targeted host
reproduction/fix test slot, existing rootdependencyb21 cherry-pick authorized.
Native two-file cached Swift frontend typecheck527fe77e requestmsg26599770b5fb
is queued next, not yet granted. No parallel root/native compiler.

Canonical update00:03UTC: main60ffc972 integrates source-identical3288 native9
Settings/search/minimum-one and caret batch. Independent review, fulltsc99639exit 0,
focused66/66 tests55162 pass. Actual Simulator8/9 evidence and phoneDev9 repeated
install/launch65171both0 recorded docs/history/native-mobile-integration.md. Caret pixel/
dragUI gaps remain; no menus/import/loader/tabs included. Root checks terminal,
no compiler live; tab harness requires ready-source exactpath/fresh slot ACK.

Import verification00:00UTC: root5fc59cae compiled officialRust1.95 locked/offline.
Host49920 terminal101,9/10 pass: known-name binary collision test returned
import_storage/commit_uncertain at staged_import_step;861 investigating source.
ABI63416 terminal0,5/5 pass (FD ownership, strict errors, leases and panic fencing).
Logs tmp/native-import-{host,abi}-test.log. No import/main or native UI acceptance.
Root returned heavy slot for native owner's bounded tab-model Foundation harness;
targeted host correction rerun follows only after explicit slot return.

Native menu authority implementation assigned stage4_base_reuse in isolated
tingkai-c/native-menu-authority, proposal /private/tmp/native-menu-authority-proposal.md:
optional exact destination-parent witness in whole FamilyCommand, atomic Store/
native apply and compact original operation status. No schema/core Mutation or
host/mobile/Swift changes by that worker;861 retains Duplicatehost/FFI, rootowns
later hostwire. stage4_markdown_contracts independently reviews. Taskmodel held.
Native9 confirmed source batch composed source-identical3288 in isolated
tingkai-c/native9-integration HEADe2d8d2fc; source review/typecheck pending, notmain.

Resource update23:56UTC: native owner returned exclusive heavy slot. Frozen3288c1bb
Simulator9 passes actual final Remove-disabled check; signed phoneDev9 build63961
and install 75081 exit 0, strict signature/version checks pass. Launch failed only
because device was locked, not an app crash; native owner may retry launch without
rebuild. Root now owns heavy slot for isolated import5fc59cae host10→ABI5 focused
checks, official Rust1.95 -j1/offline/locked, existing stage4-verified cache.
Host test session49920 active, log tmp/native-import-host-test.log; no mobile
compiler/Simulator build may overlap until root explicitly returns slot.

Native resource update23:48UTC: build8 app/helper cleanup confirmed, phone8 skipped.
Granted continued exclusive Simulator9→signed phoneDev9 slot to native owner for
frozen3288c1bb (95df87fa + reviewed minimum-one navigation only). Actual8 Settings,
Rust search/open/return pass; no-typing caret pixel acceptance remains unverified,
later capture was contaminated by typing. Menu/import/loading/tabs remain outside9.
Root import candidate5fc59cae checks wait for explicit slot return; no root heavy
job or shared dependency-tree mutation while native owner holds the slot.

Historical design/discussion checkpoint (implementation hold superseded by the
managed-data lead's user-authorized Phase0/1 plan; see current top checkpoint and
managed-data-tasks-calendar-plan.md): ordinary Markdown records
reference configurable vault type definitions; task behavior is an optional type
capability mapping status categories/planned day/deadline/recurrence/reminders.
Checkboxes stay separate with explicit conversion. Bases select records and hold
multiple views/creation defaults; built-in Tasks/Calendar reuse the same system.
At that time the user said "let's discuss", pausing implementation and holding
isolated candidates. The later coordinated managed-data track may now proceed;
those old checkbox/tag candidates remain superseded. Resolve storage
and stable type/property/option identity, then recurrence/calendar connection
ownership before resuming. Native UX/import work remains separately owned.

Native build8 slot granted via msg86316aed4280 at23:32 UTC for frozen reviewed
95df87fa (search/Settings/navigation and caret). Native owner exclusively runs
serialized Simulator then phone Dev verification; no imports/menu changes in8.
Root Rust task fixture run53258 already terminal0 (6/6 for superseded isolated
model, not integrated). Process observation found no competing actual compiler;
6.3GiB disk available. Root must not start heavy checks or mutate shared dependency
trees until native owner returns this slot. Build8 outcomes remain pending.

Native import source checkpoint23:44UTC: independent117 accepted exact
8c94529d→708012df→c62bc79b→cc3e7721 (terminal text collision recovery fixed).
Root composed source in isolated tingkai-c/native-import-integration, HEADb21d18d9,
with existing sha2=0.11.0 promoted to production and standalone mobile lock edge
added. No new package versions/schema, no main runtime integration, no compiler
or host10/ABI4 test execution yet; native slot remains owned by mobile session.
Minimum-one navigation source c1faeda1 reviewed but actual build9 pending.
Native document tabs source-only new-file scope acknowledged after user answers;
existing editor/session lifecycle wiring requires a concrete ownership proposal.

Latest Vite completion — main165cf17a +manager-lock60efe609:
- Vite is the default application renderer build. Actual dev/prod browser, desktop
  file renderer/save/math/code,307exactvendorassets,347fileASAR/nativearm64 and
  actual iOS build7 create/save99bytes/reopen/math/Prism/PDF2pages all pass.
  Final main frozeninstall0/fulltsc0/73affectedchecks pass. First main install
  required byte-exact original pnpm12.14 manager-lockdoc restoration; application
  dependency resolutions unchanged, independently reviewed. Main cache activation
  uses existing source/artifact fingerprint validation. Source/evidence:
  docs/history/vite-migration.md, tmp/vite-main-*.log, native msg67c02132f86d.
- Phone7 EXACTce1e0ace build91966 passed; strict signing/development metadata
  passed and physical iPhone install/launch12016 both exited0. Native owner returned
  the exclusive heavy slot in msg5e815eb955cf. Keyboard interaction acceptance,
  search and new Settings remain separate; those new screens are not in build7.
- Historical next-milestone proposal was Bases/tasks/calendar, then Stage5.
  Its assumed combined checkbox/task model is superseded: checkboxes are separate,
  task behavior belongs to configurable note types, and work blocks/time entries
  use managed records. Follow managed-data-tasks-calendar-plan.md and current
  coordinated ownership; do not revive the old aggregate task implementation.


Current Vite checkpoint — candidate103428be (not main default yet):
- Root isolated vite-renderer-migration composes independently reviewed native
 9c35d6d7/source829cd2c9 with Vite8.3.4. Final source/config and native-preservation
  reviews pass; fulltsc0 and272 focused consumers pass,34 build/worker/CSP/assets/
  packaging checks +2 dev MIME/Rust invalidation checks pass. Frozen install0.
- Actual Electron file renderer startup/edit/math/code/save passes, raw146 bytes
  confirmed, app37382 closed0. Actual production browser create/rename/save/reload
  and dev create/save/reload pass; math and actual Prism tokens observed, no
  observed errors/warnings. Both test tabs closed; servers stopped130. Unchanged
  Stage4WASM accepted only after existing source/artifact fingerprint validation.
- Real Vite native build91739 succeeded; staging then hit missing license texts
  in new protobuf/Connect distributions, assigned scoped pinned-notice source fix
  to vite-desktop-staging worker. Guard remains strict. Official pinned Electron
  runtime installed/verified in isolated dependency tree. No release claim.
- Native owner may merge103428be into reviewedcc13 focus/silent-refresh candidate
  for ONE simulator7 +phone7 build after composed review/typecheck, under grant
  msg177a2c088479. This supersedes baseline-only build instruction. Native owns
  exclusive heavy slot; root source/notices work only, no compiler/app/server.
  Search remains isolated until independent117 review fixes pass.
- Root source902bd190 adds only acceptance docs and generic mobile:sync native
  renderer command beyond frozen103; no renderer/native runtime change.


Latest user sequence correction — 2026-10-17:
- Complete the active Vite migration first, then build the Bases/tasks/calendar
  product milestone BEFORE Stage5. This supersedes the immediately preceding
  Vite→Stage5 sequence and older task/calendar discussion-only deferral.
- Shared Rust Base parsing/query/index semantics are already accepted Stage4;
  this new milestone concerns usable first-party Bases, task and calendar
  workflows on that foundation. Use earlier FullCalendar/TaskNotes references
  as capability input, prioritize Zorid UX, and settle bounded behavior/contracts
  before parallel implementation. No speculative plugin framework is needed.
- Native mobile improvements continue independently under its named owner.
  Preparation/dependency map: docs/bases-tasks-calendar-plan.md.
  Stage5 enrollment/history/backups/management remain required, resequenced rather
  than dropped. Built-in active goal text predates this correction; this durable
  checkpoint is authoritative for execution order after Vite.


Latest execution steering — Vite then Stage5 (2026-10-17 22:41 UTC):
- User authorizes Vite renderer migration now; Stage5 follows it. New built-in
  goal tracks both in this order. Mobile owner continues UX improvements in
  parallel; P2P remains deferred. Root owns manifests/locks/root config/assets/
  packaging, isolated tingkai-c/vite-renderer-migration from4cdafd33. Independent
  asset slice vite-asset-pipeline and source/packaging reviews proceed separately.
- Preserve build dist/index.html and relative native assets, native marker
  routing, automatic validated browser Rust/WASM and independent native core.
  Keep Electron main/preload/Rust build authority separate from renderer bundler.
  Required acceptance: dev/production browser +worker/WASM, nativefile renderer/
  packaging and coordinated iOS asset loading. No default change before checks.
- Native phone6 built52508/installed+launched24342 exit 0 on frozen829cd2c9.
  Detailed UI checks ongoing, no compiler live at last report. Root requested
  slot release before heavy Vite proof. Native owns title→body keyboard-bounce
  finding msg5dc07b64e4ef and mobile-specific source; root avoids focus edits.


Latest checkpoint — 2026-10-17 22:25 UTC (supersedes older pending statuses):
- Stage4 accepted and committed main2604057b; built-in Stage4 goal complete.
  Root test apps/servers/compilers are stopped. Native owner received canonical
  commit and next exclusive native validation slot in msg657bb7e41ced; it must
  announce exact handles and return the slot after terminal. No mobile parity
  claim; next work is the separately owned mobile reconciliation/build.
- Root final Stage4 consumer candidate701e107f now cleanly merged into main
  with final independent acceptance approved. Actual final native Base20/facade7/host13,
  strict CJS/native/CLI fixture1 and actual browser WASM Markdown49+4 checks,
  Base54+10 checks+2 context witnesses pass. No Rust delta after99464a78.
- Normal browser Table/Board/List/Cards, typed groups/date/link/current context,
  property save/reload and shared search/navigation pass. Rebuilt desktop Table/
  Board/property save exact63 physical bytes/sharedsearch2/navigation pass. Desktop
  initially caught undefined optional scalar IPC mismatch; reviewed701e fixes
  request construction, retains strict decoder. Test Electron59332 closed exit 0.
- Main full TypeScript exits0;92 focused consumer tests pass. Functional source
  matches verified candidate (only main's newer docs and trailing whitespace
  differ). Details/evidence: docs/shared-document-semantics-plan.md. No full-repo,
  mobile parity, measured performance or production security claim.
- Mobile source f7d78f6d combines reviewed FFI/Swift/adapter/perf/presentation;
  owner reports240 focused tests +typecheck0. Actual FFI75210/10 accepted, source
  blobs unchanged in combined branch. Separate signed Dev phone build5/51 source
  installed80513 exit 0 and launched0; simulator keyboard toolbar/PDF2pages and
  navigation/save observed. Final Stage4 mobile linkage/phone UI remain unproved.
- Native owner retains ordinary durable identitybbf despite runtime rebind;
  root replied msg09f79ae8d517 and acknowledged deliveryaa3e8e53a9b5. No duplicate
  worker. Native source-only work may continue; root must announce canonical
  consumer commit before granting next native build. Main remains sole root-owned.


Current update — 2026-10-17 21:31 UTC (supersedes older pending statuses):
- Subsequent21:43 checkpoint: native-only fixturehost bbe26f1d passed actual
  nine-case check54202 (compile1m48s/test0.71s), source integrated maind94c3ae3.
  Log copied to tmp/stage4-host-fixture-run1.log. This does not prove successful
  relay/FFI/simulator/phone sync. Root reclaimed compiler slot, no compiler live
  while current Base group-token source freezes; mobile owns no active Xcode.
- Current isolated root candidatee97d5bf9 composes Base context+frame-error/null
  guards, search+released-owner fix, typed-date display, retained-row edit witness
  +provider atomic rename and deferred pin-close handling. Combined frontend
  check1925 passes91/91, full TypeScript79631 exit 0 (before final pin follow-up).
  Reviewer source gates pass for these slices. Last presentation gap: Kanban loose
  equality merged distinct Rust keys; contract owner adds opaque existing-canonical
  keyId fields, Base owner projects them, renderer owner uses them through moves/
  hide/order and fixes inert nested file/link labels. No TS formula regrouping.
- Native owner may merge current canonicalmain863 into isolated recovery only
  under named resolution grantmsg_e4d21dcde2bd, preserving Stage4 guards/capabilities
  and scoped native hooks. Main remains root-owned. Its phonebuild5 is signed
  ready but uninstalled until actual CoreDevice connectivity; simulator hotfix
  proof and separate outstanding keyboard/PDF presentation are recorded in findings.
- Subsequent21:36 checkpoint: native facade21944 exit 0, all6 tests PASS,
  including explicit external import and authenticated sync receive with exact
  bytes, metadata/search/backlink retarget, old-pin coherence, rebuild equivalence
  and no authored receive echo. Reviewed tests29bdb786 integrated mainecd52a4f.
  Native hotfix simulator51d8b84f/build5 now verifies actual open/Back/Forward/type
  and exact67-byte save without UIKit crash. Phone87290 stopped before compile
  because destination unavailable; native checks connection/generic build. Root
  returned brief Rust slot in msg_e7b43ac5d754; no root compiler currently live.
- Remaining consumer candidate: Base context/options e224f491 plus controller
  b067f8b3/datec13ff75d/late-pin97a63eff composed isolated. Focused TS passes;
  native/WASM proof pending. Independent review caught a shared `stale-source`
  diagnostic incompatible with desktop frame error spelling; contract owner fixes
  mapping without relaxing framing. Shared-row mutation identity freshness is
  under source audit; do not integrate controller until resolved. Search57dafece
  source frozen,16 focused tests/typecheck pass, independent review pending.
- Reviewed engine39a306e7 composed into main without source conflicts. Normal
  browser backlink removal also PASS. Main full frontend typecheck7046 exit 0,
  focused document/browser/desktop/backlink/workspace tests24094 PASS 48/48.
  No Rust engine changes since recorded native/WASM proof. Final merge commit
  records these gates; remaining search/Base migrations keep Stage4 active.
- Candidate39a306e7 actual production browser/IDB full suite PASS18.235s, then
  page-reload cache PASS, watermark12/rawBytesPreserved:true. Actual WASM
  Markdown49/49 and Base51/51 remain verified with matching binary provenance.
- Normal rebuilt Electron UI PASS: shared backlink shown, Source navigation,
  editor save removes backlink; independent physical Source exact42 bytes.
  App8635 exited0 and closed. Normal web bundle87821 exit 0, server52415(port8767):
  create/rename/normal save/shared backlink/navigation and reload restored source
  pass; final backlink removal after edit also passes. Earlier closed-worker under resource
  pressure did not recur after reload; root cause is not established.
- Independent review approved staged integration but identified remaining normal
  sidebar search and Base controller TS evaluation. Assigned isolated workers
  stage4_native_consumer(search) and stage4_base_reuse(Base controller), with
  stage4_contract_review owning missing retained current-entry/step-limit options.
  stage4_native_index strengthens external-import and received-sync index tests.
  No worker may mutate main; current caches/logs remain preserved.
- Native build4 opening crash is independently reproduced (UIKit hosting-controller
  containment). Native owns hotfix51d8b84f/build5, slotmsg_d40cc87b1ea0. Initial
  simulator build71295 failed linking ENOSPC; native recovered space by cleaning
  only its own regenerable dependency caches. Retry50983 live; simulator actual
  file-open verification must precede phone update. Build4 is unaccepted.
- Reviewed mobile fixture-sync plan dc2a6c1b granted in msg_7efc3aa3b3cf to named
  term_86199dce-0f1c-45f0-9ca0-8942cba829c5, acknowledgedmsg_58ee54c32890:
  isolated tingkai-c/mobile-host-fixture-sync based39a306e7, only hostlib minimal
  field/module/export and new embedded_fixture_sync source/test. Existing-vault
  binding before initialization, same admitted lease, no renderer sync access,
  bounded redacted native DTOs; no Rust tests before hotfix terminal checkpoint.
  Simulator-only fixture; no phone remote-sync or production enrollment claim.


Current authoritative update — 2026-10-17 20:42 UTC. The bullets below
this update are historical checkpoints where their status differs:
- Browser publication defect is now identified and fixed: order-sensitive JSON
  string equality rejected equivalent source/Rust DTOs whose object fields were
  serialized in different orders. Diagnostic cf8f8ed6 + guarded retryb64de88d
  observed index_capture_descriptor/sameEntry:false on the original6 entries.
  Strict structural comparator03b0b6b4 (root0d35e292) ignores object key order
  only; exact fields, values, types and array order remain checked. Independent
  source review approved; host21/21 tests pass. Actual same-database retry now
  publishes successfully, source watermark6/currenttrue, all6 entries present,
  rawBytesPreserved:true. No source reset or relaxed validation.
- Full fresh browser suite advanced through metadata/graph/Base/24 literal pages
  and reached retained edits. It then exposed fixture-only invalid YAML Boolean
  filters:false; frozen compiler requires expression text or logical mapping.
  Base owner confirmed correctiona35ac698 to filters:"false" text; composed,
  awaiting next lightweight bundle/full run. Preserve failed suite database
  zorid-core-vault:document-index-28dd0a09-e973-4fa2-91f4-220d08c3b8da.
  Current server40946(port8766) serves tmp/stage4-browser-index-app-fixed,
  source0d35e292; root Chrome tab1268039028 is marked for continuation.
  Old corpus server22178 stopped after downloaded reports; no Rust/Electron
  process live. Full frontend tsc18913 exit 0; desktop app webpack70127 exit 0,
  but normal desktop UI has not yet run. Temporary node_modules symlink removed.
- New actual browser evidence: WASM63741 exit 0 (official1.95, release/j1,
  2m35s). BinarySHA2566c67442d272195269eb2d92e723c3fc8fd92e237c33c9368e046a92134903256.
  Chrome real-worker Markdown49/49 +4 malformed checks PASS, downloaded actual
  results independently pass verify.mjs. Real-worker Base51/51 +5 request checks
  PASS after explicit missing-graph unavailable fixture decisionf76fa1bf
  (root88a5ee9f); historical TS unsupported observation preserved. No engine
  change or WASM rebuild for that fixture correction. Reports/results retained
  tmp/stage4-browser-document-{report,results}.json and
  tmp/stage4-browser-base-{report,results}-run2.json; failed run1 retained too.
- Current native query 12117 passes3 tests including all10 accepted queries and
  resource/missing-witness/YAML checks. Current portable index18432 passes
  contracts7, generations15, metadata restore2 (tmp/stage4-index-run3.log).
- Actual production worker/IndexedDB harness does NOT yet pass: browser
  database zorid-core-vault:document-index-94d2dfce-0645-4e09-9a8e-b7c4dbe6fb9c
  failed during Rust generation publication with storage_corrupt / could not
  refresh committed state. Report tmp/stage4-browser-index-actual-run1.json.
  Browser owner is diagnosing; independent reviewer checks source/control
  validation. Preserve database/failure evidence; no resets, weakening source
  validation, or passing corpus results substituted for persistence proof.
  Bundle tmp/stage4-browser-index-app-d89dbd56 uses exact content-addressed pair.
  Local fixture servers22178(port8765) and48874(port8766) remain live; root Chrome
  tab1268039028 holds failing harness. No Rust compiler live at this checkpoint.
- Actual desktop transport now passes: run33242 exit 0 in1.86s with freshly
  built CLI `target/stage4-verified/debug/zorid` and desktop host; log
  tmp/stage4-desktop-actual-run3.log. Earlier run2 reached Base then failed a
  fixture assertion: column IDs use literal dotted property names. Fixture-only
  4e7e0b60 (rootd89dbd56) uses an explicit nested-member formula, independently
  confirmed by the Base owner. No evaluator or source-authority change.
- Browser storage/transport unit20/20 and focused production TS check pass at
  a81de486 (160 transitive files,118MiB compiler memory), log
  tmp/stage4-browser-index-focused-ts-run1.log. These are not real WASM evidence.
  First actual WASM build63741 is LIVE, official Rust1.95/pinnedbindgen0.2.129,
  offline/j1, candidate frozen d89dbd56; log tmp/stage4-wasm-build-run1.log.
  Allowlisted corpus/worker assets staged in tmp/stage4-browser-proof-a81de486,
  generated WASM not yet copied. Preserve process until terminal; native ACK
  phone compile15167 and install/launch50642 both terminal0, UI checks only.
  Native retains owned simulator booted per user; full Rust/Xcode load coordinated.
- Latest user resource policy supersedes blanket check slots: explicit slots
  only for iOS build/simulator; bounded desktop/frontend checks proceed without
  per-check approval. Full Rust/Xcode still coordinate actual8GB load. Recorded
  in AGENTS.md from native relaymsg_e825ad204547. Native ACKmsg_80f4472a25a9
  owns iOS slot now; root has no live Rust job and defers fullRust/WASM until
  compile terminal. Bounded Node/CJS work may continue.
- New actual candidatea81de486 evidence: native enrolled reconciliation57303
  passes1/1 (remaining four facade cases passed run2); CLI 34144 passes3 indexed
  documents+4 metadata subprocess cases, including moves/deletes/rebuild and
  raw-source preservation. Logs tmp/stage4-native-documents-run3.log and
  tmp/stage4-cli-documents-run1.log. Desktop host31416 compiles and clock3/3
  passes (tmp/stage4-host-clock-run1.log). Real host child fixture still pending.
- Focused frontend candidate checks pass3/3 maintenance/default probes with
  strict shared-service/desktop-adapter TS0 diagnostics (owner report). Root
  CJS protocol4/4 and desktop adapter3/3 pass, logs
  tmp/stage4-desktop-protocol-run1.log and stage4-desktop-adapter-run1.log.
  These controlled transports are not substitutes for actual Rust child proof.
- Workspace backlink hook9f259800 is now committed on the isolated candidate;
  actual Node/JSDOM run2 passed4/4 in0.77s, covering post-save pane/replaced-ID
  cancellation, valid navigation after save, and blank-tab pin retirement.
  Log tmp/stage4-workspace-backlinks-run2.log. This is controlled service/DOM
  evidence, not actual desktop/browser Rust transport or visual app proof.
- Source review caught Base defaults diverging across hosts (desktop epoch clock
  and1000 rows versus browser invocation clock and10000 rows). Shared frontend
 06cbfb7f and direct browserd62e2b60 align current-clock/1000-row defaults;
  explicit values remain explicit. Direct desktop clock correction is owned by
  stage4_markdown_contracts. Shared lost-publication-ACK helper2cdfd9ba and
  focused probes are composed; owner probes passed2/2, integrated retry pending.
- Native acknowledged exclusive slot ownershipmsg_fbdde0270743. It granted only
  the bounded workspace Node passmsg_a3b456455733; root returned that slot after
  terminal results in msg_238a603ec463. No root heavy job is live. Native owns
  editor-only recovery/error visibility plus keyboard accessory verification.
- Subsequent root checks: Base graph corpus44023 passed2/2 after the fixture
  correction (tmp/stage4-base-generation-run4.log); changed Store discard6800
  passed1/1 (tmp/stage4-store-discard-run4.log). Native retry57384 compiled and
  passed4/5; external reconciliation fixture lacked required enrollment. Fixture
  correction8619664e is composed but not executed. No authority checks relaxed.
- Root released the heavy slot to native in msg_653a697e7e30; no root heavy
  process remains live. Await explicit native release before new heavy checks.
  Isolated candidatebc374d91 includes reviewed browser discard/pruning fixes
  through e4b68158 and desktop preservation fixture2545c70b; actual browser/
  host proof remains pending. Root workspace hook is still isolated/uncommitted.
- Native owner reports successful physical iPhone build39896, install80894 and
  launch63110; simulator flow independently read the exact43 saved body bytes
  after create/rename/back/reopen. This verifies that bounded flow, not complete
  mobile UX. User now requests editor-content-only embedding, native bottom tabs
  and a glass keyboard accessory. Native owns those isolated changes plus the
  exact dedicated CSS import in src/main.ts (ACK msg_a71de90a3ac7).
- Native released the heavy slot in msg_5233e992aee5; root acquired it in
  msg_f81617bee619. Root facade check73261 has exited101: Store document index
  types lack root re-exports required by the native facade. Store owner is fixing
  only that wiring. No heavy process is live at this checkpoint; root retains
  the short slot for the focused retry pending native readiness notification.
- Actual Store run98013 passed19/19 (tmp/stage4-store-index-run3.log).
  Later published-stage discard no-op correction61b5d6e1 is composed and needs
  only its changed focused case rerun. Actual engine run39411 stopped at three
  Base graph fixture mismatches; input/oracle correctionf2893726 and explicit
  selected-cell runner06e2dc5b are composed, awaiting runtime retry. Earlier
  passing index proof does not cover the later controlled callback changes.
- Root isolated candidate f21facb4 includes desktop RPC/shared service and normal
  platform capability wiring, browser durable-index harness, plus new workspace
  backlink testsced0ec23. Root workspace hook remains uncommitted in that isolated
  worktree pending focused execution. Stage4 runtime source is not on main.
  Actual WASM parity, production browser harness, real host/CJS transport and
  normal app backlink integration remain required; source review is not proof.
- Disk recovery removed only old generated root target/debug deps/build/
  .fingerprint (~148MiB). Current Stage4 cache, shared Rust toolchain, binaries
  and logs were preserved. Native separately removed its own761MiB cache.

Historical preceding updates:
- Root candidate checkpoint54d2123d in stage4-integrated-engine is clean and
  includes the browser index module wiring. Next after native release: actual
  Store17 retry for906956ec; recheck changed controlled-index/Base APIs; native
  facade five cases and CLI metadata/documents subprocess cases; then build and
  execute actual WASM corpora and durable browser harness. Do not repeat unchanged
  component suites unless new changes/failures justify them. Desktop RPC/shared
  frontend source is still being authored; main runtime integration remains
  pending, not implied by source approval or candidate composition.
- Current resource priority: user plugged in a physical iPhone and explicitly
  wants to try the app now. Root released all heavy work in msg_486119a46d6d /
  msg_6b654f918bbd. Native owns TypeScript/webpack/Xcode/device-install slot;
  confirmed live8510 in tmp/mobile-simulator-app-build.log. Full tsc54737 and
  webpack/capcopy passed; no app/device UX proof yet. Root must not launch new
  builds until explicit release. Existing offline development signing is ready
  per native owner; separate app.zorid.notes.dev preserves other app data.
- New actual Stage4 proof: index64419 exited0 at e8615ecb, contracts7/7,
  generations14/14 and metadata restore2/2 including all49 canonical cases and
  relationship coverage pagination (tmp/stage4-index-run2.log). First run66659
  failed only test compilation; typed JSON assignment fixeda9936a34. Store
  first run63038 also failed only test compilation, corrected14755018. Actual
  run81126 then passed16/17 checks (tmp/stage4-store-index-run2.log); remaining
  draft-preservation test failed before index setup because its checkpoint
  revision was not a canonical UUID. Fixture-only906956ec preserves the opaque
  draft payload and fixes that ID; actual retry remains pending phone priority.
- Isolated composition now includes reviewed native facade242e1a74/8b0afefc,
  CLI indexed commands ab8bbf0e/2fd6ae71, Base graph factory throughafc5c7fb,
  index controlled graph/resolver4c6c405e/89529d21 and browser durable index
  b48dab11/ad686a3d/2d9aceb1. New controlled APIs/Base factory/browser source
  require actual compilation and native/WASM parity; earlier engine passes do
  not verify these later deltas. Root owns WASM module/manifest/lock wiring.
- Desktop transport ownership granted to stage4_markdown_contracts: new host
  documents.rs and minimal extracted lib.rs dispatch, new CJS protocol and
  narrow admitted service routing. Mobile ACK msg_de4f40608f1f preserves host
  main/FFI/cfg/admission boundaries. Typed semantic JSON uses bounded raw body,
  avoiding serde_json::Value sorting recursive YAML maps. Host extraction
  edcbc8b/3fae504/7932b4b/736cc823 is separately queued mobile batch, not yet
  integrated into root/main. Shared frontend capability/adapters assigned to
  stage4_contract_review; normal browser/desktop UI semantic consumers remain
  incomplete. Workspace/platform activation seams frozen aff0665c by mobile;
  new edits still require named coordination.
- Latest composition is fa4d4aaf in stage4-integrated-engine: portable index
  through6867ab9b/7c5876b6, CLI metadata dcdcff38, native Store through40109019
  plus reviewed corrupt-key/provenance/decode-bound fixes a0faa65f/7e4efc93/
  ca97529b. Lock7eddb413 adds unicode-normalization0.1.25 and tinyvec1.13.3
  without upgrading existing dependencies. Store/index/CLI runtime checks await
  release of mobile's confirmed live host opt1 handle22634; do not overlap it.
- Eight useful workers now include stage4_browser_index_host in isolated
  stage4-browser-index-host (new browser-document-index.ts/tests and WASM
  document_index.rs, narrowly owned factory/worker/runtime dispatch seams) and
  stage4_native_consumer in isolated stage4-native-consumer (new native
  document_api.rs/document_index.rs, minimal module/reexports/dependencies).
  Native owner acknowledged that wiring in msg_30db1a73c806; mobile retains
  iOS cfg/admission/filesystem/embedded-host ownership. A separate native
  semantic error wrapper preserves existing exhaustive Error consumers.
  Both adapters must use shared Rust engines and coherent retained generations;
  no JavaScript parser, duplicate resolver or current-body-as-old-snapshot path.
- Latest Stage4 verification supersedes the first-run failures below. Isolated
  candidate0ce5cd40 in stage4-integrated-engine includes metadata fixes5590df2,
  dac1f0c and59863af plus Base accepted fixture projection12e05248. Official
  Rust1.95 native run66340 passed ordered values5/5, bounds8/8, all49 shared
  Markdown cases and public YAML5/5 (tmp/stage4-parser-run3.log). Its final
  doctest invocation used the wrong ambient Rust1.99 rustdoc; scoped rerun70152
  with explicit matching RUSTDOC exited0. No metadata runtime failure remains
  in that candidate. Base run50383 exited0:30 accepted expressions,10 accepted
  queries, all focused budget/numeric/calendar/cancellation/source tests and
  ordering unit pass (tmp/stage4-base-run2.log). Actual WASM parity, durable
  indexes and CLI/web/desktop semantic consumers remain unverified.
- Root released the exclusive heavy slot to native mobile in durable reply
  msg_77abcb590bc5 after those terminal checks. Native owns the queued matching
  opt-level1 host regression, ABI/staticlib and web/Xcode/simulator sequence;
  report live handles and release before root Store/WASM verification. Mobile
  also owns the exact optional PlatformVault initialPath/noteOpened and existing
  workspace successful-activation hook, with stale-vault fences and nonfatal
  notification failures. Stage4 must not edit those shared seams until freeze.
- Useful parallel scopes are assigned to six workers: Base implementation,
  portable index implementation, WASM wrappers/harness, independent portable
  index review, independent native Store review and Store snapshot accessors.
  CLI metadata dcdcff38 is source-complete, not runtime-verified. Native cache
  source947e08ff..40109019 plus a0faa65f is under independent review; targeted
  tests are written but not executed. Validated shared relationship snapshots
  must derive from actual Rust generations; detached Base JSON rejects supplied
  graphs. A Rust-owned generation path is still required for real WASM graph
  parity; graph-less corpus wrappers do not complete that requirement.
- First Stage4 execution (2026-10-17 19:26Z onward): root owns the exclusive
  heavy slot after native release71034 exit101. Metadata compiled successfully
  on official Rust1.95 in17.72s. Run52242: ordered values5/5 and bounds6/7 pass;
  upstream scanner depth exhaustion was misclassified Syntax instead of Resource.
  Source067a2e8 corrects this without changing the depth oracle. Separate corpus
  run caught an omitted wiki embed. Updated actual run31770: values5/5, bounds7/7
  pass,44/46 corpus cases match; remaining cases are upstream greedy wiki-image
  parsing and collapsed-reference occurrence span excluding trailing[]. Root log
  tmp/stage4-parser-run2.log; metadata owner is preparing narrow parser-backed
  repairs, not regenerating expected results. Generic shared YAML mapping tests
  were not reached in that failing command. No Rust semantic code is on main yet.
- Current isolated candidate is0d2d9a6 in stage4-integrated-engine: includes
  metadata through067a2e8, shared YAML3c915e2, attributed noticesfa7ba7c, browser
  wrapper/harnessd42ab9d+c9a42aa, root WASM wiring50bd72e and Base source through
  e1f560c with locked dependencies. Actual Base proof55971 is the sole heavy
  handle; log tmp/stage4-base-run1.log. Root retains slot for short first proofs,
  will report release before another native job. No source migration/native app
  rollout/parity claim follows from source composition or baseline checks.
- Native progress: iOS simulator staticlib41020 built successfully in1m15s,
  compilation/link only. Affected host71034 terminal101:8/8 lib checks and13/15
  subprocess checks pass; failures are stale v1/no-transport fixture and a
  >16MiB stream watchdog under unoptimized test profile. Bounded actual startup
  probe independently confirms v1 credentials_invalid versus v2/grpc success.
  Mobile owns fixture-only tests/process.rs correction736cc82 and later matching
  opt-level1 focused rerun; production timeout/protocol/fallback stay unchanged.
  These failures are not accepted as verified extraction/runtime readiness.
- Native index persistence owner stage4_native_index uses isolated Orca
  stage4-native-index. Owns store/document_index.rs, its tests and minimal store
  lib/Cargo.toml wiring only; native/host/browser/CLI seams still separately owned.
  Approved exact registered optional derived SQL objects: source11 canonical
  objects/SQL remain mandatory; optional known SQL must match exactly if present,
  missing cache objects may rebuild explicitly, arbitrary prefixes/unknown objects
  remain rejected. Cache data errors are index RebuildRequired; no source repair,
  source/drop migration or parse inside write transaction. Portable index owner
  supplies validated persistence DTOs before host use. Source/publication CAS and
  retained text projection remain to implement/verify.
- Stage4 source checkpoint (supersedes earlier preparation-only paths below):
  main74b3f2f contains reviewed Markdown/index/Base contracts and shared corpus.
  Root baseline verification:42 Markdown source/range checks +42 recorded TS
  observations and47 Base TS cases pass; subsequent2963ae8 grows Markdown to44
  cases and fixes recursive map order plus semantic link destinations. This is
  specification/baseline evidence, not Rust/WASM execution. Public metadata API:
  zorid-document::{MetadataRequest,DocumentMetadata,PropertyValue,SourceRange,Link},
  parse_markdown(&MetadataRequest). PropertyValue retains recursively ordered
  ordinary JSON maps without enabling global serde_json preserve_order; Link
  keeps raw provenance plus parser-decoded semantic destination for resolution.
- Metadata source owner restored externally removed stage4-markdown-contracts
  into `/Users/ctk/orca/workspaces/Zorid/stage4-markdown-engine`, branch matching
  that name, based on9849ad1. No committed work was lost. Crate source12017c6,
  value05add61 and focused limits75add5c are uncompiled; root composed them in
  `/Users/ctk/orca/workspaces/Zorid/stage4-integrated-engine`, branch matching,
  candidate3c4d8c3 (root's earlier stage4-core-integration also disappeared).
  Its Cargo.lock adds9 reviewed packages only, no existing package upgrades.
  Exact parser pins: pulldown-cmark0.13.4/defaults off, saphyr-parser0.2.2/defaults
  off, regex1.13.1. Exact saphyr archive hash matches selected registry checksum.
  Independent reviewer owns value.rs only; metadata worker owns remaining crate.
- Index sourcec5efb66 and subsequent epoch/generation/query work remain isolated
  in stage4-index-contract. Snapshot identities include a fresh host-random epoch
  to prevent token ABA after disposable-cache rebuild. Pump1MiB is a soft batch
  target, allowing one document up to16MiB; do not silently exclude documents
  above1MiB. Initial derived-facts64MiB guard must fail explicitly/retain prior
  coherent generation without advancing coverage. Native/IDB persistence and
  consumer migration are still required, not established by portable plans.
- Base source3bb5e7f and review correctionsa4fda50 remain isolated; no compile or
  runtime reuse result yet. Pinned MDBASE evaluator is extracted with provenance,
  explicit clock/timezone and shared ordered PropertyValue input. Review found
  and owner is correcting swallowed errors, nonfinite values, date formatting/
  arithmetic and builtin allocation/work guards before its first proof. Full
  query reducer/consumer integration remain. All workers remain source-only
  until a serialized build grant; first metadata proof is queued next.
- Native-mobile recovered after its original checkout/toolchain disappeared:
  `/Users/ctk/orca/workspaces/Zorid/native-mobile-recovery`, matching branch;
  source backed up through1c0aa7f, not merge_ready. Root has issued no worktree
  removal/clean/reset commands. Mobile scope now includes the exact native
  selection branch in platform/index.ts and revised workspace.ts lifecycle hook:
  background flushes without destruction; switch flushes then acknowledges,
  restores editing on failure, and native host owns final closure. Earlier
  destroy-before-ACK proposal is rejected. No Stage4 worker edits these seams
  concurrently. Direct user approval here resolves the automatic-review blocker
  on mobile signing/TestFlight/CI: NEW mobile-ios workflow/mobile scripts/iOS
  project settings authorized via msg_0ed8b92052de; outcomes stay mobile-owned
  and outside Stage4 acceptance. No credentials belong in records/source/logs.
- Current heavy slot: native mobile's bounded staticlib simulator build and
  affected host checks only, acknowledged msg_f857cdf7e5ca/msg_98aa3916f1ee at
  19:20Z. No root compile is running. Mobile must report handle/result/release
  before Stage4 first parser proof; webpack/Xcode/simulator needs the next grant.
  Shared official Rust1.95 restored at canonical ignored
  tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin, explicit
  bin/cargo plus RUSTC needed. Official wasm-bindgen0.2.129 archive digest verified
  and binary --version passes at tmp/stage4-tools/wasm-bindgen; approved portable
  dependencies prefetched67204 exit 0 without building. Do not assume a recorded
  toolchain/worktree/process path still exists: revalidate before reuse.
- Stage4 is now explicitly authorized and active. First-goal acceptance is
  committed as f69dc90; new built-in goal covers all shared document semantics
  and actual native/WASM/CLI/web/desktop consumer parity. Main integration stays
  root-only. Independent native-mobile implementation runs alongside Stage4;
  it need not wait for document-query APIs to build its shell/storage/editor slice.
  Durable coordination inbox: `run:run_3e72b2c9ab72`; root terminal
  `term_2fbd0185-6f86-4649-824c-92faf46852f7`.
- Stage4 preparation owners (all based on f69dc90, no heavy build granted):
  Markdown contracts/corpus: stage4_markdown_contracts, Orca worktree
  `/Users/ctk/orca/workspaces/Zorid/stage4-markdown-contracts`, branch
  `tingkai-c/stage4-markdown-contracts`, owned docs/stage4-markdown-contract.md
  and tests/fixtures/document-semantics/markdown/**. Base reuse/contracts:
  stage4_base_reuse, worktree stage4-base-contract, matching branch, owned
  docs/stage4-base-contract.md and tests/fixtures/document-semantics/bases/**.
  Index/query contract: streaming_acceptance_sol, worktree stage4-index-contract,
  matching branch, owned docs/stage4-index-contract.md. Root freezes shared
  types/API boundaries and dependency locks before implementation assignments.
  Contracts/fixtures are preparation, not implementation or native/WASM parity.
- Native-mobile owner handshake acknowledged via msg_92b8e24a3e93 and
  msg_1c0e22320c5d: terminal term_bbf1787b-d2e5-402a-b366-24d40a2385c3,
  worktree `/Users/ctk/orca/workspaces/Zorid/native-mobile-ios`, branch
  `tingkai-c/native-mobile-ios`. Owns ios/**, mobile/** (independent mobile/rust
  staticlib workspace), src/platform/mobile-native.ts and mobile integration doc.
  Scoped shared ownership: desktop-host Cargo.toml/main.rs/new lib.rs to extract
  an in-process EmbeddedHost while preserving subprocess contracts; native
  Cargo.toml/lib.rs/client_admission.rs target guards and audited mobile syscall
  compatibility. Broader store/fs authority edits require exact-file agreement.
  Root retains platform/index.ts selection seam and root lockfiles; worker sends
  source-only seam proposal. Stage4 host semantic methods wait for extraction
  freeze; no duplicated mobile Markdown/Base/index engine.
- Heavy slot reserved to native-mobile for one bounded iOS feasibility pass,
  acknowledged start msg_065f67df919b: target installation then one-job cross
  compile, no simulator yet. Actual process handle/result remains to be reported;
  slot reservation is not proof of a live build or compilation success. Stage4
  workers remain source/lightweight only until explicit release/next grant.
- Integrated on main293df57: root merged independently reviewed combined
  candidate3a082b0 with a normal no-ff merge after source/lock closure review.
  Main-only divergence was documentation; the merge had no conflicts and no
  main-only source was displaced. Store schema11, normalized browser format7,
  bounded binary stages/pins, desktop protobuf frames, standalone CLI streams
  and explicit remote RPC2 are now source defaults. Existing development
  formats are rejected and retained; no real-vault migration or deployment ran.
  Main frozen offline pnpm install and main typecheck/desktop build7075 passed.
  Matching verified CLI/host binaries, rebuilt main renderer and WASM cache are
  published to main's ignored runnable artifacts, retaining existing hashed
  assets. target/debug/zorid-build-provenance.json records exact hashes/source;
  resource state for the subsequent actual-runtime pass is recorded below.
- Combined acceptance is now terminal and passing: Rust/WASM90716 passed43
  tests (including17 streaming checks); actual WASM69772 release built in31.95s;
  combined browser19973 passed97 Node checks; full TypeScript75293/76061/67743
  passed. Desktop host86481 passed its real >16MiB protobuf subprocess check
  in34.66s. CLI61291 passed the independent16MiB+17 stdin/file/raw/base64/retry
  process check in71.10s and current RPC encrypted backup/restore in2.43s.
  Test builds used one job, bounded test threads and command-only opt-level1.
- Actual normalized-v7 Chrome runtime caught two concrete issues before merge:
  first visible Text publication re-reserved an already durable witness revision;
  reviewed66bbc8c fixes it (27 focused checks and exact retained-DB rerun pass).
  Already committed exact wire echoes also repeated whole-file verification and
  publication; reviewed3a082b0 uses authenticated, strictly CAS-fenced cursor-only
  replay (31 checks). New updates retain full verification. On actual retained
  data, catch-up received64 then52 records and reported complete=true, without
  changing file identity/revision. Normal browser create/save/reload without any
  sync credentials passed; competing-tab edits retain the losing draft through
  reload, and Save recovery copy preserves it separately from the winning note.
- Actual17MiB+17 Chrome Blob import committed through bounded stages; browser
  uploaded140 encrypted records across bounded sweeps. Independent CLI received
  all140, with zero final pending authored/dependency/projection work; raw streamed
  output and physical disk exactly match the original17,825,809-byte hash. Normal
  rebuilt Electron saved 79 exact bytes through default Rust, read independently
  by CLI while host was open, discovered/opened an external file, and retained
  content after graceful quit/reopen. Both owned Electron passes exited0.
  See browser-relay-verification.md and native-progress-verification.md.
- Main4d3c12d closes the preceding three changed-path runtime gates. Actual
  Electron verification UI/private IPC/native host RPC2, fresh normalized-v7
  browser and independent CLI first shared one baseline. With the actual relay
  stopped (its socket refused connections), each appended independently and
  failed sync without losing its local edit. Restarting the same DB/server epoch
  converged all three to exact85 bytes, SHA256
  b3ae03939d06bfa6c8decbc24473d4d90b5ee0aaa614eb9fe53fcca263105496.
  Electron/CLI ended at cursor5 with all pending counts0; browser completed.
  This proves Electron-owned RPC transport, not a normal-editor sync UI or
  production enrollment. Original /private/tmp fixtures subsequently vanished;
  tmp/shared-core-final-1017/rpc-convergence-observed.json reconstructs observed
  tool outputs, rather than preserving those original databases or reports.
- Actual normal default Electron on main4d3c12d, with all fixture-selection
  environment variables unset, persisted an exact54-byte unsaved draft while
  the physical baseline remained24 bytes. Only verified owned app6746/host6780
  were SIGKILLed. Independent CLI then committed53 competing bytes without
  changing the draft checkpoint. Normal reopen displayed the retained54-byte
  draft; Save recovery copy preserved it as a distinct note and adopted the
  exact53-byte CLI original. Independent physical/checkpoint reads confirm both
  versions and a clean final checkpoint. Current report:
  tmp/shared-core-final-1017/crash-observation.json. Native normal-editor
  undo/redo/selection also passed in the current session.
- Actual normal-editor OS composition also passes: physical Zhuyin keystrokes
  produced marked phonetics and committed `你好`; undo removed the composed text
  and redo restored it. Independent CLI/physical reads and normal app restart
  preserve the exact 34-byte fixture (hash in native-progress-verification.md).
  Owned sessions50032/64810 exited0; no owned native test app remains running.
  First-milestone runtime gates are closed; final requirement audit is recorded
  in shared-core-milestone-acceptance.md. Preserve the distinction between locally
  retained draft, durable commit, server acceptance and encrypted backup.
  CLI's permanent legacy capability flags still mention larger_file_streaming;
  a source-only reporting suggestion was prepared, not applied. Preserve the
  documented synced:false no-global-barrier contract and desktop validator;
  removing the obsolete larger-file capability and exposing bounded snapshot
  completion are separate reporting follow-ups. The flag does not invalidate
  verified exact large-file transfer. Mobile, join UX and full history/admin
  stay later; P2P remains explicitly deferred from this pass.
- Continuation resources: earlier /private/tmp RPC fixtures and original reports
  vanished; do not assume those paths, credentials, relay/static handles or
  browser-tab markers remain usable. The reconstructed convergence observation
  is explicitly identified above. Current crash fixture/report live under ignored
  repo tmp/shared-core-final-1017: recovery-profile, recovery-vault and
  crash-observation.json. Nonsecret final observations are also retained under
  docs/verification/shared-core-final-2026-10-17.json. Native verification is
  complete and owned apps are closed. Revalidate processes before any later
  launch; no source change, new enrollment or real-vault migration ran.
- Latest combined checkpoint (2026-10-17): isolated
  `core-default-integration`, branch `tingkai-c/streaming-core-integration`, is
  now c2c9b91 after composing the independently reviewed browser source batch
  frozen at91c17d1. The prototype conflict retained both RPC2 configuration and
  lazy binary capability admission. Parent browser checks passed100 baseline
  and52 affected Node checks plus full TypeScript, including the prototype;
  these use test doubles and do not prove actual normalized browser runtime.
  Root's combined Rust/WASM library gate90716 is the sole active heavy handle.
  Browser WASM regeneration, real normalized-IDB streaming, host/CLI process
  checks, encrypted restore and rebuilt Electron remain before main integration.
- Native large-file gate47955 is terminal: staged restart/lost-open-ACK/pinned
  original-source case passed; compound external case hit its120-second soft
  scan budget, invalidating the fixture's single-pass expectation. Reviewed
  d69bb27 fixes only the fixture to resume bounded scans with durable progress
  and duplicate-receipt checks. Root rerun19553 PASSED the compound17MiB case
  in112.35s using command-only test opt-level1; production budgets unchanged.
  Store diagnostic follow-up abab33f (root9e97718) avoids rehashing sealed
  sources merely to query inert stage status; authority operations still verify
  actual bytes. Its targeted corruption/CAS gate77061 passed. No performance
  claim follows from these correctness results.
- Actual Chrome production RPC proof now passes for the preceding browser-v6
  storage engine: concurrent browser/independent-CLI text edits converge to the
  exact49-byte result, and a browser-uploaded262,163-byte binary reaches CLI and
  physical disk with identical SHA256. See browser-relay-verification.md. This
  supersedes the earlier computer-use connection blocker; it does not prove the
  new normalized-v7 browser engine. One post-interruption binary catch-up first
  returned sync_transport because the relay had stopped; process inspection
  confirmed absence, restarting the same DB/port completed the exact check.
  Own verification tab is closed; restarted relay60125 exited0 after Ctrl-C.
  No server deployment, real-vault migration or main transport switch occurred.
- User requests a persistent future-improvements list. See
  [future-improvements.md](future-improvements.md): bounded parallel indexing/scan
  work in the same Rust core, deferred P2P, server-push catch-up, stale-editor
  automatic merge after all stages, and later serialization evaluation. Other
  required roadmap milestones remain scheduled; this list does not remove them.
- Direct user approval (2026-10-17): after automatic approval review rejected
  selecting the new browser storage host as default before combined verification,
  the user quoted that rejection and replied "Approve". This authorizes the
  concrete default-host SOURCE wiring in the isolated browser implementation
  branch so its actual path can be compiled/tested. It supersedes the temporary
  source-gating workaround proposed solely to resolve that rejection. Do not ask
  again for this same source action. Main integration still follows scoped review
  and combined validation; this does not authorize deployment, real-vault schema
  migration or claims of browser runtime verification. Browser owner must retain
  rejected old-schema data and avoid automatic legacy fallback.
- Latest coupled gate update: Store source2921096/abf0bb4/7bd54e9 passes86
  library checks in19472 (one optional64MiB fixture ignored). Root isolated
  `streaming-core-integration` HEAD4dbd3f1 includes those fixes, native2700822,
  desktopd0bd974 and CLIb2c10ea/fb3008f/fcfabbc with existing sha2 dependency
  edges curated. Host process fixture compiles60914; standalone CLI binary/sync
  fixtures compile70839. Native test-only compile95937 found5 stale fixture/
  helper-visibility errors, fixed in independently reviewed27747ff (not yet
  picked at that checkpoint). Gate54910 now PASSES the previously failing2MiB
  CLI sync/move/delete case on the new Store candidate in198.06s across multiple
  CLI invocations. This proves correctness, not fast performance. Root picked
  native27747ff and CLIa710e5d; isolated HEAD is nowb5f483e. The only active heavy
  handle is47955, two chunk-generated native >16MiB restart/read/compound cases.
  Await its terminal result before another heavy check or source edit. First combined
  compile request timed out in permission review without executing; the one
  permitted narrower retry started normally. No remaining approval request.
- User asks about another parallel session. Recommended independent lane is
  wave4 shared document-semantics preparation: dialect/result contracts and
  representative metadata/source-span fixtures, using existing reuse assessment.
  No new owner/session has been assigned. Existing timing gate keeps parser/index
  activation and consumer migration after wave3; another session must coordinate
  any proposed earlier isolated implementation before changing that sequencing.
- RPC integration is isolated in `grpc-core-integration`, currently e9b2d63,
  with root-owned Cargo/pnpm lock resolution still uncommitted. Root gate97900
  passes6 native transport checks; gate51477 passes16 relay checks (plus one
  ignored helper explicitly invoked by its parent). Gate54282 passes7 protocol,
  one encrypted restore and12 sync checks, but the2MiB binary move/delete case
  reaches a25-second child deadline. Follow-up profiling identifies the first
  upload as local legacy whole-graph JSON validation: 1,515/2,160 samples in
  family_seal, 643 in ACK; the RPC worker is idle in 2,159 samples. A 90-second
  child allowance still fails gate30268 after102.65s. Do not increase it again
  or claim the2MiB case passes; validate replacement metadata-only Store first.
  Browser production RPC adapter/WASM seam is combined, not main: 39 focused
  Node checks and full typecheck pass; WASM11378, bundle58735 and real relay
  launcher12000 build successfully. Actual rebuilt browser proof is unverified:
  computer-use/browser connection timed out; no fallback browser automation ran.
  Fresh RPC fixture relay67263 and static server20525 were stopped cleanly.
  Schema depth/read-ID gate60697 passes its2 Rust+2 Node checks, typecheck and
  exact regeneration. Store/native/desktop/browser large-file activation remains
  isolated source work. Obsolete agent-owned build caches were removed after
  process inspection to resolve ENOSPC; source, fixture databases and official
  toolchain were retained. Completed browser verification's old HTTP relay70921
  was closed; no current client depends on it. Heavy builds remain serialized.
- Root reused its clean `core-default-integration` checkout for isolated branch
  `tingkai-c/streaming-core-integration`, currently940da98: reviewed RPC aggregate
  eaea42a plus Store foundation277adb0/ada6e8b/d1d0582, locatoraf49f73,
  activation2921096/abf0bb4, native d42f82d/98842d4/c49819e and desktop capability
  40b1104/wrapper5bf0ca7/bridged0bd974. This is source composition, not validation.
  Store owner has the only heavy slot: initial compile30487 failed2 type errors;
  repeat30383 ran61pass/24fail/1ignored, mainly nullable plan-state decoding and
  fixture schema issues. Reviewed fixes are being checked in gate74019. Root
  must import those fixes before combined Native/host checks. Native bdcb40e
  fixture follow-up is also queued. CLI owner grpc_native_sol now owns only CLI
  source/helper/tests and approved existing sha2 dependency; sourceb2c10ea awaits
  review and read-owner crash cleanup. Browser owner retains normalized IDB,
  streaming engine/WASM and source-import seams; desktop owns platform/index.
  No schema11 activation or new RPC default has been integrated into main.
- User explicitly skips P2P in this implementation pass (2026-10-17). Continue
  server-backed E2EE sync and its client integration; P2P stays deferred rather
  than becoming a gate for this pass. Live update behavior is independent of
  peer topology: current clients run bounded sync sweeps, and a later server-push
  subscription can trigger prompt catch-up. No Watch RPC or per-keystroke editor
  integration is implied by the current Hello/Append/Pull transport migration.
- Current main3dbcac1 includes tested general metadata planners6bda1b8 and native
  primitives57aa342+sha2edge5050db9. Aggregatefc886c7 gates68041 pass116file-sync
  lib+14mutation checks;77528 passes10native streaming primitive checks;50743
  passes29Storelib+3family checks. Store schema10 foundation remains isolated;
  schema11 activation is in progress and not main. Matching main5050CLI/host
  build33360 passed43.90sec; copied binaries plus independentCLI exact41,819-byte
  read/quiet271-entry rescan recorded in ignored build provenance. Official pinned
  Electron runtime restored/verified by16609 after frozen-install skipped scripts.
  No testElectron/host/build process remained at root's latest process audit.
- Protobuf WASM compile now passes22884 in8.61sec on official Rust1.95 with
  explicit compiler and matching wasmstd under /private/tmp/zorid-proto-rustup;
  user's root-owned toolchain unchanged. Evidence main7f46b34. Future plaintext
  protobuf mapping main3dbcac1 is proposal only: no files/Text codec rewrite yet.
  RPC FIRST is approved: transportmajor2, explicit fixtureconfigv2/grpc,
  standard generated protobuf parsing with version/features/presence checks,
  exact existing ZSE1/envelope1/headerAAD/plaintext retained. No automatic HTTP
  fallback. Existing HTTP reference fixtures remain only during transition.
- RPC source ownership: protobuf_schema_sol owns IDL/generated DTO/service crate
  and portable validators; grpc_server_sol owns grpc-relay-adapter server/startup/
  bounded shared admission; grpc_native_sol owns grpc-native-transport client/
  credentials plus named CLI sync/recovery/protocol fixtures; browser owner owns
  transport selection/WASM RPC bridge, its file-command worker the new Connect
  adapter/predecode frame guard. All use isolated worktrees; root alone integrates
  main/locks and grants build slots. Source freeze/compile/actual integrated RPC
  proof remain pending. Current app sync still uses HTTP transport1.
- Main2a78b40 also contains the reviewed additive metadata candidate/classifier/
  binary event mapper (portable sourcec319e8d+67493c4+a661bf7, gate50222:97/97)
  and core metadata-only Create/Write helperacda3ed (sourcee7827b0, gate33112:
  6 new+12 planning+5 materialization checks). Source trees exactly match tested
  candidates; no client streaming activation follows from these additions.
  Current verified native CLI/host/renderer copied to main ignored artifacts;
  target/debug/zorid-build-provenance.json records sourcef4e6ec2 and exact hashes.
  Main pinnedpnpm12 frozen install9473 and Nodeprotobuf4/4 pass; earlier42000
  install failed only sandboxDNS. Store schema10 foundation is composed in
  isolated aggregateb86149e, not main; schema11 Store/native streaming activation
  remains in progress with exact shared types and fresh-only development format.
- gRPC proof compiled16543exit 0 and passed actualChrome and nativeHTTP2 clients
  against the same Rust endpoint.131072-byte upload/download hash exact; limit,
  hash/id mismatch, uncertain response+exact retry and cancellation-after-accept
  checked. Source/evidence83d47e6+69c9fa2+3f2a89d remain isolatedprototype only.
  This closes browser compatibility gate, supporting accepted remoteRPC direction.
  Nativebindings/IPC/CLI calls remain local. Next proposal reuses existing relay
  SQLite/auth/receipt/cursor logic with explicit protobuftransport version; no
  production transport switched. OwnChrome tab and servers closed.
  General metadata planner5ce07e5 and native bounded primitive67c8bed are reviewed
  source-frozen awaiting serialized checks. Protobuf owner currently provisions
  official matching Rust/WASM toolchain in writabletmp because user rustup
  directories are root-owned; no chmod/sudo or existing-toolchain change.
- Main77bb43f integrates the reviewed resumable native scan batch after actual
  independent CLI and rebuilt Electron proof. Fresh CLI init/enroll needed no
  desktop/server;270dirs completed over22 independent32entry scans with one
  persisted scanID/stable entries, missing note retained on every partial pass
  and deleted only at completion; quietrepeat unchanged. Unicode Text write/read
  matched41,800bytes exactly. Fresh default Electron imported270folders+note,
  cleared warning, opened larger note and saved typedmarker through Rust;
  independentCLI/physical41,819bytes exact. App21921 normalQuitexit 0. See
  native-progress-verification.md for hashes, retries and automation limitations.
  Protobuf foundation integrated17907d8+7e29a08, corrected pinnedpnpm12 environment
  lock07117b1; isolated worker's original pnpm9 install was misidentified and is
  explicitly corrected in protobuf-adoption-plan.md. No codec/transport activation.
- User accepts the transport direction (2026-10-17): keep platform-appropriate
  local connections (Electron IPC/pipes, browser WASM/worker, native bindings,
  direct Rust CLI calls), and favor gRPC for remote sync after a small real-browser
  compatibility proof. default_lifecycle_review_sol owns an isolated prototype
  using a Rust gRPC/gRPC-Web endpoint and generated browser client. Verify bounded
  binary upload/download, statuses, cancellation and exact retries after uncertain
  outcomes before activating production transport. Protobuf adoption is already
  approved; gRPC runtime adoption remains gated by this proof. No required local
  server/daemon is introduced. Transport retries do not replace durable sync IDs,
  receipts, encryption or recovery semantics.
- Root revalidated main2ad1712 clean and the Orca inbox empty; no heavy/native app
  process was live. Protobuf generation, four Rust and four Node checks, full TS
  typecheck, frozen install and byte-identical regeneration pass in isolation.
  Optional WASM check cannot run on the selected toolchain: wasm32 target missing.
  No runtime codec switched. Slot released to portable mapper gate50222 at
  a661bf7; Store277adb0+ada6e8b passed29 library+3 family/schema tests and is frozen.
  Native CLI/host build56614 exited0; actual independent-process directory/Text
  proof is running. Native scanner and Store schema10 are not on main yet.
- User explicitly chooses protobuf (2026-10-17), superseding the earlier codec
  hold. Apply it to serialized Rust/client command/result boundaries and sync
  messages/chunks, with generated Rust/TypeScript types and bytes fields. Human
  Markdown/YAML/settings and CLI JSON remain unchanged. New protobuf_schema_sol
  owns isolated protobuf-schema-foundation (base454e955), common/v1+stream/v1
  IDL, pure portable zorid-proto messages and reproducible checked-in Rust/TS
  generation. No runtime codec switched yet. Sync mapping/version transition must
  be reviewed explicitly; never change v2 JSON bytes under the same version or
  assume protobuf encoding is canonical for hashes/AAD. Existing stored exact
  bytes remain authoritative. gRPC is a separate open discussion, not adopted.
- Native host gate38267 passes2/2 adapted incomplete-discovery fixtures on the
  reviewed scanner candidate. Matching CLI/host build56614 currently running;
  root owns heavy slot. Next actual independent-process large-directory/large-
  Text check, then normal app check and coherent scanner integration. Store
  owner277adb0 queued next for bounded tests; portable candidate/classifier
  c319e8d+67493c4 queued after that. No protobuf codegen build slot granted yet.
- User opened protobuf discussion for streaming/raw-byte messages and asks whether
  generated schemas/codecs would speed development. No codec adoption or rewrite
  authorized yet. Root recommends evaluating protobuf for versioned cross-language
  commands/chunk metadata and bytes fields, retaining JSON for human-facing CLI/
  settings. Desktop stdio already carries raw bodies; browser/WASM JSON arrays and
  aggregate graphs are distinct serialization costs. Portable/Store owners told
  to hold encoding changes while codec-independent semantics/review may continue.
  Existing authenticated exact-byte commitments and semantic validation remain
  required with any encoding. No new dependency installed for this discussion.
- Main7511fb0 integrates reviewed portable foundation7edbb72 after73/73 file-sync
  checks (owner47442); no large-file client activation is implied. Binary explicit
  create f62cd3e is integrated after39 Node checks/typecheck/source approval.
  Isolated native progress six-fixture gate47817 passes6/6. Existing external
  scope20679 was50/51: pending namespace work omitted a retained external binary
  observation. Diagnostic73155 confirmed that exact path. Reviewed retention-only
  fixd44e57f preserves all authority blocks; combined rerun16545 nowpasses51/51
  (new progress tests excluded to avoid repetition). Actual CLI/host/UI scan proof
  and two adapted host fixtures9d6cfd2 remain next; progress source not main yet.
  Store foundation277adb0 is reviewed/frozen but uncompiled; schema10 not active.
- Main4a48a79 integrates reviewed25f6745: whole-text diff trims shared scalar-
  aligned prefix/suffix, bounds Myers work and falls back to the changed middle
  when the window/edit count exceeds its budget. Existing256KiB Text, snapshot,
  actor, identity and wire limits unchanged. Root gate35897 passes39/39 client-
  sync tests including Unicode, large replacements and external branch merging.
  Coarse fallback is less precise for overlapping remote deletions; this is not
  the deferred stale-editor-buffer automatic merge. Native/WASM rebuilt app
  verification follows the next coherent storage build; current main binaries
  still predate this source-only library update.
- Isolated aggregate edf54fd now contains resumable external inventory source
 269b4e9+dc0d420, Store checkpoint/proof seama8e970d and importfix7e114fa plus
  Ready fixture correctionb60c854. First gate10255 exited101 on missing Store
  OperationId import; fixed explicitly. Gate47817 compiled and six new fixtures
  are running; do not claim progress implementation validated yet. Root owns
  heavy slot, external owner runs no build. Current schema remains9.
- Browser owner found a binary-create race: Vault prechecks absence then calls
  writeBinary, whose consumer can upsert a peer-created file. Explicit optional
  adapter.createBinary and fixed Create intent are approved as a separate narrow
  correctness fix. Browser owner owns isolatedbinary-create-exclusive; recovery
  UI owner reviews desktop/shared seams.39 focused Node checks and typecheck
  reported pass; review/integration pending. Unsupported adapters fail clearly,
  no writeBinary fallback. This is distinct from streaming activation.
- Streaming source foundations active in isolated worktrees: portable owner
  desktop_default_sol, Store owner package_sol (schema10 reserved; currently
  no activation), browser owner and recovery_ui_sol prepare adapter contracts
  read-only until shared types/commit plan freeze. One immutable exact-plaintext
  per-update body source plus bound metadata summaries avoids duplicate chunk
  authorities. No runtime streaming or larger Text framing is claimed.
- Mainab64af0 now integrates the coherent browser-default/desktop-diagnostic/menu
  batch. src/desktop/crates/scripts/build configs are identical to aggregate
  ebbcc22. Normal-browser actual evidence is in browser-normal-verification.md:
  no-query startup/save/reload, nested create/title rename/trash/reload,
  competing-tab retained draft/recovery-copy reload and duplicate-tab fencing.
  Undo/selection passed; IME/binary import/forced browser crash remain unproved.
  Agent browser tabs/server closed. Desktop diagnostic actual evidence above
  remains applicable; its source is now main14620da+c3297e0+7ede17e.
- Cached desktop production gate35651 passed6.787sec after menu fix. Copied
  matching tested CLI/host and renderer into ignored main artifacts; provenance
  target/debug/zorid-build-provenance.json records per-binary source/hash.
  Host2192d5926169de4939341420ca260e15f00ffc2d259b0126c5bd744e7d39942c;
  renderer main.8b902e9bbe49f990cd13.js hash
  d9f64be6ae8cdbf3bcdd7e3a9fa5d99cd8dbe232e76491d7fc026295994acbd7.
  Artifact copy first hit an index-script parsing error after files copied;
  repaired using HTMLParser and wrote the correct complete provenance. No app
  running after verification. Heavy slot returned to native progress owner.
- User asks whether Markdown indexing/search is being built and reused. Rust
  semantics/index implementation has not started; this remains wave4, after the
  current storage gate. CLI literal committed-text search is a small immediate
  headless capability. Existing completed source reuse assessment already covers
  pulldown-cmark/Comrak, SQLiteFTS5 and MDBASE evaluator extraction; none adopted
  or runtime-evaluated yet. Preserve the reuse-first gate, not a custom parser/
  search engine implementation by default. Root rechecked local assessment and
  current primary upstream docs on2026-10-17; no new dependencies installed.
- Maina1eb831 integrates standalone CLI search/watch (cf807b6+ a1eb831),
  independently reviewed with10 scoped local-process/relay checks. CLI/native/
  store/lock sources exactly match tested0f03894; copied tested CLI into main
  target/debug, SHA2565212e542ed7673ccc0ef9fea32ee6f5f77ee85b80173f40fe4ce28e080657abb.
  Per-binary provenance records the older desktop host separately. Root's main
  CLI finds exact external custom-text note and runs one quiet complete watch
  cycle on retained fixture. Search/watch are no longer missing implementation.
- Combined client aggregate c6c5772 (through browserd1ac52c, desktopdiagbbbb358,
  UI744083c, workflow305d397 and verifiedCLI) has independent seam approval,
  TypeScript9653 exit 0, desktop production23356 exit 0 and3 targeted workspace/
  platform tests5743 pass. Actual no-opt-in Electron4610 uses aggregate dist and
  default-discovered host on fresh /private/tmp/zorid-incomplete-ui-us4yx3m4:
  257dirs show persistent incomplete warning/details with zero imports, rather
  than an apparently empty ready vault. Removing only agent-created emptydirs
  lets automatic polling import Visible.md and clear the warning; exact note
  read through UI. Explicit retry was not proved because polling completed first.
  Normal app-menu Quit4610 exit 0 confirmed; no test app remains.
- Browser owner reports actual simultaneous-tab saves: winner remains committed,
  losing exact draft survives reload and recovery-copy creation/reload preserves
  both versions. Tiny real undo/selection/copy pass; IME not exercised. Folder/
  trash UI exposed a shared stale-object menu guard after unchanged snapshots;
  approved scoped fix666ac28 is source-reviewed/tested by worker and awaits
  owner independent review/rebuild/runtime proof before client batch integration.
- Shared bounded streaming contract now in shared-binary-streaming-plan.md.
  Root approves narrow portable sections1–3; desktop_default_sol owns portable
  implementation and package_sol the store adaptation proposal, coordinated with
  native progress helper ownership. Scattered whole-file caps remain; no streaming
  runtime claim. Practical8K Text diff repair stays within current256KiB limits;
  larger Text framing/limits are still proposals. Native256progress source review
  remains active; heavy builds coordinate through browser owner then native owner.
- Main4816771 integrates fatal routing2cceb6e, compound move/delete10479ea and
  test-only corruption oracle4816771. Native/store sources exactly match tested
  aggregate e9bc2be. Native external gate10156 passes51/51; prior21576 was50/51
  because the corruption test reloaded its deliberately corrupt graph in its
  assertion. Corrected oracle independently counts durable pending outbox rows;
  runtime behavior was unchanged. Host incomplete-process gate68733 passes2/2
  and bounded-diagnostic check passes1/1; CLI/host build7548 exit 0.
- Retained actual fixture now reconciles ExternalTools->ExternalRenamed plus
  text edit and binary-child deletion through the rebuilt standalone CLI.
  Folder/text IDs unchanged; exact 33textbytes hash
  4c229322000382c309ae5e2e6bdb8d14b4dfef5afb4237fcb018063385258b9c,
  deleted binary absent from live list. Independent restart/rescan is complete,
  zero imports/namespace/issues. Original CLI/recovery-copy hashes unchanged.
  Report /private/tmp/zorid-compound-reconciliation-1017.json. No test Electron
  process was present. Diagnostic activation remains isolated until UI wiring
  joins it; do not copy its changed host into main before that coherent batch.
- Browser rebuild9631 exit 0 (webpack6.074sec, unchanged Rust cache). Actual normal
  browser create/save/reload without credentials passed on8791; namespace,
  simultaneous-tab and recovery evidence remain with browser owner. CLI
  search/watch proposal approved, implementation package_sol. Streaming requires
  normalized authenticated chunk storage/content references, not raising a cap;
  desktop_default_sol owns a concrete contract proposal before broad edits.
- Main04ca6f3 is clean. Isolated aggregate e42d7fe now composes native fatal-error
  propagation61236b2 (source0fcf8fe), atomic moved-folder/child-deletion37c77b4
  (source5404a50), status seam9a200fb and live incomplete diagnostics e42d7fe.
  Documentation-only cherry-pick conflict retained both records. Native runtime
  validation remains pending; external_reconcile_sol separately owns persistent
  scan progress beyond256 directories. No heavy native job started.
- Actual normal browser startup at8791 contradicted the successful build: the
  minified worker contains invalid dynamic-import JavaScript before WASM loads.
  Browser owner fixed loader rewriting in d1ac52c; independent review, tiny real
  production-worker parse regression and TypeScript pass. Rebuild9631 currently
  holds the serialized heavy slot; actual editor proof remains pending. Do not
  cite the earlier successful build as functional normal-browser evidence.
- Milestone acceptance audit identifies further accepted CLI gaps: Search is
  explicitly unsupported, continuous watch/sync absent, and whole-file paths
  remain capped at16MiB. package_sol owns isolated CLI search/watch follow-up;
  external owner will assess bounded streaming separately. Indexed Markdown
  search remains stage4. Add one short actual undo/selection/composition pass
  during the next successful client session, not a repeated broad test matrix.
- Mainf5f97b2 now integrates the reviewed/tested desktop default batch; crates,
  desktop, src, scripts and build configs are source-equivalent to aggregate
  1a02f01 (zero diff). Copied tested CLI/host and renderer into ignored main
  target/debug and dist for ordinary desktop startup; provenance JSON retained
  beside binaries. No repeated main build needed for source-equivalent artifacts.
  Native host SHA2563bd287c11baf7a7321725e8d06d38296f975cc0e032daa7b4f5b3801be680ee6.
  Actual test app72273 normal Quit exit 0 confirmed; no test app left running.
- Browser normal default source ff90295 source-approved after release-phase retry
  and independent legacy export fixes. Heavy browser87504 passed with existing
  tasklocal Rust overlay/pinned wasm-bindgen (first95472 lacked wasm target and
  exited2). WASM2378971 bytes digest0d9efb8e2eda8e6cf741fd6f2e62791902c2879bc397cb41f88210218f7277cf;
  webpack production passed72.236sec, size warnings only. Actual editor CUA proof
  now owned default_lifecycle_review_sol at freshorigin8791/server65716.
  Browser source not main yet. Packaging workflowfollowup305d397 must join asset
  build:desktop script, not standalone. No heavy build live at checkpoint.
- Native compound external folder move+child deletion and typed fatal error routing
  remain external_reconcile_sol work. Diagnosticfollowupcaa4e7e+bbbb358 and UI744083c
  source reviewed; do not activate until native fatal errors propagate (catch-all
  ScanIssues cannot hide corruption/schema/unsafe-root failures). Large directory
  rescan progress above256held descriptors remains required followup.
- Aggregate1a02f01 compiled; native external42/42, portable8/8, oldschema byte-
  preserving rejection1/1, credential-free localhost startup1/1 passed. CLI/host
  built serial gate96668; TypeScript/renderer webpack30017 passed. Actual no-env
  app82388 discovered aggregate target/debug host (SHA256
  3bd287c11baf7a7321725e8d06d38296f975cc0e032daa7b4f5b3801be680ee6).
  Default create/save/title rename/folder creation proven through UI+CLI.
- Fresh fixture /private/tmp/zorid-native-default-8o5uj29z/vault, profile sibling,
  launcher sibling; no opt-in/hostoverride/credentials. Primary clientabcd76be-
  24b6-437e-9cbc-3ad20d47803a. Forced app98078+host98137 crash after CLI won race
  preserves draft. Restart72273 opens normal workspace with exact draft and
  recovery banner. Save recovery copy succeeds:44 bytes digest
  1f2732c872e0eab1235c1911725609c3526c4007352f6459eecd45bb1f9ce075,
  original36 CLI bytes unchanged, checkpoint adopts latestoriginal. Report
  /private/tmp/zorid-default-recovery-result-1017.json. Normal close pending.
- Actual external auto-import of custom text+binary+folder passed. Compound move
  folder+edit text+delete binary leaves completefalse/old logical paths; exact
  new physical paths retained. external_reconcile_sol owns required atomic
  MoveWithDeletions followup, no activefixture writes. Do not claim complete
  external compound support. Native contextmenu trash action was attempted but
  produced no observed change; verification remains open (tool/menu issue unknown).
- Browser normal default needs real admission/durable editor integration beyond
  smoke; default_lifecycle_review_sol owns browser-rust-default, Sol subworkers
  slots/commands/assets. Desktop incomplete-import diagnostics followup owned
  desktop_default_sol, UI module744083c recovery_ui_sol, workspacewire browser
  owner, backendreview package_sol. >256dir import progress remains gap.
- Combined candidate core-default-integration9aec09b holds reviewed Rust-default desktop, packaging, external reconciliation and recovery UI. Main not yet default; actual no-env native gate remains. Combined cargo check84218 failed unresolved crate alias in external_scan.rs410; owner preparing fix, no heavy job now.
- Actual stopped-relay browser/CLI offline edits, browser reload and relay restart converge exact55 bytes/digest; see browser-relay-verification.md. Current relay43620/static69072; old60287/52832 handles gone. Old test app3337 handle missing and process inspection confirms no test app alive.
- Agent tree reset on resume; replacements explicitly Sol/high now own existing worktrees. Prior work preserved. New-device QR/code join plan recorded below, implementation after current default/recovery gate.
- Crash21481 terminated confirmed ownapp37756+host37814 with SIGKILL; restart3337
  retained checkpoint exactly and CLI physical bytes SHA256
  a54edd43b725a162f7e7bcc95d56f36e208a16c982b32348c71c266f13bfd7f7.
  Actual AX blocks workspace on recovered conflict. browser_sync_plan owns fix:
  initial render must not flush unseen recovered draft; preserve baseline/CAS and
  offer note-local recovery, plus user-requested improved workspace error screen.
  Evidence /private/tmp/zorid-race-after-crash.json. Restart3337 was asked to quit
  via normal menu but exit not yet confirmed; revalidate before new launch.
- Default activation source ongoing desktop-rust-default: local-only bootstrap,
  per-window identities and host discovery;15 bounded checks passed. Registry
  4a3d6f0+fb25329 independently source-approved,5 checks passed. Lifecycle reviewer
  found retire/open race; owner must fence per-root closing + identity cache delete.
  Packaging13 bounded checks passed, source review underway, no full package run.
- Actual desktop/CLI race now exercised on fresh lockfixed fixture. Observer
  /private/tmp/zorid-desktop-cli-race.py saw desktop checkpoint draft token
  DesktopRaceToken1017 at old revisionf5e0aeec-9d04-47f2-b7eb-4bed68da9e5e;
  independent CLI write5655dba5-d99b-4b82-a45b-429a8c2e0e54 committed sequence66,
  revision5f0b715c-a1ab-4907-90a1-11257cfb34e9. Physical file contains CLI body;
  AX shows desktop draft retained and "Save failed — draft retained". Checkpoint
  remains exact old baseline + draft; evidence /private/tmp/zorid-race-lockfixed-1017.json
  and /private/tmp/zorid-race-checkpoint-before-crash.json. Next actual process
  interruption/restart still pending. Root app session21481, PID37756, host37814
  live at last observation; fixture note ConcurrentProof.md id
  a5cd22cf-01d4-4096-9ebe-d9ea5dea5e9a. Do not silently discard draft or claim merge.
- Browser account-isolation proof completed; see browser-relay-verification.md.
  Authorized B exact 33 bytes, persisted-scope conflict, unauthorized A-scope denial
  with empty inventory and denial after reload. Both extra tabs closed.
- User explicitly requests Rust as default desktop core, superseding opt-in
  rollout sequencing. desktop_integration owns startup/platform/init/host discovery
  and packaging in isolated branch based0d3db40; root owns rebuilt UI verification.
  Local operation must work without sync credentials or an available backend.
- Latest browser receive/reload proof and CLI isolation pass are recorded in
  browser-relay-verification.md; browser account-isolation portion remains.
  External ordinary create/move/delete discovery implementation now assigned to
  mobile_readiness in core-external-namespace based2c811ef, with portable planner
  crdt_interop, import worker client_sync_review, review data_readiness. No builds.
- 2026-10-17 10:04 handoff: main f4ec6bf integrates the entire reviewed native
  namespace/external-edit/publication-handoff and desktop full-command chain,
  including retry identity guard. Independent source equivalence review confirms
  native/store/CLI/host sources match tested92673a9; sole Rust difference is the
  separately tested required-ACK protocol fix. Main focused Node checks10/10 pass.
- User confirms rename works. Root actual AX observes title rename to
  TestRename-verified.md; independent CLI reads the same stable entry
  0e77560f-65ea-4996-a172-cf1b7cd51bec with33 bytes (leading tab plus
  "Rename and restart verification."). Physical bytes and core agree. User-created
  folder/nested file and trash move are also visible through independent CLI.
- Test app session78880 exited0 after app-menu Quit (keyboard shortcut did not
  close it). Its PID7579, child12514 explicitly used
  core-namespace-external-gate/target/debug/zorid-desktop-host; rendered source is
  desktop-file-commands/dist/index.html. Fresh fixture is
  /private/tmp/zorid-cli-family-20261017-lockfixed. Old0936 fixture remains broken;
  never reuse it. CUA AX can lag, screenshots clipped, clipboard paste timed out;
  do not infer lost data from these UI tool failures. Close test app after pass.
- Latest real CLI sync through loopback relay succeeded:33 accepted, graph50,
  authored/dependency/projection pending0, cursor50. Sandbox attempt failed
  transport; escalated networking succeeded. Relay60287 and browser server52832
  both polled live. Browser still needs receive of latest rename/trash records.
- Next: actual fresh desktop/CLI concurrent race and dirty-checkpoint restart;
  current browser receive/offline rejoin plus client-level account isolation.
  core_cli supplied bounded authorized-B and B-token/A-scope denial sequence;
  existing server isolation tests already pass and need no repetition.
  mobile_readiness assesses new external-file/rename/delete reconciliation,
  proposal before shared native edits; no heavy builds running.
- Native lock fix integrated `ac6b09a`, independent subprocess checks2/2 passed.
  Full follow-up candidate9c61837 then passed84 native and18 store namespace
  checks, including mixed obligations, file/directory handoff and external edits.
  CLI/host build3348 is the current heavy handle; root runs no build.
- Protocol compatibility6/6 passed in corrected candidateeca934a, gate16371,
  including lock fix. Required-feature ACK error classification fix integrated
  main1a8f316. Exact retries/pending writes survive rejected acknowledgments;
  incompatible payloads leave ledger/cursor/publication unchanged.
- Actual browser tab ownership/independent same-database write/read/reopen checks
  passed; see browser-relay-verification.md. Simultaneous conflicting tab writes
  remain a narrower unproven scenario, not implied by those checks.
- Broken live fixture evidence is now secured in
  `/private/tmp/zorid-wal-split-74662.{lsof,stat}.txt` and physical-note snapshot
  `/private/tmp/zorid-wal-split-physical-snapshot`. Normal Cmd-Q closed launch37850
  exit 0; database recovery is not claimed. Lock fix source independently approved;
  data_readiness granted minimal sqlite_lock_tests gate before other native runs.
- User confirms creation works but rename fails. Actual `native_namespace_pending`
  matches incomplete adapter connection; desktop_integration full-file command
  slice owns fix and subsequent rebuilt UI proof.

Historical first-milestone acceptance snapshot (2026-10-17; superseded by
the current checkpoint and [final acceptance](history/shared-core-milestone-acceptance.md)):

| Requirement | Current evidence / next necessary step |
| --- | --- |
| Portable Rust + independent web/Electron/CLI | Desktop Rust default now main, actual no-opt-in startup/recovery passed; normal browser source built and undergoing actual editor verification; standalone CLI independent |
| Text, binary and folders | Byte-exact binary/nested transfer and desktop normal creation/rename/folder proof; durable file commands integrated. Compound external move+delete remains in progress |
| Offline convergence | Actual stopped-relay browser/CLI independent edits, browser reload and relay restart converge exact55 bytes; see verification document |
| Desktop/CLI simultaneous safety | POSIX lock fix integrated; actual CLI wins while desktop draft retained, forced restart and recovery copy preserve both exact versions. Automatic stale-editor merge remains future UX |
| Browser-tab safety | Earlier spike and store-connection checks exist; current complete worker/tab lifecycle still needs bounded integrated proof |
| Durable-save crash/restart | Actual abrupt app+host termination retains draft, normal workspace opens after restart, recovery copy verified. In-flight commit lost-reply UI case remains separate |
| Move/delete/external edits | Fresh native receive physically retires deleted paths. Mixed obligations/publication handoff/existing external imports are reviewed follow-ups awaiting storage fix and combined runtime gate |
| E2EE/account/vault isolation | Actual server, standalone CLI and browser worker isolation checks passed; production enrollment remains fixture-only |
| Protocol compatibility | Current-v2 CLI checks6/6 passed, including exact retry after rejected required-feature ACK |
| Basic encrypted backup/restore | Clean independent CLI text + multi-chunk binary restore/restart passed; account/permission/credential and pinned WAL snapshot tests passed |
| Integration/resource discipline | Main owns reviewed confirmed batches; builds serialized. No real vault migration or deployment; active broken fixture retained for diagnosis |

- Priority storage blocker: browser_sync_plan observed live host74662 holding
  WAL inode342471712/SHM342471713 while pathname WAL/SHM are342480671/342480672.
  Host writes and later CLI/Python reads therefore see split SQLite state.
  Likely cause is native fs::regular open/drop on SQLite-managed inodes in
  fs.rs::verify and post-open database identity capture, releasing POSIX locks.
  data_readiness owns narrow descriptor-relative metadata fix and regression.
  Preserve live0936 host and WAL; no further SQLite opens or termination until
  evidence is secured. Earlier sequential interop evidence is retained, but
  concurrent safety is not established. Native combined gate waits for this fix.
- Encrypted restore extension integrated as main `e71f59a` after candidate
  f53a6b5 recovery54884 exit 0: clean CLI restored exact text and 262163-byte
  multi-chunk binary, then restart preserved both. Existing metadata/credential
  restore test81517 and pinned WAL permission/log snapshot check also passed.
- Concurrent-editor follow-up remains failing/unproven: test launch37850,
  Electron74599/host74662, vault0936, note `Untitled 1.md` entry
  cbc93ccf-f71d-493c-ae4e-ebf238906f6d. Two bounded readonly checkpoint observers
  timed out without issuing CLI writes. UI and physical file have appended race
  tokens while Rust CLI read/checkpoint retain `Concurrent seed.` (generation16).
  browser_sync_plan owns save/admission diagnosis; no concurrent-write success
  or draft-crash recovery is claimed. Preserve fixture for investigation.
- Main `5d29c53` now integrates native candidate292cd27 and normal desktop
  create/save candidatea29605b plus idle-child cleanupc06d110. Main tsc31928
  exited0 and four focused creation checks passed; crates/Cargo sources exactly
  match the built native candidate. Actual fresh CLI14-record receive, nested
  text/binary hashes, deleted-path absence, rebuilt Electron New note/save,
  simultaneous-open CLI upload and browser exact receive passed. Electron92846
  quit normally exit 0. See browser-relay-verification.md for scope and hashes.
- `core_cli` owns the next serialized recovery check: binary extension3aab341
  in an isolated candidate, then existing metadata/permission snapshot checks.
  Mixed namespace obligations and external-edit imports remain isolated follow-ups;
  these are not included in the successful runtime claims above.
- Main `517f87b` includes reviewed browser ancestor-publication fix and hashed
  smoke assets. Actual worker nested create/reload/read and encrypted upload
  passed; see `docs/history/browser-relay-verification.md`. Old failed database is
  preserved. Earlier apparent failed rerun used cached JavaScript.
- Normal desktop bridge `96e4542` fixes full-reload journal response validation.
  Latest observed fixture draft was committed and checkpointed; exact UI restart
  acknowledgment verification remains pending. Original process80439 exited;
  replacement82184 is live and user-interacted. Do not count source fixes as
  normal desktop verification.
- User reported New note fails with `durable_consumer_required`. Desktop owner
  owns explicit createText adapter/Vault seam, checkpointed main-process create
  consumer, and narrow leased Rust host create_text command (`9fe9571`).
  Focused checks/build and actual New note UI verification are pending.
- Native namespace batch `b27de4d` passed 24 native and 18 store checks, merged
  into isolated CLI candidate `878a2e3`; not yet main or actual CLI-verified.
  New canonical schema8 tables require a fresh disposable vault. Mixed folder
  Move/Delete claims are a separate client_sync_review follow-up; active content
  publication transfer remains unresolved. Do not migrate current open fixture.
- `core_cli` owns combined native/host build; desktop owner runs scoped
  TypeScript/webpack afterward. Serialize these checks. Browser diagnostic
  server8768 stopped; root relay and smoke8767 remain for subsequent interop.

- User explicitly approved remaining namespace physical-binding patch; owner
  committed `f7f81ce` in `core-family-namespace` and continues received/local
  Move/Delete attachment + recovery. No authorization blockers remain for those
  two previously blocked source patches. No real-vault migration authorized.
- Combined native CLI candidate `e6b1a67` built successfully (root73685).
  Actual standalone CLI init/enroll/receive matched browser binary SHA256 and
  created/uploaded `cli-note.md`; fresh browser received exact 27-byte CLI text.
  Native received namespace still incomplete: logical deleted note absent from
  list but `note.md` remains physically, pending_projection3. Owner has reproducer
  `/private/tmp/zorid-cli-family-20261017-0910`; do not claim synced=true.
- Normal desktop candidate `2ac9d13` passed tsc46590 and webpack15318; matching
  Rust desktop host build/runtime still pending. `core_cli` assembles host into
  native candidate. Editor Canvas pass released native slot via msg52236cefade5.
- Actual browser nested child creation found storage_corrupt. Initial reviewed
  fix `1cefd8d` (candidate da2d162) rebuilt but STILL fails in fresh DB; not
  integrated main. `mobile_readiness` owns diagnostic/fixture bounded build slot;
  root browser interactions only. Preserve failing fixtures, no automatic repair.

- Native schema8 owned commits `dc9e1ba` + `a9e821c` passed combined store family
  integration 3/3 in worker session98471. `core_cli` assembles latest-main native
  + standalone CLI + shared runner candidate in `core-native-cli-combined`;
  native compile remains pending. Source-only desktop normal editor bridge
  `4c80179` waits for NoteBuffer consumer and native combined build.
- Editor explicitly resumed scoped Canvas/Bases verification; native slot granted
  via `msg_92a391b3b6b9`, live Electron session22552 acknowledged. Core heavy
  work waits for release. Rust-save ownership remains with shared-core workers.
- Actual browser rename preserved identity/content; remote deletion removed the
  file from the other browser, and a normal restart preserved prior local content.
  Evidence in `browser-relay-verification.md`; folders/crash/native checks remain.

- User explicitly resumed **Rust save integration only**, leaving editor polish
  paused, and confirmed test-vault content is disposable. `browser_sync_plan`
  owns isolated NoteBuffer/helper/workspace durable-save lifecycle; desktop owner
  owns main/preload/bridge/platform capability plumbing. This supersedes earlier
  NoteBuffer pause for this scoped integration. No real-vault migration authorized.

- User explicitly APPROVED the prepared native database initialization/visibility
  activation patch in chat. `data_readiness` resumes isolated schema8 activation
  and coherent native aggregation. This is source-only fresh-database development,
  not permission to migrate real vaults. The separate namespace physical-binding
  patch is not covered by this specific approval and remains unapplied.

- Browser batch is now integrated through `3185253` after successful combined
  WASM/TypeScript/webpack builds and actual two-browser encrypted relay roundtrip
  plus concurrent-edit byte convergence. See `browser-relay-verification.md`.
  Next run binary/move/delete/reload on the same live fixture. Native activation
  remains approval-blocked. Physical hooks source `9e93426`, native wrapper
  `a1c0a13` + `acd8a96`, and Electron `3ef94f8` + `dadf4a5` remain isolated.
- Root reclaimed idle compile slot via `msg_f56012597044` after observing paused
  editor and no compiler; all root builds now finished. Loopback relay60287 and
  static server52832 remain for actual-browser continuation, not heavy builds.

- Latest user direction: prioritize usable complete implementation; production-grade
  testing is not required now. Keep one combined build and short real client/sync
  checks plus targeted data-loss/security regressions; defer exhaustive test expansion.
- Combined browser candidate `48bacf9` in `core-browser-combined` assembles current
  main plus rebind/witness helpers, WASM `00065a2`, storage `76a30d3`, worker
  `e79ad2f`/`fbcbdc6`, and relay launcher `8df30f7`, with no conflicts. Build and
  actual HTTP verification pending. `browser_sync_plan` owns minimal runtime smoke
  page using real BrowserCoreRuntime rather than direct-IDB fixture substitution.
- Electron source candidates `3ef94f8` + `dadf4a5` are independently reviewed and
  syntax-checked, awaiting combined native core and relay execution. No more
  per-component mock-test/review gates planned.
- Editor terminal inspection shows interrupted/paused session and test Electron
  PID15065 still open; no compiler process observed. Requested fixture cleanup
  and slot release via Orca `msg_ddca4dd55c60`; root has not started a heavy build.

- Execution adjustment after user's testing/velocity question: finish native
  family persistence + standalone CLI and browser storage + worker/relay flows;
  batch validation around those consumers. Keep actual bug regressions and all
  milestone requirements, but stop unnecessary repeated component gates.
- Native schema8 activation has a separate automatic-review block. Exact
  unapplied artifact `/tmp/zorid-schema8-activation.patch` was read by root;
  user approval requested for isolated source application. It changes fresh-only
  initialization/version rejection and visibility/legacy mutation gates, not
  a real-vault migration. Do not bypass review or apply while approval is pending.
  `recovery_review` now owns native family wrapper source with API/lock constraints
  from `data_readiness`; the latter retains atomic store/apply/receipt ownership.
- Current resource handoff: editor coordinator owns bounded Canvas/Bases tests
  and TypeScript via Orca `msg_4c1acfc31c9b`; root's last WASM session45875 exited0
  with 21 wrapper tests. No core heavy checks until editor explicitly releases.
  New user-authorized Canvas/Bases UX work is active; NoteBuffer remains paused.
- Editor acknowledged the handoff and reported Canvas session70192 as its live
  handle via `msg_8a891d676c3e`; wait for explicit slot release before core builds.
- `be8bfc3`/`90e7b91` integrate source-reviewed retained-binary and classifier
  WASM bindings after21 native wrapper tests (session45875 exit 0). New exports
  are NOT yet browser-verified. Rebuild once with remaining FamilyCommand/wire
  routing bindings for the combined browser storage/relay gate; do not reuse
  artifact11d2544 as evidence for these exports.
- Actual two-tab fixture `ecbffdf` passed four Chrome checks including competing
  same-revision edits and actual owner-tab closure/reacquisition. Evidence
  `bb296d8` extends `browser-admission-verification.md`; disposable resources closed.
- `8f9a89b`/`d76d88b` integrate complete-text and shared classification helpers;
  combined current-main session74219 passed96 tests. `04af75f` adds exact durable
  FamilyCommand/mode identity (reviewed candidate passed14 focused tests).
- Next coherent browser batch: `mobile_readiness` owns atomic storage and intent
  routing; `wasm_integration_prep` owns shared planner bindings;
  `browser_sync_transport` owns admission-aware worker/runtime RPC and HTTP flow
  in `core-browser-sync-worker`. Network waits remain outside IDB transactions.
  Native store/schema8 and actual CLI/recovery/protocol fixtures form the other
  integration batch. No full network-convergence claim yet.
- Remaining browser dependency owner explicitly reactivated: `wasm_integration_prep`
  implements FamilyCommand/planning, bounded envelope-ID routing and historical
  binary witness bindings. Worker source `e79ad2f` is reviewed by `crdt_interop`;
  no runtime claim before combined storage/worker/WASM build.
- `core_cli` owns extraction of existing native CLI relay orchestration into
  `zorid-native-sync`; desktop host and CLI call that same library directly.
  `desktop_integration` owns host/bridge consumption, preserving paused editor
  consumer work. `browser_sync_plan` prepared source-reviewed disposable relay
  launcher `8df30f7`, pending the combined launch/build gate.
- Source-ready aggregation queue (not runtime-verified): native wrapper `a1c0a13`,
  CLI family `1834b5e` + omitted-mode regression `0ab1e4e`, shared native runner
  `e0dba5c`, CLI protocol fixtures `1cb296f`/`a2134a0`/`0c05291`, recovery fixture
  `1523618`. Browser worker `e79ad2f`/`fbcbdc6` is source-reviewed after fatal
  storage cleanup fix. WASM batch awaits portable witness `af76394` and text
  revision rebind `a5b8450` plus final boundary review. Combine dependencies in
  isolated candidates; do not cherry-pick unfinished consumers into main.
- Editor's next combined build/native slot is granted via `msg_1b2ab3e90af6`
  after its current tests finish. No overlapping core heavy checks are authorized.

- Main `1362e6f` adds the reviewed shared mutation planner; `01bf40a` bounds
  retained binary expansion before allocation. Combined current-main session96859
  passed39 file-sync unit tests plus11 mutation fixtures. Native/browser consumers
  remain unfinished; this establishes portable planning only.
- HTTP isolation tests integrated as `4a2f7a1`/`db7264e`: final reviewed candidate
  session87939 passed2 actual TCP tests. Revocation overlap remains smoke evidence,
  not deterministic transaction-order proof.
- Browser admission fixture integrated as `8743ebd`, evidence `d6bbc60`:
  TypeScript/build and all5 real Chrome multi-worker checks passed, cleanup
  confirmed. See `browser-admission-verification.md`. `desktop_integration` owns
  the next actual two-tab fixture; single-page results do not establish that gate.
- Auth setup discussion is recorded in `user-findings.md`: Better Auth/SQLite
  with an OAuth/OIDC boundary is a proposal, not an adopted provider. Account
  login remains distinct from E2EE key recovery.
- Native/classifier review found incomplete Yrs updates could appear as complete
  visible text. `crdt_interop` owns a single-load complete-materialization helper;
  classifier must treat pending insertion/deletion prerequisites as pending.

- Subsequent promotion: `f9e6fc9` integrates the reviewed WASM crate and runtime
  fixtures. Rebuilt candidate `11d2544` passed all10 actual Chrome groups; main
  wrapper tests passed17. `906dab6` includes strict plaintext inspection with
  no authenticated authority. See `wasm-family-browser-verification.md`.
- `5f6555e` integrates physical move frontier joining and retained historical
  binary witness validation. Candidate session44641 and current-main session4653
  each passed all 38 file-sync tests. These pure helpers do not prove filesystem
  projection; native/browser adapters still must commit their own durable proof.
- HTTP isolation candidate `ccad485` passed2 actual TCP tests, but review requires
  request deadlines and narrower overlap-race claims before integration. Timing
  alone does not establish deterministic revocation transaction ordering.
- Browser storage review found cursor skipping, incomplete hidden-content witness
  validation, stranded unsupported prepared intents, bounds-after-copy and a
  competing sealed-result authentication gap. Owner is fixing these; no storage
  integration approval yet. Focused TypeScript passed, not runtime evidence.
- `core_cli` owns portable mutation planning; `data_readiness/family_ledger_review`
  owns shared materialization classification in `core-materialization-2`, reviewed
  independently by another worker. `wasm_integration_prep` exposes the validated
  retained-binary helper. No duplicated JavaScript/native causal algorithms.

- Main `90aa624` through `ec5b2ee` now contains purpose-separated recovery,
  portable raw-response codecs and text/file-v2 planners. Combined current-native
  candidate `a72e13c` passed 108 tests (session60597 exit 0), including known-note
  clean-client recovery. Evidence: `portable-family-integration-acceptance.md`.
  Browser admission `cdd6b49` passed 47 focused tests/full TypeScript in its
  reviewed source candidate; actual browser lifecycle proof remains required.
- Root pinned WASM build session43081 exited0 at source `f79a294`; native
  wrapper tests passed15. Actual Chrome fixture `6f3ade8` passed all10 groups,
  including authenticated family updates and raw transport decoding. Evidence
  committed as `a78770b` in `docs/history/wasm-family-browser-verification.md`. Test tab
  and loopback server are closed. Reconcile main crypto recovery dependencies
  and strengthen namespace metadata before the next WASM integration gate.
- Family-store focused session35255 exited0: 9 new ledger/file-state unit
  fixtures passed. Schema8 activation, ingress and materialization are unfinished;
  this does not establish native integration. The heavy build slot is released.
- CLI candidate `1834b5e` is source-reviewed, pending schema8 APIs and actual
  process tests. `core_cli` now owns a shared portable mutation adapter proposal;
  native and browser must consume one Rust mapping for file operations. Native
  owns transaction/receipt/CAS, browser owns IndexedDB atomic persistence.
- `client_sync_review` owns portable causal-frontier joining for physical move
  witnesses. A folder ancestor's move cannot be inserted into a child's own
  entry frontier. Physical binding commits `1d8a386`, `19d755d`, `db1ea40` are
  source-reviewed only and still depend on schema8 and the blocked patch below.
- `browser_adapter_review` reviews browser atomic sync source independently;
  `desktop_integration` prepares real-browser admission lifecycle fixtures;
  `recovery_review` audits remaining isolation/protocol/restore acceptance gaps.
- Physical-binding namespace patch is blocked by automatic approval review,
  which rejected cross-owner authorization evidence. Exact unapplied artifact:
  `/tmp/zorid-namespace-physical-binding.patch`. User approval requested for that
  scoped source patch; do not retry through another executor/path. Unaffected
  browser, recovery and family-store work continues; real vaults are untouched.

- Latest main promotion: namespace commits `82a8567` through `1a81819` include
  retained move/delete projection and bounded per-member progress. Main-based
  candidate `8ba5c55` passed 158 native/store/host tests, session12395 exit 0;
  evidence in `native-namespace.md`. Distributed namespace sync remains separate.
- Desktop flush lifetime fix `e39e266` has three fail-before regressions and
  8/8 passing focused tests. Browser transport `5681a11` through `634ab77` passed
  11 mocked fetch/stream tests and scoped TypeScript; no actual CORS/client sync
  claim. Browser admission and atomic storage integrations remain in progress.
- LiveSync matrix is integrated as `5c30e20`: 27 scoped scenarios, pinned sources,
  exact source-test references and explicit gaps. Source audit is not runtime
  coverage. Recovery `7a54d70` is independently reviewed and now owns the heavy
  slot; codec/text-v2/file-v2/WASM runtime gates follow. Root has no live build.

- Latest promotion: `6b450d7`/`13214dd` integrate the reviewed native schema6,
  text-sync CLI, desktop-host/wrapper and shared protocol decoder batch.
  Candidate `3660c77` plus resolved lock passed 202 Rust tests (session14067),
  6 protocol tests, fresh CLI/host builds and 46 CJS tests (session72147), all
  exit 0. Real CLI processes converged offline text through a loopback relay;
  real desktop-host/CLI fixtures covered concurrent access and checkpoint
  restart. See `native-sync-integration-acceptance.md`. Ordinary app storage
  selection, Electron UI, browser/server convergence, full namespace/binary
  sync and clean-client encrypted restore remain incomplete.
- Editor insertion batch is integrated as `dedbcfa` with evidence `56c9d12`:
  112 affected/regression tests and full TypeScript passed on main-based
  candidate `6e44bf2`. No new native UI or production build claim.
- Next native namespace source `61a98e3` passed 137 focused tests after a missing
  import and Linux-only filename fixture correction; per-member journal
  optimization is ongoing in its isolated worktree. Text-v2/file-v2 and schema8
  work have separate owners and coordinated APIs. Root has released the heavy
  slot after session72147; no root verification process remains running.
- Current follow-on ownership: desktop admission candidate `20b6973` owns the
  serialized test slot (owner session99012); optimized namespace verification is
  queued next. `crdt_interop` and `core_cli` own coordinated text-v2/file-v2;
  `data_readiness` owns the common family ledger/atomic ingestion. Browser
  admission design is assigned to `browser_adapter_review`, with no production
  editor selection changes. `livesync_audit` proposes a purpose-separated random
  recovery-key bundle and clean-client restore fixture; `recovery_review` owns
  independent contract review before crypto edits. These are active tasks, not
  completed implementation or runtime evidence.
- Follow-on update: desktop admission is integrated as `d12a27e`/`fda18cd`:
  56 native/host, 46 CJS and 6 actual CLI/host checks passed; duplicate-client
  exclusion and crash/reacquisition are covered at process level. Production
  window selection and editor lifecycle remain separate. The heavy slot has
  transferred to optimized namespace `0b0cf86`; root has no live build.
  WASM source candidate `4ea8838` is prepared with exact provenance but awaits
  lock resolution and tests. Browser encrypted-sync integration is undergoing
  a source-level API/transaction audit before implementation ownership is split.

- Main `227f084` contains both native/CLI batches and editor E1/E2. Native batch2
  candidate `3df1de8` passed 109 tests in a fresh target (session30255 exit 0),
  covering folder creation, bounded rescans and coherent reads/change cursors.
  See `docs/history/core-integration-acceptance.md`. Apps still use existing storage;
  no migration, push or deployment by this session.
- Editor candidate `6b96d1f` passed 29 focused and 1963 aggregate tests,
  TypeScript and production webpack (three performance warnings), session64815
  exit 0. The stale parser-tree bug has eight verified fail-before regressions;
  source fix `a8cfb75` equals editor `dfbfae7`. Native Base property writes and
  horizontal/vertical Canvas edge resizing persisted on that build; a draft
  committed on blur without loss (focus retention unproven). Audio playback
  remains unverified: its accessibility label alone does not prove failure. Evidence
  `cc55574` is on main; owned Electron exited0. Tested dist is in
  `editor-base-embed-integration`, not the primary checkout's older dist.
- Isolated core `b510194` passed the entire Rust workspace in dedicated
  target-verification: session34798 exit 0, 201 passes, one ignored crash helper
  explicitly invoked by its parent. Includes schema5 host intents, text plans,
  file/namespace/chunk plans, authenticated envelope capability, relay and basic
  backup/restore. SQLite unsigned conversions and two invalid test setups were
  corrected before this pass. These are component/process tests, not real app
  convergence. WASM crate native tests do not substitute for browser execution.
- Backend foundation is integrated on main at `04bf12b`. Candidate `91694d3`
  passed 28 protocol/crypto/server checks including managed backup/restore
  (session65524 exit 0); no-default-features crypto passed 8 including its doc
  test (session 5557 exit 0). Offline lock resolution preserved existing pins.
  See `docs/history/backend-integration-acceptance.md`. The server remains a loopback
  fixture: hosted enrollment, admin UI and deployment are unfinished.
- Web foundation is integrated on main `c369571`. Candidate8eb89de passed
  focused9 and full2005 app tests, typecheck, ordinary production and explicit
  fixture builds. Ordinary build excludes fixture assets. Actual Chrome passed
  host27 and WASM6 groups; the real app production worker opened a synthetic
  vault, saved a note that survived reload, and a second client read identical
  text. See `docs/history/browser-core-integration-acceptance.md`. The durable editor
  consumer remains disabled; this is not its crash/restart acceptance.
- Native schema6 `28cff13` passed108 focused native/store tests after source
  review fixed historical cross-entry revision reuse, sealed epoch mismatch and
  orphan managed-text binding. Isolated core assembles it as5a5cb46 with
  checkpoints6f0084f and desktopab3a959. Root session99512 exited101 at the
  desktop test that decoded response frames using the strict request decoder.
  Reviewed test-only fix9a2a113 preserves production validation; retry pending.
  Latest source is not on main or combined-pass yet.
- Editor retains NoteBuffer ownership but reports its broad goal, including
  durable/Canvas work, paused by the user in that session. Core must not treat
  the consumer as actively implementing or repeatedly invite paused work. The
  editor has the current bounded test slot for a separate insertion-command
  request. Desktop fixture admission continues independently. CLI sync source
  54929f6 is assembled as660194a; pinned dependencies fetched without changing
  existing package identities, lock1a918a1. Runtime tests remain pending.
  Reviewed physical namespace/schema7 sourcea012eaa awaits its focused slot. Shared contracts
  include stable entry-key checkpoints and best-effort typing mirror arbitration.
  User now accepts shared Rust metadata/index/Base semantics as the next milestone;
  preparation can run alongside this gate, implementation follows its acceptance.
- Actual web/Electron selection, durable editor handshake, complete moves/deletes,
  binary transfer and cross-client encrypted convergence/restore remain required.
  P2P, complete recovery/admin and native mobile remain later milestones.

### Foundation ledger and earlier evidence

The current checkpoint above supersedes the older implementation/next-action
cells below; retain their source and feasibility evidence for provenance.

| ID | Scope / owner | Branch/worktree | Implementation | Verification / next action |
| --- | --- | --- | --- | --- |
| TRACK | Coordinator: goal, decisions, ledger, coordination | `feat/core-sync-foundation` / `.worktrees/core-sync-foundation` | Goal active; isolated branch through `295d3a8` | User transferred main integration to this core coordinator; editor relinquished at `2592ebb` |
| CONTRACT | `/root/data_readiness`: portable contracts and mutation planner | `feat/core-vault-contract` / `.worktrees/core-vault-contract` | Integrated into coordinator as `9d02971`, `54df1af` | 26 native tests passed; independently reviewed; filesystem adapter design next |
| WEB-SPIKE | `/root/mobile_readiness`: IndexedDB worker persistence/tab safety | `spike/core-browser-storage` / `.worktrees/core-browser-storage` | Coordinator `9ca1767`, `6c5d4c6`, `2617b1d` | Chrome155: seven storage checks, 40 worker commits/37 conflicts; two tabs 50 commits/38 conflicts; WASM+IDB replay and fresh-worker restore passed (`f6ec4f4`) |
| CRDT-SPIKE | `/root/crdt_interop`: pinned Yjs/Yrs and WASM | `spike/core-crdt-interop` / `.worktrees/core-crdt-interop` | Coordinator `9b44bb9`, `e9a056b` | Native/Node, actual WASM browser and native↔browser byte exchange passed (`cb63b7f` evidence); idempotency/crypto bindings rebuilt through `74c802b`; actual browser checks passed (`ef687da` evidence) |
| CORE | Coordinator: SQLite native storage | `feat/core-sync-foundation` | `1ed35af` plus `d4191d4`: SQLite authority and v2 projection provenance | Native/store tests passed; filesystem publication now implemented for regular files; namespace extensions pending |
| NATIVE-FS | `/root/data_readiness`: file projection/import/crash recovery | `feat/core-native-vault` / `.worktrees/core-native-vault` | Integrated `d4191d4`; owner implementing rescan/folder-create next | 36 focused native/store tests passed (includes two harness entries), eight publication fault phases plus partial-write/process/late-FD/replay/corruption coverage; full namespace behavior remains pending |
| CLI | `/root/core_cli`: standalone full-vault executable | `feat/core-cli` / `.worktrees/core-cli` | Integrated `c0d8b32`, `1d4e854`; embeds NativeVault directly | Root actual CLI: eight subprocess + one redaction tests passed; mkdir/rescan source `7ca8048` awaits native slice and tests; move/delete/sync incomplete |
| WEB-VAULT | `/root/mobile_readiness`: full-metadata transactional browser adapter | `feat/core-browser-vault` / `.worktrees/core-browser-vault` | Integrated `ca4d157`, `05e60f9`, `d1e5e83`; real Rust planning/replay | TypeScript compile passed; 16 real-browser groups passed; not selected by production app; two-worker concurrency is not full two-tab proof |
| DESKTOP | `/root/desktop_integration`: actual Electron adapter | Read-only main/core audit | Binding and storage seam plan underway | Preserve editor ownership/current recovery; no app integration yet |
| SYNC-PROTOCOL | `/root/livesync_audit`: bounded protocol and AEAD | `feat/core-sync-protocol` / `.worktrees/core-sync-protocol` | Integrated coordinator `49f884a`; independent review issues fixed | Five protocol + six default crypto tests passed, five no-default tests passed; real native/browser crypto exchange passed (`ef687da`) |
| SYNC-RELAY | `/root/livesync_audit`: ciphertext SQLite relay/auth | `feat/core-sync-relay` / `.worktrees/core-sync-relay` | Integrated `295d3a8` from reviewed `d8e0d6e`; cancellation admission flaw fixed | Nine focused tests passed, including actual TCP HTTP; backup/restore source underway |
| VERIFY | `/root/livesync_audit`: independent source reviews | Read-only across worker/coordinator trees | Core planner, CRDT, store and WASM reviewed | SQLite identity/schema checks, wildcard bug and tests fixed; actual browser/Electron/failure gates outstanding |
| LATER | P2P; full history/backups/admin; iOS/Android | Unassigned | Required, not started | Basic encrypted restore remains part of first integrated milestone |

Six workers have independent scopes. Root owns shared Cargo manifests/lockfile.
This core coordinator now owns main integration after the user-authorized
handoff; both coordinators serialize heavy builds explicitly through Orca. Native regular-file projection and standalone
CLI are implemented and tested; the Electron app has not been migrated. Client sync
and distributed namespace semantics remain unfinished.

### Current evidence and next steps

- Native commands: `cargo test --offline -p zorid-core -p zorid-store -j1 -- --test-threads=1`
  passed all 26 core tests; initial store run found an incorrect expected test
  count (five successful operations, not six). Corrected to explicit operation IDs;
  `cargo test --offline -p zorid-store -j1 -- --test-threads=1` passed all 11 tests.
  Review fixes cover rejecting foreign/incomplete databases before WAL mutation,
  SQL/JSON identity consistency, and actual subprocess writer-lock contention.
- Full workspace attempt exhausted disk before tests; removed only task-generated
  targets and set dev/test debug=0, incremental=false. No editor/user data removed.
- Browser strict durability must fail closed; two-tab verification must observe
  real CAS conflicts. Per-key CAS does not prove multi-entry mutation atomicity.
- Yrs 0.28.0 / Yjs 13.6.27 update-v1 UTF-16 fixtures passed native/Node checks.
  Deletion-only updates can leave state vectors unchanged: never use vectors as
  durable revisions or skip exchange based only on vector equality.
- Task-local rustup overlay has Rust 1.95.0 and wasm32 target. Global Homebrew Rust
  1.99.0 has no matching target; select `RUSTC=/Users/ctk/.cargo/bin/rustc` as well as
  task `RUSTUP_HOME` and `RUSTUP_TOOLCHAIN=stable`. Initial WASM build selected the
  wrong compiler and failed before runtime tests; explicit RUSTC fixed it and the
  actual release build completed successfully in 44.89s. Matching wasm-bindgen 0.2.129
  official prebuilt SHA256 verified (`81d4a23d56b3c3eb8187658329116d50e0b228a93b343825fb71f70179051cd1`).
- Current actual browser evidence is committed in
  `prototypes/core-browser/validation/chrome-wasm-2026-10-16.json` and
  `native-browser-exchange-2026-10-16.json`, with exact tested source and artifact
  hashes. All five Rust/WASM checks passed; real native/browser transfer passed
  both directions with duplicates, out-of-order dependencies and deletion-only
  updates. Test tabs and servers closed. These do not prove real app integration,
  browser process/power-loss durability, Safari/Firefox or encrypted sync.
- Native `cargo test --offline -p zorid-crdt -p zorid-wasm -j1 -- --test-threads=1`
  passed four CRDT and three WASM-helper tests before the later idempotency export.
  `cargo build --offline -p zorid-crdt --example interop -j1` passed; executable was
  used in the actual browser byte exchange. Current `d00a617` adds three helper
  tests and browser replay assertions; those need a rebuild/run.
- Protocol/crypto verified native-only in `docs/history/sync-protocol.md`; optional control
  extensions are preserved, unknown required features fail, relay can retain a
  future document format while clients reject unsupported consumption. No-default
  crypto dependency tree excludes implicit system entropy. Actual native/browser
  crypto exchange is verified in `ef687da`; product key enrollment remains pending.
- Root integrated native+CLI candidates through `1d4e854` and ran
  `cargo test -p zorid-cli -j1 -- --test-threads=1`: eight actual executable tests
  plus one redaction unit test passed. Checks include independent invocations,
  exact bytes, stale updates, lost-ACK replay, external nested-file import,
  no-clobber, bounded input, existing-only opens, and commit-with-pending-projection.
- Root built browser vault TypeScript using the existing main checkout compiler:
  `node /Users/ctk/Projects/Zorid/node_modules/typescript/bin/tsc -p prototypes/core-vault-browser/tsconfig.json`.
  It passed without modifying main. Exact IndexedDB schema and content-integrity
  checks were added after review; runtime corruption fixtures passed in `ef687da`.
- Root WASM release build through `74c802b` passed, using the explicit task-local
  Rust compiler noted above. Seven native WASM helper tests passed; the real
  `crypto-interop` example built and five no-default crypto tests passed. Browser
  crypto exchange and all 16 browser vault groups passed; exact artifacts, assertions
  and limits are recorded in `chrome-vault-crypto-2026-10-16.json` (`ef687da`).
- Next: integrate native scanner/folder source, then client update planning and adapters. Native owner
  is implementing recursive rescan/folder publication; moves/deletions follow.
  Full web/Electron/CLI encrypted convergence, accounts/service recovery and basic
  encrypted backup/restore remain required. No app runtime migration has occurred.
- User restarted the editor in Orca and explicitly requested contact. Direct
  acknowledgment received: editor is sole main integrator; core sends reviewed
  ordered batches. Editor accepted the next heavy slot for candidate `1777025`
  tests/type/build and will explicitly release it; core workers hold heavy checks.
  Editor terminal: `term_3496fd0d-d06a-49fc-b79f-b687be61c58a`; core terminal:
  `term_f6b0f772-a4cb-4b2b-af9e-148ed32a072d`. Revalidate live handles after restart.
  Primary checkout coordination docs were read; its three existing dirty core
  tracking files remain untouched. This is peer coordination, not delegated main ownership.

### Client ingestion implementation boundary

The next shared layer is `crates/zorid-client-sync`, owned by `/root/crdt_interop`.
Local mutation request/receipt records are not wire operations. Authored commits
must atomically persist CRDT state, materialized bytes, projection intent and a
new durable sync intent. Received updates atomically merge state, deduplicate exact
envelope identity and advance receive progress without creating authored outbox
records. Sealing commits one immutable envelope before upload; retries reuse it.
External edits need the CRDT snapshot that produced their disk baseline and a
fresh actor for stale-baseline branches, preventing clock reuse and loss of unseen
remote edits. Actor ownership collisions fail closed; random allocation is not a
uniqueness proof. Native v3 scanner work remains independent of distributed moves,
deletes, binary conflict heads and chunked transfers. Plans and tests must reach
actual storage adapters and clients; a single-note fixture cannot complete the goal.

Relay source `295d3a8` passed nine owner tests (one cancellation unit, two actual
HTTP/TCP, six storage) and independent CLI-owner review. Root reconciled Cargo.lock
with `cargo generate-lockfile --offline`, preserving existing pinned versions;
combined root relay build passed all nine tests on `9728064` (session 48628 exit 0). Backup/restore source is assigned to
relay owner: consistent SQLite snapshot, no-clobber new destination, schema/integrity
validation, new epoch and revoked restored device tokens; accounts/permissions and
ciphertext retained. Runtime restore verification is still required.

### Applicable LiveSync reference invariants

The user explicitly permits referencing critical applicable LiveSync logic.
Source audit pinned livesync-commonlib `5f79422c96565ee33f26449668cda2f6d67376f7`;
upstream tests were read, not executed. References are design evidence, not proof
of Zorid correctness:

- [Storage events and reflection](https://github.com/vrtmrz/livesync-commonlib/blob/5f79422c96565ee33f26449668cda2f6d67376f7/docs/storage-events-and-reflection.md)
  and [offline scanner](https://github.com/vrtmrz/livesync-commonlib/blob/5f79422c96565ee33f26449668cda2f6d67376f7/docs/offline-scanner.md):
  recheck stale watcher deletion against current files; lookup failure is unknown,
  not absence. Persist projection provenance so crash replay cannot import an old
  file projection as a new user edit. Preserve intentional reverts/external edits.
- [RPC room](https://github.com/vrtmrz/livesync-commonlib/blob/5f79422c96565ee33f26449668cda2f6d67376f7/src/rpc/RpcRoom.ts):
  transport ACK is not durable application acceptance. Keep outbox until durable
  remote receipt; keep projection intents until filesystem completion.
- [Chunk retrieval design](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/design_docs/chunk_retrieval_and_waiting.md):
  references may arrive before bytes; do not acknowledge complete materialization
  until required bytes are durable. Resume cancellation/retry without lost work.
- [Garbage collection](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/specs_garbage_collection.md):
  Zorid must protect retained history, conflict alternatives and pending uploads;
  do not copy a GC policy that sacrifices retained history. PouchDB revision-tree
  winners/path IDs and text three-way merge are not our CRDT model.

### Shared-main integration coordination

The user explicitly transferred sole main integration to this core coordinator
and requested the editor clean up its main work. The editor relinquished through
Orca at `2592ebb3f6b168d5b0fffdefa3ba042c7a240975`; core accepted. All editor-owned
main work was committed, no heavy processes remained, and only this coordinator's
three tracking files were dirty. Earlier editor-integrator statements are historical.

- Core coordinator owns main integration and the shared heavy-check schedule.
  Editor session continues isolated editor/workspace implementation and review,
  and sends ordered batches with dependencies, evidence and known gaps. No editor
  main writes or pushes occur without a new explicit handoff.
- Shared editor/core interfaces, platform selection, desktop bridges and root
  JavaScript build files require named implementation ownership. Existing editor
  internals remain editor-owned; integration ownership does not permit overlap.
- Before integration, reconcile current main in an isolated candidate and run
  affected checks. Record tested/resulting SHAs. Preserve all unrelated work;
  never stash/reset/clean or blindly stage another session's files.
- Existing named desktop storage scope: `/root/desktop_integration` owns new
  Rust host/runtime files and storage-only `desktop/vault-service.cjs` and
  `desktop/vault-dispatch.cjs`. Existing main/preload/bridge/index/webpack seams
  require exact narrow proposals and coordination before edits.

Next: reconcile the three preserved primary tracking files, then validate the
handed-over core candidate `f44b812` at
`/Users/ctk/orca/workspaces/Zorid/core-batch-one-integration`, including the
reviewed late-divergence recovery-status correction. Editor candidate `4a29e12`
at `editor-base-embed-integration` has scoped checks but no full gate yet.
Core Batch 1 is now integrated; editor candidate remains isolated (latest checkpoint above). Source work continues
on scanner finalization, browser intents, desktop host, client updates and backup.
No heavy process remains after relay test session 48628 exited 0.

## Architecture discussion record

Later steering on 2026-10-16 explicitly opens discussion of app-managed syncable
plugin data, secret storage, and a native mobile shell around the web editor.
The user then said to discuss first and **not change the API design now**.
No storage/sync/secret/mobile API design or runtime replacement is approved by
that discussion. Obsidian plugin API compatibility is no longer required.
The original calendar/task integrations below remain deferred.

Subsequent discussion on 2026-10-16 explicitly chooses a **native-owned mobile
shell with the shared web editor embedded inside it**. Plugins may register
app-owned actions that open plugin web screens. This settles the intended shell
ownership, but does not select native frameworks, decide whether to retain
Capacitor, approve bridge/data APIs, or request implementation. Continue discussing
those boundaries while editor parity work proceeds independently.

The user subsequently selected **Rust for the shared data core**, after comparing
Kotlin Multiplatform and other alternatives. This accepts the language direction,
not a specific storage schema, sync protocol, binding library, API or migration
plan. Those details remain under discussion; implementation has not been requested.

Further requirements accepted during this discussion: device-local data excluded
from sync; seamless setup and automatic conflict handling without routine prompts;
and end-to-end encrypted sync with version history and automatic backups. The
specific CRDT, backend, encryption/key-recovery protocol, history retention and
backup design remain open. Yjs/Yrs and LiveSync have been examined as candidates
and references, not selected as a complete stack.

The user also accepted support for both an official hosted service and an open
self-hostable backend, and the lightweight SQLite backend direction. Backups must
cover all recovery-critical state, explicitly including accounts and permissions,
as well as encrypted content. Detailed database schemas, structured-data sync
semantics, deployment and restore protocols remain under discussion.

Terminology correction from the user: **plugin data** means durable,
non-disposable plugin configuration (for example connection strings, colors and
settings). **Local device data** means disposable state derived from that
configuration, local documents and local state; it can be regenerated and is not
synced. This supersedes the earlier assistant proposal of a durable local plugin
store. Required credentials and unsynced user edits must not be put in disposable
storage. Secret-bearing configuration needs secure handling; any broader durable
plugin-content API remains to be discussed.

The user explicitly approved protected secret storage for sensitive plugin
configuration. Whether individual secrets sync, how they are backed up, and
their access/recovery policies remain open.

Latest scope correction: the user wants a **tight-knit first-party experience**
and an overview of the overall app architecture. Defer speculative plugin content
stores, custom document frameworks, Excalidraw integration and JSONL format design.
Earlier examples are discussion history, not requirements to implement. Keep the
shared core, storage, sync and shell boundaries focused on actual Zorid features.

The user subsequently explicitly requested **P2P live sync** in addition to the
server-backed sync direction. Transport/protocol selection and implementation
remain open. Peer delivery must not be confused with server persistence or an
independent backup. The user also asks about a management web UI for the Rust
backend; serving a web frontend and authenticated management APIs is compatible
with that architecture, without granting the server plaintext content access.

The user accepted an upgrade strategy using shared Rust protocol definitions
without requiring Protobuf. Connections negotiate compatible versions; optional
additive changes remain compatible, while unsupported consequential operations
must not be silently discarded. Transport protocol, encrypted document format and
local database schema have separate versions. E2EE content migration requires a
client-side policy and cannot rely on server-side plaintext conversion.

### Proposed implementation sequence after readiness review

The user now asks whether the overall architecture is ready and what the plan is.
This is a readiness/plan request, not a runtime migration already performed.
Read-only refresh: the app still uses TypeScript VaultAdapter/NoteBuffer storage,
whole-text editor change callbacks, and Capacitor shells hosting the workspace.
No Rust core or sync service implementation was found in the current inventory.

Latest sequencing decision: the user selects **web + Electron desktop** as the
first two sync clients and explicitly requests a **CLI for full headless vault access**.
These are the first delivery targets; native mobile implementation follows their
core/sync milestone. Proposed browser architecture compiles the portable Rust
logic to WASM and injects browser storage/network/key-storage adapters. Browser
SQLite/OPFS feasibility and durability must be tested; the current localStorage
preview adapter is not the production persistence contract. The web client must
own an independent local replica, rather than merely control the desktop replica.

The user clarified that the CLI must access and change **all vault files**, with
changes synced; it is not limited to notes or recognized document types. It uses
the app's shared durable mutation pipeline for arbitrary text and binary files,
attachments, custom formats, nested paths and folder operations. Its surface
covers list/read/search/create/update/import/rename/trash and folder operations,
plus one-shot/continuous headless sync and status, with JSON output, stdin/file
content, stable errors and revision-checked updates. External edits by agent
tools must also be reconciled on watch or rescan, including edits made while the
core is stopped. Existing exclusions for internal disposable caches and protected
secret storage remain; this correction expands vault content access, not implicit
sync of internal databases or credentials. Latest user correction explicitly
rejects dependence on a running Rust core: the CLI embeds and runs its own Rust
core independently, with no required desktop process, daemon or IPC connection.
Shared core means shared library/behavior, not a shared running process. When
desktop and CLI open the same local vault, coordinate mutations through a
designed multi-process storage protocol: transactions, revision checks, durable
change records and bounded locks for file projection/reconciliation. SQLite
locking alone is not a complete solution for in-memory CRDT state and files;
test stale readers, concurrent edits, interrupted projection and sync workers.
This supersedes the earlier single running vault-owner/IPC proposal. Read-only
inspection, pending offline edits and machine-readable sync state need explicit
semantics. A CLI harness helps testing but does not substitute for actual web and
Electron verification. These details are proposed contracts, not implemented APIs.
Acceptance must include binary and unknown-format file changes, folder moves and
deletions, desktop-open concurrency, external edits and offline/restart sync, in
addition to Markdown editing. Binary conflicts preserve recoverable alternatives
rather than claiming arbitrary binary content can be automatically merged.

Implementation waves and parallel ownership (latest requested plan):

1. **Contracts and feasibility.** One core owner defines commands/events, stable
   file IDs, revision/commit semantics, database/file reconciliation, and the
   multi-process desktop/CLI protocol. Agree versioned sync envelopes, durable
   acknowledgements and key enrollment/recovery/revocation architecture with the
   sync owner. In parallel, prove Rust/WASM persistence in a browser worker and
   Yjs/Yrs editor interoperability, including undo/IME. Choose and pin compatible
   formats before production data is written. Test keys are acceptable for
   isolated fixtures, not production enrollment or recovery.
2. **Parallel foundation work after the relevant contracts settle.** Build the
   portable core and native SQLite/filesystem adapter; standalone CLI; browser
   adapter; Electron adapter; and Rust backend concurrently in isolated worktrees.
   A verifier builds crash/replay/concurrency fixtures independently. Start CLI
   local operations before its sync commands, and wire clients to real core
   behavior as it lands. Mocks can unblock UI/API work but do not establish
   persistence or sync readiness. Native-only dependencies stay out of the
   portable core. The first milestone's file model includes arbitrary text and
   binary content, folder operations and external edits, even if the first
   development fixture is one Markdown note.
3. **Integrated web + Electron + standalone CLI gate.** Each web/desktop client
   has independent local state and syncs E2EE through the same backend. CLI runs
   with desktop closed and concurrently with desktop open using its own core.
   Verify offline concurrent text edits, binary byte preservation, unknown file
   formats, rename/delete/folder cases, external tools, failed writes/restarts,
   two browser tabs, duplicate/reordered delivery, authorization and mixed
   versions. Verify editor undo/selection/IME in the actual app. Pending edits,
   local commit, server persistence and backups must have distinct semantics.
   Run these as successive integration checks (text first, then file lifecycle,
   then binary/unknown content), not one final large merge. Prove a basic encrypted
   backup/restore round trip before introducing real user data; automated backup
   scheduling and administration can follow in wave 5.
4. **Shared document semantics in Rust (accepted 2026-10-16).** After wave3
   acceptance, implement portable Markdown metadata extraction (properties, tags,
   headings, links and task records), revision-aware rebuildable indexes and
   backlink/search queries, then Base definition parsing/expression/query semantics.
   Current TypeScript behavior inventory, shared fixtures and API contracts can
   be prepared in parallel with wave3; do not replace app parsers during its
   storage/recovery integration. Migrate web/WASM, desktop and standalone CLI
   consumers incrementally against the same behavior fixtures. Keep live editor
   syntax parsing, Markdown rendering and Base views in the web editor. Files
   remain authoritative and invalid source remains saveable/syncable; indexes
   are disposable local state. See `docs/shared-document-semantics-plan.md` for
   acceptance, ownership and implementation order. Native mobile document/query
   feature integration consumes this shared layer rather than duplicating it.
5. **Parallel expansion after the integrated gate.** Separate owners add P2P
   discovery/authentication/relay fallback; retained encrypted history and
   coordinated off-host backups; hosted/self-hosted onboarding and administration
   UI; and native iOS/Android shells. Core owner coordinates checkpoint retention,
   long-offline rejoin, durable configuration and secret policy. Key and restore
   design begins in wave 1 even though full recovery UX lands here. P2P must work
   alongside server delivery without duplicate mutation. Mobile must prove native
   bindings, keyboard/selection, permissions, lifecycle and process-death recovery.
   Independent P2P/backend operations and native shell scaffolding may overlap
   wave4 after wave3 passes; native metadata/Base features depend on wave4.
6. **Release and migration gate.** Verify account/vault isolation, enrollment and
   key recovery, revocation-safe clean-server restoration, compatible upgrades,
   rollback and migration of existing vaults. Restore backups of accounts,
   permissions, ciphertext and recovery-critical configuration, not just notes.
   Run real browser/Electron/mobile checks and independent security review of
   E2EE boundaries before production rollout. Preserve existing vaults/recovery
   drafts until their migration is verified.

### After all six stages: seamless stale-editor draft merging

Direct user instruction (2026-10-17): defer this until all six stages above are
complete. Preserve the existing retained-draft/recovery-copy UX meanwhile.
This deferral concerns stale local editor buffers, not existing normal CRDT
replication or the first milestone's no-loss concurrency/restart requirements.

Use the existing Yrs merge machinery. The missing bridge must retain the original
causal document witness for the editor baseline, derive the user's edit delta
against that state, and apply it to the latest core state without treating unseen
remote text as a deletion. Reconcile the resulting buffer while preserving active
typing, selections, composition and local undo behavior. Draft checkpoint,
authored mutation and recovery acknowledgment must stay consistent across
interruptions. Never implement this by replacing an expected revision with the
latest revision while submitting the same stale full buffer.

Acceptance should include independent CLI/sync edits while typing, insert/delete
overlap, undo/IME/selection, repeated concurrent changes, interruption/restart and
missing baseline history. If safe merge cannot be established, retain the current
recoverable draft and both document versions.

Proposed ownership boundaries (new paths are proposals, not existing crates):

| Owner | Primary scope | Dependencies and boundaries |
| --- | --- | --- |
| Core/storage | `crates/zorid-core`, native storage adapter, schema and multi-process coordination | Own shared types and migrations; reconcile stale in-memory state and file projection |
| CLI | `crates/zorid-cli`, CLI contracts and tests | Calls core library directly; no desktop/daemon requirement and no duplicate persistence logic |
| Browser | WASM bindings, browser worker, durable browser adapter | Validate cross-tab ownership/coordination, quota failures and restart persistence |
| Electron integration | Native binding and desktop adapter | Preserve authorization and recovery; coordinate shared bridge changes |
| Backend/sync | Protocol implementation, encrypted relay, account/device/vault authorization | Core owner owns client apply/commit semantics; shared protocol changes reviewed together |
| Verification/integration | Cross-client, multi-process, crash/recovery and version fixtures | Independent acceptance evidence; serialize heavy jobs and integrate coherent reviewed work |
| Existing editor session | Editor behavior and parity | Retains ownership of editor/workspace internals; CRDT integration coordinated through one agreed seam |

Use isolated branches/worktrees. One integrator owns root build manifests,
lockfiles and shared entrypoint changes to avoid overlapping edits. Integrate
reviewed, validated changes into main incrementally; keep unfinished work
isolated. Serialize heavy builds/full suites on the 8 GB machine. No speculative
plugin framework or calendar work is added to these waves.

User direction recorded 2026-10-16: discuss the following only after the editor
base is solid. These are deferred requirements, not approved architecture or
current implementation claims. Continue editor behavior, split views and
verification first; the later discussion exception above supersedes the earlier
discussion restriction only for the explicitly raised architecture topics.

- **Default Zorid sync:** use [Obsidian LiveSync](https://github.com/vrtmrz/obsidian-livesync)
  as the requested model, with setup that is very easy for users.
- **Built-in calendar:** use [FullCalendar](https://fullcalendar.io/).
- **Integrated tasks and calendar capabilities:** use
  [TaskNotes](https://github.com/callumalpass/tasknotes) as the requested capability
  reference, including tasks, two-way Google Calendar sync, task Kanban views,
  and broader task/calendar functionality to discuss at that stage.

These links record the user's references. Their APIs, licenses, compatibility,
deployment needs and feature boundaries have not yet been assessed for this work.
