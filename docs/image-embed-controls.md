# Image-specific Live control helper

`createImageEmbedControls` in `src/editor/image-embed-controls.ts` mounts controls on a resolved image embed's own root. The host supplies `onSelect`, `onEditSource`, `onZoom(image, event)` and an optional platform `isMobile` flag. The returned handle exposes `setSelected`, `refresh` and `destroy`. The helper owns its buttons, event listeners and observers; it never acquires image bytes, rewrites Markdown, opens a second renderer or destroys the image.

The host must own the selected embed identity and map it through document edits. Its source callback selects that image's current URL segment and enables source reveal while retaining its existing rendered child. Its zoom callback invokes the current viewer capability directly; dispatching `image.click()` would reenter the helper. The existing shared renderer exposes its lightbox through `image.onclick`, which can be invoked directly by the integrating host. Images supplied without that capability require an explicit host decision; this module does not manufacture a lightbox.

Mount only on the resolved image root, not a generic wrapper or a containing note. It observes direct image replacement, load and resize; nested images are not adopted. The generic host must remove its own image edit button and destroy this handle before releasing the embed. It must update selection through `setSelected` and release/recreate the helper when the resolved type changes. CSS is in `src/editor/image-embed-controls.css`; integration owns its application import and generic wrapper layout.

The original implementation follows the image-specific observations in [embed-controls-reference.md](embed-controls-reference.md): desktop zoom plus source actions at top/logical end 8 px, selected/hover visibility, and a displayed-image width threshold of 80 px. Mobile omits the separate zoom action and uses larger action padding. First image click delegates selection; a selected-image click delegates viewing. The host retains exact source-range and renderer ownership. Focused keyboard actions are additionally made visible, and unselected narrow-image actions leave the tab sequence; these are bounded accessibility choices, not claimed reference keyboard parity.

Six focused tests cover selection/action dispatch, width gating and CSS applicability, mobile controls, image replacement, detached/disposed ownership, queued callbacks, and independent destination documents. Strict scoped TypeScript and whitespace checks pass. These checks do not measure browser layout or establish image/lightbox native parity.

Desktop resize-corner dragging/reset and source width writes are implemented separately in [image-resize.md](image-resize.md). The reference's separate image reveal tooltip, image context-menu parity and complete image keyboard behavior remain gaps; the retained source-plus-renderer architecture is not advertised as the reference tooltip implementation.

## Desktop Live host integration

The Live embed host now mounts the helper only for an actual resolved image root,
removes the generic image source button, and imports its CSS in the application.
A per-editor selected identity maps through source edits. Desktop first-click
selection focuses the editor and puts a collapsed caret at the image source start
without revealing syntax; a selected-image click invokes the current image's
viewer capability directly. Explicit movement to either source boundary retains
selection; other editor selection or a mousedown outside that image clears it.
The document listener exists only while an image is selected and is removed on
editor destruction. A stale helper cannot dispatch after type change or teardown.

The source action selects the current parsed target substring: wiki target excluding
outer spaces and alias, or Markdown destination excluding angle delimiters and
optional title. It keeps the rendered image mounted beside revealed source. Target
positions are reparsed/mapped with document edits, and duplicate images have separate
identities. Controls are disposed before their renderer, including async type changes.
The host does not acquire or release a second image resource lease.

The supplemental static evidence supplied by the image audit is `app.js`
1710824–1711054 (physical-keyboard or focused-editor selection focuses and sets the
caret to widget start), 1711267–1711610 (selection retained at either boundary), and
1714375–1714570 (outside mousedown clears). These offsets use the character-offset
convention and artifact hashes in the shared reference document. Touch selection
without a focused editor differs; the current desktop integration does not claim
that path. There is no canonical mobile hint in `EditorOptions` yet; the helper's
mobile option remains available for later host plumbing rather than viewport guesses.

At this checkpoint 52 focused tests pass (46 editor cases and 6 helper cases), with
scoped TypeScript and whitespace checks. Tests cover real CodeMirror selection,
source mapping after insertion, multiple image identities, source/render ownership,
async type changes and observer teardown. Native visual/interaction verification,
mobile plumbing, resize native verification, reveal tooltip and full keyboard parity remain gaps.
