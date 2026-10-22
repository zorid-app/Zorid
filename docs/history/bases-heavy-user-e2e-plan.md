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
- Edit number, checkbox, multiselect, status and relation using actual controls;
  check exact YAML values and preserve original body/unrelated fields.
- Paste two rows/two columns through the production ClipboardEvent handler;
  one command undo/redo, exact durable field checks.
- Create two notes through New with exact full literal template and collision
  handling; assert unchanged template and no expanded placeholders.
- Switch Table/Cards/List/Kanban; move one card through actual keyboard behavior
  and assert original file changed.
- Mount both file/named-view and fenced Base embeds; preserve containing Markdown.
- External editor writes while a real cell draft retains its original baseline;
  verify stale rejection/draft feedback and exact authoritative external bytes.
- Signal-free normal quit; restart same profile; verify note/config bytes and UI.

These are **authored, not executed**. Selectors and interactions are coordinated
with implementation owners and must be reconciled to their final reference-backed
controls before runtime. A failed early gate does not establish later coverage.

## Required remaining additions before full acceptance

- Formula creation/edit/rename/removal, built-in/custom group and overall summaries,
  display names, visual nested All views filters, search and result limits/export.
- Property definition option creation/rename/reorder/color/removal and unknown
  values; date/datetime/list/link editing and invalid-value diagnostics.
- Relation reverse lookup, rollups, target rename/delete/unresolved and refresh.
- Table resize/reorder/header menus/range clear; Kanban pointer drag, empty/null/
  list/folder groups; Cards covers/sizing, List markers/separators.
- Full-template missing/unreadable failure and explicit recovery/retry without a
  duplicate; New without template and create-in-group precedence.
- Split/sidebar mounting and active-main-note `this` context changes; fenced
  configuration UI saves original Markdown block; close/remount pending drafts.
- Real native interruption/failure retained recovery, report actual atomic/partial
  boundaries and repeat safe retry; this needs integration-owner fault scheduling.
- Matched Obsidian reference screenshots/interaction evidence remains the REA/
  reference owner's independent lane. Zorid screenshots alone establish no parity.

Root supplies source HEAD/native/frontend freeze, exact binaries and runtime slot.
All heavy builds and app runs remain serialized. Only disposable fixture files
are modified. Artifacts include before/after hashes, action log, exact data
assertions, screenshots, renderer errors, native child identity and graceful exit.
No browser/mobile/sync/performance acceptance follows from this desktop pass.
