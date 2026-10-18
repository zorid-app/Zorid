# Normal browser WorkBlock proof harness

**SOURCE ONLY: gate2/3 have not run or passed.** V source successor task
`task_83ee5512f2f3`, dispatch `ctx_507e6047b69b`, isolated `managed-browser-wb-proof`.
Contract SHA256 `adc287835bc5e05e649122c3375bc34f54e1f713b440d620421dc390a05bb082`.

## Actual product lifecycle

All authored operations in `fixture.mjs` use actual `BrowserCoreRuntime` ->
`admitBrowserClient` -> `consumer.workBlocks` -> normal `browser-core-worker.ts`
-> fixed product registry -> actual generated WASM -> actual strict IndexedDB.
There is no synthetic consumer, alternate Worker, external authored seeder,
hand-built domain wire command, JS merge, registration substitute or WASM stub.

Local authorities use `open({initializeLocal:true,...})`. Independent encrypted
replicas use normal unenrolled `open`, existing
`configureSyncFixture({...enrollEmpty:true})`, then `admitBrowserClient`. H
`d5cd2c8c` and corresponding P readiness successor must be composed: initial
unenrolled open has no service; successful configuration must refresh the normal
`{workBlocks:boolean}` capability only after guarded fixed registration. Both
replicas retain different actual DB authorities/client leases and one logical
realm/vault. Sync configuration/keys are fixture credentials, not enrollment UX.

## Bounded source campaign (12 groups; all browser assertions unexecuted)

- Actual CRUD/ref/delete/read, remove/readd exact retry, newer-state/reopen
  original receipts, stale/target collision/range rejection with exact relevant
  IDB stores and counters unchanged, native-shaped changes.
- 66 live records cross the 64 scanned-row ceiling: 1 MiB maximum public budget,
  31-day bound, filtered/deleted scan cost, first-row byte rejection, deterministic
  coverage, repeated/foreign/evicted/reopened cursors and collection watermark.
  Rust-reported snapshot byte counts force a partial page whose excluded next row
  must resume; an actual normal unrelated file-family command must not invalidate
  the WorkBlock cursor despite advancing the global publication sequence.
- Corrupt only an existing current state's bytes, replay its original remove
  receipt despite a later readd, prove replay transaction reads only authority,
  registration and original journal, then restore the exact original state.
- Admitted release drains a real final-write-held strict transaction before ACK
  and cleanup; exact same client reacquires and recovers its receipt.
- Deliberate normal Worker closing while a real callback is held before prepare
  must abort with definite noncommit and zero durable changes.
- Closing during actual `common.authored` after staged managed state/change and
  immutable source writes must abort, roll back all stores/counters and report
  definite noncommit; witnesses require the actual staged writes occurred.
- Closing after final native writes must really complete, suppress stale change
  notifications, report uncertainty and recover the original receipt on same
  client reacquisition without another authored/source/change/journal row. Before
  abandoning the still-live parent facade, explicitly retry identical input: the
  genuine Worker predispatch rejection is definite but the same facade must keep
  the original uncertainty. Changed same-operation input must collide locally
  without another RPC or automatic/new-ID mutation. Original receipt recovery
  then occurs after reacquisition; it is not a same-facade success claim.
- Revoke sync credentials during a held local mutation: durable local authoring
  remains independent of credentials and retains the common outbox for later sync.
- Drop exactly one real committed response, await runtime transport timeout,
  require uncertainty and unchanged original receipt/source/outbox after restart.
- Two normal same-DB clients deliberately lose the writer's BroadcastChannel hint;
  real foreground refresh must catch durable changes, without repeating delivery.
- Two independent normal Workers perform real encrypted HTTP1 exchange after
  offline separate-field, concurrent title/range, reference and delete/edit races;
  restart and compare exact canonical state/projection/revision/candidates/
  tombstones, original receipts/sealed bytes, empty outboxes/shared cursor/no echo.
- Real wrong-key/scope rejection preserves data; revoke a receive session while a
  real encrypted receive transaction is held, prove abort and unchanged cursor/
  source/state, then reconfigure and converge normally without receive echo.

## Authorized observation and deliberate fault boundaries

`run.mjs` uses `observation-transform.mjs` to prepend exactly two statements to
**only** the frozen normal Worker. It imports/installs `worker-observer.mjs` and
retains the entire original product module body byte-for-byte. It hashes original,
prepend and transformed bytes, checks the exact original body at each transform,
records actual transformed-load witnesses and rejects any mismatched body. There
is no registry transform. This source wiring is authorized by the successor task;
that does not authorize a browser/build launch.

The observer watches native IDB calls and terminal events without replacing
transactions or product settlement handlers. A deliberate callback hold retains
the genuine request success, keeps the real native transaction live using reads,
and later invokes that original handler inside a native request callback. A
final-write hold begins only after journal/counter write success. Holds have a
10-second fail-safe; any deadline release makes the proof fail. Read/write traces
exclude observer keepalive reads. Every observed normal write needs requested
and actual durability `strict` plus a terminal witness; missing/truncated evidence
cannot pass. Capture-phase product terminal listeners remain unchanged.

`observation-client.mjs` taps the actual Worker constructor used by the runtime.
Its injection API accepts only normal `release-client` and `refresh` lifecycle
messages, explicitly fault scheduling outside the admitted release path; it cannot
send semantic authoring RPCs. Public admitted release has its own separate test.
Reply drop and hint suppression preserve exact product payloads on all other
messages. Fault corruption uses a native strict write in an owned disposable DB,
never a seeder authored operation, and always attempts to restore original bytes.
The report identifies each deliberate fault separately from product operations.
`report.ordering` binds each claimed terminal-before-reply comparison to the exact
normal Worker lifetime, transaction, operation and incoming RPC ID. Corrupt-state
replay, held mutations/receive, late recovery and dropped-reply recovery explicitly
check native terminal ordinal < observed reply ordinal. A deliberately suppressed
reply compares against its actual production before the drop, not delivery. The
predispatch retained-facade rejection has no transaction: its evidence instead
requires no new write start. Other mutations do not inherit a global ordering
claim from aggregate strict-transaction counts.

## Launch only after coordinator readiness

Coordinator must supply/review the frozen S/W/D/H/P+uncertainty assembly and
current actual generated WASM/build.json, then authorize a concrete load turn.
Native phone17 currently owns the heavy slot. No launch has occurred here.
The runner never builds or installs dependencies and requires existing Vite.

From that exact composed checkout, replace both arguments with real values:

```sh
node tests/browser-workblocks-worker/run.mjs --expect-head FULL_40_HEX_COMMIT --runtime-authorized --out tests/browser-workblocks-worker/artifacts/OWNED_RUN_ID
```

`--runtime-authorized` records operator intent; it cannot grant coordinator
approval. Default campaign deadline is 180 seconds, configurable only up to 300
seconds. Rust source fingerprint, glue/WASM hashes and TS/harness digest must match
before and after the run. Evidence stays under the persistent output path.
Temporary Chrome profile is used only for owned browser isolation and removed
once its owned child confirms exit. Fixture cleanup closes normal runtimes and
deletes only uniquely named owned DBs; runner closes its Chrome child/Vite server
and retains cleanup failures in final `report.json`. `cleanup.json` and the
embedded report cleanup retain the exact owned Chrome PID, native spawn/exit
code/signal events, kill attempts, profile path and confirmed ENOENT after removal,
and Vite close resolution/listener state/address. CDP records only a close request.
Failure in any cleanup branch does not skip the other owned resources, and an
unconfirmed child exit retains its profile and fails the run. Auxiliary artifact
write failures are retained separately without erasing the original runner error.
It prints success only after cleanup succeeds.

## Unverified details and deliberately omitted claims

All 12 groups and their strict IDB terminal/event ordering remain unexecuted.
Uncertainty correction source `8391fb86` has only Node/source evidence so far.
Native `window limit65 -> limit` remains the assertion. Read-only composed
source `2834c783dc0bcd69fe0051fd8112f81a9cf6eb6a` now keeps transport checks primitive
and delegates this budget rejection to Rust, resolving the older P source mismatch;
actual generated-WASM behavior still needs runtime proof. H/P startup must use the
supported lifecycle above; never bypass it with a synthetic registry.

The campaign is intentionally bounded rather than exhaustive. An eventual
passing run reports only `passed-subset`, with actual evidence and limitations.
The unrelated-family cursor case does not exercise a second managed collection,
and the 1MiB requested budget is not saturated. No HTTP2/gRPC/protobuf, rendered Calendar UI, native/mobile or full browser-matrix
claim follows. All actual gate2/3 outcomes remain unknown until that run.

## Source checks

```sh
node --test tests/browser-workblocks-worker/assertions.test.mjs tests/browser-workblocks-worker/observation-transform.test.mjs tests/browser-workblocks-worker/cleanup.test.mjs
node --check tests/browser-workblocks-worker/fixture.mjs
node --check tests/browser-workblocks-worker/run.mjs
node --check tests/browser-workblocks-worker/worker-observer.mjs
node --check tests/browser-workblocks-worker/observation-client.mjs
```

Eleven Node cases validate evidence rejection, exact-transform integrity and
cleanup helper behavior. One bounded Node child exercises PID/exit/profile cleanup;
the Vite close interface is a unit double, never an actual Vite launch. They provide
no actual Chrome/product Worker/WASM/IDB/encryption runtime proof.
