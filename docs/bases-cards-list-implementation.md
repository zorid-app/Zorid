# Cards and List implementation checkpoint

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
return `{ update(result), refreshLayout(), destroy() }`. Each owns one child scroller;
its container must receive a bounded height from the host. Import `cards-view.css`
and/or `list-view.css` when mounting. `update` replaces the result atomically and
invalidates old widget/edit/thumbnail owners even when the host reuses a version.

Both accept:

- `result` and `openFile(path, MouseEvent | KeyboardEvent)`. Original native events
  preserve modifiers. Cards open on background click/middle click and Enter; List
  opens through its file-name link, not arbitrary row text.
- Optional `getPropertyLabel(property)` for root-config display names.
- Optional `renderProperty(element, { row, property, value, version })` returning a
  disposer, for the host's full metadata/link/value registry. It replaces the default
  primitive renderer; it must use the supplied version for writes and release all
  resources in its disposer.
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
one focused unit mounted outside that window. A Fenwick height index supports
logarithmic measured-height updates and visible-index lookup. One ResizeObserver
watches the scroller and mounted units only. Scroll renders are animation-frame
coalesced. Measured changes above the current anchor compensate scroll position.
Snapshot/width changes rebuild the O(n) unit index; scroll does not scan every row.
Large query evaluation remains the query engine's responsibility.

The Cards layout uses fixed initial metrics; List rows are measured when mounted.
This differs from the reference's incremental measurement scheduling and adaptive
overscan. A 10,000-row List fixture proves bounded DOM in jsdom, not real-device
performance or a matching reference latency/memory budget.

## Remaining gaps

- Workspace toolbar, view settings/property ordering UI, saved configuration,
  embeds, complete context menus, hover previews, note drag formats and drop actions
  still need the corresponding host integration.
- Full property widget/coercion registry, rich links, Markdown values, lists/tags,
  date/datetime controls, plugin renderers, transaction undo, and failed-write UX
  must be supplied or implemented; primitive rendering is not full metadata parity.
- Resize/query replacement currently reconstructs visible units and can retire an
  active editor. Precise focus/draft preservation and reference keyboard navigation,
  selection semantics, mobile touch, CSS-theme card scaling, and ephemeral scroll
  state need additional work and native verification.
- Query groups/rows retain the engine's ordering. List-valued group keys are composite
  keys, not membership expansion. No grouping mutation or persisted collapse option
  is invented. Collapse state is local and retained across updates.
- Reading/external link image parsing and thumbnail generation are not implemented
  here; loading is an explicit host capability. No browser network request occurs
  without a URL supplied by that capability.

Validation: 14 focused serial tests cover settings, ordered properties, event
modifiers, text selection/editor protection, List omissions and numbering, nested
markers, group collapse, asynchronous thumbnail retirement, 10,000-row virtual
mounting, write-version boundaries, edit failures, repeated edits, bounded observer
subscriptions, and measured scroll anchoring. Focused strict TypeScript passes.
