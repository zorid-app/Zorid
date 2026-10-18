# Linked-task Calendar implementation review

## Review identity and status

2026-10-18, current implementation wave. CalendarIndependentReviewOwner task
`task_916e2bfd8595`, dispatch `ctx_3227884a4148`, terminal
`term_b64f6f01-b577-46c5-88fe-da33d69d953f`. Reviewer branch/worktree:
`managed-intent-contract-recovery`, starting at
`73dee4a3272a375aed9181c6c64f01f71344cc08`. This NEW document is the only
owned file. Root alone integrates; no production/harness edits, compilers,
builds, apps or runtime checks are authorized for this review.

**In progress; no implementation approval yet.** Early working source is useful
for API feedback but is not a frozen implementation or test result. The accepted
contract is not reopened, and the already accepted standalone Calendar is not
audited again. Browser-v1/origin-helper freezes remain untouched.

Read canonical roadmap execution checkpoint and relevant findings, exact accepted
contract `31aafe8f56ec39aceb5f260d7b4eed480503253e` (document SHA-256
`49e29a2fbbe5260a1c928095a33fbb1226d89dcce33b31def1d0015327db575e`),
independent contract review `73dee4a3`, and ownership document granted at
`a1d9d64f16732118b4ab1b448adf9d9c36ad4d8f` (root grant
`msg_f1f28718656f`). Canonical main observed during preparation:
`e18a9fc65c110d185ffdd7abb735c0dc928f5c80`; later main changes require scoped
comparison, not assumed whole-tree approval.

## Owners and evidence ledger

| Owner | Branch/worktree and dispatch | Exact implementation freeze | Verification |
| --- | --- | --- | --- |
| CalendarStoreEvidenceOwner | `managed-calendar-store-evidence`, `ctx_9141e0dedf28`, starting `a1d9d64f` | `3882acec3c28aef4c9175d63a81ed9649c96890f` | Exact source reviewed; coordinator log independently read, 5/5 SQLite pass |
| CalendarTaskProjectionOwner | `managed-calendar-task-projection`, `ctx_6383ea2ee869`, starting `a1d9d64f` | `cfcdf84d` + `9cdd273e` + `e60718df9affc8aa8e792fbedf0dd01c2b0b6443` | Exact source/test successors reviewed; worker log independently read, 6 Calendar + 11 Tasks pass |
| CalendarSchedulingOwner | `managed-calendar-scheduling-ui`, `ctx_d9e664a13abe`, starting `e18a9fc6` | `577a1b2874a21e8b048c8e402d5039f11aed08af`, successor pending | First recovery fixes source-reviewed; 38 focused checks/full TS reported by owner; Stop/zone findings open |
| CalendarNativeJoinOwner | `managed-calendar-native-join`, `ctx_3b4cc32f6b20`, task `task_965db883c836` | DTO `fcdc30fd`, full source `a0ac46ab` + test-only `ae989104` | Exact source/nine SQLite tests reviewed; execution not claimed |
| CalendarDesktopBindingOwner | `managed-calendar-desktop-binding`, `ctx_04249b81d70c` | Pending | Root shared host dispatch grant `msg_f5fd82d6b580` |
| BaseCalendarViewOwner | `managed-base-calendar-view`, `ctx_9ee5beb2fbcf` | Pending | Actual retained read/context/lifecycle composition pending |
| CalendarWorkspaceOwner | `managed-calendar-workspace`, `ctx_8a2d79713b05` | Pending | Trusted singleton/key/recovery/guarded note route pending |

## Early API questions and bounded findings

Direct questions sent to each source owner before reviewing freezes:

- Store `msg_dd7ddccf0538`: exact summary DTO, authorized collection/watermark
  continuation binding, accepted-only pages, receipt-only rows and accounting of
  examined items/bytes toward the shared aggregate budget.
- Projection `msg_8abf23a4db8d`: saved Rust Base selection before cap, original
  order/search/limit, one IANA/clock context, ignorePaths/currentEntryId, completed
  membership and detailed diagnostics.
- Scheduling `msg_2da1cc430145`: exact journal/store/owner interface,
  persist-before-send, unchanged replay after post-ack storage failure and actual
  Base/Workspace close veto retaining mounted UI.

Initial working projection source calls the existing Rust `query_generation`,
overrides its evaluation clock/timezone from one context, and projects that
result's ordered EntryIds before enforcing the task row cap. It reuses task
capability projection and retains Base results plus task, Type and metadata
diagnostics. This appears consistent with the selection contract; freeze and
meaningful negative tests remain necessary. Unknown Type/metadata omissions must
remain qualified by coverage rather than interpreted as proven non-task files.

Existing Store `managed_export` enumerates accepted-state rows only. Existing
`managed_apply` checks persisted exact local request/receipt before current
revision, enabling the required uncertain-command replay. These are dependency
facts, not proof that the new native join or journal uses them correctly.

Early actual Store summary inspection found no concrete blocker: private cursor
binds store/process/collection/registration/fence, unresolved is sticky through
accepted-only suffixes, partial pages remain unknown and only EOF/all-accepted
permits `None`. All five authored authenticated SQLite cases were read, including
receipt-only waiting/incompatible before any accepted state, mixed settlement,
count/byte continuation, authorization/reopen/re-registration and sticky unknown.
These tests had not been executed at inspection. Returned `examined`/`bytes` and
each step must still be charged by native; its final current-collection fence is
outside the Store summary's read transaction.

All six early portable test cases were read: selected match beyond 1,001 unrelated
tasks; root/view/group/search/order/saved limit/currentEntryId/ignorePaths; Toronto
versus UTC date boundary; renamed/missing/path-reused/completed links; invalid
Type/metadata diagnostics; named-view and row-budget errors. No concrete early
projection blocker found. Source feedback sent as `msg_d38c9dd47e87` (Store) and
`msg_c45e3699c1d6` (projection), explicitly pending freeze/execution.

### Scheduling findings, open against early draft

Sent directly to owner in `msg_54886ca09594` and coordinator in
`msg_935771159c65`; these are actual source counterexamples, not runtime results.

1. **Stopped recovery overwritten.** `begin` rejects active/corrupt/storage-failed
   state, but allows `stopped`; its next persisted journal replaces the only
   recovery entry with unfinished selections. Require retained explicit recovery
   or an explicit reviewed replacement/discard decision before overwriting it.
2. **Initial storage failure cannot recover in the current owner.** First
   `persist` failure sets `storageFailed` while leaving `journal` null. Then
   `begin` blocks and `resume` rejects; even restored storage has no safe retry
   path. Retain immutable unsent intent and offer safe persistence retry before
   sending anything, with coverage for close veto and unchanged create identity.
3. **Actual desktop read DTO rejects the journal's request.** `advance` calls
   `service.read(acknowledged.create)`, carrying `operation`, `range` and `title`.
   Actual `src/platform/desktop.ts` forwards the full input to
   `captureWorkBlockCommand('read', input)`; `desktop/workblocks.cjs` rejects
   these extra keys. The draft fake `read` ignores input, hiding the defect.
   Pass only `{record,generation}` and exercise the actual strict codec in the
   focused test. Sent owner `msg_1ad922342cca`, coordinator `msg_301014b97336`.
4. **No Stop during a healthy sequence.** `canStop` requires `!running`, but
   create and every link execute in one running loop. The button is disabled
   until failure, so a user cannot stop after create/partial progress. Request
   safe stop at the next durably acknowledged boundary, without dropping an
   uncertain command or sending another ref (`msg_1c361457036e`).
5. **Shared canvas omits saved zone/context.** Initial extracted canvas fixes
   `timeZone:'local'`, uses system date parts/setHours and direct library Today,
   and accepts no zone/clock. A Toronto saved Calendar on a UTC system therefore
   cannot use the captured context consistently. Asked owner to coordinate
   explicit options and installed v7 adapter with Base owner
   (`msg_a3aa7e8ecc2b`). This concerns new shared composition, not a repeat audit
   of accepted standalone behavior.

Decoder consistency/unsupported-field checks were also requested as focused
follow-up, without requiring JSON property order or a new tamper framework
(`msg_45aed70581e6`). Post-ack failure ordering in the draft correctly retains
the old journal/current command and replays it before next-task admission; actual
failure/restart tests and mounted close composition remain pending.

Coordinator `msg_1f00d7ee9426` accepts the early Store, projection and scheduling
interfaces and names CalendarNativeJoinOwner `ctx_3b4cc32f6b20`, task
`task_965db883c836`, worktree `managed-calendar-native-join`. Its initial DTO/source
draft is available; exact implementation freeze/tests are not yet supplied.

## Exact opening freezes reviewed

**Store `3882acec` and projection `cfcdf84d`: no blocking source finding.**
Reviewed complete scoped production deltas and authored tests, confirmed worker
crate files match their commits, and checked both commit diffs for whitespace.
This is source-only approval; compiled/check execution is queued behind the
coordinator's actual native iOS19 machine-load restriction. It does not establish
that tests pass or the dependent join is correct. Reviewer sent exact verdicts
`msg_75ded86344cf` (Store) and `msg_f06fb80ba56c` (projection).

| Exact frozen file | SHA-256 |
| --- | --- |
| `3882acec:crates/zorid-store/src/managed_records.rs` | `4081dd4632383bfb51c304fad8c37651f238583dadf22eced401d81fe91d7504` |
| `3882acec:crates/zorid-store/tests/calendar_evidence.rs` | `de24d0b7866489d2e8203974f5280f9df0b6f2e4566c22baa30e9b29cf6e755a` |
| `cfcdf84d:crates/zorid-bases/src/calendar.rs` | `4a87a6cb07d44696ce1c1e22d7e6f13c94122f778b5035001a144ddb818c02e9` |
| `cfcdf84d:crates/zorid-bases/tests/calendar.rs` | `36a851bf9a017463b48e0ad045e672b4cd3cdfb97c41f66c091f561864938dff` |

Scheduling owner confirmed both early findings in `msg_2982a932f85e`: retain
immutable unsent first-write intent for explicit retry, reject replacement of a
stopped entry and allow explicit resume. These are intended fixes, not verified
closure; await exact successor source/tests.

Native DTO/helper groundwork
`fcdc30fdd0519248b4f1fd9a21e4d2fb4d7465e6` was independently inspected. No
DTO-level blocker found: original typed diagnostic objects are preserved as
engine-tagged values and companion `baseResult` retains Base detail. Dependent
strict codecs must validate recognized engine shapes without flattening them.
Saved Rust selection and explicit delivery current-source/collection fences are
present in helpers. Asked owner to validate `CalendarContext` for links too
(`msg_4e1608b41acc`). This commit is groundwork, not a completed scan/retention/
cursor/lifecycle implementation, and has no executed test evidence.

Working native scan initially marked window `summary_done` true without walking
receipts, permitting `membershipComplete:true` for receipt-only unresolved state.
Sent concrete counterexample `msg_3fe3616cff48`. Owner reports adoption in
`msg_1db2e2919c3d`: windows now also run summary under shared budgets; links clear
predecessor and call scalar context validation. Confirm at frozen successor and
tests before closure. Portable public-validator successor
`9cdd273e46ef9f571fee128b140b8170a71147e0` independently reviewed: only visibility,
documentation and report changed; no new source blocker, execution still pending.

Exact scheduling `577a1b2874a21e8b048c8e402d5039f11aed08af` nine-file batch
reviewed. First-write identity retention and stopped replacement protection now
have focused tests; exact target-only read fixes the actual codec mismatch.
Owner reports 38 focused cases (including 24 existing standalone cases) and full
TypeScript success, but frozen report still promises a later exact command/count
appendix. Reviewer ran no tests. Stop/zone findings remain present at this freeze;
sent explicit request for successor and actual strict-codec regression
`msg_968a95f2802f`. Owner `msg_5ec1a8b77a80` acknowledges codec-test, timezone and
stop-at-ack corrections as next work. No final scheduling approval yet.

Coordinator `msg_8b430aed7971` names all dependent source owners above and accepts
Base host `{scheduling,typeDefinitionIds}`. Direct review channels opened for each.
Workspace plan `msg_63c036bf4034` keeps real native selection in Base controller,
derives singleton storage from authenticated window/trusted vault ID, fails writes
closed without trust and routes notes by immutable original identity. Exact source
and unclaimable-window recovery handoff remain to inspect.

## Verified scoped evidence updates

- **Portable accepted with focused execution evidence.** Reviewed test-only
  successor `e60718df9affc8aa8e792fbedf0dd01c2b0b6443`; production is identical to
  reviewed `9cdd273e`. Initial large fixture failed before Calendar at the
  documented convenience `Generation::from_sources` pump bound. Corrected fixture
  uses ordinary incremental `GenerationBuilder`, retaining the >1,000 regression.
  Independently read `/Users/ctk/.local/state/zorid-calendar-task-projection-validation-rerun.log`:
  6/6 Calendar and 11/11 Tasks pass. Command uses cached official toolchain,
  existing `stage4-verified` target, jobs=1, incremental=0, offline/locked and
  test-threads=1, only `-p zorid-bases --test calendar --test tasks`. Reviewer did
  not execute it. Source/focused-test verdict `msg_50f9a8df508f`.
- **Store accepted with focused execution evidence.** Coordinator
  `msg_2df631226584` ran exact `3882acec`, only `-p zorid-store --test
  calendar_evidence -- --test-threads=1`, same bounded cached toolchain/target.
  Independently read
  `/Users/ctk/orca/workspaces/Zorid/managed-data-foundation/tmp/calendar-store-3882acec.log`:
  5/5 SQLite cases pass; ten existing warnings recorded. Reviewed source still
  matches freeze. Source/focused-test verdict `msg_bbe1f584d128`.
- **Native source-only approval.** Complete exact
  `a0ac46abc92c6783980c702c4de5b7ca658eea49` plus DTO groundwork reviewed with all
  nine actual SQLite/native authored tests. Window receipt-only regression is
  now included; scalar context validation, current-source/session/delivery fences,
  one-use cursors, shared slots and explicit scan/retention/expanded limits have
  no remaining blocking source finding (`msg_9df1596d71a1`). Test-only
  `ae98910402cc308144b22eef933c8c0e7bf25897` moves family enrollment before explicit
  Text fixture creates; no production delta. Execution/type correctness pending;
  aggregate-limit guards were inspected, not exhaustively executed.
- **Binding working-source finding.** `calendarRow` initially rejected native
  valid unknown `statusId` rows with null label/category and
  `unknown_task_status` diagnostic, unlike existing Tasks. Sent
  `msg_5509a7346e95`; owner acknowledges correction and a native-shaped regression
  in `msg_72147dc5635b`. Exact successor/test evidence still to review.
- **Base working-source presentation finding.** Unknown membership and proven
  absence initially share one picker; suffix text does not provide the accepted
  separate unavailable group. Also an incomplete omitted-file difference is
  labeled proven non-task files. Sent `msg_1b60e86c007d`, pending successor.
- **Workspace recovery gap.** Missing trusted scope fails closed, but error text
  alone provides no same-vault adoption. Sent `msg_975973567ec7`; owner agrees and
  proposes authenticated reopen of the original inactive client slot, with broker
  exclusivity and unchanged journal key (`msg_571c1921d75f`). Root host ownership
  and actual source/test implementation remain pending.

Composed proof owner `ctx_ae18ba75a733` / `task_5a14557000ef`, worktree
`managed-base-calendar-proof`, owns only the new Electron integration harness and
report. It has no app/build authorization before coherent freeze. Reviewer sent
the bounded original composed gate and explicit real-interruption versus mock
fault distinction (`msg_fc69242911a1`). Runtime acceptance remains separate.

## Required bounded successor review

Review exact source/tests for the three opening batches, then the actually named
dependent composition. Track findings against exact commits and record source
inspection separately from worker-reported check execution. In particular:

1. Receipt-only unknown survives accepted-only continuations; no incomplete,
   failed, exhausted or changed-fence summary becomes negative membership.
2. Selected Base membership precedes cap; date/search/order/limit/current-entry
   context and detailed diagnostics survive the Rust/native/DTO boundary.
3. Durable immutable requests precede writes; ack persistence precedes next write;
   failed post-ack persistence replays the old command before admitting a new
   task; stopped/uncertain/corrupt journals and close rejection preserve work.
4. Same-lease document-current-source and collection fences cover every delivered
   continuation/result. Counter domains remain distinct; no cross-store atomicity
   or JavaScript query authority is claimed.

Final composed source review and runtime acceptance remain pending. No browser,
mobile, remote-sync, generic file-date Calendar or complete goal claim follows
from this document.
