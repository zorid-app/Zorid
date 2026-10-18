# Managed records, Bases, Tasks and Calendar

[Architecture](README.md) · [Storage](storage.md) · [Sync](sync.md)

## Data model boundaries

Bases are declarative file-backed query/view definitions. Types configure typed
properties and capabilities. Note-backed Tasks are derived from/edit ordinary note
content and properties; they are not all independent managed database rows.
Calendar WorkBlocks are first-party structured managed records and can refer to
Tasks. Calendar joins combine these sources without making presentation the owner
of storage or identity.

`zorid-bases` compiles/evaluates host-fed expressions and implements Type/task/
Calendar query semantics. `zorid-records` defines scoped record operations,
conflicts, schemas, tombstones, admission and WorkBlock helpers. It is portable
in-memory semantics; native Store and the browser host perform actual transactions.

TypeScript modules render Base views, Task editing and Calendar interactions.
Backend endpoints, a passing component test and a fully usable composed UI are
separate delivery stages. Desktop Tasks has bounded runtime evidence; production
Base wiring and complete Calendar composition remain unfinished in the execution
records. No mobile/browser feature parity is inferred.

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
