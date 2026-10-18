# Calendar portable task projection

Owner: CalendarTaskProjectionOwner, task `task_f8c3a1de7bd1`, dispatch
`ctx_6383ea2ee869`; isolated branch/worktree `managed-calendar-task-projection`.
Base: `a1d9d64f`, granted through `msg_f1f28718656f`; root alone integrates main.
API proposal accepted by coordinator in `msg_2adcbf0c2e08`; native consumer
`term_dd33591a-6916-410e-956b-5cc23e5eba28` and independent reviewer
`term_b64f6f01-b577-46c5-88fe-da33d69d953f` received exact source locations.

## Implemented portable seam

`calendar::select_calendar_tasks` takes the admitted immutable Generation,
same-generation TypeRegistry, optional borrowed CalendarBaseSelection and a
captured CalendarContext. Hosts admit the pin, load/compile the actual saved
Base definition, and supply exact-witness presentation facts and bounded Type
inventory. No caller-selected task IDs replace saved Base evaluation. Exact
view names resolve using the existing BaseProgram method; missing/ambiguous
names error. The existing query_generation evaluator retains root/view filters,
group exclusion, displayed-value AND search, ordering, saved limit, currentEntryId,
ignorePaths and budgets. Context explicitly overrides query clock/timezone.

Only then are selected files projected through the shared task capability mapper
extracted from tasks.rs. Ordered task rows include completed tasks; picker_rows
filters completed rows without altering membership/counts. More than 1,000 selected
tasks produces an explicit budget error. The full Base result, task/Type/metadata
diagnostics and exact witnesses survive; combined encoded output is bounded to
8 MiB. selected_files counts selected Base file rows; selected_tasks counts known
task-capable rows; excluded_non_tasks is the omitted-file difference, qualified
by diagnostics/coverage when classification is unavailable. Standalone selection
has stable path order and the same explicit cap, without querying a truncated
Tasks prefix. Existing query_tasks retains its original filters/sort/truncation.

`resolve_calendar_links` independently resolves at most 64 original EntryIds
against the same generation and pinned Type sources. Completed/outside-selection
tasks remain tasks; missing original IDs stay missing despite path reuse. Visible
manifest absence never claims deletion. Broken/unavailable metadata, invalid or
missing Type knowledge and incomplete coverage cannot assert notTask. Results
retain detailed diagnostics. Hosts attach Type summaries and perform WorkBlock
joins, pin/current-source/collection fencing and membership proof.

## Verification and limits

Exact source commit `cfcdf84d` independently approved in `msg_f06fb80ba56c`;
no blocking source finding. Native consumer `msg_222fa3ece202` requested public
CalendarContext::validate so link-only reads validate context without materializing
tasks or adding dependencies; this visibility-only successor preserves behavior.

Source formatting and git diff --check pass. Six focused tests cover selection
beyond 1,000 unrelated tasks, saved named-view selection/limit, explicit cap,
root/view/group/search/order/this/ignore behavior and selected counts, Toronto
clock/IANA parity with Tasks Today, completed picker versus membership, missing/
renamed/path-reused links, invalid/missing/stale Types, malformed metadata and
missing/ambiguous views/query budgets.

Cargo/build/tests have **not run**: coordinator explicitly holds these while the
native iOS19 heavy turn is active. Source/API is ready for independent review;
compiled verification awaits a bounded load checkpoint. This does not establish
native join, binding, browser, rendered UI, mobile or integrated-main completion.
No manifests, dependencies, managed record schema or other owners' files changed.
