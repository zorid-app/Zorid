# Platform setup

For responsibilities and data flow, start at the [architecture overview](architecture/README.md).
This page is a command guide, not a runtime acceptance report.

| Target | Presentation | Core |
| --- | --- | --- |
| Desktop | Electron + shared TypeScript/CodeMirror | Native Rust host process |
| Browser | Shared TypeScript/CodeMirror | Rust/WASM Worker with current IndexedDB persistence |
| iOS | Native shell + Capacitor/WKWebView shared editor | Embedded native Rust via C ABI |
| Android | Existing Capacitor project/shared renderer | Older Filesystem adapter; native Rust path pending |

Use Node.js 26+ and the repository's pinned pnpm/dependencies. Run commands from
repository root; do not install or download unrelated toolchains as a side effect.

```sh
pnpm install --frozen-lockfile
pnpm run dev                 # browser development server
pnpm run desktop:dev         # Electron using the running Vite server
pnpm run build               # TypeScript check + browser bundle/WASM assets
pnpm run build:desktop       # TypeScript check + native renderer bundle
pnpm run desktop             # Electron using packaged renderer assets
```

Desktop requires its matching Rust host artifact; browser builds require the
configured Rust/WASM toolchain. See [WASM build guide](browser-wasm-build.md),
[package scripts](../package.json), [Vite config](../vite.config.mjs) and
[build architecture](architecture/build.md). Existing package scripts are the
source of truth for exact invocation.

Native projects already exist. `pnpm run mobile:sync` builds/synchronizes assets;
`pnpm run mobile:ios` opens Xcode and `pnpm run mobile:android` opens the Android
project. iOS Rust/build helpers live in [mobile/scripts](../mobile/scripts/).
Asset synchronization is not compilation, signing or runtime verification.
Desktop-first delivery is current priority; these commands do not resume iOS work.

The superseded early platform guide is retained as
[initial scaffolding history](history/platforms-initial-scaffolding.md). Its
localStorage-only browser and Filesystem-only iOS descriptions are historical.
