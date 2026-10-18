# Cards and List implementation checkpoint

Current status: standalone workspace mounting and guarded shared-buffer property
writes are now integrated. See [the workspace checkpoint](bases-workspace-integration-checkpoint.md)
and [current Bases status](../bases-status.md). Older module-only verification below
is historical and does not imply those host features are still missing.

These are original, independently implemented view modules. They consume the immutable
`BaseQueryResult` contract and do not open vaults, evaluate queries, write `.base` files,
or load thumbnails without explicit host callbacks. This checkpoint is not native,
mobile, visual, integrated workspace, or complete Bases parity certification.

## Reference evidence

This work reuses the REA extraction and artifact identities in `bases-reference.md`:
Obsidian 1.14.4 desktop `app.js` SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`,
E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`,
and restored extraction `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`.
The focused inert readings here cover decoded character offsets 3142260–3152425
and 3175752–3189534, plus the corresponding Cards/List CSS declarations in the
same packaged release. No reference code was executed or copied into the project.

Observed static contracts used here:

- Cards default target width 200, positive configured `cardSize`, normalized `image`
  property independent of displayed properties, cover/contain fit, positive image
  height-to-width ratio with default 1. Column count uses available width divided by
  target size, and distributes the remaining width across columns.
- Cards render the ordered properties, with the first property as title and later
  properties labeled. Group collapse and viewport-limited mounting are separate from
  query filtering. Click/middle click keep modifiers, protect active child editors,
  link handlers, and noncollapsed text selections whose endpoint is inside the card.
- List default markers are bullets; supported options are `bullet`, `number`, `none`.
  `indentProperties` defaults false. A falsey separator defaults to comma plus space.
  Null, empty strings, and empty lists are omitted; false and zero remain. In indented
  mode an empty first configured property suppresses the row, and remaining visible
  properties become bullet children. Numbering counts displayed rows per group.
- The reference uses measured virtual layout for List and measured card metrics. Its
  exact CSS metrics, text width, theme scale, scrolling, and native input behavior
  have not been reproduced by a runtime fixture in this pass.

## Host API

`createBaseCardsView(container, options)` and `createBaseListView(container, options)`
return `{ update(result), refreshLayout(), hasActiveEdits(), destroy() }`. Each owns one child scroller;
its container must receive a bounded height from the host. Import `cards-view.css`
and/or `list-view.css` when mounting. `update` replaces the result atomically once active edits settle and invalidates old
widget/thumbnail owners even when the host reuses a version. While a draft, IME
composition, or primitive write exists, only the latest requested result is queued;
the original result version remains attached to the editor's write callback.

Both accept:

- `result` and `openFile(path, MouseEvent | KeyboardEvent)`. Original native events
  preserve modifiers. Cards open on background click/middle click and Enter; List
  opens through its file-name link, not arbitrary row text.
- Optional `getPropertyLabel(property)` for root-config display names.
- `hasActiveEdits()` and optional `onEditStateChange(active)` let the host defer
  selected-view replacement and closing. `destroy()` remains explicit forced cleanup;
  the host must not destroy a view with recoverable drafts during an ordinary switch.
- Optional `renderProperty(element, { row, property, value, version })` returning a
  disposer, for the host's full metadata/link/value registry. It replaces the default
  primitive renderer; it must use the supplied version for writes and release all
  resources in its disposer. Custom widgets mark recoverable drafts/pending writes
  with `data-base-editing` on their element/descendant and clear that marker only on
  settle/cancel, so the common virtual surface can defer replacement and pin them.
- Optional `editProperty({ version, path, property, value })`, `onError(error)`.
  Default editing is limited to note properties on Markdown files: booleans and
  text/number/null input. The host is responsible for write authorization, metadata
  type coercion, undo transactions, and rejecting stale versions at commit time.
  Failed primitive edits retain their draft for retry or Escape; accepted checkbox state is retained for a later rollback. View guards prevent stale controls from initiating writes or redrawing new results.
- Optional context-menu, hover-file, and drag-file callbacks. Cards provide all three;
  List currently provides context-menu/hover callbacks. Menus themselves remain a
  host responsibility and are not presented as reference-complete.

Cards additionally accepts `loadThumbnail({ row, property, value, version, signal })`.
It returns a promise for `{ url, dispose() }` or null. The host resolves permitted
resources and owns URL revocation. Cancellation is signaled on retirement. A resource
resolving after update/scroll removal/destruction is disposed without insertion.
The query engine supplies the configured image property in `row.values` even when
it is not in the visible order.

## Performance and lifecycle

`presentation-common.ts` owns a visible window with 300 pixels of overscan and keeps
focused units and marked draft units mounted outside that window. A Fenwick height index supports
logarithmic measured-height updates and visible-index lookup. One ResizeObserver
watches the scroller and mounted units only. Scroll renders are animation-frame
coalesced. Measured changes above the current anchor compensate scroll position.
Snapshot/width changes rebuild the O(n) unit index once drafts settle; scroll does
not scan every row. One subtree MutationObserver observes only child changes and the
edit marker attribute, coalesces edit-state notifications, and releases deferred
refreshes. Failed/unfocused drafts remain pinned during scrolling. IME blur waits
for composition end and the final input task before attempting a write.
Large query evaluation remains the query engine's responsibility.

The Cards layout uses fixed initial metrics; List rows are measured when mounted.
This differs from the reference's incremental measurement scheduling and adaptive
overscan. A 10,000-row List fixture proves bounded DOM in jsdom, not real-device
performance or a matching reference latency/memory budget.

## Remaining gaps

- The workspace selector and shared session are integrated. Full view settings/property
  ordering UI, persisted view state, embeds, complete context menus, hover previews,
  note drag formats and drop actions remain incomplete.
- Full property widget/coercion registry, rich links, Markdown values, lists/tags,
  date/datetime controls, plugin renderers, transaction undo, and failed-write UX
  must be supplied or implemented; primitive rendering is not full metadata parity.
- Resize/query/group-collapse replacement now waits for active/failed drafts or
  pending writes. This original preservation policy is not a native reference
  interaction certification. An unresolved draft can defer presentation refresh
  indefinitely; the host must communicate write conflicts and offer retry/cancel.
  Reference keyboard navigation, selection semantics, mobile touch, CSS-theme card
  scaling, and ephemeral scroll state still need work and native verification.
- Query groups/rows retain the engine's ordering. List-valued group keys are composite
  keys, not membership expansion. No grouping mutation or persisted collapse option
  is invented. Collapse state is local and retained across updates.
- Reading/external link image parsing and thumbnail generation are not implemented
  here; loading is an explicit host capability. No browser network request occurs
  without a URL supplied by that capability.

Validation: 16 focused serial tests cover settings, ordered properties, event
modifiers, text selection/editor protection, List omissions and numbering, nested
markers, group collapse, asynchronous thumbnail retirement, 10,000-row virtual
mounting, write-version boundaries, edit failures, repeated edits, null/unsupported values, invalid numeric drafts, bounded observer
subscriptions, and measured scroll anchoring. Focused strict TypeScript passes.

## Draft preservation follow-up

At root checkpoint `5e2e1d9`, a read-only jsdom probe reproduced active and failed
drafts disappearing on query or layout replacement in both views. The follow-up
keeps the current DOM and original write revision until save/cancel; it does not
rebase a stale write onto a new snapshot. The controller must perform the actual
compare-and-set validation. Group collapse/layout requests queue without retiring
the editor, and a pending checkbox stays marked through callback completion and
DOM restoration. Escape during an in-flight write cannot remove its owner.

Validation: 43 focused serial tests (16 original, 13 independent prior review,
14 new preservation cases) and focused strict TypeScript pass. New cases cover
latest-result queuing with the original version, failed/unfocused draft pinning
through resize/collapse/scroll, final IME text after blur, pending checkboxes, and
custom marker lifecycle. Two older tests now explicitly cancel a draft before
asserting retirement rather than expecting destructive query replacement. Native
IME, mobile keyboard, and integrated controller behavior remain separate gates.

Independent review additionally found that a custom widget throwing after marking a
draft could strand that marker. Failed custom mounts now clear partial content and
the marker, allowing a later result to render; both views have regressions.
