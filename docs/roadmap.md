# Product roadmap

Updated 2026-10-26. This is the maintained delivery order and scope register for
Zorid. The [architecture manual](architecture/README.md) explains system design;
the [execution checkpoint](deferred-product-roadmap.md) records owners, branches
and evidence; [user findings](user-findings.md) records incoming bugs/requests.
Older plans remain detailed capability inventories, not competing delivery orders.

Latest user scope freeze: finish the **basic local create/edit/filter/delete/
restore/restart** experience, including the already-coded truthful deleted-source
Trash card and working Change source. Complete only the current implemented
UI/controller seam and focused verification, then clean handoff/integration.
No further exploratory or secondary edge-case work, broader acceptance gates or
matrix expansion. Retain untested variants as honest limits without blocking a
bounded basic-delivery claim. [Tracker P009](plans/types-properties-implementation.md#p009--2026-10-27--deleted-source-core-flow-verified)
records local_ui + view_source_model ownership and combined-review dependency.

## Current focus

Frozen basic local scope is now **verified; main integration pending**. Final
code `05b73d5a08dc7c9a083041071d376b54020a71f9`/product `262939e6` and controller
successors are independently reviewed, zero must-fix; root 99/99 targeted/full TS/
native frontend006 PASS. Final normal source Electron 70282 verifies truthful
Trash card, card Restore and working Change source to untyped; restoring the old
collection preserves exact 3 identities/values/full bytes without changing that
selected untyped source. Normal quit exit 0, all owned test apps closed.

[Final tracker/handoff](plans/types-properties-implementation.md#p009--2026-10-27--deleted-source-core-flow-verified)
retains earlier CLI/native/browser passes and failures, exact artifact receipts
and limits. Main unchanged c36c4b0e; root will commit clean docs/evidence and make
an explicit integration request to its sole owner. Review/isolated verification
is not a main merge. No installed production-package or broad platform acceptance
claim. Untested secondary variants remain limits, not blockers to the frozen basic
scope. Browser collections/scoped previews unavailable. No Tauri or new sync work.

### Latest local collection design steering — 2026-10-27

The user now chooses local collections with internal Types and independently
sourced Base views, superseding the older no-named-Types product direction below.
Each view selects one collection/type or untyped notes; untyped views only browse
notes and do not expose property grids. The special Properties.yaml registry is
to be retired. Collection import and cross-collection moves are excluded.

The user subsequently resumed local implementation with **"ok start"** on
2026-10-27. The [tracker's P001 receipt](plans/types-properties-implementation.md#p001--2026-10-27--local-implementation-resumed-underway)
records active owners, contracts and actual source checks. This is implementation
in progress, not acceptance of the new feature or a change to the recorded
acceptance scope of shipped Bases. The [design decisions](design/types-properties-sync-discussion.md)
and [implementation tracker](plans/types-properties-implementation.md) record
local contracts, edge cases, owners, batches and separate verification gates.
Earlier broad sync-first or no-Types language is historical where it conflicts
with this later steering. Tasks/Calendar/provider/mobile expansion stays deferred.

**S0, S0A and S1 are accepted within their recorded scopes.** On2026-10-20,
the user deferred further performance optimization/stress budgets and requested
ordinary functional acceptance. Matching macOS Electron, actual web and standalone
CLI checks pass; the browser startup and rename/save failures found during this
closeout are fixed, reviewed and verified in the app. See the execution checkpoint
for exact source, results and limits. **Local S4 Bases is delivered within the recorded desktop scope.**
The [Bases closeout](history/bases-desktop-closeout-20261026.md) records staged
heavy-user acceptance and remaining coverage limits. Existing iOS work is
preserved; no task/calendar, sync or mobile milestone is opened by this closeout.

Direct user steering (2026-10-21) defers the broader managed-data/Tasks/Calendar
work and prioritizes Bases now. File-backed query/view configuration
and note property editing do not depend on synced structured records. Settle
only their concrete local contracts within S4; broader S3 remains planned.
See [Obsidian mental-model findings](reference/bases-mental-model.md).

Historical 2026-10-21 decision (superseded for the new collection design):
remove the named Types feature, rather than defer it. Bases select ordinary files using tags, folders and property filters. Users
may write `type: book` like any other frontmatter property. Property value types
(text, number, date, checkbox, etc.) remain necessary; they are not named Types.
No implicit collection or schema ownership follows from a property called `type`.

Design for desktop, browser and mobile now; finish the usable desktop feature set
and establish solid sync before resuming native mobile implementation. The browser is a connected sync-group client
with retained local working data, rather than a user-managed filesystem vault.
Do not reopen all tracks in parallel.

Current verification targets are **macOS Electron, web, and the standalone CLI on
macOS**. Exercise the CLI as an independent client, including shared-vault access
with Electron; it is not only a test harness. Windows, Linux, iOS and Android
runtime verification is deferred. Keep the shared-core design portable without
claiming those platforms have passed.

## How a milestone advances

One product milestone is in implementation at a time. Within it, parallel workers
may own independent bounded pieces or reviews; one coordinator owns shared seams
and integration. Reuse workers and close settled temporary workspaces. Dependency
research may proceed, but future feature implementation waits for its gate.

Each milestone gets a short execution entry with owner, isolated branch, scope,
blocked dependencies, exact integrated commit, actual scenario results and remaining
gaps. Use these states: **planned → implementing → verifying → accepted**. A blocked
milestone names its prerequisite; a source-approved component is not an accepted
product milestone. Acceptance is an engineering checkpoint, not a new permission
prompt for every routine action.

Advance only after the integrated app demonstrates the exit scenario, required
focused checks pass, independent review resolves material findings, and the
coordinator records the evidence. Test the changed storage/data-loss/security
boundaries; avoid repeated full campaigns and tests that merely mirror code.
No invented performance numbers or claim of universal correctness. New findings
that invalidate a closed gate reopen that bounded gate, not every earlier milestone.

## Delivery order

S0 is **accepted** within its explicit scope/limitations; S0A is **accepted** as a
contract gate. S1 is **accepted for bounded ordinary functionality**; further
performance work is deferred by the user. Later milestones remain **planned**.

| ID | Milestone | Prerequisite |
| --- | --- | --- |
| S0 | Storage layer, saving and local recovery — immediate priority | Current source/retained-artifact inventory |
| S0A | Modular interfaces and feature-consumer contract review | S0; storage contract design starts within S0 |
| S1 | Rust parsing, indexing, caching and search performance | S0A |
| S4 | Local desktop Bases delivered within recorded scope | S1; bounded local Base/property contracts |
| S3 | Managed-data services and feature contracts — deferred until after S4 | S1 |
| S5 | Fully usable desktop Tasks | S4 and relevant S3 contracts |
| S6 | Fully usable desktop Calendar and planning | S5 |
| S7 | Google Calendar two-way integration | S6; provider job/credential decisions |
| S8 | Complete desktop experience and distribution gate | S0, S0A, S1, S3–S7 |
| S1A | E2EE sync-group lifecycle design — discussion deferred | S8 |
| S2 | Shared E2EE sync backend and usable self-hosted native-client sync | S1A |
| S9 | Hosted Zorid Cloud service | S2 and S8 |
| S10 | Connected web client at web.zorid.app | S9; self-hosted service from S2 |
| S11 | Native iOS app | S8 and S2; hosted/web completion is not a hard prerequisite |
| S12 | Complete history, backup/recovery and administration | S11; basic operational backup already required in S2/S9 |

Latest user steering places usable local desktop Bases/Tasks/Calendar and
Google integration before Zorid sync. Stable IDs and storage boundaries remain
sync-ready; remote transport is not a prerequisite for local feature acceptance.
Existing stage IDs are retained for links; table and section order define delivery
order. Reconcile each stage with current main and retained isolated changes first.
Google-specific authorization is distinct from logging into Zorid sync.
User steering on 2026-10-20 keeps native mobile development paused until desktop
and sync are solid: S8 and S2 are prerequisites for S11. S9/S10 before S11 remains
a proposed scheduling order, not an additional hosted/web requirement.

## S0 — Storage layer, saving and local recovery

**Current:** native Store/SQLite authority, physical projection journals and local
checkpoints exist. Browser uses IndexedDB. The first reviewed S0 batch adds shared
SQLite connection policy, separate app-local recovery snapshots, automatic opening
recovery and settled backup retirement. The second batch, integrated as `eb6d6bb2`, separates native disposable document
caches into app-local `cache.sqlite` and adds entry-scoped version preview/restore.
Clipboard images, native dirty-window close, live-window normal AppKit quit, history
restoration and restart have passed scoped actual Electron checks. Main `0bbeb61b`
adds reviewed superseded-move recovery, definite conflict handling and normal
no-window quit. The final actual lifecycle42 and concurrent-CLI/interruption6
checks pass. S0's native delivery gate is accepted; this does not establish browser
history, power-loss, foreground traffic-light or other-platform parity. The original
real-vault warning's historical cause remains unconfirmed and that vault untouched.

Scope:

- [x] Inventory current transaction boundaries, save state and pending/settled
  `.previous`/`.namespace` artifacts before changing their lifecycle.
- [x] Review storage service contracts against existing feature needs before
  implementing the SQLite layer; carry unresolved cross-system seams into S0A.
- [x] Introduce shared Rust SQLite infrastructure for native connections,
  configuration, transactions, schemas, errors/locking and diagnostics. Keep
  domain operations in services; no arbitrary frontend SQL API.
- [x] Keep native authoritative state in vault `.zorid/vault.sqlite`. Define stable
  local vault identity and app-data path resolution shared with the independent
  CLI; handle moved/copied vaults and identically named vaults explicitly.
- [x] Separate app-local per-vault `cache.sqlite` (rebuildable) and
  `recovery.sqlite` (retained history) without breaking authoritative transactions.
- [x] Deliver the agreed autosave/File Recovery behavior: coalesced
  roughly two-second saves, blur/close/graceful-quit flush, five-minute snapshots,
  seven-day expiry, unchanged-content dedupe, best-effort failed-save capture and
  manual preview/restore. Do not promise every unsaved keystroke survives a crash.
- [x] Stop accumulating per-save backups; reconcile current Rust DB/file authority,
  external-writer handling and safe artifact cleanup before save-strategy cutover.
- [x] Reproduce and fix the superseded captured-move recovery failure identified
  from read-only candidate metadata; normal fixture operation settles automatically.
  The original screenshot's historical cause remains unconfirmed. Real unresolved
  recovery stays actionable; unknown evidence is preserved rather than hidden.
- [x] Specify browser service/storage interfaces for connected working state.
  Persistent browser SQLite/OPFS is optional and does not block native S0 delivery.

Completed checks refer to the bounded implementation and evidence recorded in
[the execution checkpoint](deferred-product-roadmap.md), not acceptance of the
whole milestone. Vault moves currently start a new local-history bucket; aliases
share a bucket and copies remain separate. Settled backup retirement never sweeps
unresolved namespace evidence. The [browser contract](architecture/browser-storage-contract.md)
maps current IndexedDB services; connected onboarding and attachment eviction
remain later browser work. Autosave/history behavior is implemented and scoped
checks and actual no-window/live-window quit gates pass. S0A completes the
cross-feature interface audit before live S1 optimization. Existing large-stream
performance checks remain incomplete and move to S1 measurement, not a stress pass.

**Exit:** actual desktop create/edit/save/reopen/restart works through the new
layer; meaningful interruption, external-change and CLI/application-concurrency
cases preserve work and report uncertainty correctly. Repeated successful saves
stop unbounded `.previous` accumulation. A retained snapshot restores correctly;
expiry/dedupe work; clearing/rebuilding cache does not damage source or history.
Normal scans settle without a persistent false warning. Record exact limitations;
never bulk-delete unresolved artifacts or real vault data to make a test pass.

Design: [storage](architecture/storage.md), [SQLite](architecture/sqlite.md),
[saving/recovery](architecture/saving-recovery.md).

## S0A — Modular interfaces and feature-consumer contracts

**Status:** accepted as a contract review, with implementation gaps explicitly
assigned to their owning stages. The reviewed operation/consumer inventory and
runtime requirements are recorded in the review guide; main `d102dbe2` closes the
direct browser binary-helper FIFO seam (50 focused main checks and TypeScript
pass). Representative S0 consumer evidence and independent review are recorded
in the execution checkpoint. This is not browser/mobile runtime acceptance. Storage
contract review begins during S0 design so we do not build the wrong layer first.
S0A then checks storage, indexing and caching together against actual consumers
before S1 changes internals or downstream feature work resumes. Existing milestone
IDs stay stable.

- [x] Inventory current Rust service contracts, TypeScript platform capabilities,
  host/WASM/mobile bindings and consumers. Reuse working interfaces; identify
  concrete gaps rather than inventing a general framework.
- [x] Build a supported-operation matrix covering files/attachments, managed records,
  retained recovery, disposable caches, parse/index/search and relationships. Map
  Bases/Tasks/Calendar, editor, sync and independent CLI needs to owning services.
- [x] Specify inputs/results, identity/revision/scope, transaction boundaries,
  local-commit versus publication/sync status, subscriptions, pagination/limits,
  cancellation, release and error/uncertain-retry behavior.
- [x] Check indexing snapshots, incremental updates, source/version fences, query
  pins and rebuild/progress APIs; features must not read private index tables.
- [x] Check cache keys/versioning, hit/miss/stale/error behavior, invalidation,
  eviction/budgets and rebuild APIs. Pending edits, provider receipts and recovery
  history must never be routed through disposable-cache deletion.
- [x] Review native durable-vault and browser connected-working-state differences.
  Shared services do not require identical persistence guarantees. Document missing
  capabilities explicitly rather than silently falling back to another authority.
- [x] Prove representative consumer flows through the service boundary; add focused
  behavior/contract checks only for meaningful boundaries. Resolve incompatible
  seams and document each interface in its owning module page.

**Exit:** independent review accepts the supported-operation/consumer matrix and
concrete interface contracts. Existing representative consumers work through the
intended APIs without private-table access, direct database plumbing or duplicated
semantics. Error/lifecycle/transaction and cross-platform differences are explicit;
material gaps are resolved, or future unimplemented capabilities have named owning
milestones and cannot be mistaken for currently supported operations. No complete
mobile/runtime or future feature acceptance follows from this contract gate.

Review guide: [module interfaces](architecture/interfaces.md). Subsequent milestones
recheck interfaces they extend; this is not a one-time promise to support every
future feature or a public plugin API freeze.

## S1 — Rust parsing, indexing, caching and search performance

**Status: accepted for bounded ordinary functionality, 2026-10-20.** Further
optimization, performance budgets and representative/stress gates are explicitly
deferred by the user. This advances the roadmap without claiming those gates pass.

Shared core owns committed-document indexing, versioned parsed-fact caching,
query preparation and update lifecycle; platform hosts provide storage/effect
execution. Immediate editor syntax remains local. Native reusable facts live in
app-local cache storage; browser working state survives visits. Supported search
and Bases semantics remain bounded by the maintained language matrix.

Final integrated source610ada26 has matching native/WASM/frontend builds and
actual macOS Electron, web and standalone CLI acceptance. Verified flows include
create/edit/save, rename, image transfer/read/render, Search, exact reopen/history,
independent CLI CAS/conflict/recovery and Base/filter/source/time refresh. The two
functional regressions discovered during closeout are fixed and independently
reviewed. Focused checks and actual source/artifact correspondence are recorded in
the [execution checkpoint](deferred-product-roadmap.md#latest-execution-update).

Deferred work and limits:

- Multicore and further computation/latency/memory optimization, including
  renderer startup work beyond demonstrated functional fixes.
- Representative10000-note/100000-note stress and performance budgets. Historical
  measurements remain observations, not release acceptance or new speed claims.
- Contention/dirty-query and partial-first-build DOM timing witnesses; the small
  functional fixtures do not establish stress, cancellation-race or partial-preview
  timing coverage. Unexecuted broader Rust cache/time matrix remains unverified.
- Complete Obsidian query/visual compatibility and Windows/Linux/iOS/Android
  runtime acceptance. No fully usable Base/Task/Calendar feature UI or sync service
  follows merely from this shared-core foundation.

**Exit satisfied:** supported ordinary flows pass through integrated macOS/web/CLI
paths, demonstrated functional failures are resolved, and limitations are explicit.
S3 is next. Do not reopen an optimization campaign without new user steering.

Design: [indexing/search](architecture/indexing-search-design.md),
[implementation slices](plans/indexing-search.md),
[query boundary ADR](adr/0001-shared-query-semantics.md).

## S3 — Managed-data services and contracts

**Latest authority correction (2026-10-20):** work blocks, time entries and similar
first-party user content must also be note files. S3 first reconciles feature
contracts and existing record-backed prototypes with that model; it must not
create a second authoritative database representation of those notes. Exact note
schemas/granularity remain discussion items. Operational records, recovery,
indexes/caches and secrets keep their distinct roles. This is design steering,
not authorization to implement an undecided file schema.

**Current:** portable record semantics, native/browser transactions and WorkBlock
foundations exist; complete production consumer wiring remains unfinished.

- [ ] Finish core-owned scoped records, transactions, subscriptions, revisions,
  tombstones/conflicts and bounded local queries; explicitly label local/cache data.
  Preserve sync-compatible identities/export; remote transport acceptance is in S2.
- [ ] Finalize first-party Base/Task/Calendar contracts using existing
  foundations; retain unknown supported fields and source-preserving file edits.
- [ ] Establish required schema/version handling, export and finite operation-log/
  retired-intent retention without discarding uncertain or dependency-critical work.
- [ ] Protected secret handles and observable pending/error state. Design durable
  jobs and coordination/fencing only for actual provider requirements; do not
  freeze a speculative public plugin framework.

**Exit:** a first-party record flows through actual native storage, consumer
subscription and reopen; conflicts, scoped access and interrupted retries have
meaningful checks. Source/component acceptance alone does not activate a UI.

Detail: [managed-data architecture](architecture/managed-data.md),
[feature capability plan](managed-data-tasks-calendar-plan.md).

## S4 — Desktop Bases

Execution scope and completion checklist:
[Bases implementation pass](plans/bases-implementation-goal.md). Read it before
implementing Base queries, property definitions, layouts, commands or embeds.

Obsidian's Bases appearance and interaction are the starting reference. REA and
actual runtime evidence inform concrete behavior; the latest project direction
prioritizes the best Zorid UX and the agreed improvements. The closeout establishes
bounded desktop functionality, not complete visual or behavioral parity.

- [x] Create/open/configure Bases through normal UI; useful presets and creation
  defaults; property value types and appropriate editing controls. No named Types
  or Type editor. An ordinary `type: book` property is user data, not a reserved
  schema declaration. Select/status option configuration remains a property concern.
- [x] Multiple named saved views: table/cards/list/Kanban, filtering, grouping,
  sorting, formulas, visible fields and source-preserving configuration editing.
- [x] Note creation and inline editing work in file tabs and embeds/splits, with
  stale identity, dirty-buffer, pin-close and mount-lifecycle rules intact.
- [x] Invalid definitions remain editable/saveable with clear diagnostics.
- [x] Shared property settings support select/multiselect/status and relations/
  reverse relations/rollups without named note Types. Settle persistence locally.
- [x] New copies the configured template's complete properties and body literally;
  this is the approved difference from the inspected Obsidian implementation.

**Exit:** actual Electron create Base → configure views → create/edit notes
→ open in a split/embed → restart retains the intended state. Multiple views see
the same data; rejected stale edits do not mutate a newly selected note.

## S5 — Desktop Tasks

- [ ] Built-in Tasks destination using ordinary note data. Earlier named-Type
  capability requirements are superseded. Task identification/field mappings
  must be reconciled when this deferred milestone resumes; no automatic task
  behavior is assigned to an ordinary `type` property by this decision.
- [ ] Capture, body/properties, status/priority, planned day versus deadline,
  grouping/sorting/filtering/Kanban and inline editing through ordinary note data.
- [ ] Markdown checkboxes stay separate. Provide explicit checkbox-to-task-note
  conversion without silently turning every checkbox into a global task.
- [ ] Recurrence/occurrence history and retained pending drafts; completion must not
  duplicate a recurrence or lose an interrupted capture.

**Exit:** create/edit/complete/reopen through Tasks and a Base without inconsistent
state, duplicate notes or lost drafts; conversion/undo and recurrence semantics
work in actual desktop flows. Existing bounded Tasks evidence is reused where valid.

## S6 — Desktop Calendar and planning

- [ ] Built-in Calendar and reusable Base calendar views using FullCalendar for
  desktop/web presentation; source selection is separate from publishing mappings.
- [ ] Month/day/week/agenda, all-day and timed events, Today/navigation/search/add,
  date-only/timezone/DST/recurrence and bounded range loading.
- [ ] WorkBlocks link zero/one/multiple tasks; multiple blocks can reference one task.
  Unscheduled panel, drag-to-schedule/move/resize, details, cancellation and undo.
- [ ] Time entries/timers/corrections and native-feeling keyboard/context-menu,
  accessibility and narrow-split interactions on desktop.
- [ ] Task completion/deadlines stay independent of a block ending or moving.

**Exit:** actual task capture → schedule → move/resize → edit → complete → reopen
works with consistent Base/Tasks/Calendar state; recurrence and date boundaries
have focused checks. No Google/provider completion inferred from a local calendar.

## S7 — Google Calendar two-way integration

- [ ] OAuth connection and protected tokens, selected calendars, writable/read-only
  behavior, expiry/re-authentication and explicit disconnect.
- [ ] One central connection/event mirror and subscriptions for all views; coverage,
  freshness, incremental checkpoints, recurrence masters/exceptions/cancellations.
- [ ] Incoming Google edits and outgoing Zorid edits, Base publishing mappings and
  per-view display toggles. Displaying an event does not automatically create a note.
- [ ] Retry-safe provider jobs, stable external IDs, conditional writes and
  reconciliation after uncertain outcomes; local concurrent-client ownership as needed.
  Validate cross-device provider ownership/fencing with Zorid sync in S2.
  Do not claim exactly-once Google effects.
- [ ] Define pending mutation/receipt/mapping retention separately from disposable
  expanded occurrence caches. Browser/provider credential execution policy is open.

**Exit:** controlled Google calendars demonstrate create/update/delete both ways,
recurrence/all-day/DST behavior, restart/retry and token reset without losing pending
changes or duplicating events. Multiple views do not start competing fetch loops;
concurrent local clients preserve one coherent outcome. Cross-device cases remain
an explicit S2 integration gate. Use authorized test
accounts/calendars, not real calendars by assumption.

## S8 — Desktop completion gate

Close outstanding user findings that affect normal use of delivered features:
vault create/open/recent selection, saving/recovery, file operations, tabs/splits,
links/embeds/Canvas/media, commands/settings, keyboard/IME, undo and accessibility.
Preserve mostly-correct editor behavior; do not turn this into endless reference
pixel matching. Confirm S0/S0A/S1 and S3–S7 together against the same integrated build and
representative vault; fix integration seams before native mobile expansion.

Distribution includes the selected supported runtime, signed/notarized desktop
packaging, DMG/Homebrew flow, licenses and source/provenance hygiene. Current desktop
packaging commitments are macOS-first; other desktop OS release scope must be
explicit rather than silently claimed. Publishing/releases still require their
normal authorization; this roadmap does not deploy or tag anything.

**Exit:** the user can use the integrated desktop feature set day to day, with
recorded real-app acceptance and measured performance, and the chosen packaged
build reproduces the essential workflow. Remaining limitations are explicit and
must not contradict a required feature's usability. iOS implementation may resume
only after this desktop gate and solid sync at S2. The proposed later hosted/web-before-iOS schedule
is not an additional hard acceptance gate.

## S1A — E2EE sync-group lifecycle design

**Status:** planned for later discussion, not implementation now. Sync is
end-to-end encrypted for both self-hosted and hosted services. Existing encrypted
sync foundations do not settle the product's group lifecycle.

- [ ] Define group identity, creation, membership and the relationship between
  accounts, devices, local vaults and browser working state.
- [ ] Design joining: authorization/invitations, key delivery/unlock, destination
  selection, existing-data reconciliation and interrupted join/retry behavior.
- [ ] Design leaving: distinguish local disconnect/sign-out from membership or
  device revocation and group deletion. Decide retained data/key/cache handling,
  pending edits, offline devices and rejoining without silently losing work.
- [ ] Settle E2EE key ownership, recovery and access changes, including what
  revocation can and cannot prevent for data already downloaded. Define consistent
  Electron, web and standalone CLI behavior.

**Exit:** discuss and record the lifecycle/state transitions, security boundaries,
user flows and meaningful acceptance scenarios before S2 enrollment implementation.
This is a separate design gate with no one-day completion commitment; unresolved
policy remains explicit until that discussion.

## S2 — E2EE sync foundation and self-hosted service

**Current:** encrypted text/full-vault/managed-record foundations, relay, native
CLI/desktop and bounded convergence evidence exist. Product enrollment and normal
user-facing administration/onboarding are not complete.

- [ ] Reconcile native storage changes with E2EE sync for files and managed records;
  distinguish local commit, physical publication and remote acknowledgment.
- [ ] Verify Bases/Tasks/Calendar records and provider-job ownership across
  devices; remote propagation must preserve the locally accepted feature behavior.
- [ ] Make server URL/account/group selection, credential/key handling and sync
  status usable through ordinary client settings and standalone CLI.
- [ ] Implement the accepted S1A group lifecycle, including leaving and rejoining.
  First-device group creation and joining an existing group; trusted pairing,
  invitations/QR/copyable code and recovery-key design. Do not expose reusable
  secrets in invitation codes. Finalize crypto/API details before implementation.
- [ ] Empty/existing destination bootstrap, interrupted enrollment/resume and safe
  reconciliation; preserve differing same-path files without destructive guesses.
- [ ] Reconnect/catch-up, offline native edits, deletion/move conflicts, revocation,
  wrong key/server/group rejection and live update delivery into the editor.
- [ ] Deployable self-hosted package/configuration, transport security, operator
  provisioning and a documented minimum backup/restore procedure. Production
  hosting is not implied by the current loopback fixture server.
- [ ] Decide server-push wake/catch-up transport from measured product needs;
  notifications never replace durable progress/acknowledgment.

**Exit:** independently running native clients and CLI join a controlled
self-hosted group and converge files/records after offline changes and server
restart. Bootstrap/retry/revocation cases preserve local work. A new operator can
follow setup and restore instructions; secrets are kept out of logs and synced
ordinary records. No browser durable replica is required.

Design: [sync/security](architecture/sync.md); detailed
[joining discussion](deferred-product-roadmap.md#device-joining--proposed-ux-and-implementation-slot-2026-10-17).

## S9 — Hosted Zorid Cloud

- [ ] Operate the same sync backend/protocol as self-hosted deployments; no fork of
  client sync or domain semantics. Settle deployment/account/service policies.
- [ ] Account/group/device management, authentication and revocation, server/vault
  identity, invitation/recovery flows and honest service limits/status.
- [ ] Deployment/configuration/secrets, transport security, monitoring, upgrades,
  capacity limits and routine encrypted-data/account/permission backups with a
  restore exercise. Minimum hosted safety is not postponed to S12.
- [ ] Decide signup/account recovery, quotas, billing/commercial terms and service
  ownership before exposing a public service; these policies are not yet selected.

**Exit:** a staged hosted service supports real controlled native-client enrollment,
sync, revocation, outage recovery and operator restore using the shared protocol.
Public production launch is a separate explicit action; a local relay test isn't it.

## S10 — Connected web workspace

The planned entry point is **web.zorid.app**; this is a product destination, not a
claim that the domain/service is deployed.

- [ ] Welcome screen offers Zorid Cloud login or a self-hosted service URL/login.
  Authenticate, obtain authorized sync groups, select/join and unlock a group.
- [ ] Fetch the selected group's working data and display notes/attachments plus
  Bases/Tasks/Calendar using shared UI/core semantics. Required writable behavior
  and pending/error status must be honest.
- [ ] Zorid Cloud and self-hosted use the same client/protocol. Define browser
  connection requirements, origin/credential isolation and service discovery.
- [ ] Retain local working note text/metadata and indexes across visits for fast
  local use and incremental catch-up. Fetch attachment bodies on demand into a
  bounded cache. Re-authenticate/unlock and validate retained state on return.
  Browser storage is not a native vault directory or the group's sole durable copy.
- [ ] Define close/reload/sign-out behavior, cache cleanup/key retention and handling
  of unsent edits. Pending edits are not disposable cache; a local write is not
  proof of remote acknowledgment. Offline editing/reload guarantees remain open.

**Exit:** connect to controlled hosted and self-hosted groups, see and edit the same
feature data, reconnect after changes elsewhere and repeat after clearing cache.
Cache loss only triggers refetch for synchronized data; unsent edits are retained
or explicitly resolved rather than silently lost. No persistent browser SQLite/
OPFS migration is required merely to match native platforms.

## S11 — Native iOS

Resume preserved native work on the accepted native-shell/shared-editor/Rust
interfaces after desktop S8 and sync S2 acceptance. Finish retained WebView routing/editor-window
ownership, vault selection/tabs, create/edit/save/return/reopen, lifecycle/background
handling, native menus/keyboard/gestures and accessible navigation. Resolve the
observed disabled Home controls and incomplete composed runtime gates.

Deliver native generic task lists, Apple-Calendar-informed calendar month/day/
multi-day timelines, all-day/overlap layouts, source controls and native detail/
connection/settings screens. Rich note bodies stay in the shared web editor;
Swift does not duplicate the Rust parser/store/sync engine. Reuse S7 provider logic.

**Exit:** actual designated simulator and physical development device demonstrate
notes plus task → schedule → edit → complete, sync/reconnect, Google integration,
background/return and gesture cancellation with preserved content. Measure memory,
scrolling/range loading and keyboard/accessibility. Compilation/signing/install
alone do not establish interaction acceptance. iOS validation slots remain required.

## S12 — Complete history, backups and administration

Deliver the broader required history/recovery/admin milestone beyond local
seven-day File Recovery: inspectable file/record history, deletion/restore/recovery
UX, complete encrypted server/client backup workflows, account/device/group
administration, recovery-key and revocation behavior, and retention/compaction
consistent with offline clients. Decide whether/how version history is synced
before promising cross-device restoration; local File Recovery remains separate.

**Exit:** a controlled device-loss/server-loss exercise restores intended data,
permissions and recovery-critical configuration without resurrecting revoked
access or silently dropping pending/conflicting content. Retention and unsupported
history cases are documented. Do not defer basic backup required to run S2/S9.

## Preserved later work and open decisions

| Item | Treatment |
| --- | --- |
| Android native Rust shell and feature delivery | Preserved follow-up after iOS; generated Capacitor project is not native parity. Choose native/JNI/calendar path before implementation. |
| P2P live sync | Explicitly deferred; retain existing identity/encryption/convergence semantics and server fallback. Not a prerequisite for current server-backed milestones. |
| Seamless stale-editor draft merging | Later improvement after planned stages; preserve IME/undo/selection and recoverable original draft. Current recovery must remain usable meanwhile. |
| Public plugin/extension API, managed-data/secrets/jobs contracts | Discussion/decision gate; derive from working first-party services. No Obsidian API compatibility requirement and no speculative plugin content framework. Earlier broad plugin phases do not override this hold. |
| Additional calendar providers / EventKit | Google first; later provider/native-calendar scope to decide. Avoid duplicate imported sources. |
| Further transport/serialization changes | Evaluate only from measured need; protobuf transport does not automatically change encrypted payload formats. |
| Synced version history | Explicit retention/restore design in S12; no automatic promotion of local snapshots into sync. |
| Spaced repetition | Removed by user, not deferred. Do not restore it as a roadmap obligation. |
| Excalidraw/plugin content frameworks/JSONL schemes | Remain deferred discussion; not prerequisite architecture work. |

## Maintenance rules

Keep milestone IDs stable. When scope changes, amend the relevant milestone and
record the decision; do not silently drop a capability or insert a second competing
roadmap. Link detailed plans instead of copying their implementation diary. Archive
completed execution details while keeping a concise acceptance link per closed
milestone. Review this roadmap at milestone boundaries and after material user
steering; do not mark boxes complete from an agent's plan or isolated passing test.

## Future collection collaboration and sync

Status: **deferred requirements**, not part of the local collection delivery or
its acceptance gate. Detailed discussion: [design sections 7–8](design/types-properties-sync-discussion.md#7-future-multiplayer-requirements--deferred).

- Replicate structured schema/membership/typed values by stable identities. Field
  or option renames preserve references; unrelated short-ID collisions never merge
  objects. Local storage must operate without mandatory remote enrollment.
- Specify causally later and concurrent scalar/rename resolution, set operations,
  ordering, deletion, schema/datatype versions and old-client writes. Converge
  automatically without rename-choice prompts; the set add/remove policy is open.
- Extend the existing Rust/encrypted-sync foundation. Persist validated updates
  and outgoing work durably; preserve operation identity across uncertain retries.
  Do not sync live SQLite files or computed formula/rollup results as source state.
- Retain updates arriving before their schema/option dependencies. Bound protocol
  admission, versions and resource use; do not accept unrestricted raw client CRDT
  updates as validated domain operations.
- Give body saves, structured properties and generated frontmatter/type YAML one
  coherent composition/replication contract. Projections must not become a second
  authored sync stream, overwrite newer values or generate echo loops.
- Reconcile supported external value edits against an observed projection/schema
  baseline; preserve unknown or ambiguous input. This is not collection import
  or permission to change membership by editing `_type`.
- Include necessary authoritative hidden state and definitions in backup/restore
  and supported transfer. Markdown-only copies do not guarantee collaborative
  identity/history restoration; format and recovery contracts remain to be chosen.
- Before future activation, demonstrate multi-client offline/concurrent edits,
  schema rename/value retention, dependency reordering, retry/deduplication,
  deletion and crash/restart recovery on actual integrated clients.

Local source tests or durable local publication do not establish any of these
future distributed guarantees. Reopen design and implementation explicitly when
this roadmap work is authorized.
