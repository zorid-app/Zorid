# Tab preview and Kanban column integration checkpoint

Production checkpoint `d282e8d` starts from main `f0898d8` and contains reviewed
tab split preview `b616e4e`, Kanban UI chain `cbc8186`, `7438972`, `e4bd365`,
`29ccca4`, and guarded configuration persistence `ddb6569`. Merge `7b1dc8d`
subsequently incorporates main `8cfe95d`, which adds native-evidence documentation
only. Editor hotkey consumers, the Option-key normalization follow-up, Canvas
resizing and shared-core changes remain outside this batch.

Tab dragging previews the destination remainder as an inert, resized snapshot
alongside the existing split highlight. Cleanup restores destination appearance
on cancellation, completion and owner retirement. This changes preview rendering,
not the split model or cross-window transfer protocol.

Kanban column controls now configure visibility, manual order and automatic sort
through the existing BaseSession and guarded shared NoteBuffer. Stored display
labels resolve to canonical typed query keys, including list and null groups;
successful configuration acknowledgments preserve group counts. Configuration
changes only Base view options, retaining unknown fields and note contents.
Failed absolute patches retry only against the captured committed or exact desired
source; stale views, changed file identity and external edits still reject.
Readonly sessions expose no configuration mutation controls.

The sole merge conflict was additive Lucide imports/aliases. The aggregate keeps
both table grip orientations and the Kanban visibility/order icons, with one
`grip-vertical` alias. Existing Workspace/Bases lifecycle and recently integrated
hotkey/image/table behavior remain unchanged.

## Verification

- 67 focused tab, Kanban UI, configuration/controller and icon tests passed
  serially on the combined source.
- The full suite passed **1,795/1,795 tests**, no failures or skips, with
  concurrency two in 52.480 seconds on `d282e8d`.
- TypeScript checking and production build passed on `7b1dc8d`; webpack took
  6.290 seconds and emitted three bundle/performance warnings.
- The six feature commits passed a separate source credential/private-path scan.

These checks do not establish native preview geometry, accessibility output,
Kanban drag/popover pixels, real IME or mobile parity. No Electron app or packaging
job was launched by this integration lane. Root owns native verification. The
individual tab-docking and Bases column-action ledgers retain their narrower
implementation boundaries and deliberate safety choices.
