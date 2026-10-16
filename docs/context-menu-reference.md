# Context-menu evidence and original desktop bridge

The reference supports **both native and custom menus**. Its global menu preference defaults to native on macOS when unset; the menu implementation uses a custom DOM path when the platform is not desktop or the native preference is false. Thus “all reference menus are custom” and “all reference menus are always native” are both too broad. Zorid's desktop bridge intentionally selects native Electron menus for the surfaces that call it, following the user's requested desktop behavior.

## Evidence boundary

This pass applies the installed REA skill and its JavaScript guide, reuses the retained renderer evidence and recovered files described in [source-audit.md](source-audit.md), and performs focused ordinary source reading. No reference process or recovered function was executed, no broad producer analysis was repeated, and no proprietary implementation or asset was copied into the project.

The renderer is `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, associated with retained E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. E3's expanded semantic graph is partial. Anchors here are zero-based Unicode character offsets in the UTF-8-decoded source, **not byte offsets**. Conclusions below are static source observations, not verified execution paths or runtime menu measurements.

## Menu implementation

| Anchor | Observed contract |
| --- | --- |
| 1221200–1222880 | Menu instances inherit the global native-menu preference. Custom menus own a keyboard scope with arrows, Enter and Escape, suppress selection-changing primary mousedown inside the menu, and register outside-click/context-menu dismissal. |
| 1222900–1224950 | Items have ordered sections; section prefixes can become submenus. Sorting inserts group separators and removes trailing separators. Disabled, label-only and checked states are distinct. |
| 1225477–1225920 | Mouse invocation uses client coordinates and the event's owning document, with a transformed-window adjustment when needed. |
| 1225949–1227050 | Custom desktop menu positioning accounts for viewport bounds and safe-area top; phone menus follow a separate bottom-sheet animation path. This is not the native Electron path. |
| 1227050–1227650 | Native menu construction recursively translates labels, disabled/label-only items, boolean checked state and submenus into Electron menu items. Callbacks remain bound to the source menu item. Popup coordinates are multiplied by the owning webContents zoom factor, expressed here as `1.2` to the zoom-level power, and rounded. The popup explicitly targets the owning window. Optional macOS writing tools use the focused frame. |
| 1227650–1228500 | Native menu closing triggers menu cleanup. Shared hide logic unloads scope/listeners, clears active-parent decoration, removes custom menu DOM and invokes a hide callback. |
| 1230990–1231280 | Event-based creation reuses one menu per event via a weak map and defers showing until handlers have added their contributions. It prevents default. This lets nested surface handlers contribute to a shared menu rather than necessarily opening competing popups. |
| 3925640–3925780 | Preference update reads `nativeMenus`; an unset value becomes true on macOS. A settings toggle at 3855100 changes this preference. |

A native menu does not reproduce arbitrary HTML icons, highlight swatches or custom layout automatically. The inspected conversion deliberately reduces the richer menu item to native fields. Native writing tools, spelling integration, Electron role accelerators and platform accessibility behavior need separate runtime verification.

## Surface dispatch findings

| Surface and anchor | Relevant behavior |
| --- | --- |
| Files, 1512900–1516570 | File explorer distinguishes multiple selection from a single file/folder. It contributes open/copy/delete actions, raises `files-menu` or `file-menu` extension events with a source identifier, associates the menu with the tree item and focuses that tree item before showing. File and folder context are not interchangeable. Deletion uses the file manager's prompt path. |
| Tabs, 1579600–1580530 | Tab header menu orders close/pane/open/action/info/view/system sections, creates path-copy and linked-view submenus, calls view-specific tab actions, conditionally calls pane actions and emits `leaf-menu`. It anchors to the exact clicked tab header. A menu must capture the clicked tab, not silently operate on whichever tab is active later. |
| Editor entry, 2592017–2594900 | Existing preventDefault is respected. The handler maps pointer position through the owning editor and verifies the content DOM target. Desktop trusted events can retrieve native edit flags and spelling suggestions. It limits spelling suggestions and offers dictionary insertion. Clickable-token context contributes internal/external link, tag and footnote actions. |
| Editor clipboard/formatting, 2594900–2601100 | Cut/copy/paste/plain-text paste use native webContents editing when available and otherwise explicit text/clipboard operations. Native edit flags control availability. Select-all works on the editor's document. Formatting, paragraph, heading and insertion sections are built from selection context; paragraph/insertion groups are disabled inside table cells. The shared editor menu event and owner extension hook are invoked before showing. |
| Keyboard editor invocation, 1970200–1970650 | A desktop invocation synthesizes a right mouse press/release at the editor cursor, with zoom-adjusted coordinates; the fallback invokes the editor context menu directly at cursor coordinates. Context-menu-key support is therefore a separate entry path, not a different command set. |
| Rendered links, 1864350–1865000 | Link context handlers obtain the event-associated menu and contribute internal/external-link operations. They share the menu mechanism rather than assuming all links are editable text. |
| Images, 3023500–3025700 | Image controls add Copy image, internal-file/link actions and file swap for internal embeds, Remove image and Reset size. Reset size is disabled when no explicit width exists. Remove edits the owning source range. Image clipboard data and file swapping are specialized operations; a text-copy role alone does not implement them. |
| Table cells, 2049662–2050450 | Right-click dispatch distinguishes selected cell ranges from active nested cell editing. Clicking outside a multi-cell selection can clear that selection and focus the clicked cell; an already active cell can route to its nested editor. The selected-cell route uses the shared event menu. |
| Table menus, 2081005–2085500 | A rectangular selection gets clipboard, formatting, column alignment, clear and delete actions. Otherwise the table adds Row and Column submenus plus sorting. Column insertion/movement/deletion/alignment depends on the clicked column. The nested editor's menu hook delegates into its table owner (2614676–2615020). |

These are bounded surface findings, not complete menu inventories. Reading-mode image menus, standalone image viewers, every file action, all table sorting/row actions, spelling event transport, third-party plugin additions, mobile long-press behavior and OS-native writing tools remain incompletely audited. Surface integrations should preserve their own selection rules and lifecycle checks; a global menu service should not infer document edits from DOM text.

## Original Zorid API

`src/platform/context-menu.ts` exports `showContextMenu(event, items, { document? })`, returning `Promise<string | null>`. Supply a mouse event or `{ clientX, clientY }`. The function prevents the supplied event's default and propagation, then uses the owning document's desktop bridge if available. Callers should therefore supply the **complete menu** for that event rather than relying on the reference's shared-event aggregation behavior.

Supported descriptor shapes:

- Action: `{ id, label, enabled?, checked? }`.
- Separator: `{ type: 'separator' }`.
- Submenu: `{ label, submenu: items, enabled? }`.
- Native edit role: `{ role, label?, enabled? }`, where role is one of `undo`, `redo`, `cut`, `copy`, `paste`, `pasteAndMatchStyle`, `selectAll`.

Action IDs are opaque identifiers returned to the caller. They never name an IPC channel or main-process operation. Renderer closures stay in the renderer; after awaiting, find the selected action and revalidate that its original editor/file/tab/widget target is still valid. Native edit roles return null after closing, as does dismissal. Surface-owned edits should use action IDs instead of edit roles when native clipboard semantics are insufficient, as for a rectangular Markdown table selection.

The optional preload method is `window.zorid.showContextMenu({ x, y, items })`. It invokes only `zorid:showContextMenu`. The main handler uses the existing exact webContents/main-frame/trusted-document sender check. `desktop/context-menu.cjs` rejects unknown fields, unsupported roles, duplicate or malformed IDs, control characters in labels, nonfinite/out-of-bound coordinates, more than 100 total entries, more than four nested submenu levels, and labels longer than 200 characters. It constructs fresh native templates from validated fields and escapes mnemonic ampersands. It never accepts JavaScript, executable callbacks, arbitrary Electron menu options, filesystem paths or arbitrary IPC channel names.

`dismissContextMenu(document?)` returns a promise and dismisses both browser and native menus through a separate fixed, sender-validated cancellation endpoint. Workspace teardown and vault replacement should call it, in addition to invalidating their pending action targets.

Each owning window has at most one outstanding popup session. A new popup cancels the previous one; empty requests also cancel. Dismissal settles null. Window closure, renderer loss/destruction and main-frame navigation cancel the session and remove listeners. Stale callbacks cannot settle the replacement session. Native coordinates scale from CSS client pixels by the owning webContents zoom factor, are rounded and clamped to content bounds. The native path leaves DOM focus and selection untouched. It is still the caller's responsibility to preserve or deliberately change selection **before** opening the menu.

The browser fallback creates accessible menu/menuitem/checkbox roles, supports disabled actions, nested submenu arrows, Home/End, Enter/Space, Escape/Tab dismissal, outside click and replacement cleanup. It snapshots focus and selection and restores them before returning an action; outside clicks retain the user's new focus. It uses text content for labels. Browser Paste is enabled only when the browser explicitly reports that command available, and plain-text paste is disabled because this helper has no privileged browser clipboard access. Custom action IDs can provide an app-specific clipboard route. Native fallback is not attempted after a desktop IPC rejection; that error remains visible to the caller rather than bypassing the validated native path.

## Validation and limits

Focused Node tests use an injected fake Electron menu/window, the real main/preload scripts in constrained VM harnesses, and jsdom for the fallback. They cover descriptor rejection, sender/frame/document validation, returned action IDs, disabled ancestors, zoom/clamping, concurrent sessions, dismissal/selection ordering, lifecycle cleanup, popup failures, keyboard/submenu navigation, selection restoration and browser clipboard availability. TypeScript compilation validates the exported API.

These tests do not launch Electron, operate the reference app, verify OS popup pixels or test clipboard behavior in a native host. Menu infrastructure alone does not wire editor/file/tab/image/table surfaces or establish full right-click parity. Integration must supply those descriptors, keep the Reading/Live Edit product constraint, avoid stale actions after asynchronous menus, and verify the native host with actual pointer/keyboard events.
