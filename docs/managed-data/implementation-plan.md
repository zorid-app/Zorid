# Zorid: managed data, Bases, Tasks and Calendar implementation plan

Date: 2026-10-17. Discussion handoff; not an implementation-completion report.

Scope amendment (2026-10-18 03:17 UTC / 2026-10-17 America/Toronto):
the user explicitly removed spaced repetition from this implementation goal.
Do not build it or retain it as a required/deferred acceptance milestone.
Other phases remain required.

## Start here

Implement a first-party local-first experience spanning desktop and native mobile, backed by one Rust data core. Features use managed storage for both synced and non-synced data. They must not implement their own Zorid sync engines. External-provider integrations still supply provider-specific behavior.

Read current AGENTS.md, docs/deferred-product-roadmap.md and docs/user-findings.md before starting. This document consolidates this discussion; it does not replace the active core roadmap or authorize interfering with existing work. Reconcile newer repository decisions before implementation.

The shared-core coordinator owns integration into main. Work in isolated branches/worktrees and submit coherent reviewed batches with affected paths and evidence. Do not mutate main, push concurrently, or stash/reset/commit another session's changes. Coordinate existing editor/platform/bridge seams. Parallelize independent implementation and review; serialize actual heavy resource use. iOS builds/simulator verification require coordinated slots under current project instructions. Follow the standing disposable-development-device permissions. Close owned test Electron apps after passes; retain the designated simulator as instructed.

The user explicitly requests desktop AND native mobile UI delivery stages. Backend fixtures alone do not complete this plan. Exact Obsidian parity is superseded by best Zorid UX. Calendar/task discussion is now explicitly opened; execution must be coordinated with the active building session.

## Settled product direction

1. Bases select note records and contain multiple YAML-defined views. Share one vault-wide index; an unfiltered Base selects all indexed note records. Type/folder/property predicates narrow membership. Index exclusions are distinct from query filters.
2. Creation defaults are separate from selection: destination folder, note type and inferred properties. A newly created item should remain visible where possible; complex filters must not silently invent values.
3. Note types define fields/defaults/options. Built-in datatypes supply behavior. Status has semantic categories not_started, working, done, with configurable options within them. Select/multi-select options use stable IDs and mutable labels.
4. Tasks are a capability enabled on a note type, not a reserved `_task_` type name. Ship a useful Task type. Multiple Bases can use it; custom Assignment/Bug types may enable task behavior through explicit mappings. Do not require multiple task types merely to separate personal/work collections.
5. Markdown checkboxes and task notes are completely separate. Add an explicit command to convert the checkbox at the cursor into a task note. Do not index every checkbox as a global task automatically.
6. Tasks and Calendar are built-in destinations. Their reusable list/calendar views also work inside Bases. Native task lists are generic native lists with grouping/sorting/visible-property/inline-edit capabilities.
7. A task is work to complete; an event is a time commitment; a work block reserves time and may link zero, one or several tasks; time entries record actual work. A task may occupy several blocks. A block ending does not complete its tasks or change their deadlines.
8. Two-way external calendar integration is required, Google first. External sources can be displayed in any Base calendar view and the built-in Calendar.
9. Connections and fetched external events are centrally managed. Multiple views query the same store and subscribe to changes; they do not each run independent fetch loops.
10. Base publishing settings choose destination calendar and field mappings. A view's display-source selection is independent of publishing/importing records. Displaying an external event does not automatically create a note.
11. Desktop calendar uses FullCalendar. iOS calendar is native, visually and interactively informed by Apple Calendar: month/event grid, day and multi-day timelines, week strip, all-day lane, overlapping cards, current-time line, Today/search/add/source controls and native translucent controls. Rich note bodies retain the shared web editor.
12. Use a managed structured-record platform backed by SQL where appropriate. The final choice supersedes the interim recommendation to make all plugin state file-based. Notes/attachments remain files; structured records need not have corresponding files.
13. Synced/local/cache data all use host APIs. Secrets use a separate protected service. Features do not own arbitrary SQLite replication.
14. Removed by direct user instruction on 2026-10-17: spaced repetition is outside this implementation scope.

## Current evidence and constraints

Read-only source checks in this discussion observed:
- crates/zorid-crdt depends on Yrs 0.28.0. TextReplica validates plain text and rejects maps/rich values; structured-record CRDT support is NOT already integrated.
- zorid-store uses SQLite/rusqlite with transactions, operation/outbox structures and core-owned schema. Unknown plugin tables cannot simply be inserted into that schema.
- checkpoints.rs has local CAS, explicitly separate from the sync outbox. It is not a distributed lease.
- relay.proto exposes Hello, Append and Pull; generic distributed coordination is not present in that inspected API.
- src/plugins/plugin.ts exposes whole-value loadData/saveData hooks. It does not implement the proposed collections/permissions/migration/secret contract.
- Existing encrypted file transport and persistence are reusable foundations, not proof of generic structured-record sync.
- Last parent checkout observed during plan preparation: 31b69e2d. Recheck current HEAD and queued batches; source may advance.

Do not report new APIs, calendar behavior, native UI or managed-record migrations as implemented from this plan. No new performance benchmarks or runtime integration tests were run for the tool evaluation.

## Architecture

Clients (Electron/web, native iOS, later other native clients, CLI)
  -> host-scoped data API
  -> shared Rust validation, persistence, queries, recurrence, records and sync
  -> native SQL / existing supported browser storage adapter
  -> encrypted transport and generic coordination backend

Provider adapters run on eligible devices and access secrets through the host. The server remains unaware of calendar/task/plugin payload meanings. Coordination metadata may be visible, explicitly documented.

### Authority rules

| Data | Authority |
|---|---|
| Note title/body/properties | Markdown/file model; SQL is derived projection |
| Attachments | File/blob model |
| Types and Bases | Vault configuration files (YAML proposed); parsed indexes derived |
| Work blocks and time entries | Managed structured records |
| Recurrence occurrence state | Managed structured records linked to task IDs |
| External event mirror | Provider-derived state, subject to pending local edits |
| External IDs, pending mutations, receipts | Durable operational records, never disposable cache |
| UI preferences | Explicit synced or local policy |
| Secrets | Protected secret store, device-local initially |

Native SQL is an implementation detail. Do not introduce a second SQL-WASM database automatically if the existing browser persistence adapter can serve the logical contract. Cross-adapter semantics must match.

### Managed collections contract

- Host assigns namespace from trusted installed feature/plugin identity; plugins declare collections, not arbitrary owner prefixes or filesystem locations.
- Schema declares stable collection/field IDs, types, defaults, version, persistence (synced/local/cache), scope, bounded indexes and supported conflict policies.
- API offers CRUD, field patches, explicit set operations, bounded queries, transactions, subscriptions and export. Exact API syntax remains to be designed.
- Commit means durable LOCAL success. Sync acknowledgement and pending/conflict/error states are separately observable.
- Record change and outgoing sync work are committed atomically. Incoming durable application and progress checkpoints must have equivalent crash-safe boundaries.
- Preserve unknown fields and reject incompatible writes. Plugin authors must not silently replace entire newer records.
- Synced changes use existing E2EE transport through a deliberate new payload/family contract; do not bypass existing validation limits.
- SQL indexes are core-owned and rebuildable. Do not promise arbitrary SQL, ORM inheritance, or globally serializable offline transactions.
- Invariants across fields may require atomic values (e.g. start/end/timezone together). Relationships use stable IDs, not paths.
- Namespace scoping is not a sandbox by itself. Define trusted vs isolated plugin execution and enforce capabilities at the host boundary.
- User data remains inspectable/exportable without the originating plugin. Disable, disconnect, uninstall and delete-data are separate actions.

### Versions and migration

Keep plugin release version, collection schema version, record causal revision and wire-protocol version separate. Record versions may differ temporarily within a collection.

Support additive optional fields, index changes and label changes first. Stable field IDs avoid migrations for label renaming. Destructive/type-changing transformations require explicit plans, backups/recovery and compatibility rules.

A phone may edit version-1 data offline after desktop migrated to version 2. On receipt, safely translate supported operations or retain an unresolved change; never discard it silently. Blocking future writes after download alone is insufficient.

Migration transformations must be deterministic and side-effect-free, but this alone does not prevent duplicate concurrent CRDT migrations. Design deterministic migration identities/operations or coordinated upgrades, and test mixed-version concurrent edits. Avoid arbitrary plugin migration execution in v1. Local DB layout migrations are distinct from synced semantic migrations.

### Secrets

Separate secret handles from ordinary records. Initially device-local; use platform credential facilities, with an explicit supported browser policy. Never silently fall back to plaintext synced values. Synced connection records refer to secrets by handle; another device can report authorization required. Define grant/revocation, plugin-update provenance, uninstall handling and log redaction. Cross-device credential sharing remains a separate decision.

### Generic coordination and jobs

Extend the existing backend with authenticated generic conditional writes/leases, not Google-specific tables or routes. Resources have opaque scoped IDs, revision, owner, server-clock expiry, fencing generation and encrypted payload or checkpoint reference.

Acquire must be atomic. Renew/release/conditional commit check current ownership and generation. Include unique atomic creation. Bound lease duration, payload size and retries. If a result references uploaded encrypted blobs, commit the reference atomically after blob durability; do not invent cross-record atomicity.

Device execution sequence:
1. Save local data and stable pending operation ID atomically.
2. Upload through ordinary encrypted sync.
3. Acquire lease for the connection/resource.
4. Catch up through a defined relay boundary and read current committed checkpoint AFTER acquiring.
5. Fetch provider changes, reconcile, publish retry-safe operations.
6. Durably commit encrypted results/checkpoint under the lease, acknowledge operations and release.

Lease metadata should not contain calendar names, emails or plugin payloads. Ordinary edits remain possible without the lease. Offline publishing waits if the coordination service is unavailable. All eligible apps closed means device-side integration waits.

Fencing protects our server commits, NOT already-sent Google requests. Stable external identities, provider version checks and reconciliation are still required. Do not claim exactly-once external effects. A worker losing ownership stops initiating work and treats in-flight outcomes as uncertain.

Core job runner owns queue persistence, backoff, cancellation, resume and status. Handler versions and credential availability determine device eligibility. External handlers own provider-specific mappings and idempotency logic. Design this from calendar needs before freezing a general plugin API.

## Calendar model and connector

### Central connection and mirror

Use stable account/calendar/event/recurrence-instance identities. Keep selected display sources per view, reusable built-in calendar setups, and Base publishing rules separate.

The shared event store should record coverage ranges, last refresh/error and provider checkpoints. Recurrence masters/exceptions must not be confused with expanded display instances. Expand only bounded visible ranges. Explicitly distinguish absence outside fetched coverage from deletion.

Do not call all fetched data disposable: pending edits, mappings and cancellation/deletion information required for reconciliation must survive cache eviction. One possibility is a durable synced provider mirror plus device-local expanded occurrence caches; finalize the policy before implementation to avoid independent-device sync-token/cache inconsistencies.

Refresh on eligible foreground/reconnect, periodic active execution and manual request. Coalesce view demands and avoid per-view fetch loops. Do not promise fixed iOS background intervals. Push-triggered refresh is optional later work, not a prerequisite.

### Google two-way rules

- OAuth account selection, least required permissions, selected calendars and explicit writable/read-only behavior.
- Event-note publishing maps title, description, start/date, end/duration and optionally timezone. Decide range/default-duration behavior in setup.
- Work-block publishing creates one event per block, even when several tasks are linked. Task notes/deadlines are not automatically exported. Description disclosure is explicit.
- Moving a Google event linked to a work block changes the reservation, not task deadlines.
- Deleting a published reservation preserves tasks. Define delete-vs-local-edit recovery and user undo.
- Incoming events display without automatically becoming notes; import-to-note is an explicit policy/action.
- Overlapping Bases must not create duplicate exports unintentionally. Define connection mapping ownership and explicit multiple-destination publishing.
- Use incremental sync, pagination and expired-token recovery. Preserve pending operations during resync.
- Use event identity and conditional updates/ETags; merge independent field changes, surface genuine scheduling conflicts, preserve provider fields Zorid does not own.
- Explicitly model timezone, date-only/all-day values, DST, series and occurrence exceptions, calendar permissions and attendee notification behavior.
- Device-side Google access is the starting proposal; credential enrollment on each eligible device is required unless a separately approved sharing mechanism is built.

## User interfaces

### Types, Bases and generic lists

Provide simple presets (Blank, Tasks, from folder, custom type), readable filter controls, type editor, status/multi-select configuration, creation defaults and saved views. YAML and UI edit one configuration, preserving unknown supported data.

Lists support grouping, sorting, visible properties, inline edits and status controls. A three-state status indicator is distinct from a boolean checkbox; custom statuses get a picker and explicit accessible names. Decide multi-select grouping duplicates/counting behavior.

Base calendar configuration includes external-source toggles even if publishing is disabled. Base connection settings manage mappings without controlling all other views' visibility.

### Desktop UI stage

Build the usable Electron/web experience: Bases configuration/editor, Tasks destination, Calendar source/setup picker, FullCalendar month/day/week/agenda, unscheduled task panel, drag-to-block, resizing, multi-task block details, event/task sheets, recurrence editor, timers/time-entry corrections, connection wizard, sync errors/conflicts and pending-state badges. Rich details open the shared editor. Include keyboard commands, context menus, undo and narrow split-pane behavior.

### Native iOS UI stage

User specifically wants the Apple Calendar appearance/interaction family. Implement native SwiftUI/UIKit UI; FullCalendar stays desktop/web. Apple Calendar's full UI is not available as an embeddable component. UICalendarView is not by itself the required event timeline. Evaluate a native library versus custom layout based on requirements, not branding.

Required surfaces: vertically scrolling month weeks with event cards; day/multi-day timeline; compact week strip; all-day area; overlapping timed cards; now indicator; source-colored cards; Today/search/add/view controls; native task/event/detail sheets and source selection. Provide readable layouts and accessible controls, not just screenshot matching.

Gestures: day navigation, scrolling, long-press creation, move/resize, task scheduling, cancellation and explicit alternatives for accessibility. Keep frame-by-frame drag preview native; send semantic commands to Rust on commit. Respect safe areas, large text, light/dark modes and reduce-transparency/motion settings. Load/query only required ranges and reuse native views.

Use native property controls and the shared web editor only for rich note bodies. EventKit device-calendar access is optional and separate from Google integration; avoid duplicate sources if later enabled. Android native calendar design/library selection remains open and must be tracked, not silently claimed complete.

### Screenshot privacy

User supplied Apple Calendar screenshots as private visual references. They show month, two-day and day layouts with personal entries. Do not commit these screenshots, transcribe their private event content into fixtures, or publish them. Use synthetic schedules for tests and shareable artifacts. Local reference paths, if still available: IMG_1750.PNG, IMG_1749.PNG, IMG_1748.PNG under the user's Downloads; the conversation also includes the images. References may not survive handoff, so rely on the layout requirements above.

## Implementation sequence and acceptance

### Phase 0 — Coordinate and settle bounded contracts

Owner: core coordinator plus feature/native leads. Re-read current code and roadmap, assign owned paths, inventory reusable primitives. Decide collection authority, browser adapter, task-property mapping, record/occurrence IDs and provisional schema/merge policies. Record decisions rather than freeze an expansive public API. Establish synthetic fixtures and measurable UI/performance scenarios.

Exit: agreed contracts and file ownership, explicit open decisions, no incompatible parallel changes to shared seams.

### Phase 1 — Managed records vertical slice

Implement one internal collection end-to-end: scoped schemas, local/synced/cache policies, stable IDs, patches, validation, durable write+outbox, encryption, incoming changes and subscriptions. Add core-owned SQL/index projection and equivalent browser persistence behavior. Evaluate Yrs structured types against required semantics; do not weaken the existing text validator. No automatic adoption of a second sync engine.

Exit: two replicas offline-edit different fields and converge; same-field and deletion policies exercised; crash/retry cases preserve data; local/cache never leak into sync; restart and unknown-field preservation work. No UI completion claim.

### Phase 2 — Versions, migrations, security and coordination

Parallel owned tracks: schema compatibility/migration; scoped access and secrets; generic CAS/leases and durable jobs. Add resource limits, export/recovery and observable errors. Test migration-vs-offline-write, concurrent migration, lease race/expiry/stale owner, crash-after-provider-success simulation and duplicate retries. Do not conflate local transaction atomicity with global offline consistency.

Exit: reusable internal data contracts proven and credential handling usable on target devices; exact unsupported cases documented.

### Phase 3 — Types, Bases and task domain

Build type definitions/capabilities, status/multi-select, shared query/index integration, Base YAML multiple views, presets and creation defaults. Implement task commands, checkbox conversion, recurrence/occurrence history, planned day/deadline separation and work-block/time-entry records. Implement bounded calendar occurrence queries. Define operational behavior without a general automation engine.

Exit: same task updates through multiple views without duplicate recurrence; note authority preserved; multi-task blocks and multiple blocks/task work; date-only/DST/recurrence exceptions tested. Checkbox conversion is undoable and preserves user content according to the agreed rule.

### Phase 4 — Usable desktop UI vertical slice

Build the desktop surfaces described above against real core data. Begin with local tasks/calendar to make the product usable before provider work finishes. In parallel, native team can prototype layouts using agreed DTOs and synthetic fixtures, without inventing separate data logic.

Exit: user can create a typed collection/Base, add task, change status, schedule/move/resize block, select sources, navigate views and reopen with persisted state. Native Electron visual and interaction verification, keyboard/accessibility checks and narrow-pane behavior. Close owned Electron after verification.

### Phase 5 — Central external calendars and Google two-way

Implement account connection, shared provider mirror, refresh coalescing, coverage/freshness, view source toggles, Base mappings, inbound/outbound operations and lease-based multi-device execution. Integrate auth/pending/conflict/disconnect UI. Use controlled test calendars and explicit provider test credentials; do not touch real calendars without appropriate authorization.

Exit: two devices edit/publish without duplicate events; Google edits import; failed writes retry after restart; expired sync token recovers without losing pending edits; one view's toggle doesn't affect other views; multiple open views don't cause independent fetch loops; deletion preserves linked tasks.

### Phase 6 — Native iOS UI implementation and verification

Deliver actual native generic task lists, Apple-Calendar-style month/day/multi-day screens, native details, sources and connection/settings flows connected to Rust. Keep event layout/gestures native and rich editor embedded. Coordinate Xcode/simulator slots. Verify physical development device under existing authorization and the designated simulator.

Exit: complete task capture -> schedule -> edit -> complete flow; external-source display and two-way edits; offline/pending/reconnect; drag cancellation, overlap, DST/all-day, typography, keyboard/sheets and accessibility. Measure scrolling, range-load latency and memory with representative synthetic schedules. Agree budgets on actual hardware; no invented performance numbers. Document Android follow-up scope.

### Phase 7 — Removed from scope

Spaced repetition was explicitly removed by the user on 2026-10-17. No study UI,
scheduling algorithm, flashcard history implementation or acceptance workload is
required. The phase number is retained only to keep existing handoff references
stable; it is not a deferred obligation.

### Phase 8 — Public plugin API and release integration

Extract the proven first-party APIs into versioned plugin contracts. Document schema policies, namespace identity, export/uninstall, grants, secrets, jobs, subscription lifecycle and migration limits. Provide one small example plugin and compatibility fixtures. Integrate coherent batches through the sole integrator; verify the combined app rather than relying only on isolated fixtures.

Exit: an example plugin stores synced/local/cache data without writing sync code; cannot cross namespaces through the API; older-version behavior works as specified; first-party features use the same storage contract. No assertion that unrestricted trusted plugins are sandboxed.

## Parallel work allocation

- Core record/persistence owner: Phase 1 and durable transaction boundaries.
- Schema/version owner: migration compatibility and independent review.
- Coordination owner: generic backend primitive and job runner, after protocol ownership approval.
- Secrets/platform owner: credential adapters and grants, coordinated with native lead.
- Types/Bases/task owner: domain/query and configuration, editor seams explicitly assigned.
- Desktop UI owner: Phase 4 then provider UX.
- Native UI owner: layout research/prototype early; real Phase 6 integration after stable commands/queries.
- Provider owner: Google mapping/cache and retry behavior after identity contracts.
- Independent reviewer: data loss/concurrency/authority boundaries; integration evidence.

Use as many agents as genuinely independent work permits. Do not maximize worker count at the expense of overlapping file edits or running multiple heavy suites on the 8 GB machine.

## Open decisions requiring explicit resolution

1. Exact managed-record schema syntax, wire format, merge policies and transaction scope.
2. How synced migration operations handle older offline edits; no arbitrary callbacks assumed safe.
3. Single note type vs future multiple types/inheritance; simplest initial assumption is one type with capabilities.
4. Task status transition UI, Today/Inbox semantics and checkbox conversion replacement/content rules.
5. Recurrence representation, completion-based scheduling, occurrence identity and series edit UX.
6. Google import-to-note policy, Base duplicate mapping ownership, attendee notifications and record-delete behavior.
7. Provider mirror durability/sync scope, token/checkpoint handoff and range coverage strategy.
8. Device authorization and browser secret policy; cross-device secret sharing is not approved implicitly.
9. Native calendar component selection, iPhone/iPad modes and Android follow-up.
10. Time tracking allocation across multi-task blocks and interrupted timers.
11. Permission/runtime model for untrusted plugins, stable publisher identity and update grants.

## Reuse evaluation and sources

Retain Rust/SQLite/encrypted relay. Existing Yrs is the first structured-merge candidate, subject to tests; its text wrapper is not a ready-made record store. RxDB provides useful schema/query/migration API ideas but adds a JS authority and replication system. PowerSync's source-database distribution model is not a drop-in opaque E2EE relay. Automerge/Loro are credible merge engines, not complete answers to migrations/secrets/plugin access. Revisit only if a concrete workload demonstrates a gap.

- RxDB replication: https://rxdb.info/replication.html
- RxDB schema migrations: https://rxdb.info/migration-schema.html
- RxDB SQLite (production storage is Premium): https://rxdb.info/rx-storage-sqlite.html
- PowerSync architecture: https://docs.powersync.com/architecture/architecture-overview
- Automerge modeling/migrations: https://automerge.org/docs/cookbook/modeling-data/
- Loro: https://www.loro.dev/docs
- Yrs: https://docs.rs/yrs/latest/yrs/
- TaskNotes reference: https://github.com/callumalpass/tasknotes
- TaskNotes Google provider: src/services/GoogleCalendarService.ts in that repository
- TaskNotes task export: src/services/TaskCalendarSyncService.ts in that repository
- Google incremental sync: https://developers.google.com/workspace/calendar/api/guides/sync
- Google conditional writes: https://developers.google.com/workspace/calendar/api/guides/version-resources
- Apple UICalendarView: https://developer.apple.com/documentation/uikit/uicalendarview
- Apple EventKitUI: https://developer.apple.com/documentation/eventkitui

TaskNotes code was inspected as a reference, not copied or runtime-verified. Its external calendar access and task-to-event export must not be assumed to provide unrestricted reverse task-property sync. Any future reuse requires source commit provenance and license preservation. Keep recovered proprietary artifacts and personal screenshots/notes out of project source.

## Suggested opening instruction for the new session

Read this plan plus current AGENTS.md and the roadmap execution checkpoint. Coordinate with the sole main integrator. Reconcile current code and queued changes, then begin Phase 0 and the managed-record vertical slice in isolated worktrees. Keep desktop and native iOS UI as explicit delivery milestones. Resolve consequential open semantics before dependent implementation; make routine implementation choices autonomously. Maintain durable ownership/commit/verification tracking, parallelize independent work, and report implemented vs integrated vs runtime-verified status separately.
