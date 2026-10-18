# Configurable hotkeys: workspace batch

Status: original implementation in `feat/settings-hotkeys`, pending integration and native verification. This is a bounded first batch of the user's configurable-hotkeys request, not completion of editor-wide shortcut configuration.

## Implemented contract

`src/ui/hotkeys.ts` defines 27 stable workspace command IDs, defaults, exact platform modifier matching, reservation/conflict checks, bounded preference decoding and local persistence. Settings → Hotkeys (`src/ui/hotkey-settings.ts`) searches names and effective shortcuts; adds, changes, removes and resets bindings; displays conflicts and inaccessible reserved bindings; announces validation failures. Escape cancels recording without closing Settings or running a command. Tab cancels recording and continues normal focus navigation. IME, AltGraph, repeats and modifier-only input cannot commit a shortcut.

Commands cover new window/note/tab, close tab, save, quick switcher, command palette, Settings, Reading toggle, all-files search, splits, sidebar visibility, daily note, graph, new folder, open vault and nine numbered-tab destinations. New window requires a desktop capability. Missing capabilities consume a matched shortcut without triggering another command.

Preferences use `zorid:hotkeys:v1` in localStorage. Absent overrides mean defaults; an empty array means explicitly unbound. Reset can fail when another command owns the default. Storage failure leaves the active configuration unchanged. Unknown commands/malformed values are ignored; ambiguous imported bindings do not execute. Other windows reload through storage events; current and cached toolbar/ribbon hints update without replacing editors, selection or history. Preferences are local, not vault-synced. Plugin commands are outside this batch.

Workspace dispatch remains after CodeMirror event handling. Known editor, text input, navigation and native application chords are reserved rather than advertised as working workspace bindings. Native and keyboard workspace commands share modal ownership checks, including image dialogs. Platform matching uses Command on macOS and Control elsewhere; an unrelated secondary modifier is not silently accepted.

## Desktop ownership

`desktop/menu-hotkeys.cjs` accepts captions for exactly `new-window` and `close-tab`, bounded and validated in the authenticated IPC handler. No arbitrary accelerators or executable command names cross IPC. File menu items have effective binding captions but no native accelerators: renderer keyboard dispatch owns configurable workspace commands. This prevents native New window from retaining a removed default or firing during shortcut recording. Explicit Close window replaces the implicit role-close binding; Close tab sends a fixed command to the focused authenticated renderer and uses its regular availability/modal/save behavior. Subscription cleanup belongs to Workspace destruction.

The native Window menu is explicit because Electron 44's default non-macOS Window menu includes Close and its implicit Control+W. Native editing, view and system roles retain their normal behavior and are reserved. Source: [Electron 44 menu roles](https://github.com/electron/electron/blob/v44.0.0/lib/browser/api/menu-item-roles.ts). The staging allowlist includes the new desktop module.

## Remaining editor scope and next integration boundary

| Existing surface | Source | Configurability still needed |
| --- | --- | --- |
| History, search, selection, indentation, line transformations | `src/ui/editor.ts` installs CodeMirror `defaultKeymap`, `historyKeymap`, `searchKeymap` | Undo/redo and selection history; find/find next/find previous/replace/select matches; select parent syntax/line/all; indentation; delete, move, copy and split/join lines; comment and bracket commands. Inventory must use installed keymaps rather than assume generic editor shortcuts. |
| Markdown formatting and links | `src/editor/format-menu.ts` | Expose existing Add link/external link, bold, italic, strikethrough, highlight/color, code, math, comment and clear-formatting commands through stable editor IDs. Several paragraph/insert menu entries are disabled placeholders, not implemented actions to advertise. |
| Folding | `src/editor/folding.ts`, editor handle `fold()` | Fold/unfold current and all. The exported folding keyboard extension is not installed by current `createEditor`; do not claim its documented chords already execute. |
| Lists | `src/editor/list-commands.ts` | Tab/Shift-Tab indentation and Enter/Shift-Enter continuation use high-priority local behavior. Preserve list fallthrough and multiline selection semantics when making commands configurable. |
| Tables | `src/editor/live-tables.ts` | Nested editor undo/redo routes to the owner; navigation, selection extension, delete, insert/delete/move/select rows/columns, alignment and rectangular selection actions need explicit target resolution. Preserve top-level history and table ownership. |
| Wiki suggestions | `src/editor/wiki-completion.ts` | Highest-priority navigation/acceptance/dismissal (including Control-N/P, Enter/Shift-Enter/Tab/#/^). Treat these as popup-local controls, not global commands. |
| PDF, file tree and dialogs | PDF view, workspace tree and modal modules | Focused search/navigation, F2 rename, menu and dialog controls remain local. Native/system editing roles remain reserved. |

Recommended next boundary: editor command descriptors with stable IDs and availability checks, plus a CodeMirror compartment for effective bindings on both top-level and nested editors. Reconfiguration must preserve editor instances, history, selection, pending changes and local highest-priority interaction ownership. Extend this preference schema deliberately before adding IDs: the current decoder only accepts workspace IDs. Do not solve editor rebinding by intercepting all keys at document capture or synthesize keypresses for native commands.

## Verification and limits

Focused tests cover preference persistence/reset/conflicts, exact modifiers, reserved editor keys, corrupt/ambiguous storage, quota failures, capture keyboard accessibility, native caption validation and preload lifecycle. Real Workspace/CodeMirror tests exercise a rebind through the editor, unbinding, multiwindow storage refresh, cached hints, unchanged editor selection/history, Escape capture, native modal guards, image dialog ownership and legacy fallback conflicts. Packaging fixtures verify inclusion of the new native module. Relevant existing desktop/context-menu/workspace/window suites pass; TypeScript and whitespace checks pass.

These checks do not establish native Electron accelerator/caption behavior, OS-owned shortcut interception, non-US keyboard layout parity, visual Settings parity, mobile keyboard behavior or packaged launch. Root owns native Electron 44 verification. No full build, full suite, browser automation or native app launch was run by this worker.
