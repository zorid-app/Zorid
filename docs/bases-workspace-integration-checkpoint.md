# Bases workspace integration checkpoint

Source checkpoint `0f2211b` starts from verified main `78d4001` and mounts the
existing Table, Cards, List and Kanban modules for standalone `.base` tabs. It
preserves the current Electron 44 runtime, Canvas/Markdown shared buffers, PDF
links, per-type embed controls and static Canvas previews. No new public plugin,
sync or mobile API is introduced.

The aggregate includes the reviewed session chain `20dec27`, `04291ba`,
`3a20405`, `5cabe33`, `d38cc80`, `e75f319`, `da7c8c3`, followed by reviewed
Workspace host `f1e4b04`. The bundle imports all five session/view styles once.
The earlier standalone session ledger remains historical; standalone Workspace
mounting and bundle style integration are implemented at this checkpoint.

Shared property edits retain the existing NoteBuffer write validation and recovery
path. Navigation preflights pending edits without disposing the session; actual
runtime closure disposes it after its save gate. Parked/docked sessions retain
active drafts and selected views. Same-path recreated files cannot reuse a retired
dirty buffer. Thumbnail leases and query ownership remain bounded by the owning
session. See `bases-workspace-host.md` and `bases-session-host.md` for detailed
contracts and unresolved behaviors.

## Verification

- 63 focused session, draft, Workspace Bases and docking tests passed serially.
- The whole repository suite passed **1,712/1,712 tests**, zero failures/skips,
  with concurrency two in 52.504 seconds.
- Direct TypeScript checking passed.
- Production webpack build passed in 6.714 seconds with three bundle/performance
  warnings. The main entry is 1.42 MiB; this is not a performance-parity claim.
- Independent aggregate review confirmed production files match reviewed authors
  and the five styles remain scoped. An additional real Workspace/Canvas/Bases
  probe verified property edits preserve the linked-note CodeMirror instance and
  unsaved body; closing the Base leaves subsequent Canvas editing/save usable.
- The committed source delta passed a separate credential/private-path scan.

The tests do not establish native layout, drag geometry, real IME, mobile behavior
or complete reference toolbar/menu parity. Markdown Base embeds remain separate.
Persisted Base-specific view state, full global property-type coercion, recovered
config editing UI and richer thumbnails remain documented gaps. No Electron app
was launched during this integration gate.

## Native desktop checkpoint

The identical reviewed renderer was run from main `19c4684` with Electron 44.8.0
arm64 against two original disposable notes and a four-view Base. Table, Cards,
List and Board all mounted through the native view selector. Editing Alpha's
status from Todo to In progress in the table saved the actual Markdown file;
Cards and List subsequently displayed the new value with the existing priority.

The Board exposed only Todo and Done after that edit when the fixture explicitly
specified `groupOrder: [Todo, Done]`. Whether the missing new group follows the
reference contract is under audit; this observation is not a full grouping-parity
pass. Native drag/drop, selection geometry, IME, failed writes and restart recovery
remain unverified by this pass. The owned app exited normally after verification.
