# Browser Rust/WASM assets

Ordinary `npm run build` / `pnpm build` and `npm run dev` / `pnpm dev` generate
the browser core automatically before Vite compilation. No fixture flag or
artifact environment variable is needed. The Rust build uses one Cargo job;
unchanged source and intact generated artifacts reuse the local cache. Rust
source changes, including additions and deletions, restart the Vite dev server
and regenerate its matched module/asset pair. Rust-aware `vite build --watch` is
not supported; use `pnpm dev` for watched Rust changes.

Install the toolchain once:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked -j 1
```

Use Rust stable with WASM support. `cargo` and `wasm-bindgen` must be on PATH.
Explicit `CARGO`, `WASM_BINDGEN` and `CARGO_TARGET_DIR` overrides remain available
for development machines. `npm run build:core` regenerates/checks only the core.
The pinned CLI must match `crates/zorid-wasm/Cargo.toml`.

Webpack verifies the current browser storage, durable family command, recovery,
sync codec and returned plan class bindings before emitting assets. It defines
`__ZORID_CORE_MODULE_PATH__` as `lib/core/<pair-sha256>/zorid_wasm.js`. Resolve it
against `document.baseURI` in the app, then pass the absolute URL to the worker.
The generated initializer loads its adjacent `zorid_wasm_bg.wasm`. Both bytes
contribute to the directory hash; a changed pair receives a new URL. The adjacent
manifest records exact individual hashes, required exports and class methods.
Never cache the generated module under a separate unversioned URL.

`npm run build:desktop` selects `vite build --mode native` and omits browser
WASM generation/assets. Electron uses its native Rust host. This does not alter
native host packaging. Mobile/browser builds continue to include the web core.
Explicit fixture builds retain `ZORID_CORE_FIXTURES=1`, an absolute
`ZORID_CORE_WASM_DIR`, source `ZORID_CORE_BUILD_ID` and flat fixture module paths.
Fixture validation covers the original planner entrypoints; normal builds require
the complete current browser binding contract.

This packaging check establishes build wiring and matching asset bytes. Runtime
storage, editor integration, native/mobile behavior and sync need separate gates.
