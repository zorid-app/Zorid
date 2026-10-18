# Desktop

[Architecture](../README.md) · [Editor](../editor.md) · [Storage](../storage.md)

## Current

Electron owns the application process, windows, native menus, vault selection and
OS integration. A BrowserWindow loads packaged `dist/index.html`, or the explicitly
configured Vite development URL. The renderer runs TypeScript/DOM/CSS and CodeMirror
6; Rust does not draw the editor.

```text
Electron main → BrowserWindow → src/main.ts → Workspace → editor/document views
                                      ↓
                    platform adapter → sandboxed preload → IPC
                                      ↓
                        Rust desktop host process → NativeVault
```

The renderer is sandboxed, with context isolation enabled and Node integration
disabled. `window.zorid` exposes bounded application operations through preload.
Main checks caller authority before forwarding requests; the frontend does not
open SQLite or filesystem handles directly.

Normal desktop vaults use the Rust-backed path. The Node service starts
`zorid-desktop-host` and exchanges framed stdio messages. Rust commits database
state and separately projects changes to ordinary vault files. The shared
NoteBuffer remains responsible for loaded editing state and the save lifecycle.
A host receipt, visible file and synced update are distinct facts.

## Source map

- [Electron main](../../../desktop/main.cjs), [preload](../../../desktop/preload.cjs).
- [Rust default selection](../../../desktop/editor-core.cjs) and
  [host process service](../../../desktop/rust-vault-service.cjs).
- [Platform selection and capabilities](../../../src/platform/index.ts).
- [Startup](../../../src/main.ts), [workspace](../../../src/ui/workspace.ts),
  [note buffer](../../../src/ui/note-buffer.ts).

## Accepted direction

Saving/recovery correctness and measured indexing/search performance come first.
Complete desktop Bases, Tasks, Calendar and Google integration before resuming iOS
implementation. App-local per-vault cache/recovery databases are planned; current
native index tables still share the vault authority database.
