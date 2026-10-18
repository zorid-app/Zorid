# Product roadmap

Updated 2026-10-18. This is the maintained delivery order and scope register for
Zorid. The [architecture manual](architecture/README.md) explains system design;
the [execution checkpoint](deferred-product-roadmap.md) records owners, branches
and evidence; [user findings](user-findings.md) records incoming bugs/requests.
Older plans remain detailed capability inventories, not competing delivery orders.

## Current focus

**S0 — Storage, saving and local recovery is implementing.** The user explicitly made the
storage layer the immediate priority. Review storage contracts during S0 design; the new
**S0A modular-interface gate** follows S0 and precedes S1 optimization and downstream
feature work. Implementation ownership and verification are tracked in the execution checkpoint;
no complete S0 acceptance is claimed. Existing feature/iOS work is preserved.

Design for desktop, browser and mobile now; finish the usable desktop feature set
before resuming iOS implementation. The browser is a connected sync-group client
with retained local working data, rather than a user-managed filesystem vault.
Do not reopen all tracks in parallel.

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

S0 is **implementing**; later milestones remain **planned**. Earlier integrated
foundations are credited below; complete S0 acceptance still requires its exit checks.

| ID | Milestone | Prerequisite |
| --- | --- | --- |
| S0 | Storage layer, saving and local recovery — immediate priority | Current source/retained-artifact inventory |
| S0A | Modular interfaces and feature-consumer contract review | S0; storage contract design starts within S0 |
| S1 | Rust parsing, indexing, caching and search performance | S0A |
| S2 | Shared sync backend and usable self-hosted native-client sync | S1 |
| S3 | Managed-data services and feature contracts | S2 |
| S4 | Fully usable desktop Types and Bases | S3 |
| S5 | Fully usable desktop Tasks | S4 |
| S6 | Fully usable desktop Calendar and planning | S5 |
| S7 | Google Calendar two-way integration | S6; provider job/credential decisions |
| S8 | Complete desktop experience and distribution gate | S0–S7, including S0A |
| S9 | Hosted Zorid Cloud service | S2 and S8 |
| S10 | Connected web client at web.zorid.app | S9; self-hosted service from S2 |
| S11 | Native iOS app | S8; hosted/web completion is not a hard prerequisite |
| S12 | Complete history, backup/recovery and administration | S11; basic operational backup already required in S2/S9 |

The dependency order is an execution plan, not a demand to rewrite accepted core
work. Reconcile each stage with current main and retained isolated changes first.
Google-specific authorization is distinct from logging into Zorid sync.
S9/S10 before S11 is a proposed scheduling order, not an additional user-required
gate: the hard iOS requirement is desktop completion at S8. Revisit that scheduling
choice at the desktop gate rather than silently expanding the prerequisite.

## S0 — Storage layer, saving and local recovery

**Current:** native Store/SQLite authority, physical projection journals and local
checkpoints exist. Browser uses IndexedDB. The first reviewed S0 batch adds shared
SQLite connection policy, separate app-local recovery snapshots, automatic opening
recovery and settled backup retirement. The second batch, integrated as `eb6d6bb2`, separates native disposable document
caches into app-local `cache.sqlite` and adds entry-scoped version preview/restore.
Clipboard images, native dirty-window close, live-window normal AppKit quit, history
restoration and restart have passed scoped actual Electron checks. S0 remains
implementing: superseded-rename recovery, no-window quit and the final concurrent
CLI/interruption exercise remain open. Complete S0 is not accepted.

Scope:

- [x] Inventory current transaction boundaries, save state and pending/settled
  `.previous`/`.namespace` artifacts before changing their lifecycle.
- [ ] Review storage service contracts against existing feature needs before
  implementing the SQLite layer; carry unresolved cross-system seams into S0A.
- [x] Introduce shared Rust SQLite infrastructure for native connections,
  configuration, transactions, schemas, errors/locking and diagnostics. Keep
  domain operations in services; no arbitrary frontend SQL API.
- [x] Keep native authoritative state in vault `.zorid/vault.sqlite`. Define stable
  local vault identity and app-data path resolution shared with the independent
  CLI; handle moved/copied vaults and identically named vaults explicitly.
- [x] Separate app-local per-vault `cache.sqlite` (rebuildable) and
  `recovery.sqlite` (retained history) without breaking authoritative transactions.
- [ ] Match the inspected Obsidian autosave/File Recovery behavior: coalesced
  roughly two-second saves, blur/close/graceful-quit flush, five-minute snapshots,
  seven-day expiry, unchanged-content dedupe, best-effort failed-save capture and
  manual preview/restore. Do not promise every unsaved keystroke survives a crash.
- [x] Stop accumulating per-save backups; reconcile current Rust DB/file authority,
  external-writer handling and safe artifact cleanup before save-strategy cutover.
- [ ] Reproduce and fix the persistent import/reconciliation warning's actual cause;
  normal operation should settle automatically. Real unresolved recovery remains
  visible with an actionable message, rather than being hidden.
- [x] Specify browser service/storage interfaces for connected working state.
  Persistent browser SQLite/OPFS is optional and does not block native S0 delivery.

Completed checks refer to the bounded implementation and evidence recorded in
[the execution checkpoint](deferred-product-roadmap.md), not acceptance of the
whole milestone. Vault moves currently start a new local-history bucket; aliases
share a bucket and copies remain separate. Settled backup retirement never sweeps
unresolved namespace evidence. The [browser contract](architecture/browser-storage-contract.md)
maps current IndexedDB services; connected onboarding and attachment eviction
remain later browser work. Autosave/history behavior is implemented and scoped
checks pass, but the lifecycle gate still includes the separate no-window quit
case. S0A will complete the cross-feature interface audit.

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

**Status:** planned; this document does not certify an interface audit. Storage
contract review begins during S0 design so we do not build the wrong layer first.
S0A then checks storage, indexing and caching together against actual consumers
before S1 changes internals or downstream feature work resumes. Existing milestone
IDs stay stable.

- [ ] Inventory current Rust service contracts, TypeScript platform capabilities,
  host/WASM/mobile bindings and consumers. Reuse working interfaces; identify
  concrete gaps rather than inventing a general framework.
- [ ] Build a supported-operation matrix covering files/attachments, managed records,
  retained recovery, disposable caches, parse/index/search and relationships. Map
  Bases/Tasks/Calendar, editor, sync and independent CLI needs to owning services.
- [ ] Specify inputs/results, identity/revision/scope, transaction boundaries,
  local-commit versus publication/sync status, subscriptions, pagination/limits,
  cancellation, release and error/uncertain-retry behavior.
- [ ] Check indexing snapshots, incremental updates, source/version fences, query
  pins and rebuild/progress APIs; features must not read private index tables.
- [ ] Check cache keys/versioning, hit/miss/stale/error behavior, invalidation,
  eviction/budgets and rebuild APIs. Pending edits, provider receipts and recovery
  history must never be routed through disposable-cache deletion.
- [ ] Review native durable-vault and browser connected-working-state differences.
  Shared services do not require identical persistence guarantees. Document missing
  capabilities explicitly rather than silently falling back to another authority.
- [ ] Prove representative consumer flows through the service boundary; add focused
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

**Design:** confirmed after user interview; implementation remains planned and
requires S0/S0A. [Design](architecture/indexing-search-design.md),
[implementation slices](plans/indexing-search.md),
[query boundary ADR](adr/0001-shared-query-semantics.md).

**Current:** portable parsing/index generations and native prior-generation reuse
exist; pumps are sequential, Rust literal search scans text and Bases rebuilds
substantial state per call. No new measured improvement or complete Obsidian query
compatibility is established by this roadmap.

- [ ] Preserve distinct documented Obsidian Bases/search languages and results in
  shared Rust; inventory supported syntax, gaps and deliberate differences first.
- [ ] Measure 10,000-note baseline/100,000-note stress plus large-note workflows:
  cold/warm startup, indexing, incremental edits, search/Base latency and memory.
- [ ] Persist content-derived parse/index reuse with semantic-version keys and safe
  identity rebinding; incrementally invalidate changed inputs and survive restart.
- [ ] Reuse compiled Base programs, graph/generation preparation and eligible query
  answers in bounded memory; include all relevant dependencies and time context.
- [ ] Move indexing/semantic-parsing lifecycle into shared Rust core: commit-driven
  invalidation/coalescing, cache access, job scheduling and update subscriptions.
  Platform adapters execute work; editors refresh relevant views. Retain local
  interactive syntax parsing and separate revision-tagged draft analysis.
- [ ] Add measured bounded adaptive multicore work, priority for editing/saves/active
  queries and real cancellation/bounded chunks without stale publication. Evaluate
  native and browser executors on every platform where parallelism helps.
- [ ] Query committed source; retain coherent previous results while updating and
  clearly mark partial first-build results/counts. Refresh time-dependent visible
  views using configured timezone (device-local default), one time context/query.
- [ ] Cover supported text/properties and attachment names/metadata; PDF extraction/
  OCR later. Keep browser working data/indexes across visits with incremental
  catch-up and on-demand bounded attachment caching.
- [ ] Measure renderer startup/lazy loading and fix demonstrated bottlenecks.

**Exit:** same representative workloads have retained before/after results and
measurement-based budgets. Semantic compatibility, invalidation/cancellation,
coverage and actual foreground responsiveness pass on the integrated changed
paths. No new Base/Task/Calendar feature UI or paused native mobile implementation
is smuggled into S1. Execute slices one at a time; source approval alone is not
runtime or performance acceptance.

## S2 — Sync foundation and self-hosted service

**Current:** encrypted text/full-vault/managed-record foundations, relay, native
CLI/desktop and bounded convergence evidence exist. Product enrollment and normal
user-facing administration/onboarding are not complete.

- [ ] Reconcile native storage changes with E2EE sync for files and managed records;
  distinguish local commit, physical publication and remote acknowledgment.
- [ ] Make server URL/account/group selection, credential/key handling and sync
  status usable through ordinary client settings and standalone CLI.
- [ ] First-device group creation and joining an existing group; trusted pairing,
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

## S3 — Managed-data services and contracts

**Current:** portable record semantics, native/browser transactions and WorkBlock
foundations exist; complete production consumer wiring remains unfinished.

- [ ] Finish core-owned scoped records, transactions, subscriptions, revisions,
  tombstones/conflicts, sync and bounded queries; explicitly label local/cache data.
- [ ] Finalize first-party Types/Base/Task/Calendar contracts using existing
  foundations; retain unknown supported fields and source-preserving file edits.
- [ ] Establish required schema/version handling, export and finite operation-log/
  retired-intent retention without discarding uncertain or dependency-critical work.
- [ ] Protected secret handles and observable pending/error state. Design durable
  jobs and coordination/fencing only for actual provider requirements; do not
  freeze a speculative public plugin framework.

**Exit:** a first-party record flows through actual native storage, sync, consumer
subscription and reopen; conflicts, scoped access and interrupted retries have
meaningful checks. Source/component acceptance alone does not activate a UI.

Detail: [managed-data architecture](architecture/managed-data.md),
[feature capability plan](managed-data-tasks-calendar-plan.md).

## S4 — Desktop Types and Bases

- [ ] Create/open/configure Bases and Types through normal UI; useful presets and
  creation defaults; typed properties, stable select/status options and mappings.
- [ ] Multiple named saved views: table/cards/list/Kanban, filtering, grouping,
  sorting, formulas, visible fields and source-preserving configuration editing.
- [ ] Record creation and inline editing work in file tabs and embeds/splits, with
  stale identity, dirty-buffer, pin-close and mount-lifecycle rules intact.
- [ ] Invalid definitions remain editable/saveable with clear diagnostics.

**Exit:** actual Electron create Type/Base → configure views → create/edit records
→ open in a split/embed → restart retains the intended state. Multiple views see
the same data; rejected stale edits do not mutate a newly selected note.

## S5 — Desktop Tasks

- [ ] Built-in Tasks destination and useful Task type. Task behavior is a type
  capability, including explicit mappings for custom types; no reserved type name.
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
  reconciliation after uncertain outcomes; multi-device ownership/fencing as needed.
  Do not claim exactly-once Google effects.
- [ ] Define pending mutation/receipt/mapping retention separately from disposable
  expanded occurrence caches. Browser/provider credential execution policy is open.

**Exit:** controlled Google calendars demonstrate create/update/delete both ways,
recurrence/all-day/DST behavior, restart/retry and token reset without losing pending
changes or duplicating events. Multiple views do not start competing fetch loops;
multiple eligible devices preserve one coherent outcome. Use authorized test
accounts/calendars, not real calendars by assumption.

## S8 — Desktop completion gate

Close outstanding user findings that affect normal use of delivered features:
vault create/open/recent selection, saving/recovery, file operations, tabs/splits,
links/embeds/Canvas/media, commands/settings, keyboard/IME, undo and accessibility.
Preserve mostly-correct editor behavior; do not turn this into endless reference
pixel matching. Confirm S0–S7 together against the same integrated build and
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
only after this desktop gate. The proposed later hosted/web-before-iOS schedule
is not an additional hard acceptance gate.

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
interfaces after the desktop gate. Finish retained WebView routing/editor-window
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
