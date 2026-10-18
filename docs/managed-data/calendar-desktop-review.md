# U: Calendar desktop independent review

Final verdict: APPROVED for scoped desktop Calendar integration at assembled runtime freeze e6910442724510666f823cb85222a03b8f4d86bb. All identified source, harness and visual gaps are resolved. Independently checked24 focused cases and the actual3-process UI proof, including all5 final screenshot pixels; no remaining blocker in this scope.
Reviewer dispatch ctx_a2ec5d15f34f; implementation C dispatch ctx_cda0bb2b5600.
Only this report is reviewer-owned; no source/index edits, builds or application launches.

Baseline is accepted desktop WorkBlock binding proof65a2dfdb; unchanged codec is not re-audited. Scope includes Calendar controller/view/CSS and exact Workspace hooks, pinned community dependencies/notices, and preserves native371 toolbar initialization and notes/editor/unsupported-platform routing.

Early finding sent C msg_d5939cd6c645 and coordinator msg_8c4145938937: application document of pnpm12.14 multi-document lockfile has duplicate YAML keys for temporal-polyfill, temporal-spec, function-bind and get-caller-file; snapshot-only dependency entries copied into packages and temporal-utils lacks package resolution metadata. HEAD lockfile parses as two documents with no errors; initial working edit parses as two documents with six duplicate-key errors. C must repair before freeze. These were live-edit observations, not a final verdict.

Local installed FullCalendar7.1.3 package metadata/README confirms v7 fullcalendar/* plugins and explicit skeleton/theme/palette CSS; temporal-polyfill1.0.6 is pinned in proposed package edits. No network queries were needed.

Early controller/view review:
- Controller retains original mutation operation/target/revision and frozen request through uncertainty, shares per-service controller across views, and blocks flush while pending. Window aggregation splits <=31days, requests <=64/1MiB, bounds128 pages/8MiB and compares watermarks plus duplicate-block content before publishing.
- msg_921b380bd78e: view initially did not call changes(), so external focused-app writes did not trigger refresh; datesSet did not invalidate selection read serials; refresh used removeAllEvents plus addEventSource and accumulated source ownership. C asked to add focused regressions and native change polling disposal.
- msg_2c28e095ff78: local calendar currentStart persisted via UTC toISOString date slicing, shifting month to previous month in positive offsets. Requested local date anchor and positive-offset restore coverage.
- msg_b47b06247b27: standalone Monarch CSS mapping omitted actual border/strong-border/muted-foreground/faint-foreground variable names, supplying unused reversed foreground-muted/faint names. Asked to verify actual theme variable references and rendered light/dark/narrow results.
- Subsequent lock edits now parse as2 documents with no errors, first manager document structurally unchanged, and exactly7 Calendar/transitive package and snapshot additions in app document. Final frozen check still required.

Later concrete findings/evidence:
- msg_1a5f6e7c4e3e: Workspace openNote from Calendar inherited reading mode and toggle-reading still targeted Calendar. C reports correction using non-note reset and kind guard.
- msg_43846372c359/msg_9ff753556964: 513ASCII title through actual CalendarController + B createDesktopWorkBlocks rejected invalid_workblock_request with commitUncertain=false, calls=0, yet controller.state.pending=true. This blocks cancel/flush/revision until repaired. UI must validate UTF8 <=512 and known definite codec rejections must clear pending.
- Polling initially replayed history from0 at64 per5s and falsely cleared freshness status before catching head. Requested rendered watermark baseline or bounded draining/backlog status.
- First focused Node run of calendar-controller.test.ts + calendar-view.test.ts:15/17 pass. Existing-event selector test failed finding v7 event anchors; uncertain-retry test failed because successful Retry left editing/form open and flush still threw. Sent C exact failures, including required acknowledged-retry form cleanup. This is DOM/library source evidence only, not CSS/Electron acceptance.

## Frozen source review 1cec325f

C froze implementation at1cec325fa095481f8acf9cdfc25a7e2b4541260a atop accepted B proof65a2dfdb. Independently reran `node --test --test-concurrency=1 tests/calendar-controller.test.ts tests/calendar-view.test.ts`: **21 passed,0 failed**; `git diff --check` passed. Working tree was clean at this source checkpoint. C reports65 combined Calendar+existing Workspace checks, full frontendTS+Vite desktop build and frozen pnpm install success; these broader checks/builds were not rerun by reviewer.

Resolved findings at this source:
- Lockfile parses cleanly as2 documents; pnpm-manager document is byte-identical. App document adds exactly7 package and7 snapshot nodes with no structurally changed existing package/snapshot entries. Pinned community fullcalendar7.1.3 and temporal-polyfill1.0.6 use published v7 subpath plugins/theme/skeleton CSS. Seven checked-in license notices match installed package license bytes.
- Calendar is injected only from actual PlatformVault.workBlocks. Undefined service renders a clear unsupported-platform message; production contains no memory service, fake task list or Google placeholder. Test fixtures are isolated test code. Task joining remains deferred to real Rust query.
- WorkBlock create uses generation===operation as agreed native contract. Mutation target, opaque revision bytes and whole signed-decimal range are retained unchanged through uncertainty; no silent rebase or automatic replacement operation. Known definite local codec errors clear pending and UTF8 titles over512 bytes reject before pending admission. Acknowledged retry closes the owning form; unknown errors remain conservative.
- Range loader splits42day grids into<=31day native windows, with64record/1MiB pages, bounded128pages/8MiB aggregate, same continuation budgets, watermark equality, duplicate identity/content checks and stale-request serial fences. It publishes no mixed/exhausted aggregate. No global native limit is raised.
- Shared per-service5s change polling seeds from a complete consistent window watermark, advances monotonically despite late polling replies, refreshes listeners and marks failed freshness checks visibly. Last unsubscribe stops future timer work. Existing service release drains native calls; view destroy invalidates serials and removes observer/focus/subscription ownership.
- Events preserve every range candidate and expose conflict details. Conflicted events are not draggable; explicit field saves explain replacement of alternatives. Drag/resize always reverts optimistic library state and opens a cancellable review form with a fresh read/revision check before an actual command. Keyboard-accessible add/forms and actual v7 focusable event markup provide alternatives.
- Native371 hideNativeEditorToolbar initializer is untouched by Calendar diff. Workspace adds destination/tab/session/lazy-render/command/flush/dispose/cached-view fields; editor-only command routing remains guarded. Notes opened from non-note destinations retain default Live Edit, and Calendar is excluded from note-mode toggles/menus. The coordinator must preserve the current main native initializer when composing/rebasing rather than assuming this branch establishes current native parity.
- Local view state persists local-zone calendar date rather than UTC date slice; DST skipped/ambiguous form times reject. Actual Monarch variable names are mapped to app colors. CSS visual claims await rendered proof.

Coverage gaps explicitly requested as focused tests-only successor: held inspect followed by date navigation and late result, plus multi-range conflict interaction/drag cancellation. These are task-critical transition evidence; existing source guards read correctly. Actual Electron/Rust execution, persistence/reopen, light/dark/narrow layout, split resize and full keyboard interactions remain native/rendered acceptance gates. Reviewer opened no application, ran no build or network call, and changed no source/index.

Frozen source file Git blobs:
```text
100644 blob 284588fa5cd5943adbd94f4e148b11ee15162e8b	package.json
100644 blob 05def45eec6892433b4a8ded961c9819c0aaaa41	pnpm-lock.yaml
100644 blob a18bd6a0ad4f822cfea5c06088323077ffc5766f	src/calendar/controller.ts
100644 blob ed787883a2f2282331ba02fe9ee0d1355099434d	src/calendar/styles.ts
100644 blob 3d57d10c4fddcd7f0454b6535b95760a588ada9c	src/calendar/view.css
100644 blob 38cb1db016b585ed272abb246a81c3dd415f4e3f	src/calendar/view.ts
100644 blob c145cd860c6a51ae54575c93aaee31de63d897c6	src/ui/hotkeys.ts
100644 blob 6ca1e111eceeb4a37ffa7725f07bd3070c685fbd	src/ui/workspace.ts
100644 blob c8c808f951b47d9e341618ef168f4a20aff29f2c	tests/calendar-controller.test.ts
100644 blob b45b8beec35c3477a3b5ff5990da552e480a171f	tests/calendar-view.test.ts
100644 blob c07376ab10d1a621f67a8572e2f35963bda11646	third-party/notices/fullcalendar-7.1.3/LICENSE
100644 blob c07376ab10d1a621f67a8572e2f35963bda11646	third-party/notices/fullcalendar-core-7.1.3/LICENSE
100644 blob c07376ab10d1a621f67a8572e2f35963bda11646	third-party/notices/headless-calendar-7.1.3/LICENSE
100644 blob da5389a93cbaa3ffcde17e2c76df6cb850912477	third-party/notices/preact-10.29.8/LICENSE
100644 blob efd1ff8bce045599f4a08c3503f45671b0539328	third-party/notices/temporal-polyfill-1.0.6/LICENSE
100644 blob 22626d03d77c6685f4e598d07a4df1cb012921cd	third-party/notices/temporal-spec-1.0.1/LICENSE
100644 blob efd1ff8bce045599f4a08c3503f45671b0539328	third-party/notices/temporal-utils-1.0.3/LICENSE
```

## Tests/report successor91cbf8d0

Exact successor91cbf8d04dad33f7bd5601d1a266191b2a351cbb changes only tests/calendar-view.test.ts and docs/managed-data/calendar-desktop-results.md; all runtime source remains1cec325f. Durable owner report read and scope/limits agree with observed source/evidence. Independently ran only the three added cases using `node --test --test-concurrency=1 --test-name-pattern='held source inspection|all conflict alternatives|library move and resize' tests/calendar-view.test.ts`: **3 passed,0 failed**, bringing independent Calendar evidence to24 passing cases (prior21 plus these3). `git diff --check` passes. This closes the requested focused stale-selection/conflict/callback-cancellation evidence gap; emitted library callbacks do not establish actual pointer interaction.

All source findings are resolved. Native/full rendered acceptance is still pending; exact source/build provenance and actual light/dark/narrow screenshots, operation results and reopen proof have been requested from coordinator before final verdict. No reviewer source/index edits or builds/apps were used.

Successor evidence blobs:
```text
100644 blob 176b8bb6ce587f7f11427d0642886a0403253cee	docs/managed-data/calendar-desktop-results.md
100644 blob bb56cee609246dca61d868ae9c45cf56d9f4f029	tests/calendar-view.test.ts
```

Coordinator followup msg_df5889244a32 (2026-10-18 02:58UTC) confirms source approval already permits assembly; no dependency cycle. Accepted F+Calendar composed as2d1d93dc with owner-reported fullTS/30 query+Calendar focused passes and matched native build. First actual bridge-only pass found Electron Error metadata stripping; B/R own an explicit-envelope fix. U is now additionally assigned read-only source review of C's new calendar-electron-integration harness and will then assess actual rendered proof on the new exact freeze. No additional app launch is authorized to U, and unchanged tests/builds must not be repeated. The earlier source approval is not native acceptance and does not supersede this discovered cross-boundary issue.

## New actual Electron harness early review

C supplied tests/calendar-electron-integration.cjs (msg_8fd60c6e8869), not run by U. It drives normal desktop/main/preload/Workspace with fresh owned vault/profile through3 actual app processes, normal DOM controls/keyboard and sendInputEvent gestures, then reopen/delete/reopen. App/source/dist/native hash guards and fail/quit watchdog cleanup are present; no private Workspace injection or service stubs are used. Native dialog overrides only fail the test and avoid leaving modal dialogs.

Concrete harness proof gaps sent C/coordinator as msg_294490877d7e: assert final.Title is the requested edited title rather than merely comparing reopen against self-captured baseline; require fixture event presence in each view instead of ignoring null eventElement; wait both split panes loaded before screenshot; hash the harness itself and reject untracked relevant-source files because git diff alone misses those. This harness does not inject/test unknown acknowledgements; keep its UI result separate from B's actual metadata/uncertainty bridge result. Waiting corrected harness freeze and actual output; no launch or build from reviewer.

Corrected actual-proof harness source APPROVED at9379b17c41ada492cb2be17b1612d8cff6622c91, SHA25631a2e8ce0d6990d97217078233d4c59bc4863a114e0f9bd1e9f2c633de4baa65. All reported harness assertion/provenance gaps are closed. Source diff/check reviewed only, no launch or repeat build/test. C/root notified source-ready for the owned runtime pass after B/R metadata fix proof and exact new source/native/dist freeze; actual UI output remains pending.

Coordinator runtime authorization msg_2c5ddaad9e51: B's separate3-launch actual metadata/storage proof passed and its owned apps/native processes closed. C is authorized to run the reviewed harness against exact frozen assembly86a1c1a92808048e69f32c42460f6b3d95ca3e95 (harness cherry-pick only; frontend unchanged from6e915a3d, native62c6fc58 reported stable/matching). No duplicate app/build is permitted or performed by U. Actual Calendar output/screenshot review pending; this B result is coordinator-reported and separate from Calendar authoring/rendering acceptance.

## First actual functional run (visual gap retained)

C explicitly confirmed all3 app processes passed and owned Electron/native processes were closed (msg_7fa3d39a12d4). I read all phase JSON and report and inspected all5 screenshots at:
`/var/folders/yc/__symlbx5zxd7v1vhwh84z180000gn/T/zorid-calendar-proof-lFPpAm`.

Report actual outcomes: normal Workspace/real admitted Calendar creation; intended title Calendar proof edited; atomic12:00–13:30 America/Toronto range; real sendInputEvent move proposed12:30–14:00 and resize proposed12:00–14:30, both cancelled and original range retained; all4 view modes contained fixture; normal split; exact title/range/timezone survived process quit/reopen; explicit delete and deletion survived another process reopen. No fake service/private Workspace entrypoint. Electron44.8.0, Chrome152.0.7977.167.

This is a functional PASS on frozen86a1c1a92808048e69f32c42460f6b3d95ca3e95; the visual claim is limited. Dark month and delete-confirmation layout are coherent/readable; narrow controls wrap and remain available. The purported light-list screenshot is actually a stale DARK Appearance modal frame obscuring Calendar, so it does NOT establish light visual acceptance even though phase JSON passed. The narrow event label also clips midword. Sent exact findings promptly C/coordinator (msg_188bab214eb3/msg_35eabae681d5), retained original artifacts and did not modify them.

C capture-only6059e0cb source correction reviewed/approved (SHA256495627c447f99c48e1b33f246a5e094e17757b79a1d56a9f1e76e4201db769ac): focus owned window, double RAF, warm capture, wait and re-RAF, record/assert theme/modal/background state. Actual product modal selector is correct; first frame is a compositor timing gap. C small product presentation0bb82e5668c8da409471fe105170d9bfc3d6d9cf reviewed/approved: scoped label span/class, native title tooltip and width-bounded nowrap/ellipsis, with fullDOM text retained; no storage/mutation/lifecycle changes. Coordinator owns one frontend rebuild and new frozen actual pass. Light and corrected narrow visual verdict pending that evidence.

First report SHA256: 50d56dea15faecfdbbf96f8afaab5d0aefb7c7bc3b45cccc839d13c5c6c6edb5
Provenance:
```json
{
  "commit": "86a1c1a92808048e69f32c42460f6b3d95ca3e95",
  "source": "37fa7947bb23cc335e6faa44c6481152ac733f7943724439ad6cf4618b4a8e8e",
  "desktop": "27dc5c5967ab8bbeb629f6204769973808f079517118d7dfcf4f9c3c21ea9e6b",
  "dist": "865a83e0e8b843726450167bc564ac3af2f97ed7ad891335cd9a5280dc40b718",
  "native": "62c6fc58b742a23c52b75919a9d8ef94474f81232a51b2ce3775a9d6957ba405",
  "harness": "31a2e8ce0d6990d97217078233d4c59bc4863a114e0f9bd1e9f2c633de4baa65",
  "package": "76ae369a62766d91a124ac70d6b3d93a7a0859db9d69305b6403af6c89f5569a",
  "lock": "6d97823375a0130ffaf1b7fbf86544a53ef740a298cf7e57945fa169626def7a"
}
```

## FINAL actual evidence verdict — e6910442

Final approved assembly: **e6910442724510666f823cb85222a03b8f4d86bb** in managed-desktop-integration. C runtime source is1cec325f plus presentation0bb82e56; tests/report91cbf8d0, original harness9379b17c and capture-only6059e0cb are independently reviewed. Calendar source directory was directly byte-compared with assembled target and matches. Main native371 toolbar initializer was not edited by C; apply the scoped Calendar patches during main integration and preserve main's current native-owned initializer rather than copying an entire older desktop Workspace file. This desktop proof does not validate mobile/strict-eight-field native behavior.

Final raw report:
`/var/folders/yc/__symlbx5zxd7v1vhwh84z180000gn/T/zorid-calendar-proof-Ofm3Vp/report.json`

Report SHA256: **a486207c62b3f3f05151a3b02de828c9fad17cf3014736362fda76e29a837724**.

I read the full3phase report and all final screenshots. All3normal Electron processes passed. C explicitly confirmed clean exit and verified no owned Electron/native processes remained (msg_b11df891e569). Independent recalculation confirms source, desktop, dist, package, lock and harness hashes match the report and current HEAD is the exact frozen commit. Native hash matches the coordinator's accepted matching build; no native binary compilation was performed by U.

Observed acceptance:
- Normal Workspace/real admitted Rust-backed WorkBlockService readiness and UI creation/title save/one atomic whole-range save.
- Actual keyboard event activation and real pointer move/resize review+cancel. Both proposals differ from original, then the saved12:00–13:30 America/Toronto range remains intact.
- Correct intended title Calendar proof edited and exact displayed range/timezone survive app quit/reopen. Explicit delete confirmation/Keep block precede final delete; deletion survives a second process reopen.
- Fixture event appears in month/week/day/list; normal split creates2 Calendar grids; secondary Calendar closes and app exits through normal lifecycle.
- Actual light-list screenshot is white, readable, no modal; actual dark-month has readable grid/event controls; actual dark narrow split wraps controls and uses clean ellipsis instead of midword clipping. Full event title remains available in DOM/tooltip/detail. Confirmation form shows saved title/timezone12:00–13:30 and distinct Confirm delete/Keep block actions. Deletion-reopen screenshot is an empty loaded day view.

All5 final images were visually inspected; the original lFPpAm light screenshot remains explicitly invalid and retained, not relabelled or silently counted as success. Final screenshot hashes:
- author-dark-month.png: `9d2ddd5b173f3a5af406dae86865e16edc944bdab971429f45ff6787cc869ff2`
- author-dark-narrow-split.png: `127a2ffbe453da04a3a737f04192cc9529b40c2ef191c76ca2e0cafb70a97687`
- author-light-list.png: `9802cfaca6acbe0cbbe40ddb0672f961a1b35700de512691831aa975a0af1a3e`
- reopen-delete-delete-confirmation.png: `f8a4f5630041c82fdcccde38fba34ef8a9e3092d675977e8efd5414a6f3bd234`
- reopen-deleted-deleted.png: `fd39408de57e21dbb7b6a8afa8ed3d201d77277c29ee7a2c860d7b7e7dbcc989`

Exact final provenance:
```json
{
  "commit": "e6910442724510666f823cb85222a03b8f4d86bb",
  "source": "0d66a579f15e788ae0c027d4f389bec70f80e5f5d1308500ee05175e8d9b853e",
  "desktop": "27dc5c5967ab8bbeb629f6204769973808f079517118d7dfcf4f9c3c21ea9e6b",
  "dist": "8f96956d065f86f048eabbc1d7bf22ae9726364ef4da0e9e2e70395ef1ba47eb",
  "native": "62c6fc58b742a23c52b75919a9d8ef94474f81232a51b2ce3775a9d6957ba405",
  "harness": "495627c447f99c48e1b33f246a5e094e17757b79a1d56a9f1e76e4201db769ac",
  "package": "76ae369a62766d91a124ac70d6b3d93a7a0859db9d69305b6403af6c89f5569a",
  "lock": "6d97823375a0130ffaf1b7fbf86544a53ef740a298cf7e57945fa169626def7a"
}
```

Remaining claim boundaries:24 independent focused Node/DOM cases establish the exercised source state transitions; final actual UI proof uses one synthetic standalone block and3processes. It is not dense-calendar stress, arbitrary race coverage, full assistive-technology auditing, forced-crash draft recovery, encrypted multi-client convergence, browser activation, native mobile or reference parity. This UI harness does not itself inject unknown acknowledgements; Calendar retention/replay has focused tests and B/R's separately accepted actual bridge metadata/storage proof. Task joining/unscheduled tasks await the real Rust query/UI stage; no checkbox reinterpretation, raw-ID task editor or Google placeholder was introduced. Main integration remains coordinator-owned and is not performed by this read-only reviewer.

Reviewer changed only /tmp/zorid-calendar-desktop-review.md, no repository source/index, no build and no additional app. Source/harness/test/evidence review is complete and no requested review work remains.

## Durable final report freeze3ab0d5e8

Coordinator requested final durable report/raw review in msg_0e217bbed1a4. Reviewed docs-only3ab0d5e8 and expanded docs/managed-data/calendar-desktop-results.md; its scope and acceptance limits agree with the observed source and pixels. Durable initial/final JSON files were independently byte-compared to their original artifact reports and are identical; final raw SHA remainsa486207c62b3f3f05151a3b02de828c9fad17cf3014736362fda76e29a837724. Newly documented actual native path /private/tmp/zorid-calendar-native-2d1d93dc/zorid-desktop-host was independently hashed and matches62c6fc58b742a23c52b75919a9d8ef94474f81232a51b2ce3775a9d6957ba405. Runtime target remains e6910442;3ab0d5e8 changes only durable reports, not tested source/assets. Final scoped Calendar verdict is APPROVED; no further runtime launch, build, source edit or review work is required from U.
