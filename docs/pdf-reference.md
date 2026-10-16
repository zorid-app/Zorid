# PDF viewer reference contract

Focused static inspection of Obsidian 1.14.4, 2026-10-16. This report reuses the retained REA artifact identity and examines selected recovered source ranges. No target execution, new broad analysis, copied implementation, or recovered asset enters Zorid. Static observations below are requirements candidates, not verified runtime parity.

## Evidence and scope

Desktop payload: `obsidian-1.14.4.asar`, SHA-256 `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`. Recovered artifacts remain under `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`, outside project source. REA E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` binds the renderer source; its expanded semantic graph is incomplete. Detailed findings here come from ordinary focused source inspection, not additional REA semantic conclusions. See [reference evidence](reference-evidence.md), [source inventory](source-audit.md), and [attachment findings](attachment-reference.md).

| File | SHA-256 | Inspected scope |
| --- | --- | --- |
| `app.js` | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` | Lazy loader, PDF configuration, toolbar/find/annotation wrapper, standalone and embed adapters. |
| `lib/pdfjs/version.json` | `0a8ac68bb7f1845ad8eb795e7147abf66f75c79b5e585c5985dbad4d42ad1eec` | Entire metadata: version **5.3.34**, build **34**, commit **cc1e2a3e0**. |
| `lib/pdfjs/pdf.min.mjs` | `f298004f6e2f4e67faab473513f322edc506295968e96b50041cb1a69ea90279` | Identity only in this pass; 566,729 bytes. |
| `lib/pdfjs/pdf.viewer.min.mjs` | `7060308a7ffa11ab3112458ec58f740eb90643849beeaa6d9c9ff4441e9d35af` | Selected integration factory, event bindings, history, defaults; 488,821 bytes. |
| `lib/pdfjs/pdf.worker.min.mjs` | `0235bc7b0c7822334edb2f82eb2ffc7954b971e4c7e57acca4703f6c2555efe4` | Identity only in this pass; 1,130,698 bytes. |

Offsets below are zero-based **Unicode character offsets** in decoded UTF-8, not byte offsets. `A` means `app.js`, `V` means `pdf.viewer.min.mjs`. They identify this exact build only. Matching APK version metadata does not establish mobile wrapper equivalence; this pass does not inspect the Android PDF integration.

## Engine and construction

At A1993290–1993960, lazy module loaders load `pdf.min.mjs`, then `pdf.viewer.min.mjs`. The core loader sets `GlobalWorkerOptions.workerSrc` to `/lib/pdfjs/pdf.worker.min.mjs`. A legacy `.js` worker pathname also occurs in configuration around A2632868; its presence is not proof that a `.js` worker is used. Resolve effective configuration in runtime before treating that discrepancy as a bug or deployment contract.

The distribution contains a **custom `createObsidianPDFViewer` factory** at V480878, plus `ObsidianPreferences` and `ObsidianServices`. An arbitrary upstream viewer or browser PDF iframe does not reproduce this wrapper. This evidence does not establish the extent of the fork or that a public package at the same version is byte-identical. Use independently acquired open-source PDF.js under its license, then implement original integration code; do not redistribute this recovered distribution as project assets.

Configuration at A2632420–2632940 disables scripting, eval, telemetry and PDF history integration, uses page-width as the default zoom, and points to packaged image, CMap, standard-font, WASM and ICC resources. `maxCanvasPixels` is 16,777,216, changed to 5,242,880 on mobile during wrapper load (A2656500). This is a per-canvas pixel setting, not a measured total memory bound.

`Y0` (A2656010 approximately) owns the actual viewer wrapper; `X0` (A2674250 approximately) provides child lifecycle and queued operations before loading; `Q0` (A2675150 approximately) is the standalone `pdf` view; `$0` (A2677000 approximately) is the file embed adapter. Exact method boundaries below are more useful than these minified symbols.

Wrapper load at A2656030–2659950 creates an EventBus, hidden temporary layout container, viewer/text/annotation area, thumbnail/outline sidebar, and custom toolbar, find bar, password prompt and outline component. It initializes before moving the finished nodes into the host. A 200 ms debounced ResizeObserver dispatches viewer resize events. CSS changes reapply page background and inversion when the app-local `pdfjs-is-themed` preference is enabled. Owner-window migration closes and reloads the file while retaining its subpath.

The factory at V480878–487090 creates rendering queue, link service, find controller, viewer, thumbnails and sidebar; it supplies custom external services and disables printing through its instance getter. Scripting creation returns null. Its preference adapter reads the supplied options and has a no-op setter. This does **not** mean all view state is unpersisted: fingerprint-based history remains separate.

## Standalone, embeds and state

| Surface | Static contract |
| --- | --- |
| File tab | View type `pdf`; load through the vault resource URL with the container's ownerDocument; reload when that file changes. Closing the file closes the viewer. A2672060–2676990. |
| Ephemeral navigation | Apply a subpath; requested focus waits for the first page before focusing the PDF viewer. The file view delegates its search command to the find bar. A2676400–2676980. |
| Embed | Same wrapper with `isEmbed`, removed page borders, default height `page`, 300 ms initialization delay, and optional positive integer `height` parameter. An extra toolbar menu opens the source link's context actions. A2677020–2678650. |
| Embedded height | Numeric content height adds toolbar height; `page` waits for the active page viewport and adds toolbar height; a resize recalculates page height. V482010–482490, V487000. |
| Display-only embed | Sets page scroll mode and no spread, waits for the active page canvas, and moves that canvas into a wrapper with bounded CSS width. This is a separate branch from interactive embedding. A2672060–2673440. Its full caller set remains unresolved. |
| Deferred visibility | File loading waits for node insertion when the host lacks an offsetParent. The visible path also resolves its enclosing wait on password-prompt opening, rather than waiting indefinitely for successful document loading. A2672060–2673440. |
| Teardown | Disconnect ResizeObserver, unbind viewer window events, close PDF, close find bar, detach temporary nodes, clear host and annotation popup. A2659890–2660300. |

V441664 defines a localStorage `pdfjs.history` database keyed by PDF fingerprint, with default cache size 20. On view-area updates, standalone viewers persist page, zoom, scroll left/top and rotation; the inspected handler excludes embeds (V472105). Mode-change handlers persist their mode separately, so do not infer that embeds never write any shared history. Initial-view overrides at V486100–487000 hide the sidebar for embeds, prefer explicit subpath values, and otherwise consider saved page/scroll state for standalone views. Browser hash/history integration being disabled is distinct from this local persistence.

## Links and selection

The outer `applySubpath` parser at A2673440–2674300 accepts named destinations when no `page` parameter exists. With `page`, it parses integers using JavaScript `parseInt` (not strict decimal validation), defaulting a failed page parse to 1. `offset=left,top,zoom` becomes a PDF destination: missing zoom selects `FitBH` with top; present zoom selects `XYZ` with all three values. Missing coordinates stay null. Page indices in destinations are zero-based, while links use one-based pages. Numeric range enforcement is not established by this parser alone.

Additional highlight state is independent of that destination:

- `#page=N&selection=startItem,startOffset,endItem,endOffset`: four parsed integers address PDF text-layer items and offsets within those items. These are **not** global file character offsets, pixels, or CodeMirror positions.
- `#page=N&annotation=ID`: identifies an annotation; annotation takes precedence over selection when both are supplied.
- `height` is read separately by the embed constructor. The outer parser also returns a height field, but this inspected caller does not forward that returned field to the underlying destination setter.

Selection serialization at A2664470 walks to `.textLayerNode` elements and uses their `data-idx`; offsets count descendant text-node lengths before the DOM Range endpoint. Both endpoints must be inside the same supplied page element. A cross-page selection is not thereby proven serializable as one selection link. Highlight application at A2670140–2672060 rebuilds affected text spans, marks selection fragments and scrolls the first fragment near the top; text-layer render events retry pending highlights. Annotation-layer events likewise retry annotation highlights. Escape, find actions and pointer actions clear ephemeral highlight state.

Link generation at A2674300 uses the app file manager and therefore inherits configured wiki/Markdown link formatting, escaping and aliases. Page-link aliases use the PDF basename plus localized page label. Context actions at A2664900–2667900 include copy text, quote plus link, selection link, annotation text plus link, annotation link, and thumbnail page link. The quote shape is a blockquote followed by a blank line and the generated link. Desktop context-menu text normalizes Unicode and collapses line breaks. Mobile's text-layer copy handler instead augments available clipboard plain text with a quote and selection link; actual platform clipboard delivery remains unverified.

Annotation click handling at A2663100–2664470 tracks one pointer, treats movement over 5 CSS pixels as a drag, and ignores Widget/Link subtypes for custom comment popups. Re-clicking the same active annotation closes it. Desktop/tablet popups show contents, author/date and a copy action; phones use a modal. Extracted quote text is based on character rectangle centers inside annotation quad rectangles (A2668000–2669560), which depends on this distribution's text-layer character metadata. Public PDF.js equivalence for that metadata is unverified. Annotation viewing, form interaction and annotation creation/editing are separate capabilities; this reading does not establish that the app exposes a PDF annotation editing toolbar.

## Controls, search and input

Toolbar construction at A2649600–2655410 supplies sidebar toggle, thumbnail/outline choices, reveal current outline item, zoom in/out, fit width/height, single/odd/even spreads, adapt-to-theme and page-number input. Outline choices are disabled without an outline. Page input uses PDF page labels when present, numeric input otherwise; clicking selects the input. The factory provides sidebar resizing and thumbnail reuse via its rendering queue. Exact dimensions, pointer hit areas and accessibility tree remain unmeasured.

Find bar at A2632980–2640140 has initially false `highlightAll`, `caseSensitive`, `matchDiacritics` and `entireWord`, with app-local persistence under `pdfjs-search-settings`. Input dispatch is debounced 250 ms; Enter finds again, Shift+Enter reverses, and composing key events are excluded. While open it installs F3 / Shift+F3 and Mod+G / Mod+Shift+G scopes. Closing unregisters them. Opening selects the input; the higher-level show-search operation focuses an already open unfocused input, otherwise toggles. Pending/not-found styles and `aria-invalid` reflect find state; counts above 1,000 have a capped display message. This is not evidence of a 1,000-match search limit.

**Do not copy the generic PDF.js key map into the clone as an Obsidian specification.** At V468644–470050, `bindWindowEvents` defines a no-op local `mockWin_addEventListener`. Generic keydown/keyup, click, resize, hash and print listeners are passed to that no-op. The retained generic `onKeyDown` body at V476470 therefore does not prove those shortcuts are reachable through that path. The wrapper explicitly registers Escape to clear ephemeral UI/close find (A2658640), the find scopes described above, and standalone Left/Right to change pages when zoom is page-width or page-height and the event target is not an editable element (A2675320–2675940). Other app-global commands require further call-site tracing.

Wheel events **are** actually registered on the viewer container, and a touch manager is constructed, unlike the no-op keyboard registrations. V474300–476150 contains Ctrl/Meta wheel and pinch zoom branches, cursor origin, accumulated ticks/factors and temporary suppression after ordinary scrolling. Gestural thresholds, focus routing, OS shortcuts and actual wheel behavior need reference runtime observation.

## Original implementation plan and unresolved checks

Implement a vault-backed PDF service with lazy open-source engine/worker loading, resource URLs, cancellation and lifecycle cleanup; a shared interactive viewer for standalone and Markdown embeds; an independent toolbar/find/sidebar/password UI; explicit destination/selection/annotation adapters; and bounded rendering through PDF.js queues. Preserve selection item indices and text normalization contract instead of substituting an approximate text search. Keep browser history, PDF fingerprint history, app settings and workspace ephemeral state as separate stores.

Required verification includes valid/malformed/password PDFs; missing workers/fonts/CMaps; page labels and named destinations; internal/external links; selection and annotation links across reload/zoom/rotation; multi-page selection; mixed page sizes; thumbnail/outline navigation; spread and fit modes; embeds with page/height/offset parameters; multiple concurrent viewers; file changes/deletion during load; window migration; search scope/focus; mobile clipboard and pinch; and large-file memory/teardown. These are integration requirements, not all implemented tests.

Unresolved: full fork diff against a public upstream distribution, engine/parser and worker internals, font/WASM licenses and acquisition provenance for a future dependency, all global command routing, persisted preference edge cases, PDF form saves/downloads, complete annotation compatibility, mobile wrapper differences, rendering metrics and timing, and direct reference/clone runtime comparisons. No full PDF source audit or feature completion is claimed.
