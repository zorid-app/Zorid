# Future Feature Plan: Plugin Power and Shell UI Extensibility

Status: future-facing design track; not required for v0 implementation  
Date: 2026-05-27

## Purpose

Zorid should eventually allow plugins to reach Neovim-level UI power without exposing raw private shell internals. The current v0 architecture stays locked around a broad typed `ZoridPluginContext` facade and no public generic service locator. This future track defines the public UI/shell extension points needed for deeper plugin power later.

## Current locked v0 decision

- Public plugins receive an ergonomic, broad, typed `ZoridPluginContext` facade.
- Public plugins do **not** receive a generic `getService()` or raw internal service locator.
- Raw SQLite, index scheduler/engine, Electron IPC, Node/fs handles, and shell-private Vue internals remain private.
- `FieldsAPI` and `DataViewsAPI` are public-prealpha experimental APIs so the API shape can mature before alpha.
- First-wave v0 core plugins remain desktop-only unless specifically mobile-tested.
- Deep UI replacement is future work, not a blocker for v0 desktop/editor/index/fields/data-view implementation.

## Why not expose everything now?

Broad app/global access is excellent for plugin author velocity, but it tends to couple plugins to internals and makes future platform boundaries harder. Zorid should instead expose official extension points for the same kinds of power: if a plugin should be able to replace or augment a surface, that surface should become a public API.

## Future public Shell/UI API goals

A future `UIAPI` / shell extension layer should allow plugins to augment or replace major UI surfaces through stable contracts:

```ts
export interface UIAPI {
  registerStatusBarItem(item: StatusItemContribution): Disposable;
  registerNoticeRenderer(renderer: NoticeRendererContribution): Disposable;
  registerCommandPaletteProvider(provider: CommandPaletteProvider): Disposable;
  registerCommandPaletteRenderer(renderer: CommandPaletteRenderer): Disposable;
  registerMenuProvider(provider: MenuProvider): Disposable;
  registerPopupRenderer(renderer: PopupRendererContribution): Disposable;
  registerTheme(theme: ThemeContribution): Disposable;
  registerShellRegion(region: ShellRegionContribution): Disposable;
  registerActivityItem(item: ActivityItemContribution): Disposable;
  registerSidebarView(view: SidebarViewContribution): Disposable;
  registerModal(modal: ModalContribution): Disposable;
}
```

## Capability classes

Future plugin capability IDs may include:

```text
ui.status.write
ui.notice.render
ui.commandPalette.provide
ui.commandPalette.render
ui.menu.provide
ui.popup.render
ui.theme.register
ui.shell.region
ui.activity.register
ui.sidebar.view
ui.modal.open
```

## Plugin power matrix

| Capability | v0 current architecture | Future Plugin Power track |
|---|---:|---:|
| Create split panes/views | Yes | Yes |
| Add custom views/panels | Yes | Yes |
| Add status bar items | Yes | Yes, richer ordering/placement |
| Add commands / command palette entries | Yes | Yes |
| Editor extensions/themes | Partial | Richer editor/theme contracts |
| Markdown processors / embeds | Yes | Yes |
| Custom `.zbase` renderers | Yes | Yes |
| Replace notice/message UI | No | Yes |
| Replace command palette renderer | No | Yes |
| Replace popup/menu renderer | No | Yes |
| Deep shell layout replacement | No | Possibly, through `ShellRegionContribution` or later shell profiles |
| Full editor renderer replacement | No | Later, only if CodeMirror abstraction is insufficient |

## Acceptance criteria for this future track

- Plugin authors can replace or augment command palette, popup/menu, notice/message, theme, and shell regions without importing shell-private Vue code.
- All UI replacements are lifecycle-owned disposables.
- Extension points are capability-gated and visible in API metadata.
- Plugin manager/devtools show which plugins own or override UI surfaces.
- Default shell UI remains stable if a plugin fails or unloads.
- Mobile support is explicit per extension point and may lag desktop.

## Non-goals for v0

- No arbitrary third-party plugin marketplace.
- No full shell layout replacement.
- No public raw Vue component tree access.
- No raw Electron/Node/fs/SQLite access.
- No requirement that first-wave core plugins support mobile UI parity.
