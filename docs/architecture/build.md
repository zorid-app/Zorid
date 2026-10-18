# Build and delivery boundaries

[Architecture](README.md) · [Platform setup](../platforms.md)

Vite builds the shared TypeScript/CSS renderer. Browser builds include generated
Rust/WASM assets; native builds omit the browser core payload because desktop/iOS
use native Rust. Generated JavaScript glue and WASM must match their Rust input.
A TypeScript-only build does not verify a freshly compiled native host.

Electron packaging stages renderer resources, native host and dependencies.
Capacitor synchronization copies the native renderer assets; iOS compilation/signing
and device behavior are separate steps. Mobile's Rust static library has its own
Cargo workspace and C header boundary. The relay and CLI are independent native
artifacts.

Use checks appropriate to changed boundaries: component tests for semantics,
actual storage transactions for persistence, and actual desktop/browser/native
flows for their runtime claims. Keep heavy Rust/Xcode work serialized on the local
machine. Documentation changes need link/navigation/source review, not app builds.

## Source map

[Package commands](../../package.json), [Vite configuration](../../vite.config.mjs),
[WASM build](../../scripts/build-core-wasm.cjs),
[desktop staging](../../scripts/stage-desktop.mjs),
[iOS build](../../mobile/scripts/ios-build.sh),
[workspace crates](../../Cargo.toml), [mobile crate](../../mobile/rust/Cargo.toml).
