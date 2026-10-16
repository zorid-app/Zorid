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
| Sidebar open/collapse controls stay at the outer edge in the top tab bar, both open and closed | Integrated; native open/closed checks found and fixed duplicate legacy controls (`cb7a718`) | Verify split/tab-overflow geometry and exact reference placement |
| Empty top-bar areas drag the window; double-click expands it; tabs/buttons retain their own interactions | Chrome worker coordinating with native window owner | Implement platform window behavior and verify drag, double-click, and interactive exclusions |
| Right-click empty space in the left file list matches Obsidian's background menu | Integrated; native background menu showed New note, New folder, New canvas in order and New note created a file | Inline folder integration and broader conditional/reference checks remain |
| New-folder creation UX and dragging items in the file tree match Obsidian | Isolated host integration and independent review in progress; creation and drag helpers implemented | Audit inline naming/focus/cancel, drag thresholds, destination feedback, multi-selection and move outcomes |
| Math rendering matches Obsidian in Reading and Live Edit | Local MathJax 4.1.3 modules implemented; integrated rendering/ownership review underway; abandoned queued work fix independently cleared | Complete combined build and native inline/display editing verification |
| Clean Zorid plugin API; Obsidian plugin compatibility no longer required | User changed direction, then explicitly requested discussion before API design changes; registry work paused with no files changed | Discuss capabilities, lifecycle, extension surfaces and trust model before implementing a new API |
| App-managed syncable plugin data and secret storage | Requested for architecture discussion; not implemented | Agree on data scope, conflict semantics, schema evolution, recovery and secret access/sync policy; no API redesign yet |
| Native mobile shell with only the core editor in a WebView | User considering this direction; existing Capacitor scaffold remains | Discuss native UI extension model and shared data ownership; measure a prototype before choosing runtime |
| Separate sessions/worktrees for plugins, sync/data and mobile | Readiness assessed: isolated research/prototypes possible, shared contracts not stable | Coordinate owners and contracts; discussion does not authorize independent public API redesign |
| Local audio embed fails in packaged Electron | Fixed in `02f3421`; native Reading playback switched Play/Pause and advanced to 0:02, Live Edit retained controls | Other codecs, video, native menus and mobile playback still need verification |
| Deleting apparent blank line above audio makes player disappear | Native reproduction: underlying embed Markdown remains, but joins preceding heading; player loses normal controls/layout | Fix source-row/caret geometry and inline embed sizing; verify real blank-line deletion separately and retain playback/source |
| Canvas undo disappears after saving card text | Fixed in `c656637`; native Cmd+Z and toolbar Redo restored expected content, verified in actual Canvas file | Broader Canvas selection/drag/history and cross-pane cases remain in verification queue |
| Show file type in file tree only for types Zorid does not recognize | Latest user correction: hide extensions for recognized types, retain them for unknown types; assigned | Use actual supported handlers, preserve full-path accessibility and distinguish same-basename files; native verification pending |
| PDF embed appearance matches Obsidian | Native rendering/search/page-targeted Live Edit embedding verified; specific styling under implementation | Compact toolbar, sizing, border/background/spacing and Reading/Live Edit comparison |
| Clicking `</>` on an embed reveals its source while keeping rendered content visible | Reported; focused reference audit and repair assigned | Preserve widget identity, selection geometry, source editing and re-hide behavior across embed types |
| Obsidian-style `[[` links and suggestions | Typography/spacing correction integrated; native popup rendered file rows and heading/block/display footer | Exact reference pixel comparison, placement edge cases and full result varieties remain required |
| Split views, including nested horizontal/vertical arrangements | Host integration and automated state/history tests pass | Native split, resize and restore checks; remaining docking/selection behavior |
| Drag tabs to pane edges to split; drag out to a new window | Focused reference audit and reusable drag controller assigned | Preserve dirty buffers, editor history, caret and tab identity across moves and windows |
| ⌘1–⌘9 selects tabs; ⌘T new tab; ⌘N new file; ⇧⌘N new Zorid window | Shortcut contract assigned to workspace keymap worker | Verify active-pane order, modifiers, focused inputs and native window lifecycle |
| Canvas appearance matches Obsidian exactly | Dedicated Canvas styling audit and implementation assigned after context menus | Cards, background, connections, selection outlines, controls, typography, spacing and native comparison |
| Click blank note space to start typing, including empty/property-only notes | Reference sizing and focus behavior audited; focused repair assigned | Preserve property/title/embed interactions and verify native blank-space clicks |
| Enter after a new filename should focus the note body | Async rename/rerender focus race identified; repair assigned with blank-note focus | Wait for successful rename and focus the current editor; preserve newer user focus intent |
| Opening an existing file should not expose the first line's Markdown automatically | New inline renderer reveals syntax only for focused editor selections; opening-focus audit assigned | Verify sidebar open separately from intentional title-Enter and body clicks in next native build |
| Obsidian-style launch page and vault selection | Existing basic chooser; full launch/create/open/recent-vault flows queued | Audit reference flows and implement after higher-priority editor dependencies |
| Launch should reuse the previously open vault and workspace | Native relaunch restored the saved test vault, both tabs and contents; unavailable previous folder falls back to chooser | Complete broader startup/multiple-vault lifecycle reference comparison |
| Close agent-launched Electron after testing on the 8 GB MacBook Air | Persisted resource policy in AGENTS.md; latest native pass ended with exit zero and no Electron in app inventory | Keep heavy checks serialized and close test processes after each pass |
| Use maximum useful parallel agents with good architecture and independent verification | Persisted in `AGENTS.md`; implementation, audits, integration and review assigned in parallel | Reassign available workers as useful scopes become independent |
| LiveSync-style easy default sync, FullCalendar and TaskNotes-style task/calendar features | Calendar/tasks remain deferred; user explicitly opened shared plugin-data/sync discussion, with API design changes on hold | See `deferred-product-roadmap.md`; do not infer approval of sync implementation from discussion |

Editor correctness remains the immediate priority: cursor/selection geometry,
complete live rendering, tables, properties, embeds, clipboard, keybindings,
recovery and performance. This queue does not certify complete editor parity.
