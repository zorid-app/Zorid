# Actual browser retained-storage baseline

Source tooling only until the coordinator grants a runtime slot and freezes the
application source plus matching generated WASM. This harness builds and installs
nothing. It shares the versioned `workload.mjs` generator and arithmetic literal
oracles with the independent CLI baseline. See
[the baseline specification](../../docs/plans/indexing-search-baseline.md).

```sh
node scripts/indexing-search-baseline/web.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --chrome '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --wasm-dir /absolute/matching/generated-wasm \
  --out /private/tmp/zorid-s1-web-smoke \
  --notes 100 --runs 1 --repeats 1 --timeout-ms 300000 \
  --runtime-authorized
```

The output directory must be absent. It is resolved through ancestor symlinks and
must exclude source, harness and recorded manual playground roots. Chrome uses a
new headless profile inside that output, never a user's profile. Only the exact
spawned child is terminated; no process-name, application-name or port killing is
used. The loopback server and Chrome processes close after the run. The generated
workload, browser profile/IndexedDB and reports remain for inspection. Do not put
real notes or credentials in this fixture profile.

Start with the untimed correctness/smoke run above. Only after it passes, use
`--notes 10000 --runs 5 --repeats 20` for representative samples under a separately
coordinated slot. Each warm run retains twenty repeated rare-query samples. The
100,000-note stress fixture is a separate one-run limit observation; current
browser record/header/projection ceilings prevent complete coverage. A rejection
or deadline stays failed with its observed code/progress, never a successful
prefix or full-vault latency. No throughput/latency acceptance budget is selected.

## Actual execution boundary

A fixture page imports the frozen production `BrowserCoreRuntime`, admission and
default adapter. They create the unchanged dedicated product Worker, load the
real generated Rust/WASM and use actual IndexedDB. No parser, worker, index,
mutation service, clock or result is mocked. The page runs through Vite development
transforms; this is not production-bundle startup or complete workspace rendering.
The named engine is the supplied Chrome executable, recorded with hash and actual
CDP browser/JavaScript version. This establishes no other-browser parity.

Each run uses one new database and performs these phases at a stable exact origin:

1. **Import/setup:** generate the exact workload separately, then author its
   folders and every manifest file through the admitted normal adapter. Read back
   each file through the real Worker and compare exact bytes/digest. Retain logical
   ID → actual physical ID/revision/presentation mapping. Synthetic fixture times
   are kept as expectations; authority presentation is recorded without overwrite.
   Import/setup timing is separate from index timing. No derived generation exists.
2. **Derived-cold:** release and close the browser, then restart the same profile
   and origin with the committed authority intact. Start from no derived snapshot;
   pump the real index to publication. Record returned progress, reused counts and
   coverage. Query every frozen literal with complete pagination, comparing all
   ordered IDs, revisions, byte/UTF-16 ranges and line numbers to the independent
   generator oracle. Full count/digest and first/last witnesses are retained.
3. **Warm reopen:** release/restart Chrome again with the same profile, origin,
   source and cache. Require the same current snapshot before querying. Record
   startup/status/pin-open and first-query timings separately, then repeated rare
   queries on one pinned generation. No new index pump is accepted as a warm hit.
4. **Independent commit:** while the original client is released, another admitted
   client changes note zero through the ordinary compare-and-write adapter using
   its exact ID/revision/content witness. Verify exact committed bytes and retain
   the changed revision. This is a local committed route, not simulated sync.
5. **Incremental catch-up:** restart the original client, require stale index status
   and the independent commit witness, then publish/query the changed source.
   Preserve all original literal results and require the added marker at its exact
   independently computed range. This measures missed-change catch-up at reopen.

Every pin, stage and client receives an explicit release attempt. A release failure
fails the phase; terminating Chrome afterward is cleanup and cannot satisfy it.
Pending source/receipts are never deleted to manufacture a derived-cold state.

## Evidence and limits

`report.json` includes every sample with median/range, source/generator/harness and
WASM SHA-256 witnesses, build fingerprint, engine/version, exact origin/profile,
OS/hardware/load facts, storage estimates, phase status/progress and child cleanup.
Per-phase reports/screenshots and the complete independent `oracles.json` remain
beside the generated fixture manifest. All frozen source/artifact hashes must
match after execution. WASM is the release artifact selected by the fingerprinted
build script; the build manifest does not record the compiler version, so that
field is null rather than inferred from an installed compiler.

Worker-open timing includes its actual startup/WASM/IDB/admission recovery, without
claiming those subphase counters. A retained sample read is an end-to-end RPC,
not pure message overhead. Returned pump `reused` is the observable host counter;
no parser invocation or cache-hit count is invented. Unsupported queue wait,
transfer bytes, Worker CPU and peak process memory remain null. Chrome page JS
heap and origin storage estimates are labeled with their actual scopes; they are
not Worker/process memory or exact index byte sizes. Resource timing, when exposed,
is retained without treating hidden Worker transfers as observed page transfers.

Result presentation timing covers the fixture's summary DOM plus a frame, not the
product editor search sidebar or typing responsiveness. Cold means a fresh process
and absent derived state, not a cold OS page cache; no global cache purge occurs.
This subset does not implement eviction/corruption, cancellation, foreground
contention, browser extraction parallelism, sync-group login, mobile or Safari/
Firefox verification. It does not satisfy the complete S1.0 campaign alone.
