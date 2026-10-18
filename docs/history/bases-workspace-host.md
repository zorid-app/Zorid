# Bases workspace host integration

This original host wiring mounts the reviewed `createBaseSession` for `.base`
files. The session composes the existing Table, Cards, List, and Kanban views.
It is not a new plugin API, a complete reference interaction implementation, or
native/visual verification.

## Ownership and persistence

A pane stores its BaseSession alongside its existing TabViewRuntime. Parking and
same-window docking move that same session and DOM, including an active property
input; they do not recreate the controller or save merely to move it. A cached
session retains its selected view. Serialized workspace view selection and other
Base-specific UI state are not added in this slice.

Navigation and workspace save first call the non-destructive session `flush`.
An invalid/uncommitted property draft or failed persistence rejects before the
normal navigation model changes. Runtime destruction awaits `close` before
releasing the wrapper. The before-unload check includes Base pending changes.
File removal retains a Base with active drafts; clean cached sessions close and
release their query subscriptions. Config modification leaves the session alive
so its own controller can refresh without discarding property input.

The host supplies the shared `bufferFor` registry. The post-transform callback
uses its exact previous source to map inactive selections, updates live and
cached peer editors using their external-change path, and invalidates managed
embeds. It does not replace the buffer, replay the transformation, or add another
save queue. Controller validation and NoteBuffer optimistic writes remain active.
A host buffer identity token prevents an old dirty buffer from being reused for a
same-path recreated file, even when the recreated file has identical bytes. Clean
buffers can reload and reconnect. A genuine rename migrates only a matching
buffer identity.

The controller deliberately reads committed `.base` configuration. Before
replacing an existing tab, the host loads and flushes its shared config buffer; a
conflicting recovered draft rejects and retains the prior tab. A restored startup
Base with a conflict shows an error and retains recovery instead of rendering
unrelated disk config. This does not add a raw Base source editor or a conflict
resolution UI.

Folder-group Kanban moves use `Vault.rename` with in-queue source, result, vault
and destination collision validation. The adapter flushes shared buffers, not
`Workspace.flush`, which would recursively await its own accepted Base action.
A flush that changes the query can make the original move stale; it must be
retried against the refreshed result. Existing vault rename listeners migrate
open paths and buffers.

File opening preserves ordinary versus modifier/middle-button new-tab intent.
Cards thumbnails are limited to local image files resolved from plain paths or
wiki links (including aliases), use shared AttachmentResources leases, and release
late/retired leases. Remote thumbnails and richer thumbnail expressions are not
implemented here.

## Integration and verification

Base: reviewed PDF/embed checkpoint `3676a95`, current main `5ab350d`, and the
reviewed Bases adapter chain `20dec27`, `04291ba`, `3a20405`, `5cabe33`, `d38cc80`,
`e75f319`, `da7c8c3`. The integration owner must import these existing styles:

- `src/bases/session.css`
- `src/bases/table-view.css`
- `src/bases/cards-view.css`
- `src/bases/list-view.css`
- `src/bases/kanban-view.css`

Focused tests use actual Workspace, Vault, NoteBuffer, CodeMirror and all four
Base views. They cover shared dirty text, multi-caret mapping and undo, parked
selection/history, failed/repeated saves, accepted-write navigation, draft close
and vault-switch guards, same-window docking, source/target recreation, recovered
configuration, local thumbnail leases, cached deletion, file opening, and actual
Kanban folder movement. This does not establish native drag geometry, CSS layout,
mobile behavior, or full reference menu/toolbar parity. Markdown Base embeds and
static Canvas embeds remain separate host work.

Validation for this host snapshot: 101 focused Workspace/Bases/docking/NoteBuffer
tests and direct TypeScript checking pass. Independent review reran the first
14 host cases plus a delayed-thumbnail retirement probe and cleared the production
identity/lifecycle changes. The final parked-caret test also passes.
