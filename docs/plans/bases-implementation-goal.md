# Bases implementation pass

Updated 2026-10-21. Status: **implementation in progress; composed runtime acceptance pending**.
This is the current feature scope and completion checklist for this pass. Follow
the [roadmap](../roadmap.md) for other milestones. This document supersedes older
Types/Bases designs and combined Bases/Tasks/Calendar implementation assignments.

## Goal and settled decisions

Deliver fully usable local Bases over ordinary vault files, using the shared Rust
core and TypeScript workspace. Match **Obsidian 1.14.4 Bases appearance and
interaction** as the initial target, including menus, editing, keyboard behavior
and all four built-in layouts. Approved template difference: **New copies the complete
configured template note, properties and body, rather than only its properties**.

- Files own content and properties. Bases own saved selection/configuration;
  views own presentation. Multiple Bases can select the same file.
- Membership uses folders, tags and ordinary properties. `type: book` is ordinary
  user data. Named note Types, Type registries/editors and mandatory schema
  assignment are removed from the product design.
- Property value definitions remain: text, number, checkbox, date/datetime,
  lists/tags/links, select, multiselect and status. Rich property definitions and
  relations are Zorid additions to the reference, not evidence Obsidian has them.
- Relations, reverse relations and rollups are required work in this pass; exact
  persistence/identity rules must be settled before their code is written.
- Existing storage/index/save services are prerequisites already available, not
  reasons to wait for broad managed-data services or sync implementation.
- Desktop/macOS Electron is the product acceptance target. Exercise shared
  semantics in native Rust and actual browser/WASM; web and standalone CLI must
  retain their existing supported paths. Native mobile, other OS runtime parity,
  Tasks, Calendar, recurrence, Google, sync and public plugin frameworks remain
  later work. A Base's local date/relation fields do not activate those features.

## UI fidelity and retained improvements

Latest direct steering: use REA heavily throughout implementation, not just for
initial research. Obsidian is also the logic reference: inspect its concrete
implementation and corresponding runtime scenario before inventing behavior for
filters, defaults, grouping, conversion, clipboard, undo or other ambiguous cases.
Preserve agreed improvements and documented core correctness guarantees. Exact reference UI/UX is the default for existing Bases
features; the agreed improvements below remain requirements, not parity defects.

- Inspect each feature's shipped implementation with REA before building it;
  reuse retained evidence and inspect focused areas rather than repeatedly
  analyzing the entire bundle. Follow up unclear behavior with runtime scenarios.
- Match layout, spacing, typography, sizing, icons, menu structure/order,
  popover placement, focus, selection, shortcuts, pointer/drag interactions,
  disabled states and empty/error states against the identified reference build.
- Compare corresponding reference/Zorid screenshots and executed interactions
  during each UI batch. A similar-looking default screen is insufficient.
- Preserve full literal template copying, richer property definitions including
  select/multiselect/status, and relations/reverse relations/rollups. Use the
  reference's visual language and interaction conventions for these additions.
- Record each intended addition/deviation and its user-facing reason alongside
  reference evidence. Fix accidental differences; exact matching must not remove
  agreed capabilities or weaken storage, stale-edit and recovery guarantees.

## Readiness, ownership and reference baseline

- [ ] Reconcile this scope with current main, retained branches and actual source;
  [Bases status](../bases-status.md) is historical evidence, not a current audit.
- [ ] Inventory old named-Type consumers. Remove Type requirements from generic
  Bases/property flows; preserve existing user files. Record deferred Task/Calendar
  dependencies without silently rewriting those features or deleting their data.
- [ ] Establish named ownership for Rust queries/contracts, property commands,
  TypeScript configuration/UI, and workspace/editor/bridge integration. Use
  isolated worktrees and the existing sole-main-integration protocol.
- [ ] Build a feature/scenario matrix from [reference inventory](../reference/bases-reference.md),
  [query inventory](../bases-query-reference.md) and [recent research](../reference/bases-mental-model.md).
  Use REA on the identified shipped artifact; resolve static unknowns through
  actual reference scenarios. Keep proprietary recovered code/assets outside
  project source. Record version/hash, screenshots and observed interactions.
- [ ] Capture toolbar, popovers, menus, table geometry, all layouts, selection,
  drag/drop, focus and keyboard behavior in matching reference fixtures. Record
  each deliberate Zorid extension separately from reference parity.

Completion: every required capability below has an owner, baseline observation,
implementation status and named acceptance scenario. Unobserved reference behavior
is explicit; a static method/registration is not runtime proof.

## 1. Shared query and configuration contract

- [ ] Use one vault-wide committed-file index, including applicable non-Markdown
  files; distinguish index exclusions from Base filters and unavailable metadata.
- [ ] Compile/evaluate Base-wide AND view filters in Rust, including nested
  AND/OR/NOT and advanced expressions. Keep selection independent of creation.
- [ ] Complete the reference expression/function matrix: value types, null/error
  rules, conversions, regex, date/timezone/duration behavior, formula references,
  cycles and rich output values. Specify existing deliberate semantic deviations.
- [ ] Rust owns visible-property search, sorting, grouping, group identity/order/
  visibility, limits, counts, summaries and formula results. Preserve exact
  pipeline ordering and the distinction between filtered and displayed results.
- [ ] Add built-in/custom summaries to Rust results and transport. Define group
  versus overall scope and behavior under saved limits, partial coverage and
  presentation paging. Never aggregate only the currently mounted DOM rows.
- [ ] Return typed values, file identity/revision, diagnostics, coverage and refresh
  information through native/WASM bindings. Validate explicit clock, timezone and
  `this` context; preserve cancellation/resource bounds and pin release.
- [ ] Keep TypeScript query code as presentation/adaptation on supported core
  paths. Inventory the legacy fallback and resolve its supported-host policy;
  do not quietly run conflicting evaluators after a Rust error.
- [ ] Preserve `.base` configuration, unfamiliar fields and supported source
  formatting through targeted edits. Invalid source remains editable/saveable
  with actionable diagnostics. Preserve unknown view definitions without deleting
  them when their renderer is unavailable.

## 2. Create Bases, manage views and configure results

- [ ] Normal Create Base entry points, sensible blank defaults, collision-safe
  naming, opening, rename/move and deletion through existing file services.
- [ ] Add, duplicate, rename, delete and reorder named views; first/default view
  behavior and named-view fragment handling match the observed reference.
- [ ] Complete shared toolbar: view menu/settings, Results, Sort, Group, Filter,
  Properties, Search and New; match reference labels, ordering and availability.
- [ ] Visual and advanced filters for both All views and This view; property-aware
  operators, nested groups, correct values and preservation of advanced expressions.
- [ ] Multi-property sort ordering; grouping, automatic/manual group order,
  visibility, empty groups, collapse/expand and reset behavior.
- [ ] Property visibility/order/display names; formula create/edit/rename/remove
  with diagnostics; result limits and per-layout settings through normal UI.
- [ ] Classify saved configuration versus local scroll/selection/active session
  state. Reopen/restart restores the intended state without saving every click
  into shared configuration or allowing one embed's transient state to leak.

## 3. Rich property definitions and relations

- [ ] File-backed property settings shared by note-property UI and all Bases;
  editing controls are driven by property value definitions, not named note Types.
- [ ] Text, number, checkbox, date/date-time, list, tags and links render/edit
  consistently. Missing properties stay missing until edited; unrelated note
  fields survive. Preserve incompatible values with visible diagnostics.
- [ ] Select/multiselect option pickers, creation/rename/reorder, colors, removal
  and unknown-option handling. Status adds semantic categories and editable labels.
  Define stored option identity and rename migration before implementation.
- [ ] Relations provide single/multiple note pickers, optional target filters,
  clickable presentation and explicit missing/unresolved target states.
- [ ] Resolve/index relations in Rust using stable entry identity. Decide how
  readable file links retain identity across rename/external move/copy/deletion;
  do not equate a path string with an immutable foreign key.
- [ ] Derive reverse relations and implement related-property lookup/rollups in
  Rust. Define cardinality, empty/missing/error behavior and dependency invalidation.
  Rollup values are derived rather than separately authoritative note data.
- [ ] Preserve external-file edits, dangling links and unknown properties. Avoid
  cascading deletion; deleting a related note must not delete referring notes.

## 4. New item and full template copy

- [ ] New creates an ordinary Markdown note from file tabs and embeds, including
  create-in-group/column where the reference offers it. Support configured folder
  and template paths, safe collision handling and normal open/focus behavior.
- [ ] With a template, copy its complete text, including frontmatter and body;
  retain literal placeholders. Template expansion/scripting is outside this pass.
  Leave the template unchanged and preserve its supported formatting.
- [ ] Without a template, apply explicit defaults and only safely derived filter/
  group values. Complex predicates must not invent arbitrary property values.
- [ ] Make template/default/group precedence explicit before implementation. Treat
  full template copy as the baseline: conflicting filter defaults must not silently
  rewrite template content. Explain when the saved note lies outside the view.
- [ ] Missing/unreadable template or invalid destination has a clear error and no
  silent blank-note fallback. Failed/uncertain creation retries reconcile one
  operation instead of producing duplicate notes or losing the draft.
- [ ] Preserve observed configuration access. If the reference lacks a native
  template picker, document any added picker as a Zorid extension, not parity.

## 5. All four layouts and shared editing

| Layout | Required work and completion behavior |
| --- | --- |
| Table | Rich cells; cell/range/row/column selections; reference header/cell menus; column drag/reorder/resize/reset/auto-size; row height; keyboard editing; rectangular copy/paste/clear; group/overall summaries; create/open/file actions. |
| Cards | Image property, size, fit and aspect ratio; visible property order; grouped/collapsible cards; link/text interaction; normal/modifier/middle-click opening; hover/context actions and file dragging. |
| List | Bullet/number/none markers; separators and property indentation; visible property order; grouped/collapsible sections; link/open/edit/context behavior. |
| Kanban | Rich cards/covers; width/image options; status/property grouping; empty/hidden/reordered columns; create in column; pointer and keyboard moves; list-valued/null groups; folder-group file moves; pending-move failure reconciliation and observed card-order behavior. |

- [ ] Common property widgets and shared commands serve every renderer. Keep
  virtualization and image-lease disposal; local drag previews commit semantic
  commands rather than persisting DOM order as data.
- [ ] Route edits through existing NoteBuffers/workspace save boundaries, carrying
  original file identity/revision. Preserve dirty body content, caret, editor undo,
  comments and unrelated properties; reject stale/path-reused targets safely.
- [ ] Implement Base command undo/redo for property edits, bulk paste/clear and
  moves. Reversal checks current state and never overwrites intervening edits.
- [ ] Bulk operations report their actual atomic/partial-success boundary and
  recovery behavior. Do not imply multi-file atomicity from a single-file CAS.
- [ ] Inspect/write reference clipboard formats where supported, plus TSV/Markdown;
  define coercion, mixed/read-only cells and invalid paste behavior. Text inputs
  retain their own selection, clipboard, IME and undo ownership.

## 6. Embeds, exports and lifecycle

- [ ] Standalone files, `.base#View` embeds and fenced `base` configurations use
  the same session/controller. Fenced changes update the original Markdown block.
- [ ] Embedded `this` means the correct containing note; standalone context uses
  the correct Base. Rename, fragment changes, split reuse and stale mount results
  must not retarget an active edit.
- [ ] Sidebar-mounted Bases follow the reference's active-main-note `this`
  context. Verify switching main notes, pinning and closing panes, context refresh
  and stale in-flight results without retargeting retained edits.
- [ ] Draft/save guards, navigation/close, detach/remount and restart retain or
  settle pending work. Unmount releases subscriptions, pins, timers and image
  leases without throwing away unresolved writes.
- [ ] Copy/export current results to CSV/TSV/Markdown/paths where supported by the
  reference and existing CLI. Export the defined result set, not a silent 1,000-row
  materialization cap or visible viewport. Define escaping and incomplete coverage.
- [ ] Refresh across note/property/config changes, creates, moves, deletes and
  time-dependent formulas. Other Base views and open note buffers agree after save.
- [ ] Keyboard traversal, focus return, screen-reader labeling, resize, dark/light
  mode and display scaling work with the reference interaction model. Native
  mobile/touch acceptance remains in its later milestone.

## Execution sequence and acceptance

Latest explicit user requirement: run a full actual heavy-user end-to-end pass.
Use automation against the actual Electron UI, with screenshot inspection for
visual fidelity. Exercise a sustained composed workflow rather than isolated
components or only service calls. Cover creation/templates, all layouts and
rich properties/relations, bulk clipboard/undo, splits/sidebar/embeds, moves,
external edits/conflicts, close/restart and exact durable readback. Retain the
script, fixture definition, artifact/source identities, results and screenshots.
Failure recovery and repeated actions belong in the same real-user journey.
This functional campaign does not reopen deferred large-vault performance budgets.

Implement in order: local contracts/reference scenarios → creation/config/view
management → property widgets and commands → layout interaction completion →
relations/rollups/summaries → embeds/export and composed acceptance. Independent
bounded implementation/review can run in parallel after shared contracts/ownership
are agreed; heavy builds stay serialized under repository resource instructions.

For each batch record owner, branch/worktree, dependencies, reviewed commit,
integrated commit, exact tests/scenarios and unresolved gaps. The existing
shared-core coordinator retains sole main integration. This goal file creates no
new integration-owner assignment and does not claim a feature is implemented.

- [ ] Actual Electron: create a Base, choose membership and columns, create notes
  with/without a full template, manage named views and edit all property types.
- [ ] Actual Electron: selection/paste/undo, resize/reorder, summaries, all four
  layouts, Kanban moves and relation/rollup updates match recorded scenarios.
- [ ] Actual Electron: standalone/split/sidebar/file embed/fenced embed, external edits,
  stale writes, failures, close/reopen and restart preserve content/configuration.
- [ ] Focused native Rust and actual browser/WASM corpus checks cover changed
  query/value/relationship/summary boundaries with independently authored oracles.
- [ ] Actual web and independent CLI checks cover their affected existing query/
  edit/export paths; report supported scope separately from desktop UI acceptance.
- [ ] Independent review resolves data-loss, stale identity and material reference
  differences. Matching screenshots plus executed interactions establish visual/
  behavioral parity; compilations and component tests alone do not.
- [ ] Update current status and findings; integrate confirmed batches into main
  through its owner. Mark accepted only when the required scenarios pass or the
  user explicitly changes scope. New performance/stress campaigns remain deferred.

## Decisions to settle within the owning batch

Property settings file location/name scoping; readable labels versus stable option
IDs; relation link/identity persistence; rollup expression/configuration syntax;
template/group/default conflict handling; clipboard/bulk undo atomicity; existing
named-Type source retirement and legacy fallback support. Record decisions with
their affected source and acceptance cases; none is permission to delay unrelated
work or to restart broad Tasks/Calendar/plugin architecture design.

## Composed acceptance checkpoint — 2026-10-21

The [current reference evidence and deliberate-difference ledger](../history/bases-pass-reference-20261021.md) records the shipped-artifact REA analysis and 51 actual Obsidian capture pairs. Component/native checks are evidence for their named boundaries only; actual composed Electron, browser/WASM and CLI acceptance remains pending.

- [ ] Custom summaries support live expression editing, name changes that update selections across every view, and deletion that removes matching selections without damaging unrelated settings. Preserve collision and empty-name guards.
- [ ] Named-view embed rename updates its fragment binding and relevant references; hiding rename to preserve the old binding is an open gap.
- [ ] Group/column dragging includes the observed live insertion/reorder preview; persisting final order alone does not close this interaction requirement.

The reference ledger distinguishes the directly approved full-template improvement from deliberate safety choices requiring explicit verification: last-view deletion protection, correct per-column clipboard mapping, conditional touched-property undo, and stable resolved-target linksTo identity. These differences do not establish visual or runtime completion.
