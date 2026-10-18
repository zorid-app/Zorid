# Unified SQLite infrastructure

[Architecture](README.md) · [Storage categories](storage.md)

## Current

Native SQLite access is implemented in `zorid-store` using `rusqlite`; Store
coordinates related authoritative changes inside transactions. Optional document
cache tables live on that Store connection. There is no unified three-platform
SQLite infrastructure layer yet, and the browser still uses IndexedDB.

## Accepted direction

Provide shared Rust SQLite infrastructure for durable desktop/mobile storage.
Browser clients share domain/service contracts but join existing sync groups; they
are not required to use a persistent local SQLite database. The earlier mandatory
browser SQLite/OPFS proposal is superseded. Browser SQLite/WASM remains an optional
implementation choice if it helps reuse queries or manage working state.

The native storage path is:

```text
Vault / managed-data / recovery / index services
  → shared connection, transaction, schema and diagnostics infrastructure
  → native SQLite (desktop/mobile)
```

The layer should own connection configuration, database roles/paths, schema
versions, transactions, busy/locking behavior, resource limits and error mapping.
Each service owns its tables and domain operations. UI calls service operations;
it does not issue arbitrary SQL. Shared infrastructure does not mean one global
connection or one database file for every role/vault.

Keep authoritative, recovery and cache lifecycle separate. Source commits must
not depend on a healthy cache. Recovery retention must not use a generic cache
clear operation. Local-only rows must not enter sync merely because they share
infrastructure with managed records.

## Implementation gates

1. Inventory current transactions and preserve their atomic boundaries while
   wrapping existing native Store access. Do not split tables whose joint commit
   is a correctness requirement.
2. Specify browser join/bootstrap and pending-edit behavior independently of
   native SQLite rollout. If SQLite/WASM is selected for browser working state,
   prove its integration and required lifecycle/concurrency behavior. Persistent
   OPFS is not a platform-parity gate; native rusqlite does not automatically
   become a browser implementation.
3. Define the app-local vault-ID/path resolver used by desktop, mobile and CLI.
4. Move derived caches and add recovery storage independently. Cross-database
   operations require explicit ordering/retry; do not assume a global transaction.

These are design obligations, not completed migrations. No blanket replacement of
IndexedDB or the existing authority schema is authorized by a diagram alone.

## Source anchors

[Native Store](../../crates/zorid-store/src/lib.rs),
[index persistence](../../crates/zorid-store/src/document_index.rs),
[WASM boundary](../../crates/zorid-wasm/src/lib.rs).
