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

## Architecture

- Electron main process: `apps/desktop/src/main/index.ts`
- Secure preload bridge: `apps/desktop/src/preload/index.ts`
- Vue/Vite renderer: `apps/desktop/src/renderer/`
- Build config: `apps/desktop/electron.vite.config.ts`
- Packaging config: `apps/desktop/electron-builder.yml`

The renderer must not receive raw Node, Electron, or `ipcRenderer` access. Desktop APIs are exposed through the typed `window.zoridDesktop` preload bridge only.

## Current scope

This setup intentionally covers local development, preview, and unsigned local package builds only. Signing, notarization, auto-update, and release publishing remain deferred.
