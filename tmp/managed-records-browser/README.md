# Actual managed-records browser fixture

Owner: task `task_eadeb14c7e04`, dispatch `ctx_beb32c3918c8`, terminal
`term_a9b70f4e-5734-4bd7-9b54-4427df3a6697`; owned scope is this harness and
new output proof files only. Integration branch `tingkai-c/managed-records-integration`.
Coordinator assembled A Rust/WASM and B TypeScript at `13f8e10c588ba02133019cb4a4a410e994401785`
and authorized committing these harness adaptations before taking the run freeze.
Actual browser results belong to separate timestamped raw reports; prepared assertions
below are not runtime evidence. Syntax checks of all three `.mjs` files pass.
`tmp/` is ignored; preserve only intended harness files using explicit `git add -f`.

## Later execution after coordinator source freeze

First assemble/review A+B and freeze the integration tree. After coordinating
heavy compiler load, coordinator rebuilds the real pair using existing tooling (this worker never builds):

```sh
node scripts/build-core-wasm.cjs
```

Then run from the integration checkout (Node 26 with global `WebSocket`):

```sh
node tmp/managed-records-browser/run.mjs --expect-head "$(git rev-parse HEAD)"
```

For a separately recorded exact freeze, replace the command substitution with its
full 40-character Git SHA. The runner NEVER builds WASM. `--out /absolute/path`
and `--timeout-ms 120000` are optional. Existing Vite resolves from the current
checkout or `ZORID_TOOLING_ROOT` (default `/Users/ctk/Projects/Zorid`); it installs
nothing. `CHROME_BINARY` defaults to the provided Google Chrome app binary.
It loads no repository Vite configuration or root build hook.

Before launch, the runner independently recomputes the existing WASM build input
fingerprint (all crate Rust/manifests, root Cargo files and builder), checks
`build.json`, verifies both artifact SHA-256 hashes, and checks required records
bindings. It records the core/harness source digest and full HEAD. All witnesses
are recomputed after browser completion; changed sources/artifacts invalidate the
run. This establishes matched local build provenance, not independent reproducible
build attestation or a security audit.

Vite binds its own ephemeral loopback port. Chrome gets a fresh uniquely named
disposable profile and its own ephemeral CDP port; the runner reads that profile's
`DevToolsActivePort`, creates one target and connects using Node's built-in WebSocket.
No existing browser is attached, no process is killed by name/port, and no existing
port is taken. The runner closes its CDP connection, terminates only its own child,
closes Vite, and removes its own profile after confirmed Chrome exit.
Reports go to `artifacts/<timestamp>/report.json`, `cdp-events.json`, and optional
`chrome-stderr.log`; failures return nonzero. No real vault/key/server/network
sync transport is used. A fixed synthetic 32-byte key and unique synthetic IDB
names exist solely in the disposable fixture profile.

## Actual source seam assumptions

The fixture imports the real `src/core/browser-streaming-vault.ts` opener through
`opener.mjs`. B's in-progress source was inspected read-only; its actual current
`vault.managedRecords` surface matches the following calls. Reconfirm against the
assembled freeze; if it changes, adapt ONLY `opener.mjs`/fixture call sites, never
insert a semantic/storage/authentication stand-in.

- `openBrowserStreamingVault({name,wasm,clientId,assertActive,managedRecordsSession})` creates the current
  fresh schema with managed stores and returns `managedRecords`.
- `managedRecordsSession()` returns the fixture-owned real `WasmVaultKey`, a stable
  per-open `sessionToken` object, and a lifetime-bound `assertActive`; each reopen
  creates a fresh token. This is trusted fixture host wiring, not product enrollment.
- The private trusted `managedRecords.register(collectionKey, registrationBytes)`
  returns a closure-owned token; `apply(token,{scope,operation,expectedRevision,
  command})` returns `{result:Uint8Array,replay,localDurable}`.
- `snapshot(token,scope)` returns `{state,projection,metadata}`; only bounded digest
  metadata is JSON-parsed. Raw state/projection/request/result remain bytes.
- `retryPage(token)` reopens retained real ciphertext through the enrolled key;
  existing `sync.receive(id,wire,key,delivery)` dispatches authenticated records.
  B's current common-ledger retained-key behavior must survive reopen; fixture
  will expose a failure if registration/retry cannot acquire that key.
- Current real WASM exports include the frozen records functions plus
  `recordsRetryEligible`, `recordsLocalReadSet`, `recordsStoredReadSet`, all three
  stored evidence validators, `RecordsPlan.payloadMetadataJson`, and authenticated
  `WasmSyncUpdate.recordsReadSetJson/prepareRecords` (later A/B corrections).
- Registration field/object order and operation payload fields match existing
  Rust serde documents. Synthetic JSON bytes only author inputs; Rust validates
  them. No JS admission, union, projection or schema classifier is implemented.
- File and Text use the real existing family command/write, seal and receive paths.
  `vault.sync.pending(100)` must expose the tiny synthetic workload in authored
  order; no production pagination completeness claim is made.

The fixture is internal trusted host code, not a plugin or public registration
API. `assertActive` belongs to this fixture's own lifetime; cross-tab/worker lease
fencing requires a separate worker lifecycle pass.

## Prepared assertions (not yet runtime evidence)

1. Local Synced creation with i64 MAX/MIN and Number `51.248178375505404` literals
   authored directly into raw UTF-8; exact state/projection survive close/reopen.
   The mixed stream records authenticated decrypted raw wire plaintext, checks all
   three literals, and checks the received f64 projection before and after reopen.
   Domain request/state/projection/wire plaintext never pass through JSON.parse.
2. Lost-response simulation: retain original test receipt but discard it from the
   simulated caller, mutate later, close/reopen and retry the original stale request.
   Assert exact original result bytes, replay marker and byte-identical all-store
   snapshot. This simulates caller response loss after a known committed call;
   it does not kill a worker mid-RPC or prove OS crash/power-loss behavior.
3. Local and Cache durable creation/replay with no common sync authored/source rows
   or pending outbox and no duplicate changes on replay.
4. Real encrypted authored Records + Files + Text delivered through actual
   streaming dispatcher in one cursor chain; exact record state and text bytes,
   no receive echo, persisted cursor after reopen.
5. AEAD tamper, wrong envelope scope, authenticated unknown records format and
   cursor gap all reject with exact before/after snapshots of EVERY actual store.
6. Missing-parent child retained, invalid-schema-value child retained/rejected,
   reopen, parent received and bounded AEAD-backed retry recovering child while
   invalid child remains terminal `invalid_operation`.
7. Fault injection calls actual Chrome `IDBTransaction.abort()` after an actual
   `managed_records.put` request succeeds. Assert no partial state, replay row,
   changes, source, quota, cursor or outbox; close/reopen preserves rollback;
   the same operation can then commit as fresh.
8. Observation wrappers require `{durability:'strict'}` on all fixture database
   readwrite transactions and record real `complete`/`abort` events. They never
   synthesize transactions/results. Raw inspection uses real readonly cursors.

Successful execution deliberately reports `passed-subset`, never full acceptance.
Still required: full retry 16-count/1MiB/continuation boundaries, conflicting
waiting commitments/equivocation, authored self-echo versus received duplicates,
restoration generations, quota boundaries and replacement, signed-i64 sequence
ceiling, cross-tab lease loss/reacquisition, worker lifecycle and product/native/
mobile integration. No runtime gate can close from this preparation checkpoint.
