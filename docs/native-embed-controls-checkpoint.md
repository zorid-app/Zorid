# Native embed controls checkpoint

The production build of `78d4001` was exercised with Electron 44.8.0 arm64 in a
disposable vault using an original SVG and a three-card Canvas fixture.

- Live Edit resolved the image into a rendered preview with Zoom in and Edit
  image source actions.
- Edit image source revealed the Markdown and selected its filename while the
  rendered image and both image actions remained mounted.
- Zoom opened an image viewer reporting one image at 100%. Closing it restored
  the note with its rendered preview and source selection still present.
- The static Canvas preview exposed its title and three-card/zero-connection
  description. Activating it opened the correct Canvas document.

That final navigation reproduced the unresolved direct-audio defect: the cached
Canvas had a playable WAV card at startup, but returning through the preview
showed "Unable to play media." Clicking Play did not change the state. The
adjacent note used the same WAV successfully. The attachment investigation now
has this specific workspace/cache transition; isolated resource-lease tests do
not establish that the native decoder path is correct.

The owned desktop process was closed after the pass. These observations verify
native action outcomes, not exact geometry, screenshot parity, mobile behavior,
modifier-key navigation or every image/PDF interaction. Fixtures remain outside
project source and contain no user notes.
