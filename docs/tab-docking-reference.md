# Tab docking and popout reference

This is a bounded static audit and an original reusable controller, not a claim of native or screenshot parity. The user-supplied screenshot is a static visual reference, not evidence of fresh-install defaults. No reference application was launched for this audit.

## Evidence boundary

Pinned artifacts are outside this repository, under `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`:

| Artifact | SHA-256 |
| --- | --- |
| `app.js` | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` |
| `app.css` | `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba` |
| `main.js` | `5d90e3738f7db8fb8ea00d01556d71310fd557c4a3c785601274c2bb875a2cba` |

Offsets below are zero-based UTF-8 byte offsets in these exact artifacts. Existing REA E3 evidence `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` is a partial renderer analysis: one parsed JavaScript file, 195 factories, with a partial semantic graph. These additional bounded inspections establish local behavior, not complete call-graph coverage. See `docs/source-audit.md`. No recovered implementation or bulk proprietary CSS was copied into project source.

## Verified behavior

| Evidence | Static finding |
| --- | --- |
| `app.js` 2921936, `onDragLeaf` | Desktop leaf drag makes a title/icon ghost and uses a five-pixel Euclidean movement threshold. This path moves leaves; it has no modifier-key copy branch. Valid destinations set `dropEffect` to `move`. |
| `app.js` 2928354, `getDropLocation` | Drop targets are resolved within the event window, including registered floating splits. The main workspace additionally resolves sidebar ribbon/toggle targets. |
| `app.js` 2929176, `getDropDirection` | Edge eligibility uses normalized distance strictly below `.33`. Candidates are checked top, left, right, bottom, with strict improvement retaining this tie priority. An ordinary tab header suppresses side edges: its top third permits a top split, the remainder chooses center. Stacked content outside its header disables left/right. Preview strips use `max(axisLength / 3, 40)`. |
| `app.js` 1568433, `getTabInsertLocation` | Header insertion uses each tab's horizontal midpoint; equality goes before the tab. Preview is a 10px vertical marker centered on the insertion boundary. |
| `app.js` 2921936–2928354 | Center insertion into the source group adjusts the index after removal and ignores a resulting no-op. A group containing only the source leaf cannot split itself. A changed target changes the preview immediately; this code has no hover-activation timer. |
| `app.js` 2930210, `splitLeaf` | Left/right create a vertical split; top/bottom create a horizontal split. The destination dimension is divided in half when using an existing matching split; an incompatible parent is wrapped. The one-third preview is not the final split proportion. |
| `app.js` 2926900–2928354 | Leaving with `relatedTarget === null` and nonzero buttons hides the preview and sets popout eligibility after 10ms. Re-entry and drop clear eligibility. Cleanup can pop out an eligible leaf. The position in this static closure comes from the captured drag-start event; no native final-position observation was made. |
| `app.js` 2932862, `moveLeafToPopout` | The source leaf object is removed from its parent and inserted into a new popout group; source view dimensions and window zoom are supplied. This preserves the same editor object rather than reopening the file. |
| `app.js` 2882025, popup workspace construction | Supplied popout width and height are clamped to at least 600 each. The popup shares the application's in-memory object and receives existing leaf objects. |
| `app.js` 2620310, popup creation | A popup is created with `window.open` and width/height/x/y features; styles and zoom are propagated to its document. |
| `main.js` 173271; 184014 | The reference allows a specific about:blank popup request and registers newly created windows. Its Electron security settings differ from this project's hardened separate-renderer configuration and are not an implementation template. |
| `app.css` 210928; 211230 | Fixed, pointer-transparent drop overlays use layer 5, 100ms ease-in-out geometry transitions, and a centered fill inset by 3px, accent color at `.5` opacity, radius 8px. |
| `app.css` 211517 | The reference also uses a hidden cloned target and a fake-target overlay to preview the remaining pane's layout. |

## Original controller and API

`src/ui/tab-docking.ts` exports `createTabDocking`, `dockZone`, and `tabInsertion`. Import `src/ui/tab-docking.css` separately. The controller consumes live host pane/tab descriptors rather than discovering application state through DOM attributes:

```ts
const docking = createTabDocking({
  root,
  getPanes: () => panes.map(pane => ({
    id: pane.id, element: pane.element, tabBar: pane.tabBar,
    tabs: pane.tabs.map(tab => ({ id: tab.id, element: tab.element })),
  })),
  dock: async intent => { /* host moves this stable tab into the requested pane/edge */ },
  tearOff: async intent => { /* host performs an acknowledged native state handoff */ },
  onError: error => { /* surface a recoverable failure */ },
});
// On workspace disposal:
docking.destroy();
```

The host must make tab elements draggable. Remove the old per-tab drag mutation handlers. The controller captures local tab drag events before those handlers, but unrelated external drags remain available to the workspace. `enabled` can suppress desktop tab dragging on phone/touch layouts. `DockPane` additionally supports `stacked` and `disabledEdges`.

`DockIntent` supplies `sourcePaneId`, stable `tabId`, `targetPaneId`, `edge`, and `index`. For a center drop, **index is already adjusted for removal from the same source pane**; do not adjust it again. Edge drops use index zero as a placeholder. Hosts should use their split-layout implementation for actual split ratios, source-group cleanup, selection, and persistence. Source and destination must be revalidated before an asynchronous host operation commits.

`TearOffIntent` supplies `sourcePaneId`, stable `tabId`, `screenX`, `screenY`, `width`, and `height`. Coordinates deliberately use drag-end screen coordinates to express the user's requested destination; the captured-start coordinate in the reference is documented above rather than silently reproduced. The host owns zoom, display work-area clamping, minimum window dimensions, window creation, and all editor state transfer. The controller emits this intent only after a window exit with no successful external drop and revalidates the current source pane/tab IDs and connected DOM ownership before calling the host. A source closed, detached or moved out of its pane during the outside drag produces no handoff intent. The host still revalidates ownership after any asynchronous work. It supports explicit cancellation, Escape where delivered by the platform, re-entry cancellation, and disposal cleanup. The short delayed exit eligibility follows the audited 10ms behavior. Native drag cancellation and coordinate delivery still require platform verification.

Callbacks may return promises. While one is pending, no further local drag session starts. Preview cleanup never removes a source tab or editor. A rejected callback is delivered to `onError` (or logged if the host omits it). The host must keep the source authoritative until the destination acknowledges restoration; a rejected operation must leave source data intact. `cancel()` cancels a current drag, not a host operation that has already begun.

## Native bridge contract and state preservation

This module intentionally owns no IPC or editor serialization. The original same-object move cannot be reproduced by opening a file path in a separate renderer. The workspace/native bridge needs a versioned, validated handoff containing stable tab identity, actual unsaved text, saved baseline, revision/conflict/pending-write state, CodeMirror selection and history, view scroll state, view kind/mode/subpath, and relevant nontext view state. The separate `window-handoff` workstream owns the reusable state contract; shared host files are owned by the integration lead/root.

Create a destination, restore its state while inert, acknowledge readiness, then commit source ownership removal. On precommit failure retain the source and discard the incomplete destination. Authenticate renderer senders, maintain each window's session identity, serialize compare-and-write operations per vault/path, and broadcast vault updates across windows. Keep the project's context isolation and sandbox; do not adopt the reference's legacy shared-global security configuration. Source dirty state must not depend on a successful save before a transfer. Actual undo/redo continuity and caret restoration must be verified in the integrated native app.

## Validation and remaining scope

`npm run check` passes. `node --test tests/tab-docking.test.ts` covers strict edge thresholds, priority, header and stacked behavior, insertion midpoint/index adjustment, move-only modifiers, target switching, source DOM/state nonmutation, no-op moves, unrelated drags, outside handoff, re-entry/cancel/Escape/disposal, duplicate prevention, and rejected callbacks. These are geometry and simulated DOM event contracts, not native mouse-drag proof.

The controller implements the accent strip plus an inert target snapshot resized into the remaining space. It does not create the reference title/icon ghost, activate sidebar ribbon drop targets, or receive a tab dragged directly from another renderer. Native cross-window receiver routing and file-drop coexistence require host integration. Computed colors, font rendering, screen scaling, drag image behavior, actual platform Escape delivery, and final window placement remain unobserved. Full separate-window creation and data-safe handoff are not completed by this module alone.


## Split preview correction (2026-10-16)

A user reported that dragging a tab to split showed the wrong preview. Focused reinspection of `onDragLeaf` at byte 2921936 and CSS bytes 210928–211848 found the missing behavior: an edge preview also visually replaces the destination with a snapshot in the remaining space. The previous controller drew only the accent strip over the full-sized destination. The existing one-third edge math, five-pixel Euclidean activation threshold, and midpoint tab insertion were confirmed; the final split remains half-sized through the unchanged host layout implementation.

`src/ui/tab-docking.ts` now keeps one inert visual snapshot per current target. For left/top edges the remainder moves past the strip; right/bottom retain the original origin. Both rectangles use the target's viewport CSS coordinates and the same 100 ms transition. Neither device pixel ratio nor screen coordinates multiply this geometry. The snapshot retains current input values, nonzero scroll positions and copyable canvas pixels, and remaps local SVG IDs/references to avoid duplicating live document IDs. Empty ancestor class wrappers retain contextual styling. The live pane's inline opacity (including priority) is restored on center insertion, target changes, invalid target, exit, cancel, drop and disposal. A newer host opacity change is retained.

The snapshot imports into an inert document, recreates native elements without customized built-in identity, and replaces plugin custom elements with inert placeholders. It strips scripts, embedded documents, inline event handlers and autoplay/media sources; no second editor or view runtime starts. Therefore embedded browsing/media and plugin custom-element appearance can differ during preview. The snapshot is transient and never transfers ownership, changes the split topology, or persists layout. Existing dirty input, selection and live editor objects remain in place. A fresh snapshot is created only when changing targets; repeated dragovers resize the existing one.

Local dragover events are consumed before reaching the five-pixel threshold, as in the inspected reference; no preview or move activates until the threshold. Registered sources and targets must remain connected descendants of the current workspace. Re-entry observed as a dragover clears outside eligibility even if a platform omitted a separate dragenter. Actual popout final screen coordinates remain the deliberate existing policy documented above.

Validation: 18 tab-docking tests and 32 existing Workspace docking/Bases tests pass with concurrency one; TypeScript passes. Tests cover all four remaining rectangles, edge-to-center transitions, snapshot reuse, current/other pane transitions, inert cleanup, saved original opacity, source/editor state preservation, local IDs/scroll, disconnected ownership, and offset/HiDPI client coordinates. Independent review passed five additional probes and cleared customized built-in constructor and SVG script/style regressions. Native comparison remains separate. Root must compare physical drag previews on light/dark themes, nested splits, zoom levels, large/virtualized views and embedded media; DOM fixtures do not establish native visual parity.
