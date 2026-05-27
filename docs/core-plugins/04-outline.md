# Core Plugin: Outline

## Purpose

Show headings and structural blocks for the active note.

## v0 behavior

- Outline panel for headings.
- Click heading to navigate editor.
- Optional block IDs/custom blocks display after fields/data-view primitives exist.
- Update on editor changes and index updates.

## Uses

- `EditorAPI`
- `MetadataAPI`
- `WorkspaceAPI`

## Acceptance criteria

- Outline updates without forcing the full editor into Vue state.
- Large documents remain responsive.
- The outline can be hidden/replaced like other core plugin surfaces.
