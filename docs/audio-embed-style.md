# Live audio embed controls and spacing

The 2026-10-16 user screenshot showed the generic source-edit overlay covering native audio controls. The original audio-specific fix hides that action, makes the direct audio embed a block, and removes the generic widget's 12 px top/bottom padding. It preserves audio width 100%/height 42 px, the existing inline available-width rule, CodeMirror line geometry, source selection handlers and renderer ownership. Image, PDF and containing-note controls retain their existing styling.

Reference audit: supplied Obsidian 1.14.4 artifact and hashes are recorded in [media-embed-reference.md](media-embed-reference.md). The historical E3 record was unavailable in the current REA ledger; the recovered artifact hashes were checked directly without rerunning a producer or executing reference code. Offsets below are zero-based decoded Unicode character offsets, not bytes.

- `app.js` 3029600–3031100 creates explicit source actions for PDF/Bases branches; audio/video use the generic click hook. PDF and Bases identities resolve at 2677016 and 2547872; local media classes are at 2681753–2682600.
- `app.js` 1949481–1951200 registers generic source-selection click handling without adding an action. The own-line nonimage widget path around 3044850–3047350 adds no fixed 12 px padding.
- `app.css` 331675–332200 gives audio 100% width and 42 px height; 370156–370310 makes nonimage internal embeds block-level and caps media width. No ordinary audio padding/margin rule was found in the focused audio stylesheet audit. Popover and Canvas styles have separate scopes.

Only audio styling changes here. Other media parity remains separately queued. The existing generic wrapper click still exposes source while preserving the rendered player; native media clicks remain interactive. No deletion, caret mapping, keyboard, source-reveal or resource code changed.

Validation: 33 serial Live embed tests passed, including actual `createEditor` block/inline audio controls, selector applicability, source-selection preservation, renderer retention, image/PDF/enclosing-note isolation, and existing Backspace/Delete/undo/redo boundaries. JSDOM assertions establish CSS applicability and interaction ownership, not native pixel geometry or the user's screenshot match. Root owns native verification of spacing, native playback controls and pointer hit testing.
