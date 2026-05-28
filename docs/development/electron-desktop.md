# Electron Desktop Workflow

Zorid uses **electron-vite** for the local Electron/Vue development loop and **electron-builder** for local packaged builds.

## Commands

From the repository root:

```sh
pnpm desktop:dev        # Electron + Vite dev server with renderer HMR
pnpm desktop:dev:watch  # dev mode with main/preload watch reloads
pnpm desktop:build      # typecheck and build main/preload/renderer into apps/desktop/out
pnpm desktop:start      # build, then launch the production-preview desktop app
pnpm desktop:pack       # build an unpacked local app into apps/desktop/release
pnpm desktop:dist       # build current-platform distributables
```

## WSL2 / headless Linux

`pnpm desktop:dev` prepares the Electron binary before launching. On WSL2, if a tmux shell lost `DISPLAY`/`WAYLAND_DISPLAY`, the launcher restores WSLg variables so the Electron window can appear on Windows. It does **not** use invisible `xvfb-run` by default. For headless smoke testing only, run:

```sh
ZORID_DESKTOP_HEADLESS=1 pnpm desktop:dev
```

## Architecture

- Electron main process: `apps/desktop/src/main/index.ts`
- Secure preload bridge: `apps/desktop/src/preload/index.ts`
- Vue/Vite renderer: `apps/desktop/src/renderer/`
- Build config: `apps/desktop/electron.vite.config.ts`
- Packaging config: `apps/desktop/electron-builder.yml`

The renderer must not receive raw Node, Electron, or `ipcRenderer` access. Desktop APIs are exposed through the typed `window.zoridDesktop` preload bridge only.

## Current scope

This setup intentionally covers local development, preview, and unsigned local package builds only. Signing, notarization, auto-update, and release publishing remain deferred.
