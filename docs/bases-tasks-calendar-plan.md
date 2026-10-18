# Bases, tasks and calendar

> Historical plan — superseded by
> [the managed-data implementation plan](managed-data-tasks-calendar-plan.md).
> Do not implement the combined checkbox/task aggregate or direct task-calendar
> scheduling described below. Markdown checkboxes remain separate from task
> notes; tasks are a type capability, and work blocks/time entries use managed
> records. Keep this file as provenance for isolated early candidates only.

User moved this milestone before Stage5 on2026-10-17. Execution order is Vite →
this milestone → Stage5. This is preparation while Vite native acceptance runs;
no new product feature or schema is implemented by this document.

## Starting point

Stage4 already supplies portable Rust Markdown metadata, disposable coherent
indexes and Base filters/formulas/sorting/groups. Existing web views include
Table/Cards/List/Kanban and guarded source-preserving property/config edits.
Normal UI lacks a Create Base action and convenient add/remove-view/formula UI.
Rust task extraction includes checkbox status/text and byte/UTF16 ranges with
entry/revision identity; it has no scheduling fields or aggregate task endpoint.
Current calendar ribbon opens today's daily note, not a calendar screen.

## Delivery sequence

1. Finish Vite defaults and native loading proof; preserve the shared-core and
   editor ownership gates.
2. Bases creation/templates and view management, plus practical record creation
   and formula editing, using existing BaseDocument/source-preserving mechanics.
   Invalid definitions stay editable and saveable; no TS evaluation fallback when
   Rust capability is available.
3. Freeze a small task contract, then implement an inbox, completion/edit actions
   and task-note creation. The optional user question asks checkboxes/task notes/
   both; default proposal is both pending reply. Ordinary Markdown remains the
   authority, with no independent authoritative task database.
4. Calendar month/week/agenda, create/open/schedule/reschedule tasks, and daily-note
   navigation on the same task query/action layer. Start with a usable local
   workflow; keep additional reference capabilities explicitly tracked.
5. Verify actual web/desktop and coordinated native consumers, then continue
   Stage5 device joining/history/backups/management. P2P stays deferred.

## Decisions to settle before task implementation

- Explicit task-note identification, status/completion and priority fields; due
  date versus scheduled interval; all-day dates versus timestamps and timezone.
  Existing notes must not become tasks merely because they contain a due field.
- Inline checkboxes remain at their original source. Aggregate task edits must
  carry entry ID, revision and exact source witness/range; current line-only
  checkbox toggle cannot safely power retained cross-note results unchanged.
- Do not invent an inline scheduling syntax silently. Decide supported syntax
  against existing notes/reference expectations before calendar drag edits.
- Derived task rows/indexes are disposable local data. Source-preserving edits
  retain comments/unknown fields/BOM/line endings; no whole-file parse/reserialize.
  Date-only values remain calendar dates, not timestamps shifted through UTC.
- Keep query/interpretation in shared Rust and presentation in each client.
  Native shells reuse the contract; do not duplicate Markdown/task semantics in
  Swift or put a hidden web workspace behind native navigation.

## Reuse and ownership

Use FullCalendar for web calendar presentation as previously requested. Official
current documentation lists standard Month/TimeGrid/List views and an MIT vanilla
package; premium resource scheduling is a separate product. Select and pin the
actual package/API version at implementation, with notices and asset checks.
Sources: https://fullcalendar.io/docs/vanilla-js and
https://fullcalendar.io/docs/plugin-index . TaskNotes remains a capability reference
for structured properties and planning, not a requirement to copy its whole app:
https://tasknotes.dev/features/ and
https://tasknotes.dev/settings/property-types-reference/ .

Parallel scopes after Vite: Bases UX (`src/bases/**`); shared task extraction/query
contracts and native/WASM/CLI consumers; task actions/UI (`src/tasks/**`); calendar
presentation (`src/calendar/**`); one named workspace/navigation/command integrator.
Native mobile owner keeps Swift/native navigation. Agree contracts before edits;
serialize Rust/WASM/Xcode builds. Reuse the shared query/index lifecycle and
existing lossless editing helpers instead of adding another storage/sync layer.

Earlier requested two-way Google Calendar integration, task Kanban, recurrence and
richer planning remain visible follow-on capabilities. A local calendar alone
must not be called complete reference coverage. Provider credentials/accounts and
external writes need their own concrete setup/authorization at that point.

Verification should target actual user flows, source preservation/stale identity,
completion/date/time behavior and real client use. Avoid a production-scale test
campaign or implementation-mirroring tests. No performance improvement is assumed.
