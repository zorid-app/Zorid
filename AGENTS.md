# Zorid development instructions

## Parallel development and verification

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

## Current product priorities

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
  editor base is solid. See `docs/deferred-product-roadmap.md`.
