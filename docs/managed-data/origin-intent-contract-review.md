# Exact original-intent successor review

Review owner: `term_a24edaa8-8f57-426b-9d65-aad03f4838d6`; task
`task_ff62f0626cc6`, dispatch `ctx_f97438198514`. Documentation only, isolated
branch/worktree `managed-intent-contract-review`; coordinator retains integration.

## Verdict

**Design acceptable for root representation selection; I1 resolves the earlier
no-row retirement blocker. No additional blocking protocol contradiction found
in this bounded review.** This does not approve implementation or establish
execution correctness. Root still must select the reserved namespace and budgets,
assign the coordinated seams, and authorize migration/intent implementation.
Current-v1 S/W/D/H/P/V delivery is separate and remains unaffected.

Reviewed exact target: recovery commit
`5a176c0e28655f495f645d7323988abb0c64973d`,
`docs/managed-data/origin-intent-contract.md`, SHA256
`14a5a48ed1edd45288f86716ecb5c33c4374a85391b8bc6b3d70e1053d9675f7`.
Its committed bytes equal the named recovery worktree file. The document records
recovery of corrected predecessor SHA256
`a14edf25ff3a4a1028eb5e9fc23d3ca27562541aeb812600ba245d08ec645f1d`;
this review verifies the durable successor itself, not the deleted predecessor.

Canonical migration contract inspected here: SHA256
`3abec071b0300b31376612aa372e86dce8b8fd3f90e18e8c866e06f813686760`.
Working source HEAD `22fad1b3c6e082fd72c76e715dcf66f7ff40e19c` reproduces the
target's eight-file source witness SHA256
`23d7261ade9200ede499aab0d3a2172224b7d527c4bc7ee3677742920d7a0999`
(sorted relative path + NUL + bytes + NUL, paths listed in target's evidence
freeze). No source/build/app changes, workers, network or installation were used.

## Counterexample assessment and concrete seams

| Concern | Assessment against exact successor and actual source |
| --- | --- |
| Capture revision issuance | Target lines 65, 83, 89–90 require host-generated canonical checkpoint revision **before** canonical intent encoding and the identical revision in the durable checkpoint. Native `checkpoints.rs::CheckpointWrite.next_revision` and browser `CheckpointChange.nextRevision` already accept a supplied revision; neither currently issues it for managed intents. Generate once inside the capture path; never persist with one revision and encode/return another. Existing capture/journal lookup precedes issuance; repeat capture must compare original input, excluding newly read origin, and reuse the original ref. No durable capture means no apply was dispatched, so a later first successful capture is well defined. |
| Reserved namespace/admission bypass | Current native checkpoint `scope` checks physical Store ID only; browser `browserCheckpoints` accepts generic client strings. Native `client_admission::claim`, browser `claimBrowserClient` and `admitBrowserClient` do not reserve a system identity. Target explicitly requires denial at generic claim/admission **and** checkpoint load/CAS/list/changes, plus removal/internalization of unfenced managed apply. This closes the design bypass, but all these guards are new work. A prefix-only guard or admission-only guard is insufficient. |
| Raw/semantic canonical identity | Target retains complete origin registration/lineage, physical authority, original operation/scope/witness/raw command and optional semantic DTO in shared Rust canonical bytes. This satisfies migration contract's byte identity requirement; current `admission::local_request` still contains only scope/witness/command. Check both the semantic DTO and stored Rust-derived raw command: remove-ref tags are captured once, never regenerated on retry; Create's original empty witness remains independent of later defaults. JSON strings are a storage representation, not JS semantic equality. |
| Current authorization plus historical replay | Native `managed_apply` authorizes inside IMMEDIATE and checks journal before `load`/`State::prepare`; browser `apply` authorizes and reads journal before `readFacts`. WASM `prepare_local_inner` similarly branches on prior request before accepted-state preparation. The successor preserves these orders while extending identity. After upgrade/restart a fresh current handle validates historical retained origin and returns exact original journal/result binding; `require_fresh_origin` applies only when no row exists. A stale handle or ref does not acquire replay authority. |
| No-row v1 Create under v2 defaults | Target lines 91–96 explicitly reject missing/unverifiable/mismatched origin before state/default preparation even with equal empty digests. This directly meets the canonical migration contract's no-row correction. A held-plan registration fence alone would fail this case; successor additionally requires the retained pending origin on a newly reacquired call. |
| Apply/retire, either order | Target lines 100–111 require journal read, exact original live capture-head CAS and accounting in one serialized transaction. Retirement first prevents any fresh or held-plan publication; apply first makes reconciled-uncommitted return `committed`, preserving pending accounting until exact receipt acknowledgement. Final live-head/nondeleted-body and current registration checks belong to the publication transaction. Separate journal query followed by public checkpoint CAS would violate the contract. |
| Lost retirement acknowledgement | Tombstone retry uses original ref/capture revision and returns the existing retirement revision, with current authorization and journal recheck; it neither allocates a new revision nor frees a slot twice. Native history retains `expected_revision`; browser immutable revision rows do **not** retain a predecessor, but the permanent tombstone head retains `previousRevision`. For browser proof, validate that head plus both immutable fences, same key, first live capture and no intervening successor; do not assume the revision row has a nonexistent edge field. These existing structures suffice under the proposed immutable two-revision-per-key rule. |
| Missing/corrupt refs or history | Target requires explicit failure for missing/forged ref, foreign authority, malformed body, changed request, missing/inconsistent history and unexpected successor. Existing native checkpoint loading verifies head/latest/history/body consistency; browser load verifies head fence and missing-head retained history, and generic CAS preserves creation membership. Internal helpers must retain these checks and add exact two-revision retirement proof. A no-row tombstone can prove only original key/ref retirement; it cannot recreate the discarded body or permit recapture. Committed replay may recover full identity from its exact journal evidence, as explicitly allowed. |
| Limits and settlement capacity | Live32/16MiB and historical4096-key/16MiB metadata limits are explicit, per physical authority, with admission reserving future retirement space. Retired bodies free live bytes/slots once; keys and both fences remain charged. Root must accept the permanent distinct-operation ceiling or choose another reviewed store/retention policy: at4096 retired keys, even zero live intents cannot admit a4097th operation. This is disclosed bounded scope, not unlimited product readiness. Logical reservations do not make physical IO/quota failures successful; failures retain an uncertain durable boundary for retry. |

The no-row `reconciled_uncommitted` transition is the missing executable contract:
it can retire an origin-mismatched intent without inventing a commit receipt,
while the same transaction refuses to call a real durable success cancelled.
The tagged `Committed` result is an observation, not retirement. A subsequent
`AcknowledgedCommitted` call must carry the exact original receipt.

## Conditions before implementation

These are existing successor requirements to preserve, not a new architecture:

- Root selects fixed reserved UUID and accepts/adjusts all four budgets. Define
  deterministic charged metadata bytes including head, both fences and encoding
  overhead, reserving retirement at capture admission. Validate/reconstruct usage
  on reopen and reject inconsistent counters; never default corrupt accounting
  to empty capacity. Native can derive bounded totals transactionally; browser
  may use namespaced existing `control` rows. No new DDL/store/index is implied.
- Factor transaction-local checkpoint helpers. Public native checkpoint CAS opens
  its own IMMEDIATE/FULL transaction; public browser CAS opens its own strict
  transaction. Neither may be called from managed apply/settlement. Preserve
  global checkpoint sequence/history checks and browser `creationOrder`.
- Browser `createBrowserManagedRecords` currently combines managed/common stores;
  `normalizedTransact` adds `control`, but not checkpoint heads/revisions.
  Explicitly include both checkpoint stores in the relevant shared transactions.
  Resolve only on strict transaction completion, keep callbacks synchronous and
  retain actual lease/enrollment/authority guards at every publication boundary.
- Named portable/native/WASM/browser/admission/transport owners must reconcile
  current-v1 changes before implementation. New-format APIs must reject missing
  origin rather than leave old apply as a fallback. No migration-authored domain
  operations, wire-v1 changes, automatic real-vault clearing or public origin
  capability follows from this approval recommendation.

## Required execution evidence

Run each storage case against real native SQLite and **generated Rust WASM with
strict IDB**, not only mocked exports/in-memory planners. No tests were run for
this documentation review; the following remain required gates:

1. Golden complete canonical bytes/ref identity across native/WASM, including
   nested default key ordering/numeric identity and original raw/semantic binding.
   Tamper every bound dimension; reject old tuple/missing origin. Same operation
   with changed semantic DTO or remove-ref tag command collides.
2. Capture response loss and restart before/after durable completion. Recover
   identical ref from pending enumeration/repeated capture, including new admitted
   client in same authority; foreign DB/store fails. Verify host-issued revision
   equals embedded capture revision and exact checkpoint head/fence.
3. Capture v1 generic `Create([])` with no journal (precommit abort), install test
   v2 optional default with unchanged empty digest, reacquire/restart and apply
   original ref: origin mismatch before defaults/state/source/change/outbox/journal
   writes. Missing/corrupt/live-ref mismatch also has zero domain effects.
4. Separately commit v1, lose apply ACK, upgrade/restart and reacquire: exact
   original receipt/payload/sequence replay before fresh state/quota/default checks,
   with no duplicate change/authored/outbox. Stale authorization fails; changed
   request/ref collides. Repeat after legitimate pending retirement using journal.
5. Fill32 no-row v1 captures, upgrade, explicitly reconcile/retire all32 and capture
   a new operation. Test no-row committed-ACK rejection, committed-row reconciled
   result without freeing capacity, then exact committed ACK retirement. Hold
   apply/retire in both orders, including held preparation before retirement.
6. Lose settlement ACK, reopen and repeat original ref/disposition: identical
   retirement revision, one decrement, no extra checkpoint revision. Reject wrong
   receipt/ref/head, foreign tombstone, missing capture/retirement fences, broken
   predecessor, unexpected successor and corrupt counters without new effects.
7. Exercise live bytes, live slots, historical keys and charged metadata boundaries
   independently. New captures cannot consume reserved retirement capacity;
   tombstones remain charged/reusable only as retry evidence. At4096 historical
   keys reject new capture, never evict uncertain intent/history. Inject storage
   abort/quota failure and confirm no early success or partial accounting.
8. Attempt reserved namespace claim and every generic checkpoint entry point, plus
   old generic managed apply, through actual native/browser admitted paths. Verify
   ordinary checkpoint clients still work and sequence/history invariants survive
   interleaved generic writes. Product Worker/desktop two-stage capture and drain
   need separate composed service proof; they are not established by storage tests.

This verdict is a bounded design review. Implementation ownership, migration
execution approval and native/generated-WASM/strict-IDB evidence remain pending;
no integrated, mobile, rendered Calendar or encrypted convergence claim is made.
