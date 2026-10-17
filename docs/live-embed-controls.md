# Live embed controls implementation

This original implementation follows the static classification and CSS evidence in
[embed-controls-reference.md](embed-controls-reference.md). It changes only Live
Edit widgets; the shared Reading renderer and viewer controls keep their ownership.

Controls are selected from the actual renderer root and its immediate loading or
error children. Filename extensions do not establish a supported viewer. Audio,
video and an actual Canvas renderer have no generic source overlay. A rendered
note reuses its existing navigation anchor as the `Open link` maximize control.
PDF and actual Bases renderers retain explicit source controls, with the inspected
PDF toolbar reserve and direct-editor Bases header reserve. Unknown and unavailable
renderers retain a source fallback. The current shared `.base` and `.canvas` routes
are still unavailable attachment fallbacks; this change does not implement those
viewers. Image-specific interaction is a separate integration.

Each widget observes only root class and immediate child changes, so lazy resolution
updates controls without replacing the renderer or watching nested render churn.
Cleanup disconnects that observer and resize measurement, removes owned handlers,
invalidates retained note anchors, then releases the renderer. Source reveal keeps
the existing rendered owner and editable syntax together.

Validation: 38 focused CodeMirror/editor tests pass, including async type changes,
unsupported-extension fallbacks, note navigation identity and stale anchors, PDF
source/viewer control separation, native video default behavior, observer bounds,
source reveal ownership, and existing media deletion/undo cases. Scoped TypeScript
checking and `git diff --check` pass. CSS tests verify selector applicability and
computed declarations in JSDOM; they do not establish native geometry or visual
parity. Root native verification remains required. Note navigation modifiers still
follow the shared renderer's existing callback, which currently omits modifier
information; this patch does not claim new-window/split modifier parity.
