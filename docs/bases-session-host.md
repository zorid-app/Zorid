# Existing Bases modules: session integration

`createBaseSession` composes the existing Table, Cards, List and Kanban modules
with the existing query/controller and shared note buffer. This is an internal
composition layer, not a plugin API redesign. Those four implementations are the
views available in this checkpoint; this does not establish that every reference
view or interaction is implemented.

## Workspace and Markdown embed contract

The caller creates a container with available height and mounts a session with:

- `vault`, the current `.base` path, selected `query.viewIndex`, and `validate`
  checking the owning workspace/pane/vault generation.
- `buffers.getBuffer`, returning the existing shared `NoteBuffer` for that file;
  never create a second private buffer if a dirty draft already exists.
- `buffers.onBufferChange(path, buffer, previousText)`, updating every peer editor
  and mapping inactive selections from the supplied exact prior text. The
  callback is after the synchronous transform, before persistence. Recovery and
  CAS remain owned by NoteBuffer. Failure must remain visible to the caller.
- Optional guarded `buffers.rename`: flush related shared buffers, validate inside
  the serialized host rename, preserve collision checks and migrate existing
  pane/buffer paths. The session never uses adapter.rename directly. Folder
  grouping is disabled without this capability; root `/` maps to the empty
  vault-relative parent.
- `openFile`, retaining the original modifier-bearing mouse/keyboard event.
  Optional `loadThumbnail` must use permitted resource ownership and revocation.

Import `session.css`, `table-view.css`, `cards-view.css`, `list-view.css` and
`kanban-view.css` in the host bundle. No primary workspace or bundle imports have
been changed by this isolated preparation. `.base` routing and Markdown embedded
bases still require the workspace/renderer owners to mount this session.

A Reading embed may pass `readOnly: true` without a buffer host. Writable embeds
must use exactly the same shared-buffer and ownership validation contract as a
workspace pane. The current session view selector is a composition control;
reference toolbar/menu/spacing parity remains a separate native check.

## Persistence and teardown

Edits carry the rendered numeric query revision. Tagged expression values are
converted explicitly to YAML-compatible values; unsupported computed/date/regex
values reject instead of saving display text. Kanban moves additionally validate
the grouped property, current source group and existing destination group. Typed
empty groups and configured empty columns retain their distinct values. Unknown
base root/view options remain in the original BaseDocument; switching views does
not rewrite the file.

Query refreshes cannot overwrite an active default property draft. View switches
and close reject while uncommitted/invalid text remains, so the host must leave the
view attached and let the user finish or cancel. `close()` first waits for accepted
operations and flushes changed shared buffers, then disposes the renderer and
controller. A write/ownership failure rejects and leaves recovery/UI alive. The
host must await close before removing the pane; a synchronous Markdown disposer
must route through an async owner rather than silently ignore close failures.
This is a concrete integration prerequisite, not a claim that current Workspace
or Markdown teardown already satisfies it.

Version checks do not rebase stale edits merely because a path still exists. A
query change while typing keeps the original revision; committing that draft may
reject and leave it visible. Complete reference conflict UX, menus, selection,
Kanban multitext semantics, state persistence and native/mobile verification remain
outside this composition checkpoint.

## Evidence

Focused tests instantiate real Vault/MemoryAdapter/NoteBuffer and DOM renderer
modules: all four views mount, Table edits preserve a shared dirty Markdown body,
Kanban guards reject forged source/property/destination, unsupported values cannot
be persisted, immutable config is retained, readonly embeds cannot mutate, and
close waits for accepted writes. Independent probes cover CAS failures/retry,
exact prior-text callbacks, deferred query error publication and vault-root moves.
No full suite, production build or native Electron verification is implied here.
