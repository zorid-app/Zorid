# Canvas context-menu reference and implementation

This ledger covers bounded static reading of the supplied desktop renderer, not reference execution or complete menu parity. The original implementation adds feasible actions to `src/canvas/view.ts` using the shared platform `showContextMenu` transport. Recovered code and assets remain outside the repository.

## Source identity

- Artifact: `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, verified SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- Existing REA E3: `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, source node `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`. Its graph is partial; this work does not rerun the producer or remove its coverage limits. See [reference-evidence.md](../reference-evidence.md).
- English label carrier: sibling `i18n.js`, SHA-256 `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713`. Canvas labels occur around 107189–112250, shared menu labels around 35025–36200, and the shared short Delete label at 32480.
- Ranges below are zero-based Unicode character offsets in UTF-8-decoded source, with an exclusive end. They describe ordinary focused source inspection, not new REA semantic evidence or byte offsets.

## Ordering mechanism and shared conditions

The menu sorter at 1223330–1224600 groups entries by section, preserving insertion order inside a section and separating populated sections. Unlisted nonempty sections are appended in first-use order. `addSections` at 1224591–1224830 inserts explicit section order. Thus insertion of Remove before other entries does not mean Remove is displayed first.

The background handler at 3340455–3341334 runs only for an unhandled event directly on the Canvas wrapper and only when writable; it clears selection. Node dispatch at 3368778–3369115 skips an actively editing node and previously handled events. Right-clicking an already selected node in a selection of size greater than one routes to the multiselection menu; otherwise it selects that node exclusively. Edge dispatch at 3406376–3406667 similarly routes an already selected edge to multiselection; its exclusive selection update is omitted in read-only mode. Node and selection menus use an event-associated menu, while edge/background construct a menu explicitly. Plugin hooks can add further entries; their registrations are not exhaustively traced here.

## Complete inventory of the inspected handlers

Within each row, entries are in the resulting section order. Conditional entries disappear when their condition is false. No submenu is built directly by these handlers; extension hooks and shared file menus may add submenus independently.

| Surface / range | Ordered entries and conditions |
| --- | --- |
| Background creation, 3342338–3343358 | **Add card**, **Add note from vault**, **Add media from vault**, **Add web page**, **Create group**. Note opens a note picker with attachments excluded; media opens a media picker; web page opens a URL dialog. The menu captures the pointer's document position for creation. |
| Background continuation, 3340455–3341334 | History section: **Undo** only when undoable, **Redo** only when redoable. Desktop-app clipboard section: **Paste**, using the current web contents' native paste. Quick settings follow. |
| Quick settings, 3341623–3342338 | Canvas section: **Snap to grid**, **Snap to objects**, **Read-only**, each checked from current state. The first two toggle plugin options and save them; read-only toggles Canvas state and saves local view data. The background menu itself is suppressed when already read-only. |
| Single node common, 3369115–3369861 | Explicit sections: title, canvas, open, action-primary, action, info, view, system, default, danger. Canvas: **Zoom to selection** always. Action: **Duplicate** on mobile (the inspected branch does not also check read-only), cloning selected data with remapped IDs and selecting imported nodes. Danger: **Remove** only when writable, removing the node and requesting a save. Emits `canvas:node-menu`. |
| Text node additions, 3388327–3388758 | In the common canvas section after Zoom: **Edit**, **Convert to file...**, both only when writable and an embedded child exists. Convert invokes the conversion path, whose complete filesystem lifecycle is outside this audit. |
| File node additions, 3383880–3386420 | Canvas: **Swap file...** when writable, with picker types dependent on the current resolved extension; **Edit** when writable, file resolved and child is the editable Markdown class; **Narrow to heading...**, **Narrow to block...** when writable and resolved extension is `md`; **Pin view...** when writable and resolved extension is `base`. Open: **Open in new tab** for resolved Markdown files. Action: **Rename...** when the file resolves and no subpath is present (no additional read-only guard in this branch). With no subpath, emits shared `file-menu` for the resolved file. Missing files still allow Swap when writable. Narrow-to-block may write a missing block ID to the underlying note before changing the Canvas subpath; Pin view reads Base views before choosing a subpath. |
| Web node additions, 3392868–3393890 | Canvas after Zoom: **Change URL...** only when writable; **Open external link**, **Copy URL**, **Reload page** always. Reload affects the existing frame only for an HTTP(S) URL. Open uses the stored URL; copy writes that string. |
| Group node additions, 3399507–3399810 | Canvas after Zoom: **Edit label** only when writable. Background-image actions seen elsewhere in Canvas are not added by this inspected node context handler. |
| Edge, 3406667–3407499 | Canvas: **Edit label** when writable, then **Follow connection** always. Follow compares the menu point's distance to the two side endpoints, then zooms to the opposite node from the nearer endpoint. Danger: **Remove** when writable, removing the edge and requesting a save. Emits `canvas:edge-menu`. |
| Multiselection, 3344897–3346562 | Explicit sections: title, open, selection, clipboard, action, view, info, default, danger. Selection: **Zoom to selection** always; **Create group** when writable, enclosing the selection bounding box with 20 units padding. Clipboard: **Cut**, **Copy**, **Paste**, all only when writable and in the desktop app, invoking native web contents operations. Danger: **Delete** when writable. Emits `canvas:selection-menu`; if more than one selected object is a file node, also emits `files-menu` with those nodes' file values. |

Default creation dimensions and editing/selection behavior are corroborated at 3325112–3326650: text uses the configured text dimensions, group/file use configured file dimensions, and creation requests a save and selects/focuses by default. Default configured sizes are visible around 3305690: text 250×60 and file 400×400. This implementation uses those sizes for menu creation and does not implement the reference's URL-specific video sizing.

## Implemented subset and host contract

The view adds a contextmenu listener using `showContextMenu(event, items, { document })`, so the existing Electron bridge or browser menu owns presentation. Implemented actions retain the observed English labels and relative section order:

- Background: Add card, Add web page, Create group, and available Undo/Redo. Creation uses inverse viewport coordinates; a URL editor creates a link only after nonblank input.
- Text: Zoom to selection, Edit, Remove. Group: Zoom to selection, Edit label, Remove. File: Zoom to selection, optional Open in new tab for Markdown paths, Remove. File resolution is not available here, so this path/host-capability condition is an original approximation of the reference's resolved-file condition.
- Link: Zoom to selection, Change URL..., optional Open external link, optional Copy URL, Remove. External opening needs the existing `openLink` hook. Copy needs the new `copyText` hook or an available browser clipboard writer. No webpage is fetched by the menu.
- Edge: Edit label, Follow connection, Remove. Labels edit the projected raw record only. Follow uses the view's existing side inference; full reference curved-edge geometry remains outside parity.
- Multiselection: Zoom to selection, Create group, Delete. Group bounds include selected nodes and endpoints of selected edges, plus 20 units padding; this approximates reference edge bounding boxes.

New optional hooks are `openFileInNewTab?(path): void | Promise<void>` and `copyText?(text): void | Promise<void>`. A host must supply a true new-tab operation to expose that item; ordinary `openFile` is not relabeled as new-tab behavior. Existing `onError` handles failures. Unsupported actions are omitted, rather than displayed with inert behavior.

Text, group-label, URL and edge-label editors use the same `flush`/pending-change lifecycle. Context clicks inside an active textarea retain the platform text menu. Opening a different Canvas menu first commits and flushes pending text; a failed write prevents the menu and leaves unsaved source available for retry. Editor forms are original controls, not reconstructed reference dialogs. The owner must continue to await successful `flush` before closing, replacing documents or destroying the view.

Before dispatching an asynchronous menu result, the view checks its lifetime, document identity, unchanged source, menu generation and unchanged selection. Selection changes, newer menus, an editor opened during a menu wait, document replacement, source mutation or teardown invalidate old results. Source-changing actions use the existing transaction/history path; hidden records remain unless explicitly selected deletion affects them or their incident edges. Undo restores prior exact source. View-only zoom/follow actions do not save.

## Explicit remaining gaps

Vault note/media pickers, swap, conversion, embedded-file editing, narrowing/pinning, file rename, full shared file menus and plugin hooks, mobile duplicate, native Canvas clipboard payloads, embedded web reload, snap toggles and read-only mode remain unimplemented in this menu slice. They are listed above with their static conditions instead of being silently counted as complete. The platform descriptor currently carries labels/order/separators and capabilities; this view does not reproduce reference icons, warning styling, plugin-provided submenus or every native presentation detail. The app's existing view remains writable and does not expose a fake Read-only command.

Tests in `tests/canvas-view.test.ts` exercise the actual browser menu and injected platform bridge, supported ordered labels, conditional host actions, card/web/group creation, node/edge edits and removals, multiselection, undo, retained unknown data, viewport-only follow, pending text, source/selection/owner invalidation and save failures. These tests do not establish native menu visual or mobile parity.

Validation: `node --test tests/canvas-document.test.ts tests/canvas-view.test.ts` passed all 40 tests; `npm run check` and `git diff --check` passed.
