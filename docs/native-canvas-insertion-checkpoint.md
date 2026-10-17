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

## Native-control follow-up on 5ab350d

A fresh production build passed 54 focused Canvas/embed tests, TypeScript and
Webpack checks. Native verification on Electron 31.6.0 still reproduced the
first-click playback failure when the accessibility Play action was used: the
Live text editor disappeared, its Reading renderer replaced it, and the new
player remained at 0:00. The pointer-path repair alone therefore does not close
this finding. The temporary audio insertion was undone, preserving the existing
card text, and the owned desktop process exited normally. A missing-pointer
focus path is being repaired and requires another native check.

## Electron 44 missing-pointer correction

The production build of `8032d47` ran with the verified Electron 44.8.0 arm64
runtime against the same disposable vault. The first accessibility Play action
changed the Live card's player to Pause while retaining its existing editable
text field. Clicking the adjacent note editor then left Canvas editing normally.
This closes the reproduced missing-pointer activation failure for this native
path; it does not establish every pointer, keyboard or mobile interaction.

The temporary embed was entered using native typing because the automation
clipboard action timed out or produced no insertion in this pass. That clipboard
path remains unverified on Electron 44. Cleanup removed only the temporary audio
suffix after the owned app exited normally; existing text and node geometry were
preserved. Direct WAV-card controls were available throughout this pass, but the
previous intermittent decoder error is not proven fixed. Screenshots remained
mostly white/clipped, so no new pixel-parity claim is made.
