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
