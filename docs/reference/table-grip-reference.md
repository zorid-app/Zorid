# Compact table grips

The user reported a row grip with dots repeating down the entire row. Zorid's
`.cm-table-grip::after` used an inset repeating radial gradient, so the number of
dots increased with the cell height or column width.

This fix reuses the existing REA extraction for Obsidian 1.14.4, without executing
or copying recovered code. The renderer identity and retained E3 evidence are
recorded in [editor-reference.md](editor-reference.md). Static `app.js` around
2072200 selects Lucide `grip-vertical` for row handles and `grip-horizontal` for
column handles. `app.css` at 124003–126400 centers a small icon in the handle.
Its theme declares `--icon-s: 16px`, stroke width 2px, desktop handle size 16px,
selection border width 2px, and corner radius 4px. The resulting desktop hit strip
is 14px thick while the icon stays 16px. Mobile raises the handle size to 24px.
The icon remains compact regardless of the row height or column width.

Theme values around CSS 92730 set the resting handle background to transparent,
its color to faint text, and its active background/color to the selection accent
and text-on-accent. Hover makes the handle visible; it does not add a gray strip.
Active state adds the selection-colored outline. Row handles round the outward
corners at the inline start; column handles round the top corners.

Zorid now uses its existing pinned upstream Lucide package through the shared
icon helper. Row handles contain one six-dot vertical icon; column handles one
six-dot horizontal icon. The SVG has a fixed 16px box, does not flex or receive
pointer events, and sits centered inside the existing hit target. The change
removes the repeated gradient and restores the reference-informed transparent,
faint resting style and accent active style. Existing ownership, selection,
reordering, menu and accessibility-label behavior stays in place.

The 41 existing table interaction tests and 3 icon-helper tests passed, as did a
strict TypeScript check of the affected modules. No CSS-mirroring tests were
added. Native screenshot comparison and actual hover/drag hit testing remain the
root verification owner's work; this static evidence and DOM test pass do not
establish complete visual or gesture parity.

Integrated on main as `f0898d8`. Root's table/icon test entrypoints, project
TypeScript check and production build passed. An unsigned arm64 package of that
commit launched successfully with Electron 44.8.0 and a synthetic vault. Native
accessibility confirmed the table handles and cell editor, but screenshot
capture returned a mostly white/clipped image: the six-dot appearance was not
visually verified. The agent-owned packaged app was closed after the pass.

A subsequent browser visual pass used the same production table implementation
in the built tab/Kanban candidate (`7b1dc8d`, whose later candidate changes were
documentation only). Chrome opened the locally served renderer with an empty,
synthetic browser vault. Creating a two-column table, selecting its body-row
handle, then its first-column handle showed compact vertical and horizontal
six-dot icons respectively. The corresponding whole row/column was highlighted.
The pointer was moved away through the Files button so it did not obscure the
icons. Screenshots were readable in this browser pass. The tab and local server
were closed afterward. This verifies the renderer appearance in that browser,
not exact Electron pixels, touch targets, drag reordering or every theme/zoom.
