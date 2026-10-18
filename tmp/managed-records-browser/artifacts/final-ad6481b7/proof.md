# Actual Chrome managed-records subset — final product source

Task `task_eadeb14c7e04`, dispatch `ctx_beb32c3918c8`, owned harness/output only.
Product source includes B config-CAS follow-up assembled at `39880fbe98fffdc6dea50e0085b109354ab0ec7a`.
Owned harness changes were committed before evidence freeze; final tested HEAD is
`ad6481b708073a301b55836b3146882cd96bd73a`.

Command: `node tmp/managed-records-browser/run.mjs --expect-head ad6481b708073a301b55836b3146882cd96bd73a --out tmp/managed-records-browser/artifacts/final-ad6481b7`

Actual terminal session 22166 exited 0. Chrome 155 headless executed the real
streaming opener, Rust/WASM, vault key and IndexedDB. All eight groups passed:

- local i64 extrema and precise f64 survive exact raw state/projection and reopen
- lost local response replays original raw result after later mutation and reopen
- Local and Cache commit and replay without any sync outbox
- real encrypted records/file/text share one ordered cursor chain and never echo receives
- tamper, wrong scope, unknown format and cursor gap leave every store unchanged
- pending child and invalid child persist then bounded parent recovery retries through AEAD
- post-AEAD enrolled epoch rotation rejects fresh duplicate and retained commits without progress
- real strict transaction abort after state put rolls back all stores and survives reopen

The config race wraps the actual real-key method, returning its actual authenticated
capability. After successful Rust AEAD open it queues a real strict sync_state
writer changing only disposable enrolled key_epoch 1 to 2, then immediately queues
an actual all-store readonly snapshot before downstream product transactions.
Fresh receive, duplicate delivery and retained retry each reject sync_snapshot_conflict.
All 31 stores equal the actual AFTER-injection baseline; the baseline differs from
the original snapshot only in that config row. The raw report includes actual config
rows, errors, compared store names and baseline SHA256 for each path. No fake
capability, semantic admission logic, fake transaction or core test hook is used.

The raw report preserves exact UTF-8 state/projection and actual authenticated
Records plaintext containing i64 MAX/MIN and Number 51.248178375505404. Domain
requests/state/projection/plaintext never pass through JSON.parse/stringify;
control/digest metadata and synthetic string commands use ordinary JSON.

Observed strict readwrite events: 69 complete and 8 abort. Abort events include
intentional config-CAS rejections, explicit managed put-success rollback injection,
and authority-close control transactions. Exact all-store rollback/reopen and
fresh retry assertions pass. All seven disposable databases report actual delete
success, with zero blocked notifications on the final pass. Runner returns only
after closing Vite, confirming owned Chrome child exit and removing its fresh
profile; terminal exit0 confirms that cleanup path completed. No user data touched.

## Exact source/artifact witnesses

- HEAD: `ad6481b708073a301b55836b3146882cd96bd73a`
- Rust build fingerprint: `a4027f128c91099071a2744f90a599b9151ee623599f3e4b7c4846283a16e0f8`
- Core/harness source digest: `70460609b2be88f743ef6b2aa934d62986f44eadc370636822d54abd08f52f88`
- zorid_wasm.js: `1145a203bda8c72a6e017e87f0adda6df4b5c9d992d802c56ece864538ffae31`
- zorid_wasm_bg.wasm: `b8e316e2a8d4e8a498c0e8f2d48b844d3b3db4ca51513bbd000674f26283ae2e`

Runner independently recomputed these witnesses before and after execution.
No source/artifact change during the run was accepted. No build, dependency
installation, full suite, Rust/manifest/lock/main edit or product-core edit was
performed by this worker. Harness commits: 75740021, 1ce44050, 24916ce6, ad6481b7.

## Failed attempts retained

- pass-75740021: successful seven-group baseline before B config-CAS follow-up.
- final-1ce44050: failed before config injection because the synthetic Create
  generation differed from its operation ID; corrected only fixture generation.
- final-24916ce6: all eight behavior groups passed, but overall exit1 because the
  fixture immediately rejected an author deleteDatabase blocked notification.
  Updated cleanup to record blocked events and require actual onsuccess within
  five seconds; no blocked event counts as deletion. Final pass had none.

These raw reports/events/stderr remain separate and are not overwritten. Failure
results are not accepted as overall passing evidence. Artifact SHA256SUMS.json
files accompany each preserved run.

## Scope limits

This is passed-subset browser evidence, not whole Phase1, product UI, worker host,
native, mobile, production enrollment, security-audit or power-loss acceptance.
Remaining gates include complete retry count/byte/continuation boundaries,
conflicting waiting commitments, authored self-echo/received duplicate matrix,
restoration generations, quota/replacement boundaries, signed-i64 sequence ceiling,
cross-tab lease loss/reacquisition and worker lifecycle integration. The direct
actual-key wrapper tests epoch changes; it does not establish full lifecycle or
session-rotation race coverage. The overall goal remains active.
