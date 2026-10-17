# Zorid development instructions

## Parallel development and verification

- `main` is the canonical integration branch and the primary workspace checkout.
  Keep unfinished implementation in isolated branches/worktrees. After scoped
  review and required validation pass, merge or cherry-pick coherent confirmed
  changes into `main`; do not leave confirmed work only on a feature branch.
  Integration does not establish unverified native/mobile/reference parity.

- Shared-core implementation is coordinated separately from the active editor
  polish session. Before work or after context compaction, read the execution
  checkpoint in `docs/deferred-product-roadmap.md` and relevant findings. Record
  task owner, branch/worktree, dependencies, commits and verification separately.
  The built-in goal is thread-scoped; repository records are the cross-session
  source of truth. Do not assume another session has read new instructions.
- Serialize changes to the primary `main` checkout across sessions. Use a shared
  integration owner or an explicitly acknowledged common lock protocol before
  either coordinator merges/cherry-picks there. A Git index lock alone does not
  serialize an entire integrate/test/commit sequence. The user transferred sole
  main integration to the shared-core coordinator, acknowledged by the editor
  at main `2592ebb` on 2026-10-16. The editor continues isolated implementation
  and review and sends ordered batches; it must not mutate main or push
  concurrently. Do not stash, reset, clean or commit another session's work.
- Keep editor/workspace internals with the editor session. Shared editor/core
  seams, platform selection, desktop bridge and root build files require named
  ownership before edits. Reconcile with current main and revalidate affected
  behavior before integration; a clean cherry-pick is not semantic verification.
- User authorization (2026-10-17): resume Rust save integration in the normal
  editor, including the required NoteBuffer/workspace durable-save connection.
  The shared-core coordinator may assign these scoped files to named workers;
  editor polish remains paused. Do not ask again whether this integration may
  proceed merely because an older checkpoint says NoteBuffer work was paused.

- Maximize development velocity by using as many available agents in parallel
  as useful independent work allows. Do not leave agents idle when implementation,
  reference audits, integration, or verification can safely proceed independently.
- Proactively delegate concrete tasks without waiting for the user to repeat this
  instruction. Check available workers and reuse completed workers where practical.
- Give each worker a clear scope, owned files, acceptance criteria, and existing
  reference evidence. Use Git branches and isolated worktrees for implementation.
- Keep integration and independent review running alongside feature development.
  Parallelism must preserve sound codebase design, data integrity, and meaningful
  tests; do not trade verification for a larger active-worker count.
- Avoid overlapping edits or duplicated investigations. Coordinate shared APIs
  early, assign ownership, and integrate reviewed changes in coherent commits.
- Report observed results and remaining gaps honestly. A passing isolated test
  does not establish integrated, native, mobile, visual, or reference parity.

## Local resource use

- Latest user resource steering (2026-10-17, native relay msg_e825ad204547):
  explicit validation slots are required only for iOS builds and simulator
  passes. Bounded frontend/desktop builds and focused tests may proceed without
  per-check permission. Coordinate actual load for full Rust compilation and
  Xcode on this 8 GB machine; this does not authorize overlapping full suites or
  interrupting another owner's live process. Main integration ownership is
  unchanged. This supersedes the earlier blanket slot for every check.
- The development machine is an 8 GB MacBook Air. Keep heavy builds and full
  test suites serialized; use bounded test concurrency. Parallel agents should
  coordinate local resource use rather than launch overlapping full checks.
- Close the test Electron app opened by the agent after each native verification
  pass. User-designated test vaults and agent-created disposable fixture vaults
  contain disposable content: agents may create, edit, rename, delete or reset
  their notes and discard unsaved test edits without asking again. This standing
  permission applies to verification in those vaults, not real user vaults or
  unrelated applications. Do not leave test windows running between passes.

## Incoming user findings

- The user will send frequent observations, screenshots, bugs, and feature requests.
  Treat them as additions or corrections to the ongoing goal unless explicitly
  told to stop, replace the goal, or change priorities.
- Maintain a persistent queue in `docs/user-findings.md`. Record new findings,
  group related work, and track implementation and verification separately.
- Organize and choose the implementation sequence autonomously using dependencies,
  correctness, user impact, and integration readiness. Do not interrupt a coherent
  task for every incoming message or require the user to prioritize the queue.
- Acknowledge relevant steering briefly, then continue useful work. Escalate only
  genuinely missing information or consequential decisions that need user input.
- Do not lose deferred requests, silently reduce scope, or mark a finding complete
  based on an implementation plan or an isolated test alone.

## Product priorities

- User explicitly permits copying/adapting suitable Obsidian LiveSync logic to
  accelerate implementation. Reuse code where it fits the accepted Rust/core
  architecture; preserve applicable upstream license/copyright notices and track
  source commit provenance. Do not limit reuse to conceptual reference only.
- Latest direct user confirmation (2026-10-16): prioritize the best Zorid UX.
  Use Obsidian as a starting point and reference, not an exact parity requirement.
  This supersedes older exact-match requirements in project instructions and
  reference ledgers. Preserve useful requested capabilities and correctness,
  accessibility, data integrity and native verification; document deliberate UX
  choices without treating every reference difference as a defect.
- Latest execution steering (2026-10-16) supersedes the earlier discussion-only
  restriction for the first shared-core milestone: the user requests persistent
  plans/tracking and a built-in goal for coordinated implementation. Start with
  contracts and feasibility, then Rust core, web + Electron clients and standalone
  CLI, with E2EE server sync. CLI embeds its own core, covers all vault files and
  runs independently; concurrent local access requires storage coordination, not
  mandatory IPC/daemon ownership. See the roadmap execution checkpoint. P2P,
  complete recovery/admin and native mobile remain later required milestones;
  speculative plugin frameworks and calendar work stay deferred. Existing editor
  polish work continues independently; do not replace its runtime/storage path
  before the integration gates pass.
- Latest architecture discussion (2026-10-16): the user no longer requires
  Obsidian plugin API compatibility and wants to discuss a clean Zorid API,
  app-managed syncable plugin data, secret storage, and native mobile shells
  around the web editor. These are discussion topics, not approved API designs.
  Do not redesign or implement those APIs until the discussion resolves them.
  Continue existing editor correctness and verification work. Subsequent discussion
  explicitly chooses a native-owned mobile shell embedding the shared web editor,
  with registered plugin actions able to open plugin web screens. Detailed APIs,
  native frameworks, and whether to retain Capacitor remain open; implementation
  is not requested by this discussion. Do not replace Capacitor merely from it.
  The user subsequently selected Rust for the shared data core. This settles the
  language direction; core ownership, storage/sync semantics, binding choices,
  API design and migration remain discussion topics before implementation.
  Latest steering prioritizes a tight-knit first-party experience: do not design
  speculative plugin content frameworks, Excalidraw integrations or JSONL formats.
  Present the overall app architecture; those extension details are deferred.
- Build an original open-source note-taking app informed by Obsidian, with Electron desktop and
  Capacitor mobile apps. Keep recovered proprietary artifacts out of project source.
- Prioritize the editor foundation, intuitive interactions, split views, and native
  verification. Exposed note modes are Reading and Live Edit, both rendering content.
- Use Obsidian context menus as a reference for useful commands, ordering, labels,
  submenus, availability and action behavior; choose improvements for Zorid UX.
  Tables include
  deleting rows/columns, selecting whole rows/columns, and multiple-row/column
  selections with selection-dependent commands.
- Include Obsidian-style launch/onboarding and vault-selection flows: create a
  vault, open an existing folder, and choose recent vaults. Sequence work by
  dependencies and integration readiness; new requests need not interrupt the
  current implementation immediately.
- Defer discussion, design, and implementation of the requested LiveSync-style
  default sync and FullCalendar/TaskNotes-style calendar/task features until the
  editor base is solid, except the user has now explicitly opened discussion of
  shared plugin-data/sync architecture. Implementation is still on hold, and the
  calendar/task request remains deferred. See `docs/deferred-product-roadmap.md`.
