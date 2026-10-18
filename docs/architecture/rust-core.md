# Rust core systems

[Architecture](README.md)

The core is a family of crates, not one process or database. Pure crates define
semantics; storage adapters commit them; host bindings expose bounded operations.
Desktop, browser and mobile share semantics without sharing a runtime instance.

| System | Crates | Owns |
| --- | --- | --- |
| Vault contracts | `zorid-core` | IDs, paths, revisions, mutation preconditions and idempotency plans |
| Text convergence | `zorid-crdt` | Yrs-backed text replicas and edit semantics |
| Durable native authority | `zorid-store` | SQLite commits, content, receipts, checkpoints, outboxes, projection journals and managed records |
| Native filesystem | `zorid-native` | Locks, scans/reconciliation, file publication, namespace changes and native query endpoints |
| Markdown semantics | `zorid-document` | Frontmatter/properties, headings, tags, aliases, links and task extraction |
| Index and search | `zorid-index` | Generations, publication fences, literal queries, link resolution and relationships |
| Bases/Types/Tasks/Calendar queries | `zorid-bases` | Portable compilation/evaluation and joined projections |
| Managed records | `zorid-records` | Scoped structured record operations, conflicts, schemas, tombstones and first-party WorkBlocks |
| Sync planning | `zorid-client-sync`, `zorid-file-sync` | Causal text, binary and namespace changes; prepare authored/received state |
| Encryption | `zorid-crypto` | Authenticated envelopes and key-recovery primitives |
| Wire contracts | `zorid-sync-protocol`, `zorid-proto`, `zorid-sync-rpc` | Bounded protocol rules, protobuf data and native service bindings |
| Native sync orchestration | `zorid-native-sync` | Bounded upload/receive sweeps and retained retry state |
| Encrypted relay | `zorid-sync-server` | Authorized ciphertext storage/transport and server backup/restore |
| Host boundaries | `zorid-desktop-host`, `zorid-wasm`, `mobile/rust` | Framed process RPC, browser exports and embedded native C ABI |
| Independent client | `zorid-cli` | Native file/index/query/sync commands without Electron or a mandatory daemon |

Each workspace crate is under [crates](../../crates/).
[Mobile FFI](../../mobile/rust/) is a separate Cargo workspace embedding the host
library. The [bindings guide](bindings.md) explains their execution models.

## Dependency boundaries

`zorid-core`, `zorid-document`, `zorid-index` and portable query/planning modules
must not acquire platform filesystem or UI ownership. `zorid-records` in-memory
state is not a durable authority. Native Store and the browser transaction host
atomically persist accepted state and receipts. A decoded request is not authorized;
a validated plan is not committed; a committed record is not proof of publication
or delivery. Network waits stay outside storage write transactions.

The detailed subsystem contracts belong in [storage](storage.md),
[indexing](indexing.md), [managed data](managed-data.md) and [sync](sync.md).
