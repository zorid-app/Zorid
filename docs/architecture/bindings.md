# Platform bindings and standalone CLI

[Architecture](README.md) · [Rust systems](rust-core.md)

| Consumer | Boundary | Runtime ownership |
| --- | --- | --- |
| Electron | Preload/IPC → framed stdio → `zorid-desktop-host` | Separate native process managed by desktop main |
| Browser | Worker messages → `zorid-wasm` exports | Rust/WASM executes semantics; TypeScript owns IndexedDB transactions |
| iOS | Capacitor plugin → Swift serial queue → `zorid-mobile-ffi` C ABI | Native static library embeds `EmbeddedHost` |
| CLI | `zorid-cli` → native vault/core | Independent process; no Electron or mandatory daemon |

The desktop host crate provides both its process entry point and reusable
`EmbeddedHost`. Mobile embeds that library through a small owned-buffer/session C
ABI; exposing every internal Rust type directly to Swift is not the architecture.
Browser wasm-bindgen wrappers expose portable operations, not native rusqlite or
filesystem handles.

Native CLI/application concurrency is coordinated through vault/client locks,
SQLite and shared identity/receipt rules. It is not permission for two independent
writers to bypass those rules. Client release must drain/settle owned work before
retiring handles. Platform admission and bounded decoding are part of the boundary,
not implementation details that the UI can skip.

Android's native/JNI boundary is future work; its current adapter differs.

## Source map

[Desktop host](../../crates/zorid-desktop-host/src/),
[process transport](../../desktop/rust-vault-service.cjs),
[WASM](../../crates/zorid-wasm/src/lib.rs),
[mobile C ABI](../../mobile/rust/include/zorid_mobile.h),
[mobile implementation](../../mobile/rust/src/lib.rs),
[CLI](../../crates/zorid-cli/src/).
