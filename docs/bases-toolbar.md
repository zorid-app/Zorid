# Bases session toolbar

Isolated implementation from main `3fba86b`, in branch
`tingkai-c/editor-bases-toolbar`. Main integration, browser/native geometry and
mobile verification are separate gates. The shared-core coordinator retains
sole main integration and heavy-build scheduling.

## Behavior

The shared session exposes its existing local view selector and result count,
then Sort, Group, Filter, Properties and View options. Each configuration control
opens a staged panel with Apply and Cancel. No notes are rewritten by these
configuration actions. Read-only sessions keep local view selection but omit
mutation controls.

- Sort supports multiple property criteria, ascending/descending order, moving
  a criterion earlier, removal, and clearing all explicit sorts. Existing unknown
  criterion fields survive edits.
- Group selects a property and direction. Changing the property explicitly
  resets manual group visibility/order; changing direction preserves it. An
  existing unavailable property remains selectable, preventing accidental reset.
- Filter preserves nested all/any/none groups and existing expressions. Simple
  property conditions use quoted property access and typed literals; other
  expressions remain editable as expressions. Base-wide filters are disclosed
  and preserved. Changes affect the selected view only. Invalid typed input stays
  present until corrected or its condition is explicitly removed.
- Properties supports searchable visibility and keyboard-accessible earlier/later
  ordering, retaining existing unknown configured properties. Search displays at
  most 100 matching properties.
- View options selects one of the four implemented layouts and renames ordinary
  index-bound views. Named-view embeds omit rename because their identity follows
  a configured name; changing that binding is outside this toolbar batch.

New-file creation, view creation/deletion, summaries, export and text search are
not exposed as placeholder controls. Those capabilities need separately scoped
host/action contracts. Existing Kanban Edit columns remains in its view.

## Persistence and lifetime

`toolbar-config.ts` validates a bounded detached patch containing only the
fields this toolbar owns. It does not redesign the query or parser. Configuration
flows through the existing revision-guarded `BaseController.updateView` and shared
`NoteBuffer` mutation host. Original YAML comments, unrelated options and note
bytes remain owned by those existing layers.

Property drafts/pending operations prevent opening or applying configuration.
A staged toolbar draft prevents view switching and teardown. Query refreshes
are deferred while a draft or save is active. Cancel closes only the staged UI;
it never rolls back an accepted shared-buffer draft.

Action rejection retains editable fields. A failure after an accepted transform
retains the exact buffer draft and offers an explicit persistence retry. The
retry checks path and captured text, flushes that buffer, then refreshes; it does
not replay a stale patch. Newer shared edits reject the retry and remain intact.
Successful host flush acknowledgement clears only the captured failed panel,
not a later draft/error. Close rejects if unsaved or invalid edits remain.

Panels use the owner document, clean up their listeners/observers, and restore
owned focus without taking it from another pane. Panels are portaled to the
document body and clamped to the viewport. Toolbar labels collapse below a
590-pixel pane width; below 360 pixels the actions wrap to a second row. These
CSS rules require real browser/native visual verification; jsdom tests do not
establish layout fit.

## Reference provenance

Reference: installed Obsidian 1.14.4 extracted `app.js`, SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
Matching `app.css` SHA-256:
`866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`.
The REA workflow reused the matching prior extraction; this pass used focused
inert artifact reads, not new runtime or semantic-tool evidence. Source bodies
were not copied into the implementation or this repository.

Bounded observations:

- `app.js` offsets 2534400–2538600: toolbar construction orders view/result
  controls, sort, group, filter, properties, then other actions.
- `app.js` offsets 2517000–2521000: result actions and search behavior are real
  actions; their presence is not justification for decorative replicas.
- Matching extracted `app.css` around offsets 451193 and 449662: flex toolbar
  with text labels that collapse under 590 pixels. Around 455427: bounded menu
  sizing/scrolling. Around 57238: 40-pixel header variable.

These offsets describe the pinned extraction only. They do not establish exact
menu behavior, runtime hit targets, mobile interaction, or visual parity. The
original responsive panel implementation prioritizes usable Zorid controls.

## Verification checkpoint

The pure configuration helper has 11 focused passing tests, including detached
patch validation, recursive limits, unknown-field preservation, safe literal
construction and execution through the real query engine. The existing session
suite passes 10 tests. Independent UI review supplied seven regression tests; its last pre-fix run
passed five and exposed group-alias and unavailable-sort-default issues. Both
are now corrected in source, awaiting the shared test slot. Actual-session
action fixtures are in progress. TypeScript passed before the last reviewed
source fixes and standard Lucide icon additions; rerun it for the final candidate. No production build or native pass has run for this
branch.
