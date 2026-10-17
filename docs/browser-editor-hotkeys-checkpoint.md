# Browser editor-hotkey verification

On 2026-10-16, the production renderer matching main `f718f61` was served on
loopback and opened in Chrome on macOS. The browser vault contained only the
synthetic note created during the earlier table-grip visual pass. No user vault
or native Electron instance was used.

Settings listed the 13 scoped editor actions. Assigning Cmd+Shift+9 to Toggle
bold saved successfully. In the live Markdown table, selecting the word `One`
and pressing that chord changed the active cell to `**One**`, with the rendered
table and its nested editor retained. Undo restored the original word.

Selecting the body row through its grip and pressing the same chord rendered
both cells in bold without replacing the table with Markdown source. The note's
character count increased from 79 to 87. One undo restored 79 characters and the
original cell content, with focus still in the first cell editor. Readable browser
screenshots showed the retained row highlight and table. The temporary shortcut
was reset to unassigned afterward, and the test tab and server were closed.

This is actual browser interaction evidence for the configured formatting and
rectangle path, not native Electron, IME, non-US keyboard, mobile or full hotkey
parity. Option-letter normalization still needs a fresh actual-input check. The
reference-backed Bold/Italic default bindings and exact duplicate-binding dispatch
semantics are separate follow-up work; this run used a temporary custom chord.
