# Image resizing in Live Edit

The original image control implements a desktop resize corner and double-click
size reset. The shared renderer still owns the image bytes and viewer. The host
owns source edits through a parser-derived label range and the current embed
identity; the pointer controller owns only a temporary image width attribute.

## Reference evidence

This extends the same hashed Obsidian 1.14.4 extraction documented in
[embed-controls-reference.md](../embed-controls-reference.md). These are static reads
of existing artifacts, not a new runtime trace or a re-run of the historical REA
producer. Offsets below are decoded character offsets; no proprietary source is
copied into the project.

- `app.js` 3026310–3027450: primary-button desktop resize corner, displayed initial
  width/height ratio, bounding-rectangle anchor, frame-batched width preview.
- 873360–874609 and 849262–849470: five-pixel movement threshold, matching pointer
  ownership, frame cancellation and terminal-event cleanup.
- 2601510–2601705: maximum width comes from the editor content width.
- 784373–784743, 754217–754543 and 773155–773283: final integer width or width×height
  segment rewriting; aliases, Markdown destination and title remain intact.
- `app.css` 371608–372924 and 373800–374585: 30×30 corner hit region, 10×10 indicator
  inset six pixels, RTL cursor and active indicator. The narrow-image rule at
  374854–375060 gates the toolbar only; the corner remains reachable on small images.

Width is the rounded larger of horizontal distance from the anchored side and
vertical distance times the initial displayed ratio, clamped to 20 pixels and the
editor width. The preview writes width only. A terminal pointer event commits the
last applied displayed width; pending animation frames are canceled. Double-click
removes only a final recognized size segment. Existing explicit height remains
during the preview and is removed by the width-only source rewrite; exact native
aspect presentation for that case remains unverified.

## Ownership and deliberate safeguards

There is no Markdown write on pointer movement. One completed gesture dispatches
one isolated undo transaction. Inserting text before the image during a gesture
maps the final edit correctly. Changing or deleting the image syntax, replacing
its renderer, detaching it, or destroying the editor prevents a stale commit.
Reset without existing dimensions is a no-op, including an empty wiki alias.
A completed source edit can replace the renderer once because its label changed;
preview frames retain the original renderer and resource lease.

Pointer cancellation, Escape, context menu, window blur and teardown restore the
original width attribute and remove gesture listeners/capture/queued frames. This
rollback is an explicit original safety choice: the inspected reference cleanup
did not establish DOM rollback on cancellation. Likewise, source changed during a
gesture is rejected rather than overwritten. Nonfinite geometry cannot produce a
source write. Mobile has no resize corner; the existing mobile host-option gap is
unchanged. Keyboard resizing, separate image reveal tooltip and image context-menu
parity are outside this change.

Focused tests exercise actual editor source mapping, wiki aliases and Markdown
titles, width×height normalization, isolated undo/redo, stale/deleted source,
preview ownership, pointer identity, threshold/frame batching, minimum/maximum,
RTL, reset, cancellation, replacement and teardown. JSDOM tests verify event/state
and selector behavior, not native pixel parity. Root owns native verification.
