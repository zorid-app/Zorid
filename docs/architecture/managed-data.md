# Managed records, Bases, Tasks and Calendar

[Architecture](README.md) · [Storage](storage.md) · [Sync](sync.md)

## Data model boundaries

For current Bases work, follow the
[implementation goal](../plans/bases-implementation-goal.md). Rich property
definitions (including multiselect/status) and relations/rollups remain in scope
without named note Types. Their persistence and identity contracts are local
decisions within that pass. New copies complete template notes literally.

Bases are declarative file-backed query/view definitions over ordinary files.
Latest direct user decision (2026-10-21) removes named Types, the Type editor and
mandatory schema assignment. Users may add `type: book` as ordinary frontmatter
and filter by it, just as with tags, folders or other properties. Property value
types and editing controls remain; exact property settings are a local Base
contract, not a prerequisite for broader managed data or sync. Existing
Type-dependent task/query code is historical implementation requiring later
reconciliation; this decision does not itself migrate data or rewrite that code.

Note-backed Tasks are derived from/edit ordinary note
content and properties; they are not all independent managed database rows.
Latest user direction (2026-10-20): work blocks, time entries and similar
first-party user content are also note files, with structured properties and
ordinary note bodies/links. SQLite/index rows are derived projections of that
content, not a second authority. Calendar joins query those notes without making
presentation the owner of storage or identity. Exact field schemas and whether
individual entries use separate notes or an embedded representation remain open.

Durable operational records (pending operations, receipts and provider progress),
local recovery, disposable caches and protected secrets remain separate from
user-authored notes. Existing record-backed WorkBlock code is implementation
history, not proof of the new note-backed target; reconciliation belongs in S3.

`zorid-bases` compiles/evaluates host-fed expressions and implements Type/task/
Calendar query semantics. `zorid-records` defines scoped record operations,
conflicts, schemas, tombstones, admission and WorkBlock helpers. It is portable
in-memory semantics; native Store and the browser host perform actual transactions.

TypeScript modules render Base views, Task editing and Calendar interactions.
Backend endpoints, a passing component test and a fully usable composed UI are
separate delivery stages. Desktop Tasks has bounded runtime evidence; production
Base wiring and complete Calendar composition remain unfinished in the execution
records. No mobile/browser feature parity is inferred.

## Query language and performance

The [confirmed query design](indexing-search-design.md) includes Bases compilation,
filters, formulas, sorting and grouping in S1. Keep Bases in a dedicated Rust
language module over shared query/index capabilities. Target documented Obsidian
syntax and results, with explicit compatibility gaps and reviewed deviations.
This does not move new Bases/Tasks/Calendar UI delivery into the optimization stage.

## External integrations

Google integration is a required desktop milestone. Provider OAuth, credential
storage, event mapping, conflict/retry behavior and delivery acceptance are not
established by current Calendar query/WorkBlock code. No implemented Google
provider was found in the source audit. Do not invent its API while documenting
existing systems. Provider secrets must not become ordinary synced records.

## Source map

[Bases/query crate](../../crates/zorid-bases/src/lib.rs),
[managed semantics](../../crates/zorid-records/src/lib.rs),
[native Calendar endpoint](../../crates/zorid-native/src/calendar.rs),
[native WorkBlocks](../../crates/zorid-native/src/workblocks.rs),
[Bases UI](../../src/bases/), [Tasks UI](../../src/tasks/),
[Calendar UI](../../src/calendar/), [detailed feature work](../managed-data/).
