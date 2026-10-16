# Zorid development instructions

## Parallel development and verification

- `main` is the canonical integration branch and the primary workspace checkout.
  Keep unfinished implementation in isolated branches/worktrees. After scoped
  review and required validation pass, merge or cherry-pick coherent confirmed
  changes into `main`; do not leave confirmed work only on a feature branch.
  Integration does not establish unverified native/mobile/reference parity.

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

- The development machine is an 8 GB MacBook Air. Keep heavy builds and full
  test suites serialized; use bounded test concurrency. Parallel agents should
  coordinate local resource use rather than launch overlapping full checks.
- Close the test Electron app opened by the agent after each native verification
  pass, preserving any unsaved work. Do not leave test windows running between
  passes or close unrelated user applications.

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

- Latest architecture discussion (2026-10-16): the user no longer requires
  Obsidian plugin API compatibility and wants to discuss a clean Zorid API,
  app-managed syncable plugin data, secret storage, and native mobile shells
  around the web editor. These are discussion topics, not approved API designs.
  Do not redesign or implement those APIs until the discussion resolves them.
  Continue existing editor correctness and verification work. The mobile shell
  choice remains open; do not replace Capacitor merely from this discussion.
- Build an original open-source Obsidian recreation, with Electron desktop and
  Capacitor mobile apps. Keep recovered proprietary artifacts out of project source.
- Prioritize the editor foundation, exact interactions, split views, and native
  verification. Exposed note modes are Reading and Live Edit, both rendering content.
- Context menus must match Obsidian across applicable elements, including menu
  ordering, labels, submenus, availability and action behavior. Tables include
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
