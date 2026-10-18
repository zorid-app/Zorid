# Browser WorkBlock runtime harness and evidence review

Reviewer `term_547a1451-3b97-46d8-a85c-5d527a706a4e`, task
`task_cfd69df67d10`, dispatch `ctx_b7e810f05a37`, isolated
`managed-browser-wb-review`. Only this new document is owned. The previous S/W
review is immutable. No production edits, builds, apps, dependencies or main
mutations are part of this review.

## Current conclusion

**Accepted: the twelve exercised runtime groups at exact assembly
`3f07c9d4ed080bda39c24d8e4ecf1a42907e0e1d`, with the explicit omissions below.**
Independent source review and actual raw evidence review are both complete for
this bounded normal admitted Worker/actual WASM/strict IndexedDB and encrypted
HTTP1 campaign. This does not close every contract gate: a second managed
collection, saturation of the 1 MiB page budget, incoming malicious cross-scope
ciphertext, gRPC/protobuf, rendered Calendar, native/mobile and broad browser
matrix are not established. All earlier failed runs and blocked source reviews
below remain historical evidence; their pending-status statements are superseded
only for the exercised final subset. Final actual details are at the end.

## Authority and status

Read the roadmap execution checkpoint and canonical main's
`docs/managed-data/browser-workblock-implementation-contract.md`, SHA-256
`adc287835bc5e05e649122c3375bc34f54e1f713b440d620421dc390a05bb082`.
Compared the harness against the accepted composed product source at
`2834c783`, including outcome classification, fixed-consumer initialization,
normal admission and strict transaction settlement. Main was sampled at
`c233362aec19d6446f748ffa756d670be3053744`; no integration ownership is assumed.

Initial V inspection: `managed-browser-wb-proof` HEAD
`80fef9d91c6099dfea51ff009b5b95af840233ca` with uncommitted observer successor
files, dispatch `ctx_23f551472e1b`. Final exact source reviewed and **approved
for the bounded harness scope**:
`69f8dca65f8b26d8c3c545786f5dace1ca983665`, harness Git tree
`00b1b757b3ec35ce67af1968662445284cbb8ce4`, clean V worktree. Final source
verdict sent before runtime in `msg_36d44a8a058c`. Source approval grants no
launch authorization. No actual raw runtime artifacts have been assigned or
reviewed. Gates 2/3 remain unaccepted.

## Bounded source findings

No blocking source counterexample, semantic substitution or forged authored
operation found in the reviewed commit. `fixture.mjs` imports `BrowserCoreRuntime` and `admitBrowserClient` and
authors through the admitted `consumer.workBlocks`. The independent replicas
use separate databases and client IDs, normal fixture enrollment and the normal
post-enrollment capability. The harness never registers a replacement consumer,
constructs a semantic worker RPC, seeds authored records, or substitutes a WASM
implementation. HTTP1 relay bytes originate in the real client sync path.

`observation-transform.mjs` affects only the exact normal Worker path. Its two
prepended statements install observation; the original body must match exactly
and is retained in full. Original, prepend and transformed digests are recorded.
The runner requires a full expected HEAD, Rust input fingerprint, bindgen version,
glue/WASM hashes, source digest and an actual transform-load witness, then
recomputes provenance before accepting a successful run. These are useful source
and artifact fences; they are not evidence that a browser ran.

The observer calls native `IDBDatabase.transaction`, object-store/index methods
and `postMessage`. It neither replaces transaction settlement properties nor
the product's capture-phase terminal listeners. A callback hold stops delivery
of one genuine request success, saves the original `onsuccess`, and invokes it
inside a later native keepalive success. Keepalives use the captured native
`control.get` and are excluded from product read traces. The normal transaction
includes `control`, so this is a valid existing store. This deliberately extends
the transaction lifetime; it must be described as fault scheduling, not ordinary
timing. Deadline release or observer error makes the campaign fail.

The boundaries correspond to the actual product API:

- `managed_local_operations.get` holds before replay/prepare.
- `sync_state.get('authored-sequence')` holds inside common authored processing,
  after managed state/change and immutable source staging. The fixture separately
  requires those store writes and a genuine abort plus unchanged durable rows.
- `control.put` after the matching local journal add holds final native writes.
  The late-close case requires actual completion, uncertainty and exact receipt
  recovery without reauthoring.
- Encrypted receive holds a real `managed_receipts.get`; session revocation must
  cause an actual abort and preserve the durable cursor and related stores.

Parent observation injects only `release-client` or `refresh`, explicitly as
fault lifecycle messages. Normal admitted release is tested separately. The
reply-drop wrapper removes exactly one selected real response and forwards all
others unchanged. Broadcast hint suppression affects only the existing normal
core hint channel. No authoring capability is supplied by these wrappers.

The corrupt-state case alters only one existing owned disposable row's state
bytes, retains the original bytes, and restores them on the normal path and in
`finally`. Exact replay must complete with zero writes and only authority,
registration and original-journal reads. It then verifies the later reference
readdition survived. This directly tests replay before corrupt current state;
it does not fabricate a journal or source.

## Coverage and limits at the initial 69f8dca6 review

The sticky-uncertainty, causal-ordering and cleanup gaps in this table are
superseded by the exact successor review below. Other boundaries remain.

The twelve proposed groups cover local CRUD/reference/delete/reopen and original
receipts, stale/collision/domain rejection with store equality, bounded scanning,
real admitted drain, early/common/final-write closing, local credential
independence, committed reply loss, foreground lost-hint catch-up, independent
encrypted offline conflicts/restart and negative key/scope/session handling.
Conflict checks compare public candidates and exact stored canonical state;
restart checks preserve local journals and sealed wire rows. Authored-ledger
identities, pending outboxes, common cursors and unchanged relay item sets bound
the no-echo claim. Wrong scope exercises configuration rejection, not incoming
malicious ciphertext from a different scope.

Required versus omitted evidence must remain explicit:

| Concern | Inspected draft coverage / remaining requirement |
| --- | --- |
| Strict IDB | Every observed normal readwrite start must have a terminal witness; requested and actual durability must both be strict. Runtime still must supply those real events. |
| Completion before acknowledgment | Admitted drain explicitly compares transaction completion and RPC reply ordinals; there is no global per-mutation ordering assertion. Raw events can support further bounded comparisons. |
| Sticky uncertainty | Reply loss is tested through restart and exact replay, but a later definite rejection on the same retained facade is not exercised. No browser runtime sticky-retention claim follows. |
| Windows | 66 live rows cross the 64-row ceiling; deleted/filtered accounting, first-row byte rejection, 31-day bound and cursor fences are exercised. Final source uses Rust-reported first/second snapshot byte counts to force partial consumption and verifies the excluded row resumes. A normal admitted file-family mutation must preserve a WorkBlock cursor; a second managed collection is not exercised. The 1 MiB budget is requested, not saturated. |
| Remote receipt immutability | Exact admitted replay follows merge/restart and sealed rows are compared across restart; broader byte-for-byte history immutability is not exhaustively audited. |
| Cleanup | Fixture records owned DB deletion and failures. Runner closes only its child Chrome, profile and Vite server, but `report.json` lacks explicit PID/exit/profile-removal/server-close receipts. Independent cleanup acceptance needs retained concrete evidence. |
| Other products | No rendered Calendar, gRPC/protobuf, native/mobile, full browser matrix or whole-goal acceptance. |

Reported the sticky-uncertainty and durable cleanup-evidence gaps before freeze
in `msg_3f8cf8012e23`; requested final freeze and source/runtime dispatch scope
through a durable coordinator question. These are evidence boundaries, not a
request to weaken assertions or alter product semantics.

## Checks performed

Ran the eight existing evidence-helper/exact-transform Node cases in the V
worktree; all eight passed. Also parsed the final fixture, runner, worker observer
and observation client with `node --check`; all four passed. These verify
assertion rejection, transform integrity and syntax, not Worker/WASM/IDB/encryption
execution. No mirrored tests, full suite, build or application launch was added
or performed.

## Runtime acceptance

Pending separate assignment of exact frozen assembly and raw artifacts/results.
Source approval, when recorded, will not close normal admitted Worker/strict IDB
or independent encrypted convergence gates. Actual terminal events, provenance,
result content, retained failures and owned cleanup must be inspected before a
bounded runtime acceptance statement.

Coordinator confirmed exact source `69f8dca6` and source-results report
`6b67c21886a6f53b7dca74a702c79743c6bdc491`, and requires the sticky-uncertainty
and cleanup-receipt corrections before runtime. This dispatch remains live for
the follow-up review; the current source approval is not acceptance of those
missing cases. Proposed bounded corrections sent in `msg_2e6f086e7bfd`:

- Extend the real final-write/injected-release case before abandoning its facade.
  Retry identical input after release ACK: the actual Worker predispatch owner
  guard returns a definite rejection, while the previously uncertain facade must
  retain uncertainty. Record both the real raw reply and admitted error. A changed
  request with the same operation must then collide without another author RPC;
  reacquisition must still recover the original durable receipt. No forged reply,
  synthetic author or journal mutation is needed. The existing timeout case
  terminates its runtime, so it cannot provide this same-facade sequence.
- Persist runner-owned Chrome PID, exit code/signal and confirmed exit, exact
  profile path and removed/retained result, Vite closure and cleanup errors. Catch
  cleanup stages individually so one failure cannot skip later cleanup or the
  final report. Unconfirmed cleanup must fail the campaign. Preserve exact
  before/after provenance comparison and all original failure evidence.

## Final source successor — 67ba0d06

**Source approved**, independently reviewed exact commit
`67ba0d065ca011a9133f9d23267603da4c10f159`, harness tree
`b832423573cda6cb1a81a09b64c26a34c04419d9`. Recomputed the 11 `.mjs`/`.html`
file digest using sorted relative UTF-8 path + NUL + file bytes + NUL:
`d7e8b20d24b2a455a62da1630bf74370e0af90f68fe9e24c6bf4e0c1302e12da`.
The exact worker observer, observation client and transform are unchanged from
the reviewed predecessor. No blocking source counterexample found in the
bounded correction delta. This closes the required **source** corrections;
actual runtime behavior remains unknown.

The final-write case now retains the same parent runtime/facade after its actual
late committed mutation and real uncertain host result. The explicit identical
retry must receive a genuine raw `client_ownership_lost`/definite reply while the
facade remains uncertain. A changed same-ID title must collide before any author
RPC, no extra write transaction may start, no new Worker/facade may appear, and
durable rows remain equal. Original receipt recovery follows actual reacquisition;
the report accurately avoids claiming a same-facade successful replay. No
manufactured error acknowledgement or new journal/author seeding was added.

`completedMutationTx` now correlates the incoming real RPC ID, matching reply,
Worker lifetime and mutation identity, checks terminal ordinal before reply, and
retains `report.ordering`. This covers the explicitly inspected fault/replay
cases, including receive and dropped production replies; it is not a global
per-mutation ordering claim. A suppressed reply is observed before dropping, so
its ordering evidence describes production rather than delivery. The genuine
predispatch sticky retry is separately required to have no write transaction.

New `cleanup.mjs` records the exact owned child PID and native spawn/exit events,
signal attempts and matched exitCode/signalCode. It confirms profile absence via
ENOENT only after confirmed exit (or no child), retains an unconfirmed child's
profile, and records Vite close resolution and listener state. Independent cleanup
branches preserve failures. The runner attempts auxiliary artifact writes
individually and embeds cleanup/artifact failures in final `report.json`; cleanup
failure cannot print success. CDP closure records a request, not a socket-closed
proof. Runtime cleanup acceptance must still examine the actual receipts.

Independently ran all **11 focused Node cases**, all passed, including reversed,
cross-Worker and mismatched causal-evidence rejection. Cleanup checks use one
bounded owned **Node** child and a Vite interface double; its child exited and
temporary profile was removed. Parsed all **10 `.mjs` files**, all passed. No
Chrome, Vite, generated-WASM build, product app or production edits occurred.

Final source explicitly retains the second managed-collection and unsaturated
1 MiB limits in `remainingGates` and README. Existing local/remote runtime gates,
rendered UI, non-HTTP1 transport, native/mobile and broad matrix claims remain
unaccepted. This dispatch stays live for coordinator-assigned raw artifact review.

## Actual first run — cf1bb55c FAILED

Coordinator assigned the explicitly authorized run at exact assembly
`cf1bb55cb0e9f9c29a57262f9a4b8673a17f515b`, preserving reviewed harness tree
`b832423573cda6cb1a81a09b64c26a34c04419d9`. V executed the runner inside
`managed-browser-wb-integration`; this reviewer launched no product app or build.
Raw evidence is retained at
`/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-proof/tmp/browser-wb-proof-cf1bb55c/`.

**Runtime verdict: failed; zero complete groups.** The first CRUD group reaches
its stale-title rejection and fails because the admitted client receives
`invalid_workblock_response` with uncertainty instead of definite
`stale_revision`. All subsequent window/fault/restart/independent encrypted
convergence groups remain unexecuted. No gate 2/3 acceptance follows from the
successful operations preceding that failure. `ordering` is empty because the
first group fails before the explicit fault-ordering cases.

The decisive raw events all belong to Worker
`5bc11db7-dc35-4aa9-9170-b028e666799f`:

| Event | Exact evidence |
| --- | --- |
| Original RPC | Operation `stale`, ID `cb4db4d4-0600-4b2d-ae34-159b28787757`, incoming ordinal 161. |
| Real terminal | Transaction 63, requested/actual `strict`, outcome `abort`, zero writes, ordinal 165. |
| Real response | Same RPC ID, ordinal 166, `ok:false`, error `{code:'stale_revision',source:'workblocks',commitUncertain:true}`. |
| Parent outcome | Rejects the unexpected source label as `invalid_workblock_response`, uncertain. |

Independently counted all observed readwrite starts and terminals: **14/14**, all
requested/actual strict, **13 complete and 1 abort**; no observer-error or
hold-deadline event. This is bounded actual normal Worker/IDB evidence, not a
successful full strict campaign. Prompt counterexample sent in
`msg_08256e7db411`; source diagnosis sent in `msg_a4adc04f4c89`.

Exact source chain at this freeze:

1. `crates/zorid-wasm/src/workblocks.rs:21–51` constructs a native same-Worker
   Error with the semantic code, source `workblocks` and false uncertainty.
2. `browser-managed-records.ts:455–460` constructs a fresh BrowserVaultError,
   copies that source without normalization, and only brands it when its local
   terminal variable says abort. `browser-sync-streaming.ts:906` and
   `browser-streaming-vault.ts:402` expose direct method references; there is no
   structured clone or wrapping at the D-to-H seam.
3. `browser-workblocks-host.ts:101–103` checks private abort identity, then
   mutates the same BrowserVaultError and preserves source `workblocks`.
   `browser-core-runtime.ts` accepts only `host`/`rust` in this response envelope.
4. `browser-normalized-idb.ts:83` installs its rejecting `onabort` before D adds
   terminal listeners at `browser-managed-records.ts:418–419` inside the later
   authority-read callback. The source-supported diagnosis is a native listener
   microtask-ordering hole: the rejection continuation can run before the later
   terminal listener. Capture-listener timing is not an adequate settlement
   guarantee. The raw trace proves the lost classification; it does not directly
   instrument the private terminal variable or prove each microtask step.

The correction needs authentic terminal evidence recorded in normalized native
settlement **before** resolve/reject, plus trusted semantic error normalization.
It must preserve uncertainty for complete/unreported, late ownership loss and
unknown outcomes. Public `code`, `source` or `commitUncertain:false` must never
mint definite-abort proof. Widening P to accept `workblocks` alone would leave
the actual abort misclassification unresolved. Production fixes require a named
owner; this reviewer makes none and authorizes no rerun.

Independently recomputed post-failure provenance from the exact assembly:

- Rust fingerprint `2839865d44b7a7ba87e862dfac82d118125053866552135c7643df8fedae60d0`.
- Source digest `d532fec3a10b23bf89c8be8e1e3f876c6be9d7f92f30caf35e3ebe4f04c806fb`.
- Glue SHA256 `ab5af194bf78cad8a5dd5da6396d7671bef07172e24463eb0c82ad2b1221986f`.
- WASM SHA256 `7e95c92909d7e2fd8c4f4136a0844bde93b3cbf3c395f13655496af97a33121f`.

All match the original report; the transformed-load witnesses identify the
actual normal Worker in the integration checkout and its unchanged original
body. The failure path does not reach runner's successful post-proof comparison,
so independent post-failure hashing and V's `post-run-audit.json` supply that
check explicitly. Original raw files stayed unchanged: report SHA256
`930cf6daa751ef4823775bf32abcc6ff61670cd19aa5f51687637316762f3da0`, cleanup SHA256
`c09beb05b136ad80d78bb4b67490bb2f52e711447f59c12d149679929e56614c`.

**Owned cleanup accepted for this failed run.** Native Chrome PID 58255 has an
exit event `(code:0,signal:null)` after SIGTERM; Vite port 51281 close resolved
with listening false, profile removal has ENOENT, and the unique owned DB deletion
succeeded. Independently read `cleanup.json` and the embedded report, checked
the exact PID is absent, found no listener on that port, and observed the recorded
profile path absent. Cleanup and auxiliary artifact failure arrays are empty.
Browser receipt identifies Chrome 155.0.8059.80. Cleanup success does not change
the failed runtime verdict.

## Terminal correction source — 8bc3ecc5

Coordinator named `term_2e39c53b-1726-4fb5-8063-d07e1a4e413c`, task
`task_c44860fcf8c0`, dispatch `ctx_e0b7e21b3041`, isolated
`managed-browser-wb-terminal-fix`, to implement the narrow settlement/source
correction. Agreed the hook before edits; reviewed exact commit
`8bc3ecc518bb562a064261de6dcb6b35f52af487` against `cf1bb55c`. **Source approved**
in `msg_2b662a56cec6` / `msg_9169f5448ad8`; no blocking counterexample found.

Reviewed all three product changes, three focused test changes and results doc.
Normalized settlement invokes optional internal `onTerminal` synchronously before
resolve/reject; hook exceptions reject without leaving the promise pending. D
passes a per-attempt assignment closure, removes later capture listeners, and
retains fresh error wrappers/private WeakSet proof. Complete/unreported and late
owner loss remain uncertain. The source does not treat a rejected promise or
public error field as rollback evidence.

`callWorkBlockWasm` wraps only actual trusted binding calls, normalizes the native
`workblocks` failure source to `rust`, and privately brands provenance. D copies
Rust provenance only from that identity; an identical-shaped error originating in
host admission becomes `host`. H preflight/read/window/session boundaries use the
same narrow wrapper. No P decoder widening, stores/schema/write-order changes,
Rust/WASM semantic changes, harness weakening or dependency changes occurred.

Independently ran the four scoped Node test files with concurrency 1: **97 passed,
0 failed**. Reviewed the regression's explicit microtask checkpoint between the
normalized handler and later listeners and the retained owner counterexample log:
restoring the old later-listener D strategy makes its uncertainty assertion fail
`true !== false`. Also reviewed complete-without-result, hook exceptions, reused
underlying errors, copied witness rejection and unchanged sticky-uncertainty tests.
Owner reports full TypeScript check passed; this reviewer did not repeat it.

These checks establish the bounded source correction and regression sensitivity.
They do not repair or replace the retained failed run. Coordinator reconciliation,
new exact freeze and actual normal Worker/strict IDB rerun remain required;
independent encrypted convergence is still unexecuted.

## Corrected actual run — 3b555af6 FAILED at harness eviction setup

Coordinator ran exact assembly `3b555af6c33018089d263402502ba309d1f8bd8c` with
the approved terminal fix and unchanged actual WASM. Raw output:
`/Users/ctk/orca/workspaces/Zorid/managed-data-foundation/tmp/browser-wb-proof-3b555af6/`.
Independently inspected report, raw events, cleanup and retained runner error.

The first full CRUD/ref/replay/rejection/restart group **passes**. Its actual
`stale` reply now has `code:stale_revision, source:rust, commitUncertain:false`,
confirming the original failure is corrected through the actual normal Worker.
The overall run **fails** in the second window group at fixture line 98:
`Expected rejection: cursor_expired`. Later fault and independent encrypted
convergence groups remain unexecuted, with no gate 2/3 acceptance.

This second failure has a concrete **harness setup defect**, missed in the earlier
source review. It captures an initial cursor under `q`, then requests the same
initial page under identical `q` nine times. Rust `workblocks.rs:718–725`
intentionally reuses a retained cursor when query, consumed position and watermark
match; eviction at line 737 occurs only when inserting a new distinct entry.
`workblocks_tests.rs` also checks same-page reuse before distinct-entry eviction.
Nine identical queries therefore do not fill nine slots, and expecting expiry is
invalid. Reported promptly in `msg_42ce53aa807e` and `msg_c8c014616f02`.

Proposed bounded harness correction: retain original `q` cursor, produce at least
nine distinct continued query/position identities (for example valid limits
2 through 10 while enough rows remain), require non-null unique tokens, then
require original `q` cursor expiry. Preserve existing repeated-cursor assertions;
no product/session behavior change or weaker expiry assertion is justified.

Independent post-failure hashing matches recorded Rust fingerprint and both
glue/WASM hashes from the first run; new source digest is
`a63223d819b345234189fe0272cf7f82a46424735a579662e173bd8c8db2a930`.
Report SHA256:
`b419f672306419e5025dc3ac800a0b50a69ce649d25284cfd9e59cbb77f6da5a`;
cleanup SHA256:
`97d95b1e7b0ef0b7ce75421be93d04073e82876f642562d62d25faddfcd19dbd`.
All **102/102** observed write starts have strict terminal witnesses: 98 complete,
4 abort, with no observer-error/deadline event. This does not substitute for the
unexecuted transaction-fault campaign; aggregate final `strict` and `ordering`
remain unset/empty after the early failure.

Owned cleanup independently accepted: PID 49042 native exit/close code 0 after
SIGTERM, profile ENOENT, Vite 61091 close resolved/listening false, both owned DBs
deleted, failure arrays empty. Also checked exact PID absent, profile absent and
no listener on the port. No reviewer build/app/rerun or production edit occurred.

## Cursor harness successor — 64cacfbf

Named cursor harness owner `term_8fee1f84-94e0-4b5b-856f-3bfa56be802c`, task
`task_761a84781664`, dispatch `ctx_7406c718a396`, delivered exact
`64cacfbf28b648e2567705b24d6bdf250b0a9695`. **Bounded source approved** after
reviewing the complete fixture/report delta. It retains the original continuation,
checks identical-page reuse, allocates nine valid distinct `fromMs`1..9 queries,
requires their original watermark and pairwise unique nonnull tokens distinct
from the original, and only then requires original-token expiry. Query/page
evidence is retained. Earlier repeated-continuation and subsequent reopen checks
remain. No product source or runner semantics changed.

Independent fixture syntax check passed. Recomputed fixture SHA256
`386c7ad13f010ee5177e217734d50cb0ba39899c6b12f97589f88a6314233c1f` and 11-file
harness digest
`b3a6f56ac76dddaf3a37e2e58d220215339b568e3348c9b787b64de09eda913d`, both match.
All five versioned second-run raw copies compare byte-for-byte with the original
foundation output. Report accurately preserves overall failure, first-group pass,
cleanup and unexecuted later gates. Unchanged helper tests were not repeated by
this reviewer for the fixture-only delta; owner reports all 11 remain passing.
Actual corrected eviction/fault/convergence runtime is still pending.

## Third actual run — d8d3a4e9 FAILED after four groups

Exact coordinator-authorized assembly
`d8d3a4e9c97c83b0bfcdc53bb65a4d7fea12886f`; raw evidence at
`/Users/ctk/orca/workspaces/Zorid/managed-data-foundation/tmp/browser-wb-proof-d8d3a4e9/`.
Four complete groups pass: CRUD/ref/replay/restart; bounded windows including
nine distinct eviction allocations; original-journal replay despite corrupt
current state; admitted release draining a held strict write and reacquisition.
The overall run **fails** during the following before-prepare owner-loss case at
fixture line 279, comparing a full durable snapshot after release ACK.

Raw Worker `f1625133-001b-4d2d-ad1e-838cbc1dd498` gives a decisive causal prefix:

- Transaction 24 holds the actual original journal get, then really aborts strict
  at ordinal 64 with zero writes.
- Exact mutation RPC `f15186ec-9275-47c0-81fa-c3685dacee86` replies ordinal 65,
  `client_not_admitted`, host, definite false uncertainty.
- Separate strict transaction 25 completes at ordinal 67, reading
  `control['document-index:v1/catalog']` then issuing `control.put`.
- Release ACK follows at ordinal 70, after normal document-index cleanup and
  binary-read cleanup. The failed equality comparison occurs after this ACK.

The mutation itself is not shown partially committing. The snapshot includes
**every control row**, while normal Worker release calls document-index close,
whose `browser-document-index.ts:310–311` writes its catalog. Absent catalog rows
are interpreted as an empty catalog at lines 85–97, so even an unused cache can
gain its first catalog row during close. This source and actual separate
transaction strongly explain a harness comparison crossing a legitimate lifecycle
write. However, **raw before/after row snapshots were not retained**, and the
owned DBs are deleted. The exact row delta cannot now be independently recovered;
do not claim that only the catalog differed as an observed fact.

Reported this distinction immediately in `msg_3bf78b8cb1b3` and
`msg_e97dcb4ad62b`. Required next harness evidence: retain the full snapshot diff,
validate the narrowly expected catalog close delta explicitly, and require every
other control identity/counter and every managed/source/outbox/cursor store to
remain identical. Blanket control exclusion, a product patch, or treating the
generic equality message as proved data loss is unwarranted. Later common-authored,
late-commit/sticky uncertainty and encrypted convergence cases remain unexecuted.

The report retains three exact terminal/RPC order comparisons: corrupt replay
101<105, admitted drain 63<67, and before-prepare abort 64<65, each within its
own identified Worker lifetime. All **135/135** observed write starts have strict
terminals: 130 complete, 5 abort; no observer-error/deadline. Independently
recomputed source digest
`7c431190d3c9116fa2117f332044f899b3bfdc7884970b2c90a2ba6013c20410` and both
unchanged generated asset hashes, matching raw provenance. No Rust/build-script
inputs changed from run two. Report SHA256
`03de96463dbce69a0339958e8b05842af308ca89976bab2ad374473845bdbb49`;
cleanup SHA256
`89706e94a5ff5b44f7dc9c29fbe88a06bdd569fb93e300afe292e9f6ed351020`.

Owned cleanup independently accepted: exact PID 84250 exit/close code 0 after
SIGTERM, Vite 64811 closed/listening false, profile ENOENT and five owned DBs
deleted, empty failure arrays. Independently checked PID/profile/listener absent.
No reviewer app/build/source mutation/rerun occurred; gate 2/3 remain unaccepted.

## Atomicity harness source review — a5676bb3 blocked

Reviewed exact `a5676bb3be729cbd5c11f54614cc1aa0831e1563`: all-store keyed
snapshots now use one readonly transaction and are retained with diffs before
assertions, including failed boundaries. The narrowly expected absent-to-empty
catalog schema, persisted authority, write key/value and lifecycle causality are
explicit. Test-only observer adds exact control write content; no product edits.

**Not source approved:** `abortedAtomicityEvidence` counts all completed
readwrite transactions between mutation reply and release ACK and requires only
one. The actual third-run trace already has both catalog transaction 25 and
binary cleanup transaction 26; the latter completes ordinal 69 with `writes:[]`
before release ACK 70. The proposed helper would reject that valid lifecycle
again. Independently reproduced this pure-helper counterexample without editing
files or running an app. Prompt blocker: `msg_362d0cc804c9`; prior owner had
settled, so coordinator named fresh correction dispatch `ctx_5008bde5ad90`.

Required correction: a unique **write-bearing** exact catalog close transaction,
while retaining every other intervening transaction and requiring zero writes
from each, with terminal/strict evidence as applicable. Keep full row/inventory
equality and all causal/schema/authority checks. No broader exception or runtime
launch is authorized by this review. Other inspected source changes have no
identified blocker; final exact successor review remains required.

## Atomicity harness successor — 0d10bcd6 approved

Reviewed exact `0d10bcd63a105b88d96ef663018eace5291b91d8`, harness tree
`ab920172e2a9f51cb23f77c538dcfba2c32f2d4f`. **Source approved** in
`msg_85c5ae6fc547` and `msg_e7b484ae73da`; this supersedes the a567 blocker.
Independent 12-file `.mjs`/`.html` digest:
`f045e03dbdd5e0c65b86a32fae5d0dba6db979a3e8b3a65ea780a3848c7a382c`.

The helper now finds exactly one write-bearing close transaction and validates its
complete strict outcome, exact catalog content, authority, control-only scope,
read set and correlated release chronology. Every other observed transaction
except the actual aborted mutation must have zero writes, including aborted
transactions; all terminal evidence has unique IDs, proper order and the same
Worker/database. The no-diff path also checks witnesses/lifecycle and rejects
other write attempts. Duplicate snapshot row keys cannot hide a difference.
All-store snapshot capture and retained diffs remain intact; no blanket control
exclusion or product change was introduced.

Independently ran all **16 focused Node checks**, all passed. New cases reproduce
the actual raw3-shaped catalog tx25 plus zero-write tx26 and reject any additional
put/add/delete/clear, even when aborted or snapshots remain equal. Wrong schema,
authority, stores, counters, cursor/managed bytes, durability, IDs and chronology
also reject. Fixture, observer and helper syntax checks and diff check passed.
All five copied raw3 artifacts remain byte-identical to the originals. No new
product/browser run occurred; coordinator exact composition and actual evidence
are still required. The old raw3 exact-delta limitation remains unchanged.

## Final actual run — 3f07c9d4 accepted bounded subset

Coordinator authorized and executed frozen
`3f07c9d4ed080bda39c24d8e4ecf1a42907e0e1d` in the integration checkout.
Raw output remains at
`/Users/ctk/orca/workspaces/Zorid/managed-data-foundation/tmp/browser-wb-proof-3f07c9d4/`.
Independently reviewed its 42,831,740-byte `report.json`, cleanup/browser/raw
events, full snapshots/diffs and the relevant exact frozen source. No new product
execution was performed by this reviewer. Runtime verdict: **accepted for all
twelve exercised groups**, `passed-subset`, with two explicit remaining-gate
entries. RunnerError is null; auxiliary artifact failures are empty.

| Exercised actual behavior | Bounded retained evidence |
| --- | --- |
| CRUD/ref/delete, rejected writes, original receipts and restart | First full group passes, including actual `stale_revision/rust/false`; original remove retry preserves later readdition. |
| Windows and cursors | 66 live records, first scan64, filtered/deleted costs, partial-byte scan1 and excluded-row resumption, nine distinct continuation allocations before old expiry, repeat/foreign/reopen/query/collection fences. |
| Replay before corrupt current state | Real completed replay reads only `control.local-store-id`, registration and original local journal; zero writes. The current-state corruption is restored. |
| Admitted drain | Real held final-write transaction completes before exact mutation ACK; admitted release waits, and the same client reacquires its original receipt. |
| Before-prepare and common-authored owner loss | Both actual strict transactions abort with definite errors; staged common-authored writes are genuinely present before abort. Full31-store snapshots prove no mutation delta. |
| Late commit and sticky uncertainty | Real strict completion precedes uncertain error; same retained facade receives genuine raw definite owner-loss rejection yet retains uncertainty, blocks changed same-ID input locally, then reacquisition recovers the original receipt without reauthoring. |
| Credential-independent local save | Held local mutation completes after sync revocation and retains its common outbox without network authoring. |
| Committed reply loss | Actual committed success is dropped, real timeout remains uncertain, and restart replays `g_lost_reply` exactly without new source/journal/change/outbox rows. |
| Lost hint | Two clients share one actual authority with different client IDs; foreground catch-up delivers exactly one missed change without duplicate refresh delivery. |
| Independent encrypted convergence | Distinct real authorities/leases, normal fixed consumer and actual common HTTP1 encrypted exchange preserve separate fields, both title alternatives, both atomic range alternatives, readded ref and delete/edit tombstone through restart/replay. |
| Negative receive/configuration | Wrong key `sync_plan_rejected`, wrong-scope configuration `sync_scope_conflict` and revoked held receive `sync_session_revoked`; all three retained full snapshot diffs are empty. Actual receive abort precedes reply and normal reconfiguration converges. |

The two aborted owner-loss records now prove the narrowly expected lifecycle
exception rather than infer it. Independently recomputed keyed differences over
all31 stores: in each case the **only** change is creation of the exact empty
document-index catalog bound to that DB's persisted local authority. The mutation
tx24 aborts ordinal64; its definite reply follows65; separate strict catalog
tx25 writes that exact row and completes67; strict tx26 completes69 with zero
writes; correlated release ACK follows70. Every other control identity/counter
and every other store row is unchanged. Before-prepare has zero staged writes;
common-authored has six staged writes including managed state/change, immutable
source header/payload, binding and control, all rolled back. This proves the
expected delta **in the final run**, not retrospectively in raw3.

Independently matched all **443** observed readwrite start identities to **443**
terminal identities: **436 complete, 7 abort**, all requested/actual strict and
no observer-error or hold-deadline. Ten case-local terminal/RPC pairs have matching
Worker/operation/RPC identity and terminal ordinal before reply. These support
the claimed cases; ordinary operations do not acquire a global per-RPC ordering
claim. All43 retained atomicity snapshots are complete captures.

Late-commit details: the first real postcommit owner-loss response is uncertain;
the same-facade retry's actual Worker response is
`client_ownership_lost, commitUncertain:false`, while the retained facade returns
true. Exactly one explicit retry reaches the original Worker, changed input
collides locally, no new write/automatic operation is admitted, and the recovered
original receipt has sequence2. Same-facade uncertainty and later reacquisition
success are distinct claims.

The independent HTTP1 replicas have authority IDs
`7e14ae53-76dd-4197-b318-d4e753a86da3` and
`9bc37896-2539-4242-89fa-4361ed0e35ac`, with distinct client IDs and one authorized
logical scope. Initial convergence has17 uploads and17 persisted sealed wire
rows per replica. The harness checks exact canonical state/projection/revision,
original receipts, sealed bytes across restart, no receive echo, cleared pending
outboxes and consistent common cursors. Raw retained projections show red/blue
title candidates, `range_left`/`range_right` as whole alternatives, `missing_note`
retained after ref readdition, and a deleted/null public block after delete/edit.
The group receipt array later contains19 entries because two negative-group
authors append to the same array; **do not describe nineteen original receipt
replays in the initial convergence group**. Wrong-scope evidence remains a
configuration rejection, not an incoming cross-scope ciphertext test.

Independently recomputed after completion: Rust fingerprint remains
`2839865d44b7a7ba87e862dfac82d118125053866552135c7643df8fedae60d0`, source digest
`b71686c024e405843ed7a34acb3b7db1b9b391e0cea86cd900d0e36374917d50`, glue
`ab5af194bf78cad8a5dd5da6396d7671bef07172e24463eb0c82ad2b1221986f`, WASM
`7e95c92909d7e2fd8c4f4136a0844bde93b3cbf3c395f13655496af97a33121f`. All match
the actual pre-run report/build metadata, bindgen0.2.129 and the runner's successful
post-run equality check. HEAD remains exact3f07c9d4; the three product terminal-fix
files match reviewed8bc3ecc5 exactly. Transformed-load witnesses retain the normal
Worker's original hash and authorized prepend hashes, with no registry substitute.

Final report SHA256:
`34031e83c8c02d963c9ddcbb496f0cf753e13c4285e78b437b47fef5e22d30c6`;
cleanup SHA256:
`77217d8dac409f8d9e9178ab79b6baad6dc463a1dd9ad6bdca7604892a306628`.
**Owned cleanup accepted:** Chrome38170 native exit0 after SIGTERM, Vite54132
close resolved/listening false, profile removal confirmed ENOENT, all12 named DB
deletions succeed. Independently checked the exact PID/profile/listener absent.
Coordinator corrected an initially premature runner-exit statement: the Node
parent lingered after PASS/app cleanup, then its owned exec session35242 positively
returned exit0 at05:02:57 UTC. This review relies on that coordinator-owned terminal
receipt for runner exit, not the earlier PASS log; no cause for the delay is inferred.

No further actual run is justified by this evidence. Remaining second-collection,
unsaturated1MiB, transport/UI/mobile/matrix and incoming-cross-scope limitations
stay explicit. Main integration is coordinator-owned; acceptance here does not
claim main delivery, full product parity or whole-goal completion.

## Final report, compact manifest and source inventory review

Successor reviewer task `task_f91cdc64e2c8`, dispatch `ctx_1b271d6baf26`, same
terminal/worktree, owns only this review document. Documentation author
`term_23278648-ea86-451a-9509-f8ef012ae35d`, task `task_172568a274b3`, dispatch
`ctx_0a4cfee3f064`, supplied final exact freeze
`24a3dd98c54287fd1ec3ad717e67df0dcad69ce6` in `managed-browser-wb-proof`, ordered
documentation commits `cc26408a`, `04c307fa`, `24a3dd98`. **Final scoped report,
manifest and inventory accepted**, communicated to author/coordinator in
`msg_df4be615aa58` and `msg_589127e031d2`.

Accepted paths and exact SHA256:

- `docs/managed-data/browser-workblocks-worker-results.md`, including the ordered
  source inventory:
  `3d7696b5794dd124c36cf02a9cfa2b1fc7bde8a5ac8ca8dff9e8f4296dcc1c4c`.
- `docs/managed-data/browser-workblocks-3f07c9d4-evidence-manifest.json`:
  `cfa4077f696edd97f39c882b207c46502a8de534a6685450d30f57a6df69c43c`.

Independently verified the compact manifest's nine raw/generated file paths,
sizes and SHA256 against the persistent foundation run directory/sibling log
and integration generated assets. They match the already accepted run and
provenance. This successor did not duplicate the actual runtime audit or launch
tests, apps, compilers or a new run. Documentation diff checks passed.

The final current report accurately states twelve passed groups,443 strict
terminals,43 snapshots,12 concrete DB deletions and the delayed positive Node exit
at05:02:57. It distinguishes17 initial encrypted wire updates from the later
19-entry shared receipt array; it does not claim19 initial replays. Same-facade
sticky uncertainty and blocked changed input **reusing the same operation ID**
are distinguished from successful original receipt recovery through a newly
reacquired runtime. Required wording corrections also make wrong-scope
configuration rejection distinct from unproved incoming malicious cross-scope
ciphertext, in both current report scope and manifest limitations. Original raw
`remainingGates` strings remain unchanged. HTTP1 JSON, second managed collection,
unsaturated1MiB and absent rendered/gRPC/mobile/full-matrix claims stay explicit.

The ordered integration inventory selects W, D, H, P and harness source with the
uncertainty/terminal seams carried coherently. It explicitly excludes canonical
S (`6f864a31`/`a4389f5f`), portable-origin foundation evidence8133fd2c and huge
historical raw copies. Independently confirmed current main's shared WorkBlock
service/test bytes match the accepted assembly. The inventory requires narrowly
adding WASM `mod workblocks;` and shared helper hunks, not replacing either whole
crate lib; it preserves main's `local_intent`, exports/modules and unrelated
editor/mobile/recovery work. Main sampled at `9e4a755f` during this review.
This is approval of the scoped selection/report, not unverified future integration
or authority to overwrite main. Coordinator supplies the approved paths to main's
sole integrator, which must reconcile and validate affected behavior separately.
