# Task and calendar implementation contract

Accepted implementation defaults, 2026-10-17. User may refine the workflows;
these defaults permit useful parallel implementation without migrating notes.
Execution remains Vite (complete), Bases/tasks/calendar, then Stage5.

## Source and identity

Markdown is authoritative. Derived task rows/indexes are disposable. A task note
is explicitly identified by the exact `task` member of its frontmatter tags list.
Do not classify other notes merely because they have status or due properties.
Inline tasks come from the existing Rust Markdown checkbox extraction. Both
representations appear; completing a task note does not complete its checklist.
Do not deduplicate by title/text or fabricate files for inline checkboxes.

Task notes use stable entry ID plus expected revision. Inline references include
entry ID, revision, extracted task index and exact source/status ranges; they
are snapshot references, not permanent task IDs. Keep source/path/snapshot
witnesses. A path or frontmatter ID alone never authorizes mutation.

Task-note title is an optional string property, otherwise the filename stem.
Statuses are `open`, `in-progress`, `done`; only exact `done` is completed.
Missing status projects as open with an issue, without rewriting the file.
Unknown strings remain custom states; invalid types remain explicit issues.
Inline checked/completed semantics remain those of the existing Rust parser.

## Time

`due` is a deadline; `scheduled` is when to work. Neither implies the other or
an event duration. Each is absent/null, a valid Gregorian `YYYY-MM-DD` calendar
day, or an explicit-offset RFC3339 instant. Invalid values retain raw source and
an issue. Offset-less timestamps are unsupported rather than machine-local.
Calendar days never become UTC midnight instants or shift with timezone.

Queries use one clock and explicit effective IANA timezone (default UTC), and
return that context. Day deadlines become overdue after that day in the effective
zone; instant deadlines compare to the captured clock. Completed tasks are not
overdue. Wall-time authoring must resolve zone/fold and reject nonexistent time.
Calendar item identity includes the task reference and due/scheduled role.

No inline scheduling syntax is introduced in this slice. Inline checkboxes are
initially unscheduled; UI must make this clear. They do not inherit note dates.
Duration, recurrence, reminders, time tracking, dependencies and two-way Google
Calendar remain visible follow-on requirements in the product plan.

## Queries and actions

Use a bounded Rust query over a retained index generation, not N client metadata
requests or an independent TypeScript interpretation. Provisional hard limits:
page200, scan50000, output8MiB; cursor must bind query and snapshot, cancellation
must release owned state, and truncation/exclusions must not claim complete
coverage. Reuse existing index lifecycle patterns; Index must not depend on Bases.
Agree concrete DTOs before binding native/WASM/CLI and presentation consumers.

Actions reuse shared NoteBuffer, lossless property writers, durable saved witnesses
and CAS. Preserve comments, unknown fields, BOM, line endings and concurrent draft
typing. Inline completion requires exact source/range evidence or a verified mapped
anchor; reject stale rather than guessing from text or line number. Unknown save
outcomes retain recovery state and original operation identity.

## Active owners

| Owner | Isolated branch/worktree | Scope |
| --- | --- | --- |
| streaming_acceptance_sol | tingkai-c/bases-workflow | src/bases workflows/helpers and focused tests; root wires workspace commands |
| stage4_base_reuse | tingkai-c/task-read-model | Rust index task projection/query and fixtures; DTO proposal first |
| stage4_markdown_contracts | read-only | Independent task contract/lifecycle review |
| root | main integration | Manifests, consumer assignments, workspace ownership and actual client acceptance |

Native owner retains Swift navigation/editor viewport and import ownership.
Serialize heavy checks on the 8GB machine. Source implementation and isolated
tests do not establish integrated web/desktop/mobile workflow acceptance.
