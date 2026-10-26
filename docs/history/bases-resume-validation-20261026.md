# Bases resume validation — 2026-10-26

Fresh CLI and browser/WASM campaigns pass. The first native safety and recovery
runs fail; subsequent rich-property and full three-protocol recovery campaigns
pass on their separately identified sources below. Safety remains incomplete.
This record preserves the earlier failures and describes completed runs, not
later fixes or whole-feature acceptance.

## Initial source and build identity

The runtime checkout was frozen at
`9c6088b3e9c015369e5bc4e1791a2709272cb4f2`, on the isolated
`codex/types-bases-model` branch. Native/CLI and desktop frontend receipts name
build source `4453e584a16b3c7fa3cd0b834feea63b7fb1cada`; the subsequent commits
before the runtime freeze only add documentation. The Rust tree is
`07265b1d344e89cd84c2fae143c4c4ab8678c2ca`.

The desktop build, including TypeScript checking, and cached native/CLI build
finished successfully. The focused composed run passed **63 tests, zero failures
and zero skips**. This is not a new full Rust-suite result.

| Product or receipt | SHA-256 |
| --- | --- |
| Native desktop host | `403cbeb86da2d0279cd919134bd3ebc53cd95b21b9303e5581b6a08fce2d3c99` |
| Standalone CLI | `8e4e61e4f158f0bfcc1a40286f9a3f677ecabc741ffba680a901721b4246f42b` |
| Native build receipt | `42a1f9b4e34cc56d8ecbfe8c7533b283a433b1078e0543d46332c3ca19e106aa` |
| Frontend receipt, 333 files | `52dd4948c4c90a739e0f19a2bf8998150dc7bfa6226e1dd025a82738c14322d5` |
| WASM JavaScript | `81c4a5c09ada24257106eaadeaafb46032ec0de7a947f7bee0d2352ed0e6a0c1` |
| WASM binary | `c1298e7c89384cb754a6a488238451beee9cd97050a97981b5c72564361510cc` |

Original receipts and native executables are under
`/private/tmp/zorid-bases-20261026-products-001/`. The browser runner independently
checked its current Rust fingerprint
`c46bb16d3a51f6b7dcf9a46e5ee118ab912c9b451ce3a4f255c0caa08ce81fde`;
it did not build or substitute an evaluator.

## Standalone CLI — pass

Session 99317 completed **125 commands and 17 checks**. The report verifies the
supplied build source's Rust/Cargo trees against the checkout and the supplied
CLI hash. The host is associated by hash but is not executed by this campaign.
The ten Q3 checks include **162 typed row-value expectations, 16 Q3 diagnostic
entries and ten legacy-context diagnostic entries**.

The process exits are 121 expected successes, two expected exit-3 cases and two
expected exit-4 cases; every child has a null signal. An independent retained-file
audit verified all **250 stdout/stderr streams, 29 stdin files and 54 exports**
against their recorded hashes. No Electron app, desktop host or daemon was run.

Report:
`/private/tmp/zorid-bases-cli-20261026-001/zorid-bases-cli-NPuDb9/report.json`.
SHA-256: `17c33308ed6c80077a5d7258b713aeae29b319bcd515e831440bc0f37a3a7e81`.

## Browser/Worker/WASM — pass

Session 30342 completed **all 19 planned groups**, with no unexecuted groups,
runner error or artifact failures, using owned headless Chrome
`156.0.8078.47`. The ten Q3 groups use the same committed typed expectations.
A separate read-only comparison of their retained result payloads against the
authored fixtures verified all **162 typed row values**; it did not rerun the
semantic implementation.

The owned Chrome process exited with code 0 and null signal after cleanup's
SIGTERM request. Its disposable profile's absence was confirmed, the Vite server
closed, and the report records deletion of the fixture database. Three worker
requests and three worker target observations were retained. The campaign's two
explicit deferred gates remain: rendered/full-app UI, and mobile/other-browser/
sync/stress acceptance.

Report: `/private/tmp/zorid-bases-browser-20261026-001/report.json`.
SHA-256: `7db733130cdc82ce24ca3dbf672db142eaddfbe80b171738e6747901866f04e1`.

## Native safety — setup failure

Session 41873 stops at **seven actions and one check**. After submitting Split
right, the automation clicks the A explorer row approximately 13 ms later. The
final DOM contains two Bases and no ordinary editor; the wait for editor A fails.
This run does not establish which internal navigation stage caused the outcome,
and none of the later conflict, partial-bulk, registry or embed scenarios ran.

Owned cleanup reports `SIGTERM-cleanup`, exit 0, null signal and no leaked
children. Before/after source and artifact manifests are identical. An independent
audit matched their 837 tracked source hashes to Git blobs at the frozen commit
and their 333 distribution hashes to the frontend receipt.

Report: `/private/tmp/zorid-bases-safety-20261026-001/result.json`.
SHA-256: `c7eb527d647d2d4c54a2edfea97f12f2b4d7287ae794cf55e3e3aa338deac3d8`.

## Native recovery — first protocol passes; later continuation fails

Session 7413 stops at **28 actions and 24 checks**. Its first protocol passes:
the owned lock-access failure produces a genuine failed checkpoint
acknowledgement; the newer summary draft remains visible; one original retry
continues the exact newer B source automatically. Whole-source/unrelated-file
checks and a fresh-process readback pass, including two normal quit checks.

The second protocol holds the acknowledgement of genuinely committed A
(`values.length`), accepts newer B (`values.sum() + 7`), requests close, then
releases A. The visible B draft remains with the closing error. The campaign's
subsequent ordinary focus/Tab action does not persist B: the final physical
`Recovery.base` still contains A. This record does not attribute the failure to
a particular event handler or assert that the closing latch is stuck. The
remaining lost-New-reply protocol is unexecuted.

The first two app lifecycles are already exited with code 0 and null signal.
The last requires `SIGKILL-cleanup`, null exit code and signal `SIGKILL`;
all three cleanup receipts have no leaked children. Before/after source and
artifact manifests are identical; the same 837-source/333-distribution-file
independent audit passes. Forced cleanup is not a successful normal quit.

Report: `/private/tmp/zorid-bases-recovery-20261026-001/result.json`.
SHA-256: `ceb58b7decd8111d4714705badacb48961f807cd2008b3c6eb69fcde4e044752`.

## Later rich-property campaign — bounded pass

Properties session 22470 passes **188 actions and 65 checks** on frozen source
`9e589589218d2f8723332c274af9f364905bfb12`. Frontend 002 was built at
`74dcc2a9368471b07b12b49f2f09515cf394be4b`; the intervening commit only adds
documentation. Its receipt, `frontend-receipt-002.json` in the products directory,
has SHA-256
`9fa54f89db3d72ef5dce7a796ca3c939f1eab27334bd58149f29c440ea6afafe`.
The native host and Rust tree remain those listed above. This run predates the
later enhanced-editor Tab/blur fix and does not verify that fix.

The campaign covers text/tags/plain links, select and multiselect option creation
with unknown-value preservation, status, relation add/remove with aliases and
unresolved links preserved, and durable edits across Table, Cards, List and
Kanban. It verifies actual Kanban membership after a status save. Derived
read-only presentation is inspected in all four layouts; negative pointer/Enter
attempts are exercised in Table, not all four layouts.

The C1 summary scenario selects one shared custom definition through four
independent references across two views/properties. Blank/colliding rename guards
preserve source, and rename/delete update all four references while preserving
unrelated custom and built-in selections. Final note/registry byte and Base
configuration oracles, six fresh-process source/configuration checks, and both
normal quits pass. This does not claim every Base formatting byte was authored
independently in advance.

Both app cleanup receipts report already exited, code 0, null signal and no
leaked children. Before/after provenance matches; an independent audit verifies
837 frozen Git blobs, 333 frontend-002 hashes and all six final physical sources
against the recorded restart checks.

Report: `/private/tmp/zorid-bases-properties-20261026-001/result.json`.
SHA-256: `b026bcc4878e6cd782f4cd55e0909c7318b71e6e2695681a05e49265e30b5b0c`.

## Later safety attempt — row-count setup failure

Safety session 87569 uses the same frozen source/frontend 002 and stops at
**six actions and one check**. Its split-ready helper expects row count 3. The
visible fixture has a header, two result rows and a summary row; the frozen
renderer counts that visible footer, implying count 4. That explanation is an
inference from source and the screenshot/text, not a captured native row-count
attribute. The readiness wait fails before any A-row click or note-body input.
This does not exercise the subsequent conflict/recovery scenarios or establish
a product failure from those scenarios.

Owned cleanup reports `SIGTERM-cleanup`, code 0, null signal and no leaked
children. Source/artifact provenance matches before and after; the independent
837-Git-blob/333-frontend-file comparison also passes.

Report: `/private/tmp/zorid-bases-safety-20261026-002/result.json`.
SHA-256: `b38878531b3d0e29ee569be05cedc2203f3c2f459d319df90d2c449451e0e431`.

## Later native recovery — all three authored protocols pass

Recovery session 42961 passes **36 actions and 36 checks**, including all three
authored recovery protocols, on frozen source
`16cd01e57402fd0cac4751d4c3dd5623dd6cc92b`. Frontend 003 was built at
`a8086315dbe95e26a6cbaea935ba2e1f38f93a0a`; intervening additions are checkpoint
documentation and the normal-web test harness, without product frontend changes.
Its receipt, `frontend-receipt-003.json`, has SHA-256
`44b4c0d1a2abf5f0df620601d6a1d1bde9bef465a64e82d1fd673f5bba6b70a3`.
The native host/Rust tree remain unchanged. The associated composed summary
recovery tests also pass **19 tests, zero failures and zero skips**.

- The genuine checkpoint-access failure retains newer B; one original retry
  automatically continues the exact B source. Whole-source/unrelated-file and
  fresh-process readback checks pass, as in the first protocol of Recovery001.
- The held committed-A acknowledgement, newer B and close request retain B.
  After A is released, the explicit close-guard retry path uses ordinary
  focus/Tab to save the exact B source; a later close retry occurs only after
  durable acknowledgement. The relay records exactly two preparations and
  successful commits for the exact A/B bodies. A fresh process reads B back.
  This exercises the conservative retry route, not an automatic-B-close claim.
- The genuine create acknowledgement is deliberately dropped after the native
  commit. The test explicitly interrupts its owned app, then starts a fresh
  process and verifies the original create receipt replay, the same file
  identity and one exact full-template copy. It does not claim same-mounted
  transport reconnection, arbitrary crash or power-loss recovery.

Five app lifecycles finish through normal quits with code 0, null signal and no
leaked children. The one intentional lost-reply negative fixture uses
`SIGKILL-cleanup`, null exit code and signal `SIGKILL`, with no leaked children;
it is not counted as a normal quit. Before/after source/artifact provenance is
identical. Independent retained-file checks match 837 frozen Git blobs, all
333 frontend-003 hashes and the last saved source for each of eight physical
fixture files. These results do not relabel the earlier failed Recovery001 run.

Report: `/private/tmp/zorid-bases-recovery-20261026-002/result.json`.
SHA-256: `362a06deb7f6ef3c150e98946258f134850fea1f80be4c37bae83933c024e74c`.

## Safety003 — four scenarios pass; path-reuse feedback stops the run

Session 73430 stops at **107 actions and 22 checks** on frozen source
`36dad4c1fc228658b54fe74959974966917b72d9`, with frontend 004 built at that same
commit and the unchanged native host. The frontend-004 receipt has SHA-256
`38090c09df2df8f0bdc8d5664958f82b1fa8707861d68a5806948ff2a809d18c`.
The recorded scenario statuses are four passed, one failed and eight unexecuted.

The four completed scenarios cover shared dirty-body/property saves and
conditional history; partial bulk failure, undo and recovery; stale property
settings; and stale live-summary configuration with newer input. In particular,
the partial clear durably saves `score: null`, publishes its blank cell, preserves
the conflicted B file, and passes subsequent recovery/clear/undo checks. This is
bounded partial-clear acceptance after the explicit freshness setup. It does not
replay the original stale-physical `7null` merge interleaving or establish a full
safety campaign pass; the source-guard regressions remain separate evidence.

The fifth scenario types `8`, retires the original `Replace.md`, writes a new
identity at that path, then submits the stale editor. At failure, its screenshot
shows the retained `8`; the captured cell has `mod-error` and its nested input is
`aria-invalid`, while the page displays the generic durable-request error. The
captured role-alert list is empty, and the wait for visible
stale/changed/replaced/conflict feedback fails.
A separate post-run physical audit confirms both authored files remain exact:
replacement score `6` and retired original score `3`. Those physical observations
do not make the failed visible-recovery assertion pass. The remaining close-guard
steps in that scenario and all eight later scenarios are unexecuted.

Two preceding normal quits have code 0, null signal and no leaked children.
Final cleanup requires SIGKILL, null exit code and no leaked children.
Before/after provenance is identical; independent comparison verifies 837 frozen
Git blobs, 333 frontend-004 hashes, the original fixture hash at the retired path,
and the complete authored replacement source.

Report: `/private/tmp/zorid-bases-safety-20261026-003/result.json`.
SHA-256: `429e2131462eca4f0ae33996eaa6d357871959c863459970bfef0685871103d0`.

## Typed Filter002 — String cases and partial list round-trip pass

Session 58096 stops at **315 actions and 99 checks** on frozen source
`292cf8bb61c79528ed08d13648dd5e39cfe586e9`, using frontend 003 and the unchanged
native host. All 15 String cases pass their source, membership, reopened-control
and clear assertions, including zero results. The following `list-exact` case
passes source/membership/reopen checks and the remove/re-add type/shape checks.
Its subsequent close wait fails with the Filter panel still mounted.

The last dispatched input is Escape after re-adding the list item. An early
Escape before acknowledgement is a timing hypothesis: the actual panel/ACK state
at that key dispatch was not recorded. This is not proof of a product close bug
or a completed list scenario. Remaining typed cases and restart acceptance stay
unexecuted. Owned cleanup is SIGTERM, code 0, null signal and no leaked children.
Before/after provenance matches, including independent verification of 837 Git
blobs and the 333 frontend-003 hashes.

Report: `/private/tmp/zorid-bases-filters-20261026-002/result.json`.
SHA-256: `c4bbf7b531ac342e892b08f24ba7cab9dcd0b4ed2437aae1c633e3182c39982e`.

## Normal web001 — module-load failure before Workspace acceptance

Session 7720 fails before any input or any of the five authored normal-web phases
executes, on frozen source `16cd01e57402fd0cac4751d4c3dd5623dd6cc92b`. The actual
browser exception says `/desktop/conditional-saved-source.cjs?import` does not
provide the named export `captureSavedSourceGuard`, while loading
`src/platform/desktop-note-plan.ts`. This is distinct from the passing browser
Worker/WASM semantic fixture above: normal Workspace startup was not established.

Owned Chrome PID 21982 exits with code 0 and null signal after normal close is
requested. Vite close resolves, HTTP listening is false and cleanup failures are
empty. The campaign retains its owned Chrome profile separately; the archive
excludes that directory. Final provenance verification passes. An independent
read-only audit matches 385 tracked and 441 Rust-input hashes to frozen Git blobs.

Report: `/private/tmp/zorid-bases-web-20261026-001/report.json`.
SHA-256: `9ac1ec68eb04dcf51193a60f7a320135b282285db1df11ef230342e3597287fe`.

The subsequent Vite-boundary and staging fixes are integrated as `5dca58ed` and
`332f0f50`. Their composed boundary test run records **four passed and one failed**:
the Vite test cannot bind `127.0.0.1` under its sandbox (`EPERM`). A separate
focused Vite rerun with the required execution access passes **one test, zero
failures and zero skips**. That focused pass neither rewrites the earlier failed
run nor establishes a successful normal-web UI or packaged-app runtime.

Logs: `/private/tmp/zorid-bases-boundaries-composed-20261026-001.log`
(SHA-256 `2ae3b47d210031b9984fa539c7e4edc3bd2edd679e7ba6dca49c1ed00e02ed43`)
and `/private/tmp/zorid-bases-vite-composed-20261026-002.log`
(SHA-256 `172038ee19ebfaf6926fd240af56a1d6a2d222499e39a4ee092ed84cd7b370b5`).

## Safety004 — changed-file feedback passes; failed-edit cancellation blocks

Safety004 stops at **110 actions and 22 checks** on frozen source
`c1cc76c1034108b10d7c28eb4f3da40f4a559110`, using frontend 005 and the unchanged
native host. Four scenarios pass, the fifth fails and eight later scenarios
remain unexecuted. The first four are the same shared-body/history, partial-bulk
recovery, property-settings CAS and live-summary CAS scenarios recorded above.

Within the fifth scenario, the actionable changed-file message appears, both
replacement/original physical sources remain exact, and input `8` is retained.
After Escape and an attempted navigation, the editor remains in error/draft
state and configuration is blocked with a finish-or-cancel message. The run stops
waiting for Configure property topics. Native focus at the Escape dispatch was
not recorded, so loss of focus is a separately reproduced causal explanation,
not a captured key-time fact from this run. The normal close-guard portion of
this scenario does not complete here.

Two preceding normal quits finish with code 0, null signal and no leaked
children; final cleanup is SIGKILL with null exit code and no leaked children.
Source/artifact freeze verifies. Frontend-005 receipt SHA-256 is
`05bbe88c8588631381f17b3fa65d038b77db99ca35c7531122fa67acfba1d0ce`.

Report: `/private/tmp/zorid-bases-safety-20261026-004/result.json`.
SHA-256: `a1b85decf2391e35768919754323f5ea7654dabd2d9f8816b45b3cdd6850f0f0`.

## Safety005 — five scenarios pass; named-reference retry stops the run

Session 54587 stops at **135 actions and 24 checks** on frozen source
`c483d861be0cbec9d361aa0a55d0f6ae669414d9`. Frontend 006 was built at
`c48a217aec74f026632753a887916e216c9e446f`, including TypeScript checking and
333 distribution files. Later changes before this run are test-harness changes,
not product renderer changes. Its receipt has SHA-256
`a5bdf20ae31dcaa6e7eae71298c4e3f061112fcf2adf736e690ce4fe1fb74db3`.

The first **five scenario statuses pass**. The newly completed fifth scenario
records the rejected scalar's exact `8`, enabled/invalid draft state and actual
keyboard ownership immediately before one Escape. That single Escape dismisses
the failed editor. The unapplied property-settings draft then blocks closing,
remains intact, and can be explicitly cancelled before a clean close. This is
bounded native verification of the focus/cancellation fix, not retroactive
acceptance of Safety004.

The sixth scenario acknowledges the Base view rename and its independent clean
reference update, retaining a retry for the dirty reference. It then cannot find
the expected Save recovery copy control in `.native-document-notice`. Captured
UI instead contains the retained view-configuration error and Retry save button;
the failure does not establish the cause of the missing notice. Dirty-reference
recovery/retry and all seven subsequent scenarios remain incomplete. In
particular, the new genuine C2 checkpoint-fault relay is present in this source
but its later publication scenarios have not executed.

Two normal quits finish with code 0, null signal and no leaked children; final
cleanup is SIGKILL with null exit code and no leaked children. Before/after
provenance is identical. Independent audits of Safety004/005 match 837 frozen
Git blobs and 333 distribution hashes each, and verify both the retired original
and authored replacement bytes. Safety005's captured pre-Escape focus frame is
also checked directly.

Report: `/private/tmp/zorid-bases-safety-20261026-005/result.json`.
SHA-256: `2b08fd967ad95d270321dfa5b4b8a2faab03a0f31ff2093798a09f344e4409c0`.

## Normal web003/004 — observer failures; no completed five-phase pass

Normal web003 uses frozen source
`f39653204fce9c64131dab51b3b562a8fd7459d5`. It reaches the normal Workspace and
issues one New note action. The create-and-rename phase then fails because its
read-only observer insists on an existing version-6 database. A separate static
source audit establishes the supported streaming contract as **version 8 with
31 stores**; this is a source-contract observation, not a retained successful
database snapshot from web003. The other four phases are unexecuted.

Normal web004 uses frozen source
`c483d861be0cbec9d361aa0a55d0f6ae669414d9` with the reviewed streaming observer.
Its control flow advances through the initial note/source check and dispatches
five normal UI actions: New note, title focus, select-all, title text and Enter.
It then fails in the renderer-evaluated rename/focus readiness expression with
a SyntaxError at column 609. No phase completes, the four later phases are
unexecuted, and the stored observations array is empty. The screenshot/diagnostic
shows the requested title and normal editor, but does not establish the missing
durable rename/focus assertion or whole web acceptance.

Both Chrome processes exit with code 0 and null signal. Vite close resolves,
HTTP listening is false, cleanup failures are empty and final provenance verifies
for each run. Both owned profiles are retained separately and excluded from the
archive. Independent audits match each run's 385 tracked and 441 Rust-input
hashes to its frozen Git source.

The reviewed streaming-observer change has **25 focused tests passed, zero
failures and zero skips**. That source-level result does not turn either failed
web run into a pass.

Reports and SHA-256:

| Report | SHA-256 |
| --- | --- |
| `/private/tmp/zorid-bases-web-20261026-003/report.json` | `721dd58f1fc96678ec9fa35bb0a1287f9f64afaae1c33322e93342beddf7d0fc` |
| `/private/tmp/zorid-bases-web-20261026-004/report.json` | `3613ccf20d22556ac32585bca25a9518191c1e03e74778dda3e60279bff6b56d` |

## Durable local archive

To survive temporary-directory cleanup, completed evidence and native products
are copied into the implementation worktree's ignored
`tmp/bases-validation-20261026/`. The compressed archive contains **486 retained
original regular files**, totaling **57,731,042 original-file bytes**, plus an
embedded snapshot manifest. It includes the four reports,
provenance, screenshots, owned vault/relay/CLI evidence, product receipts,
executables and seven launch/build/focused-test logs. Both disposable Electron
Chromium profile directories are explicitly excluded. No proprietary reference
artifacts, user browser profiles or symlinks are included.

Every included original file is hashed before and after archiving, without
mutation; every compressed member is then read back and hash-verified. The
manifest records original absolute paths, archive member names, sizes, modes
and hashes. These are local retained artifacts, not tracked project source.

| Local artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `fresh-validation-001.tar.gz` | 19,910,416 | `43fbd8c1536e746c3ccaf904170199b0c00837e29cb377277db558e19adb0e88` |
| `fresh-validation-001-manifest.json` | — | `ba222ae124e9efe34d351ef93dd61dfefa32e468e8c05d52648b1551bb4341c7` |
| `independent-content-audit-001.json` | — | `ee424904c90dc5a9f68602564b8d339b0c03cd5dd7764a22de324630c15eb439` |

Part 001 remains unchanged. A separate part 002 retains the completed
Properties001/Safety002 reports, provenance, screenshots, owned fixture data,
three launch/build logs and frontend-002 receipt. It contains **85 original
regular files, 12,366,126 original-file bytes, plus an embedded snapshot
manifest**. Both corresponding disposable Chromium profile directories are
excluded, and the same original/member hash verification passes.

| Additional local artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `fresh-validation-002.tar.gz` | 2,044,438 | `6db4614644f4eb138397ca347163bdee4578aa8660c8bfa505d940ce3d849baf` |
| `fresh-validation-002-manifest.json` | — | `e59d0c522c9c85255d4c18267b72411e7598d9499a663e18dcf09218275bd529` |
| `independent-content-audit-002.json` | — | `649b8c81c2ce87be8c03fc962b968c66c1c7ab38c84b13a61f842e2335ba5fa6` |

Part 003 separately retains completed Recovery002 evidence, the frontend-003
receipt and three launch/build/focused-test logs: **26 original regular files,
2,703,629 original-file bytes, plus an embedded snapshot manifest**. The owned
Chromium profile is excluded. All original/member hashes verify, and both earlier
archive parts and their manifests remain unchanged.

| Additional local artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `fresh-validation-003.tar.gz` | 759,858 | `180a260d7ef2f69a6e2563460434d299f2043a7e88bf8e8d51ff4e5adf30b99d` |
| `fresh-validation-003-manifest.json` | — | `021f39d1b96039871840f40305784641c0a9fe8c6c4e877883662031878fecd6` |
| `independent-content-audit-003.json` | — | `dc6943b6ae3b9cc6c2a1fa3ce954148e3d30cf4e72a338c3990e659916d77f5b` |

Part 004 retains the completed Safety003, Filter002 and normal-web001 evidence,
frontend-004 receipt and six launch/build/boundary-test logs. It contains **94
original regular files, 9,571,849 original-file bytes, plus an embedded snapshot
manifest**. All three owned profile directories are excluded. Original/member
hashes verify, with parts 001–003 and their manifests unchanged.

| Additional local artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `fresh-validation-004.tar.gz` | 2,182,572 | `5d7506935c38b505a853eea065f3390b165a2e92bdd89a391a45030b356a9740` |
| `fresh-validation-004-manifest.json` | — | `5511b4c43eb006963139cebf2da94e62fcb8c6d0f86ad2af5537d3fdffaeb9fe` |
| `independent-content-audit-004.json` | — | `0160d1c3be20a4b46a0c9b62e413c5231d9c2d6cf71602d3b166dc5557475648` |

Part 005 retains the completed Safety004/005 and normal-web003/004 evidence,
frontend-005/006 receipts, five existing launch/build/focused-test logs and the
static streaming-schema source audit. It contains **160 original regular files,
19,440,240 original-file bytes, plus an embedded snapshot manifest**. All four
owned profiles are excluded. No saved launch logs existed for Safety005 or
normal-web004; none are reconstructed. Original/member hashes verify and all
four earlier archive parts/manifests remain unchanged.

| Additional local artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `fresh-validation-005.tar.gz` | 4,922,260 | `65e0fa88eee14cbcf0d953e03045f75f3876a1c2fe5e4c0acb4fb5b8c1294784` |
| `fresh-validation-005-manifest.json` | — | `e168306d5c495841d3fd18caf309addefb89cbb82ce9b2aa399be2e177391ebf` |
| `independent-content-audit-005.json` | — | `7a75bd7e9cb16fe4ee9d4713fa67b014bb4cd7880f62810e905d6865c24f5e3c` |

Full archive directory:
`/Users/ctk/Projects/Zorid/.worktrees/types-bases-model/tmp/bases-validation-20261026/`.
Full native safety, heavy-user, visual/reference, normal-web and final integration
acceptance remain separate. The passing recovery result covers its three authored
protocols only. No main merge or completion is claimed.
