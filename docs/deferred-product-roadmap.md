# Product discussions after the editor foundation

## Execution checkpoint — shared-core coordinator

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
runtime gates; see [final acceptance](shared-core-milestone-acceptance.md).
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

### Integration checkpoint — 2026-10-17

Current update — 2026-10-17 21:31 UTC (supersedes older pending statuses):
- Subsequent21:43 checkpoint: native-only fixturehost bbe26f1d passed actual
  nine-case check54202 (compile1m48s/test0.71s), source integrated maind94c3ae3.
  Log copied to tmp/stage4-host-fixture-run1.log. This does not prove successful
  relay/FFI/simulator/phone sync. Root reclaimed compiler slot, no compiler live
  while current Base group-token source freezes; mobile owns no active Xcode.
- Current isolated root candidatee97d5bf9 composes Base context+frame-error/null
  guards, search+released-owner fix, typed-date display, retained-row edit witness
  +provider atomic rename and deferred pin-close handling. Combined frontend
  check1925 passes91/91, full TypeScript79631 exit0 (before final pin follow-up).
  Reviewer source gates pass for these slices. Last presentation gap: Kanban loose
  equality merged distinct Rust keys; contract owner adds opaque existing-canonical
  keyId fields, Base owner projects them, renderer owner uses them through moves/
  hide/order and fixes inert nested file/link labels. No TS formula regrouping.
- Native owner may merge current canonicalmain863 into isolated recovery only
  under named resolution grantmsg_e4d21dcde2bd, preserving Stage4 guards/capabilities
  and scoped native hooks. Main remains root-owned. Its phonebuild5 is signed
  ready but uninstalled until actual CoreDevice connectivity; simulator hotfix
  proof and separate outstanding keyboard/PDF presentation are recorded in findings.
- Subsequent21:36 checkpoint: native facade21944 exit0, all6 tests PASS,
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
  browser backlink removal also PASS. Main full frontend typecheck7046 exit0,
  focused document/browser/desktop/backlink/workspace tests24094 PASS48/48.
  No Rust engine changes since recorded native/WASM proof. Final merge commit
  records these gates; remaining search/Base migrations keep Stage4 active.
- Candidate39a306e7 actual production browser/IDB full suite PASS18.235s, then
  page-reload cache PASS, watermark12/rawBytesPreserved:true. Actual WASM
  Markdown49/49 and Base51/51 remain verified with matching binary provenance.
- Normal rebuilt Electron UI PASS: shared backlink shown, Source navigation,
  editor save removes backlink; independent physical Source exact42 bytes.
  App8635 exited0 and closed. Normal web bundle87821 exit0, server52415(port8767):
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
  process live. Full frontend tsc18913 exit0; desktop app webpack70127 exit0,
  but normal desktop UI has not yet run. Temporary node_modules symlink removed.
- New actual browser evidence: WASM63741 exit0 (official1.95, release/j1,
  2m35s). BinarySHA2566c67442d272195269eb2d92e723c3fc8fd92e237c33c9368e046a92134903256.
  Chrome real-worker Markdown49/49 +4 malformed checks PASS, downloaded actual
  results independently pass verify.mjs. Real-worker Base51/51 +5 request checks
  PASS after explicit missing-graph unavailable fixture decisionf76fa1bf
  (root88a5ee9f); historical TS unsupported observation preserved. No engine
  change or WASM rebuild for that fixture correction. Reports/results retained
  tmp/stage4-browser-document-{report,results}.json and
  tmp/stage4-browser-base-{report,results}-run2.json; failed run1 retained too.
- Current native query12117 passes3 tests including all10 accepted queries and
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
- Actual desktop transport now passes: run33242 exit0 in1.86s with freshly
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
  passes1/1 (remaining four facade cases passed run2); CLI34144 passes3 indexed
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
  dependencies prefetched67204 exit0 without building. Do not assume a recorded
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
  rebuilt Electron saved79 exact bytes through default Rust, read independently
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
  preserve the exact34-byte fixture (hash in native-progress-verification.md).
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
- gRPC proof compiled16543exit0 and passed actualChrome and nativeHTTP2 clients
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
  independentCLI/physical41,819bytes exact. App21921 normalQuitexit0. See
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
  TypeScript9653 exit0, desktop production23356 exit0 and3 targeted workspace/
  platform tests5743 pass. Actual no-opt-in Electron4610 uses aggregate dist and
  default-discovered host on fresh /private/tmp/zorid-incomplete-ui-us4yx3m4:
  257dirs show persistent incomplete warning/details with zero imports, rather
  than an apparently empty ready vault. Removing only agent-created emptydirs
  lets automatic polling import Visible.md and clear the warning; exact note
  read through UI. Explicit retry was not proved because polling completed first.
  Normal app-menu Quit4610 exit0 confirmed; no test app remains.
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
  and bounded-diagnostic check passes1/1; CLI/host build7548 exit0.
- Retained actual fixture now reconciles ExternalTools->ExternalRenamed plus
  text edit and binary-child deletion through the rebuilt standalone CLI.
  Folder/text IDs unchanged; exact33textbytes hash
  4c229322000382c309ae5e2e6bdb8d14b4dfef5afb4237fcb018063385258b9c,
  deleted binary absent from live list. Independent restart/rescan is complete,
  zero imports/namespace/issues. Original CLI/recovery-copy hashes unchanged.
  Report /private/tmp/zorid-compound-reconciliation-1017.json. No test Electron
  process was present. Diagnostic activation remains isolated until UI wiring
  joins it; do not copy its changed host into main before that coherent batch.
- Browser rebuild9631 exit0 (webpack6.074sec, unchanged Rust cache). Actual normal
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
  Actual test app72273 normal Quit exit0 confirmed; no test app left running.
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
  Authorized B exact33 bytes, persisted-scope conflict, unauthorized A-scope denial
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
  exit0; database recovery is not claimed. Lock fix source independently approved;
  data_readiness granted minimal sqlite_lock_tests gate before other native runs.
- User confirms creation works but rename fails. Actual `native_namespace_pending`
  matches incomplete adapter connection; desktop_integration full-file command
  slice owns fix and subsequent rebuilt UI proof.

Historical first-milestone acceptance snapshot (2026-10-17; superseded by
the current checkpoint and [final acceptance](shared-core-milestone-acceptance.md)):

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
  f53a6b5 recovery54884 exit0: clean CLI restored exact text and 262163-byte
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
