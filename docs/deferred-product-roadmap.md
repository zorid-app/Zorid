# Product discussions after the editor foundation

## Execution checkpoint — shared-core coordinator

Updated 2026-10-16. Read this section before resuming after a context reset;
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
built-in goal. An active goal now targets the first integrated Rust core + web +
Electron + standalone full-vault CLI + E2EE server-sync milestone. This is not a
claim that implementation or validation is already complete. Subsequent P2P,
full history/backups/admin and native mobile milestones remain required in the
sequence below; completion of the first goal must not close those requirements.

### Resume procedure and status rules

Latest reuse review: the user explicitly requested evaluating Etebase before
expanding custom sync/E2EE infrastructure. `livesync_audit` owns the source-based
comparison; `crdt_interop` independently reviews Yrs transport and security
lifecycle fit. Current Yrs/RustCrypto primitives remain in use; no backend switch
or migration is approved. Compare complete requirements, including browser/core
portability, independent CLI, durable ingestion, key recovery/revocation and
encrypted restore; library encryption alone does not establish protocol safety.
The completed source assessment is in `docs/etebase-reuse-assessment.md`;
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
artifact: `docs/livesync-edge-case-matrix.md`. Record audit scope and uninspected
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

### Integration checkpoint — 2026-10-17 09:35 local

Current authoritative update (older bullets below record preceding stages):
- Main `5d29c53` now integrates native candidate292cd27 and normal desktop
  create/save candidatea29605b plus idle-child cleanupc06d110. Main tsc31928
  exited0 and four focused creation checks passed; crates/Cargo sources exactly
  match the built native candidate. Actual fresh CLI14-record receive, nested
  text/binary hashes, deleted-path absence, rebuilt Electron New note/save,
  simultaneous-open CLI upload and browser exact receive passed. Electron92846
  quit normally exit0. See browser-relay-verification.md for scope and hashes.
- `core_cli` owns the next serialized recovery check: binary extension3aab341
  in an isolated candidate, then existing metadata/permission snapshot checks.
  Mixed namespace obligations and external-edit imports remain isolated follow-ups;
  these are not included in the successful runtime claims above.
- Main `517f87b` includes reviewed browser ancestor-publication fix and hashed
  smoke assets. Actual worker nested create/reload/read and encrypted upload
  passed; see `docs/browser-relay-verification.md`. Old failed database is
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
  with21 wrapper tests. No core heavy checks until editor explicitly releases.
  New user-authorized Canvas/Bases UX work is active; NoteBuffer remains paused.
- Editor acknowledged the handoff and reported Canvas session70192 as its live
  handle via `msg_8a891d676c3e`; wait for explicit slot release before core builds.
- `be8bfc3`/`90e7b91` integrate source-reviewed retained-binary and classifier
  WASM bindings after21 native wrapper tests (session45875 exit0). New exports
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
  each passed all38 file-sync tests. These pure helpers do not prove filesystem
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
  candidate `a72e13c` passed 108 tests (session60597 exit0), including known-note
  clean-client recovery. Evidence: `portable-family-integration-acceptance.md`.
  Browser admission `cdd6b49` passed 47 focused tests/full TypeScript in its
  reviewed source candidate; actual browser lifecycle proof remains required.
- Root pinned WASM build session43081 exited0 at source `f79a294`; native
  wrapper tests passed15. Actual Chrome fixture `6f3ade8` passed all10 groups,
  including authenticated family updates and raw transport decoding. Evidence
  committed as `a78770b` in `docs/wasm-family-browser-verification.md`. Test tab
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
  candidate `8ba5c55` passed 158 native/store/host tests, session12395 exit0;
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
  exit0. Real CLI processes converged offline text through a loopback relay;
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
  candidate `3df1de8` passed 109 tests in a fresh target (session30255 exit0),
  covering folder creation, bounded rescans and coherent reads/change cursors.
  See `docs/core-integration-acceptance.md`. Apps still use existing storage;
  no migration, push or deployment by this session.
- Editor candidate `6b96d1f` passed 29 focused and 1963 aggregate tests,
  TypeScript and production webpack (three performance warnings), session64815
  exit0. The stale parser-tree bug has eight verified fail-before regressions;
  source fix `a8cfb75` equals editor `dfbfae7`. Native Base property writes and
  horizontal/vertical Canvas edge resizing persisted on that build; a draft
  committed on blur without loss (focus retention unproven). Audio playback
  remains unverified: its accessibility label alone does not prove failure. Evidence
  `cc55574` is on main; owned Electron exited0. Tested dist is in
  `editor-base-embed-integration`, not the primary checkout's older dist.
- Isolated core `b510194` passed the entire Rust workspace in dedicated
  target-verification: session34798 exit0, 201 passes, one ignored crash helper
  explicitly invoked by its parent. Includes schema5 host intents, text plans,
  file/namespace/chunk plans, authenticated envelope capability, relay and basic
  backup/restore. SQLite unsigned conversions and two invalid test setups were
  corrected before this pass. These are component/process tests, not real app
  convergence. WASM crate native tests do not substitute for browser execution.
- Backend foundation is integrated on main at `04bf12b`. Candidate `91694d3`
  passed 28 protocol/crypto/server checks including managed backup/restore
  (session65524 exit0); no-default-features crypto passed 8 including its doc
  test (session5557 exit0). Offline lock resolution preserved existing pins.
  See `docs/backend-integration-acceptance.md`. The server remains a loopback
  fixture: hosted enrollment, admin UI and deployment are unfinished.
- Web foundation is integrated on main `c369571`. Candidate8eb89de passed
  focused9 and full2005 app tests, typecheck, ordinary production and explicit
  fixture builds. Ordinary build excludes fixture assets. Actual Chrome passed
  host27 and WASM6 groups; the real app production worker opened a synthetic
  vault, saved a note that survived reload, and a second client read identical
  text. See `docs/browser-core-integration-acceptance.md`. The durable editor
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
- Protocol/crypto verified native-only in `docs/sync-protocol.md`; optional control
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
