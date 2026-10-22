# Current Bases status

Current pass scope: [Bases implementation goal](plans/bases-implementation-goal.md).
The table below records older observed implementation/evidence; reconcile it with
current source rather than treating its age or aggregate checks as acceptance of
the new pass. Named note Types are removed from the target; rich property value
definitions and complete template copying remain required.

Updated after main `87c3eb1`. Bases does not yet have complete Obsidian feature or
interaction parity. This document distinguishes integrated behavior from older
module-only checkpoints; it is not a completion certificate.

| Capability | Current evidence | Remaining scope |
| --- | --- | --- |
| Standalone Table, Cards, List, Kanban | Integrated workspace sessions; all four mounted in Electron 44 | Exact controls, menus, geometry and mobile behavior |
| Basic property edits | Native table edit saved Markdown; Cards/List reflected it; shared-buffer tests preserve dirty body, caret and undo history | Complete type widgets/coercion, cross-view transaction undo, native failure/restart cases |
| Query/filter/formula/sort/group | Reviewed query engine and configuration parsing | Full expression/reference coverage, summary evaluation, query settings UI and performance profiling |
| Session ownership | Draft/save navigation guards, parked/docked state and file-incarnation checks tested | Persisted Base-specific view state and complete recovery UI |
| Kanban grouping | Explicit groupOrder excludes unlisted groups; Edit columns visibility, manual ordering and automatic sorting integrated through guarded configuration saves | Native drag/drop, popover placement and other interactions remain unverified |
| Base table interactions | Range, row and column selection plus TSV/Markdown/Obsidian-table copying integrated; native editable-control text selection retains copy ownership | Paste/clear, raw metadata clipboard, complete header menus, column management, summaries, create-item controls and native geometry |
| Rich values and thumbnails | Primitive values and local-image thumbnail leases integrated | Complete links/tags/date/list widgets, richer image sources and reference styling |
| Markdown Base embeds | Reviewed file-embed host committed separately; isolated main reconciliation passed 38 focused checks, not yet integrated | Combined review/full gate, native verification and fenced Base configuration |
| Scale and platforms | Latest Canvas/Table aggregate passed 1,873 tests, TypeScript and build; independent interaction and reconciliation review cleared | Real large-vault latency/memory, native IME, mobile/touch and complete visual comparison |

The native Board fixture had `groupOrder: [Todo, Done]`. Changing a note's status
to In progress intentionally excluded it from that view; the note was preserved
and shown by other views. This is not evidence of lost data. Missing configuration
controls were the relevant gap. Those controls are now integrated; their native
behavior still needs verification.

See the [workspace checkpoint](history/bases-workspace-integration-checkpoint.md) for exact
validation scope and [workspace host](history/bases-workspace-host.md) for storage and
lifecycle details. Editor-wide and shared-core changes remain separately owned.
