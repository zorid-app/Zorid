# Store original-intent adapter independent review

Review owner: `term_14a30a1f-d756-4393-bfcf-5ad804e31ed2`, task
`task_8241d6d5ec1d`, dispatch `ctx_4ef93249788f`. Scope is this new document
only; no source, public API, compiler, tests, apps or main mutation. Integration
belongs to root. Source owner is `term_86d19693-a193-4149-bf35-439dccb61a49`
in `managed-origin-store-adapter`, assigned by coordinator message
`msg_fa5eb72a13ce`; shared edits require an exact inventory freeze and subsequent
coordinator grant. This review is active, not an implementation approval.

## Evidence freeze

Canonical source read at `aab1d5c833e8476b135e1049f8043726dabc82f2` on
2026-10-18. Review checkout remains `6d8252713dfb8273ae012b6b865635a779872d13`;
missing current files were read from canonical main, not inferred from this old
checkout. Roadmap execution checkpoint and relevant user-findings guidance were
read. SHA256 values below describe canonical Git blob bytes:

| Path | SHA256 |
| --- | --- |
| `docs/managed-data/origin-intent-decision.md` | `5ef13c2b969a45c468a86cd73155bec8663664622dcbe7948d72bd312ec8b25f` |
| `docs/managed-data/origin-intent-contract.md` | `14a5a48ed1edd45288f86716ecb5c33c4374a85391b8bc6b3d70e1053d9675f7` |
| `crates/zorid-records/src/local_intent.rs` | `d8f77c2ed11fc39c42626562512b217bf42d4013ed74adcf8b75c2286d8d4cf8` |
| `crates/zorid-records/src/workblock_service.rs` | `6a1535cf7b7bdde0fda9f04f240359167571e57dd0a616aecb00008367e2e439` |
| `crates/zorid-store/src/checkpoints.rs` | `49bd7b16cda1ba39347186f854c904363094288575a6a25d9f14dfca8589812a` |
| `crates/zorid-store/src/managed_records.rs` | `4081dd4632383bfb51c304fad8c37651f238583dadf22eced401d81fe91d7504` |
| `crates/zorid-native/src/client_admission.rs` | `20bb2b812cec2580eb9e6a6d792eb04bc43efca8dd6830542babdae5e254de5f` |
| `crates/zorid-native/src/workblocks.rs` | `a742139d61f9bacbb567a197b4d773d77b39bc9ad2c00d488ad5a241687d5ebf` |

## Initial exact boundary inventory

These are observed seams for comparison with the implementer's proposed
inventory, not edit grants or selected replacement signatures.

| File/API | Concrete observation and required boundary |
| --- | --- |
| Store `managed_records.rs`: `ManagedRegistration`, `registered`, `authorize`, `portable` | Current registration stores realm/vault/owner/schema without lineage. New origin-aware paths must obtain full compiled validated registration, without treating caller registration or handle revision as original semantic identity. Existing private Store/process/key/revision handle plus enrollment checks remain mandatory. |
| `managed_apply` (line 480) | IMMEDIATE transaction authorizes, compares journal request before state load, then prepares and atomically writes state/source/change/authored/journal. Preserve this ordering and common publication logic. New retained path needs exact canonical intent request, live checkpoint and registration fence in that same transaction. |
| `managed_snapshot`, `load`, `check_restore`, retry/receive paths | Existing accepted-state, receipt summary, incoming wire and retry behavior must remain coherent. Avoid changing generic incoming registration semantics merely to add local origin retention. |
| `checkpoints.rs`: `checkpoint_load`, `checkpoint_compare_and_swap`, `checkpoint_list`, `checkpoint_changes` | All four need reserved-client denial. List/changes share `checkpoint_page`; load/CAS share physical `scope` validation, which currently checks only local Store identity. Private helper must not accidentally reuse a public reserved denial or expose an internal bypass to callers. |
| Checkpoint `load`, `high_water`, CAS mutation | Existing head/history validation checks exact latest head, byte counts, deletion consistency, retained revisions and contiguous global sequence. Extract a narrow caller-transaction helper preserving these invariants, UUID revision uniqueness and FULL durability; do not invoke the public nested-transaction API. |
| New capture/apply/pending/settle API types and lib exports | Final exact names/types/export hunks await source-owner inventory. Caller sends immutable input or ref, never trusted origin bytes; Store derives physical authority and reserved namespace. Scope includes restores even though checkpoint operation key intentionally does not include record/generation. |
| `zorid-native/src/client_admission.rs::claim` | Ordinary client admission lives outside Store; Store has no client-claim registry. Existing canonical UUID validation does not deny reserved UUID. A separately named native admission owner is necessary before any complete isolation claim. |
| `zorid-native/src/workblocks.rs::execute_workblocks`, `workblock_apply` | Existing service calls raw `managed_apply`; lease/session checks occur above Store. Preserving current-v1 adapter while adding source-only retained Store APIs cannot establish complete old-apply bypass closure or actual consumer-lease enforcement. Later explicit transport/admission cutover is required. |
| `local_intent.rs` pure helpers | Full canonical authority/ref/scope/origin/witness/raw/semantic bytes, historical prefix validation and no-row `require_fresh_origin` already exist. These helpers authenticate no caller and issue no durable evidence. Production compiled catalog remains v1; v2 trust stays test-only. |
| `workblock_service.rs::command_for_new`, `command_for_replay` | RemoveRef new capture observes accepted tags once. Repeated capture must find journal/pending first and use retained raw command; recomputing tags from current state changes original semantics. The transient old tuple used inside pure semantic verification does not authorize persistent old-format fallback. |

## Concrete risks to resolve in inventory and implementation

1. **Publication versus retirement.** Checking checkpoint before opening the
   apply transaction permits settlement to retire a held plan and apply to
   publish afterward. IMMEDIATE must cover current authorization, exact live
   capture head/body, journal check and publication. Retirement must inspect
   journal and exact-head CAS in its own single IMMEDIATE boundary. Apply-first
   returns original committed evidence to reconciled-uncommitted settlement;
   retirement-first prevents fresh publication. Synchronous SQLite needs no
   artificial asynchronous plan API to prove this serialization.
2. **Precommit upgrade versus lost commit ACK.** A no-row old intent must reject
   origin mismatch before `load`/defaults/prepare, even if empty-state digest
   matches. A committed old intent instead returns exact original receipt before
   state/quota checks. Rebinding retained command to current registration defeats
   both guarantees. Stale handles must fail even on replay.
3. **Capture response loss and collection-scoped collisions.** Key lookup and
   journal lookup must precede first capture and semantic derivation. Same
   operation with changed target/restores/witness/command/semantic DTO collides;
   fresh client or upgraded registration cannot recapture an unresolved ID.
   Tombstone with no journal remains permanently unreusable.
4. **Settlement response loss.** Original capture revision must prove the exact
   capture-to-tombstone edge in retained history; caller need not learn a new
   retirement revision first. A tombstone alone proves neither acknowledged
   success nor correct disposition. Wrong receipt/ref/head or changed authority
   must not retire, append history or free accounting twice.
5. **Reserved historical capacity.** Counting only live bytes lets later
   captures consume the last metadata space and strand settlement. Capture must
   reserve its future retirement key/revision metadata under the same lock.
   Charge UTF-8 keys, full checkpoint head/history metadata and retained revision
   overhead conservatively; preserve 32 live/16MiB live/2MiB request and
   4096 retained keys/16MiB metadata. Settlement never needs spare new-capture
   capacity. Existing replay journal quotas remain separate. No eviction/reuse.
6. **Reserved namespace authority.** UUID is public, not a credential. Deny
   ordinary claims and every generic checkpoint read/write/list/changes path,
   including alternate UUID casing accepted elsewhere. Private helpers derive
   namespace and local authority, never accept renderer-selected checkpoint state.
   Native Store collection handles provide no lease proof by themselves.
7. **Canonical bytes and receipt association.** Persist the complete Rust
   canonical request unchanged in checkpoint and journal; do not compare decoded
   floats or lossy DTOs (notably signed zero), digest only, version only or random
   registration revision. Replay validates operation/scope/ref and original
   result binding; malformed or legacy rows fail explicitly rather than falling
   back to new preparation. Existing receipts/source associations remain intact.
8. **Bounded recovery enumeration.** Return only this authorized collection's
   live retained intents in bounded pages, with recoverable raw/semantic input
   association as required by callers; do not leak other collections or accept
   an unbounded scan/body allocation from caller cursor or damaged state.

These are implementation acceptance risks identified against the unmodified
baseline, not asserted defects in an unreceived implementation.

## Focused verification recommendation

No compiler or test was run by this reviewer. Existing real SQLite tests already
cover exact local replay/reopen, stale Store handles, full publication rollback,
receipt quotas and checkpoint ABA/cursor/history behavior; do not duplicate their
entire suites or mirror portable canonical tests. Add focused real SQLite cases
for the new transaction boundary: durable capture with no journal followed by
test-only additive v2 rejection; separate committed v1 lost-ACK replay after
upgrade; exact retry after lost capture/settlement responses; both apply/settle
orders; altered scope/ref/receipt and stale handles with no effects; 32-slot
retirement/recovery plus retained-key/metadata reservation and permanent ID reuse
denial; and all four reserved generic checkpoint denials. Use actual Store and
SQLite state/rollback behavior, not fake SQL. Native admission denial belongs to
its actual admission owner and test scope. Meaningful tests may combine related
cases; do not add a broad mirrored matrix.

The portable test-only trusted lineage catalog must remain <=16 declarations and
1MiB; no production v2 field, schema/index/wire/dependency/public plugin change
is approved. Generated WASM/strict IDB and later admitted native/desktop/browser
transport/runtime proof remain separate future gates, not a reason to repeat
already accepted unchanged pure tests during this source review. This Store
slice alone cannot activate the product or establish no old-apply bypass.

## Inventory and implementation review status

### F1: preserve ordinary Store checkpoint client identities

Early in-progress checkpoint extraction called
`validate_ordinary_checkpoint_client` in generic `scope()`. That helper also
requires canonical UUID spelling, whereas existing Store checkpoint API accepts
valid arbitrary `OperationId` clients. Existing real tests use `child`, `client`,
`a` and `b` (`tests/checkpoints.rs:44`, `:121`, `:372`), and document-index
fixtures use this API too. This would break ordinary generic recovery behavior,
beyond the granted reserved UUID denial. Requested correction is deny-only
`is_reserved_checkpoint_client` at generic Store scope, retaining canonical UUID
validation at ordinary native/browser claims. Do not rewrite ordinary fixtures to
hide the regression. Sent owner `msg_95532ea5f400` and coordinator
`msg_1ea94ecf51ea`; correction verification awaits exact source freeze. No test
was run and no source was edited by reviewer.

### F2: non-create committed replay reconstructs absent history

Early `intent_receipt` read sources filtered to the original update ID, built
empty `prior` State, and called `prior.prepare` to reconstruct the result.
Actual `State::prepare` (`records/src/lib.rs:547`) emits only `vec![op]` in its
payload, not previous accepted history. Therefore a committed patch's selected
source rows cannot reconstruct its original prior state: witness/dependency
checks fail on exact replay, repeated capture and settlement. This also invokes
preparation/default expansion on the committed replay path contrary to the
contract. Requested correction: validate canonical receipt/op/positive sequence
and immutable source/change association without historical State reconstruction
or `State::prepare`; original complete journal/result were authored atomically.
Focused patch lost-ACK replay and acknowledgement coverage is meaningful.
Sent owner `msg_f8402cca251d`, coordinator `msg_45b950dfd136`; exact correction
review pending. This finding is actual-source reasoning, not a test result.

### F3: deleted-head predecessor string is not full retry proof

Early settlement retry on a deleted head checked only
`head.expected == ref.capture_revision`. Checkpoint load verifies latest head
and contiguous global ledger, not whether predecessor is this key's original
nondeleted capture with exactly capture+retirement and no intervening revision.
Capacity checking had the necessary per-key count/first-row checks, but only
on new capture. Settlement and retired committed association must independently
prove the exact two-row edge, including no-journal retirement retry; missing or
inconsistent/foreign history must fail explicitly. Sent owner
`msg_8a2f81917606`; exact correction review pending.

Source-owner inventory was reviewed at owner HEAD
`7d60b1e351f8640c8042c6fdb53faddbea5394e5`; document SHA256 is
`b7db60a99a86debf16172461c11f2c8f0b5f75646b5460fa805ebd8818a7207c`.
It requests exactly Store managed_records/checkpoints/lib export hunks, a new
real SQLite managed_intents test file, existing checkpoints tests, and a
conditional inline test seam. Proposed APIs are ManagedIntentInput,
ManagedIntentDisposition/Settlement, ManagedPendingIntent/Page and four
capture/apply/pending/settle methods. No native/admission/WASM/browser source is
included. The raw plus optional canonical semantic input boundary is coherent
for this staged Store-only scope. Implementation freeze remains pending; this
inventory review is not source approval.

Coordinator grant `msg_75e0a8b9c5a9` subsequently authorizes those exact Store/
checkpoint/export/test hunks after isolated reconciliation to canonical
`2120024d22e9b673858e05cb2f2fc8f6ffd166d2`. No compiler is authorized yet.
Raw plus semantic capture is explicitly sufficient for this foundation; later
service ownership must resolve original capture/journal before mutable tag reads.
Inventory/API must permit exact operation lookup or bounded original recovery.
Native/browser/Cargo and test-only trust changes remain outside this grant.
Relevant Store/pure/admission paths have no diff between the initial canonical
freeze and `2120024d`. Owner isolated merge HEAD is
`71aa8e075913cd2c35be17f6f1d06927739393dd`; inventory's appended grant checkpoint
changes its SHA256 to
`3b1d6cc35f19c4430d64387d6f6b41d1fc255332a6adc791727a66c77664d371`.
The appended text preserves exact source scope. Inventory approval within the
coordinator grant was sent as `msg_21614d41bab3`; source review remains pending.

Cross-crate v2 assessment: `cfg(test)` on Store does not enable records dependency
test code, and ValidatedRegistration/catalog construction is private. Therefore
an inline Store test cannot currently exercise actual trusted v2. No valid
existing seam exists within the granted no-Cargo/no-production-catalog scope.
Copied engine code, invalid-registration substitutes or fake SQL do not prove
upgrade acceptance. The real SQLite upgrade gate stays OPEN while independent
v1 implementation proceeds. A later explicitly owned nondefault fixture feature
would be a conventional option, requiring portable/Cargo ownership and evidence
of exclusion from default production artifacts; it is not approved here.

Two explicit dependencies were sent to coordinator in `msg_3aa68422337a` and
source owner in `msg_3dc78e0508b6`: portable test-only trusted-v2 construction is
currently unavailable downstream; semantic remove-ref recovery and derivation
must eventually share an atomic capture boundary, which this raw input API
alone does not supply. Neither permits unassigned external edits or production
arbitrary-schema trust. Inventory intentionally preserves old v1 adapters, so
complete namespace admission and bypass closure remain future composed gates.

Coordinator `msg_62d2b409d75b` routed a possible fixture feature to root for
separate ownership. Review recommendation (`msg_7b417b8a3afc`): records may expose
only a deterministic fixed synthetic owner/collection v1 plus optional-default
v2 constructor under a nondefault fixture feature, never caller-supplied catalog
validation. Keep normal compiled-v1 validator unchanged. A forwarded Store
feature should select synthetic trust only inside
`cfg(all(test, feature = "intent-test-fixtures"))` in its private registration
helper, with upgrade tests inline in Store's unit-test module. This excludes
fixture injection from the production Store library even when the feature is
selected; integration tests cannot rely on dependency `cfg(test)`. A fixture
release-build compile error can additionally prevent shipping those artifacts.
This is a proposed safe scope, not a Cargo/portable edit grant or passed test.

Root subsequently granted the same source owner exact feature scopes through
coordinator `msg_6bc46c7356a6` (root authority `msg94ba7da4d049`), conditional
on amended inventory review before edits. Amendment at owner
`6396fbe3cfac49fcdbf39e7d088dcffe44100b93`, inventory SHA256
`7d6f8c9f80cd8b8579f081a3ee6441b79dcd85021a57ea35fd39825547915c62`,
was approved within that grant in `msg_cb075fb328d6` (owner) and
`msg_060b6f3dadab` (coordinator). Exact added scope: records Cargo nondefault
empty fixture feature; local_intent deterministic
`intent_test_registration(realm, vault, version)` restricted to fixed synthetic
owner/collection and versions 1/2; Store Cargo forwards only that feature; already
owned Store private helper/inline tests select fixture trust only under combined
test+feature cfg. Fixed v2 adds one optional String default, not product fields.
Production validator is unchanged and fixture-enabled release must fail closed.
Baseline native/WASM/default dependency paths request no such feature. Actual
cfg/source review and test execution remain pending; no compilers are released.

The proposed metadata reservation formula charges at most 3402 bytes per key
at the 1024-byte key limit; 4096 keys therefore charge at most 13,934,592 bytes.
The 16MiB metadata cap is dominated by the retained-key cap under this exact
formula. Verify the real formula/accounting and key boundary; do not invent
artificial fake-SQL data merely to cross an unreachable independent threshold.

Observed initial source-owner HEAD `a4ee37ea` predates canonical pure helpers;
reconciliation is required before implementation review. No implementation
hashes, source approval or runtime claims were issued at that initial stage. Findings sent
to coordinator as `msg_93a3a1864300` and source owner as `msg_6a2f5c14eae6`.

## Final independent source verdict — 6078c333

Reviewed exact implementation commit
`6078c333d9c6838c07cbfbedaa3951d7df483245`, owner worktree clean at inspection.
**No remaining blocking source findings within the granted Store foundation.**
F1/F2/F3 are corrected in these exact bytes. This approves the bounded source
design for coordinator validation, not integration readiness, executed tests,
admitted service behavior or product activation. No reviewer compiler/test/app
execution occurred.

Combined nine-file SHA256 witness is
`884358f26073b68ccb2440053893fd7c954b824c566698b452daf2e524a17c95`,
computed as sorted relative path + NUL + Git blob bytes + NUL for every path
changed by that implementation commit:

| Path | SHA256 |
| --- | --- |
| `crates/zorid-records/Cargo.toml` | `a9baa53c988a87f2cceb467e303c33dbc521806e810b3a6fcaacad6facd4fc51` |
| `crates/zorid-records/src/local_intent.rs` | `eea6a950d576b1f0052a0848f09593a5b4d93dab8884bd7f9d66df2bd896ec79` |
| `crates/zorid-store/Cargo.toml` | `0260984cb1d907eeaf718287ea9ee8e3119f8ec94077c4b575ae7c8fb23bda73` |
| `crates/zorid-store/src/checkpoints.rs` | `3c6160e94812bd54046125c864ed77cbc3810f0ed1497cb6a6c47be251e77f28` |
| `crates/zorid-store/src/lib.rs` | `88fdbb9583c8f988785958f4eb94fc387e574956543e409d0dbb93bf99a747bf` |
| `crates/zorid-store/src/managed_records.rs` | `d5ca89dad0a65c6cb1eb3de936ac59eba550657e26809eb124bd6d1162ed6c19` |
| `crates/zorid-store/tests/checkpoints.rs` | `dadc05a370a5850a06844a9bb34eab2f0071788fc3bd765ef98a720ef4bfb9b4` |
| `crates/zorid-store/tests/managed_intents.rs` | `67fde44132d641d8563fbd4dc93d210f62d4e3893d7a46c758c29aa2964b0ded` |
| `docs/managed-data/origin-store-adapter.md` | `490188b4d984d6b06692887f915227cd2ca789fa9c08087419d6321c287e86d6` |

Concrete correction and boundary verification against this commit:

- `checkpoints.rs:160` denies only reserved UUID/case variants; generic nonUUID
  OperationId clients retain existing semantics. All four generic methods reach
  that scope check. `intent_load:167` validates FULL/authority, bounds body before
  allocation, preserves high-water/head validation, and requires exactly one
  root capture or two capture/retirement rows for the same key. Missing or foreign
  predecessor evidence fails, including unjournaled settlement retry. `cas:452`
  preserves existing revision uniqueness, exact expected-head and retry semantics
  in the caller's transaction, without nested public transaction calls.
- `managed_records.rs:1365` captures complete canonical evidence before domain
  dispatch, resolves retained/journal input first and compares raw plus semantic
  bytes. Physical authority is derived from the private handle/current Store.
  `managed_apply_intent:1456` checks journal before no-row freshness or accepted
  state. `intent_receipt:1264` now validates exact canonical result, original op,
  canonical positive sequence, accepted change and immutable source association
  without historical/current State preparation. The retained result revision is
  returned verbatim from the atomic journal.
- `require_fresh_origin` precedes `apply_new`; its final fence reauthorizes the
  handle and exact live capture body/revision immediately before publication.
  The original atomic state/source/change/authored/journal sequence is factored
  into `apply_new:1054`, with existing raw v1 replay behavior preserved. Receipt
  summaries, incoming/retry semantics, schema/index definitions and wire-v1 code
  are unchanged by this patch.
- `managed_settle_intent:1583` checks original ref/expected capture revision,
  current handle/enrollment, full retained association and journal in one
  IMMEDIATE transaction. Committed reconciliation returns original receipt
  without retirement; exact acknowledged receipt retires. Tombstone retry
  validates the original two-row edge and returns the existing retirement
  revision without another append. Live accounting is derived, so retry cannot
  decrement twice. No-row tombstones prevent operation reuse.
- `intent_capacity:1327` runs under capture's serialized transaction and charges
  the future second revision plus final head from the first capture onward.
  New captures cannot consume another intent's retirement allowance. Live count/
  body and retained keys/metadata are separate from unchanged replay-journal
  quotas; settlement needs no new key reservation. Pending pages authorize and
  filter this collection before loading bodies and preserve exact request/ref.
- The feature adds only a fixed two-schema synthetic catalog under a nondefault
  records feature and Store forwarding edge. Normal `validate_registration`
  bytes are unchanged; Store synthetic selection is exactly combined test+
  feature cfg. Fixture-enabled non-debug builds hit compile_error. Repository
  manifest search finds only those two feature entries, no default/native/WASM
  request. This is static source evidence, not a compiled artifact proof.

The 11 integration cases plus one ordinary checkpoint regression and four
explicitly featured inline cases are meaningful real SQLite tests, not fake SQL
models. They cover capture/reopen/lost response, patch replay after newer state,
explicit settlement/ref/receipt failures, full live-slot recovery/no ID reuse,
real precommit SQL abort, canonical receipt corruption, concurrent apply/settle,
retained RemoveRef tags after re-add, foreign predecessor, old tuple rejection,
and a coherent 4096-retired-key fixture. Inline cases separately test no-journal
upgrade with unchanged empty digest, postcommit upgraded replay, 32 upgraded
mismatches retired explicitly, and both held IMMEDIATE writer orders on actual
independent connections. Existing accepted pure tests need no mirrored copies.

**Execution is still OPEN:** all 16 authored tests were unexecuted at this
source freeze, as were affected existing v1 managed-record/checkpoint regressions.
Coordinator must release compiler load and run bounded new/default and explicitly
featured SQLite checks before implementation validation/integration acceptance.
Request/live-byte guards were inspected but no independent byte-threshold runtime
claim is made; normal fixed WorkBlock requests are small. Historical key boundary
has a real fixture; the independent metadata threshold remains dominated by key
cap mathematically. No unnecessary full suite or repeated unchanged pure checks
are requested.

Later required vertical work remains: ordinary native/browser reserved client
claim denial, current real consumer lease/admission at trusted issuance, atomic
semantic recovery before RemoveRef tag derivation, complete committed-operation
lookup/caller transport and durable ACK handling, native/WASM/strict IDB cutover,
old generic apply bypass closure and actual runtime proof. Existing v1 adapters
remain intentionally available in this source-only slice. Source review does
not establish those gates, mobile/native/reference parity, or product activation.
Any later main composition or source successor must identify changed affected
bytes and receive appropriate revalidation; this verdict binds only 6078c333.

## Actual SQLite receipts and author-report follow-up

Follow-up owner is the same reviewer, task `task_290c00486842`, dispatch
`ctx_43fddc69334d`, following review commit
`e9df538f69182bb0be1d1593904329dea4ad5a12`. Only this document changes.
**Scoped verdict: PASS for the actual 18 SQLite checks and exact author report;
no remaining blocking receipt/report findings.** This section supersedes the
earlier unexecuted status only for the checks explicitly listed below.

Tested source remains `6078c333d9c6838c07cbfbedaa3951d7df483245`. Final author
report commit `64325db140cddc2d4fc9d67dddca5ecaddb5b29c` changes only
`docs/managed-data/origin-store-adapter.md`, whose SHA256 is
`99b906438776cb6c83010a1cdc96c198ad4f2246389899547df896e38383d517`.
Independent Git comparison confirms unchanged source/test/manifests; worktree
status is clean. The earlier source witness remains applicable to the frozen
implementation, with the report's later bytes identified separately.

Read actual persistent logs, per-command JSON, binary hashes and cleanup receipt
under `/Users/ctk/orca/artifacts/zorid-origin-store-20261018/task_b677f7629e9b/`.
Independently recomputed all five log hashes and seven source hashes retained
in the first receipt, and all three executable hashes; all match. Each command
uses the same explicit cargo/rustc/rustdoc toolchain directory recorded below,
`--offline --locked -p zorid-store`, `CARGO_BUILD_JOBS=1`,
`CARGO_INCREMENTAL=0`, target directory
`/Users/ctk/Projects/Zorid/target/stage4-verified`, and `--test-threads=1`.
Recorded start times plus elapsed times establish sequential nonoverlapping
commands, including the three short checkpoint commands. No selected test failed
or was ignored; unrelated filtered unit tests were not counted as passes.

| Receipt/log basename | Scope | Actual result / total elapsed | Log SHA256 |
| --- | --- | --- | --- |
| `v1-managed-intents` | `--test managed_intents` | 11/11, exit0, 18.612s; build16.96s/test0.97s | `2410dedc3c1f8ba5ffe1a576809dbe78110201445ba0f71d3c1ca40263ad74b5` |
| `reserved-checkpoint` | Exact reserved namespace/ordinary OperationId regression | 1/1, exit0, 3.914s | `0d1061c277cf87790d93edf87f0f6dc3607b6ea2a9f3d90598b25b98bb4cda0b` |
| `ordinary-tombstone` | Exact current retry/tombstone fences | 1/1, exit0, 0.349s | `4035748e6602a92fa6d102860d34f59f1c1917793c0374f1d57389ee12c4bce5` |
| `ordinary-scope` | Exact scope/cursor/input bounds | 1/1, exit0, 0.240s | `1939140558334625ecaf30a0b123950b1df398d007f127fac563e48d8fa66947` |
| `featured-upgrade-held` | `--features intent-test-fixtures --lib managed_records::origin_sqlite_fixtures::` | 4/4, exit0, 12.626s; build11.69s/test0.31s;96 filtered | `b5e6bdb889a9141ef3146eabe15ce41a4bf495603038387075665d2675ab7167` |

Verified executable identities in the shared target directory's `debug/deps`:

| Executable | SHA256 |
| --- | --- |
| `managed_intents-bb31664929a24c82` | `aecd03cd2e4565f410519739dc6ddc4ea50131212a4adefadd2fb1b5764b4713` |
| `checkpoints-7d8efda900136a79` | `5569a26dd4f8ef98de1b0203be801b85a2b598d64a6215b91514ddf765c5a1a3` |
| `zorid_store-572fc49b61647e1f` | `2ad250ae1fdeb2cacdb42912a035fc2f55182d9d39642d3c424ad2e90ee6d15b` |

Receipt `v1-managed-intents.json` records compiler identity
`rustc 1.95.0 (59807616e 2026-04-14)`. Tool paths resolve within
`/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin`.
Reviewer read the existing tool bytes without launching a build or test:
cargo SHA256 `c512bff73c86143b557463f021d0c3d5b0490d97d65040ba59ea2b3427784758`,
rustc `b829b733131d4e1673eeebd1f34d06ae1e9ff4977b051313cf42e2a9e79ecf1c`,
rustdoc `59bc6a1caf617032284a2edc2aa03916396e70589c435a8b51e3957887f90ce5`.

Source-to-result assessment confirms the important distinction: the no-journal
fixture captures v1 empty Create, injects a real precommit SQL abort and checks
zero domain/journal effects, upgrades to optional-default v2 while empty digest
stays identical, reopens and gets exact `intent_origin_mismatch`. It retains the
original ref/pending evidence, explicitly retires it and proves only a fresh v2
intent can author the new default. The separate committed-before-upgrade fixture
returns the exact original receipt after reopen/v2, adds no defaults or authored
echo, and repeats exact settlement/replay after tombstoning. These are distinct
executed SQLite cases, not inference from a held registration CAS test.

Other executed cases establish patch lost-ACK replay after newer state, original
raw/semantic RemoveRef tags after re-add, exact lost-settlement-response retry,
current Store/ref/receipt rejection, foreign predecessor rejection, old tuple
refusal while ordinary v1 adapter exact replay remains available,32-live-slot
reconciliation/no-ID-reuse, and4096 retained-key rejection. Featured held-writer
tests use two actual SQLite connections with zero contender busy timeout and
exercise both IMMEDIATE serialization orders. Retirement-first blocks and then
rejects publication; apply-first blocks reconciliation until commit and then
returns the original committed receipt rather than false cancellation. No new
tests or duplicated unchanged pure checks were requested or run by reviewer.

### Fixture graph exclusion and cleanup evidence

Rechecked fixed fixture declaration, unchanged production validator, Store's
combined `cfg(all(test, feature = "intent-test-fixtures"))` trust branch and
records' `cfg(all(feature = "intent-test-fixtures", not(debug_assertions)))`
compile_error. Reviewed author cleanup/feature receipt
`final-source-feature-cleanup.json`, SHA256
`b78a0ae2dea259d1de4f778046d9d80d30d645d546d1db9b989b3b251531fc0f`,
which records clean source/status, no remaining compiler processes, resolver2,
the only two fixture feature definition/forwarding edges and latest canonical
`2972911c` native/WASM manifests without fixture requests.

Reviewer independently resolved read-only feature graphs using that same cargo,
`cargo tree --offline --locked -p <package> -e features`, once with defaults and
once with `--no-default-features`; WASM additionally uses
`--target wasm32-unknown-unknown`. All four exit0 with empty stderr and zero
`intent-test-fixtures` occurrences. Default and no-default graphs are identical
for each selected package here:

| Selected package | Stdout bytes / SHA256 (each configuration) |
| --- | --- |
| `zorid-native` | 43820 / `d458474f8f1b3dc679441fe409f4de1cde65c177b8c49bde20cb3666e223541e` |
| `zorid-wasm` | 40527 / `4abadc2a70a056fc0a2952d5e9acdb82a5cf12f906cd570926dab79be60c3df1` |

These are dependency-resolution/source observations, not native/WASM builds or
release artifact inspection. No negative release build was executed or invented;
the release guard remains source-reviewed only. No source/lockfile changes were
made by the read-only graph queries. Author reports cargo PID12830 exited and
load returned in `msg_509a9e7fab5a`; reviewer independently observed PID12830 and
the three exact test executable processes absent. No app was launched or left
running during this follow-up.

The exact final author report accurately limits its claims and is accepted for
this scoped evidence. Broader existing suites were not run and are not implied
by18 passes. Request/live-byte boundary execution remains unproved; metadata cap
is mathematically dominated by retained-key cap under this charge formula.
Ordinary native/browser client-claim denial, real session/lease authority,
semantic caller recovery, generated WASM/strict IDB cutover, old-apply bypass
closure, encrypted/product/native/mobile verification and main integration
remain separate gates. No whole vertical or product activation is accepted.
