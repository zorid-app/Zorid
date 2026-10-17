# Bases Kanban renderer

Original implementation in `src/bases/kanban-view.ts` and `.css`. The renderer is integrated through the Bases session and workspace. Basic native Table/Cards/List/Board navigation and property persistence have been observed; that does not establish full Kanban or native interaction parity.

## Evidence

Reuses the REA extraction and static findings in `docs/bases-reference.md`: desktop 1.14.4 app.js SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, Evidence `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. This pass read the restored extraction, without executing it. Static ranges 3154907–3156600 show grouping guards and property/folder move transactions; 3159429–3161500 show pending reconciliation; 3168152–3169000 show move failure handling. This is additional bounded interpretation, not a new REA execution trace.

Observed guards: a grouping property is required; formulas and file properties except `file.folder` are read-only; property writes require Markdown files; folder grouping accepts any file. A folder destination must be a string and resolve to a real folder. Property writes use frontmatter transactions, delete the property for null, preserve list destinations, and wrap scalar destinations for inferred multitext properties. Those latter metadata conversion, validation and transaction responsibilities belong to the host, not this renderer. The renderer previews pending cards in the destination without mutating query data; failure removes the overlay. A focused follow-up at 3169815 shows this overlay strategy and the result-order insertion rule used by the reference.

Static stylesheet observations inform the original layout: 280px default column width, 200–500 option range, 8px column spacing, 12px outer padding, 24px property lines, bordered rounded columns on the primary alternate background. Exact theme geometry, card measurement, covers and native appearance remain unverified.

## Contract

`createBaseKanbanView(container, { result, openFile, requestMove?, onError?, readOnly? })` returns `update(result)`, `move(path, typedDestination)`, and idempotent `destroy()`.

Results are immutable caller-owned query snapshots. Group membership comes from query snapshots. The Kanban-specific projection puts the null group first in automatic order, matching static 3159690–3161106; explicit order instead includes listed `groupOptions`, preserving empty columns and excluding hidden unlisted groups. Lists remain one composite key; no scalar expansion occurs. JS-null groups are not grouped columns; typed-null keys form the empty-value column. `requestMove` receives path, version, grouping property, source key and destination key. It must reject stale versions and perform a real vault transaction; `file.folder` requires moving the file through the existing vault/file-manager operation. Other supported properties require preserving frontmatter and adapting metadata types. This module must not be mounted with a callback that only modifies DOM or mutates query results.

A destination preview remains pending after callback success until a query update removes the file from its original group. Duplicate moves for that path are blocked. Callback failure clears its current pending marker and invokes `onError(error, request)` with visible feedback; old failures after regrouping, removal or destruction do not overwrite newer state. An unrelated query update retaining the source membership preserves the pending lock. Successful persistence followed by a failed query refresh therefore needs host recovery: there is no invented timeout that could enable a duplicate write.

Header counts remain authoritative query counts while cards preview a pending move; the packaged header render at 3171671 uses original group entry counts separately from the preview projection.

Grouping property IDs use the shared query normalization helper. Automatic search-group caching remains a gap because the current snapshot contract has no search-active flag; counts alone cannot distinguish an active search matching every row.

The renderer uses scroll-driven horizontal column and vertical card windows, not user-visible pagination. Row sizes currently derive from fixed 24px property lines; text is truncated instead of wrapping. The independent review caught and cleared stale retained controls, drag-end ownership after virtual unmount, and scroll restoration before the height spacer exists; permanent regressions cover each. No full-suite/build/native checks were run here. JSDOM tests cover callbacks, failure and stale lifetimes, typed lists/null, mutation guards, bounded mounting, scrolling, and selection persistence/removal. Scoped TypeScript validation covers the implementation and dependencies.

## Remaining parity

- Full mutation/undo parity: shared-buffer property writes and guarded folder moves are integrated, but metadata-registry scalar conversion and broader native race coverage remain incomplete.
- Shared property rendering, image covers and image options, measured theme-dependent sizes.
- Drag-hover previews and direct board-header column dragging; typed new-group and new-note controls. The Edit columns popover now supports manual ordering/visibility, pending integration/native verification.
- Matching context menus, hover links, text/link interactions, drag autoscroll/ghosts, keyboard and touch interactions, read-only visual affordances.
- Native Electron/mobile validation and large-vault profiling; bounded DOM is not proof of acceptable rendering latency.

## Edit columns controls

The original `kanban-columns.ts` helper adds an **Edit columns** entry to the board and **Hide column / Edit columns** to editable column-header context menus. The helper only requests a versioned configuration patch; it never writes note frontmatter. A session adapter routes requests through the existing shared-buffer controller, retaining unknown `.base` keys and configuration comments as supported by the document model. The companion adapter is tracked separately; this implementation must not be described as live until its session wiring is integrated.

Static reference evidence from the same artifact:

- `zJ` at 2490030 filters rows against configured `groupOrder`, and the runtime query notification at 2543550 invokes it before search. Thus `groupOrder: [Todo, Done]` deliberately hides an `In progress` note from that view; automatically inventing a new visible column would contradict the reference.
- `WJ` at 2490466 returns listed groups separately from unlisted rows. The Kanban manual branch at 3159690 uses those listed groups including empty columns.
- Group menu implementation `ZJ/JJ` starts at 2501697. Manual mode displays visible rows first, then sorted hidden rows, each with a checkbox/count and drag grip. Clicking a row toggles visibility. Alt+Up/Down moves the selected checked row; Hide all/Show all changes checked states. Saving serializes checked rows in current order and appends unmatched stored order entries.
- Returning to automatic sorting removes `groupOrder`; returning to Manual during the same open menu restores the previous manual order, or initializes an empty order if none was remembered. Closing the menu clears that temporary remembered order.
- Header context-menu wiring near 3167670 exposes Hide column followed by Edit columns. These two implemented actions are only a subset: the reference also has new-note actions which still need a host capability.

The helper keeps existing empty menu rows through its own hide/show save acknowledgements, so Hide all followed by Show all in the same menu does not lose empty configured columns. New snapshot versions invalidate stale failures/drag gestures. Pending saves disable duplicate controls; failed saves restore authoritative checked states and display an error. If the shared buffer retains a failed disk write, the session still owns the recovery draft; retry/close behavior follows the controller's recovery contract rather than discarding the draft.

Focused tests cover the exact missing-group fixture, retained unknown configuration, checkbox/hide-all/show-all, Alt-arrow and drag reorder, automatic/manual toggling, rejected/pending/stale operations, teardown and read-only visibility. Scoped TypeScript passes. Native placement, menu styling, real pointer dragging, accessibility and mobile verification remain pending. Property chooser changes, typed Add group widgets and complete native header menu contents remain explicit gaps; no custom data-type registry was invented.
