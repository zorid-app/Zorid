# Editor and rendering

[Architecture](README.md) · [Saving](saving-recovery.md) · [Platforms](platforms/desktop.md)

## Current responsibilities

The shared frontend uses TypeScript, DOM/CSS and CodeMirror 6. `Workspace` manages
vault activation, tabs/splits, document views, commands and per-vault NoteBuffers.
`EditorView` and editor extensions own interactive text presentation, selection,
composition, undo and Live Edit rendering. Reading views render document content
without a text editor. Native shells embed these views rather than implementing
a second Markdown editor.

A NoteBuffer represents loaded text and its saved baseline independently of a
particular pane. It coordinates scheduled writes, retained draft state, conflicts
and durable write receipts. Split views must not create competing unrelated save
owners for the same buffer. Rust parses durable source for shared queries; that
parsing does not replace CodeMirror's interactive syntax/state machinery.

Feature views consume typed services: Bases render query results, Tasks edit
note-backed properties/content, Calendar presents scheduled records and joins,
Canvas hosts cards/embeds, and media/PDF views use their dedicated renderers.
Platform capability checks decide what a mounted view can safely invoke.

## Source map

- [Workspace](../../src/ui/workspace.ts), [editor](../../src/ui/editor.ts),
  [NoteBuffer](../../src/ui/note-buffer.ts),
  [durable note lifecycle](../../src/ui/note-durable-state.ts).
- [Editor extensions](../../src/editor/), [Bases views](../../src/bases/),
  [Tasks views](../../src/tasks/), [Calendar views](../../src/calendar/),
  [Canvas](../../src/canvas/).

## Boundary rules

Do not move cursor/IME/undo ownership into the data core. Do not let a successful
render imply that a save committed. Retain original entry/revision/client identity
through async actions; a changed pathname or active pane cannot retarget an old
request. Cache failures must not make source content unsavable.
