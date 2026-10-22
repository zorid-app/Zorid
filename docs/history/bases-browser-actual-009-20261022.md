# Actual browser/WASM Bases run009 — 2026-10-22

**All 19 planned semantic integration groups passed**, including all 133 authored
Q3 typed row-value checks and 16 exact Q3 diagnostics. This verifies the normal
browser service/Worker/WASM/IndexedDB path under this fixture. It does not establish
rendered Bases UI, native/mobile, other-browser, sync or stress acceptance.

## Exact execution and provenance

```sh
node tests/bases-browser-integration/run.mjs \
  --expect-head caec33ecb9752979922ae008ab3caffd37194669 \
  --runtime-authorized \
  --wasm-dir /Users/ctk/Projects/Zorid/.worktrees/types-bases-model/target/browser-wasm/generated \
  --out /private/tmp/zorid-bases-browser-actual-20261022-009
```

The root was `/Users/ctk/Projects/Zorid/.worktrees/types-bases-model`. Session
57532 exited 0. The default 180,000 ms deadline, exact planned group-name list,
all typed/numeric/group/diagnostic assertions and source/artifact guards remained
enabled. No build, product mutation, direct evaluator, replacement Worker or
private IndexedDB write was used. The tests-only correction following
[run008](bases-browser-actual-008-20261022.md) accepts an omitted overall map only
when the independently authored expected summaries map is empty.

| Proof | Exact value |
| --- | --- |
| Frozen HEAD | `caec33ecb9752979922ae008ab3caffd37194669` |
| Rust crates tree | `958b19aca4666414e956fbb2f406558af5a18366` |
| WASM input fingerprint | `36809d020fb8c1ad52736417717d9b1418b866547f99d62cf347bfbee6250e9b` |
| Generated JS SHA-256 | `81c4a5c09ada24257106eaadeaafb46032ec0de7a947f7bee0d2352ed0e6a0c1` |
| Generated WASM SHA-256 | `79563768b5c7c5795bba32daecd67c048e2b882882784251f84c84c59bd6dd37` |
| Source digest | `5d4c3b76c98ef4e0108b3f9acdbfc222e5f2c330d385fc177b13d18c83ac10ef` |
| Raw report SHA-256 | `ee24aebc4ad96028addd7223ea82ce6f2ea83c0e9f4031a60f2cc750d36ad221` |

Raw `report.json`, screenshot, browser/CDP/stderr records, `cleanup.json` and
independently recomputed `post-run-verification.json` remain in that output
directory. Both the runner proof and independent post-run proof confirm the exact
HEAD, Rust fingerprint, generated assets and source digest stayed unchanged.
Failed runs 006–008 and their raw reports remain preserved separately.

## Executed coverage

The first nine groups passed ordinary notes without a property registry;
source-relative and nested cross-file lookup; raw alias/date/nested value editing
and durable CAS; limited-row overall/group summaries and scoped previews; rich
values, seeded randomness, dates/errors; exact fenced source/UTF-8 witness proof;
configured relation targets, reverse relations and rollups; forged settings/source
rejection; retained snapshots, foreign-client rejection, close and real restart.
The malformed-metadata stage requires the exact witness-bound 30-diagnostic
multiset and explicit incomplete metadata before exact restoration and healthy
eligibility/restart assertions.

All ten appended Q3 groups passed:

1. Object callback keys, typed values and outer scope.
2. Tag hierarchy versus generic String/transformed List membership.
3. Registered arity, null/type validation and special-call spelling.
4. String/regex replacement and finite numeric conversion.
5. Recursive flatten and constructor-sensitive uniqueness.
6. Duration components and January overflow with a captured clock.
7. Duration fields/comparison with an explicit February clock.
8. Nested TagList provenance in overall/grouped summaries.
9. Strict Object Link-child provenance in grouping/summaries.
10. Returned summary Error values versus formula namespace rethrows.

The shared authored fixture has 10 groups, 133 typed row-value expectations and
16 diagnostic expectations; those counts were independently recounted from its
source. No group was skipped or left unexecuted. These are bounded, explicit
semantic cases, not an exhaustive claim about every expression or dataset size.

## Worker evidence, cleanup and limits

The normal product Worker script had one GET 200 and two revalidation GETs 304.
Three dedicated Worker targets and six exact generated-asset GETs (three JS,
three WASM) were observed, including restart. There were no dropped protocol
events, runner errors, artifact failures or cleanup failures.

Owned Chrome PID 67075 exited 0 and its owned profile absence was confirmed with
`ENOENT`. Owned Vite port 55741 closed with `httpListeningAfter:false`. The
synthetic database
`zorid-core-vault:bases-browser-33c6d8f7-2e19-4118-a115-c648660a4448` was deleted.
The runtime slot and source freeze were released after post-run verification.

The two explicit remaining gates in the runner are unchanged: rendered table,
property widgets, HTML sanitization and full app UI acceptance; and mobile,
other-browser, sync and stress acceptance. Passing rich-value transport checks
does not establish safe or correct rendered rich-value behavior.
