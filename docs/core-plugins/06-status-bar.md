# Core Plugin: Status Bar

## Purpose

Provide official status bar contributions while the shell owns the status bar container.

## v0 behavior

- Indexing status.
- Active file metadata summary.
- Save/dirty status.
- Error/sync placeholder status.
- Plugin contribution API for future status items.

## Uses

- `EventBus`
- `MetadataAPI`
- `EditorAPI`
- `WorkspaceAPI`

## Acceptance criteria

- Shell owns layout; plugin contributes items.
- Status updates are small reactive slices, not global rerenders.
- Status items can be enabled/disabled by plugin lifecycle.
