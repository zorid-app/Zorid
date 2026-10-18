# Managed data execution checkpoint

Started 2026-10-17 America/Toronto (2026-10-18 00:35 UTC).

User explicitly requested implementing the handoff plan, starting a built-in goal,
and coordinating other Orca sessions. Canonical scope is the preserved
[implementation plan](implementation-plan.md). This is not a completion report.
The goal remains active across all phases, including desktop and native UI.

## Authority and separation

Managed structured records are a separate data model and encrypted payload family
from normal file synchronization. Notes and attachments retain file authority and
their existing sync behavior; managed records must not weaken plain-text/file
validation or turn ordinary Markdown properties into a second SQL authority.
Both use shared Rust persistence/sync infrastructure and encrypted transport.
Features must not introduce independent replication engines.

Core coordinator `term_2fbd0185-6f86-4649-824c-92faf46852f7`, Run
`run_3e72b2c9ab72`, retains sole main integration and heavy resource scheduling.
This session must not write main, root build manifests, shared bridge seams or
owned editor/mobile internals without agreed scope.

## Current owner and checkout

- Coordinator: `term_959a4f02-747c-4b9d-820e-3672def55e49`.
- Orca Run: `run_7a10da5526b5`.
- Branch: `tingkai-c/managed-data-foundation`.
- Worktree: `/Users/ctk/orca/workspaces/Zorid/managed-data-foundation`.
- Starting main SHA: `d06eccd98316f73e1fc706102526c7d6a1bbe5ca`.
- New local documentation: `docs/managed-data/` only; not yet integrated.
- No source implementation, build, migration or native UI claim yet.

## Existing sessions and dependencies

Native lead `term_bbf1787b-d2e5-402a-b366-24d40a2385c3` acknowledged Phase 0/1
contracts and feasibility may proceed independently (message
`msg_f01924f9481e`). Lead owns native shell, Pages, components, tabs, import,
project registrations and native integration documentation, through existing
subowners. Checkout `native-mobile-recovery`, branch of the same name,
reported SHA `62552aea`. Future Tasks/Calendar native DTOs must be proposed to
this lead before changing UI seams; no duplicated Swift/Kotlin data engine.
No native Tasks/Calendar UI owner assigned as of that response.

Core ownership reconciliation requested in `msg_9c9bf68ee3cf`; acknowledgment
pending. Existing task, Base and calendar branches were found and must be
reconciled before assigning domain implementation. Plan author notified through
`msg_ec8f8f37b2bf`; newer decisions requested. Mobile reference terminal was listed
but structured delivery reported terminal_not_found; no takeover or duplicate
worker was attempted.

## Active bounded investigations

1. `task_8402e67140be` / `ctx_91634298e905`: read-only inventory of reusable
   persistence/sync/browser seams and missing managed-record layers. Worker
   `term_13c2a6ac-15d4-423e-b5e7-b85beb14f73d`; no edits or builds authorized.
2. Independent structured Yrs semantics review requested through Orca;
   dispatch receipt pending. No edits or builds authorized.

## Next gate

Reconcile ownership replies and both source reports. Record provisional internal
schema, merge/delete/set policies and bounded fixture acceptance before source
implementation. Assign separate owned paths for implementation and independent
review. Coordinate actual Rust compilation load with core coordinator; reserve
explicit slots for iOS/simulator passes. Phase 1 requires durable local write plus
outbox, encrypted incoming application/checkpoint, browser equivalence, offline
convergence and restart evidence; CRDT-only tests do not satisfy it.

## Ownership acknowledgment and first reports

Core ACK `msg_0a6bfa6082d8` reserves `docs/managed-data/**` and NEW
`experiments/managed-records/**` for this lead, prototype only. Existing CRDT
lib/registration, Store/schema, root Cargo, protocol, bridge and native paths
remain excluded. New production crate path requires contract review first.
Root preserved plan at `docs/managed-data-tasks-calendar-plan.md`, main
`6a914af3`. Heavy compilation currently free but native lead next candidate
reserved; no compile has been started here.

Both initial read-only tasks succeeded; source inventory and semantics report
are preserved in this directory. No tests or runtime proof were claimed.
The workers are being reused for the isolated experiment and contract review.
A reuse attempt omitted exact worktree and failed preflight with
terminal_worktree_mismatch; fleet inspection showed only original completed
attempts, so corrected explicit placement was used without duplicate workers.

User asked about desktop Base calendar design: plan specifies FullCalendar
month/week/day/agenda and functional panels/actions, but no detailed desktop
mockup or finalized toolbar/spacing/styling. Apple Calendar visual family is
specifically iOS. Concrete desktop layout remains a delivery task, not settled
from this plan. User also explicitly checked separation from normal file sync;
the separate model/family plus shared infrastructure boundary was confirmed.

## Confirmed overlap and exact prototype reservation

Core `msg_39746f9c6913` and resend `msg_0b6045e75a33` explicitly reserve
NEW `crates/zorid-crdt/tests/managed_record_feasibility.rs` as the single bounded
probe. This replaces the earlier experiments path; worker informed via
`msg_8b15de748c8a`. No duplicate probe or manifest is needed. Compile grant is
pending exact source SHA, fixture count and command; official Rust1.95, offline,
locked, jobs1, threads1 and shared stage4-verified target requested by integrator.

Reuse reconciliation from core (source status only, not new-plan acceptance):

- Old task branches use SUPERSEDED checkbox/tag assumptions; preserve without
  integrating them as the newly accepted typed-task design: read model
  `5d15b0ba` + `b12230d2`, workspace `71270963`, query `3ab3f885`, task-actions
  uncommitted source, calendar workflow `7bb6588a` closure.
- Bases workflow `d9e2a156` + `fa6c6b4c` has 39 reviewed checks for optional
  creation/view CRUD/formulas/record UI; reuse requires current-main reconciliation.
- FullCalendar 7.1.3 + temporal 1.0.6 exist only in isolated work, not main.
  Preserve pnpm12 multi-document lock handling and license provenance if reused.
- Native lead retains shell/tab/menu/import/editor-container UI. Do not assign
  or modify its seams from this managed-data track.

Follow-up tasks: `task_92619feaf55d` / `ctx_15deb593d301` synthetic probe source,
and `task_e3e64127dd6d` / `ctx_3f9b96321369` independent read-only contract review.
Both reused their original completed worker terminals with explicit worktree.

## Source-only first slice

Worker source commit `a2702e5ff83303527483173b1f0ae188c11ea66f` adds 11
bounded Yrs fixtures in the exact owned file. Self-review accepted as source
handoff, not compile/runtime acceptance. Independent contract review task
`task_e3e64127dd6d` succeeded; corrected authored-intent/sealing and incoming
shared cursor language, namespace authorization, resource/version bounds and
normalized-IDB transaction requirements. Reviewer released after settlement.
Root ACK `msg_cda3a2338602` reports historical combined-checkbox/direct-scheduling
and discussion-hold passages marked superseded in canonical main documents.

The source worker settled before processing a late requested text-validator
firewall test; a new explicit follow-up reuses that worker for the single test
and limitations header, no compiler. One bounded Rust fixture check has been
requested in `msg_dd8ca0afb527`; no grant or test run yet.

## Focused verification

Final source `aadda86712e6ee39924d82de4899fe8ccc5e368b`: 12/12 synthetic
fixtures PASS with official existing stable1.95 binaries, offline/locked/jobs1,
threads1, shared stage4-verified target. Exclusive grant `msg_62205822e454`;
session50530 exit0, log `/private/tmp/zorid-managed-record-feasibility.log`.
No production source changed. Slot explicitly returned; all dispatched workers
settled and were released/reused through final settlement. Detailed observed
policies and limitations: [feasibility results](feasibility-results.md).
Phase0 contract remains provisional; Phase1 durable encrypted slice is not done.

## Phase 1 portable source assignment — continuation

Previous goal turn is **progress**: exact12-fixture run and committed evidence,
not a wait/status-only turn. Root independently reviewed and integrated the
entire prior `1a350fd2` ancestry as main `3322d30b`, with exact-byte comparisons
of test and seven documents (`msg_5a146aa388d8`); no redundant rerun needed.

Root `msg_89203964cf61` assigns NEW `crates/zorid-records/**` for actual internal
portable schema/patch/causal-state/payload planning. Existing Store/protocol,
root manifests/lock, browser/native/editor paths remain excluded. No production
API frozen. [Concrete portable contract](portable-record-contract.md) is under
independent review alongside source implementation, not bundled retroactively
into the previous accepted batch.

- Implementation task `task_abc93cd985fe` / `ctx_ff9b09110693`, terminal
  `term_be44a8bb-0331-440a-b349-1f1a20023b8f`; isolated child worktree
  `/Users/ctk/orca/workspaces/Zorid/managed-records-engine`. Own new crate only,
  no compiler until resource grant; source commit/test-count handoff required.
- Independent contract review `task_8b1ad78f1d79` / `ctx_07f04a40e5aa`, terminal
  `term_1aa0a1d9-438e-4711-a5f4-024eff657bd3`; read-only, no builds or edits.
- Retained operation history, concurrent conflict candidates, observed-remove
  sets, generation tombstones, replay/pending and byte/depth/count admission
  must be concrete and tested. Encoding choice is explicit and one-authority;
  no redundant custom mutable field engine beside Yrs.

Concrete review `msg_0834151441e4` supports immediate source and sole typed
operation-set authority, with required create ancestry, per-field maxima, causal
tag removal, pending activation/equivocation, aggregate capacity, additive unknown
fields and planner-binding corrections. Preserved `portable-contract-review.md`,
resolutions appended to contract, exact findings sent implementation owner in
`msg_7b646e579cc0`. This choice is internal; sync framing/production seam acceptance
remains separate. Root informed new crate lock entry requires its named gate.

Independent adversarial source tests committed as
`2cb477160772a8adc632d17f9539cf146f35f351` in the foundation branch: ONLY
`crates/zorid-records/tests/adversarial.rs`, nine traces against the actual
public engine API. Task `task_a9ef6739c237` / `ctx_4a95526c266d` succeeded;
no compiler run. Reviewer reports no new blocker, preserves explicit invalid
pending-activation and33-head backpressure limitations. Worker released.

Coordinator source review found full transitive ancestry String/BTreeSet storage
could grow quadratically in copied variable-length IDs at4096 operations; compact
ordinal bitsets or an equivalent bounded representation requested before freeze.
This is a concrete resource correction, not a new benchmark claim.
Root `msg_440f6dba56ae` grants isolated Cargo.lock change ONLY for the new
zorid-records package entry and edges to existing locked deps, no version/source/
checksum changes and no network. Exact lock diff needs root review; compiler
still requires later exclusive bounded slot, native priority unchanged.

## Portable library verified and reviewed

Composed clean candidate `1842c15e99129531baf189af2f15ad3e1bba77a1`:
independent tests `2cb47716`, reviewed contracts `525c2c1b`, engine cherry-pick
`d286e0e2` from `5e1c78f3`, exact8-line lock `6cdbd6c8`, compact ancestry
`1842c15e` from `c1e91bad`. Root approved unchanged lock in `msg_95887dae0a83`.

Granted bounded check `msg_68f3021742d8`, session17018 EXIT0:33/33 PASS
(9independent+24traces), no source/lock changes or retries. Log
`/private/tmp/zorid-records-1842c15e-tests.log`; explicit slot return
`msg_0676fb3dce42`. All owned workers settled/released, no compiler live here.
Independent root actual-source review APPROVED exact1842 library slice in
`msg_a8f809191242`. Retained known direct-programmatic input clone memory budget
limitation; adapter/wire gates remain. See [portable results](portable-record-results.md).
No Phase1 durable/encrypted/browser/UI completion claim. Batch is ready for sole
root integration; main result SHA still pending this checkpoint.
