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
Derived document caches use a separate connection: desktop and CLI opt into
app-local `cache.sqlite`; bare Store/native embedders use an in-memory cache.
Legacy optional cache tables in the authority DB remain recognized but inert.

Browser storage uses TypeScript IndexedDB transactions around portable Rust/WASM
plans. Its derived index keys also currently share the existing authority DB.
Current checkpoint/host-intent rows are not periodic File Recovery snapshots.

## Markdown note size

Markdown authoring has an explicit **1 MiB (1,048,576 UTF-8 bytes)** limit.
The editor checks a proposed change before applying it to its document or undo
history; the shared note buffer applies the same policy for other edit sources.
Oversized changes show a plain size explanation and leave the note unchanged.
Loading/recovery does not discard an existing oversized draft; it may be reduced
toward the supported size. Attachments and other file types do not inherit this
Markdown editor limit.

The Rust Text materialization limit and native/browser read/write paths support
the same1 MiB body. Encrypted Text envelopes have an8 MiB plaintext allowance
because the existing JSON encoding expands CRDT update bytes; request wrappers
also allow8 MiB. File-family and managed-record payload bounds stay1 MiB, and
binary files retain their independent streaming/chunk limits. The envelope
allowance is not the user-facing Markdown file-size limit.

Store15 updates only the immutable Text payload constraint; relay2 updates its
envelope constraint. Known predecessor schemas are validated exactly and
migrated transactionally while retaining existing bytes and identities.

## Native placement

```text
Vault/
  notes and attachments
  .zorid/vault.sqlite           authoritative native state and sync bookkeeping

Platform app-local storage/
  vaults/<local-scope-key>/
    cache.sqlite               rebuildable metadata/indexes
    recovery.sqlite            retained local snapshots
```

Desktop/CLI use the shared app-data resolver. The local scope key hashes authority
identity plus canonical vault location, so aliases reuse one bucket and copies at
different locations stay separate. Moving a vault currently creates a new bucket;
old retained history is not deleted or silently reassociated. Native mobile can
supply private app storage through the shared API; its rollout remains paused.
This native layout is not a browser requirement. The browser joins an existing
sync group and retains local working data/derived indexes for low-latency access
and incremental catch-up. Browser storage is not a native vault directory; its
engine and exact offline/reload guarantees remain to be designed. Protect pending
edits/receipts separately from refetchable synchronized content.
Recovery and cache do not travel with a copied vault and are excluded from sync.
A display name is not a storage identity. Retiring old buckets or reassociating
retained history after a move remains an explicit future operation.

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
