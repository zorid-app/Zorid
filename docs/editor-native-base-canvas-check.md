# Native Base and Canvas verification — 2026-10-16

Tested source: `6b96d1f`, built dist in `editor-base-embed-integration` (not main dist).
Isolated fixture and profile: `/private/tmp/zorid-editor-native-djv1rb47`.
`tested-build.json` records the source/build hashes; `baseline-sha256.json` records all eight synthetic vault files.
Bootstrap only selects isolated userData before requiring candidate desktop/main.cjs.

## Observed results

- Live Edit file Base embed: changed One status Todo to Doing; Reading showed Doing.
- Reading Base embed: changed Two priority 2 to 3; persisted source contains 3.
- Canvas text card rendered the same writable Base, alongside linked note and SVG cards.
- Dragging horizontal and vertical card edges visibly resized the card. Final saved text-card dimensions: width420, height340. Linked note/image geometry and text-card Markdown stayed intact.
- Typed Review in the Canvas Base status input, then dragged the card edge. Value was committed on blur and persisted in One.md; no draft loss observed. The input closed and focus moved to Canvas, so this does NOT establish input-focus retention.
- SHA256 comparison after exit: only One.md, Two.md and Canvas verification.canvas changed. The other five fixture files were byte-identical.

## Failure and limits

Tone.wav stayed Loading in Live Edit and showed Unable to play media in Reading. Python wave validates mono PCM, 16-bit, 8000Hz, 2000 frames; cause remains under source audit. This is a failed playback check, not a verified media implementation.

This bounded pass does not establish Canvas undo/fit/autopan, multi-selection, mobile, full editor parity or complete Bases support. New fenced-Base consumer work was not in this tested build.

Owned Electron session34883 was quit through the UI and returned exit0. Native/heavy slot explicitly released to core coordinator via Orca message msg_892e56adb432. No user vaults or unrelated apps were changed.
