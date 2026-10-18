# Native top-chrome drag and double-click

## Decision

Keep the existing Electron `titleBarStyle: 'hiddenInset'` configuration and use native draggable regions for blank top chrome. Do not add a renderer `dblclick` listener or a new window-control IPC method for those regions. The pinned Electron/Chromium implementation routes draggable backgrounds to the native frame specifically for dragging and title-bar double-clicks. A renderer listener is therefore neither required nor a reliable fallback for those native hit-test regions.

At desktop viewport widths of at least 701 CSS pixels, the sidebar-controls change supplies `[data-window-drag-region]` on top-row pane bars and sidebar headers, with explicit `no-drag` exclusions for tabs, buttons, links, form controls and `[data-window-no-drag]`. Its overlay passes pointer events through except on its controls. That CSS/host integration is the implementation change; this audit adds no second event-handling path. Lower pane tab bars are not intended as window drag handles at those widths. At 700 CSS pixels and below, this helper CSS is inactive and the preexisting tab-bar drag rules still apply; lower-bar exclusion at narrow desktop widths is not established by this change.

## Reference application evidence

The retained Obsidian 1.14.4 renderer has SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. Its macOS desktop double-click helper reads `AppleActionOnDoubleClick` at zero-based UTF-8 byte offset **1559271** (Unicode character offset **1554397**). Static inspection establishes: left button only; exclusions for clickable icons, tab-close buttons and sidebar tab headers; minimize for `Minimize`; toggle maximize/unmaximize for `Maximize` or an unset/empty preference; no action for other strings. This is evidence of a renderer helper in that reference application, not evidence that Zorid must reproduce the same event route. No target runtime was executed in this pass, and no proprietary implementation was copied.

## Pinned native source trace

Zorid's installed Electron package is **31.6.0**. The following official sources were downloaded read-only to `/private/tmp/zorid-electron31-*` on 2026-10-16; they are not project dependencies or vendored implementation.

| Source | Relevant location and finding | SHA-256 |
| --- | --- | --- |
| [Electron 31.6.0 DEPS](https://github.com/electron/electron/blob/v31.6.0/DEPS) | Lines 4–5 pin Chromium `126.0.6478.234`. | `97069b51841bf75dde21780d0fcbad979a8e9498c61d5926619ad2cef87f6e60` |
| [Electron native_window_mac.mm](https://github.com/electron/electron/blob/v31.6.0/shell/browser/native_window_mac.mm) | Lines 168–170 treat a non-normal title-bar style as frameless internally. Lines 1656–1671 pass client-region hit testing through the native window and leave fullscreen as client content. | `5f068d25f759e13cdb92b6793a44ba918cd10e0d2aa1e1c42bf517c5bed6f7a5` |
| [Chromium bridged_content_view.mm](https://github.com/chromium/chromium/blob/126.0.6478.234/components/remote_cocoa/app_shim/bridged_content_view.mm) | Lines 286–297 explicitly route draggable backgrounds away from the content view so the native frame can handle window drag or title-bar double-click. | `3b62b8659515f920ae2a10c7972850cb4b148b9ee282c399c81cc1de466f7ea7` |
| [Chromium native_widget_mac_nswindow.mm](https://github.com/chromium/chromium/blob/126.0.6478.234/components/remote_cocoa/app_shim/native_widget_mac_nswindow.mm) | Lines 137–150 route native frame mouse-down through AppKit window dragging and then the frame superclass. Lines 445–460 separately forward right/control-clicks rather than treating them as left-button drag. | `21b8a9b40c6bcb7b212d41d5b748a0c2dbdf90e6ab27c088442bd9984c241793` |

These sources establish the native dispatch route. They do not prove the outcome on the user's installed macOS version, the final CSS hit-test geometry, or every system-preference branch. AppKit owns the behavior after dispatch; Zorid does not read or change the user's global preference. In particular, maximize/zoom is distinct from entering fullscreen.

## Root-owned native acceptance check

After the sidebar helper and workspace integration reach one coherent build:

1. Open only the agent's Zorid test app. Record the current macOS double-click title-bar preference without changing it.
2. Drag blank top chrome over the left sidebar header, middle pane bar, and right sidebar header. The containing native window should move; controls, tabs and editable fields should retain their interactions.
3. Double-click blank regions in each location. With zoom enabled, confirm bounds expand and a second double-click restores them; with minimize/no-action selected, verify the corresponding current system behavior. Record only the preference branches actually exercised. Do not infer other branches from one result.
4. Repeat with both sidebars hidden and a horizontally split workspace, including independent auxiliary windows at viewport widths of at least 701 CSS pixels. Verify top-row whitespace remains draggable, lower pane bars and content do not move the native window, and tab double-click does not accidentally resize it.
5. Check a maximized window, and separately fullscreen if exercised; native fullscreen hit testing is a distinct branch. Preserve unsaved drafts and close the agent-opened test windows after the pass.

No native verification is claimed by this document. If actual double-click dispatch fails after CSS integration, first inspect the computed app-region and hit-test target at the failing location. A safe fallback needs evidence of the missing route before adding a separate bridge or handler.
