# Workspace and keyboard reconstruction evidence: Obsidian 1.14.4

This is a focused static contract for an original workspace and keyboard implementation. It does not establish runtime, operating-system, accessibility, mobile, or pixel parity. Zorid's requested public modes are **Reading** and **Live Edit** (the reference calls the latter Live Preview); raw-source controls are outside that requested product surface.

## Evidence and boundaries

The pass read the REA skill and JavaScript guide, reused the recovered artifact identities and existing REA coverage in [source-audit.md](source-audit.md) and [editor-reference.md](editor-reference.md), and performed bounded ordinary source reading. No reference process or recovered JavaScript was executed. No producer analysis was rerun. No reference implementation or asset is included here.

All anchors below are zero-based **Unicode character offsets in Python's UTF-8-decoded text**, not byte offsets or line numbers. Root: `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`.

| Artifact | SHA-256 | Reused evidence / scope |
| --- | --- | --- |
| `app.js` | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` | E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`; partial expanded semantic graph. Findings here are source readings, not newly established graph relationships. |
| `app.css` | `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba` | Bounded stacked-tab and sizing declaration inspection only. |
| `main.js` | `5d90e3738f7db8fb8ea00d01556d71310fd557c4a3c785601274c2bb875a2cba` | E2 `ev_ac5b6f0769f47603747fcf2abec7a2980bedf7d986b23bd9323df29b9cde7501`; bounded native-menu reading. |

The default-command inventory below exhausts the **34 literal `hotkeys:[` declaration sites found in this renderer**, expanding the numbered-tab loop to eight IDs: 41 command IDs. A separate search for `hotkeys:` found only those arrays and the configuration object's empty hotkeys object. This is a bounded syntactic inventory, not proof that every dynamically registered command, plugin, native menu accelerator, editor binding, or device shortcut has been found. Shortcut functions and command context were read at the cited sites. Community plugins, user overrides and other distributions are excluded.

## Registry and dispatch contract

| Layer / anchor (`app.js`) | Observed behavior | Implementation consequence |
| --- | --- | --- |
| Registry, 3104965–3106510 | Commands keyed by ID; separate editor-command collection; add/remove emits `changed`; declared defaults added/removed with the command. Mobile-only commands are skipped off mobile. | Use stable command IDs shared by palette, menus, settings, toolbar and keyboard routes. Plugin unload must unregister defaults and commands. |
| Editor guards, 3104965–3105750 | Editor callbacks become context checks. Require active editor; Reading rejected unless `allowPreview`; Markdown title and inline-title focus rejected; properties focus rejected unless `allowProperties`. | The last opened note alone is insufficient editing context. Inputs in dialogs, title, properties and nested editors need deliberate routing. |
| Palette enumeration, 3105960 | `listCommands` invokes check callbacks with checking=true and filters falsey results; exceptions exclude that command and are logged. | Availability checking must not mutate state. |
| Execution, 3104670, 3106231 | Execution invokes check callback with checking=false, otherwise ordinary callback, and catches synchronous exceptions. Its success return does **not** propagate a check callback's boolean. | Do not assume this registry's execution result means that the action changed anything or was available. |
| Hotkey manager, 1323872–1326380 | Reads/writes `hotkeys.json`; changes invalidate a baked lookup. Custom entries precede defaults. Any custom property replaces that ID's default array, including an empty array. | “Unassigned” must persist as `[]`; deleting the override restores defaults. Preserve deterministic collision order. |
| Trigger, 1325918–1326380 | First matching registered command whose execution does not throw consumes the key; repeated events skipped unless `repeatable`. It does not preflight `checkCallback(true)`. | A disabled check callback can still consume a matching key. Do not infer fallback-to-next-command from palette availability. |
| Scope, 1214520–1215220 | Keys tried in registration order; parent consulted after no handler settles the event. A handler returning a defined value settles it. A specifically keyed/modifier binding also settles even if callback returns undefined; wildcard binding returning undefined can continue. | Context precedence is an ordered scope chain, not a single global map. Keep callback-result semantics explicit. |
| Window key manager, 1215260–1217900 | Capture-phase `keydown`; per-window scope and previous-scope stack; pushed scopes restore previous scope on pop. Only result=false calls preventDefault and stopPropagation. Pure modifier keys skipped. | Distinguish “handled and suppress browser” from “stop scope search but allow browser.” Popouts require their own scope stack. |
| Matching, 1217900–1218610 | `Mod` resolves to Meta on macOS, Ctrl otherwise. Modifiers sorted and matched exactly; key matches legacy virtual key or case-insensitive event key. Null modifiers/key act as wildcards. | Do not accept extra Shift/Alt accidentally; normalize letter case. Keyboard-layout and IME effects still need runtime fixtures. |
| Workspace scope, 2883051–2883970 | Delegates dynamically to active leaf view's scope, otherwise application scope. Workspace scope is pushed. Markdown view scope inherits application scope (3086251). | Active-leaf transition must update command context immediately. Modal/menu scopes must take precedence and restore the prior context. |

The registry assigns `app.lastEvent` from its execution argument, but the inspected hotkey manager calls execution without supplying the event. A keyboard handler must not rely on `lastEvent` carrying a modifier-bearing event in this route.

The unmodified Escape fallback at 2883160–2883950 runs only if not already prevented. It can focus the editing surface, or return from a non-navigating pane to the most recently active navigating leaf. This is distinct from modal dismissal, suggestion dismissal and editor selection simplification.

## Core command defaults in the inspected declarations

`Mod` = Command on macOS and Ctrl elsewhere. Explicit `Ctrl` always means Control. All rows remain conditional on their command's context and feature/plugin availability. “Mac / other” means the actual conditional branch in this build, not a runtime measurement on every OS.

| Command ID | Declared default | Anchor |
| --- | --- | ---: |
| `editor:open-search` | Mod+F | 1953021 |
| `editor:open-search-replace` | Mac Mod+Alt+F; other Mod+H | 1953277 |
| `editor:insert-link` | Mod+K | 1955748 |
| `editor:toggle-bold` | Mod+B | 1957178 |
| `editor:toggle-italics` | Mod+I | 1957373 |
| `editor:toggle-comments` | Mod+/ | 1958803 |
| `editor:toggle-checklist-status` | Mod+L | 1959670 |
| `editor:delete-paragraph` | Mod+D, repeatable | 1965444 |
| `global-search:open` | Mod+Shift+F | 2703675 |
| `graph:open` | Mod+G | 2722403 |
| `editor:save-file` | Mod+S | 2893336 |
| `editor:follow-link` | Alt+Enter | 2894037 |
| `editor:open-link-in-new-leaf` | Mod+Enter | 2894549 |
| `editor:open-link-in-new-window` | Mod+Alt+Shift+Enter | 2895092 |
| `editor:open-link-in-new-split` | Mod+Alt+Enter | 2895805 |
| `workspace:edit-file-title` | F2 | 2897242 |
| `workspace:undo-close-pane` | Mod+Shift+T | 2898768 |
| `workspace:next-tab` | Ctrl+Tab; Mac Meta+Shift+]; other Ctrl+PageDown | 2900197 |
| `workspace:goto-tab-1` through `workspace:goto-tab-8` | Mod+1 through Mod+8, respectively | 2900579 |
| `workspace:goto-last-tab` | Mod+9 | 2900925 |
| `workspace:previous-tab` | Ctrl+Shift+Tab; Mac Meta+Shift+[; other Ctrl+PageUp | 2901292 |
| `workspace:new-tab` | Mod+T | 2901674 |
| `workspace:close` | Mod+W | 2902151 |
| `workspace:close-window` | Mod+Shift+W | 2902338 |
| `command-palette:open` | Mod+P | 3432954 |
| `switcher:open` | Mod+O | 3631603 |
| `app:go-back` | Mod+Alt+Left | 3912187 |
| `app:go-forward` | Mod+Alt+Right | 3912437 |
| `app:open-settings` | Mod+, | 3913844 |
| `markdown:toggle-preview` | Mod+E | 3914192 |
| `markdown:add-metadata-property` | Mod+; | 3914728 |
| `app:open-help` | F1 | 3917278 |
| `file-explorer:new-file` | Mod+N | 3919296 |
| `file-explorer:new-file-in-new-pane` | Mod+Shift+N | 3919758 |

Search can target a searchable active view, including Reading; replace requires the edit adapter. Checklist toggling rejects table-cell context. Save requires a saveable file view. Follow/open-link commands first inspect an editor clickable token, then can send a bubbling `open-link` event to a focused element. Popout and split commands are capability-gated. Numbered tabs 1–8 are explicitly unavailable on phones; they require an existing tab at that index. Next/previous wrap within the active group. These distinctions are in 1952490–1953370, 1959410–1959750 and 2893080–2902360.

The inspected registrations also expose **unbound** commands, including pin toggle, split right/down, stacked tabs, move/open in new window, new window, close others/group, adjacent-pane focus, title/path/URL copying, readable-line-length and line-number toggles, left/right sidebar toggles, default mode toggle, and most formatting/insertion commands. Do not invent defaults for them. The raw-source toggle is likewise unbound and should be omitted from Zorid's two-mode UI by product requirement. This sentence names inspected examples, not all unbound commands.

## Editor and native bindings are additional layers

The preceding inventory is not the entire keyboard experience. CodeMirror bindings are assembled separately, in order, from local extensions, the dynamic compartment and shared extensions (2581330–2581500). Shared keymap assembly at 2557000–2558513 places application-specific Home/End and macOS movement overrides before the filtered bundled keymap and history keys. Higher-precedence extensions exist; for example Markdown's ArrowUp-to-properties handling uses high precedence (2604755), and Vim uses highest precedence when enabled (2585650). Effective collisions require testing the actual extension order and capture-phase scope route.

| Inspected binding family | Contract / anchors |
| --- | --- |
| Undo/redo | Mod+Z undo; Mod+Y redo except macOS uses Mod+Shift+Z; Linux additionally Ctrl+Shift+Z. Shared assembly explicitly adds Mod+Shift+Z as well. The history keymap also declares Mod+U and Alt+U (macOS Mod+Shift+U) for selection-history operations. Anchors 1890500–1890600, 1895240–1895600, 2558000. |
| Suggestion-aware editor keys | Local Up, Down, Enter and Tab handlers intercept when suggestion UI reports showing. Escape removes search highlights and returns false while specifying preventDefault. Anchor 2582208–2582830. Suggestion popup's own selection and dismissal scope was not fully inspected. |
| Markdown Enter/Tab | With smart-list indentation enabled, Enter continues Markdown lists or takes the special context's plain-indent path; Shift+Enter inserts newline with indentation only. Tab/Shift+Tab invoke list indent/unindent and return handled. Anchor 2604755–2605810. |
| Shared movement overrides | Home/End and macOS Cmd+Left/Right route to application-specific functions, with Shift extending selection. Mac Alt+Up/Down operate at rendered line-block boundaries, with Shift extending. Anchor 2557380–2558050. |
| Retained bundled keys | The shared map retains arrows, word/line/document/page movement and selection, Enter, select-all, character/word/line deletion, indent/unindent, bracket matching, subword movement and additional selection actions from `qz`/`zz`. The exact declarations were read at 1913675–1915650. Their complete function semantics and appended macOS Emacs-style `Hz` map remain unaudited. |
| Explicit exclusions | Filter at 2551341 removes entries whose generic key is Alt+Up, Shift+Alt+Up, Alt+Down, Shift+Alt+Down, Alt+L, Alt+V or Ctrl+M before composing the shared map. Filtering the generic key also removes that entry's platform alternative. Do not install an untouched stock default map and assume parity. |
| Nested editing | Tables use their own cell keys and parent history; image widgets have navigation/edit/resize keys. See [editor-reference.md](editor-reference.md) and [attachment-reference.md](attachment-reference.md). Their shortcuts must win only in their owning object context. |

The native desktop menu supplies another route (`main.js` 178300–181500): explicit Mod+Shift+Z redo, Mod+Shift+V paste-and-match-style, hidden Mod+Alt+Shift+V alternate paste-and-match-style, Mod+0 actual size, Mod+= zoom in, Mod+- zoom out, macOS Command+M minimize, Command+H hide and Command+Q quit, and developer-tools accelerators (Mac Alt+Command+I; other Ctrl+Shift+I). The menu also uses Electron roles for undo, cut/copy/paste, select-all, fullscreen and window actions; their implicit accelerators are **not enumerated or verified here**. The context-menu declarations at 163719–164140 explicitly show Mod+X/C/V and Mod+Shift+V. Native redo distinguishes a keyboard-originated event and dispatches a synthetic renderer keydown versus direct webContents redo. This is evidence that renderer command defaults alone cannot model desktop menus.

## Workspace state and navigation

The inspected hierarchy has split containers, tab groups and leaves, with independent main, left, right and floating roots. A split has a direction and child dimension percentages; a group has an ordered leaf list, current index and stacked flag; a leaf owns view state, ephemeral state, pin/group identity and navigation history. Sources: 1539550–1544500, 1554700–1561000, 1569040–1581450.

### Opening and focus

At 2927226, `getLeaf` routes `split` to split-active, `tab` or boolean true to a new tab route, `window` to popout, and other values to an unpinned navigable leaf. `getUnpinnedLeaf` (2926660) first accepts the active navigable unpinned leaf, then finds the most recently active eligible selected/stacked leaf in its container, otherwise creates a leaf. A pinned active note must not be silently replaced by ordinary navigation.

`createLeafInTabGroup` (2927400) selects the most recently active child as insertion reference, reuses it when it is the empty view, otherwise inserts after it. `focusNewTab` controls immediate activation. In contrast, explicit New Tab (2901400) appends a fresh empty leaf to the most-recent leaf's group and focuses it. The tab-strip plus button also appends. These routes should not be collapsed into one unconditional “append and activate” policy.

`setActiveLeaf` (2928500–2930030) rejects unattached leaves, updates active time, leaf/group classes, tab index, title and active-editor cache, optionally focuses, and schedules active-leaf/file-open notifications. The focus path can close settings in the same window and collapse mobile drawers. Focusin and capture-phase pointerdown inside a leaf activate it (1569340). Commands should resolve current context at invocation time.

`openFile` (1571350) selects a view type by extension, retaining an existing file view when it accepts that extension. It carries file path, active/group options and separate ephemeral state. Unsupported types take a notice/external-app route. `setViewState` (1573959–1575440) has a working guard, closes/replaces views only when necessary, applies state, active/group/ephemeral options, updates layout/header, and records prior history only when the view-state transition requests it. Deferred views are realized when needed; inactive restoration can retain lightweight type/icon/title state.

### Reading, Live Edit and “preview” ambiguity

Markdown has two serialized dimensions: `mode` selects `preview` (Reading) or `source` (editing adapter); boolean `source` selects raw Markdown versus Live Preview inside the editing adapter (3089537, 3092055; detailed in [editor-reference.md](editor-reference.md)). Zorid can map Live Edit to editing with raw source false, and Mod+E to Reading/Live Edit. Leaving editing saves and transfers fold/scroll information. Persist mode per view rather than treating every tab as one global mode.

The inspected open/leaf/tab state contains no established separate transient “preview tab” contract. Exact-string searches for `previewTab` and `isPreview` returned no matches in this renderer; this is only a bounded negative search, not proof that no analogous feature exists. Reading's `preview` mode, hover-link popovers, deferred view loading and an empty navigable tab are separate concepts. Do not infer VS Code-style single-click temporary-tab replacement or double-click promotion from the word “preview.” Tab-header hover can emit a hover-link event with the file path (1570100), but hover plugin behavior was outside this pass.

### Close, pins and reopening

At 2901870–2903250, desktop Close Tab first **unpins a pinned leaf**; a later invocation detaches it. Phone close bypasses that unpin step. Non-file sidebar context can redirect Close Tab to the most-recent main leaf. Close Others preserves the active and pinned leaves in the current container. Close Group and Close Others in Group also skip pinned leaves. Sidebar/capability guards differ by command.

Pinning changes navigation eligibility, saves layout, updates the header and synchronizes linked group members (1576530–1577290). The header hides its close button and exposes an unpin status icon. This is not an absolute prohibition on closing: the observed middle-click handler directly detaches a tab (1569650–1570350), and explicit low-level detach has no pin guard. Treat command, button and middle-click paths separately.

Removing the current tab chooses the same numeric position if a next tab survives, otherwise the last preceding tab; removing another tab preserves the current leaf by identity (1564000–1564550). Close-button interactions can lock tab widths until pointer exit, reducing target movement; last-tab close unlocks immediately (1564400–1566000, 1569450). Those are observable UX contracts beyond the model array mutation.

`detach` captures closed nonempty view/ephemeral state plus root ID, parent ID, leaf ID and serialized back/forward history. The undo-close stack is newest-first and capped at ten (1577290–1577660, 2944131). Reopen (2897960–2898780) restores root/group where possible, otherwise selects a suitable empty/new/split/popout destination; restores IDs, history, view and ephemeral state and activates it. Empty tabs do not enter undo-close history. An original implementation should define behavior when the recorded group/root no longer exists rather than assuming it always survives.

### Per-leaf navigation history

History states include title, icon, view state and ephemeral state (1581160). A navigation transition records the prior nonempty navigating view when state differs from the last entry by serialized state (1581310). New entries clear forward history. Back/forward swaps the current state onto the opposite stack, restores the target with `popstate` and emits history-change (1567480–1569040). A working leaf produces a busy notice instead of navigating.

**Do not claim a verified 20-entry history cap.** The inspected push path tests length greater than 20 but then calls `unshift()` with no arguments, which does not remove an entry under standard Array semantics (1568110 vicinity). This source alone does not establish a cap. Undo-close's ten-entry cap is a distinct observed pop operation. The on-disk leaf serializer does not include these navigation stacks; it does include leaf state/pin/group. History is separately transferred for duplication and undo-close. Persistence of navigation history across full app restarts was not demonstrated.

### Splits, stacking and drag/drop

Split-right is a `vertical` split; split-down is `horizontal`. `splitLeaf` (2925220–2925765) inserts alongside a matching-direction ancestor, or wraps the target in a new split if the direction differs. Existing dimensions are redistributed/preserved. Duplicating a leaf copies view, ephemeral and navigation history state (2926200–2926660). Empty/single-child container removal can collapse the tree (1541700–1542600).

Resize captures original sizes, distributes pointer delta across siblings and clamps individual sizes to 200 pixels, then persists percentage dimensions (1543600–1545850). Vertical split delta considers RTL. Double-click reset clears sibling dimensions (1539900). Sidebar resize is separate: collapse below 50 pixels, reopen at 200, otherwise constrain width between 200 and 80% of workspace width (1549300–1550900).

Stacked tabs are a group-level persisted flag (1560170–1560740); sidebar groups are excluded by the toggle command. All group leaves are displayed/realized and headers are interleaved with leaf bodies, rather than rendering only the selected leaf (1561000–1564000). Sticky offsets and min/max widths derive from header widths and available container width, with a 300-pixel lower bound in the calculation (1566000). Offscreen non-current leaves get an `is-hidden` class, and selecting a tab scrolls it into view (1566600–1567480). The inspected CSS defines `--tab-stacked-pane-width: 700px` near 90848 and tab maximum width 320px near 90253; these declarations alone do not determine final layout. Theme, viewport and computed CSS must be verified separately.

Tab dragging (2916902–2924700) has a five-pixel movement threshold; drag preview uses an overlay and temporary target geometry. Drop direction considers normalized distance to the nearest permitted edge within roughly one-third of the target, with special header/sidebar/stacked exclusions. Center-drop onto a tab group reorders or reparents a leaf, correcting the insertion index when moving within the same group. Edge-drop creates a split; some center-drop branches swap leaf positions/dimensions. Moving a leaf clears its old percentage dimension. Sidebar movement can unlink groups. Cleanup restores temporary opacity, removes overlay/ghost/listeners and clears grabbing state. Dragging a supported desktop view out of the window can create a popout with its size/zoom and activate it. Phone tab dragging is explicitly prevented. These are distinct operations, not universally “drop file opens a tab.”

The tab header's file/link/bookmark drop handler (1556500–1560170) distinguishes insertion gaps from the central portion of a header. A single compatible item over a navigable unpinned header can open there; otherwise items create tabs at the insertion index, preserving item order and ultimately focusing the last created tab. It filters files and bookmark types. Existing-leaf dragging and file dropping must have separate payload types and pin rules.

### Popouts and saved layout

Open-in-new-window copies view state to a fresh leaf; move-to-new-window reparents the existing leaf (2899250–2899800, 2927800–2928430). Reparenting preserves the actual leaf and its history. Initial size inferred from a leaf rectangle has a 600-by-600 minimum in the popout constructor; popout state includes bounds, maximized flag and zoom (2876970–2879350). Keyboard base scope is registered for the new window. A popout closing detaches its leaves, switches active context if necessary, unloads its component, restores global active-window/document ownership and removes style relay/window resources (2879500–2880300). Removing its last child closes the window.

Layout serialization (2915778–2916490) includes main, left, right, left-ribbon, optional floating roots, active leaf ID and recent-file list. It writes `workspace.json`, or `workspace-mobile.json` on mobile, only after layout is ready. Tree nodes retain IDs/types/dimensions; split direction; tabs/currentTab/stacked; leaf view state, pin and linked group; sidebar width/collapse; window bounds/zoom/maximize. Restore validates node types/capabilities and realizes views with a bounded restore wait, logging failures (2914300–2915778). Do not treat deserialization of unknown plugin views or failed popouts as an ordinary Markdown note.

## Acceptance fixtures and remaining gaps

Original implementation tests should exercise:

1. The same shortcut in editing, Reading, title, properties, nested cell, modal, suggestion popup, sidebar and popout; collision order, empty override, reset-to-default and repeat handling.
2. Every default-command row above with platform normalization and eligibility, without confusing editor/native shortcuts with configurable commands.
3. Open/reuse/new-tab routes, focus-new-tab setting, pinned navigation, next/previous wrap and numbered tab boundaries.
4. Close versus unpin versus middle-click, pinned bulk-close exclusions, selected-neighbor behavior, empty-tab close and ten-step reopen state restoration.
5. Back/forward with cursor/scroll restoration, new-navigation forward clearing, duplicate-tab history independence and busy-state handling.
6. Reading/Live Edit persistence and Mod+E transition, preserving source text, folds, scroll and focus.
7. Split creation/collapse/resize, drag reordering across groups, sidebar moves, stacked scrolling and cancellation cleanup.
8. Popout move versus copy, last-tab close, scoped keyboard focus, bounds/zoom persistence and unavailable-window fallback.

Still unresolved: full modal/menu/suggestion key inventories; all bundled editor command function semantics and macOS Emacs bindings; native-role implicit accelerators; keyboard layouts, dead keys, IME, OS-reserved keys and screen readers; complete layout migration/unknown-plugin restoration; group synchronization on all edit paths; precise drag geometry across windows/RTL/touch; actual history size/runtime behavior; all supported platform feature gates; and visual/performance parity. These gaps prevent a complete workspace or keyboard parity claim.

## Original split-layout implementation contract

The new `src/ui/split-layout.ts` is an original layout manager around caller-owned leaf elements. It is informed by the above digest-bound static observations at 1541700–1545850 and 2925220–2926660: right means a vertical split, below means horizontal; removing empty/single-child ancestors collapses the tree; dimensions normalize; resize distributes shrinkage across siblings with a 200-pixel minimum. No further reference execution or semantic producer analysis was performed for this implementation.

`SplitLayout` owns an exclusive host container, keyed split wrappers and accessible separator elements. The workspace retains ownership of pane objects, tabs, editor instances, activation and disposal. Import `src/ui/split-layout.css` at the application entry point; the TypeScript module deliberately has no CSS import. Integration must persist stable pane IDs alongside the tree. A session that regenerates all pane IDs cannot recover the prior topology by filename alone.

The public API is `new SplitLayout(host, { onChange?, minPaneSize? })`, `setPanes(Map<paneId, HTMLElement>, savedTree?)`, `split(targetId, newId, newElement, 'right' | 'bottom')`, `move(paneId, targetId, edge)`, `remove(paneId)`, `serialize()`, `restore(unknown)` and `destroy()`. Move edges are left/right/top/bottom. Leaf records contain `type: 'leaf'` and `paneId`; split records contain `type: 'split'`, stable split ID, direction, ordered children and normalized sizes. Serialization returns detached data, not mutable references to the current layout. `remove` returns the original leaf element; it does not destroy its editor. `destroy` cancels interactions, removes layout wrappers and returns surviving leaf elements directly to the host with their previous owned style/class/ID state restored.

Restoration drops unknown and repeated pane IDs, repairs invalid weights, rejects unsupported directions and excessive nesting, collapses empty/singleton groups, repairs repeated split IDs and adds missing registered panes to a fallback vertical group. All registered panes remain represented once. This is Zorid's explicit corruption-recovery policy, not a claim about every reference migration branch. Callers must not register nested or duplicate elements as separate panes.

Topology changes reuse provided leaf nodes and their descendants. Keyed wrappers and a move-before-cleanup pass limit unnecessary detachment. Focus, text-input selection, DOM selection and focused-ancestor scroll offsets are restored after reparenting. Older browser DOM operations can still dispatch blur/focus while moving an element; this code does not promise event-free reparenting or reconstruct CodeMirror state. Integrators must keep editor creation/disposal out of mere layout changes. Resize only updates dimension styles and state; it does not move editor nodes. The manager does not create tab history or active-pane history.

Pointer resize uses owner-document listeners, pointer identity, cancellation on Escape/pointer cancellation/capture loss/window blur, and original-size rollback. Only completion emits a persisted resize change. Keyboard separators support axis arrows (10 pixels, or 50 with Shift), Home/End bounds and Enter to reset proportions; double-click also resets. Vertical pointer and arrow direction accounts for RTL. Minimum sizes account for same-axis nested descendants; if the host cannot fit the absolute minima, they scale together so every pane remains visible. That compact-host policy and the keyboard increments are original design choices. Saved proportions are retained on restore; minimum fitting occurs on a resize gesture, not through a background responsive-layout migration.

Focused Node/jsdom tests cover nested split/move/remove topology, saved ordering/sizes, malformed and cyclic input fallback, unique leaf ownership, leaf/editor-element identity, focus/selection restoration, pointer commit/cancel/identity, keyboard bounds, RTL, nested minima, compact containers and cleanup. A real Live Edit CodeMirror fixture additionally retains the same editor instance, source selection and undo history through nested splits and moves. Geometry is supplied by test fixtures: these are behavioral model/DOM tests, **not real-browser measurements**, reference runtime comparisons or a claim of completed split-view parity. Workspace menu wiring, actual Pane persistence/lifecycle, CodeMirror measurement after reparenting, native drag/drop integration and visual verification remain integration responsibilities.
