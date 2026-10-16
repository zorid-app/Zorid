# Numbered tab shortcuts: reference and integration contract

This bounded static audit reuses REA E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` (partial graph) and the recovered Obsidian 1.14.4 `app.js` at `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. Offsets are zero-based Unicode character offsets in UTF-8-decoded source. No reference execution or proprietary implementation copying occurred.

## Inspected behavior

| Rule | Static evidence |
| --- | --- |
| Mod+1 through Mod+8 select indices0 through7 of the active leaf's parent tab group. They are not global workspace tab numbers. | app.js2900579–2900925 |
| Mod+9 selects the last child, including when there are more than nine tabs. | app.js2900925–2901292 |
| Pinned tabs are included in these child arrays. There is no pin filter. | Same command callbacks. |
| A missing active tab group or out-of-range numbered position makes the callback return false without selecting anything; it does not wrap/clamp. | Same callbacks. |
| The generic registry does not propagate the check callback's false result; matched commands still consume the keyboard event unless execution throws. Consequently out-of-range shortcuts are consumed no-ops. | app.js3104670,3106231–3106510;1325918–1326380 |
| The selection uses setActiveLeaf with focus:true. Selecting an already active leaf still focuses it. | app.js2928500–2930030 |
| Commands1..8 explicitly reject phones. The last-tab command does not contain this exclusion. | app.js2900579–2901292 |
| Mod is Meta on macOS, Ctrl otherwise. Modifier matching is exact, including Alt/Shift and the other primary modifier. | app.js1215260–1218640 |
| Numbered commands are not repeatable, and repeating keydowns are skipped by the hotkey manager. | app.js1325918–1326380 and command declarations |
| Either logical event.key or mapped legacy which/keyCode may match. Legacy49..57 map to digits; numpad virtual codes map to Numpad names, though a logical digit still matches. Physical KeyboardEvent.code alone is not the digit rule. | app.js1213450–1214520,1217900–1218640 |

There is no input/contenteditable focus exclusion in the numbered command or the inspected global capture-phase dispatcher. The active view scope delegates to application scope; a modal/menu/view scope can intercept first. This is not a claim that every arbitrary text field or plugin permits the shortcut. [app.js1214520–1215900,1323966,2883051–2883980]

## Original helper

`resolveNumberedTabShortcut(event, { platform, tabCount, isPhone?, blocked? })` in `src/ui/workspace-keymap.ts` returns either `{ handled: false }`, `{ handled: true, index }`, or `{ handled: true }` for a consumed command without a destination. The index is zero-based. It does not consume an event, change focus or perform asynchronous work.

The host should resolve its active pane at the event, pass that pane's complete tab count, then preventDefault and stopPropagation for a handled result. For a destination, capture the exact pane/tab identities, flush the previous editor, validate that those identities still belong to the workspace after awaiting, select/render the captured target, focus it, and save session. A missing index must not trigger a clamp, fallback tab or file open. Same-tab shortcuts still request focus. The helper must run before existing broad Meta-or-Ctrl shortcut handling, and only when the workspace is initialized.

`blocked` lets the host honor modal/menu ownership before matching. The helper also rejects already-prevented events and composition events as explicit Zorid integration safeguards. The inspected reference key manager does not itself show an isComposing guard; this safeguard is not claimed as an identical source behavior. Repeat rejection and exact modifiers are source-backed. Invalid counts become unavailable groups rather than unsafe indices. No input-type guard is added.

The source dispatcher matches hotkeys in registration order, commands1..8 then9. The original helper preserves that first-match rule if logical and legacy digit values disagree. Such synthetic/conflicting key events are tested as deterministic matcher behavior, not established physical keyboard behavior.

## Verification and remaining work

Eight focused Node/jsdom tests cover positions1..8, last tab across different group sizes, out-of-range no-op consumption, platform/extra modifiers, scope/composition/repeat handling, non-US legacy matching, phone asymmetry, focus in inputs/contenteditable without matcher side effects, and selection within one group including pinned tabs. These tests do not exercise real macOS reserved shortcuts, international hardware layouts, native menu ownership, Electron focus, or the workspace's asynchronous flush/render path. The integration owner must wire and test those paths; isolated matcher success does not establish completed UI behavior.

## Explicit user shortcut additions

The user additionally requested Cmd+T for a new tab, Cmd+N for a new file, and **Cmd+Shift+N for a new Zorid window**. The last binding is an explicit product requirement; it is not being presented as a default found in the audited reference inventory. Zorid maps these to Ctrl on non-Mac platforms, consistent with its Mod convention.

`resolveWorkspaceShortcut(event, context)` wraps numbered-tab matching and returns `{ handled: false }` or `{ handled: true, action? }`. Action types are `select-tab` (with index), `new-tab`, `new-file`, and `new-window`. A matched out-of-range tab command has no action. `canOpenWindow` is false unless explicitly supplied; without it the window chord is still consumed with no action, so it cannot accidentally reach a broad plain-N handler and create a file. This capability must be supplied only by a host with a validated actual new-window operation. A browser tab or an external browser window is not a substitute.

Shift+T remains unhandled by this helper (the reference has a separate reopen-tab command). Additional Alt/Ctrl/Meta modifiers are rejected, and repeat, composition, prevented, and blocked events remain unhandled. The original matcher does not create an Electron window or add an IPC channel. At this worktree baseline, DesktopBridge has no new-window method and the main process manages one global window; therefore **new-window behavior is pending native implementation and integration**. Three additional tests verify these new action mappings, unsupported-window no-op consumption, exact modifiers, and retained numbered-tab dispatch (11 tests total).
