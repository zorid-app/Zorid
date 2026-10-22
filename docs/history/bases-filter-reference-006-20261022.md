# Actual Obsidian typed-filter reference006 — 2026-10-22

**Seven phases passed; the eighth stopped at Date entry.** Ten exact saved-filter
and row-membership checks passed, including String containsAll returning zero
rows. The Date operator catalog was observed and checked, but entering its RHS
did not persist a filter. Five later phases remained unexecuted. This is bounded
reference evidence, not a complete reference campaign or Zorid/native parity.

## Identified target and execution

Retained output: `/private/tmp/zorid-bases-filter-runtime-reference-20261022-006`.
The report records `2026-10-22T18:56:33.166Z` through
`2026-10-22T18:58:30.315Z`; coordinator session 35076 ended 1.
Prepared five-file manifest SHA-256:
`e813269f7e9e031124d8b6054b2b938d53e60750c6ebd31c1e32bfa7efac7004`.

The owned target title identified Obsidian **1.14.4**, and `loaded-app-1.log`
records loading the profile's updated `obsidian-1.14.4.asar`. Its retained
archive identity is SHA-256
`146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`;
the app.js reference baseline is
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
The launcher shell reports Chrome 126.0.6478.234 / Electron 31.6.0; its UA retains
`obsidian/1.7.4`. The updated application package and launcher versions are
distinct and are not silently equated.

## Completed observations

The passed phase entries are baseline, String catalog, String prefix/inverse,
String variadic, List catalog/equality, List member/variadic, and Boolean
catalog/checkbox. Captured catalogs preserve exact operator labels/order:
14 String operators, ten List operators and Boolean `is` / `is not`.
List equality was reopened through the normal filter UI as well.

| Exact authored expression accepted by the reference | Observed matching notes |
| --- | --- |
| `tf_text.startsWith("alpha")` | Alpha |
| `!tf_text.startsWith("alpha")` | Beta, Gamma |
| `tf_text.containsAny("alpha", "beta")` | Alpha, Beta |
| `tf_text.containsAll("alpha", "beta")` | No rows |
| `tf_labels == ["alpha","beta"]` | Alpha |
| `tf_labels.contains("beta")` | Alpha, Beta |
| `tf_labels.containsAny("alpha", "beta")` | Alpha, Beta |
| `tf_labels.containsAll("alpha", "beta")` | Alpha |
| `tf_flag == true` | Alpha |
| `tf_flag == false` | Beta, Gamma |

Each of these ten journal entries retains the exact saved Base source and paths
under `TypedFilterCases/`. Empty membership is a positive exact assertion;
it is not skipped or inferred from a screenshot. The Boolean operand was a real
checkbox, with its true state and subsequent unchecked false state observed.

The input journal records **339 Input requests**: 237 mouse dispatches, 74 key
dispatches and 28 text insertions. All 13 admitted literal routes used Shift+Enter.
The alternative closed-suggestion Tab route was not exercised. Source-read
diagnostics record 1,259 samples and zero invalid samples. This does not reproduce
or establish the cause of 005's unrecorded null/invalid source sample.

## Date stopping point and unexecuted phases

Within failed `date-catalog-and-equality`, the eight operator labels/order match
exactly: `on`, `not on`, `before`, `on or before`, `after`, `on or after`,
`is empty`, `is not empty`. This catalog subcheck is positive evidence, not an
eighth passed phase or successful Date equality input.

The retained recipe used bulk `Input.insertText` with `2026-10-23`, then Enter.
It timed out at `Deadline: durable exact filter 17-date-on`. Failure DOM shows
the filter RHS as `input[type=date]` with empty value; saved Base source retains
the baseline filters with no Date rule. The failed 2048×1600 capture is diagnostic
evidence of that state. This establishes failure of that input recipe; it does
not demonstrate the reference's Date comparison semantics or a Zorid defect.

Date ordering, DateTime catalog/control, empty/no-operand predicates, required
Number catalog/control and restart remain explicitly unexecuted. Typed007 is
separately prepared source with a revised native keyboard recipe under review;
there is no 007 runtime result in this record.

## Evidence and restoration

| Retained file in the 006 output directory | SHA-256 |
| --- | --- |
| `result.json` | `d4d72d2b3026409389d344af513a521a78c9d6b4d78fa0a541773360b2d49b91` |
| `cleanup.json` | `c4f43bd33eb2da7d9b778d0c1665d46c9b7d433ecf2c16a12730d010207b4327` |
| `input-journal.jsonl` | `0e2790c4987898c2ca5599be2c43ab13c6e21a563743bf5618b5ee4aa665587f` |
| `source-read-counts.json` | `3b617e0985ae04f7d02d9188e74f2c1016b5776d2bab6d8ecfca9b0de712ccc4` |
| `16-date-operators.json` | `bcaf8bfb9c20477254d1f7988201e01f6bfaacc4a6541fad09365d4f3ca6f172` |
| `FIRST_FAILURE_DOM.png` | `e9fe5562f1f8d832cf60856a5d471d7801b1fc75252b457715c4af3a8fa9c4da` |

Cleanup records SIGTERM of exact owned PID 27844, empty remaining-owned and
remaining-family arrays, and unchanged archive. All 18 prior vault files and
three profile configurations were restored; four owned typed-fixture files were
removed. The original 51-capture catalog and its PNGs remained unchanged. All 41
hashed prior 005 evidence files remain unchanged; 005 was not overwritten or
relabeled as successful. Cleanup restoration is separate from the unexecuted
scenario-level restart phase.

The disposable vault/profile can be reused by later reference campaigns. These
restoration statements concern the retained 006 cleanup, not an immutable claim
about that shared fixture's later live state.

This audit independently recomputed the listed hashes and phase/journal counts,
matched the five prepared source files and four before/after source hashes,
compared the restored vault/profile hashes during its initial read, all 51
original PNG hashes and all 41
prior 005 evidence hashes. It did not rerun the reference or issue native input.
This task changed only this history file; no app, build or product test ran.
