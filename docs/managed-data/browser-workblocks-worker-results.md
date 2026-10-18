# Browser WorkBlock fourth actual run — accepted bounded 12-group subset

**Actual `3f07c9d4` verdict: `passed-subset`, 12 groups passed; no runner error
or artifact failures. This does not close the full browser or product gates.**

Documentation owner: task `task_172568a274b3`, dispatch `ctx_0a4cfee3f064`,
terminal `term_23278648-ea86-451a-9509-f8ef012ae35d`, isolated
`managed-browser-wb-proof` at base `93ce8a39`. This task edits only this report
and the new [compact evidence manifest](browser-workblocks-3f07c9d4-evidence-manifest.json).
No fixture, source, WASM/glue, raw evidence, main, tests, builds or apps changed
or ran as part of this documentation task. The coordinator remains the sole
integration owner; canonical integration and reconciliation remain separate work.

## Frozen execution and independent acceptance

Actual assembly: `3f07c9d4ed080bda39c24d8e4ecf1a42907e0e1d` in
`/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-integration`.
Chrome `155.0.8059.80`, protocol `1.3`, V8 `15.5.35.23` ran the actual normal
product Worker with an observational prepend and the existing generated WASM.
The product Worker body SHA256 remains
`a1277a3d40b1744b0ee5b63a097b0d20bd2d8fbfa2858a267e71d4caa8d1b385`.
Reviewer `ctx_b7e810f05a37` independently accepted the actual evidence in
`msg_c891acf8d710`, relayed by coordinator receipt `msg_e6a36a421c80`:
443/443 strict readwrite transactions (436 complete, 7 abort), 43 full atomicity
snapshots, 10 terminal-before-reply causal pairs and all 12 database deletions.
Exact report/manifest review is a separate required gate before this task settles.

Coordinator exec session **35242** was positively observed terminal **exit0 at
2026-10-18 05:02:57 UTC**. PASS output and owned app cleanup occurred earlier at
05:01:46; Node lingered afterward. Its cause is not established, and the earlier
PASS/cleanup is not a terminal-exit witness.

## Actual observed groups

| Complete group | Result / duration |
| --- | --- |
| Admitted CRUD/ref lifecycle, immutable receipts, rejections and restart | PASS / 237ms |
| Bounded window scan, byte nonconsumption, cursor/query/watermark fences | PASS / 9005ms |
| Historical journal replay before deliberately corrupt current state and source/quota reads | PASS / 188ms |
| Admitted release drains held strict writes; exact client reacquires | PASS / 258ms |
| Owner loss during before-prepare hold | PASS / 239ms |
| Owner loss during common-authored hold | PASS / 307ms |
| Owner loss during after-final-write hold | PASS / 341ms |
| Local authoring survives sync revocation with credential-independent durable save | PASS / 161ms |
| Lost exact reply after commit remains uncertain; retry replays original receipt | PASS / 3368ms |
| Two same-authority clients catch a lost hint on foreground refresh | PASS / 214ms |
| Two independent Workers converge encrypted offline field/ref/delete races; restart receipts and no echo | PASS / 1794ms |
| Encrypted receive rejects wrong key/scope; session-revoked held transaction aborts | PASS / 496ms |

The before-prepare and common-authored owner-loss mutations abort with definite
`client_not_admitted / host / commitUncertain:false`. The after-final-write
transaction completes while the detached facade reports uncertainty. Its real
definite retry through the same facade remains uncertain and blocks changed input reusing the
same operation ID; original durable receipt recovery succeeds after reacquisition
through a new runtime, not as a successful retry on that retained facade. Initial encrypted convergence has
**17 wire updates**. The shared receipts array later contains **19** entries
including two authors from the final negative-case group; 19 is not the number
of original receipts replayed by the initial convergence group.

The new full snapshots prove the narrow owner-close exception prospectively:
the only permitted row delta is absent -> exact empty
`document-index:v1/catalog`, containing only `version:1`, the persisted
`localStoreId`, `head:null`, `generations:[]`, and `pins:[]`. The proof requires
a separate, completed, strict, control-only **write-bearing** close transaction
with exact authority/catalog reads and exact catalog put, causally between the
definite aborted mutation reply and correlated successful release ACK in the
same Worker/database. Every other intervening transaction has zero writes;
all other full rows and store inventory are identical. This is not a blanket
control-row exclusion. The failed `d8d3a4e9` raw below still fails and still lacks
the retrospective full-row/write-value evidence needed to prove that exact delta.

## Recomputed evidence and cleanup

All raw files remain unchanged in the existing persistent directory
`/Users/ctk/orca/workspaces/Zorid/managed-data-foundation/tmp/browser-wb-proof-3f07c9d4`
and sibling `.log`; no multi-megabyte copy is added to Git. The manifest records
absolute paths, byte sizes and independently recomputed SHA256 for all five raw
files plus the log. `report.json`: **42,831,740 bytes**, SHA256
`34031e83c8c02d963c9ddcbb496f0cf753e13c4285e78b437b47fef5e22d30c6`.

| Source/artifact witness | SHA256 |
| --- | --- |
| Rust input fingerprint, bindgen0.2.129 | `2839865d44b7a7ba87e862dfac82d118125053866552135c7643df8fedae60d0` |
| Generated glue | `ab5af194bf78cad8a5dd5da6396d7671bef07172e24463eb0c82ad2b1221986f` |
| Generated WASM | `7e95c92909d7e2fd8c4f4136a0844bde93b3cbf3c395f13655496af97a33121f` |
| 71-file source digest | `b71686c024e405843ed7a34acb3b7db1b9b391e0cea86cd900d0e36374917d50` |
| Observational prepend | `e7ec847133eaea99c4b43e52feefa051d947029761bdec768da2ed1098540b29` |
| Transformed Worker | `f972b4a0178dbbac9d43587e052dafa5a47c0171b8afc028c2f9a9e621c61b55` |

The runner compares artifactProof before and after successful execution, including
HEAD, Rust fingerprint, generated hashes, source digest and observation identity;
no separate after object is serialized in raw. This documentation audit independently
recomputed those source/artifact/observation hashes and matched the frozen report.
The manifest includes source paths, digest algorithms and generated file paths/sizes.
Integration status at audit contained only pre-existing untracked `node_modules`.

Owned Chrome PID38170 received SIGTERM, exited code0 without signal at
05:01:46.611Z; exact profile `zorid-workblocks-browser-chrome-DDu6DK` was removed
with ENOENT absence confirmation. Vite `127.0.0.1:54132` close resolved and
`httpListeningAfter:false`; CDP close was requested. All 12 exact database-name /
`deleted:true` rows are retained in the manifest. Cleanup failures and artifact
failures are empty, and `runnerError:null`. This task launched no resources.

Scope remains **HTTP1 JSON fixture relay**: no gRPC/protobuf, rendered UI,
native/mobile or full browser matrix proof. The 1MiB budget was requested,
not saturated; the unrelated fence mutation covers a normal file family,
not a second managed collection. Wrong-scope evidence proves configuration
rejection only; rejection of incoming malicious cross-scope ciphertext remains
unproved by this run.

## Ordered source batch for sole main integrator

This is a source selection inventory, not permission to overwrite current main
or copy the integration tree. At read-only comparison main was
`21cdb4bf4f2181b111eaba2f807c1105c143af05`. S foundation (`a5fe46e6`, budget
correction `f6bf12c6`) is already canonical as `6f864a31` + `a4389f5f`: `workblock_service.rs` and its tests
have no diff. Earlier portable foundation evidence `8133fd2c` is canonical too
and must not be replayed. **Exclude S and preserve main's later `local_intent` module/tests.**
Do not replace either crate's entire `lib.rs`; add only the missing WASM
`mod workblocks;` declaration. Main's unrelated editor/mobile changes remain owned
by their existing sessions; preserve current exports and editor/recovery behavior.

| Order / slice | Exact assembly commits in dependency order | Scoped source and tests |
| --- | --- | --- |
| 1 W: WASM binding + replay/window sessions | `6b97046d`, `4309ba7c`, `f42cc8e7` | NEW `crates/zorid-wasm/src/workblocks.rs`, `workblocks_tests.rs`; narrow `src/records.rs` visibility/snapshot helper and `src/lib.rs` module declaration |
| 2 D: durable operations and terminal witnesses | `dcf73b93`; D hunks of `abe71464`; D/IDB hunks of `44437fb1` | `src/core/browser-managed-records.ts`, `browser-sync-streaming.ts`, `browser-normalized-idb.ts`; corresponding `tests/browser-managed-records.test.ts`, `browser-sync-streaming.test.ts`, `browser-normalized-idb.test.ts` |
| 3 H: trusted registration + host activation | `9c399576`, `e9026a3b`; H hunks of `abe71464`, `44437fb1` | `src/platform/browser-core-worker.ts`, `browser-managed-records-host.ts`, `browser-managed-records-registry.ts`, NEW `browser-workblocks-host.ts`; `tests/browser-managed-records-host.test.ts` |
| 4 P: admitted facade / retry transport | `46214d7f`, `cf4bd42c`; P hunks of `abe71464` | `src/platform/browser-client-admission.ts`, `browser-core-runtime.ts`, `browser-default.ts`, NEW `browser-workblocks.ts`; `tests/browser-workblocks.test.ts` |
| 5 Harness source only | `3515f12f`, `506cdb4a`, `22881b76`, `c8ee4c0c`, `c1999394`, `c0b47ac0`, `4b57b730` | ONLY `tests/browser-workblocks-worker/` including README; exclude historical copied raw artifacts from mixed commits |
| 6 Reviewed documentation/evidence | This report + compact manifest; select accompanying W/D/H/P/uncertainty/terminal reports separately | Preserve failed raw history where already retained; do not cherry-pick huge historical raw copies merely to obtain source |

Mixed commits must be scoped by the listed files/hunks and composed coherently;
D/H/P uncertainty and terminal changes must travel together before acceptance.
Registration/activation uses the existing queue and fixed trusted first-party
factory; it is not a new public plugin API. Reconcile with current main, rebuild
generated WASM from its resulting Rust inputs and validate affected behavior
under the integration owner's schedule. The frozen artifact proves this exact
assembly, not a future rebased/cherry-picked result. No executable check was
needed or run for this documentation-only change; raw/hash consistency and
`git diff --check` are its validation.

---

# Browser WorkBlock third actual run — four groups passed; atomicity evidence correction

**Actual d8d3a4e9 verdict: FAILED at owner-loss before-prepare durable equality.
The successor harness is source-only and has not run in Chrome.**

AtomicityHarnessOwner, task `task_b4767273866d`, dispatch `ctx_7bc0c1c56f45`,
terminal `term_2fa2f2be-7af7-4de5-891c-19875fe03eb2`, owns only the harness and
this report in isolated branch/worktree `managed-browser-wb-proof`, base `64cacfbf`.
No production source, WASM/glue, Rust, dependency or build bytes were edited.
No Chrome, Vite, WASM/Rust build or app was launched by this source task.
Main integration remains coordinator-owned.

## Source correction successor (2026-10-18)

Owner: task `task_5bbeb246e86c`, dispatch `ctx_5008bde5ad90`, same isolated
branch/worktree, base `a5676bb3`. Only `assertions.mjs`, `atomicity.test.mjs`
and this report changed. Fixture snapshot capture, observer and all old raw
artifacts remain unchanged; no product/WASM/app/compiler/runtime was run.

Reviewer `ctx_b7e810f05a37` identified a source blocker: the a567 helper selected
all completed readwrite transactions, incorrectly requiring exactly one. Raw3
also has strict zero-write tx26 terminal69 between tx25 terminal67 and release
ACK70. The corrected helper requires exactly one **write-bearing** separate
transaction, then validates its strict completed control-only exact catalog
read/write schema and release causality. Every other observed transaction except
the definite aborted mutation must have zero writes, including transactions whose
writes might later abort or leave equal snapshots. All terminal witnesses require
valid unique IDs, real terminal outcomes, strict readwrite durability and ordered
same-Worker/database events. The no-diff path also checks this evidence instead
of returning before lifecycle/witness validation. Duplicate snapshot row keys
are rejected rather than silently collapsing in a keyed diff.

Focused synthetic regression reproduces tx24 abort64, mutation reply65, catalog
tx25 complete67, empty tx26 complete69, release ACK70; added exact snapshots and
write values are synthetic, not reconstructed raw3 evidence. Negative cases
reject any other add/put/delete/clear (even abort), wrong catalog/stores/authority/
schema/counters, relaxed or missing witnesses, duplicate IDs, foreign Worker or
database, changed managed bytes/cursors/inventory and reversed causality.
`node --test tests/browser-workblocks-worker/*.test.mjs`: **16 passed, 0 failed**;
both edited modules pass `node --check`, and `git diff --check` passes.
Independent reviewer `ctx_b7e810f05a37` accepted exact source freeze
`0d10bcd63a105b88d96ef663018eace5291b91d8` in receipt `msg_85c5ae6fc547`,
including the inherited a567 snapshot/observer changes. The reviewer independently
passed 16 Node checks, parser/diff checks and all five raw3 byte comparisons.
This acceptance record changes documentation only; next actual browser proof
remains coordinator-owned. The original failed run and retrospective
exact-delta limitation below remain unchanged.

## Retained third actual evidence

The coordinator ran assembly `d8d3a4e9c97c83b0bfcdc53bb65a4d7fea12886f` in
`managed-browser-wb-integration`. Original raw directory and sibling log remain
untouched at `/Users/ctk/orca/workspaces/Zorid/managed-data-foundation/tmp/browser-wb-proof-d8d3a4e9`
and `browser-wb-proof-d8d3a4e9.log`. Exact byte-compared copies of all five raw
files and the log are versioned in `tmp/browser-wb-proof-d8d3a4e9/`; its
`artifact-manifest.json` records each file size and SHA256. Raw report SHA256:
`03de96463dbce69a0339958e8b05842af308ca89976bab2ad374473845bdbb49`.
The failed raw has not been rewritten or upgraded to a passing result.

| Complete group | Actual result |
| --- | --- |
| Normal admitted CRUD/ref lifecycle, immutable receipts, rejections, restart | PASS, 213ms |
| Bounded window scanning, byte nonconsumption, cursor/query/watermark fences | PASS, 9568ms |
| Journal replay before deliberately corrupt current state and source/quota reads | PASS, 331ms |
| Admitted release drains held strict writes and exact client reacquires | PASS, 259ms |

The next group failed at old fixture279: `Aborted owner-loss transaction made
partial writes`. Actual Worker `f1625133-001b-4d2d-ad1e-838cbc1dd498` tx24 is
strict ABORT ordinal64 with `writes:[]`; exact mutation RPC reply ordinal65 is
`client_not_admitted / host / commitUncertain:false`. A separate strict control-only
tx25 completes ordinal67 after reads of `local-store-id` and
`document-index:v1/catalog`, with one control put; release ACK follows ordinal70.
The old observer did not record the put key/value, and old raw retains no full
before/after rows. **The exact durable delta is unproved retrospectively.**
Source `src/core/browser-document-index.ts` empty/readCatalog/close explains an
expected empty-catalog creation on virgin-fixture close; this is a hypothesis
consistent with the trace, not a claim the failed raw proved only that change.
Independent reviewer dispatch `ctx_b7e810f05a37` confirmed these limits.

Cleanup: owned Chrome PID84250 received SIGTERM, exited and closed code0 without
signal; exact profile `zorid-workblocks-browser-chrome-eou3ZR` was removed with
ENOENT absence confirmation. Vite port64811 close resolved and HTTP listening
was false; all five named fixture databases report deleted. Cleanup failures and
auxiliary artifact failures are empty. Later owner-loss boundaries, sticky retry,
replica cases and whole gate2/3 remain unproved by this failed prefix.

## Narrow successor harness

Every `durable()` boundary now reads **all actual stores with keys and complete
values in one readonly transaction**, retaining the canonical snapshot in
`report.atomicitySnapshots` immediately. Each captured boundary carries its
previous same-database snapshot ID and exact keyed row differences; failure
entries are retained too. Held title mutations capture before and after settling;
owner loss additionally captures after release has settled, before assertions.
Corrupt/restore, wrong key/scope, held receive revocation and lost-reply boundaries
retain snapshots, and all still-owned hosts are snapshotted before failure cleanup.
Failed groups are explicitly recorded. Snapshots/diffs survive assertion failures
because they are report fields rather than a successful group's return value.

For aborted owner loss, the sole allowed difference is absent -> the exact row
`{key:"document-index:v1/catalog",value:{version:1,localStoreId:<persisted authority>,head:null,generations:[],pins:[]}}`.
Extra fields, nonempty content, foreign authority, modification/deletion of an
existing catalog, any second changed row, changed store inventory and every
noncatalog control counter/row are rejected. All managed, collection, source,
outbox, cursor, file/projection and other rows remain byte-identical.

The test observer additionally records exact control write keys and values using
structuredClone before invoking the genuine native write. It still prepends the
unchanged normal product Worker and supplies no schema, operation, receipt,
registration or semantic output. The catalog exception requires genuine strict
abort then definite matching mutation reply, same Worker/database release-client
input, unique separate completed strict control-only close transaction with the
exact authority/catalog reads and exact catalog put, then correlated successful
release ACK. Missing write content or reversed/unrelated lifecycle evidence fails.
No blanket control exclusion or product invariant was weakened.

## Validation and next gate

`node --test tests/browser-workblocks-worker/*.test.mjs`: **13 passed, 0 failed**.
New adversarial evidence checks reject changed managed bytes, counters, outbox,
cursor, schema/content/authority, existing catalogs, missing or wrong release,
cross-Worker or reordered close, relaxed durability and wrong write keys/values.
Syntax checks for changed `.mjs` and `git diff --check` pass. These are bounded
harness checks, not product/browser proof.

Freeze this coherent commit for reviewer `ctx_b7e810f05a37` before the coordinator
composes and runs the next actual assembly. The old failure remains failed; the
new exact snapshots and causal exception must pass in the next actual run before
any stronger atomicity or later-gate claim. Product and generated WASM bytes must
remain unchanged during composition except separately reviewed coordinator work.

---

# Browser WorkBlock second actual run — bounded prefix passed; fixture corrected

**Second actual verdict: FAILED after one complete group; full window and gate2/3
acceptance remain open. The corrected fixture below has NOT been run in Chrome.**

BrowserCursorProofOwner, task `task_761a84781664`, dispatch `ctx_7406c718a396`,
terminal `term_8fee1f84-94e0-4b5b-856f-3bfa56be802c`, owns this report, the
fixture-only correction and exact copies of the second run's synthetic artifacts.
Branch/worktree: `managed-browser-wb-proof`, based on `62611896` (which lacks the
product terminal fix). No production source, Rust/WASM, dependencies, builds,
runner, main or integration assembly was changed here.

## Second actual execution and retained provenance

The coordinator's actual run used integration assembly
`3b555af6c33018089d263402502ba309d1f8bd8c` in
`/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-integration`, with the
corrected product terminal settlement from `8bc3ecc5` (integration commit
`44437fb1`). Original raw directory:
`/Users/ctk/orca/workspaces/Zorid/managed-data-foundation/tmp/browser-wb-proof-3b555af6`.
All five original files were copied byte-for-byte to this worktree's versioned
`tmp/browser-wb-proof-3b555af6/`; each source/destination byte comparison passed.
This worker did not launch or repeat that run. Browser witness is Chrome
155.0.8059.80, protocol1.3, V8 15.5.35.23.

| Run witness | Exact value |
| --- | --- |
| Rust input fingerprint | `2839865d44b7a7ba87e862dfac82d118125053866552135c7643df8fedae60d0` |
| Generated glue SHA256 | `ab5af194bf78cad8a5dd5da6396d7671bef07172e24463eb0c82ad2b1221986f` |
| Generated WASM SHA256 | `7e95c92909d7e2fd8c4f4136a0844bde93b3cbf3c395f13655496af97a33121f` |
| 70-file source digest | `a63223d819b345234189fe0272cf7f82a46424735a579662e173bd8c8db2a930` |
| Original normal Worker SHA256 | `a1277a3d40b1744b0ee5b63a097b0d20bd2d8fbfa2858a267e71d4caa8d1b385` |
| Observational prepend SHA256 | `3302f746b13434a99a6af48408ce19212ca96e4369f7101a38dcec5f6467455e` |
| Transformed Worker SHA256 | `5d3b6a9b4a81bb186501c1537ae2196f31c3f80e3bda7ad351f17bcabb53446d` |

A read-only post-run audit during this task recomputed the fingerprint, 70-file
source digest and both generated asset hashes: all match the raw provenance.
Integration HEAD remained exactly `3b555af6`; its status contained only the
already-existing untracked `node_modules`. Raw transformed-load evidence retains
the matching prepend and unchanged product-body hashes. No successful post-proof
provenance check is implied by this failed run.

| Exact copied raw artifact | Bytes | SHA256 |
| --- | ---: | --- |
| `report.json` | 12975473 | `b419f672306419e5025dc3ac800a0b50a69ce649d25284cfd9e59cbb77f6da5a` |
| `cleanup.json` | 1690 | `97d95b1e7b0ef0b7ce75421be93d04073e82876f642562d62d25faddfcd19dbd` |
| `browser.json` | 300 | `ebc2d4dd529ac915f4a46dd3bfbad0210afe5271fe263a360f2abb9b06bd1217` |
| `cdp-events.json` | 4950 | `11dc68620f4753eda2d10257c3fe2ce31245804d2d6124baecd8df85a7db6b5b` |
| `chrome-stderr.log` | 3930 | `d5159db84596ea60df6200014739ab322d8f8413dc20aedd5bc941b731e24ac2` |

## What actually passed and why the next assertion failed

The first normal admitted CRUD/ref lifecycle, immutable receipt replay, rejected
mutation atomicity and restart group **passed** (308ms). Its stale rejection is
`{code:"stale_revision",source:"rust",commitUncertain:false}` at the facade.
Raw Worker `bd99812d-c413-4239-ba62-c7c4dc4c4095` shows incoming RPC
`9979f37e-2361-4b64-a65a-54edb5b0166e` at ordinal161, strict transaction63
aborting with no writes at ordinal165, and the matching definite Rust error reply
at ordinal166. This is actual bounded evidence for the `8bc3ecc5` product fix.
It does not establish later held-transaction or sticky-retry fault cases.

The second group failed at old fixture line98 with
`Expected rejection: cursor_expired`. Nine identical `windowPage(q)` calls did
not create nine new cursor slots. Independent reviewer
`term_547a1451-3b97-46d8-a85c-5d527a706a4e`, dispatch `ctx_b7e810f05a37`,
confirmed this diagnosis in `msg_c8c014616f02` before this correction.

Read-only inspection of the exact `3b555af6` source confirms both
`crates/zorid-native/src/workblocks.rs:536` and
`crates/zorid-wasm/src/workblocks.rs:718` reuse an existing continuation when
query, after-position and watermark match. Both evict an old token only when a
new continuation is allocated with eight slots already present. WASM's existing
`cursor_query_fence_lifetime_and_eviction_are_session_owned` test also explicitly
requires same-progress token reuse. No Rust capacity or eviction behavior changed.

The corrected fixture obtains a nonnull original cursor and checks an identical
initial query returns the exact same page/cursor. It then requests nine distinct
valid bound queries (`fromMs`1 through9, `untilMs`3000, limit1) without any intervening
mutation, validates each page, requires the original watermark and nonempty tokens
distinct from the original and every prior allocation, and only then requires
original-token `cursor_expired`. Each query/page is retained in the eventual
successful group's `eviction` evidence. The independent repeated-continuation
replay check and capacity, reopen, foreign-session, query/fence and byte-bound
assertions remain. No failure envelope is fabricated and no assertion is relaxed.

## Cleanup, source freeze and next gate

Second-run raw cleanup confirms owned Chrome PID49042 spawned, then exited/closed
with code0 and no signal after owned SIGTERM. Its exact profile
`/var/folders/yc/__symlbx5zxd7v1vhwh84z180000gn/T/zorid-workblocks-browser-chrome-H0jv0h`
was removed with ENOENT absence. Vite `127.0.0.1:61091` close resolved with
`httpListeningAfter:false`; both owned fixture databases were deleted. Cleanup
failures and auxiliary artifact failures are empty. The supplied run receipt
reports no app remains; this source task started no browser, server or app.

Corrected fixture SHA256:
`386c7ad13f010ee5177e217734d50cb0ba39899c6b12f97589f88a6314233c1f`.
Corrected harness digest (11 top-level `.mjs`/`.html` files, sorted relative paths,
path + NUL + bytes + NUL):
`b3a6f56ac76dddaf3a37e2e58d220215339b568e3348c9b787b64de09eda913d`.

Source-only validation: existing bounded Node evidence suite **11 passed, 0
failed** (330.9ms); all ten `.mjs` files passed `node --check`; `git diff --check`
passed. Allocation and watermark assertions are in the real fixture setup rather
than a new test that mirrors Rust cursor implementation. These checks establish
harness syntax/evidence behavior only. This old branch cannot validate the fixed
product runtime and must not be used for an actual runner invocation.

The coherent commit containing this record is the source freeze to send to the
reviewer before actual reuse. Only the coordinator assembles the reviewed fixture
with current corrected product sources into a new frozen assembly; an actual
rerun must wait for independent review and new-assembly readiness. No completed
window, encrypted-sync, full browser campaign, UI/native/mobile, gRPC/protobuf or
whole-product acceptance is claimed. Earlier first-run failure remains preserved
below as historical evidence.

---

# Browser WorkBlock actual proof — first run FAILED

**Actual runtime verdict: FAILED, zero complete groups; gate2/3 NOT ACCEPTED.**

Task `task_369d464a1aa8`, dispatch `ctx_3dffab017ab5`, V terminal
`term_286af0db-089a-49b7-baca-fdbff9ad0348`. One explicitly authorized actual
run only. No rerun, assertion weakening, source fix, installation, compiler or
WASM build was performed. The integration assembly/docs/HEAD/source/dist/generated
were not mutated by this worker; evidence and this report are retained only in
the original proof worktree.

## Exact frozen execution and artifacts

Working directory: `/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-integration`.
Frozen assembly: `cf1bb55cb0e9f9c29a57262f9a4b8673a17f515b`.
Reviewed harness source: `67ba0d065ca011a9133f9d23267603da4c10f159`, Git tree
`b832423573cda6cb1a81a09b64c26a34c04419d9`, identical in the assembly.

Exact command (unified execution session47173, terminal exit1):

```sh
node tests/browser-workblocks-worker/run.mjs --expect-head cf1bb55cb0e9f9c29a57262f9a4b8673a17f515b --runtime-authorized --out /Users/ctk/orca/workspaces/Zorid/managed-browser-wb-proof/tmp/browser-wb-proof-cf1bb55c
```

Actual browser: **Chrome155.0.8059.80**, browser protocol1.3/V815.5.35.23,
from retained `browser.json`. Actual normal `BrowserCoreRuntime`/admitted service,
normal product Worker/fixed compiled registration, prebuilt generated WASM and
native IndexedDB executed with the approved exact observed prepend; no synthetic
consumer, alternate engine, seeded authored record or forged receipt was used.

| Witness | Exact value |
| --- | --- |
| Rust input fingerprint | `2839865d44b7a7ba87e862dfac82d118125053866552135c7643df8fedae60d0` |
| Generated glue SHA256 | `ab5af194bf78cad8a5dd5da6396d7671bef07172e24463eb0c82ad2b1221986f` |
| Generated WASM SHA256 | `7e95c92909d7e2fd8c4f4136a0844bde93b3cbf3c395f13655496af97a33121f` |
|70-file source digest | `d532fec3a10b23bf89c8be8e1e3f876c6be9d7f92f30caf35e3ebe4f04c806fb` |
| Original normal Worker SHA256 | `a1277a3d40b1744b0ee5b63a097b0d20bd2d8fbfa2858a267e71d4caa8d1b385` |
| Observational prepend SHA256 | `9d3f7fc3628c5d24bbc960622a889842754c80ba3da7f94ae3f387d1390923eb` |
| Transformed normal Worker SHA256 | `04a62e88f567a089e001eab5e67194d1487a613a70e435a8f37085d010ca21ea` |

Runner preflight verified current Rust fingerprint and glue/WASM bytes, and
retained actual transform-load records for the normal Worker in this assembly.
The failure occurs before the runner's successful post-proof provenance check.
A separate read-only `post-run-audit.json` therefore recomputed the source digest,
assets and exact HEAD after failure: all match. Assembly status before and after
contains only its already-present untracked `node_modules`; no tracked delta.
Reviewer independently recomputed the Rust fingerprint, source digest and assets.

## Concrete first failure and bounded observations

The first CRUD group reaches its stale-title rejection and fails:
`Expected stale_revision; got invalid_workblock_response`, uncertain.
No complete group is recorded. Prior successful command responses and prefix
assertions do not establish full CRUD/atomicity/restart or any later gate.

All decisive events belong to real normal Worker
`5bc11db7-dc35-4aa9-9170-b028e666799f` and operation `stale`:

| Raw event | Exact retained evidence |
| --- | --- |
| Incoming semantic RPC | ID `cb4db4d4-0600-4b2d-ae34-159b28787757`, ordinal161 |
| Native strict transaction | ID63, requested/actual `strict`, `abort`, `writes:[]`, ordinal165 |
| Matching Worker error reply | Same RPC ID, ordinal166, `{code:"stale_revision",message:"stale_revision",source:"workblocks",commitUncertain:true}` |
| Admitted facade failure | `invalid_workblock_response`, uncertain, instead of definite `stale_revision` |

The actual transaction terminal precedes this exact matching response, but its
abort classification is lost at the semantic/transport boundary. There are
**14/14 observed normal readwrite starts/terminals,13 complete and1 abort**, all
requested/actual strict and no observer error/deadline. This is bounded trace
observation, not14 authored mutations or a passing durability campaign.
`report.evidence.groups` and `ordering` are empty: the first group fails before
its completion record and before the dedicated fault-ordering cases execute.

Immediate first-failure notices: root `msg_a361bfaaa701`, reviewer
`msg_d2bffc4b9348`; decisive raw terminal/envelope follow-ups
`msg_31e4e8291d29`/`msg_7795526cf720`. No rerun or source changes followed.

## Independent actual review and diagnosis boundary

Reviewer `term_547a1451-3b97-46d8-a85c-5d527a706a4e`, dispatch
`ctx_b7e810f05a37`, independently inspected the actual raw files **before this
final report** and confirmed failure/cleanup in `msg_6d7c8a72a8a4`.
Review record: `fcf8e53e9a35a399daae95d3a2a40e0bf27b9ddb` in
`managed-browser-wb-review`, `docs/managed-data/browser-workblock-runtime-review.md`.

The reviewed source constructs a semantic Error with source `workblocks`; D/H
preserve that label, while P accepts only `host`/`rust`. Separately, source review
identifies a likely native listener/microtask ordering hole: normalized rejection
can run before the later D terminal listener records its abort evidence. The raw
trace directly proves an actual abort followed by misclassified uncertainty, but
does not instrument D's private terminal variable or prove each microtask step.
This timing explanation remains a source-supported diagnosis, not an added runtime
observation. A source correction requires named ownership, authentic terminal
proof before native settlement and trusted semantic error normalization; merely
widening the parent source-label acceptance would leave uncertainty unresolved.
No production fix or rerun is authorized by this evidence.

## Raw retention and accepted owned cleanup

Persistent versioned artifact directory: `tmp/browser-wb-proof-cf1bb55c/` in this
proof worktree. Original raw files remain unchanged; added audit/manifest files
are separately identified and do not replace the original report or errors.

| Original artifact | SHA256 |
| --- | --- |
| `report.json` | `930cf6daa751ef4823775bf32abcc6ff61670cd19aa5f51687637316762f3da0` |
| `cleanup.json` | `c09beb05b136ad80d78bb4b67490bb2f52e711447f59c12d149679929e56614c` |
| `browser.json` | `ebc2d4dd529ac915f4a46dd3bfbad0210afe5271fe263a360f2abb9b06bd1217` |
| `cdp-events.json` | `f06453865db87cab789e0576c1596a396f9823cd15127abb064a2f5a8c2b7a4d` |
| `chrome-stderr.log` | `767899bfed5b69cdf7eb4ce7050593d96dd11ac59e6a401a1b90e22694d3321d` |

`artifact-manifest.json` records each file size/hash, including the read-only
post-failure audit. `report.json` retains the actual command failure stack,
transaction/RPC observations, observed transform bytes, cleanup and empty
auxiliary artifact failure array. No successful outcome was substituted.

Owned cleanup **accepted independently for this failed run**:

- Chrome PID58255: native spawn and exit `(code:0,signal:null)` after successful owned SIGTERM request; exact PID independently found absent.
- Owned profile `/var/folders/yc/__symlbx5zxd7v1vhwh84z180000gn/T/zorid-workblocks-browser-chrome-hSUnQ7`: removal confirmed by ENOENT; independently absent.
- Owned Vite listener `127.0.0.1:51281`: close resolved, `listening:false`; independently no listener.
- The one uniquely named owned authority DB was deleted successfully.
- Cleanup and auxiliary artifact failure arrays are empty; runner exited1 as required by actual proof failure.

No test browser/window/server/process is left running. Cleanup success does not
change the failed runtime verdict.

## Remaining gates and next step

All later window, held transaction/release/config, sticky same-facade retry,
reply-loss/restart, corrupt-state replay, lost-hint and independent encrypted
conflict/convergence groups remain **unexecuted**. No actual HTTP1 encrypted
exchange succeeded in this run; HTTP2/gRPC/protobuf, rendered UI/Calendar,
native/mobile and broader browser acceptance are not claimed. The existing
bounded source omissions remain: the unrelated-family case is not a second
managed collection,1MiB is not saturated and wrong scope is configuration rejection.

This dispatch reports **failed**. Root must assign a scoped correction and
independent source review, then provide a new exact assembled/artifact/readiness
checkpoint for any subsequent runtime run. This failed evidence must remain
retained alongside any later result.

---

## Historical source-only approvals

The source-preparation records below predate the actual failed run. Their source
approvals are preserved; their then-current statements that runtime was unrun are
superseded only by the bounded failed observation above, not by a passing gate.

# Browser WorkBlock proof — reviewed evidence-gap correction

Status: **SOURCE APPROVED; actual browser gate2/3 NOT RUN and NOT PASSED.**

Owner: task `task_83ee5512f2f3`, dispatch `ctx_507e6047b69b`, same isolated
`managed-browser-wb-proof` branch/worktree. Only harness files and this report
changed; no production/main edits, semantic engine, receipt fabrication, schema,
wire, migration or dependency changes were made.

## Exact freeze, digest and independent review

- Source: `67ba0d065ca011a9133f9d23267603da4c10f159`.
- Harness Git tree: `b832423573cda6cb1a81a09b64c26a34c04419d9`.
- Eleven-file `.mjs`/`.html` SHA256: `d7e8b20d24b2a455a62da1630bf74370e0af90f68fe9e24c6bf4e0c1302e12da`.
- Digest scheme remains sorted relative path + NUL + exact bytes + NUL, excluding README/results prose.

Independent reviewer `term_547a1451-3b97-46d8-a85c-5d527a706a4e`, dispatch
`ctx_b7e810f05a37`, approved this exact source/tree and independently recomputed
that digest in `msg_91bf56928b84` (2026-10-18 04:20 UTC). Reviewer independently
ran all11 focused Node checks and parsed all10 `.mjs` files. The review found the
genuine late-close sticky sequence, causal pairs and concrete owned cleanup
receipts satisfy the requested bounded source corrections, with no forged error
reply or semantic substitution. This approval grants no runtime/launch acceptance.

The prior exact review of `69f8dca6` identified same-retained-facade uncertainty
and cleanup receipt gaps; it also limited terminal-before-RPC evidence to the
original drain comparison. Read the exact reviewer report at the review worktree's
`docs/managed-data/browser-workblock-runtime-review.md`. The correction below
implements the reviewer's real existing-API recipe from `msg_86853c303c5d`;
root's `msg_201129cb17e4` independently required that approach. An early proposed
synthetic-error scheduling approach was rejected before implementation and is
absent from the frozen source.

## Corrections and exact evidence boundaries

The final-write owner-loss case now keeps the original admitted `h.wb` facade
and parent runtime alive after the real strict transaction completes and the
actual Worker returns postcommit uncertainty. An explicit identical retry reaches
that same Worker after its real release ACK. The genuine predispatch error must
be `client_ownership_lost` with raw `commitUncertain:false`, while the retained
facade must continue reporting `true` for the original unresolved identity.
Changed title with the same operation must collide locally with zero additional
WorkBlock RPC. Source assertions require exactly one explicit retry, no automatic
mutation/new operation ID, no new write start, no replacement facade/Worker and
unchanged durable rows. Only then is the old runtime abandoned; same-client lease
reacquisition recovers the exact original journal receipt with zero reauthoring.
The retained-facade claim covers uncertainty/retry/collision; successful recovery
uses the newly reacquired runtime and is stated separately.

`report.ordering` now contains explicit local causal pairs rather than inferring
ordering from aggregate write counts. Each claimed case binds the real terminal
and RPC reply to one Worker lifetime, transaction/operation and original incoming
RPC ID, requiring terminal ordinal < reply ordinal. Corrupt-state replay, held
mutations/receive, late receipt recovery and dropped-reply recovery apply this
check. A suppressed response is checked at actual response production before its
intentional drop, not at nonexistent delivery. The genuine predispatch rejection
has no attempted transaction and is proved by no new write start instead. Other
ordinary mutations do not inherit a global terminal-before-RPC claim.

`cleanup.mjs` is now used by the runner. `cleanup.json` plus embedded report data
retain the exact owned Chrome PID, native spawn/error/exit/close events and exit
code/signal, signal attempts, profile path, successful removal with ENOENT absence,
and Vite close resolution/listener state/address. Only that supplied owned child,
profile and server are touched. Unconfirmed child exit keeps its profile and
fails the run. A failed cleanup branch does not skip the others; artifact write
failures and cleanup failures remain alongside any original runner error. CDP
records a close request rather than claiming synchronous confirmed closure.
No Chrome/Vite cleanup receipt exists yet because no browser run occurred.

## Actual bounded source validation

```sh
node --test tests/browser-workblocks-worker/assertions.test.mjs tests/browser-workblocks-worker/observation-transform.test.mjs tests/browser-workblocks-worker/cleanup.test.mjs
```

Result: **11 passed, 0 failed**, latest local run89.7ms. Evidence checks now reject
reversed/cross-worker/mismatched terminal/RPC pairs. Cleanup helper checks use one
short-lived owned **Node child**, confirm its actual native PID/exit and removed
fixture profile, and verify a deliberately failing Vite **interface double** does
not suppress independent cleanup or its error. These are source-helper checks,
not actual Chrome/Vite or product runtime evidence. The Node child exited and its
profile was removed. All10 harness `.mjs` files passed `node --check` without
browser module evaluation; `git diff --check`/staged diff check passed.

No Chrome, Vite, Rust/WASM/compiler build, actual app, dependency installation or
additional worker was launched. Existing normal admitted Worker/WASM/strict-IDB
and real encrypted exchange assertions remain intact and unexecuted.

## Limits and next gate

The unrelated cursor case uses an actual normal file-family command, not a second
managed collection. The1MiB budget is requested but not saturated. Wrong scope
covers configuration rejection, not malicious incoming cross-scope ciphertext.
The12 bounded groups are not an exhaustive history/quota/browser matrix. HTTP1
remains HTTP1; gRPC/protobuf, rendered Calendar/UI, native/mobile and whole-product
acceptance are not inferred.

Read-only composition `2834c783dc0bcd69fe0051fd8112f81a9cf6eb6a` now delegates the
native limit65 budget rejection to Rust, resolving the older source-only mapping
question without changing V's native assertion. Actual artifact behavior is still
unknown. A separate next assignment must supply the final reviewed assembly,
exact current generated WASM/glue/build artifacts and an explicit authorized load
checkpoint before any actual browser proof. Source work here is complete.

---

## Historical wired-source preparation and predecessor findings

The following records describe the earlier freezes and are superseded where the
reviewed correction above resolves their source gaps. They are not runtime proof.

# Browser WorkBlock normal Worker proof — V successor

Status: **WIRED SOURCE ONLY; actual gate2/3 NOT RUN and NOT PASSED.**

Owner: task `task_f9accdb6712f`, dispatch `ctx_23f551472e1b`, terminal
`term_286af0db-089a-49b7-baca-fdbff9ad0348`. Sole source scope remains
`tests/browser-workblocks-worker/**` plus this results document, branch/worktree
`managed-browser-wb-proof`. Main and production files were not edited.

## Exact source and validation

Successor source commit: `69f8dca65f8b26d8c3c545786f5dace1ca983665`, following
predecessors `d31f087d5ef3aa221930e694d4b04869892cf0aa` and `80fef9d9`.
Harness source SHA256:
`f3fff8bef1e742f4e54c48177f82cdc282d0c1c21bf239142361ab77e3ad856c`.
Scheme: all nine top-level `.mjs`/`.html` files under
`tests/browser-workblocks-worker`, sorted by filename, each relative UTF8 path +
NUL + exact file bytes + NUL. README and this results document are excluded.
The runner separately fingerprints all relevant product TS and harness sources
and the actual generated assets at the eventual frozen assembly.

Actual source-only checks:

- `node --test tests/browser-workblocks-worker/assertions.test.mjs tests/browser-workblocks-worker/observation-transform.test.mjs`: **8 passed, 0 failed**, latest98.8ms.
- `node --check` for each of the eight `.mjs` files: **all exit0**; browser modules were parsed only, never evaluated.
- `git diff --check` and `git diff --cached --check`: **exit0**.

Node cases reject changed receipt bytes, invalid page/cursor/change evidence,
empty/relaxed/unsettled strict witnesses and forbidden replay reads/writes. Exact
transform checks prove a fixture input's entire product body is retained and that
other modules, altered frozen bytes and unsafe channels cannot be transformed.
These check the harness, not actual browser behavior. No Rust/WASM/compiler,
Vite/browser/app, install, target-cache creation or additional worker was launched.
No owned browser/app/process requires cleanup at this source-only stage.

## Supported normal lifecycle and observation wiring

Local-only uses real `BrowserCoreRuntime.open({initializeLocal:true,...})`.
Two encrypted replicas use real unenrolled open, existing
`configureSyncFixture({...enrollEmpty:true})`, then `admitBrowserClient` and its
refreshed optional `workBlocks` service. H `d5cd2c8c` and the corresponding P
readiness successor support this startup. Distinct DB authorities/client leases
retain one authorized logical scope. No external seeder authors managed operations.
All claimed operations use the admitted normal runtime/Worker/fixed registry and
actual generated WASM; the HTTP1 relay only stores opaque encrypted wire bytes.

The successor task explicitly authorizes the test-only Vite prepend now wired in
`run.mjs`. Only the exact normal `browser-core-worker.ts` body receives two added
import/install statements. The module body remains byte-for-byte unchanged.
Original, prepend and transformed SHA256 values plus actual transformed-load
records are mandatory durable evidence; any changed original source fails closed.
The product registry, storage semantics, Rust bindings and native settlement
handlers are not replaced. This source authorization is not runtime load approval.

Observer faults use genuine native request/transaction/message APIs. They retain
and later deliver the original native success callback inside a live native read
callback, or hold after the final journal/counter writes succeeded. Keepalive reads
are identified observer work and excluded from product read traces. Native terminal
events, requested/actual strict durability and bounded product read/write traces
are retained. Missing terminal evidence, trace overflow or the10-second fail-safe
releasing a hold fails the proof. Product capture-phase terminal listeners remain
unchanged and their real ordering still needs browser verification.

Parent tap observes the actual Worker constructed by the runtime and permits only
`release-client`/`refresh` lifecycle injection. Forced closing is a deliberate
worker-owner fault, distinguished from the separate public admitted-release drain
case. It cannot inject semantic authoring. Reply loss drops only the chosen actual
response; hint suppression drops only normal hint posts. Current-state corruption
changes only one owned existing row using a strict native transaction and restores
its exact original bytes; it does not fabricate operations, receipts or sources.

## Prepared bounded cases, all unexecuted

Twelve groups cover the prior CRUD/ref/delete/read/restart and changes assertions,
plus the following wired paths:

- Corrupt current accepted bytes after remove/readd, then replay the original
  receipt. Its actual transaction must read only authority, registration and
  local journal, with no source/accepted-history/quota reads or writes.
- Public admitted release remains pending while a strict final-write transaction
  is held, acknowledges after actual completion, then exact client reacquires.
- Forced worker closing before journal preparation causes actual abort, definite
  noncommit and zero journal/source/outbox/change/counter writes.
- Closing mid-`common.authored` at the real `authored-sequence` read requires
  witnesses of already staged managed state/change and immutable source writes,
  then actual abort, total rollback and definite noncommit.
- Closing after final writes requires actual native completion, uncertain result,
  no stale notification and same-client receipt recovery without a new row.
- Credential revocation during held local authoring must preserve independent
  local save and its common durable outbox; reconfiguration retains the receipt.
- Drop a successful original reply, wait for actual runtime timeout/termination,
  require uncertainty and exact receipt/store preservation on restart/retry.
- Two normal same-DB clients lose an actual hint; foreground refresh catches
  durable state without repeating delivery. Both clients then close normally.
- Window scanning uses66 live records, native64-row/1MiB/31-day bounds,
  filtered/deleted counts and session/query/watermark fences. Rust-reported native
  snapshot byte counts force partial-page exclusion, with the next row resumed.
  A normal unrelated file-family command must leave that WorkBlock cursor valid.
- Independent normal Workers create common history, author offline separate-field,
  same-title/range, ref/readd and delete/edit races, independently restart, exchange
  actual E2EE and compare exact canonical state/projection/revision/candidates/
  tombstones, original receipts/sealed wires, empty outboxes/shared cursor/no echo.
- Wrong-key/scope attempts preserve local state/cursor/source rows. Revoke a real
  receive session inside a held encrypted receive transaction, require abort and
  unchanged durable state, then reconfigure and converge without echo.

All normal readwrite transaction starts need matching terminal observations and
actual/requested `strict`; no empty or selectively absent witness set can pass.
The eventual runner reports at most `passed-subset` because the campaign is
bounded and HTTP1-only, not an exhaustive browser/protocol matrix.

## Composition questions and remaining claims

Uncertainty successor `8391fb8655d311d7b29a5f9dadbbd89076d38a40` supplies actual
D abort/complete private evidence and H/P propagation/sticky identity changes.
Its owner's source receipt `msg_26538a2565bc` reports77 Node tests/fullTS only;
V has not claimed those as its own checks or as real strict IDB ordering.
V source now exercises actual rollback versus completion across that boundary.

Native budget mapping remains a concrete freeze question: accepted native behavior
for window limit65 is `limit`, while older P primitive capture returned
`invalid_workblock_request`. V keeps the native expectation, reported to root in
`msg_4c415fc746b0`, instead of weakening evidence to match old source. Root/P/U
must reconcile the final composed source before actual runtime approval.

The previous shared-scope startup and unwired-observer questions are resolved in
source by the named H/P readiness and this authorized prepend. Every actual browser
assertion, event order, restart and encrypted outcome remains unverified. No broad
UI/Calendar/native/mobile, gRPC/protobuf or whole-product acceptance is inferred.
Next requires the reviewed frozen S/W/D/H/P+uncertainty assembly, exact generated
WASM/glue/build artifacts and an explicit coordinator runtime load turn. See the
harness README for the launch command and cleanup boundaries. Source handoff
`msg_92c6fad13bc8` contains the exact commit/hash/lifecycle/cases/limits.

---

## Historical predecessor source-only preparation

The following record describes `d31f087d`/`80fef9d9` before the observer was wired;
its old interface questions and missing cases are superseded by the source record
above, not evidence that any browser gate has since run.

# Browser WorkBlock normal Worker proof — V source preparation

Status: **SOURCE ONLY; actual gate2 and gate3 NOT RUN and NOT PASSED.**

Owner: dispatched V / task `task_3631c704f3ef`, dispatch `ctx_4772357315ad`.
Branch and worktree: `managed-browser-wb-proof`,
`/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-proof`.
Base: `22fad1b3c6e082fd72c76e715dcf66f7ff40e19c`.
Harness source commit: `d31f087d5ef3aa221930e694d4b04869892cf0aa`.
Main was not edited. No new workers, dependency installs, compilers, Rust/WASM,
Vite, browser, UI/native/mobile apps or target caches were launched or created.

Read the current roadmap checkpoint, contract and independent review before work.
Recomputed `/tmp/zorid-browser-workblock-contract.md` SHA256:
`adc287835bc5e05e649122c3375bc34f54e1f713b440d620421dc390a05bb082`,
matching the assignment/review. The contract's durable main copy is not present
at this isolated base; the exact assigned temporary artifact was read instead.

## What was prepared

New `tests/browser-workblocks-worker/**` contains an independent harness using
actual `BrowserCoreRuntime` plus `admitBrowserClient` and the admitted WorkBlock
service. All claimed mutations cross that service. The normal runtime selects
the actual product Worker; the runner does not substitute a registry or Worker,
and does not preseed authored operations. No managed-records apply or hand-built
wire command produces the operations under test. An opaque HTTP1 relay accepts
only the actual encrypted common sync output.

Three bounded source groups cover CRUD/ref/delete/read/restart, exact old receipt
and observed-remove retry, rejected-write durable-store equality, native-shaped
changes, 66-record window accounting/cursors/fences, and distinct-authority normal
Workers with offline separate-field/title/range/ref/delete conflicts. The latter
checks canonical rows/projection, public candidate/revision/tombstone convergence,
original receipts, sealed wire persistence, pending outboxes, cursors and no echo.
Every one of these browser assertions remains unexecuted.

The runner requires an explicit frozen full HEAD and `--runtime-authorized`, checks
current Rust fingerprint and generated glue/WASM hashes before use, records
source/artifact/browser witnesses, and rejects changed source/artifacts after the
pass. It closes its owned Chrome child and Vite server and cleans only its own
profile; fixture cleanup closes runtimes and deletes only its named databases.
The final durable report includes cleanup failure rather than silently retaining
an earlier successful status.

Prepared but unwired `worker-observer.mjs` observes native strict transactions,
can keep a real product transaction alive using read requests, suppress a chosen
normal reply or drop BroadcastChannel hints. It cannot author/register/prepare
receipts or replace persistence. It needs exact independent review/approval and
source wiring before any claim based on it. No transaction witness exists yet.

## Source validation actually performed

| Exact command | Result |
| --- | --- |
| `node --test tests/browser-workblocks-worker/assertions.test.mjs` | 5 passed, 0 failed; latest run 102.4ms |
| `node --check tests/browser-workblocks-worker/run.mjs` | exit0 |
| `node --check tests/browser-workblocks-worker/fixture.mjs` | exit0 |
| `node --check tests/browser-workblocks-worker/assertions.mjs` | exit0 |
| `node --check tests/browser-workblocks-worker/worker-observer.mjs` | exit0 |
| `git diff --check` | exit0 |

These Node cases check that binary witness comparison detects changed bytes,
window evidence rejects invalid budgets/progress/cursors, changes evidence rejects
wrong sequence/next, strict evidence cannot pass empty/relaxed/unsettled samples,
and rejection checks preserve uncertainty while rejecting missing/wrong failures.
They validate the harness assertions only; no product runtime behavior follows.

## Dependencies and unresolved gates

H/P source read-only inspection confirms `workBlocks` capability and admitted
property names match the harness. A concrete shared-scope startup seam remains:
local `initializeLocal:true` enrolls authority-derived independent logical scopes;
H requires registration before open success, while current normal shared-scope
configuration is callable only after open. V sent root `msg_2f73dc582984` and
H/P `msg_6a725b6a0653` / `msg_a88e30233bab` requesting the supported lifecycle.
Do not hide this with a synthetic registry or external authored seeder.

Root observation-hook review question: `msg_d22380815e53`. Hook wiring and actual
bounded held-transaction release/config revocation, late commit uncertainty,
strict completion/ACK, stale notification, lost hint foreground catch-up and lease
reacquisition cases remain. Journal replay before corrupt accepted state needs
approved reversible fixture-row corruption; newer-state replay is insufficient.
Partial-byte-page nonconsumption, unrelated-collection watermark, wrong key/scope
atomicity and revoked-session receive remain additional required cases. The
fixture exposes these as `remainingGates` and can report only `passed-subset`.

Next assignment must supply the reviewed frozen S/W/D/H/P assembly, current
actual generated WASM and a concrete authorized runtime load turn. Follow
`tests/browser-workblocks-worker/README.md` for the launch command and precise
remaining proof. Source preparation does not complete gate2/3, establish HTTP2/
gRPC/protobuf, rendered browser Calendar, native/mobile or broad browser parity.
