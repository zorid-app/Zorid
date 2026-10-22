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
- Edit native date/datetime segments with real keyboard input; select and plain
  list widgets persist their respective scalar/list values.
- Shared property settings: create/reorder/color option, rename label without
  rewriting values, remove a selected option and preserve/show its unknown value,
  then restore the definition through UI.
- Paste two rows/two columns through the production ClipboardEvent handler;
  one command undo/redo, keyboard range clear/undo, exact durable field checks.
- Actual Chromium dragstart/intercept/drop header reorder and Kanban pointer move;
  no injected application drag state or mutation calls.
- Create two notes through New with exact full literal template and collision
  handling; assert unchanged template and no expanded placeholders.
- New opens its hover editor. Rename the selected contenteditable title, type a
  full literal body into the real shared CodeMirror editor, close, reopen as a
  normal note and verify exact bytes again after actual application restart.
- Conflicting New title retains the draft/error. Retry cannot duplicate/overwrite
  the existing file; correct the title and explicitly retry the same note.
- Missing-template failure creates no blank fallback; repair settings and retry.
  New without template uses safe equality defaults.
- A separate Authors Base verifies reverse relations/count/average from all
  durable related files, without writing derived fields into source notes.
- Rename a target through its normal note title; verify readable relation updates.
  Delete the target through a real Base cell menu and actual confirmation; preserve
  referring notes and show unresolved links.
- Switch Table/Cards/List/Kanban; move one card through actual keyboard behavior
  and assert original file changed.
- Cards cover property, fit, size and aspect ratio save through visible controls;
  decode a deterministic 96×64 PNG. List markers, separators and indentation save.
- Mount both file/named-view and fenced Base embeds; preserve containing Markdown.
- Rename the fenced view through its toolbar and assert the exact original host
  Markdown changes only at that view name.
- Ordinary Split right: edit one shared file and assert both presentations agree.
  Palette-mounted right-sidebar Base follows two active main notes' `this` context.
- External editor writes while a real cell draft retains its original baseline;
  verify stale rejection/draft feedback and exact authoritative external bytes.
- Signal-free normal quit; restart same profile; verify note/config bytes and UI.
- Actual Results CSV download uses Chromium download-directory isolation, then an
  independent quoted/multiline CSV parser verifies all 73 initial result rows and
  total ratings. This does **not** exercise the native Save dialog.
- Rich formula link/icon, local image and inert sanitized HTML reach the real
  renderer; click the formula link to open its original note.
- Reconciled reference immediate toolbar behavior: Add view name Enter continues
  Configure view, Formula CodeMirror autosaves, custom visible comboboxes replace
  hidden native backing controls, filter sections use disclosure state, and the
  summary picker has real options/previews. Typed Bases clipboard preserves
  numbers; a separate raw plain-string paste preserves incompatibility/diagnostics.
- Add a typed custom summary and assert its immediately seeded empty definition;
  rename its live name/reference, edit its CodeMirror expression twice, return
  through Back and delete through More. Group by status and scroll the virtual
  table to observe each group summary against independent exact oracles.

These describe the complete **authored** journey. The early actual campaign below
has executed only its prefix; the unexecuted suffix is not accepted. Selectors and
interactions are coordinated with implementation owners and reconciled against
actual controls. A failed early gate does not establish later coverage.

## Actual early campaign — 2026-10-22

Root granted serialized runtime slots against production source `6ca3aab8` and
matching frontend/native artifacts. Later listed HEADs contain harness-only fixes;
they do not represent new production behavior. Native host SHA-256:
`ab4065732635ff03bf520779e89b555e949b112bd43f8bb85007a394d7d2d33d`.

| Run / frozen HEAD | Observed result | Classification |
| --- | --- | --- |
| 001 / `6ca3aab8` | Initial 73-row table/formula and ordinary Create Base reached; 1 durable check/15 actions. Replacement appended to view name. | Harness omitted Cocoa `selectAll` dispatch; corrected with explicit keyboard editing command and proper CDP modifier bits. |
| 002 / `8d32d229` | Replacement, view creation and duplication saved; 3 durable checks/31 actions. Duplicate continued into new view settings. | Harness raced that intentional continuation; now waits acknowledged dialog state and reuses the open target. |
| 003 / `37c0c67a` | View lifecycle completed; 4 durable checks/47 actions. | Harness used legacy Add expression label; actual immediate route is Add filter → Edit expression. |
| 004 / `d056b089` | View lifecycle and advanced filter's exact 28-row oracle reached; 4 durable checks/60 actions. Removing the filter restored73 rows but lost focus to BODY, so Escape could not close its menu. | **Production keyboard/focus defect**, reported to toolbar owner/root. Screenshot and actual activeElement evidence retained; not bypassed with outside click. |

Evidence directories are `/private/tmp/zorid-bases-heavy-first-20261022-001` through
`004`, with sibling `.log` files. Each retains screenshots, disposable files,
action logs, exact durable assertions and process cleanup outcomes. Runs002–004
also verify source/artifact hashes after failure. All owned Electron/native
processes exited with no leaked children. Cleanup termination is not normal
application quit/restart acceptance. No complete heavy-user pass is claimed.

Before005, the journey was statically reconciled with the current integrated
controls: hidden initial summary footers open through header Summarize; visible
footer/group numbers are read from their value child; custom summary editing is
live, with no Apply; guarded table menus use the shared context menu. Resize
expects the actual auto-measured width plus10 and reaches its keyboard separator
through context-menu cancellation and Tab. Relation editing uses cell keyboard
activation so its link chip remains a navigation target. Kanban keyboard moves
assert the exact adjacent visible status rather than merely a changed value.
These are harness/source checks, not additional runtime acceptance.

The following safe-path update keeps exact independent raw-value oracles: new
Author Grace selection writes `[[/Author%20Grace.md]]` for this fixture's actual
root filename. The other71 source relations preserve their existing plain text.
After target rename, the new choice must become
`[[/Author%20Grace%20Renamed.md]]`, while an old alias becomes
`[[Author Grace Renamed]]`. Root owns the required frontmatter source-span and
rooted/escaped rename correction; the authored assertions are not proof of that
unexecuted behavior.

## Goal audit: concrete remaining acceptance

The following maps the complete goal sections to the authored desktop campaign.
It does not convert unexecuted code into acceptance or reduce the goal.

| Goal area | Authored actual journey | Concrete remaining boundary |
| --- | --- | --- |
| Query/config contract | Membership, view expression, formula lifecycle, typed values, search/limit, overall/custom/group summaries, unknown config/comments | Full function/null/date/regex/cycle matrix and native/WASM parity are root/core corpus gates; cancellation, partial coverage and unavailable metadata remain separately verified semantics. |
| Creation/view/config UI | Create Base, add/duplicate/rename/default/move/delete views, search, filters, formula and summary editors, property settings | Visual nested All views conditions, multi-sort ordering, manual group order/visibility/empty groups and display-name controls still need composed scenarios. |
| Rich definitions/relations | Scalar/select/multiselect/status/date/datetime/list edits; option label/color/order/remove/unknown; reverse relations/rollups, target rename/delete/unresolved | Tags/plain link controls, status category edits, multi-relations/target-filter rejection, external target move/copy identity witnesses and property-definition conflicts still need composed scenarios. |
| New | Literal full template, safe defaults/no template, collision handling, missing template, hover title/body, retained conflict/retry, close/normal reopen/restart | Create-in-group precedence and unreadable-template/uncertain native I/O outcomes remain. Normal title collision recovery is not native interruption proof. |
| Layout/editing | Four layouts, range paste/clear/undo/redo, raw/typed clipboard, header drag, resize/reset, Cards cover decode/settings, List settings, Kanban pointer/keyboard | Header/cell menu ordering/availability, pointer resize/auto-size, card modifier/middle-click, empty/null/list/folder Kanban group moves and failed/partial bulk recovery remain. |
| Embeds/lifecycle/export | Standalone, split consistency, sidebar active-note `this`, named file embed, fenced config source save, stale external file, normal quit/restart, full CSV export | Pending drafts across close/unmount, stale embed retargets/in-flight results, native I/O interruption/recovery, theme/scaling/keyboard accessibility and native Save dialog remain. |
| UI/logic reference | Zorid screenshot states and actual semantic assertions authored | Matching Obsidian artifact screenshots/executed reference interactions belong to the REA/reference lane; Zorid screenshots alone prove no parity. |

Remaining additions must either be executed through matching integrated surfaces,
retain explicit independent proof in their owning lane, or remain reported gaps.
Unsupported selectors are failures, not silent skips.

## Remaining scenario list

- Formula validation errors, display names and visual nested All views filters.
- Status category editing; tags/plain links and invalid-value correction.
- Table pointer resize/header menus; Kanban empty/null/
  list/folder groups; Cards covers/sizing, List markers/separators.
- Unreadable-template failure and create-in-group precedence.
- Close/remount pending drafts and stale embed retargets.
- Real native interruption/failure retained recovery, report actual atomic/partial
  boundaries and repeat safe retry; this needs integration-owner fault scheduling.
- Matched Obsidian reference screenshots/interaction evidence remains the REA/
  reference owner's independent lane. Zorid screenshots alone establish no parity.

Root supplies source HEAD/native/frontend freeze, exact binaries and runtime slot.
All heavy builds and app runs remain serialized. Only disposable fixture files
are modified. Artifacts include before/after hashes, action log, exact data
assertions, screenshots, renderer errors, native child identity and graceful exit.
No browser/mobile/sync/performance acceptance follows from this desktop pass.
