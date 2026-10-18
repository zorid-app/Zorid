# Portable origin and lineage helpers — source freeze

Latest status: exact test successor `e19ac304` now compiles and passes the authorized
5 private unit plus8 production-catalog integration cases (13 total), with no
compiler/semantic correction. Reviewer independently accepted these logs and the
unchanged production source in `msg_a2954705eca6`. Earlier source-only/unexecuted
statements are historical; the focused execution section below supersedes them
only for these portable native-target cases, with all adapter/runtime gates open.

Owner terminal `term_b4d34271-abb5-4b73-b012-71753f74d00b`, task
`task_4d50502d40a7`, dispatch `ctx_0bc5a56f4e26`. Isolated branch/worktree
`tingkai-c/managed-browser-wb-wasm`,
`/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-wasm`.
Source commit `2c18532e630194c1d4eb8222c989ae80ee15beb4`, based on
`706a0633`; only NEW records/src/local_intent.rs, NEW records/tests/local_intent.rs
and records/src/lib.rs one-line module declaration changed. Main was not edited.
Frozen WASM WorkBlock source at62e9691a/875275b8 is unchanged. No adapter or shared
S WorkBlock source was modified. Existing S helper88bf6c70+79d5a775 is a dependency.

## Authority and exact design inputs

Root grant `msg_1c5c4434d1e0` and this dispatch select portable implementation;
coordinator `msg_03d3b3011062` confirms this module may own pure lineage types,
immutable production first-party catalog, private cfg(test) fixture injection,
and unchanged current-v1 adapter APIs. API freeze sent in `msg_a7dc84e586c2`;
source freeze sent in `msg_72f9185ab78c` for independent review.

Read canonical `/Users/ctk/Projects/Zorid/docs/managed-data/` inputs:

| Document | Observed SHA-256 |
| --- | --- |
| origin-intent-decision.md | 5ef13c2b969a45c468a86cd73155bec8663664622dcbe7948d72bd312ec8b25f |
| origin-intent-contract.md | 14a5a48ed1edd45288f86716ecb5c33c4374a85391b8bc6b3d70e1053d9675f7 |
| origin-intent-contract-review.md | b09118557de1eb86b70f01e6d0cddbfa3aba7ab0d5df39ef93a48f80fe15850f |
| migration-implementation-contract.md | 3abec071b0300b31376612aa372e86dce8b8fd3f90e18e8c866e06f813686760 |

Current execution checkpoint was read. No prior discussion-only restriction is
being treated as authority to cancel this explicit portable grant.

## Frozen private helper interface

All APIs below are in `zorid_records::local_intent`, internal inter-crate helpers,
not a public product/plugin registration or bearer-origin capability.

- `SchemaLineage {format_version,schemas}` and `LineageRegistration
  {realm,vault,owner,schema,lineage}` are strict mandatory-lineage DTOs.
- `compiled_registration(realm,vault)` and `validate_registration(bytes)` are the
  only production constructors of opaque `ValidatedRegistration`. They select
  the immutable compiled first-party WorkBlocks v1 catalog, never a caller-supplied
  catalog. It has declaration/canonical_bytes/origin_schema/lineage_identity getters.
- `validate_extension(old,next)` validates complete semantic prefix retention;
  `validate_origin_operation` and `validate_origin_history` use exact origin-version
  membership. Whole-history unsupported membership is checked before supported
  semantic failures. Structural/value/domain checks reuse State and first_party;
  causal union, dependency handling and inferred kinds still require existing State.
- `original_empty_state_bytes(registration,scope)` exposes the original canonical
  empty-state hash input. Existing host hashing remains required; no SHA dependency
  or second hash implementation was added.
- `ManagedIntentRef {operation,capture_revision}` addresses retained evidence.
  `LocalIntentV1` is an opaque immutable validated request; `ValidatedLocalIntent`
  is its alias, with only read getters and reference recovery. Neither validated
  registration nor validated intent implements Deserialize for callers.
- `capture_local_intent(registration,authority,capture_revision,operation,scope,
  expected,command,semantic_request)` validates and captures without State::prepare,
  default expansion or operation authoring. `canonical_intent_request` returns its
  exact original bytes.
- `validate_retained_intent(current,authority,expected_full_scope,reference,bytes)`
  binds complete scope, physical authority, original operation/ref, historical
  compiled origin and raw/semantic association. `require_fresh_origin` is the
  separate **no-journal-row** semantic registration equality gate.
- `require_matching_input(original,scope,operation,expected,command,semantic)`
  compares repeated capture against original input, excluding a newly read origin.
  Actual committed replay must still compare full canonical request bytes.
- `intent_checkpoint_key` produces canonical tuple
  `["managed-record-intent-v1",realm,vault,owner,collection,operation]`, <=1024 bytes.
  The key intentionally has collection-wide operation uniqueness rather than
  per-consumer/per-record uniqueness; complete record/generation/restores association
  remains in the request and is validated separately.
- Reserved checkpoint identity is fixed
  `f7bca1bf-2a2c-438e-b430-b3f05e5d9324`. `is_reserved_checkpoint_client` and
  `validate_ordinary_checkpoint_client` provide pure guards, including alternate
  uppercase spelling rejection. Authority and capture revision use the existing
  canonical lowercase UUID spelling. They do not prove issuance or grant access.

Complete request format1 has fixed-order fields format_version, store_authority,
capture_revision, operation, scope, origin_registration, expected_revision, command,
semantic_request. Registration and semantic documents are canonical UTF-8 JSON
strings, not numeric byte arrays. Raw command is its canonical typed pre-default
representation. The new decoder rejects old tuples, missing origin, unknown fields,
noncanonical object/numeric spelling and unsupported private formats without a
permissive fallback. The old tuple is used only transiently when delegating existing
shared WorkBlock semantic validation; it is never an accepted new request format.

Lineage is <=16 complete declarations and <=1MiB full registration; active schema
must equal its final declaration and the complete ordered prefix must equal the
trusted catalog. Optional additions/version-only steps preserve every prior field,
policy, collection and canonical default byte identity (including -0.0 versus0.0).
No production v2 field or migration-authored operation exists. WorkBlock semantic
binding reuses shared command_for_replay, including original observed-remove tags;
record/generation/operation/witness association is also explicit. Capture does not
read accepted state or regenerate tags on replay.

Full encoded request <=2MiB; semantic input <=16KiB checked before copying. Shared
budget constants32 live,16MiB live bytes,4096 total retained keys and16MiB metadata
match the decision. **Constants do not implement admission/accounting/reservations.**
Hosts must reserve settlement capacity and charge immutable capture/tombstone
metadata atomically. No budget is treated as permission to evict unresolved state.

## Authored focused tests and observed source checks

**No Cargo/compiler/test execution occurred in this dispatch.** Coordinator's
format/load ask reply allowed owned-file rustfmt only: the generated wasm32 turn
ended, but the native owner received the next Rust/Xcode slot. Coordinator directed
source freeze plus unexecuted-test report for independent review while Cargo waits.

Five private unit fixtures in the source use a private cfg(test) generic catalog:
R1 no-row v1 Create([]) under optional-default v2, equal canonical empty-state hash
inputs and preserved historical bytes/ref; optional-only/prefix/-0/nested defaults;
exact origin membership with numeric gaps and whole-history unsupported precedence;
16-declaration/1MiB bounds, omitted prefix/forks; and unexpanded raw input/witness
collision. There is no exported testing constructor or production catalog injection.

Eight production-catalog integration fixtures in tests/local_intent.rs cover:
canonical complete request/ref identity; missing/oldtuple/noncanonical requests;
physical authority/reference and all seven scope components; caller version/fork
rejection; semantic target/operation/witness/raw binding; remove/readd original tags;
reserved namespace and canonical collection-operation keys; and byte/key/domain
bounds. R1 is a pure helper proof fixture, not actual precommit storage evidence.
Equal canonical empty-state bytes establish equal hash input; this crate deliberately
has no new hashing dependency. Real host tests must also witness actual hashes and
absence of durable writes.

Commands observed successful (exit0):

```sh
/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/rustfmt --edition 2021 --config skip_children=true crates/zorid-records/src/local_intent.rs crates/zorid-records/tests/local_intent.rs
/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/rustfmt --check --edition 2021 --config skip_children=true crates/zorid-records/src/local_intent.rs crates/zorid-records/tests/local_intent.rs
git diff --check
git diff --cached --check
git diff --exit-code 62e9691a -- crates/zorid-wasm/src/lib.rs crates/zorid-wasm/src/records.rs crates/zorid-wasm/src/workblocks.rs crates/zorid-wasm/src/workblocks_tests.rs
```

Bounded Node source-boundary check returned PASS, exit0:

```sh
node <<'NODE'
const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('crates/zorid-records/src/local_intent.rs','utf8');
const production=source.split('#[cfg(test)]')[0];
assert(!production.includes('.prepare('));assert(!production.includes('pub fn validate_with_catalog'));
assert.match(production,/validate_with_catalog\(\s*bytes,\s*&\[first_party::schema\(\)\]/);
assert(production.includes('f7bca1bf-2a2c-438e-b430-b3f05e5d9324'));
for(const type of ['ValidatedRegistration','LocalIntentV1']){
 const before=production.slice(0,production.indexOf(`pub struct ${type}`));
 const attrs=before.slice(before.lastIndexOf('#[derive'));
 assert(!attrs.includes('Deserialize'));
}
console.log('PASS source boundary: fixed compiled catalog, opaque validated types, no production prepare');
NODE
```

Rustfmt parsing and source assertions are not typechecking or executed semantic tests.
After an explicit new coordinated load turn, proposed focused commands are:

```sh
PATH=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin:$PATH CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-records --lib local_intent::tests -- --test-threads=1
PATH=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin:$PATH CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-records --test local_intent -- --test-threads=1
```

These commands have not run. No dependency/lock/build-script/DB/wire change,
installation, new cache, app/browser/native/mobile launch or additional worker occurred.

## Mandatory remaining gates and no-bypass boundary

Independent source review and13 focused tests still require execution before
portable acceptance. This batch leaves old admission::local_request and Store/WASM
apply interfaces untouched under explicit current-v1 freeze; they are **not**
authorized origin-aware migration entry points. A completed migration slice MUST
cut every adapter over, reject missing/old intent evidence and remove/internalize
all unfenced generic apply bypasses; additive helpers cannot satisfy that gate.

Current authorization must precede loading evidence; host issuance must durably
capture the same host-generated revision before mutating dispatch. Caller-supplied
canonical bytes, UUID namespace or ref alone are never trusted issuance. Hosts
must perform journal-first exact replay, then fresh-origin gate on no row before
state/default work, plus final live nondeleted capture-head and registration fences
inside the publication transaction. Retired refs may recover exact journal replay
but cannot prepare a new mutation. The host must derive original create witness
with its existing hash and observe remove tags only at first durable capture.

Generic admission AND load/CAS/list/changes must deny reserved clients. Atomic
capture/journal lookup, tombstone identity preservation, tagged committed/uncommitted
settlement, lost-response recovery, apply/retire races, exact receipt acknowledgement,
usage reconstruction and reserved retirement capacity remain storage-owner work.
No settlement/issuance/accounting implementation or cryptographic authenticity is
claimed by a canonical decoder. Validly-shaped changed witness/raw bytes cannot
match original caller input or journal bytes, but detection of direct underlying
DB tampering is outside the selected host trust boundary.

Real SQLite plus generated WASM/strict-IDB R1 before-commit/no-row upgrade and
separate postcommit/lost-ACK replay, checkpoint head/history and reserved-namespace
proofs are mandatory. Existing current-v1 normal Worker proof, encrypted convergence,
UI/mobile/native delivery and wider migration acceptance are independent gates.
This source batch establishes none of those runtime outcomes.

## Successor review and bounded adapter cutover inventory

Successor task `task_29b5239d0e87`, dispatch `ctx_9b1009465858`. Independent
review `2571e646`, docs/managed-data/origin-portable-review.md, approves exact
2c18532e pure-helper source with no blocking counterexample. Reviewer is
`term_c574699d-e5b7-4c9d-ab3d-66b4688d4e68`, dispatch `ctx_600a176f4a90`;
received `msg_3fc4a7b94ac2`. This is source acceptance only. Source behavior/API
stays frozen while test-only cases address its nonblocking coverage observations:
explicit outer unknown/duplicate and embedded/nested duplicate properties,
signed-zero raw-command identity, individual preserved-field changes and inclusive
request/registration/semantic/key boundaries. Counts remain5 unit plus8 integration.
Actual results will be recorded only after the coordinator releases the compiler
slot; Native NewNote18 initially owns heavy load in this successor.

The following is a bounded read-only map, not source ownership or a complete
new migration audit. Canonical main was observed at
`4a2c2010545982f9df20c64c6139e25ee13a8889`. Paths/anchors below refer to that
source sample; another owner's current-v1 WorkBlock candidates are labeled
separately. No file listed below was edited, compiled or run for the inventory.

| Existing entry point / precise source anchor | Required later origin-aware seam |
| --- | --- |
| `crates/zorid-store/src/managed_records.rs::managed_register` (359), `registered` (139), `portable` (186), `authorize` (170) | Persist/validate mandatory complete lineage, preserve semantic repeat/prefix identity and current authorization revision; old Registration conversion must not discard lineage. Registration transaction revalidates every accepted record/restore before replacement. |
| Same file `managed_apply` (453), original `admission::local_request` call (469), journal SELECT immediately after it | Replace unfenced raw apply with internal origin-aware apply after durable host capture. In its existing IMMEDIATE transaction require current handle and physical authority, retained ref/full scope/origin and exact live pending head; journal-first exact complete-request replay, then require_fresh_origin only on no row before load/digest/default work. Final pending-head and registration fence must be in the publication transaction. Old public raw apply cannot remain an adapter bypass. |
| Same file `load` (199), `check_restore` (300), `snapshot` (238), `managed_snapshot` (437), `managed_export` (573), `activate` (808), `receive_in_transaction` (853), `retry_in_transaction` (641) | Thread validated lineage/origin semantics through every accepted/restore/receive/retry/export path; exact supported membership before per-origin semantics. Reuse State union, common authenticated source ledger, fair retry and quotas; activation itself authors zero operations and changes no wire version. |
| `crates/zorid-store/src/checkpoints.rs::scope` (154), private `load` (175), public `checkpoint_load` (234), `checkpoint_compare_and_swap` (250), `checkpoint_list` (325), `checkpoint_changes` (335) | Scope currently checks physical local_store_id only. Deny reserved client at every generic API, factor transaction-local internal load/CAS/page primitives rather than call public CAS inside managed IMMEDIATE. Preserve global sequence/history/fences; verify exactly original live capture or capture-to-tombstone association and reserve/account retirement capacity. |
| `crates/zorid-native/src/client_admission.rs::claim` (60), NativeVault generic checkpoint wrappers in `src/lib.rs` (251/260/269/279) | Claim currently validates canonical UUID but needs reserved denial. Generic checkpoint wrappers and underlying Store APIs both need denial, so claim or prefix checking alone cannot grant reserved access. Existing lease/physical authority checks remain mandatory. |
| `crates/zorid-native/src/workblocks.rs::open_workblocks` (273), `execute_workblocks` (302), direct Store apply calls (348/465), `workblock_apply` (457); `crates/zorid-desktop-host/src/workblocks.rs` dispatch | Named native host owner must introduce durable capture acknowledgement/ref retention before first apply, derive create's original empty witness and remove tags only on first issuance, recover refs across session/lease restart, and expose tagged explicit settlement. Existing ordinary client/session/window guards stay; no session reissue under a new schema or direct managed_apply bypass. |
| `crates/zorid-wasm/src/records.rs::registration` (46), `canonical_local_request` (350), `Facts.local`/`prepare_local_inner` (441), stored replay validator (703), `validate_stored_binding_inner` (767) | New private format must replace current tuple construction/decoder and local facts with retained complete intent/ref plus live pending-head preconditions. Validate historical journal identity before accepted facts; no-row gate before state preparation. Preserve RecordsPlan/preconditions/finalization and canonical receipt/source identity. No dual old-request decoder or missing-origin fallback. |
| Same WASM file `validate_accepted` (324), `recordsSnapshot` (331), `prior_restore` (182), `prepare_received` (556); frozen W `workblocks.rs` replay/preparation wrappers | Route all accepted histories/restores through certified origin validation when adapters cut over. Semantic wrapper must consume original durable raw/semantic identity and original witness, not recompute remove tags or current schema origin. W remains frozen and untouched in this portable batch. |
| `src/core/browser-managed-records.ts::createBrowserManagedRecords` (217), `authorize` (230), `readFacts` (238), generic `apply` (337), `register` (305), `validate` (611) | Add internal capture/apply/pending/settlement under actual maintained handle and strict transaction. Current apply constructs a tuple from latest registration/current input, so it must be internalized/replaced rather than retained beside origin-aware apply. Resolve pending/journal before new capture; add original intent and pending fence to final CAS facts and preserve existing common-authored transaction completion semantics. Reopen validation must cover new request/head/counter consistency. |
| Browser managed transaction store-set at (219), `browser-sync-streaming.ts::baseStores` (198), managed host `common.stores` (814), facade (906); `browser-normalized-idb.ts::normalizedTransact` (70) | Current managed transaction combines managed/common stores; normalizedTransact automatically adds control only. Explicitly include existing checkpoint_heads and checkpoint_revisions in capture/apply/settlement transactions; do not introduce a nested transaction or network/WebCrypto await inside a live callback. Existing DB stores suffice; no new DB/index version is implied. |
| `src/core/browser-checkpoints.ts::browserCheckpoints` (17), transaction (42), load (120), compareAndSwap (136), list/changes page (81) | Deny reserved scope on all generic paths and factor private synchronous transaction primitives. Preserve strict durability, local-store-id, sequence, creation membership, immutable revision fences and permanent tombstone previousRevision. Immutable revision rows alone do not contain the missing predecessor edge. |
| `src/platform/browser-client-lease.ts::claimBrowserClient` (15), `browser-client-admission.ts::admitBrowserClient` (30), `browser-core-worker.ts` claim (80) and checkpoint RPC cases (172–175) | Deny reserved admission/claim and all generic checkpoint RPCs/facades; original ref is never a lease/principal. Capture/apply/settle/recovery transport must remain under current owner queue, stop/drain and fresh post-await checks. Never dispatch apply before durable capture acknowledgement, and never turn unknown outcome into fresh operation identity. |
| `src/core/browser-streaming-vault.ts` existing checkpoint stores/indexes (18/69/98), managed facade export (402) | Reuse existing storage and strict host authority; include two checkpoint stores in relevant managed publication transactions. New pending/ref API shape belongs to the named storage/platform seam, not a generic externally accessible checkpoint capability. |

Current-v1 candidate-specific additions (not canonical main runtime evidence):

- Durable candidate `bf0945893863584bf12475c0786a962faadbd648` in
  managed-browser-wb-durable has `applyWorkBlock` at403 and journal-first
  workBlockReplay at419, followed by existing readFacts/prepareWorkBlockLocal.
  This semantic path must cut over alongside generic apply; current-v1 replay
  ordering alone does not prevent the R1 no-journal origin/default case.
- Host candidate `ee37d5ff97464d78c2e79282c29eb8340b4defaf` in
  managed-browser-wb-host has browser-workblocks-host.ts mutation call at67,
  execute at109, and browser-core-worker.ts workblock-command dispatch at148.
  These need two-stage durable capture/ref recovery and explicit settlement under
  the same local queue/handle, without changing public WorkBlock command meaning.
- Platform candidate `7b0f24fabf9833d40619797d29c9c6b54ebd1d9c` in
  managed-browser-wb-platform has browser-core-runtime.ts workBlockCommand call at146,
  response/error association and pending retry logic. Future transport must retain
  original ref and semantic bytes through worker loss/reacquisition, not issue a
  newer origin during explicit same-ID retry. Existing current-v1 proof remains
  separately owned; these source observations neither replace nor establish it.

This map deliberately assigns no new source owner or implementation permission.
The coordinator must serialize each current owner freeze and name exact hunks
before adapter work. Pure constants/guards and this inventory do not implement
reserved denial, live/historical capacity enforcement, settlement or durable recovery.

Test-only coverage successor is `e19ac3048ac8dd8cbd061ce871e6dac5e854473d`.
A bounded Node comparison of the pre-`#[cfg(test)]` source against2c18532e
returned PASS: approved production helper bytes are identical. Reviewer
`msg_8031ccdf7529` independently inspected this exact delta and found no blocking
test-source issue, without claiming execution. Earlier reviewer guidance said
these additions were nonblocking and unnecessary to hold the first focused pass;
they were already complete before that queued guidance was read. No production
API or helper behavior was expanded. Still no Cargo execution at this checkpoint.

## Actual focused portable execution — 2026-10-18 UTC

Coordinator explicitly released the load hold in `msg_aee9c6c6c1c7`: Tasks actual
and native sim18 compiler/app processes had exited, and only these two commands
were authorized. Launch reported in `msg_7158e8f0b044`; terminal/end results and
resource return reported in `msg_e9540a6a52d2`. Both actual compiler/test processes
exited0; there is no owned heavy process left. No native/browser/Simulator app,
wasm32 build, new target/cache, dependency install or full suite was run.

Exact tested source: `e19ac3048ac8dd8cbd061ce871e6dac5e854473d`, plus report-only
`34716eea`. Test-only additions leave the approved production helper bytes equal
2c18532e. No source/test correction followed compilation and neither command was
repeated. Commands were run sequentially with shell pipefail and logs preserved:

```sh
set -o pipefail
PATH=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin:$PATH CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-records --lib local_intent::tests -- --test-threads=1 2>&1 | tee /tmp/zorid-origin-portable-lib.log
PATH=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin:$PATH CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-records --test local_intent -- --test-threads=1 2>&1 | tee /tmp/zorid-origin-portable-integration.log
```

| Command | Exit / counts | Timing |
| --- | --- | --- |
| records lib local_intent::tests | 0;5 passed,0 failed/ignored/measured/filtered | build3.12s; tests0.03s |
| records test local_intent | 0;8 passed,0 failed/ignored/measured/filtered | build3.32s; tests0.04s |

No compiler error or warning appeared. Positive captures/decodes/extensions and
negative tampering/oldtuple/scope/ref/duplicate/bounds/domain assertions all ran;
these are successful tests of rejection behavior, not failed commands being
excluded from the report.

Actual unit test output names (all ok):

- historical_operations_use_declared_origin_not_numeric_less_than_active
- lineage_declared_catalog_bounds_forks_and_omissions
- lineage_optional_only_prefix_and_canonical_numeric_defaults
- r1_no_row_origin_rejects_even_when_empty_state_digest_input_is_identical
- raw_input_does_not_gain_defaults_and_changed_witness_or_raw_command_collides

Actual integration test output names (all ok):

- authority_reference_and_every_scope_component_are_bound
- canonical_full_request_embeds_documents_as_strings_and_preserves_complete_identity
- declared_bounds_fail_before_decode_and_do_not_loosen_existing_domain_rules
- identity_guards_and_fixed_collection_operation_key_do_not_issue_authority
- old_tuple_missing_origin_unknown_fields_and_noncanonical_bytes_are_rejected
- remove_semantics_preserve_original_tags_and_repeated_capture_binds_them
- semantic_operation_target_witness_and_command_binding_cannot_be_replaced
- trusted_catalog_rejects_caller_versions_forks_and_semantic_registration_changes

Evidence hashes from `shasum -a 256`:

| Witness | SHA-256 |
| --- | --- |
| /tmp/zorid-origin-portable-lib.log | 6e6c4663dc2bd434b32f4ee521518cd1fb0b5f260530f37384e575a3736027ba |
| /tmp/zorid-origin-portable-integration.log | 2ed1a86c939bd23301ef5bf7eaa20f8640f9c8dac4f95742ed5a175e573da034 |
| records/src/local_intent.rs | d8f77c2ed11fc39c42626562512b217bf42d4013ed74adcf8b75c2286d8d4cf8 |
| records/tests/local_intent.rs | c55a9fd642d7427d809dfa957bf0ca2b5c6f376f461d3e8107ea858914cf6ed6 |

Independent reviewer read both actual logs and compared the worktree's three
source files to exact e19ac304, including production prefix equality2c18532e.
Message `msg_a2954705eca6` accepts bounded source+focused execution evidence,
with0 failures and no repair, while preserving all adapter/storage/runtime limits.
The committed actual-results report is sent back for final frozen evidence review.

These13 cases prove the portable checks on native target. They do not issue a
checkpoint, persist an intent, enforce quotas, deny the namespace in actual generic
APIs, atomically publish/settle, recover process loss, or validate generated WASM.
The R1 fixture demonstrates identical canonical hash input and pure no-row-origin
rejection; actual SQLite and generated WASM/strict-IDB before-commit and lost-ACK
cases remain mandatory. Current old adapter entrypoints are still untouched and
cannot remain a bypass in the completed origin-aware migration slice. No current-v1
browser assembly, encrypted convergence, UI or mobile readiness is inferred.

### Persistent evidence retention and installed toolchain metadata

Per coordinator `msg_7e9dee3f8f9e`, copied the exact completed logs into owned
persistent worktree storage (not a target/cache and not /tmp-only):

- `/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-wasm/tmp/origin-portable/local-intent-lib.log`
- `/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-wasm/tmp/origin-portable/local-intent-integration.log`

`shasum -a 256` on these copies matches the corresponding log digests above.
No test/compiler was rerun. Installed toolchain manifest was read directly at
`/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/lib/rustlib/multirust-channel-manifest.toml`:
manifest date2026-04-16, rustc package `1.95.0 (59807616e 2026-04-14)`, cargo package
`0.96.0 (f2d3ce0bd 2026-03-21)`. These are installer metadata, not a newly executed
compiler/version command; the exact authorized PATH and target are recorded above.
Both actual Cargo invocations using that toolchain returned exit0 as logged.
Source remains frozen; actual-results report a44d5934 is extended only with this
retention/toolchain record for final independent evidence review.
