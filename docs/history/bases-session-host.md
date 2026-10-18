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

## Cached pane preflight and recovered base configuration

`flush()` settles the same accepted mutations/shared drafts as `close()`, but
retains the mounted renderer and controller. Workspace navigation must await it
before changing tab paths, pane generations or vault ownership. Only actual
resource disposal calls `close()`. `hasPendingChanges()` covers accepted pending
operations, dirty/error buffers still owned by the session, and active/failed/IME
property widgets; the host can use it for unload protection and tab lifetime.
A clean successfully saved buffer is released from session ownership so disposing
that buffer elsewhere cannot permanently prevent closing the base.

Queries intentionally read committed `.base` configuration. Before mounting a
writable base, the host must load its shared base buffer and flush recovered or
dirty configuration through CAS. A recovery conflict rejects navigation while
retaining the previous editor; during startup, display the error while keeping
the recovered shared draft. Do not silently display persisted configuration over
an unresolved recovered config. Editing recovered config text directly remains a
separate recovery UI requirement.

The reference Kanban conversion at app.js `3155364–3155500` consults the global
`metadataTypeManager.getTypeInfo(propertyName).inferred.type`. Only exact
`multitext` wraps non-null, non-array destinations in an array; current source
value shape does not establish this registry type. Zorid's property selection is
currently UI-local, so this session does not invent global type inference. Null
move destinations remove the existing property (reference `3156373`) through the
normal guarded controller mutation. Full registry-driven coercion remains open.

## Reviewed isolated checkpoint

At implementation checkpoint `e75f319`, all **179 Bases-focused tests** pass with
`node --test --test-concurrency=1 tests/bases-*.test.ts`; TypeScript and diff
whitespace checks pass. Independent review separately ran 46 serial probes/tests,
including real Vault/NoteBuffer sessions and synthetic composing-input/final-input
ordering. Review fixes cover failed-save retry falsely reporting success, clean
buffer ownership at close, typed root-folder moves, and failed custom widget
mounts leaving phantom draft markers. Cards/List retain active, failed, composing
and pending checkbox edits through deferred refresh and virtualized scrolling.

No whole-repository gate, production build, Workspace mount, real IME/native
geometry, or mobile verification was performed in this isolated session batch.
