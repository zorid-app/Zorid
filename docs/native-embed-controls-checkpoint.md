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

That final navigation produced the accessibility label "Unable to play media."
for the direct WAV card; the initial automation Play attempt showed no change.
A follow-up diagnostic build, instrumenting the actual media element, found no
media error: metadata loaded, readyState was 4, networkState was 1, and canplay
fired. The same direct card subsequently emitted play, pause and ended, and the
native time control reached 0:02 while the misleading accessibility label
remained. External window activity occurred between activation attempts, so this
pass does not establish which click triggered playback.

The diagnostic evidence refutes the earlier inference that this accessibility
label alone proved a decoder failure. The app's own error text is "Unable to play
this media.", a different string. No speculative retry was added. First-click
activation consistency still requires controlled native verification; a direct
file playback failure is not confirmed by this observation. Diagnostic changes
were isolated and were not merged into production.

The owned desktop process was closed after the pass. These observations verify
native action outcomes, not exact geometry, screenshot parity, mobile behavior,
modifier-key navigation or every image/PDF interaction. Fixtures remain outside
project source and contain no user notes.
