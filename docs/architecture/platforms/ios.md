# iOS and native mobile boundary

[Architecture](../README.md) · [Bindings](../bindings.md) · [Saving](../saving-recovery.md)

## Current

The iOS application has native UIKit/SwiftUI presentation around an embedded
TypeScript editor. Native code provides the outer vault/files/recents/settings
surfaces and lifecycle integration. A Capacitor bridge controller hosts WKWebView,
which loads the shared renderer in editor-only mode.

```text
AppDelegate / SceneDelegate → native shell → Capacitor WKWebView → shared editor
                                                  ↓
                             TypeScript mobile-native capability adapter
                                                  ↓
                         NativeVault plugin → serial Swift session queue
                                                  ↓
                      Rust C ABI → EmbeddedHost → native Rust vault/storage
```

The native Rust library is embedded in the application. It is not browser WASM,
and iOS does not launch the desktop host executable. Swift owns native handles and
lifecycle; Rust owns shared storage/document/sync semantics. Current local vaults
are under app Documents `Vaults/<vault UUID>/`; the native vault catalog is separate
application-support metadata.

## Accepted navigation design and implementation limits

One initialized retained WebView per vault is to own logical document tabs,
selection, route/history and the live editor window. Native owns the physical
host/session, surrounding native UI and gesture input. It must not maintain a
second independent document cursor.

Canonical source contains component foundations; composed retained-host/navigation
behavior remains unfinished. Older simulator and physical-install results do not
prove the newer composition. Existing iOS work is preserved, but new implementation
follows desktop completion. Mobile suspension/termination must be considered in
the shared storage/recovery design now, without starting another mobile build.

Android still uses the older Capacitor Filesystem adapter; a native/JNI Rust path
is not established. Do not describe iOS support as Android parity.

## Source map

- [Native entry](../../../ios/App/App/AppDelegate.swift),
  [scene](../../../ios/App/App/SceneDelegate.swift),
  [native shell/plugin/session](../../../ios/App/App/NativeMobile.swift).
- [Native Pages](../../../ios/App/App/NativePages.swift) and
  [TypeScript native adapter](../../../src/platform/mobile-native.ts).
- [C ABI implementation](../../../mobile/rust/src/lib.rs) and
  [header](../../../mobile/rust/include/zorid_mobile.h).
- [Retained editor ownership plan](../../mobile-live-editor-window-plan.md).
