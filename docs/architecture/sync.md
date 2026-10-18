# Sync and security

[Architecture](README.md) · [Storage](storage.md) · [Bindings](bindings.md)

## Current responsibilities

`zorid-client-sync` plans authored/received text changes around Yrs replicas.
`zorid-file-sync` plans causal binary/chunk/namespace/liveness changes. Neither
owns persistence or network execution. Native Store and browser transactions
commit accepted state, receipts, cursors and retry data atomically where required.
Retries retain operation/update identity and exact ciphertext rather than inventing
a replacement after an uncertain result.

`zorid-crypto` seals authenticated encrypted envelopes and supplies key-recovery
primitives. `zorid-sync-protocol` validates bounded wire contracts; protobuf and
native RPC crates provide transport representations. Decoding alone establishes
neither device authorization nor valid domain state.

`zorid-native-sync` runs bounded native upload/receive sweeps. Browser sync workers
and transport adapters drive corresponding portable plans. The standalone CLI can
sync independently; Electron is not a mandatory daemon.

`zorid-sync-server` authorizes account/device/vault access and stores ciphertext
in its own server database. The relay does not need vault plaintext keys. Fixture/
operator provisioning and tested transports do not establish finished enrollment,
Google integration or production account administration UI.

## Browser membership

The intended browser client joins an existing sync group instead of owning a
standalone durable local vault. It still needs scoped authorization, key access,
initial state acquisition, convergence and reconnect behavior. Local working
state/cache persistence is optional. Current IndexedDB receipts alone are not a
remote acknowledgment, and deleting unconfirmed edits is not an allowed shortcut.
Offline/reload retention and group-join UX remain design work.

## What participates in sync

Sync logical vault changes and admitted managed-record operations, not live SQLite
files. Device checkpoints, locks, projection artifacts, parse caches and local
File Recovery snapshots remain local. Future synced version history needs its own
policy; it is not enabled by putting history in a database used elsewhere for sync.
Filesystem publication and network acknowledgment are distinct from local commit.

## Source map

[Text planner](../../crates/zorid-client-sync/src/lib.rs),
[file planner](../../crates/zorid-file-sync/src/lib.rs),
[crypto](../../crates/zorid-crypto/src/lib.rs),
[protocol](../../crates/zorid-sync-protocol/src/lib.rs),
[native sync](../../crates/zorid-native-sync/src/lib.rs),
[relay](../../crates/zorid-sync-server/src/),
[browser transport](../../src/platform/browser-sync-transport.ts).
