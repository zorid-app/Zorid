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

Coordinator granted focused Rust checkpoint `msg_d4e80f69fd71` after native
Dev19 heavy terminal ended. Exact production source is reviewed `9cdd273e`
(`msg_fb193ee0aa03` extends exact `cfcdf84d` source approval). Command:

```sh
PATH=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin:$PATH \
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 \
CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified \
cargo test --offline --locked -p zorid-bases --test calendar --test tasks -- --test-threads=1
```

First process exited 101: five Calendar cases passed; the large fixture hit
Generation::from_sources' documented 32-entry convenience-import limit before
Calendar evaluation. Replaced only this test helper with ordinary incremental
GenerationBuilder pumps and removed its unused import; no production/API change.
Focused rerun exited **0**, **6/6 Calendar + 11/11 Tasks passed**. Existing 29
expression/files warnings remain outside this scope; no new test warnings.
Persistent logs:

- `/Users/ctk/.local/state/zorid-calendar-task-projection-validation.log` (initial fixture failure)
- `/Users/ctk/.local/state/zorid-calendar-task-projection-validation-rerun.log` (17/17 pass)

Root received terminal slot release immediately in `msg_6704bd5d71d1`; no builds
remain running. No full suite/install/new target was used. Source/API and compiled
focused verification are ready for root integration and native composition.
This does not establish native join, binding, browser, rendered UI, mobile or
integrated-main completion. No manifests, dependencies, managed record schema or
other owners' files changed.
