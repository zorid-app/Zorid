# Core Plugin: File Explorer

## Purpose

Provide vault navigation and file operations without making file browsing part of the immutable app shell.

## v0 behavior

- Display folder tree for the current vault.
- Create, rename, move, and delete files/folders.
- Open Markdown files into the workspace.
- Reflect external file changes from `VaultWatcher`.
- Support desktop keyboard and context-menu workflows.
- Provide mobile-friendly file list surfaces through shared APIs where practical.

## Uses

- `VaultAPI`
- `WorkspaceAPI`
- `CommandRegistry`
- `EventBus`

## Acceptance criteria

- Large folders are virtualized.
- File operations update the index pipeline.
- The plugin does not access raw Electron filesystem APIs directly.
- The file explorer can be hidden/replaced without breaking vault access.
