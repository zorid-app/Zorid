# Next functional first-party consumer: local Tasks and WorkBlocks

2026-10-17; source inspection at `1bbc0fb31e4094b1c1bdc038d63403824ee7fb14`.
Owner: dispatched contract worker `term_ef51c268-5804-46f1-b07c-f634a3c318a7`,
task `task_443398c0e767`, dispatch `ctx_99a6816f636e`, branch
`tingkai-c/managed-firstparty-consumer-contract`. Scope: this new document only.
The sole shared-core integrator owns main. Recommendations below are an internal
implementation handoff, not a public API freeze or an implementation claim.

## Deliverable and dependency boundary

Deliver a usable offline Electron flow: enable Tasks in a vault, create a task
note, change its status in Tasks and a Base, reserve a WorkBlock referencing it,
move/resize that block, quit and reopen. Open its rich body in the existing editor.
A second task can share the block; one task can have several blocks. Ending or
deleting a block never completes, deletes or changes the deadline of its tasks.

This follows accepted [Phase 3 then local Phase 4](implementation-plan.md), with
small coherent domain/UI slices rather than another generic framework milestone.
Google, central provider jobs/leases, secrets, recurrence, time tracking and native
calendar delivery remain required later stages; completing all of them is not a
prerequisite for this local flow. This slice must not claim all Phase 3/4 acceptance.
Continue current browser proof work independently; domain/config work can start
while those proofs settle. Product activation uses the reviewed integrated record
adapters, not a synthetic registration replacement or a test page.

Evidence read: the roadmap execution checkpoint and findings; accepted plan;
[browser storage seam](browser-storage-seam.md), [browser results](browser-record-results.md)
and [normal Worker results](browser-worker-host-results.md). Storage is integrated
through `b5d9d510`; the normal Worker report records `804c9fd5` and actual Chrome
fixture evidence, with an **empty product registry** and two independent normal
Workers authoring/exchanging offline changes still unverified at that report.
Neither report establishes Electron Tasks, native Tasks, deployed relay or complete
managed-data acceptance. Reconcile newer coordinator proof results before activation.

## Authority, identity and files

| Item | Authority and next implementation choice |
| --- | --- |
| Task title/body/properties | Markdown note bytes, ordinary durable save/recovery and file sync. Do not create a managed task mirror. Default title is filename stem; no second title property required. |
| Type definition | Ordinary synced vault file `Types/Task.yaml`; stable type ID inside, independent of filename/label. Derived type registry rebuilds from valid files. |
| Base | Ordinary `.base` YAML, default `Bases/Tasks.base`; filters, views and creation defaults have separate meanings. Existing comments/unknown configuration survive edits. |
| Task identity | Existing core `EntryId`; reference within enrolled vault, never a path or title. No duplicate frontmatter UUID required in this slice. Paths resolve from current namespace. Copy/import into a different vault gets that vault's identities; cross-vault identity-preserving export/import is not promised. |
| WorkBlock / later time entry | Managed synced record with independent opaque record and generation IDs. No shadow Markdown file, separate database or feature-owned sync. |
| SQL/index/task list/calendar rows | Rebuildable projection only; carry generation/revision/coverage witnesses. Deleting these caches must not lose tasks, type definitions or blocks. |

`crates/zorid-core/src/path.rs::VaultPath` rejects root `.zorid` (case-insensitive),
absolute/drive/backslash/control/dot/empty-segment paths. Therefore do not place
syncable Type/Base definitions at `.zorid/types/...`. `src/platform/path.ts` is a
weaker UI helper: it collapses empty segments and does not reserve `.zorid`; it
is not the admission authority. Validate configured destinations with Rust
`VaultPath` and ordinary platform filesystem admission; never silently normalize
an invalid path into a different destination. `Types` and `Bases` are defaults,
not reserved user folder names. Prompt for an alternate unused path if existing
files conflict; never overwrite an unrelated `Types/Task.yaml` or Base.

Use host CSPRNG UUID strings for newly allocated type/property/option/record and
operation identities. Validate task references with core `EntryId` (ASCII
letters/digits/underscore/hyphen, 1–128), not the more permissive records `Id`.
Managed create operation ID equals its generation, as required by
`zorid-records::State::validate_operation`; keep record ID distinct and stable.
A deleted task reference remains a visible missing/deleted reference and can be
removed explicitly; never rebind by same path. Restoring the same core entry may
resolve it again. Do not cascade block deletion when a task disappears.

## Smallest useful Type and Task model

Recommend one type per note initially, optional `task` capability per type, stable
property IDs mapped to exact YAML keys. The following is **proposed internal YAML**,
not supported syntax today; symbolic IDs show relationships and should be replaced
by generated UUIDs when the preset is installed:

```yaml
version: 1
id: type-task
label: Task
properties:
  - id: field-status
    key: status
    label: Status
    datatype: status
    default: status-todo
    options:
      - {id: status-todo, label: To do, category: not_started}
      - {id: status-working, label: In progress, category: working}
      - {id: status-done, label: Done, category: done}
  - {id: field-planned, key: planned, label: Planned day, datatype: date}
  - {id: field-deadline, key: deadline, label: Deadline, datatype: date}
capabilities:
  task:
    status: field-status
    plannedDay: field-planned
    deadline: field-deadline
```

The corresponding Markdown frontmatter uses `type: <type UUID>`,
`status: <option UUID>` and optional `planned: '2026-10-18'` /
`deadline: '2026-10-20'`. Body is ordinary Markdown. Dates are quoted ISO
calendar dates, not UTC midnight timestamps. Empty planned/deadline means unset;
malformed dates remain visible as property errors, never guessed. A task without
status uses the type default for display, but new captures persist the default.
Unknown status IDs are shown as unknown and preserved until explicitly corrected.

`status` and `select` are domain interpretations of string-valued properties;
`zorid-document` currently exposes text/list/number/checkbox/date/datetime/tags,
not a status engine. Build a Rust type/capability interpretation layer over the
existing exact-key `PropertyValue` metadata. Do not change Markdown parser meaning
or convert status to Boolean. Reject duplicate type IDs, property IDs, exact keys,
option IDs, invalid mappings/categories and unsupported versions for typed writes;
retain source with diagnostics and allow ordinary body editing. Use bounded YAML
parsing (no custom tags, excessive/cyclic aliases) and preserve supported unknown
configuration when editing. Disabling task capability removes a note from Tasks,
without deleting its content or its block references.

Labels and type filenames can change without migrating notes because IDs remain
stable. Initial property-key rename is unsupported in the UI; show the key as
fixed after use. A later explicit source migration is separate work, with recovery.
Do not offer arbitrary callbacks or overwrite older/unknown definitions.
Assignment/Bug can map their own status/planned/deadline property IDs into the same
capability. Do not reserve `_task_`, infer taskhood from folder/tag/name, or create
checkbox-derived task records. The parser's `DocumentMetadata.tasks` is checkbox
syntax evidence, not the built-in Tasks dataset.

## Bases and task queries/commands

Start with a Tasks preset containing ordinary table/list views using existing
`src/bases/document.ts`, `controller.ts`, `shared-query.ts`, and Rust
`zorid-bases::{compile_base_source, query_generation}`. `BaseDocument` preserves
unknown YAML but does not implement type capabilities or creation defaults;
`BUILTIN_BASE_VIEW_TYPES` is currently table/cards/list/kanban. Extend only the
needed Type selector, creation defaults and task-aware status rendering. A Base
selects all indexed Markdown records by default; type/folder/property predicates
narrow membership, while index exclusions/coverage remain separate.

Default Tasks Base selection is the installed Task type ID; creation defaults are
`folder: Tasks` and that type ID, separate from filters. Use existing exact-property
filter evaluation (e.g. `note.type == "<type UUID>"`) after validating syntax against
`zorid-bases` corpus; do not invent a second JS evaluator. Built-in Tasks selects
**all valid task-capable types**, independent of this Base. Add a small Rust
capability projection/query over a pinned document generation plus captured Type
configuration revisions. Do not fake capability selection with a reserved type
name or expand arbitrary JavaScript expressions. Invalidate on relevant file or
Type changes; expose incomplete coverage and require refresh after pin expiry.

Initial Tasks UI: All, Today and Unscheduled filters; Today means planned day is
captured local today or an incomplete task is due on/before today, Unscheduled
means no planned day (block reservations are a separate facet). Group by status
category, then option; sort deadline ascending with unset last, then title and ID.
Done is hidden by default with an explicit Show done control. Capture clock and
IANA timezone once per query, as existing Bases options do. Return task entry ID,
revision, path, labels, mapped values and diagnostics; no source rewrite on query.

Internal semantic commands (names are proposals): `createTask`, `setTaskStatus`,
`setTaskDates`, `scheduleTasks`, `moveWorkBlock`, `resizeWorkBlock`,
`setWorkBlockTasks`, `deleteWorkBlock`. Commands carry intent/operation ID and
expected saved revision; they do not accept namespace/schema/owner. Type-driven
capture resolves destination/defaults before allocating one ordinary note through
the existing create/save route. Inline edits use shared NoteBuffer and flush/CAS,
not direct adapter writes or a private editor buffer. A stale witness refreshes
before retry and never discards the shared dirty draft. Base and Tasks observe
the same subsequent saved file/index change.

Explicit checkbox conversion follows after this flow: create one task note first,
then replace only the selected checkbox line with a link after successful durable
create, preserving text/body and checked-to-done mapping. Two files are not one
transaction: retain the original on failure, reuse the capture intent on retry,
and offer recovery if note creation succeeded but line replacement failed. Undo
must not blindly delete a subsequently edited task. No automatic checkbox indexing.

## First managed consumer: WorkBlock v1

Recommend fixed trusted owner `zorid_firstparty_calendar`, collection `workblocks`,
schema v1, `Policy::Synced`: local-first means offline use with existing sync, not
`Policy::Local` loss on another device. Required non-null `range` is one Object;
optional `title` is a String (up to 512 UTF-8 bytes); `task_refs` is a Set of core
entry IDs (maximum 64 visible members). Empty refs permits a standalone block.
Default title is explicit block title, otherwise linked task titles, otherwise
“Work block”. Renaming a task updates a derived label, not block authority.

```json
{"start_ms":"1792328400000","end_ms":"1792332000000","timezone":"America/Toronto"}
```

Range is a single atomic value, never separately merged start/end/timezone fields.
Use canonical decimal strings for epoch milliseconds through JS boundaries;
Rust checks finite representable instants and `end > start`, timezone is a valid
IANA identifier (UTC allowed), and both dates fall in the supported UI interval
1970–2100. Start/end are instants; timezone controls wall-clock display/editing.
Reject nonexistent wall times on local input and require explicit offset selection
for ambiguous DST times. Resizing writes the entire range. Overlap is permitted;
calendar query uses half-open intersection `start < until && end > from`.
All-day/date ranges and recurrence are explicit subsequent model additions, not
implicit midnight conversion. Do not start timer/timeentry records in this slice.
Their later authority remains managed actual-work history, distinct from blocks
and planned/deadline note properties.

### Required shared Rust validation, before product activation

Today `crates/zorid-records/src/lib.rs::Value::validate` checks Object JSON
size/depth, not range keys, dates, start/end ordering or timezone. Atomicity alone
cannot make malformed Objects valid. A JS form check cannot establish the guarantee.

Implement a small compiled first-party domain module, proposed new
`crates/zorid-records/src/first_party.rs`, and dispatch for the exact trusted
owner/collection in `admission.rs`. Validate that this collection's registration
matches its compiled schema/policy; an alternate registration cannot downgrade
validation. No serialized callback/validator code or user-selected domain name.
Validate every incoming/local range write and set addition, including operations
waiting on parents and all concurrent range candidates, not only the chosen
projection winner. Reject null/unset required ranges, extra range keys in v1,
noncanonical decimal/overflow, invalid zones and IDs. Check required range on
Create and bounded resultant task-ref cardinality on admission; concurrent unions
that exceed capacity remain durably unresolved rather than silently truncating.

Apply the same validator in local preparation, received admission/retry,
accepted-state restore/reopen, registration replacement and lossless state export
validation. Preserve unknown outer fields under existing record rules; unsupported
schema versions use existing durable incompatible-schema receipts. Invalid incoming
operations retain existing invalid-operation evidence and do not mutate accepted
state or create an authored echo. Whole-value concurrent range candidates remain
recoverable; expose conflict details and choose one only by a new command observing
all current heads. Validate references structurally in Rust; requiring referenced
notes to exist at ingestion would break out-of-order file/record sync. Local UI can
require a currently task-capable note when linking, then display missing/changed
references safely after receipt. No cross-file/record transaction is promised.

### Trusted activation and bounded reads

`src/platform/browser-managed-records-registry.ts::browserManagedRecordConsumers`
is empty; host entries hold private collection handles, and `changed` supplies
metadata only. Add one compiled consumer whose registration bytes are produced
from the Rust first-party module. Extend the internal host factory narrowly so it
passes the actual handle to that consumer's closure after registration and clears
it on stop/release. Never serialize the handle or expose `register` to the renderer.
Worker messages may request semantic scheduling commands and bounded reads only;
the Worker supplies enrolled realm/vault, fixed owner/schema and handle, checks
session/lifecycle, and uses the existing local queue. Keep startup/foreground
maintenance, retries, change watermarks and shared sync session from the host.

Native `zorid-store::Store` already has `managed_register/apply/snapshot/changes`
and paged `managed_export`; `ManagedCollection` is process/store/revision-bound.
It is not yet a normal Electron first-party binding. Add a native host-owned
WorkBlock service that privately registers/retains its handle and uses these
methods. Electron main checks the existing admitted client/vault/window and routes
semantic commands, never renderer-supplied registration. Native and browser call
the same Rust domain validator. Local creation works without Google or a live network: normal browser
`initializeLocal` startup already enrolls `local_<authorityId>` /
`vault_<authorityId>` when absent; desktop
`crates/zorid-desktop-host/src/lib.rs::initialize_desktop_vault` does the same
from `local_store_id`. Reuse that persisted scope; do not invent another identity
or require a live sync key for local reads/writes. The key is needed for encrypted
receive retry/upload. Later device joining must reconcile scope explicitly under
the roadmap joining design, never silently rebind already-authored blocks.

Browser's existing frozen records facade has only register/apply/snapshot/retryPage/
changes, not a collection listing/range query. Add the **necessary bounded scoped
listing** in the records adapter, authorized by its handle: key-ordered pages with
explicit count/byte limits and continuation, no unbounded getAll or raw JS JSON
number decoding. Native can page existing `managed_export`. A shared Rust
WorkBlock query filters/decodes those pages for the visible interval; return a
continuation and incomplete flag until the scan finishes. Start with maximum
31-day windows and 200-row/1 MiB pages; existing 1024-record/32 MiB domain quotas
still apply. Concurrent changes invalidate/restart the range read; do not claim
snapshot-consistent pagination without a revision/watermark fence. Retain IDs for
missing task joins; rebuild task labels from pinned document/type facts. A bounded
scan is sufficient initially; add a rebuildable interval index only when measured
calendar behavior needs it, not arbitrary query/schema indexes now.

## Sequenced owned implementation slices

Named roles below require coordinator assignment before edits to shared seams;
this document does not acquire those files. Current native shell owner stays
unchanged and receives only a later agreed semantic DTO handoff.

| Slice / owner to assign | Exact existing seams and proposed new files | Observable exit |
| --- | --- | --- |
| 1. Task domain + preset / Types-Bases owner | NEW `crates/zorid-bases/src/types.rs`, `tasks.rs`; wire via existing `lib.rs`, `graph.rs`; NEW `src/tasks/presets.ts`, `src/tasks/types-document.ts`; review `crates/zorid-index/src/generation.rs`, `snapshot.rs`, `crates/zorid-document/src/types.rs`, `frontmatter.rs` without adding a second parser. | Install non-overwriting Type/Base preset; valid typed Markdown appears in the same pinned Base and Tasks projection; malformed configs produce recoverable diagnostics. |
| 2. WorkBlock validation + commands / records Rust owner | NEW `crates/zorid-records/src/first_party.rs`; existing `lib.rs`, `admission.rs`, `crates/zorid-store/src/managed_records.rs`, `crates/zorid-wasm/src/records.rs`. | Local and encrypted incoming malformed ranges fail identically; valid offline create/move/ref edits persist and retain conflicts/replay semantics. |
| 3. Real scoped host / browser host + desktop core owners | Existing `src/platform/browser-managed-records-registry.ts`, `browser-managed-records-host.ts`, `browser-core-worker.ts`, `src/core/browser-managed-records.ts`, `browser-sync-streaming.ts`; NEW `crates/zorid-native/src/workblocks.rs`, `crates/zorid-desktop-host/src/workblocks.rs`, `desktop/workblocks.cjs`, `src/core/workblocks.ts`; named owners for `crates/zorid-native/src/lib.rs`, `crates/zorid-desktop-host/src/lib.rs` (existing admitted stdio Command/session dispatch), `desktop/rust-vault-service.cjs`, `vault-dispatch.cjs`, `preload.cjs`, `src/platform/desktop.ts`. | Normal browser Worker and Electron main register compiled WorkBlocks; renderer schedules/queries with scoped commands; restart reads the same records without a fixture host. |
| 4. Functional desktop Tasks / UI + editor seam owner | NEW `src/tasks/controller.ts`, `view.ts`, `view.css`; existing `src/bases/controller.ts`, `document.ts`, `presentation-common.ts`; named grants for `src/ui/workspace.ts`, `workspace-keymap.ts`, `workspace-menus.ts`, `src/ui/note-buffer.ts` if needed. | Capture, edit mapped status/date, open rich body; saved state agrees in multiple Bases/Tasks; stale/failed saves retain drafts. Avoid NoteBuffer changes if current mutation host suffices. |
| 5. Local desktop calendar / calendar UI owner | NEW `src/calendar/controller.ts`, `view.ts`, `view.css`, using fixed WorkBlock service; explicit owner for `package.json` / lockfile only if adding FullCalendar dependencies. | FullCalendar day/week visible range, explicit add/edit sheet, task linking, move/resize/cancel, keyboard alternatives, local source toggle and durable reopen. Start with forms before drag; no Google placeholder flow. |
| 6. Actual delivery / independent reviewer + integration owner | Focused domain/adapter tests beside changed modules; normal Electron/browser interaction evidence and reports. Native followup assigned to existing shell owner only after DTO review. | Integrate coherent reviewed commits through sole main owner, then verify composed normal apps. No parity inference from isolated fixtures. |

Slices 1 and 2 are independent; host work can start against agreed domain functions
while Tasks UI uses the existing file mutation host. Serialize shared API edits and
heavy checks. No new crate, generic schema framework, public plugin API, independent
sync engine or root build rewrite is needed to start; any genuinely needed binding
or dependency change gets an explicitly named owner before edit.

## Acceptance and followups

Normal Electron verification must capture create task -> status/date edit in two
views -> schedule two tasks in one block -> add another block for one task ->
move/resize/cancel -> restart -> open rich note -> delete reservation with tasks
intact. Include rename/delete task with visible missing-reference handling,
external CLI property edit, dirty-buffer/CAS failure with draft retention, and
incomplete/rebuilt index behavior. Exercise split/narrow pane, keyboard and
accessible status naming. Close the owned Electron app after each pass.

Focused Rust checks must meaningfully cover malformed/DST range input on both
local and incoming paths, concurrent whole-range conflicts, invalid refs and
bounded query continuation; adapter checks cover durable retry/response loss,
revoked handle/window and restart. Actual normal browser product flow follows
activation; the current synthetic registration proof is not that evidence.
Sync acceptance additionally requires independent normal clients offline then
converging task files/config and WorkBlocks, without a feature outbox or cursor.

Native remains a required subsequent delivery stage: existing owner connects the
same commands/query results to generic native Task lists and native calendar
layouts, using the current shell and shared web editor for bodies. Agree DTOs
before their edits; this worker changes no Swift, shell or framework choice.
Designated simulator and physical Zorid Dev flows require explicit validation
slots; prove offline capture/schedule/edit/complete/restart, DST, gesture cancellation,
accessibility and no-loss behavior. Keep designated simulator booted and record
Android delivery separately. Desktop screenshots cannot establish native parity.

Only consequential later choices remain open: all-day/recurrence semantics,
checkbox conversion undo/recovery detail, and native calendar component selection.
Recommended initial defaults above (one type per note, file-authoritative task,
core EntryId reference, timed atomic range, three status categories, bounded scan)
are sufficient to assign the local implementation now. Google mapping ownership,
provider coordination/security and time-entry allocation must be settled before
those later consumers, not imposed as gates on offline Task/WorkBlock delivery.

Validation of this document: source inspection and whitespace/path review only;
no network, builds, runtime/native tests, source modifications or API activation.
