# Canvas insertion native checkpoint

Tested the integrated `80030fd` renderer on macOS Electron 31.6.0 with a
disposable verification vault, before the subsequent audio-only CSS repair.

Observed through native accessibility controls and saved fixture files:

- A linked Markdown card enters the shared Live editor on double-click.
- Its Live checkbox changed from checked to unchecked. After leaving editing,
  the Reading checkbox showed unchecked and could toggle back to checked.
  The original Markdown file persisted the checked state. The previous false
  conflict message did not recur in this sequence; the exact delayed-event
  case is also covered by the reviewed real-CodeMirror regression.
- Add note opened a vault document picker. Selecting the synthetic media note
  persisted a file node pointing to that Markdown file.
- Add media filtered the picker to the synthetic WAV attachment. Selecting it
  persisted a file node pointing to the WAV file.
- Add card persisted an empty text node, but this pass did not establish
  typing into that newly created card. The accessibility tree stopped exposing
  individual card controls and screenshots were mostly white/clipped. This is
  an unresolved native verification gap, not a passing edit test.
- The owned Electron process quit normally after the pass.

The complete candidate passed 1,573 automated tests, TypeScript and production
build checks. Those results do not establish native card placement, attachment
playback inside Canvas, drag/drop behavior, or exact visual parity. No private
vault content or screenshot is included in this report.

## Services and accessibility follow-up

The production build of `3fa19fc` was verified on the same macOS Electron 31.6.0
runtime with original disposable content after the reviewed 1,587-test gate.

- Rich card groups now expose their text editors, checkboxes and native media
  controls in the accessibility tree instead of flattening them into option text.
- Double-clicking a text-card paragraph entered its shared editor. Typed text
  appeared immediately and was confirmed in the actual Canvas JSON.
- Pasting `![[Native media tone.wav]]` rendered an audio player inside the Live
  text card. Its source was persisted in the Canvas node text.
- After leaving and reopening editing, Command-Z removed that pasted embed;
  the saved JSON confirmed the undo while retaining earlier typed text.
- Add card focused a new empty editor immediately. Typing without another click
  persisted a third text node with the expected content.
- Clicking Play inside the Live card exposed a defect: the card switched to
  Reading and the first playback click was lost. A second click in Reading
  changed Play to Pause. An independent real-editor probe reproduced the native
  control blur boundary; its repair is separate from this checkpoint.
- A direct WAV file card temporarily reported a playback error after Canvas
  navigation. A subsequent card creation cleared the error. Resource-lease
  probes have not reproduced premature URL revocation; the cause remains open.

The owned Electron process exited normally after the pass. These observations
establish actual text-card editing and persistence, not complete media, visual,
mobile, drag/drop, or source-reference parity.
