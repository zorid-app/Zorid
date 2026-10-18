# Browser

[Architecture](../README.md) · [SQLite](../sqlite.md) · [Indexing](../indexing.md)

## Intended product role

The browser joins an existing sync group and presents its data through the shared
editor. Desktop and mobile own durable local vaults; the browser is not required
to create or maintain an independent persistent vault. This supersedes the earlier
three-platform persistent-SQLite/OPFS proposal.

Rust/WASM still provides validation, decryption/convergence, parsing, indexing and
query semantics for the browser client. Joining requires the group's authorization,
key access and initial synchronization; it does not imply unrestricted access or
plaintext processing by the relay. The join UX and enrollment protocol remain to
be specified.

Working data, indexes and caches can exist locally during use. Browser-local
persistence is an optional implementation detail, not a durable-vault product
promise. Do not require a full persistent replica, per-vault recovery.sqlite or
SQLite/OPFS migration simply to match native storage. Offline editing, reload
recovery and storage retention policies remain unspecified.

A browser edit must not be reported as synced based solely on an in-memory change
or a local database write. Preserve truthful pending/error state and define how
unconfirmed edits are handled before leaving; no unsaved-data deletion is authorized
by this architecture correction.

## Entry and departure flow

The planned web.zorid.app entry offers Zorid Cloud sign-in or connection to a
self-hosted service URL. After authenticating, select/join an authorized sync group,
unlock its content and show notes, attachments, Bases, Tasks and Calendar through
the shared UI. Hosted and self-hosted use the same client/protocol. This describes
the intended product; it does not claim a deployed hosted service or complete UI.

When the user leaves, optional cache can remain to accelerate a later visit. On
return, authenticate/unlock, validate that cache and fetch current changes. The
service and durable synced native clients retain the group's data. Cache loss
must be recoverable by refetching synchronized content; unconfirmed edits are a
separate pending-data obligation. Sign-out/key retention and cache expiry policies
remain to be settled. See [S10 in the roadmap](../../roadmap.md#s10--connected-web-workspace).

## Current implementation — differs from target

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
Native filesystem publication is not part of this storage path. The current
standalone local-startup behavior above is existing code, not the intended
sync-group joining product flow.

## Source map

- [Default browser startup](../../../src/platform/browser-default.ts).
- [Worker client](../../../src/platform/browser-core-runtime.ts) and
  [worker dispatcher](../../../src/platform/browser-core-worker.ts).
- [IndexedDB transaction host](../../../src/core/browser-streaming-vault.ts).
- [Derived index persistence](../../../src/core/browser-document-index.ts).
- [WASM exports](../../../crates/zorid-wasm/src/lib.rs).

## Next architecture work

Design join/bootstrap, working-set acquisition, reconnect and pending-edit behavior
around an existing sync group. Choose in-memory or optional cached storage based
on those requirements. SQLite/WASM may be useful to reuse query/storage logic,
but persistent OPFS storage is not a requirement. Do not remove the existing
IndexedDB path until the replacement's state/receipt and pending-edit handling is
explicitly designed and verified.
