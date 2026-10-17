# Canvas and Bases UX goal

User explicitly selected this as the new scoped goal on 2026-10-16. The earlier broad parity goal remains paused; this task does not resume unrelated editor, sync or migration work. The thread goal API rejected replacing the unfinished paused objective, so this repository record is the current task scope until the tracker can be replaced. Never mark the earlier objective complete merely to clear the tracker.

## Required outcomes

1. Canvas edit controls are reliably clickable and do not trigger resize, at supported zoom levels. Edge resizing remains available.
2. Canvas Markdown retains consistent typography, spacing, content width and rendered elements when switching between editing and preview. Intentional source reveal/caret changes may remain; no avoidable layout jump.
3. Resizing is responsive, avoids rebuilding rich cards per pointer event, preserves drafts and commits a coherent undoable size change.
4. Trackpad scrolling over non-scrollable cards pans the Canvas. Scrollable content can consume its available scroll, with intentional boundary chaining; interactive controls and modifier zoom retain sensible behavior.
5. Bases uses an Obsidian-informed compact layout and meaningful view/filter/sort/property controls. Layout adapts to actual pane width, not just viewport width. Controls remain accessible at narrow widths.
6. Verify core Bases behavior through real actions: view selection, filtering, sorting, property visibility and edits persist to the intended files. Clearly record unsupported actions rather than exposing decorative controls.

## Ownership and delivery

- Canvas interactions: canvas_document, isolated `tingkai-c/canvas-interactions`, view.ts and interaction CSS.
- Canvas edit/preview style: editor_cross_review, coordinated markdown-card-specific source/CSS.
- Bases reference/layout: bases_header_audit, separate isolated branch.
- Bases functional acceptance/review: bases_controller.
- Root coordinates independent review, native validation and findings. Core session retains sole main integration ownership.

Use existing pinned REA evidence and focused artifact inspection; proprietary source/CSS stays outside project source. Serialize heavy tests/builds/native runs on the 8 GB machine. Close owned test Electron after verification. Integrate coherent reviewed batches only.

## Completion bar

All six outcomes need scoped implementation and meaningful checks. Run focused regressions, TypeScript, and a combined production/native pass of synthetic Canvas/Bases fixtures. Compare editing/preview and wide/narrow layouts visually, and exercise edit-button clicks, resize, wheel behavior and persisted Base actions. Record exact source/build evidence and remaining non-blocking polish. Completion does not require discovering every possible edge case, and does not certify the entire app suite.

Status: source investigation/implementation started; no fixes or native outcomes claimed yet.
