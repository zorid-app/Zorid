# Two independent browser Worker replicas — bounded acceptance

Owner H: task `task_6f5d6af956f8`, dispatch `ctx_f9213f43b719`, terminal
`term_287b7e5c-2b5f-468c-beca-6a17d797a3d0`; isolated branch
`tingkai-c/managed-records-worker-host`. Coordinator agreed NEW-only fixture
scope in `msg_1fc69b9805e9`. The five prior host commits through `38539b42`
were handed off unchanged; the coordinator reports canonical main `547036a7`
contains their byte-exact source. This worker did not mutate main or integrate
the separate guard branch.

## Contract and source freeze

Only NEW `tests/browser-managed-records-replicas/**` and this report are owned.
The dedicated test Worker imports the actual `openBrowserStreamingVault`,
`BrowserSyncWorker` and `claimBrowserClient`. Each replica owns a different
actual IndexedDB authority/database, UUID client lease and WASM key lifetime.
Fixed synthetic Synced/Local/Cache registrations and a fixed set of operation
names are compiled into the fixture. No fake engine, merge, admission, storage,
authenticated update or key implementation is used. The fixture protocol is
not a normal product Worker authoring or public plugin/registration API.

The synthetic in-memory HTTP relay stores only real ciphertext, sequences and
request metadata. Actual `BrowserSyncWorker` seals through durable common source
storage, uploads, validates raw acknowledgments with Rust, acknowledges the shared
outbox, pulls and AEAD-opens/receives through the real adapter and common cursor.
**Transport exercised here is the HTTP JSON v1 reference path, not protobuf/gRPC.**
No transport implementation was changed to obtain this result.

Frozen fixture/source HEAD:
`46a1a83d8dabf829de93f62aecdd279560f8a77a`.
This commit adds exactly `worker.mjs`, `fixture.mjs`, `run.mjs` and `index.html`
in the new fixture directory. All existing source, tests, docs, Rust, manifests,
locks and generated bindings remain unchanged. Generated WASM assets are exact
local copies of the previously verified assembly; no build was run here.

## Actual verification

Syntax checks for all three new modules and `git diff --check` pass. No Node
semantic mocks or additional broad build/test campaign were used. Actual command:

```sh
node tests/browser-managed-records-replicas/run.mjs --expect-head 46a1a83d8dabf829de93f62aecdd279560f8a77a --out /private/tmp/zorid-managed-replicas-first
```

**Chrome 155.0.8059.80: four groups PASS on the first actual run**, with real
WASM, independent dedicated Workers, actual strict IDB and encrypted HTTP1
exchange. Raw report including canonical bytes, receipts, relay trace, IDs,
strict-transaction witnesses and cleanup:
[`report.json`](../../tests/browser-managed-records-replicas/artifacts/46a1a83d/report.json).
SHA256 `4fc2e5aea4de18a348629aa4d2daeb2eef2c0bde71aa4f4e5efa8747343cd1d1`.

1. **Common baseline, offline separate-field edits.** A creates a root and both
   replicas consume it before independently patching different fields. Both edits
   return durable receipts and remain in separate outboxes without network use.
   A seals its outbox twice with identical ciphertext, proves exact wire bytes
   are in actual IDB, closes/reopens, then seals the same retained bytes again.
   Exchange converges full canonical state, projection and revision, retaining
   both edited fields. Exact local replay after newer remote history returns the
   original receipt without a new change/authored row; received duplicates leave
   the canonical outcome and durable change count unchanged.
2. **Same-field conflict.** Both replicas edit the same shared baseline offline.
   Canonical state/projection/revision converge with exactly two title candidates,
   `conflict-left` / `red-offline` and `conflict-right` / `blue-offline`. The actual
   engine's documented ascending operation-ID candidate ordering selects the last
   candidate for display (`blue-offline`), while both remain retained. This is a
   projection/display-rule assertion, not a rendered product UI test. Both Workers
   independently close/reopen and retain the exact canonical bytes and candidates.
3. **Delete/edit race.** Concurrent offline delete and edit converge with
   `created:true, deleted:true`, retained edited field, and all three operations
   `race-delete`, `race-edit`, `race-root` in canonical history. A new post-delete
   patch is rejected by actual Rust with `Deleted`. Reopening both Workers retains
   the exact tombstone, edit history, projection and revision; no resurrection.
4. **Local/Cache isolation and no echo.** A's Local/Cache creates do not add common
   authored rows or sync payload bodies and do not increase relay ciphertext count.
   B's Local/Cache projections remain uncreated. A reopens and exactly replays both
   receipts with unchanged state. Final authored rows are precisely A's six and B's
   three local Synced operation IDs; received operations create no authored echo.
   Both outboxes are empty and both shared delivery cursors are exactly `9`.

The run asserts distinct database names, authority IDs and client IDs. It observes
strict transaction options **and** actual `tx.durability === 'strict'` for every
readwrite transaction in each fixture Worker; counters reset on Worker reopen,
so final-session counters are not presented as aggregate counts for the full run.
Both fixture databases were actually deleted, all owned Workers were terminated,
and the runner confirmed owned Chrome exit and removed its profile after closing
its Vite server. No owned compiler/build/server/browser remains live. There were
no failed actual replica runs to omit; the expected post-delete rejection is
asserted in group 3. Earlier host-fixture failures belong to the separate report.

Source/artifact witnesses were checked before and after execution:

- Source digest (all `src/core`, `src/platform`, new replica fixture modules):
  `389229541825552f7e12c54baf403304a0d9e2fde0a3483031843c7ecf847f0e`.
- WASM fingerprint:
  `a4027f128c91099071a2744f90a599b9151ee623599f3e4b7c4846283a16e0f8`.
- JS glue SHA256:
  `1145a203bda8c72a6e017e87f0adda6df4b5c9d992d802c56ece864538ffae31`.
- WASM SHA256:
  `b8e316e2a8d4e8a498c0e8f2d48b844d3b3db4ca51513bbd000674f26283ae2e`.

Independent R read-only review `msg_cdc73e9a36c2` inspected exact `46a1a83d`
and its matching raw report: four groups passed, no source blocker. Final report
claims/evidence review is requested separately; no earlier approval is stretched
to cover later unreviewed source.

## Remaining boundaries

This closes the bounded **independent adapter/Worker** offline-convergence gap
identified in the earlier host report. That report's historical statement remains
accurate for its earlier five-group run. The normal product Worker still has an
empty registry and no public authoring activation; this dedicated fixture does
not change that. Actual protobuf/gRPC transport, deployed production relay,
exhaustive quota/failure/browser matrices, application UI, desktop/native/mobile
and the remaining complete managed-data plan are separate gates. Whole Phase 1
or product completion is not claimed.
