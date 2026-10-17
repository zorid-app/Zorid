# Table selection context-menu ownership follow-up

This audit reuses the REA extraction and static renderer identity recorded in
[the context-menu reference](context-menu-reference.md). The recovered renderer
at `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js` was
rechecked as SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
Retained renderer E3 is
`ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`;
its graph coverage remains partial. No reference code was executed or copied.

## Observed contract and reproduced defect

At Unicode character offsets 2049617–2050450, the reference cell context-menu
handler first respects an already prevented event. A mouse context-menu event
outside a rectangular selection clears that selection, focuses the clicked
cell, then explicitly invokes the newly created cell editor's context menu.
A context-menu event inside the rectangle keeps its selection-dependent table
menu. Table menu construction and whole-band deletion contracts are documented
at 2081000–2086590 and 2077011 in the existing editor reference.

Zorid previously activated the new cell but continued resolving the original
`event.target` in its outer menu handler. Activation removes rendered descendants
such as `<strong>`, so their event target no longer belongs to an editor. The
menu did not open. Right-clicking the cell itself kept a connected target, but
selected only the rendered table contribution, omitting nested-editor commands.
An already prevented context-menu event also unnecessarily cleared the rectangle.

The original fix records an event-local target handoff from the table controller
to its owning editor. It retains the original event and coordinates, resolves
the newly focused child before building the combined menu, and rejects a
handoff whose owner or connected target no longer matches. Existing asynchronous
menu guards still reject changed source, changed selection, detached editors,
and read-only mutation. The handoff does not persist across different events.

## Validation and remaining gaps

Five new integration regressions failed before the fix and passed afterward.
Two additional cases exercise selection-dependent menu deletion of multiple
complete rows and columns through the desktop menu descriptor bridge, preserving
parent undo. The tests use actual `createEditor`, CodeMirror widgets and DOM
context-menu events with an injected native menu return value. Focused existing
editor and table tests also passed. They do not execute an OS-native popup.

This bounded fix does not establish complete table parity. Existing differences
remain: immediate cell activation instead of the reference's delayed pointer
release path; mouse-only gesture handlers instead of the distinct touch/caret
paths; unverified measured drag targets, autoscroll and wrapped-line hit testing;
and unverified OS clipboard roles and native popup appearance. The reference's
single-axis grip menu and rectangular menu are intentionally separate: rectangle
Delete cells removes full row/column bands or clears partial rectangles, whereas
a grip opens its row or column actions. No disjoint multi-selection or speculative
modifier-grip gesture was added.
