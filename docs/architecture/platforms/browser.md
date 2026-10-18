# Browser

[Architecture](../README.md) · [SQLite](../sqlite.md) · [Indexing](../indexing.md)

## Current

The browser loads the same TypeScript Workspace, CodeMirror editor and document
views as desktop, without Electron chrome or a native filesystem host.
`createPlatformAdapter()` selects the normal browser vault. Ordinary local startup
requires neither sync credentials nor a connection to a relay.

```text
Browser page / TypeScript UI
  → BrowserCoreRuntime message channel
  → dedicated Worker
      → Rust/WASM: validation, parsing, planning, crypto and queries
      → TypeScript host: IndexedDB transactions and local persistence
```

WASM bindings do not persist data themselves. The transaction host atomically
stores source state, operation receipts and related metadata in IndexedDB. Local
index keys currently live in that same browser database. Worker/client admission,
leases and scoped capabilities coordinate concurrent browser consumers.

Browser storage is origin-local. Its availability, quota and lifecycle differ from
native files; errors must not cause a silent switch to an empty replacement vault.
Native filesystem publication is not part of this storage path.

## Source map

- [Default browser startup](../../../src/platform/browser-default.ts).
- [Worker client](../../../src/platform/browser-core-runtime.ts) and
  [worker dispatcher](../../../src/platform/browser-core-worker.ts).
- [IndexedDB transaction host](../../../src/core/browser-streaming-vault.ts).
- [Derived index persistence](../../../src/core/browser-document-index.ts).
- [WASM exports](../../../crates/zorid-wasm/src/lib.rs).

## Accepted direction

Evaluate SQLite/WASM backed by OPFS for the shared SQLite design. This is not the
current browser backend. Validate supported browsers, persistence, multi-tab
ownership, lock behavior, quota handling and deployment requirements before
replacing IndexedDB. Sharing SQL/schema does not eliminate platform-specific I/O.
