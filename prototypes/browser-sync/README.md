# Browser atomic sync storage fixture

Source-only fixture; no runtime result is implied. Build and browser execution require the coordinator's serialized slot.

From this worktree, compile with the repository TypeScript executable:

```sh
node /Users/ctk/Projects/Zorid/node_modules/typescript/bin/tsc -p prototypes/browser-sync/tsconfig.json
```

Serve this worktree with a static server and provide an explicit generated current-v2 WASM module URL to `prototypes/browser-sync/index.html?wasm=...`. The wrapper must include full-family planning, strict persisted payload/wire validation, snapshot validation, historical binary witness verification, and shared materialization/recovery classification. The required combined consumer wrapper source is 00065a2; it must be built for the acceptance run and older WASM artifacts must not be reused. Record source SHA, wrapper SHA, generated WASM hash and browser version in validation evidence. No native data daemon or network relay is used here: this checks actual independent IndexedDB stores and two connections, not HTTP or editor integration.

Only random disposable `zorid-core-vault:sync-*` databases are enrolled. Cleanup closes all handles and deletes only names created by the fixture. Each group has a 30-second deadline. Quota injection tests rollback/classification, not real browser disk exhaustion. Two connections share real IDB transactions, but this does not establish worker or tab lifecycle acceptance.

The fixture uses real file-v2 Create to establish namespace/text bootstraps, then the ordinary vault mutation API for managed text writes. File payloads, received envelopes, text/namespace plans, and persisted states are validated by Rust; no duplicated CRDT or namespace model exists in the fixture. Ordinary family commands now route through the shared Rust mapper, with explicit creation mode persisted before authorization; this source has not yet passed browser execution. The source now includes seal races, wire equivocation, binary partial assembly, concurrent deletion recovery, exact namespace retries, mode-bound intent preparation/replay, cursor fencing, cross-family identity reuse, hidden-witness/status corruption and untouched schema5 rejection. Additional required cases include explicit restore and application worker/HTTP acceptance. All groups remain unrun until a coordinator-granted slot.

Resource limitation: the initial correctness implementation eagerly loads and validates all retained graph/text/envelope/materialization/history rows on every transaction, including pending(limit). A small return limit does not bound storage reads. This is not production scalability evidence; normalized targeted reads, per-state validation caches tied to durable versions and large-vault/quota acceptance are required before broad enablement. No keys or bearer tokens are persisted by this module.

Publication history is separate from current recovery content. Immutable `sync_publications` records bind exact metadata revision to published bytes, presentation and historical text snapshot or binary event; hidden transitions retain that baseline. `readRetained().recovery_content` separately derives current verified content through Rust. The fixture retains a global revision fence capped at 8,192 tokens and caps publication history at 4,096 records and 32 MiB of retained content plus encoded text snapshots; admission rejects atomically at the limit, without automatic deletion or GC. This budget does not bound total JavaScript heap. Classifier input graph and aggregate text JSON are each capped at 8 MiB.

Typed namespace fixture authoring initializes an explicitly bound local empty text state. Receiving a namespace-only Text Create stays hidden until a text state arrives. This low-level fixture hook is separate from ordinary Create, which now uses the shared Rust family command mapper and exact durable FamilyCommand. The composite command is capped at 4 MiB encoded JSON.
