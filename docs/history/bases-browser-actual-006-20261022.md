# Actual browser/WASM Bases campaign006 — 2026-10-22

**Failed after eight passed groups.** Group 8 stopped at the malformed-metadata
rollup diagnostic assertion. All ten appended Q3 groups were unexecuted; the
133 typed row-value oracles and 16 Q3 diagnostics have no acceptance from this
run. The failed result and all assertions are preserved.

## Exact source and artifacts

Frozen source: `099d94edbbfbee7e79160872d1a62bb55e7601a5`, worktree
`/Users/ctk/Projects/Zorid/.worktrees/types-bases-model`.
Rust crates tree: `958b19aca4666414e956fbb2f406558af5a18366`.
The exact command was:

```sh
node tests/bases-browser-integration/run.mjs \
  --expect-head 099d94edbbfbee7e79160872d1a62bb55e7601a5 \
  --runtime-authorized \
  --wasm-dir /Users/ctk/Projects/Zorid/.worktrees/types-bases-model/target/browser-wasm/generated \
  --out /private/tmp/zorid-bases-browser-actual-20261022-006
```

The default deadline remained 180,000 ms. Process session 36291 exited 1. Results
came through the normal admitted BrowserCoreRuntime, product Worker, generated
Rust/WASM and actual IndexedDB. No build, detached evaluator, replacement Worker
or private storage mutation was used.

| Proof | Exact value |
| --- | --- |
| WASM input fingerprint, 433 Rust/build inputs | `36809d020fb8c1ad52736417717d9b1418b866547f99d62cf347bfbee6250e9b` |
| Generated JS, 204,236 bytes | `81c4a5c09ada24257106eaadeaafb46032ec0de7a947f7bee0d2352ed0e6a0c1` |
| Generated WASM, 12,437,509 bytes | `79563768b5c7c5795bba32daecd67c048e2b882882784251f84c84c59bd6dd37` |
| Source digest, 247 TS/harness/config inputs | `09180346e5529beed11846db7d5bd4508296757a9c252cdc483222f04213b65a` |
| Raw report SHA-256 | `81ec51ba1829ca819f0da6ae7dbaa66d58c82d886fb88fd57e4ca4cde5e299b8` |

The matching build receipt is
`/private/tmp/zorid-bases-final-wasm-958b19ac/receipt.json`.
The output directory contains `report.json`, `fixture-failure.png`,
`browser.json`, `cdp-events.json`, `chrome-stderr.log`, `cleanup.json` and
`post-run-verification.json`. The independent post-run receipt confirms HEAD,
Rust fingerprint, both asset hashes and source digest stayed identical after
failure. The screenshot shows the semantic proof page, not rendered Bases UI.

## Observed execution and cleanup

| Group indices | Result |
| --- | --- |
|0–7 | Passed: ordinary inference, raw edits/CAS, summaries, group previews, rich/seed/date/error values, fenced source/context proof, optional relations/rollups and settings source proof. |
|8 | Failed in the temporary malformed-metadata stage. Later restoration, retained-frame comparisons, eligibility changes and final restart assertions in this group were not completed. |
|9–18 | All ten Q3 groups unexecuted. |

The normal Worker script returned 200; a second request returned 304. CDP saw
two dedicated Worker targets. Exact generated JS and WASM assets were fetched
twice each. No CDP events were dropped and no artifact-write failure occurred.
This is partial actual browser/WASM evidence, not complete 19-group, rendered UI,
native, mobile, sync or stress acceptance.

Owned Chrome PID 32183 exited 0 with a captured exit event. Its disposable profile
was absent with `ENOENT`; owned Vite port 50994 closed with
`httpListeningAfter:false`. The synthetic database
`zorid-core-vault:bases-browser-5ea56ed1-d7cb-4c48-87a2-23c397568ddc` was deleted.
Runner and fixture cleanup recorded no failures. The runtime slot and source
freeze were released after independent post-run verification.

## First failure and bounded diagnosis

The unchanged `fixture.mjs:362` assertion required an author-specific
`phase:"filter", code:"unavailable"` diagnostic. It failed with:

> Incomplete reverse rollup must expose an unavailable author-filter diagnostic

Earlier stage assertions passed: the malformed note's exact witness carried
`propertiesUnavailable`, plain Link suggestions and saved current-note values
retained expected identities, and author rows were empty. This failure does not
show fabricated aggregate rows or missing metadata-availability flags.

Browser 005 passed the same stage on its older source. Its retained result had
30 diagnostics: two author filter diagnostics with code `unavailable`, plus 28
property diagnostics for `note.bookCount` and `note.averageRating` over 14 known
files. Its `metadataComplete` was false and `relationshipsAvailable` was true. Those
are historical results, not the current diagnostic payload.

Read-only tracing identifies a likely stale oracle under the newer published
Error-value contract. `relations::attachment_value` intentionally imports
completed non-resource errors as materialized `ErrorValue`; the named
`published_error_values_are_data_even_when_their_code_is_unavailable` test pins
that boundary. In `bookCount >= 1`, current numeric comparison rejects that Error
with `Cannot convert Error to number`, recorded as a filter diagnostic with
code `type`. Separate sealed rollup property diagnostics retain code `unavailable`
and are appended independently of row inclusion. Temporary target-filter
placeholders remain thrown diagnostics, and budget/cancellation remain fatal.
Changing those production contracts to recover the old assertion is unwarranted
by this failure.

This source-backed diagnosis was independently corroborated by
`bases_duration_review`. Browser 006 threw before the group action returned, so
its local incomplete result was not retained. Its exact actual diagnostic
payload must be captured before correcting the oracle. A tests-only follow-up
captures that result and actor/malformed-note witnesses immediately before the
unchanged assertions. Missing/changed/extra diagnostic rejection and a fresh
complete actual campaign remain required after any reviewed oracle correction.
No production fix or successful rerun is claimed here.
