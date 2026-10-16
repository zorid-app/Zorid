# Bases Table implementation checkpoint

`src/bases/table-view.ts` is an original, imperative Table view over an immutable `BaseQueryResult`. This is a separately testable presentation module, not a completed Bases feature, host integration, or reference parity claim. No recovered source or assets are included.

## Reference basis

The implementation reuses the REA artifact identity and bounded observations in [bases-reference.md](bases-reference.md) and [bases-query-reference.md](bases-query-reference.md). Desktop reference: Obsidian 1.14.4, `app.js` SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, original E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. Restored extraction evidence: `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`.

Additional inert reads of that extracted artifact found:

- Table `columnSize` configuration is read by normalized property identifier near character 3213839.
- Row-height configuration near 3214348 multiplies a base height by 1, 2, 4, or 8 for default, medium, tall, and extra. The CSS default for `--bases-table-row-height` is 30 px near character 58915. Fixed row heights therefore have source support; these are not measurements of a running UI.
- Table virtual display near 3216019 accounts for grouped rows, collapsed groups, column widths, viewport bounds, and focused content. Reference auto-width measurement and horizontal virtualization are more complete than this module.
- Header listeners near 3192359 distinguish selection, context menus, resizing, and desktop/mobile header triggers. The new module does not present nonfunctional substitutes for those unavailable actions.

These are static observations from the reference, not target execution or pixel comparison. The DOM arrangement, event implementation, resource controls, and CSS in the new module are independently authored.

## Public contract

`createBaseTableView(container, options)` appends owned DOM and returns `update(result)` and idempotent `destroy()`.

Options:

- `result`: immutable query result; visible `properties` order and grouped row order are authoritative.
- `openFile(path, event)`: receives the original mouse/keyboard event, preserving modifier and middle-button information. The host chooses pane/window disposition.
- `editProperty({version, path, property, value})`: optional asynchronous mutation capability. The view has no filesystem access. The host must validate result version, file identity, writability, metadata type, and property identity before saving, then publish a fresh query result. Promise resolution alone is not treated as new query data.
- `getPropertyLabel(property)`: optional root property display-name resolver. It returns text, never markup. Root-level property definitions are not included in query results.
- `onError(error)`: optional error reporting; current edit errors also appear in the view's status text.

The primitive editor is enabled only for `note.*` properties on Markdown paths and only when the callback exists. File/formula properties and unsupported complex values remain read-only. Existing primitive type selects text, strict finite numeric conversion, or checkbox behavior. Existing multiline strings use a textarea, with Shift+Enter inserting a line break and Enter committing. Unchanged-control comparison preserves the original LF/CRLF/CR value without a write despite browser newline normalization. Empty text requests typed null, matching the observed empty-input normalization boundary; the host still owns missing-property semantics and metadata coercion. Null cells currently use empty text entry because metadata type information is not yet exposed. Unchanged text/number/null edits close without a mutation request; an empty existing string is not silently converted to null merely by entering and leaving its cell. Invalid numeric drafts do not trigger a write. Failed requests retain their draft; repeated Enter cannot duplicate a pending request. Composition Enter is ignored.

Passing the identical result object to `update` is a no-op. A replacement result invalidates the active draft and shows a cancellation notice; the host must avoid unnecessary replacement while typing. Draft rebasing across metadata refreshes is not implemented. An update invalidates existing editor generations and late completion UI, but cannot cancel host writes that have already begun. Version checks in the host are therefore mandatory. There is no claimed transaction, undo, concurrency-control, or persistence implementation in this module.

## Implemented presentation and resource boundary

- Sticky column header, ordered property cells, labels, filename links, typed primitive/list/object/date display and explicit errors for unsupported conversions.
- Namespace-backed `file.file` values display their safe name without invoking arbitrary namespace getters. Canonical open identity is always `row.path`.
- Group heading/collapse and counts. Collapse state currently resets on query update. Group headings currently use the data-row height multiplier as an original simplification; the reference measures group geometry separately. Tall/extra group-heading spacing is not claimed to match.
- Keyboard cell focus using arrows and Home/End; Enter opens file columns or begins a supported property edit. This is a useful keyboard foundation, not complete reference selection equivalence.
- Query option row-height multiplier and stored normalized column sizes. The CSS base height is read at initialization/resize.
- Row-window DOM bounded by viewport rows plus ten overscan rows and at most one pinned active editor row. A missing layout height uses a 600 px fallback for initial rendering. Headers/columns are not horizontally virtualized; the flattened item array remains O(result rows).
- Scroll rendering is coalesced by animation frame. An active editor stays mounted while scrolling. Resize observer, scheduled frame, owned DOM, and scroll handler are disposed. Detached/stale file links cannot call the host after an update/destroy.

## Verification

`node --test --test-concurrency=1 tests/bases-table-view.test.ts`: 18 passing focused tests at this checkpoint. Targeted strict TypeScript checking passes. Tests cover visible ordering/escaping, modifier and middle-click forwarding, invalid numeric/composition handling, failed and duplicate requests, replacement during a pending request, first-click checkbox mutation requests, unavailable editing, non-Markdown guards, a 10,000-row bounded DOM window, group navigation/collapse, safe unsupported value display, pinned draft scrolling, and teardown. Follow-up fixtures cover multiline value preservation, pinned editor geometry after resize, stale group controls, and cancellation notices when results become empty.

The tests use JSDOM. They do not measure browser layout, pixel identity, actual viewport timing, native input, mobile touch, accessibility behavior in a screen reader, real frontmatter persistence, or performance against Obsidian.

## Remaining required parity

- Workspace/Base controller mounting, query-refresh lifecycle, real frontmatter edit/undo transactions and persistence after reopen.
- Complete metadata-type widgets, links/tags/date/list editors, rich values, property labels/types from the host, and error-widget parity.
- Header menu ordering/actions, sorting, adding/removing properties, resizing/reset/automatic width, column drag reorder and persisted settings.
- Multi-cell selection, range selection, clipboard formats, copy/paste coercion, row/file context menus, summaries, create-item controls and undo/redo.
- Group geometry/gaps, repeated/sticky group headers and summary rows, stable group collapse across updates, selection identity when a path occurs in several groups.
- Automatic column sizing, horizontal virtualization, direction-aware geometry, exact CSS/style, mouse selection/drag behavior and mobile interactions.
- Native comparison, theme/zoom/font changes, real large-vault profiling, and integration tests with the finished query engine.
