# Bases heavy-user Electron acceptance

Owner: `bases_e2e`, branch `codex/bases-e2e`, isolated worktree
`.worktrees/bases-e2e`. Target: the frozen integrated implementation of
`docs/plans/bases-implementation-goal.md`. No runtime launched while authoring.

The user explicitly requested a full actual heavy-user end-to-end pass. Electron
CDP automation is chosen because a repeatable multi-step session can assert exact
saved files and rerun after fixes. It runs the normal Electron application and Rust
host. It does not call production stores/controllers to simulate positive edits.

## Authored first composed journey

- 72 book notes plus heterogeneous/missing-property row; exact filter excludes
  authors, project and template. Assert table count and Rust formula output.
- Create Base through normal command, then rename/add/duplicate/reorder/default/
  delete views. Preserve unknown configuration and comments.
- Apply/remove advanced view filter; assert exact independently calculated count.
- Create/rename/remove formula through its actual editor; Search, saved result
  limit, built-in/custom summary with full-result and limited-result sum oracles;
  real column separator keyboard resize/reset.
- Edit number, checkbox, multiselect, status and relation using actual controls;
  check exact YAML values and preserve original body/unrelated fields.
- Paste two rows/two columns through the production ClipboardEvent handler;
  one command undo/redo, keyboard range clear/undo, exact durable field checks.
- Actual Chromium dragstart/intercept/drop header reorder and Kanban pointer move;
  no injected application drag state or mutation calls.
- Create two notes through New with exact full literal template and collision
  handling; assert unchanged template and no expanded placeholders.
- Missing-template failure creates no blank fallback; repair settings and retry.
  New without template uses safe equality defaults.
- A separate Authors Base verifies reverse relations/count/average from all
  durable related files, without writing derived fields into source notes.
- Switch Table/Cards/List/Kanban; move one card through actual keyboard behavior
  and assert original file changed.
- Mount both file/named-view and fenced Base embeds; preserve containing Markdown.
- Ordinary Split right: edit one shared file and assert both presentations agree.
  Palette-mounted right-sidebar Base follows two active main notes' `this` context.
- External editor writes while a real cell draft retains its original baseline;
  verify stale rejection/draft feedback and exact authoritative external bytes.
- Signal-free normal quit; restart same profile; verify note/config bytes and UI.

These are **authored, not executed**. Selectors and interactions are coordinated
with implementation owners and must be reconciled to their final reference-backed
controls before runtime. A failed early gate does not establish later coverage.

## Required remaining additions before full acceptance

- Formula validation errors, group summaries, display names, visual nested All
  views filters, result export and custom summary definition editing.
- Property definition option creation/rename/reorder/color/removal and unknown
  values; date/datetime/list/link editing and invalid-value diagnostics.
- Relation target rename/delete/unresolved and refresh.
- Table pointer resize/header menus; Kanban empty/null/
  list/folder groups; Cards covers/sizing, List markers/separators.
- Unreadable-template failure and create-in-group precedence.
- Fenced configuration UI saves original Markdown block; close/remount pending drafts.
- Real native interruption/failure retained recovery, report actual atomic/partial
  boundaries and repeat safe retry; this needs integration-owner fault scheduling.
- Matched Obsidian reference screenshots/interaction evidence remains the REA/
  reference owner's independent lane. Zorid screenshots alone establish no parity.

Root supplies source HEAD/native/frontend freeze, exact binaries and runtime slot.
All heavy builds and app runs remain serialized. Only disposable fixture files
are modified. Artifacts include before/after hashes, action log, exact data
assertions, screenshots, renderer errors, native child identity and graceful exit.
No browser/mobile/sync/performance acceptance follows from this desktop pass.
