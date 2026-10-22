# Actual browser/WASM Bases capture007 — 2026-10-22

**The unchanged old assertion failed again after eight passed groups.** Its new
checkpoint captured the exact malformed-rollup result before the failure. This
confirms a stale filter-code expectation under the published Error-value
contract; it does not establish a complete 19-group pass. All ten Q3 groups and
the later phases of group 8 remain unexecuted.

## Exact execution and provenance

```sh
node tests/bases-browser-integration/run.mjs \
  --expect-head 955f719e8d87e79fae1be346112e74d5f4e1d886 \
  --runtime-authorized \
  --wasm-dir /Users/ctk/Projects/Zorid/.worktrees/types-bases-model/target/browser-wasm/generated \
  --out /private/tmp/zorid-bases-browser-actual-20261022-007
```

The root was `/Users/ctk/Projects/Zorid/.worktrees/types-bases-model`. Process
session 9212 exited 1; the default 180,000 ms deadline and every assertion remained
unchanged. No build, product change, direct evaluator, replacement Worker or
private IndexedDB mutation was introduced for capture. It used the normal
admitted service, product Worker, generated WASM and actual IndexedDB.

| Proof | Exact value |
| --- | --- |
| Frozen HEAD | `955f719e8d87e79fae1be346112e74d5f4e1d886` |
| Rust crates tree | `958b19aca4666414e956fbb2f406558af5a18366` |
| WASM input fingerprint | `36809d020fb8c1ad52736417717d9b1418b866547f99d62cf347bfbee6250e9b` |
| Generated JS SHA-256 | `81c4a5c09ada24257106eaadeaafb46032ec0de7a947f7bee0d2352ed0e6a0c1` |
| Generated WASM SHA-256 | `79563768b5c7c5795bba32daecd67c048e2b882882784251f84c84c59bd6dd37` |
| Source digest | `b86e755190b33ad1d372fb63f44da3654a6336bd06e519f642620deeb116587b` |
| Raw report SHA-256 | `4fac737ef889b338891be7ec4080ad278dca99dfc1e520b62a18ea27e73bd600` |

Raw `report.json`, the failure screenshot, browser/CDP/stderr records,
`cleanup.json` and independently recomputed `post-run-verification.json` remain
under the output directory above. The post-run receipt confirms the exact HEAD,
Rust fingerprint, both generated assets and source digest stayed unchanged.

## Observed payload and diagnosis

The checkpoint in `report.json` is
`evidence.failureCheckpoints[0]`. It binds the result to separately read Ada,
Grace and malformed-note witnesses. It contains exactly 30 diagnostics:

| Count | Phase | Code | Exact message |
| --- | --- | --- | --- |
|2 | filter, one per known author | type | `Cannot convert Error to number` |
|28 | property, two per known file | unavailable | `Rollup relation has invalid or unresolved targets` |

The property diagnostics cover `note.averageRating` and `note.bookCount` over
all 14 known files, including both authors. Author rows are empty,
`metadataComplete:false` and `relationshipsAvailable:true`. The exact
malformed-note entry/revision has `propertiesUnavailable:true` and its
`frontmatter_syntax` extraction diagnostic. Plain Link suggestions and the
saved current-note frame assertions passed before this point.

This matches the independently reviewed source trace described in
[browser006](bases-browser-actual-006-20261022.md): completed non-resource errors
are materialized Error values, so `bookCount >= 1` reports a numeric conversion
error. Underlying unavailable rollup diagnostics remain explicit. Restoring the
old filter code by changing production Error imports would contradict the named
published-Error tests and is not warranted by this result. Temporary relation
filter placeholders, resource/cancellation errors and graph-availability guards
retain their separate contracts.

The tests-only correction requires the complete exact 30-diagnostic multiset,
including phase, independently read entry identity, path, property, code and
message. It also requires the exact 14-file inventory, unique file identities,
original author witnesses, current malformed witness, empty rows and unchanged
coverage flags. It preserves the retained-pin isolation, exact source
restoration, healthy aggregate, eligibility and restart checks later in group 8.

Twenty bounded Node oracle tests pass: the actual captured shape is accepted;
19 mutations reject missing, changed or extra diagnostics, foreign author IDs,
wrong paths/phases/properties, stale author/malformed revisions, absent metadata
availability, fabricated rows, altered coverage and missing/extra/duplicate
manifest identities. The offline test input retains captured diagnostic data;
the offline manifest uses explicit markers for non-actor revisions. Runtime
expectations read all 14 real metadata witnesses independently and never derive
expected identities from result diagnostics. These are oracle tests, not a
successful corrected Worker/WASM campaign. A fresh complete run remains required.

## Cleanup and remaining acceptance

The normal Worker GET returned 200, with two dedicated targets and four exact
asset GETs (two JS, two WASM). No events were dropped or artifact writes failed.
Owned Chrome PID 50507 exited 0; its profile absence was confirmed with `ENOENT`.
Owned Vite port 53546 closed with `httpListeningAfter:false`. The synthetic
`zorid-core-vault:bases-browser-89fe5957-3f4a-4086-addf-a6e2c4dba6ba` database was
deleted. Runner/fixture cleanup failures were empty. The runtime slot and source
freeze were released after post-run verification.

Browser 006 and 007 remain failed historical runs. Their eight passed groups do
not accept the rest of group 8, the 19-group campaign, 133 Q3 typed row values,
16 Q3 diagnostics, rendered Bases UI, native/mobile, sync or stress behavior.
