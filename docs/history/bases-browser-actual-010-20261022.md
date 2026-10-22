# Actual browser/WASM Bases run010 — 2026-10-22

**All 19 planned groups passed**, including all 146 current typed row-value
expectations and 16 exact Q3 diagnostics. This fresh campaign includes the 13 new
literal-percent/raw compact-date cases against the rebuilt date-v8 WASM. It
accepts this fixture's admitted browser service/Worker/WASM/IndexedDB semantics;
rendered UI, native/mobile, other-browser, sync and stress acceptance stay separate.

## Exact execution and provenance

```sh
node tests/bases-browser-integration/run.mjs \
  --expect-head c90d254b63eef0ef8571bba177b327ff04922495 \
  --runtime-authorized \
  --wasm-dir /Users/ctk/Projects/Zorid/.worktrees/types-bases-model/target/browser-wasm/generated \
  --out /private/tmp/zorid-bases-browser-actual-20261022-010
```

Root: `/Users/ctk/Projects/Zorid/.worktrees/types-bases-model`. Session 83570
exited 0. The 180,000 ms deadline, exact 19-name group list, full typed/numeric/
group/diagnostic assertions, source proof and cleanup guards remained enabled.
No build, product mutation, replacement Worker, direct evaluator or private
IndexedDB write was introduced for the campaign.

| Proof | Exact value |
| --- | --- |
| Frozen HEAD | `c90d254b63eef0ef8571bba177b327ff04922495` |
| Rust crates tree | `8074eabf01c55cf4e53f01c02a5a384197875a24` |
| WASM input fingerprint | `6041e8e6354b0a60e7482af8910470d3df24fd33ed47c651a68b6c286abe10ee` |
| Generated JS SHA-256 | `81c4a5c09ada24257106eaadeaafb46032ec0de7a947f7bee0d2352ed0e6a0c1` |
| Generated WASM SHA-256 | `8f9d8d6337ba0c8a8042eb568d9deaa0ea23e4c90b694d5aa4312ff4f2f03d05` |
| Source digest | `106435241fb1a71224fa11ad1a204ed1a5564a92a2b5eb28d52cf5900464af6b` |
| Raw report SHA-256 | `3ec6f382d2909d35f577e7c8ee4a9c99713c0f1063263c45c0587151639f62f1` |

The matching build receipt is
`/private/tmp/zorid-bases-final-wasm-8074eabf/receipt.json`; its build exited 0.
The preserved JS is 204236 bytes and WASM is 12437439 bytes. Build log SHA-256:
`951589cad624489ca444775fd95e6b46ea999837d2b6981660ad962a4a44b1bc`.
The receipt and adjacent post-build input proof bind the generated artifact to
the exact 433 Rust/build inputs. The campaign runner and independent post-run
receipt recomputed that fingerprint and confirmed HEAD, both assets and the
browser/harness source digest remained unchanged.

Raw `report.json`, `fixture-result.png`, browser/CDP/stderr records, `cleanup.json`
and `post-run-verification.json` remain under the output directory above. The
raw report was not rewritten after execution. Historical failed runs 006–008
and the successful earlier [run009](bases-browser-actual-009-20261022.md) remain
separate evidence with their original source/module/count boundaries.

## Actual coverage

The original nine groups passed ordinary files without a property registry,
source-relative/nested File lookup, raw source-preserving edits and durable CAS,
overall/group summaries and scoped previews, rich typed values and seeded/date
behavior, fenced-source witness proof, configured/reverse relations and rollups,
forged-source rejection, retained pins, foreign-client guards, close and restart.
The exact malformed-metadata stage still requires all 30 witness-bound
diagnostics and explicit incomplete metadata before exact restoration and healthy
eligibility/restart checks.

The ten Q3 groups passed Object callbacks, Tag hierarchy, exact call contracts,
String/regex/number behavior, recursive flatten and strict uniqueness, two
captured Duration clocks, nested TagList/Link provenance through grouping and
summaries, and returned summary Error data versus formula namespace rethrows.

The same groups now include 13 additional authored expectations: five percent
format cases require literal `%`, bracket escaping and following Moment tokens
rather than strftime; eight extrema cases reject raw compact 8/12-digit dates,
reject corresponding rich String payloads, preserve hyphenated mixed controls,
and retain explicitly constructed compact Date values. Source recount is
146 typed expectations and 16 diagnostic expectations across 10 Q3 groups;
every group completed, with no skipped or unexecuted group.

## Worker proof, cleanup and limits

The normal product Worker script had one GET 200 and two revalidation GETs 304.
Three dedicated Worker targets and six exact asset GETs (three generated JS,
three generated WASM) were observed, including restart. There were no dropped
protocol events, runner errors, artifact failures or cleanup failures.

Owned Chrome PID 29298 exited 0. Its owned profile absence was confirmed with
`ENOENT`. Owned Vite port 59857 closed with `httpListeningAfter:false`. The
synthetic database
`zorid-core-vault:bases-browser-09810ee9-0210-4a86-b21c-87459fc4e855` was deleted.
The runtime slot and source freeze were released after independent postproof.

The two explicit remaining runner gates remain unchanged: rendered table,
property widgets, HTML sanitization and full app UI; mobile, other browsers,
sync and stress. Rich-value transport acceptance does not establish rendered
HTML safety or visual equivalence. Main integration and desktop GUI acceptance
also require their own evidence. [CLI007](bases-cli-actual-007-20261022.md) covers
146 typed expectations through the separate matching standalone CLI path.
