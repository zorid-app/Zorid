# Unified SQLite infrastructure

[Architecture](README.md) · [Storage categories](storage.md)

## Current

`zorid-sqlite` provides checked connection opening for native `zorid-store` and
`zorid-recovery`: read-transaction schema validation before WAL changes, a five-second
busy timeout, WAL, FULL synchronization and foreign keys. Each domain still owns
its schema and revalidates under IMMEDIATE transaction before initialization.
No-follow paths reject symlinks throughout the filename, so trusted hosts resolve
canonical parent directories first. Store preserves authoritative joint commits.
Document caches use an independent connection and scoped app-local database,
with an in-memory fallback. Legacy authority cache tables are inert. Browser
still uses IndexedDB.

## Accepted direction

Provide shared Rust SQLite infrastructure for durable desktop/mobile storage.
Browser clients share domain/service contracts but join existing sync groups; they
retain persistent local working data/indexes for responsiveness and incremental
catch-up. This requires persistence, not a predetermined engine: SQLite/WASM+OPFS
remains a candidate, while current IndexedDB already persists data. The native
SQLite infrastructure does not automatically become a browser implementation.

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

Cache operations reserve/pin cache before authority, so waiting on a cache lock
does not reserve source storage. They recheck source/publication fences under the
authority reservation and commit only cache before releasing authority. Reads
pin cache before observing source; cache may lag the observed source but cannot
come from its future. This is not a transaction spanning both databases. Parsing
stays outside write transactions.

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

## Interface review gate

[S0A module interface review](interfaces.md) checks supported consumer operations,
identity/transaction boundaries, errors, lifecycle and platform capabilities before
S1 optimization/downstream feature work. Storage contracts are reviewed during S0
design as well; the gate must not wait until an incompatible layer is built.

## Source anchors

[Native Store](../../crates/zorid-store/src/lib.rs),
[index persistence](../../crates/zorid-store/src/document_index.rs),
[WASM boundary](../../crates/zorid-wasm/src/lib.rs).
