# Storage and ownership

[Architecture](README.md) · [SQLite layer](sqlite.md) · [Recovery](saving-recovery.md)

## Logical data categories

| Category | Examples | Policy |
| --- | --- | --- |
| Vault files | Markdown and attachments | User-accessible files; logical mutations participate in sync |
| Managed records | Structured first-party WorkBlocks and related records | Authoritative structured state; sync through validated core operations |
| Local retained data | Recovery snapshots and device-specific pending intents | Survives restart; explicit expiry/settlement; not automatically synced |
| Local rebuildable data | Parsed metadata and search/index generations | May be discarded and rebuilt from authority; no sync |

Retained and rebuildable are different: an expired snapshot can be deliberately
deleted but cannot necessarily be regenerated. Location and sync eligibility are
also separate. Being stored in SQLite does not make a row a sync record.

## Current persistence

Native `NativeVault` opens `.zorid/vault.sqlite`. Store is authoritative for
committed current state, identity/revisions, content, operation receipts and
causal sync state. Ordinary files are its user-accessible projection, while
external file edits are reconciled into the core. Filesystem projection can be
pending after a successful database commit; neither side can be discarded casually.
Current optional index/cache tables share this same SQLite connection/database.

Browser storage uses TypeScript IndexedDB transactions around portable Rust/WASM
plans. Its derived index keys also currently share the existing authority DB.
Current checkpoint/host-intent rows are not periodic File Recovery snapshots.

## Accepted native placement direction — not yet implemented

```text
Vault/
  notes and attachments
  .zorid/vault.sqlite           authoritative native state and sync bookkeeping

Platform app-local storage/
  vaults/<local-vault-id>/
    cache.sqlite               rebuildable metadata/indexes
    recovery.sqlite            retained local snapshots
```

Desktop uses its app-data directory; native mobile uses private app storage.
This native layout is not a browser requirement. The browser joins an existing
sync group; local working state/caches do not constitute an independent durable
vault. Optional persistence and offline/reload behavior remain to be designed.
Recovery and cache do not travel with a copied vault and are excluded from sync.
Define stable local vault identity, copied/moved-vault handling, retirement and CLI
path discovery before cutting over; a display name is not a storage identity.

Temporary atomic-replacement files must be on a suitable filesystem near their
destination. They are neither history nor caches and require explicit settlement
and cleanup. Existing `.previous`/`.namespace` artifacts cannot be bulk-deleted
merely because their enclosing database commit succeeded.

## Interface review gate

[S0A module interface review](interfaces.md) checks supported consumer operations,
identity/transaction boundaries, errors, lifecycle and platform capabilities before
S1 optimization/downstream feature work. Storage contracts are reviewed during S0
design as well; the gate must not wait until an incompatible layer is built.

## Source map

[Store](../../crates/zorid-store/src/lib.rs),
[native vault](../../crates/zorid-native/src/native.rs),
[browser persistence](../../src/core/browser-streaming-vault.ts).
