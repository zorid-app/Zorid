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

Local `desktop:dist` builds only target the current host platform. Release artifacts for all desktop platforms are produced by GitHub Actions.

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

## Release Builds

`.github/workflows/desktop-release.yml` builds desktop artifacts on native GitHub-hosted runners. It runs `pnpm quality:fast` first, then packages the desktop app for each platform.

Tagged builds matching `v*` create a draft GitHub Release and attach desktop artifacts. Manual workflow runs are also supported for packaging validation, but they do not create a GitHub Release unless run from a tag ref.

The release tag must match the root and desktop package versions. For patch-zero releases, both `vX.Y` and `vX.Y.0` are accepted, so package version `0.1.0` may be released with tag `v0.1`.

## Release Artifacts

- macOS: universal `dmg` and `zip`, Developer ID signed and notarized.
- Windows: unsigned `msi` and `zip` for x64.
- Linux: `AppImage`, `deb`, and `tar.gz` for x64.

Windows artifacts are intentionally unsigned until a Windows code-signing certificate is available.

## macOS CI Secrets

The macOS release job requires these repository secrets:

- `MACOS_DEVELOPER_ID_CERTIFICATE_BASE64`
- `MACOS_DEVELOPER_ID_CERTIFICATE_PASSWORD`
- `MACOS_KEYCHAIN_PASSWORD`
- `APPLE_TEAM_ID`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY_BASE64`
