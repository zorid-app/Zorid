# Actual browser/WASM Bases run008 — 2026-10-22

**All nine original integration groups passed.** The first of ten Q3 groups
stopped at an intentionally omitted empty overall summaries map. The failing Q3
group is not accepted, and the remaining nine groups were unexecuted. This is a
failed 19-group campaign, with unchanged runtime and source proofs.

## Execution and provenance

```sh
node tests/bases-browser-integration/run.mjs \
  --expect-head 375747224ba3a15d1fc363bb9fd5ad817647fc8e \
  --runtime-authorized \
  --wasm-dir /Users/ctk/Projects/Zorid/.worktrees/types-bases-model/target/browser-wasm/generated \
  --out /private/tmp/zorid-bases-browser-actual-20261022-008
```

Root: `/Users/ctk/Projects/Zorid/.worktrees/types-bases-model`. Session 36836
exited 1. The normal admitted service, product Worker, generated WASM and actual
IndexedDB were used. The 180,000 ms deadline and all assertions remained enabled;
no build or product mutation occurred during the run.

| Proof | Exact value |
| --- | --- |
| Frozen HEAD | `375747224ba3a15d1fc363bb9fd5ad817647fc8e` |
| Rust crates tree | `958b19aca4666414e956fbb2f406558af5a18366` |
| WASM input fingerprint | `36809d020fb8c1ad52736417717d9b1418b866547f99d62cf347bfbee6250e9b` |
| Generated JS SHA-256 | `81c4a5c09ada24257106eaadeaafb46032ec0de7a947f7bee0d2352ed0e6a0c1` |
| Generated WASM SHA-256 | `79563768b5c7c5795bba32daecd67c048e2b882882784251f84c84c59bd6dd37` |
| Source digest | `6b5df6361de1a0890c6a240b9a202b02ab0ce682de6d29b995929fac410fa6e7` |
| Raw report SHA-256 | `6a1a7f48346eae78f0b14f7d94c07d5e4f67ff1f048513f50e58ca963e7840b8` |

Raw `report.json`, failure screenshot, browser/CDP/stderr records, `cleanup.json`
and `post-run-verification.json` remain under that output directory. Independent
post-run hashing confirms the exact HEAD, Rust fingerprint, generated assets and
source digest stayed unchanged.

## Result and narrow harness correction

Groups 0–8 passed, including the stronger witness-bound exact 30-diagnostic
malformed-rollup assertion introduced after [capture007](bases-browser-actual-007-20261022.md).
The same group also passed exact source restoration, retained healthy pin
isolation, healthy aggregate/eligibility checks, close and real restart.

Group 9, `Q3 Object callbacks preserve exact keys, typed values and outer scope`,
failed at `fixture.mjs:127` with `Q3 exact overall summaries: {"expected":{}}`.
The actual field was absent; the error formatter omits an undefined value.
Membership and typed row comparisons precede this assertion, but that partial
execution does not accept the group or the complete 133-value/16-diagnostic Q3
campaign. The report did not retain the full failing Q3 result; a latest-result
checkpoint is added for the next run without accumulating query payloads.

The shared DTO deliberately omits empty `BaseQueryResult.summaries` via
`#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]` in
`crates/zorid-bases/src/query.rs`. The TS field is optional in
`src/core/document-semantics.ts`; `src/bases/shared-query.ts` preserves omission.
The existing CLI Q3 oracle already defaults missing empty summary maps. This
establishes an incorrect browser harness presence assumption, not evidence of a
lost nonempty aggregate.

The tests-only correction defaults `undefined` to `{}` only when the independently
authored expected map is empty. Explicit null, arrays, primitives, extra keys,
missing nonempty maps and incorrect numeric/typed results still fail. All group
summaries, row values, diagnostics, counts and grouping assertions remain exact.
Thirteen focused oracle tests plus the previous 20 malformed-rollup oracle tests
pass under Node; this does not replace the required actual Worker/WASM rerun.

## Cleanup and remaining acceptance

The normal Worker GET returned 200; three dedicated targets and six exact asset
GETs were observed. No protocol events were dropped and artifact/cleanup failures
were empty. Owned Chrome PID 58784 exited 0, its profile absence was confirmed
with `ENOENT`, and owned Vite port 54991 closed with `httpListeningAfter:false`.
The synthetic database
`zorid-core-vault:bases-browser-a47296e0-d541-48a6-950f-1534169dc325` was deleted.
The runtime slot and source freeze were released after post-run verification.

Run008 does not establish all 19 groups, all Q3 semantic oracles, rendered Bases
UI, native/mobile parity, sync or stress acceptance. A full fresh campaign is
required after the reviewed harness correction.
