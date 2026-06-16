# Zorid Markdown Table Editor Ultragoal

Implement a first-party editable Markdown pipe table widget for all Markdown documents in `@zorid/editor`.

Constraints:

- Use CodeMirror/Lezer syntax tree discovery as the primary table detection path.
- Keep table internals private under `packages/editor/src/live-preview/table/`.
- Do not export table internals from package barrels or public APIs.
- Treat Markdown source as canonical; durable edits must be CodeMirror transactions and normal undo/redo.
- Provide editable cells, keyboard navigation, structural row/column selection and guarded deletion, context/plus controls, and desktop-scoped styling.
- Keep rectangular selection, alignment controls, dense plus controls, and public API expansion out of scope.
