# Linked-task Calendar / Base Calendar contract review

Original review frozen 2026-10-18. Reviewer: task `task_d0367d69f286`, dispatch
`ctx_40091080164e`; branch/worktree `managed-intent-contract-recovery` at
`5a176c0e28655f495f645d7323988abb0c64973d`. Only this new review is owned.

Reviewed **exact** contract commit `c2760a2f2eb36c73098ca0e45c4b84f759fd8ffe`
in `managed-tasks-workspace-ui`; its document SHA-256 is
`870ad3816320824656a517fc13143e332df6a59d9d1527b28854fda37b973890`, matching
the author's working file. Source evidence below uses reviewer checkout paths;
Git comparison against canonical main `4a2c2010545982f9df20c64c6139e25ee13a8889`
found no differences in Calendar controller/view, Base session, native document/
WorkBlock APIs, portable task query or Store document index. Main subsequently
advanced to `3b12a8ad`; this review does not claim a whole-tree successor audit.
Read current canonical roadmap execution checkpoint (including 04:14 UTC) and
user findings, plus managed implementation plan. Root `msg_7b0f052fca32` accepts
routine UX; follow-ups `msg_2101efb2fce6` / `msg_f49f28d58942` settle the narrow
choices below. No builds, compilers, apps or repeated standalone audit were run.

## Successor verdict — amended contract approved, source-only

Reviewed exact author commit `31aafe8f56ec39aceb5f260d7b4eed480503253e`
from `managed-tasks-workspace-ui`, supplied directly by author dispatch
`ctx_58f8b2fd4e25` in `msg_eb3b5cbb3885`. Its contract document SHA-256 is
`49e29a2fbbe5260a1c928095a33fbb1226d89dcce33b31def1d0015327db575e`.
Successor reviewer task `task_db5b8492de59`, dispatch `ctx_b4e9e80aa824`, owns
only this review document. The original findings below are historical evidence;
this verdict supersedes their request for contract corrections.

**All concrete findings are addressed at contract level; no remaining contract
blocker identified.** Independently inspected the complete exact amendment against
`c2760a2f`, checked the authored hash and its one-document commit scope, and
re-read canonical execution checkpoint/user findings. The named seam table below
remains the exact proposed role/file/dependency assignment for root to populate;
it grants no shared edits. The author's table also adds the Store evidence seam
and Base context plumbing without extending product scope.

| Original finding | Exact amended contract evidence (line numbers at `31aafe8f`) | Result |
| --- | --- | --- |
| Export misses receipt-only unresolved records | 222–240: authorized bounded Store summary using existing receipt index, same-handle fences, conservative unknown, shared scan ceiling; 402/404: Store grant and native dependency; 432–439: decisive pre-existing receipt-only regression | Addressed |
| Retained pin is not current-source proof; distinct counters/no atomicity | 287–301: Calendar-only same-lease retained/current-source checks at admission and before every delivery; explicit refresh, per-step WorkBlock fences, separate counter domains and no cross-store transaction claim | Addressed |
| Base selection before task cap; saved search/limit and IANA context | 141–145 and 194–203: one saved-zone/captured-clock context, original Rust ordering/search/limit and completed membership; 407: shared-query/controller ownership | Addressed |
| Bounded retained join, scan and expanded responses | 257–285: one receipt per pin/eight-cursor ceiling, 1,000 task rows, 64 labels, 8 MiB retained state, shared 128-page/8-MiB scan and 1-MiB expanded replies, explicit overflow/expiry | Addressed |
| Visible manifest cannot distinguish deleted from missing | 205–214: initial missing label, deleted only with retained tombstone witness, valid complete Type knowledge required for notTask | Addressed |
| Durable owner, exact replay, ack persistence and no-loss close | 320–359: one trusted vault/window owner, 64 refs/64-KiB versioned journal, persist-before-send/next-send, original replay after post-ack failure, next-command-only fresh admission, explicit recovery handoff, partial-progress retention and actual Calendar/Base close plumbing | Addressed |

Accepted UX remains intact: shared existing canvas, any-selected linked membership,
all-time inverse join with unknown coverage, saved Base selection and explicit
partial linking. Generic file-date Calendar remains **later required** (99–101);
spaced repetition stays removed (22–24). No provider/browser/mobile implementation,
new framework, record schema or index migration is added. Standalone acceptance is
not reopened; focused regressions and one composed desktop UI gate remain.

The amendment accurately separates fixed source identity (`main 209368`) from
ongoing current Tasks actual proof (29–35, 421–426). Root must finish that gate,
fill concrete workers/worktrees and grant shared seams before source edits.
This approval establishes neither implementation correctness nor runtime delivery.
No compilers, builds, apps, production edits or test suites were run; documentation
diff whitespace and local reference checks are the only new checks.

## Original verdict (superseded by successor contract verdict above)

Feasible, with the accepted shared-canvas/linked-task scope intact. **Correct the
inverse-absence proof before source grants:** existing export omits receipt-only
unresolved records. Freeze the remaining bounded clarifications below alongside
that correction; they need no new product discussion or general framework.
This is source review, not implementation or desktop acceptance. Generic file-date
Calendar remains later required; spaced repetition is removed, not deferred.
Current Tasks proof remains a dependency, with its status owned by the coordinator.

## Concrete blocker: receipt-only records are invisible to export

Contract lines 194–203 and its ownership table say existing export/watermark is
sufficient. It is insufficient for negative membership:

- [managed_export](../../crates/zorid-store/src/managed_records.rs:573) lists
  `managed_records` keys only (line 585).
- `activate` returns incompatible/waiting/retained states before `write_state`
  ([lines 810–848](../../crates/zorid-store/src/managed_records.rs:810)).
  [receive_in_transaction](../../crates/zorid-store/src/managed_records.rs:947)
  still inserts the receipt and collection change. Such a record may have no
  `managed_records` row at all.
- [snapshot](../../crates/zorid-store/src/managed_records.rs:238) attaches
  unresolved counts only for the particular exported record. A stable fence
  detects subsequent changes, not pre-existing invisible receipts.

**Chosen correction:** add a narrow, authorized collection-scoped unresolved
summary in `crates/zorid-store/src/managed_records.rs`, using the existing
`managed_receipts_retry(collection_key,update_id,status)` index, no schema/index
change. It returns a conservative existence/unknown fact, not receipt payloads or
an unbounded history. A bounded index walk (64 receipts per step, at most 128
steps, retained continuation) may establish no relevant unresolved receipt; finding
one or exhausting the bound yields global unknown for unproven negatives. Use
same collection handle and before/after watermark fence as record scanning;
charge these steps to the same aggregate scan budget. Do not scan changes from
zero for each view. Conservative treatment of all non-accepted receipt statuses
is safe initially; accepted projected refs still prove presence. Never silently
convert summary failure or domain read failure into absence. Root confirmed this
approach; a **new named Store seam grant is required**.

Minimal decisive regression: receive incompatible/waiting operations for a record
with no accepted state before opening Calendar, keep watermark stable, and query
an unrelated otherwise unlinked task. Export may be empty, but that task must be
unknown, never absent. Also cover an accepted record plus a receipt-only record,
then settlement followed by explicit refresh.

## Exact routine clarifications to freeze

1. **Two-source observation and final admission.** Existing
   [document_result](../../crates/zorid-native/src/document_index.rs:98) rechecks
   pin retention; [document_snapshot_manifest](../../crates/zorid-store/src/document_index.rs:1180)
   expressly allows advancing source heads. Add a native Calendar-only same-lease
   check of exact retained pin plus current document source, using
   [document_index_status_with_source](../../crates/zorid-native/src/document_index.rs:18),
   at scan admission and before each delivered continuation/result. Source identity
   includes local store ID and source watermark; reject changed source with explicit
   refresh. Fence WorkBlocks before/after each bounded step/delivery. These checks
   establish a declared observation of immutable document generation and stable
   WorkBlock collection, **not** a cross-store transaction or a promise that neither
   changes after delivery. Never compare document and WorkBlock counter values.
   Preserve outer snapshot/source/coverage and detailed diagnostics independently
   of nested task/membership completeness. Local completeness says nothing about
   remote sync completeness.

2. **Selection before cap; one evaluation context.**
   [query_tasks](../../crates/zorid-bases/src/tasks.rs:108) currently scans all tasks,
   sorts, then truncates at lines 288–289. Refactor reusable projection to admit
   exact Rust-selected Base EntryIds before task materialization limits; never
   intersect a truncated prefix. Existing saved Base evaluator applies root/view
   predicates, groupOrder exclusion, AND search across displayed property values
   ([query.rs:649](../../crates/zorid-bases/src/query.rs:649)), sorting and saved
   limit before the row-budget check ([query.rs:771](../../crates/zorid-bases/src/query.rs:771)).
   Preserve that order, selected file/task/non-task counts, named-view resolution,
   currentEntryId and ignorePaths. Include completed tasks for block membership
   and labels; `showDone` limits only picker/panel. Search is existing Base search,
   not new whole-note full-text search. Picker search then filters the complete
   bounded selected set locally.

   [SharedBaseQueryRunner](../../src/bases/shared-query.ts:141) hardcodes UTC and
   closes its pin after projection. Calendar must pass its saved IANA timezone and
   captured clock consistently into the existing Rust evaluator and task projection;
   use the same context for any companion Base result in that Calendar session.
   Thread that context through the existing runner/controller seam rather than
   rendering a UTC selection then joining another zoned selection. Preserve UTC
   defaults for other views unless separately configured. No detached JS result
   becomes a native join capability. Add `shared-query.ts` and narrowly scoped
   `controller.ts` context plumbing to the proposed Base owner batch.

3. **Bound retained work and expanded output.** One active Calendar join receipt
   per pin, sharing the existing eight-cursor ceiling; a replacement explicitly
   expires its predecessor. Retain at most 1,000 selected task rows, per-ref labels
   at most 64, and at most 8 MiB total serialized retained join state per pin.
   Count record and unresolved-summary steps together within 128 pages/8 MiB;
   each scan step is at most 64 items/1 MiB. Report scan bytes separately from
   encoded response bytes; every expanded reply, including labels/diagnostics,
   is at most 1 MiB. Materialization/retention overflow is an explicit budget
   error, never truncation or complete-empty. Avoid retaining the whole vault's
   inverse index: keep membership facts only for selected tasks and streamed
   window output. Task results paginate after scan settlement, 64 per page,
   retaining the same receipt/fences. A positive witness can be shown early;
   no absence can. Domain/unresolved uncertainty without attributable targets
   makes all unproven negatives unknown. Expired cursors never silently restart.

4. **Missing versus deleted labels.**
   [capture](../../crates/zorid-store/src/document_index.rs:390) uses
   [read_states(false)](../../crates/zorid-store/src/lib.rs:261), which excludes
   deleted/invisible entries. This pin proves absence from its visible manifest,
   not whether a target was deleted versus never present. Initially return
   `missing` with “Unavailable task”; reserve `deleted` for a future retained
   tombstone witness. Do not live-read tombstones or paths and relabel them as
   same-pin evidence. `notTask` requires readable valid metadata and complete
   admitted Type knowledge; invalid/missing Type knowledge stays unavailable or
   unknown. Preserve original EntryId links and allow their removal.

5. **One durable write owner, restart and no-loss close.** The current
   [controller](../../src/calendar/controller.ts:39) generates create identity in
   memory and discards the commit return; its shared instance is keyed by service.
   [managed_apply](../../crates/zorid-store/src/managed_records.rs:473) returns the
   original persisted receipt before revision comparison on exact replay, so
   sequential crash recovery is feasible without mutation DTO changes.

   Freeze one continuation owner per trusted vault/window, shared by standalone,
   panes and embeds; at most one active scheduling sequence, at most 64 unique
   selected refs and a 64 KiB versioned serialized journal. Reject oversize before
   dispatch. The journal key derives from authenticated window + trusted vault
   identity ([WorkspaceStorageScope](../../src/ui/workspace-window.ts:18)), never
   note path, and is distinct from NoteBuffer draft keys. Other mounted views
   attach to the owner; they do not replay or overwrite its journal. Normal
   restart readmits the vault and offers Resume/inspect, without automatic writes.
   If a restored window cannot reclaim the scope, preserve the journal and offer
   an explicit same-vault recovery handoff before one new owner adopts it; no
   copying/replay by multiple windows and no automatic orphan deletion.

   Persist immutable current request before send; after ack persist receipt and
   progress before another send. If post-ack persistence fails, stop, retain the
   older journal and exact-replay that command on recovery. For a current uncertain
   command, establish its receipt by exact replay even if a task changed; fresh
   task admission applies to the **next not-started** addRef, never rewrites the
   old command. After every ack read the block; only use its acknowledged revision
   if still current. Otherwise retain progress and require review. Keep acked,
   pending and not-started refs distinct; never compensate by deleting the block.
   Stop linking preserves acked work, and cannot erase an uncertain command.

   [CalendarView](../../src/calendar/view.ts:137) currently hides the form as soon
   as pending clears; [Base MountedView](../../src/bases/session.ts:40) has no
   async flush/close. Extend these actual paths so create ack alone cannot dismiss
   unfinished links. Pending/dirty draft/failed persistence veto view replacement,
   close and vault release; failed close retains mounted UI. A fully persisted,
   acknowledged stopped sequence may close only with its recovery entry retained.
   Corrupt/incompatible journals remain inspectable, block new writes in their
   scope and are never silently cleared. This is a bounded scheduling journal,
   not a general jobs API or task replica.

## Proposed named seam ownership (not a source grant)

Coordinator fills a concrete worker, branch/worktree and commit for each role
**after current Tasks proof**, acknowledges shared hunks, then grants edits.
Names below identify exclusive roles, not existing worker assignments.

| Named role / worker to fill | Exact proposed files and edit boundary | Depends on |
| --- | --- | --- |
| `CalendarStoreEvidenceOwner` — TBD | `crates/zorid-store/src/managed_records.rs`: bounded authorized unresolved summary only; focused managed-record test file under `crates/zorid-store/tests/` | Root Store grant; summary DTO agreement; no schema/index edit |
| `CalendarPortableSelectionOwner` — TBD | NEW `crates/zorid-bases/src/calendar.rs`, narrow `src/tasks.rs` projection refactor and `src/lib.rs` export; NEW `tests/calendar.rs` in that crate | Exact selection/context/coverage contract; no managed Store dependency |
| `CalendarNativeJoinOwner` — TBD | NEW `crates/zorid-native/src/calendar.rs`; narrow `document_index.rs`, `document_api.rs`, `workblocks.rs`, `lib.rs`; NEW `tests/calendar.rs` | Store evidence + portable selection; same-lease sessions, freshness and cursor limits agreed |
| `CalendarDesktopBindingOwner` — TBD | `crates/zorid-desktop-host/src/documents.rs`, only necessary internal `workblocks.rs` sharing; NEW `src/core/calendar.ts`; `src/core/document-semantics.ts`, `src/platform/desktop-document-semantics.ts`, `desktop/document-semantics.cjs`, `.d.cts`; focused codec tests | Native DTO freeze; root shared transport grant; preserve existing WorkBlock mutation DTOs |
| `CalendarControllerJournalOwner` — TBD | `src/calendar/controller.ts`, `view.ts`, `view.css`; NEW `continuation.ts`, `canvas.ts`, `task-picker.ts` only where needed; focused journal/controller tests | Binding + agreed owner/store interface; preserve accepted standalone behavior |
| `CalendarBaseSessionOwner` — TBD | NEW `src/bases/calendar-view.ts`; `session.ts`, `document.ts`, `toolbar.ts`, `toolbar-config.ts`; narrow `shared-query.ts` and `controller.ts` context plumbing; focused tests | Native selection, shared canvas and async pending/flush protocol |
| `CalendarWorkspaceSeamOwner` — TBD, exclusive | Only granted Calendar/Base option, shared service, storage key/recovery owner and witnessed note-open hunks in `src/ui/workspace.ts`; additive key helper in `workspace-window.ts`; existing embed option threading | Current Tasks proof; root hunk grant coordinated with active Tasks/native Workspace owners; Base and journal interfaces |
| `CalendarComposedReviewer` — TBD | Read-only exact composed native/DTO/frontend review and bounded test evidence | Coherent frozen implementation commits |
| `MainIntegrationOwner` — root only | Serialized canonical integration/tracking and composed desktop acceptance | Independent review and current Tasks gate; no worker mutates main |

No grants for browser/WASM/mobile APIs, NoteBuffer, manifests, dependencies, SQL
schema, record format or a new transport channel follow from this table.

## Bounded acceptance proposal

Use five focused suites, not a combinatorial matrix:

1. Rust selection/labels: more than 1,000 unrelated tasks with a small Base match
   beyond their prefix; saved limit/search/group exclusion and Toronto date boundary;
   completed membership; unavailable Type, deleted/path-reused link, selected counts.
2. Store/native inverse evidence: receipt-only regression above; past/future,
   conflicted/zero-range live refs, deleted blocks, complete-empty versus unknown;
   zero-match continuations, exact fences, source change, cursor/aggregate/expanded
   byte budget exhaustion. Counter-domain equality must not confer authority.
3. Strict bindings: outer/nested receipt mismatch, closed pin/client, unsupported
   optional read, wrong request continuation; all errors stay unavailable, not empty.
4. Journal/controller: crash before send, create commit with lost reply, failure
   saving ack progress, one partial add ack then lost reply, restart/resume, changed
   next task, stale block, concurrent observed-remove re-add, corrupt/oversize
   journal and ownership handoff. Assert one create identity, exact replay and
   unchanged task bytes/status/dates; no compensating delete.
5. Base/DOM lifecycle: standalone/Base share canvas/owner; read-only named embed;
   dirty form, active links and storage failure survive refresh, switch, split/park
   and rejected close. Late/cancelled reads publish nothing and pins stay owned
   until settlement. Real witnessed note route preserves EntryId through rename.

Then **one composed normal Electron UI gate**, coordinator frozen with exact
source/native/binding/dist/harness hashes in a disposable vault: create two
file-backed tasks and a saved limited Base Calendar; schedule from the real picker,
link both, inspect outside-selection/missing links, open/edit the original note,
change completion separately, cancel/save a move and a drag proposal, interrupt a
create/link sequence and restart to explicitly resume it. Verify one retained
block identity, acknowledged refs, saved Base config and no lost draft/continuation.
Include keyboard scheduling and a narrow pane in both themes with actual visible
rect/hit checks. Inspect all-time No work blocks and explicit unknown coverage.
Close the owned Electron app/native child after the pass. This gate proves the
new composition; it does not repeat standalone acceptance or establish mobile,
remote sync or generic file-date Calendar completion.
