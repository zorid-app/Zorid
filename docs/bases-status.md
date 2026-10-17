# Current Bases status

Updated after main `812ec51`. Bases does not yet have complete Obsidian feature or
interaction parity. This document distinguishes integrated behavior from older
module-only checkpoints; it is not a completion certificate.

| Capability | Current evidence | Remaining scope |
| --- | --- | --- |
| Standalone Table, Cards, List, Kanban | Integrated workspace sessions; all four mounted in Electron 44 | Exact controls, menus, geometry and mobile behavior |
| Basic property edits | Native table edit saved Markdown; Cards/List reflected it; shared-buffer tests preserve dirty body, caret and undo history | Complete type widgets/coercion, cross-view transaction undo, native failure/restart cases |
| Query/filter/formula/sort/group | Reviewed query engine and configuration parsing | Full expression/reference coverage, summary evaluation, query settings UI and performance profiling |
| Session ownership | Draft/save navigation guards, parked/docked state and file-incarnation checks tested | Persisted Base-specific view state and complete recovery UI |
| Kanban grouping | Explicit groupOrder excludes unlisted groups; Edit columns visibility, manual ordering and automatic sorting integrated through guarded configuration saves | Native drag/drop, popover placement and other interactions remain unverified |
| Base table interactions | Primitive editing and bounded rendering implemented | Multi-cell selection/clipboard, complete header menus, column management, summaries and create-item controls |
| Rich values and thumbnails | Primitive values and local-image thumbnail leases integrated | Complete links/tags/date/list widgets, richer image sources and reference styling |
| Markdown Base embeds | Not integrated | Writable shared-session lifecycle, file embeds and fenced Base configuration |
| Scale and platforms | Latest tab/Kanban aggregate passed 1,795 tests, TypeScript and build; combined independent review passed 45 focused checks | Real large-vault latency/memory, native IME, mobile/touch and complete visual comparison |

The native Board fixture had `groupOrder: [Todo, Done]`. Changing a note's status
to In progress intentionally excluded it from that view; the note was preserved
and shown by other views. This is not evidence of lost data. Missing configuration
controls were the relevant gap. Those controls are now integrated; their native
behavior still needs verification.

See the [workspace checkpoint](bases-workspace-integration-checkpoint.md) for exact
validation scope and [workspace host](bases-workspace-host.md) for storage and
lifecycle details. Editor-wide and shared-core changes remain separately owned.
