# User findings queue

This queue supplements the full parity ledger. It records recent user steering;
older requirements remain in `parity.md` and `interaction-parity.md`. Implementation
and verification are separate. Work is sequenced by dependencies and user impact,
not by message arrival order. The user may keep sending findings without ordering
them or interrupting the current work.

| Finding / requested behavior | Current state | Next evidence or work |
| --- | --- | --- |
| No dash before task checkboxes; black bullets 25% larger with no visible underlying hyphen | Implemented; native screenshot confirms correction | Retain selection, source-reveal and theme coverage |
| Remove “No file is open” from new tabs | Removed in source (`4aa0fc9`) | Verify next built desktop checkpoint |
| Table right-click menus match reference, including delete row/column | Single-cell Row/Column/sort menus implemented and observed natively; active-cell formatting and popup focus fixes in progress | Complete active/selected-cell states, action verification and reference comparison |
| Whole row/column and multiple-row/column selection | Reference audit and implementation assigned | Implement handles/ranges, clipboard, keyboard and selection-dependent menus |
| Context menus match across all applicable elements | Parallel audits and modules assigned for workspace, properties, images/attachments, PDF, Canvas and links | Integrate and verify each surface and conditional action |
| Toolbar context menu opens far away from its trigger | Missing toolbar anchor identified; host repair assigned | Anchor to button bounds and verify native placement, window movement and zoom |
| Top-left chrome and file toolbar match reference; use a maintained prebuilt icon set | Dedicated icon and chrome layout worker assigned | Replace hand-drawn icons, match ordering, sizes and spacing; compare native screenshots |
| Sidebar open/collapse controls stay at the outer edge in the top tab bar, both open and closed | User screenshots received; focused chrome audit assigned | Match placement through tab overflow and split changes; verify native geometry |
| Empty top-bar areas drag the window; double-click expands it; tabs/buttons retain their own interactions | Chrome worker coordinating with native window owner | Implement platform window behavior and verify drag, double-click, and interactive exclusions |
| Right-click empty space in the left file list matches Obsidian's background menu | Focused file-operations reference audit and implementation assigned | Match ordered actions, availability and root-folder targets; verify native popup |
| New-folder creation UX and dragging items in the file tree match Obsidian | Queued with the next file-explorer batch; current desktop checkpoint stays first | Audit inline naming/focus/cancel, drag thresholds, destination feedback, multi-selection and move outcomes |
| Math rendering matches Obsidian in Reading and Live Edit | Dedicated renderer/reference worker assigned | Establish engine/configuration, inline/display parsing, editing transitions, and bounded rendering cost |
| Community plugin system and compatibility | Lifecycle foundation merged; 20 focused tests pass; no production loader or PluginHost consumer | Implement shared module resolver, real app services, registries and management; actual community-plugin compatibility remains unverified |
| PDF embed appearance matches Obsidian | Native rendering/search/page-targeted Live Edit embedding verified; specific styling under implementation | Compact toolbar, sizing, border/background/spacing and Reading/Live Edit comparison |
| Clicking `</>` on an embed reveals its source while keeping rendered content visible | Reported; focused reference audit and repair assigned | Preserve widget identity, selection geometry, source editing and re-hide behavior across embed types |
| Obsidian-style `[[` links and suggestions | Completion behavior implemented and tested; user reports popup still visually different; independent visual audit scheduled | Correct typography, spacing, result rows, highlight, placement and sizing after current integration checkpoint; native visual comparison remains required |
| Split views, including nested horizontal/vertical arrangements | Host integration and automated state/history tests pass | Native split, resize and restore checks; remaining docking/selection behavior |
| Drag tabs to pane edges to split; drag out to a new window | Focused reference audit and reusable drag controller assigned | Preserve dirty buffers, editor history, caret and tab identity across moves and windows |
| ⌘1–⌘9 selects tabs; ⌘T new tab; ⌘N new file; ⇧⌘N new Zorid window | Shortcut contract assigned to workspace keymap worker | Verify active-pane order, modifiers, focused inputs and native window lifecycle |
| Canvas appearance matches Obsidian exactly | Dedicated Canvas styling audit and implementation assigned after context menus | Cards, background, connections, selection outlines, controls, typography, spacing and native comparison |
| Click blank note space to start typing, including empty/property-only notes | Reference sizing and focus behavior audited; focused repair assigned | Preserve property/title/embed interactions and verify native blank-space clicks |
| Enter after a new filename should focus the note body | Async rename/rerender focus race identified; repair assigned with blank-note focus | Wait for successful rename and focus the current editor; preserve newer user focus intent |
| Opening an existing file should not expose the first line's Markdown automatically | New inline renderer reveals syntax only for focused editor selections; opening-focus audit assigned | Verify sidebar open separately from intentional title-Enter and body clicks in next native build |
| Obsidian-style launch page and vault selection | Existing basic chooser; full launch/create/open/recent-vault flows queued | Audit reference flows and implement after higher-priority editor dependencies |
| Use maximum useful parallel agents with good architecture and independent verification | Persisted in `AGENTS.md`; implementation, audits, integration and review assigned in parallel | Reassign available workers as useful scopes become independent |
| LiveSync-style easy default sync, FullCalendar and TaskNotes-style task/calendar features | Explicitly deferred by user until editor base is solid | Discuss only at that stage; see `deferred-product-roadmap.md` |

Editor correctness remains the immediate priority: cursor/selection geometry,
complete live rendering, tables, properties, embeds, clipboard, keybindings,
recovery and performance. This queue does not certify complete editor parity.
