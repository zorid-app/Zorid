# Historical contract: linked-task Calendar and Base Calendar

> Historical contract/evidence — superseded for current execution on 2026-10-21.
> For Bases implementation read [the current goal](../plans/bases-implementation-goal.md);
> for delivery order and ownership read [the roadmap](../roadmap.md) and
> [current checkpoint](../deferred-product-roadmap.md). Dates, owners, source grants,
> “current/next” instructions and completion claims below apply only to their
> recorded historical snapshots; they grant no present source ownership.
> Named note Types, Type registries/editors and Type-capability requirements are
> superseded by ordinary file properties and editable rich property definitions.
> `type: book` remains optional user data. Existing Type-dependent code has not
> been removed by this documentation update. Record-backed WorkBlock assumptions
> also require reconciliation with the later note-backed-content decision.
> Tasks, Calendar, Google integration, sync and native mobile remain later roadmap
> work. Public plugin APIs remain under discussion; spaced repetition is removed.

2026-10-18. Contract proposal for named implementation workers, not a source grant
or a delivery report. Author: C, task `task_bae1121e8cfb`, dispatch
`ctx_68f1a589f8ab`, isolated `tingkai-c/managed-tasks-workspace-ui` at `78b4e462`.
Amended by contract-only successor task `task_644615c93688`, dispatch
`ctx_58f8b2fd4e25`, from exact contract `c2760a2f2eb36c73098ca0e45c4b84f759fd8ffe`.
Only this document is owned by the successor. Root retains main integration
and grants genuinely shared seams before source edits.

## Evidence and precedence

The lost `/tmp/zorid-task-calendar-base-map.md` was recovered from the heredoc in
local Codex session `01a14d08-1042-7140-be10-10e039d85787`, dated 2026-10-18
03:29 UTC. Its subsequent codec-path corrections were also read. This is a new,
source-checked contract derived from that historical map, not a claim that its
old checkout hashes or open decisions are current authority.

The [durable implementation plan](implementation-plan.md), especially settled
items 4–7 and phases 3–4, supplies product direction: file-backed task capabilities,
multi-task reservations, reusable Base views and local desktop delivery before
providers. The current dispatch resolves routine UX choices below. Its explicit
removal of spaced repetition supersedes all corresponding historical plan items;
that workload, its history and its APIs are entirely excluded here. The old
[tag/checkbox contract](../task-calendar-contract.md) is marked superseded and is
not used to define task identity. Read the roadmap execution checkpoint and
[user findings](../user-findings.md) before implementation.

Standalone Calendar is already canonical and accepted according to coordinator
steering; reuse it. Tasks host source `0bfb9c88` and original-identity caller
`78b4e462` are separate from actual Tasks acceptance, which remains ongoing.
The old source snapshot's currentTasks split identity defect is now fixed in
canonical main `209368`; actual currentTasks proof remains ongoing in a separate
assembly owned by its assigned worker. This amendment neither mutates that
checkout nor claims that proof passed or weakens its identity guard. No current
runtime audit,
build, app launch, network access or additional worker was performed here.

The exact independent source findings are frozen in reviewer commit
`d476bd0a04d0c9213ec7c9647b07388cca78bfd2`,
[task-calendar-base-contract-review.md](task-calendar-base-contract-review.md)
(reviewer `term45e775b7`, dispatch `ctx_40091080164e`). This amendment adopts
those findings and root's accepted routine UX and receipt-only correction
`msg_9345ee1564b8`; independent review of the amended exact commit is still
required before source grants. The review's older current Tasks status is
historical as qualified above.

## Existing seams and concrete gaps

| Existing source | Reusable fact and missing piece |
| --- | --- |
| [WorkBlock DTO](../../src/core/workblocks.ts), [native service](../../crates/zorid-native/src/workblocks.rs) | Real create/read/move/title/addRef/removeRef/delete/windowPage/changes. Mutations carry original operation and opaque expected revision. Create has no initial references. Windows return all candidate ranges/titles, task EntryIds and unresolved status counts. No task label resolution or global inverse reference query exists. |
| [Record domain](../../crates/zorid-records/src/first_party.rs), `MAX_TASK_REFS`, `read`, `Window::intersects` | Active created/nondeleted reservations hold 0–64 visible task EntryIds; any intersecting range candidate includes a block. References deliberately allow absent targets. Domain schema already supports this slice; do not add task mirrors or change record wire format. |
| [Task projection](../../crates/zorid-bases/src/tasks.rs), `query_tasks`; [native document reads](../../crates/zorid-native/src/document_index.rs), `query_task_documents` | Rust projects ordinary Markdown tasks through pinned Type YAML and capability mappings. `typeIds` selects Type **file EntryIds**, not semantic type IDs. Result includes saved witnesses, coverage, diagnostics, matched count and truncation. Current filters are all/today/unscheduled; unscheduled tests absence of the mapped planned day. No Base selection input or WorkBlock join. |
| [Document capability](../../src/core/document-semantics.ts), `DocumentPin` | Pin retains snapshot/source and coverage. `tasks`, `base`, `metadata` are real reads; no Calendar combined read exists. A missing row in a truncated task query does not prove missing/deleted/non-task. |
| [Base evaluator](../../crates/zorid-bases/src/query.rs), [program](../../crates/zorid-bases/src/program.rs), [shared runner](../../src/bases/shared-query.ts) | Rust evaluates actual saved root/view filters, formulas, search, grouping/order and limit. Rows retain EntryId/revision. Row-budget overflow errors; saved view `limit` intentionally narrows output. Shared runner closes its pin after projection, so a rendered result is not a live join capability. It currently chooses UTC and maxRows 1,000; Calendar needs narrow captured-context plumbing, preserving other views' defaults. |
| [Base YAML](../../src/bases/document.ts), [session](../../src/bases/session.ts) | Safe unknown keys survive ordinary file-authoritative edits. Desktop builtins/mount cases are table/cards/list/kanban. `calendar` YAML alone has no renderer. Mounted views update/destroy and session edits defer refresh; Calendar must participate in pending/close, not be copied as an independent app. |
| [Calendar controller](../../src/calendar/controller.ts), [view](../../src/calendar/view.ts) | Existing shared controller, exact uncertain retry, bounded fenced windows, FullCalendar canvas/forms/gesture review and unavailable UI. Pending union currently covers create/move/title/delete only. Add ref commands, labels/picker and explicit create/link continuation; preserve existing standalone functionality and conflict candidates. |

## Chosen smallest product slice

Use linked WorkBlocks as the first `type: calendar` Base view. The same Calendar
canvas, detail form and task picker serve the standalone destination and Base
pane/named embed. This does not add a second task store or a frontend evaluator.

A scoped Base Calendar includes a block once if **any** of its linked, currently
task-capable files belongs to the exact Rust-selected saved view. Show every link
in details, including outside-selection and unavailable links. A block with no
refs belongs to standalone Calendar only. If removal of the last matching link
makes a block leave the Base, explain “Block saved; outside this Base” and keep
its details available until dismissed. Missing source/config never falls back to
all vault blocks. Non-task Base rows remain valid Base rows but do not confer
linked-task membership; report the omitted count.

Membership uses the actual displayed view, including its root/view predicates,
search, group-order exclusion and explicit saved `limit`, evaluated in Rust.
Use distinct counts for selected files and selected task-capable files. A query
budget failure does not become an empty Calendar. This deliberate exact-view
choice preserves agreement with other Base presentations. It does not define a
vault-wide absence test from a limited selection.

Minimal saved configuration (proposed first-party keys):

```yaml
views:
  - type: calendar
    name: Schedule
    calendar:
      source: linkedWorkBlocks
      timezone: America/Toronto
      initialView: timeGridWeek
      showWithoutBlocks: true
```

`timezone` is an explicit IANA zone, defaulting to the user's effective zone when
first saving the view, then retained. `initialView` uses the existing four view
names. Navigation date stays local session state, not a YAML write per click.
No provider toggles/setup are shown without a real connected provider. Unknown
supported keys remain intact. Ordinary mapped file-date calendars remain a later
required capability from the overall plan, not silently implemented as timed
blocks; this slice does not guess date fields, durations or all-day conversions.
The Task list's existing date filter is unchanged and must be described as “No
planned day” where contrasted with the new panel.

Standalone Calendar shows all local WorkBlocks; its picker/panel uses all valid
task-capable notes from the existing bounded Types inventory. Scoped Calendar's
picker/panel uses the Base's selected tasks. “Include completed” defaults off for
the panel/picker; existing linked completed tasks remain visible in details and
do not hide reservations. Scheduling never changes completion, deadline, planned
day or note body. A past block still counts as a block. “No upcoming blocks” is
not introduced under the “No work blocks” label.

## Shared read contract to assign before frontend implementation

Add one optional specialized `DocumentPin.calendar` read with the following
proposed discriminated requests. These names/fields are implementation targets,
not existing public methods. Reuse existing identity/error/page conventions.

```ts
type CalendarScope =
  | {kind:'tasks'; typeIds:readonly string[]}
  | {kind:'base'; typeIds:readonly string[]; definitionId:string;
     viewName?:string; viewIndex?:number; currentEntryId:string;
     searchTerms?:readonly string[]; ignorePaths?:readonly string[]};
type CalendarContext = {clockMs:number; timezone:string};
type CalendarRead =
  | {kind:'window'; scope:CalendarScope; context:CalendarContext;
     fromMs:string; untilMs:string; cursor?:string|null;
     limit:64; byteLimit:1048576; expectedWorkBlockWatermark?:string}
  | {kind:'tasks'; scope:CalendarScope; context:CalendarContext;
     withoutBlocks:boolean; showDone:boolean; cursor?:string|null;
     limit:64; byteLimit:1048576}
  | {kind:'links'; typeIds:readonly string[]; entryIds:readonly string[];
     context:CalendarContext}; // <=64, resolve all existing block refs
```

The transport adds the current `pinId`; no caller-supplied collection/owner,
lease, SQL, frontend query AST, task rows or label map. A Base request names a
saved definition and optional view, not JS-selected EntryIds. `currentEntryId`
comes from the actual standalone/embedding context, as for existing Base calls.
Use one captured `clockMs` and the saved IANA `timezone` for Rust Base evaluation,
task projection and any companion Base result in that Calendar session. Thread
this context through `src/bases/shared-query.ts` and the narrow
`src/bases/controller.ts` seam; do not render a UTC selection then join a separately
zoned selection. Preserve UTC defaults for other views unless configured separately.
Type inventory uses the existing 128-file bound. Search/ignore inputs keep the
existing Base semantics and bind into continuation identity. For both date
navigation and Today semantics use the captured explicit zone; extending the
FullCalendar display adapter for that zone must use installed v7 types, not a
global Temporal polyfill or an assumption that local and UTC dates coincide.

Return `DocumentQueryResult<CalendarReadValue>` with the unchanged pin snapshot,
source and pin coverage header, plus this nested evidence:

```ts
type LinkLabel =
  | {entryId:string; state:'task'; row:DocumentTaskRow; type:DocumentTaskType}
  | {entryId:string; state:'missing'|'deleted'|'notTask'|'unavailable'|'unknown';
     path:string|null; reason:string};
type BlockMembership =
  | {state:'present'; witness:WorkBlockTarget}
  | {state:'absent'}
  | {state:'unknown'; reason:string};
type CalendarReadValue = {
  kind:'window'|'tasks'|'links';
  selection:null|{definition:DocumentEntry|null; selectedFiles:number;
    selectedTasks:number; excludedNonTasks:number};
  evidence:{documentSnapshot:DocumentSnapshotId; documentSource:DocumentSourceId;
    documentCoverageComplete:boolean; taskCoverageComplete:boolean;
    workBlockWatermark:string|null; workBlockScanComplete:boolean;
    membershipComplete:boolean};
  phase:'scan'|'results'; cursor:string|null; scanned:number; bytes:number;
  blocks:readonly {value:WorkBlockRead; links:readonly LinkLabel[]}[];
  tasks:readonly {row:DocumentTaskRow; type:DocumentTaskType;
    membership:BlockMembership}[];
  links:readonly LinkLabel[];
  diagnostics:readonly {code:string; message:string}[];
};
```

For `links`, selection and WorkBlock watermark are null, task/window arrays empty;
no global-membership assertion is made. For a window page, tasks/links top-level
arrays are empty; each block has complete per-ref labels or explicit unknowns.
For task scanning, partial pages may expose progress/positive witnesses but never
new absent members; `phase: results` starts only after the global scan finishes.
Returned task rows paginate 64 at a time afterward with the same retained receipt.
Header/nested snapshot/source mismatches are errors. Existing detailed Type/task/
Base diagnostics remain in the native retained result, and relevant diagnostics
must be projected rather than replaced with success; exact schema reuse is
preferred over losing their witness/range information in generic messages.

### Selection and label resolution

Refactor reusable Rust task projection/Type compilation so Base selection is
applied **before** the task row cap. Evaluate the saved Base and task capability
against one `DocumentQueryPin`; intersect EntryIds in Rust, preserving Base order.
Do not intersect a previously truncated `pin.tasks` prefix. Preserve Rust's root/view
predicates, group-order exclusion, AND search across displayed property values,
sorting and saved limit before the row-budget check; preserve named-view resolution,
currentEntryId and ignorePaths. Include completed tasks for membership/labels;
`showDone` affects only picker/panel. Keep the portable Base
evaluator file-only: a small portable join/projection helper can accept host-fed
membership facts, without giving `zorid-bases` a managed Store dependency.

Resolve existing refs against the same retained manifest/metadata and pinned Type
sources, independent of selection, showDone or returned task prefixes. Missing
versus deleted is asserted only from retained manifest evidence. Current
capture uses `read_states(false)` and excludes deleted/invisible entries: absence
from that visible manifest initially yields `missing` / “Unavailable task”, never
`deleted`. Reserve `deleted` for a retained tombstone witness; no live tombstone/path
read may be presented as same-pin evidence. A `notTask` label requires readable
valid metadata and complete admitted Type knowledge; unreadable,
invalid Type/metadata or incomplete inventory gives unavailable/unknown. A valid
non-task target gets “No longer a task”; a missing target gets “Unavailable task”.
Never display opaque IDs as labels. Rename changes path/label while retaining the
EntryId; reused paths must not reconnect to a replacement note. Do not remove refs
because labels cannot be resolved. Opening a valid link uses the original saved
EntryId/revision through the guarded ordinary note route.

### Global inverse join and honest coverage

`withoutBlocks` means no active created/nondeleted WorkBlock anywhere in the local
collection references the task, independent of time. Scan authorized managed
records with `managed_export`, reuse `domain::read` and the WorkBlock fence; do not
infer it from a window query. Export alone is insufficient: it enumerates
`managed_records`, while incompatible/waiting/retained operations can insert
receipts and collection changes before any accepted state exists.

Add a NEW authorized collection-scoped unresolved summary in
`crates/zorid-store/src/managed_records.rs`, using existing
`managed_receipts_retry(collection_key,update_id,status)` without schema/index
changes. Return a conservative existence/unknown fact, never raw receipts or an
unbounded history to UI. Walk at most 64 receipts per step with retained continuation;
use the same collection handle and before/after watermark fences as record scans,
charging both to the shared 128-page/8-MiB aggregate scan bound. A completed summary
with no relevant unresolved receipt permits negative proof; finding one or exhausting
the bound makes all unproven negatives unknown. Initially treating all non-accepted
statuses conservatively is safe. Accepted projected refs still prove presence.
Summary/domain-read failures never become absence; do not rescan changes from zero
for every view. This new Store seam requires its own named source grant.

Existing `TaskFilter::Unscheduled` means no planned
day, including absent mapping/null/empty, while invalid nonempty dates carry a
diagnostic and do not qualify. Neither that filter nor `plannedDay === null`
implements this inverse join.

Any live block reference proves presence, including past/future blocks, multiple
or conflicted ranges and blocks outside the current Base's time window. Deleted
blocks do not count. Unresolved/incompatible or uncreated records whose retained
operations might affect references prevent a confident absence assertion. If
that uncertainty cannot be attributed to particular IDs, mark all unproven
negatives unknown. Unknown tasks stay in a separate “Scheduling status unavailable”
area; do not count them as no-block tasks. An empty No work blocks panel is only a
complete-empty claim when task selection and global membership coverage are both
complete; otherwise show an actionable incomplete-state message.

The native join owns a WorkBlock read session under the **same existing client
lease/vault** as the pin. Pin closure/client release invalidates join cursors and
retained work; never serialize a native capability into a DTO. A cursor binds
request kind, complete selection/context/budgets, document snapshot/source,
collection watermark and progress, with one active join receipt per pin sharing
the existing eight-cursor ceiling.
Replacement explicitly expires the predecessor. Retain at most 1,000 selected task
rows, at most 64 labels per block/ref-resolution request, and 8 MiB total serialized
join state per pin. Keep membership facts only for selected tasks and streamed
window output rather than a vault-wide inverse index. Keep all in-flight reads
owned until settlement
before closing the pin. Expired cursor/pin or changed fence requires an explicit
refresh; no silent retry on a new generation.

Native scan pages retain 64 scanned records and 1 MiB, including zero-match pages.
Visible windows stay half-open and at most 31 elapsed days. A 42-day month is
split into bounded windows, deduped by record+generation, all with the first
window's expected watermark; no core limit increase. Any intersecting candidate
is included, with all candidates preserved. Existing Calendar aggregate ceilings
remain 128 pages/8 MiB; exceeding them produces a shorter-view/refresh error, not
truncation. Record pages and unresolved-summary steps share the same
128-page/8-MiB maximum for the first global inverse scan.
Bound selected task materialization to 1,000 with an explicit over-budget error;
never return a truncated set as an exhaustive picker or global empty result.
Retention/materialization overflow is an explicit budget error. Report scanned
bytes separately from encoded response bytes. Every expanded reply, including
labels and diagnostics, is at most 1 MiB; an oversized
record yields an error, never a silently shortened ref set. These conservative
bounds can be optimized later by a Rust-derived reverse index after measurement.

Capture one immutable document pin and fence WorkBlock reads at a stable collection
watermark before/after each scan, continuation and result delivery. Existing
`document_result` verifies retention but the retained manifest allows
advancing source heads. Add a Calendar-only same-lease check of the exact retained
pin and current document source through `document_index_status_with_source` at
scan admission and before each delivered continuation/result. Source identity
includes local store ID plus source watermark. If it advanced, return changed-source
and offer explicit refresh. Fence WorkBlocks before/after every bounded step and
delivery. This observation makes no promise that either store stays unchanged
after delivery. Task selection, Type witnesses, labels and membership thus describe one declared two-source observation. Document
source watermark and WorkBlock watermark are **different counter domains**: never
compare numbers or claim a cross-store atomic transaction. Local coverage is not
remote sync completeness. Subsequent document/WorkBlock changes invalidate both
panel and calendar; coalesce demands through the shared service/controller rather
than run independent per-pane polling loops.

## Writes and create/link continuation

Keep `WorkBlockService` mutation DTOs and Rust record schema unchanged. Extend the
Calendar controller's immutable pending union/dispatcher with `addRef`/`removeRef`.
Each command retains target, task EntryId, expected revision and operation exactly.
Add uses a task chosen from the real query, revalidated through a fresh same-vault
read before dispatch; missing/changed/non-task selection asks for review. Existing
structural addRef intentionally permits dangling refs, so a note may change after
that check; preserve/display the link honestly. This is not atomic cross-file
admission. Remove remains available for unavailable targets. Never derive a new
operation or revision for a blind retry. Unknown response disables further writes,
shows pending/retry, and retains its exact request; definite stale rejection
requires reviewing actual state before a new user command. Observed-remove may
leave a concurrent unseen re-add visible; report the refreshed set without deleting
it again automatically. Removing a block preserves all task files.

The smallest schedule action uses existing sequential commands: create the block,
confirm it, then add selected links one at a time. Change the controller's internal
create receipt to expose the captured target and acknowledged revision, keeping
legacy standalone callers compatible. It must not close the form after create
while silently dropping unfinished links. Show “Block saved; linking 1 of N” and
list acknowledged, pending and not-started links separately. No compensating block
delete on a partial link failure. Cancel before create writes nothing; Stop linking
after acknowledged create leaves the existing block/acknowledged links intact.
An uncertain command cannot be discarded as though nothing happened.

Persist a small local continuation **before** dispatch, containing captured create
input/target, ordered selected EntryIds/witnesses, immutable current command, last
acknowledged receipt and remaining phase. Proposed NEW `src/calendar/continuation.ts`
owns validation/serialization; inject a bounded store scoped with the existing
trusted vault/window storage identity in Workspace. Store only intent/retry state,
not an authoritative task/block replica. One durable continuation owner per trusted
vault/window is shared by standalone, panes and embeds; other mounts attach rather
than replay or overwrite its journal. Allow one active scheduling sequence, at most
64 unique selected refs, and a versioned serialized journal of at most 64 KiB;
reject oversize before dispatch. Derive its distinct Calendar key from authenticated
window and trusted vault identity (`WorkspaceStorageScope`), never note paths or
NoteBuffer draft keys. A storage error stops dispatch. After an acknowledgment,
persist receipt/progress before another send. If that persistence fails, stop and
retain the older journal; recover by exact replay of its original current command.
On restart, re-admit the vault and present Resume/inspect; never auto-run a write.
Replay an uncertain stored command exactly to establish its receipt even if its
task has changed. Fresh same-vault task admission applies only to the next
not-started addRef, never to rewriting or blocking replay of the old command.
If a restored window cannot reclaim its scope, preserve the journal and offer an
explicit same-vault recovery handoff before one new owner adopts it; no copying,
multiple-window replay or automatic orphan deletion. A replayed
create is never a second create; acknowledged-create recovery never rotates its
record/generation. Read current block after each acknowledgment; only continue
with the acknowledged revision if still equal, otherwise ask explicit review
without rebasing the old request. Corrupt or incompatible continuation stays
retained and inspectable with an error, blocks new writes in its scope, and is
never silently cleared. Pending commands, dirty drafts and failed persistence veto
view replacement, close and vault release; rejected close retains the mounted UI.
Only a fully persisted, acknowledged stopped sequence may close with its recovery
entry retained. Extend actual `CalendarView` form dismissal and Base `MountedView`
async flush/close paths so create ack alone cannot dismiss unfinished links.
This journal needs dedicated restart
and write-failure proof; current standalone Calendar does not already provide it.
No new record transactions, general jobs API or protected-secret API are implied.

## Desktop layout and reuse

Keep the accepted Month/Week/Day/List, Today and navigation controls. Add a Tasks
panel toggle and a No work blocks panel beside the calendar when wide; in a narrow
split, place it above the grid in a collapsible section. It must wrap without
horizontal underflow or sidebar occlusion. Show real title/path/status and optional
planned/deadline text, never user-facing EntryIds. Picker search is explicitly
limited to the fully loaded bounded selected task set in this first slice; do not
imply vault-wide server search. Unknown coverage is visible and blocks false empty
claims. Empty-state actions are Add work block and choose an existing task, not a
placeholder connection wizard.

Schedule uses a selectable task row plus explicit Schedule button that opens the
existing timed form (one-hour default clearly editable). Clicking/selecting a grid
range can prefill that form. Pointer task-to-grid drag is a subsequent interaction
within this slice after the button path works; drop proposes a range and opens
review, never writes on hover/drop. Move/resize retains immediate library revert
and Save time/Cancel alternatives. Linked-task details support 0, 1 or many chips,
keyboard picker/add/remove, visible partial progress and Open note. Block title is
independent; never overwrite it from the first linked task. Conflicted fields keep
all candidates, with explicit field-specific replacement.

Extract/reuse a small FullCalendar canvas/detail/picker composition from the current
Calendar view. A Base calendar receives native selected results and shared mutation
host; it must not mount the unchanged standalone destination and requery all tasks.
Share row/picker rendering, not a duplicate Tasks query/controller. Extend the Base
mounted-view contract to expose pending edits/flush/close, wire them into existing
session deferral/preflight, and retain draft/continuation state on updates, view
switch, split/park, failed close and named embeds. A read-only Base embed disables
all scheduling/link writes explicitly; ordinary note opening remains available.
Unsupported optional read capability shows unavailable, without JS/local fallback.
Use safe text DOM, app light/dark typography, accessible field names/focus and
synthetic schedules only. Do not repeat the already accepted standalone audit.

## Proposed exact ownership batches (not grants)

| Batch / named role to assign | Proposed owned files and limits |
| --- | --- |
| NEW Store evidence owner | `crates/zorid-store/src/managed_records.rs`: bounded authorized collection unresolved summary using existing receipt index; focused managed-record tests under `crates/zorid-store/tests/`. Depends on named root Store seam grant and summary DTO agreement; no DB/schema/index changes. |
| Shared Task/Base owner | NEW `crates/zorid-bases/src/calendar.rs`; `src/tasks.rs` for reusable capability projection before limits; `src/lib.rs` export; focused NEW `tests/calendar.rs`. Reuse `query_generation` unchanged where possible. No records/store dependency or duplicated parser/evaluator. |
| Native join owner, coordinated with both services | NEW `crates/zorid-native/src/calendar.rs`, narrow `document_api.rs` DTO exports, `document_index.rs` pinned selection/labels, `workblocks.rs` scoped export/fence helper, `lib.rs` module; NEW `tests/calendar.rs`. Depends on the new Store unresolved summary plus export/watermark, Calendar-only retained-pin/current-source checks and bounded receipt ownership. No SQL schema/reverse-index migration or record format change. Root grants the shared native seams first. |
| Existing desktop binding owner | `crates/zorid-desktop-host/src/documents.rs` specialized Calendar command/cursor retention and `workblocks.rs` internal session sharing only if necessary; NEW `src/core/calendar.ts`; narrow `src/core/document-semantics.ts` optional pin read; `src/platform/desktop-document-semantics.ts`, `desktop/document-semantics.cjs` and `.d.cts` strict request/response checks; relevant focused host/codec tests. No new IPC channel/lease or native-authority handles. Do not alter `src/core/workblocks.ts` mutation shapes. |
| Calendar UI owner | `src/calendar/controller.ts`, `view.ts`, `view.css`; NEW `canvas.ts`, `continuation.ts`, `task-picker.ts` only as useful concrete extractions; NEW focused controller/continuation/picker tests. Preserve accepted standalone flows, exact ref retries and common service ownership. No editor internals. |
| Bases UI owner | NEW `src/bases/calendar-view.ts`; narrow `session.ts` capability/pending/mount plumbing, `document.ts` builtin, `toolbar.ts`/`toolbar-config.ts` saved Calendar controls and validation; narrow `src/bases/shared-query.ts` and `src/bases/controller.ts` captured clock/saved-IANA context plumbing for evaluator/task/companion results; focused Base calendar tests. No JS query changes to imitate native joins. |
| Exclusive Workspace owner | Exact `src/ui/workspace.ts` Calendar/Base options, shared services, continuation store scope and guarded EntryId opening hunks only after root grant; named embed host threading through existing Base session options. No NoteBuffer/native/mobile signature edits. Existing `src/ui/workspace-window.ts::WorkspaceStorageScope` supplies trusted vault/window session and draft keys; root must grant any additive Calendar key helper there. Use a distinct Calendar continuation key, never parse it as a NoteBuffer draft. |
| Reviewer and integration owner | Independent review of exact composed Rust/DTO/frontend changes; coordinator assembles after current Tasks gate. Root alone integrates main and authorizes shared new seams. No manifests/dependencies needed for this proposed slice. |

Existing native/mobile/browser transports do not acquire Calendar joins merely from
optional TS types. Native Rust semantics should be reusable there, but actual
browser WASM binding/worker and Swift UI integration require separate named batches
and platform evidence. The first delivery target here is normal desktop only.

## Ordered acceptance and freeze evidence

Use the following focused evidence and one composed UI gate, not an exhaustive
combinatorial campaign or a repeat of standalone acceptance.

1. The old currentTasks split identity defect is fixed in main `209368`; finish
   its separate actual proof through the assigned owner before source grants;
   do not attribute it to this new feature or remove
   an immutable-ID check. Assign shared seams and agree exact DTOs above before
   implementation. Keep task owner, worktree, dependencies, commits and evidence
   separate in durable coordinator tracking.
2. Rust selection/label fixtures: same-pin saved/named Base selection before task cap; exact view
   limits/search/context; Type rename/change/invalidity; manifest missing/deleted/
   path reuse; zero/one/many links; non-task notes; completed task labels; all
   diagnostic/coverage headers. Reject mismatched receipts and expired pins.
3. Inverse-join fixtures: past/future/out-of-window and conflicted blocks still
   establish presence; deleted blocks do not; unresolved/uncreated/incompatible
   states cannot produce false negatives. Decisive Store regression: receive
   incompatible/waiting operations for a record with no accepted state before
   Calendar opens, keep watermark stable and export empty, then query an unrelated
   unlinked task: it stays unknown, never absent. Cover accepted plus receipt-only
   records and settlement followed by explicit refresh; zero-match continuation, 64/1-MiB
   bounds, 128-page/8-MiB exhaustion, changing document source and collection fence,
   cross-domain counters, complete empty versus unknown. No planned-day proxy.
4. Window fixtures: 42-day month split into <=31-day windows, shared expected
   fence across all pages/windows, candidate union/dedup, oversized label expansion,
   no truncated references, cancelled/late reads publish nothing and retain pin
   ownership through settlement.
5. Controller/DOM fixtures: selection from real query, missing label retention,
   original-witness note open, independent title, ref-only writes preserve task
   bytes/dates/status; exact uncertain add/remove retry; stale/conflict review;
   concurrent re-add survives. Create then link failure/resume/restart/storage-fail
   cases prove exactly one create identity and explicit partial progress. Include
   failed post-ack persistence followed by original-request replay, changed next-task
   admission, one-owner recovery handoff and corrupt/oversize journal retention.
6. Base pane and named embed fixtures: any-selected membership once; outside-
   selection links stay visible; standalone blocks excluded; read-only behavior;
   view reorder/switch/draft deferral/close rollback; same canvas/service in split
   and standalone; no additional query/persistence authority in the renderer.
7. One coordinator-frozen native+binding+frontend Electron pass uses disposable
   synthetic vaults through normal UI: create task, schedule in standalone and
   scoped Base, link multiple tasks, unlink missing task, move/resize cancel and
   save, open/edit ordinary note, change completion/deadline separately, restart
   and verify exact blocks/refs/config/continuation. Check keyboard-only schedule,
   drag proposal/cancel, both themes and narrow panes with actual rect/computed
   visibility/hit tests, not hidden-node text. Record source/harness/native/dist
   hashes and close owned app/native child. Isolated checks do not complete this
   acceptance, mobile parity or multi-client sync.

This document settles routine first-slice UX. Consequential future work remains
explicitly outside it: file-date event mappings, recurrence/time entries, provider
connections/two-way publishing and native calendar UI. No speculative plugin
framework, checkbox indexing or flashcard workload is introduced.
