# Actual browser/WASM Bases semantic integration

Actual run011 **passed all 19 semantic integration groups**, including all 162
Q3 typed expectations and 16 exact diagnostics, on frozen
`4025d6c89e178b8241fa420e83eb1b5402b7a0dd`, Rust tree `dbfc9221`. It used the
normal admitted service, product Worker, rebuilt v9 WASM and real IndexedDB.
All groups completed, exact source/artifact guards passed, no events were dropped,
and owned Chrome/profile/Vite/database cleanup succeeded. Independent frozen-Git
and preserved-asset audit agrees. See [011 evidence](../../docs/history/bases-browser-actual-011-20261022.md).
Rendered UI/widgets/sanitization, native/mobile, other-browser, sync, stress and
later native C1 fix `12869443` acceptance remain separate.

[Run010](../../docs/history/bases-browser-actual-010-20261022.md) passed all 19
groups and its then-current 146 typed expectations on the earlier Rust8074
module. Run011 adds the 16 Date/String comparison and existing-null-guard cases;
its pass does not relabel historical counts or failed runs.

[Run009](../../docs/history/bases-browser-actual-009-20261022.md) passed all 19
groups and its then-current 133 typed expectations on the earlier Rust958 module.
It remains historical evidence; run010 covers the 13 additional date cases with
the rebuilt Rust8074 module.

[Run008](../../docs/history/bases-browser-actual-008-20261022.md) passed the nine
original groups before a tests-only empty-summary-presence assumption stopped
the first Q3 group. The correction accepts omission only against an authored
empty map; 13 oracle tests preserve missing populated/null/wrong-type rejection,
and the 20 exact malformed-rollup oracle tests remain passing.

Historical [006 evidence](../../docs/history/bases-browser-actual-006-20261022.md)
and [007 capture](../../docs/history/bases-browser-actual-007-20261022.md) preserve
the earlier stale filter-code assertion and its exact captured diagnosis. Their
raw reports and cleanup/source proofs remain unchanged.

Actual run005 **passed all nine then-current semantic integration groups**, including
plain Link alias/date-filename/URL values, all-note suggestions, the temporary
unreadable-metadata stage, exact restoration and retained healthy snapshots, on
frozen `055e985f3534af44b8fef1daafe40e372aa127cd`. Report and screenshot:
`/private/tmp/zorid-bases-browser-actual-20261022-005/`. The exact WASM input
fingerprint was
`02483212138450e2c85cce4a70d69cef769457a716af701316289e2758e048d8`.
The normal Worker GET200, three dedicated targets and exact JS/WASM GETs were
observed. Pre/post source and artifact proofs matched; no groups were skipped,
no protocol events dropped, and runner/artifact/cleanup failures were absent.
Chrome exited0, its profile was removed, Vite closed and the synthetic database
was deleted. Rendered UI, other browsers, mobile, sync and stress acceptance
remain separate.

## Executed Q3 extension

Source batch `64bee169` → `19ae330c`, composed at `eb6e0346`, appends **ten
new groups to the original nine: 19 browser groups**. All ten passed in run009, run010 and run011.
The historical run005 result above remains nine executed groups; it does not
cover this extension.

The shared [Q3 fixture](../fixtures/bases-q3-semantics.mjs) adds 14 inert source
files (four Markdown notes and ten saved Bases), with 162 current typed row-value
oracles and 16 expected diagnostic entries. All these assertions executed
successfully in run011 (146 earlier expectations in run010, 133 in run009). The counts describe fixture assertions, not additional
groups. The ten appended groups cover:

1. Object callback keys, values and outer scope.
2. Tag hierarchy versus generic String/transformed List membership.
3. Registered arity, null/type rules and exact special-call spelling.
4. String/regex replacement and finite numeric conversions.
5. Recursive flatten and strict constructor-aware uniqueness.
6. Duration components and January 31 overflow under a captured clock.
7. Duration fields/comparison under a separate February 1 clock.
8. Nested TagList provenance in overall/grouped summaries.
9. Strict Object Link-child provenance in grouping/summaries.
10. Returned summary Error data versus formula-namespace rethrows.

The G9–G15 follow-up appends 35 explicit row-value expectations to
those same groups. It retains every original Q3 expectation and adds no files,
groups or runtime commands. It covers malformed regexes in dead branches versus
a valid lazy branch; recursive Object display strings and unchanged typed Object
transport; configured relation raw-string coercion alongside canonical file
lookup; File folder normalization and repeated-tag-prefix rejection; literal-space
title boundaries; rich String raw-date selection; and natural, stable List sorting.
The inert `__proto__` Object key is deliberately preserved as user data. Sort
expectations use Zorid's pinned English base-sensitivity/numeric policy, not an
assertion of identical ordering in every host locale. These expectations passed
against the matching run009 artifacts.

The provenance group additionally distinguishes ordinary inferred Link raw public
path `/Q3/Source` from its canonical `Q3/Source.md` target witness and `.asFile()`
lookup. Six explicit row expectations cover raw string conversion/prefix behavior
and canonical File lookup for both source notes. Strict Object grouping still
requires two distinct group identities and an overall unique count of two. These
expectations also passed in run009.

The G16/G17 follow-up adds 13 expectations within the same groups: literal `%`,
`[%]`, `%YYYY`, `%Y` and Moment-token behavior after `%`; raw 8/12-digit compact
dates are skipped by extrema, while hyphenated controls and explicit compact
`date()` values remain eligible. All 13 passed in run010 against the rebuilt
WASM. The group/file/diagnostic counts are unchanged.

The G18 follow-up adds 16 Date/String relational and existing-null-guard
expectations inside the same groups. Left Date parses quoted/raw date strings;
invalid and reversed String/Date cases preserve numeric fallback behavior. Null
cases pin the existing guard, not a new null semantic. All 16 passed in run011
against the rebuilt WASM; group/file/diagnostic counts remain unchanged.

The runner requires the exact planned group-name list and all 19 passed results;
no skipped or unexecuted group can produce success. Shared fixture bytes join the
source fingerprint. Authored-data/syntax/oracle checks are source verification,
not actual Worker/WASM, native, CLI or rendered UI acceptance. Run011 supplies
the matching Worker/WASM result for its pinned source; the separate
UI/platform/stress gates above remain open.

Earlier actual run003 **passed all nine then-current groups** on frozen
`6808bf5ef48c099c9ebf3ad1877a12332dc0f902`. The report and screenshot are in
`/private/tmp/zorid-bases-browser-actual-20261022-003/`. Product Worker script
GET200, three dedicated Worker targets and exact generated JS/WASM GETs were
observed, including real restart. The complete source/artifact fingerprints
matched before and after execution. No groups were skipped, protocol events
were not dropped, and no runner, artifact or cleanup failures occurred. Owned
Chrome exited0, its profile was removed, Vite closed and the synthetic database
was deleted. This establishes this fixture's Worker/WASM/IndexedDB semantics;
rendered UI, other browsers, mobile, sync and stress acceptance remain separate.

Historical attempts: actual run001 on frozen
`36d47701709341368d15c016ecf6578804fff00a` passed the ordinary-note group, then
stopped on a fixture assumption that every unchanged property appears in
`editValues`. That map carries raw overrides; otherwise editing falls back to
`values`. The fixture now preserves exact raw oracles through that documented
fallback. The partial report is
`/private/tmp/zorid-bases-browser-actual-20261022-001/report.json`; Chrome, Vite,
the owned profile and synthetic database were cleaned up. No other group or
full campaign acceptance follows from that run. A fresh matching build/runtime
grant is required for the next run.

Actual run002 on `9d086a97b9f7fb16c3dc54452c16914ae5918c18` passed groups0–4,
then stopped because the fenced fixture supplied a body-only span and raw CRLF
source. The contract requires the complete fence span and CommonMark-normalized
source. The corrected hand-authored oracle is checked against the actual UI
`inlineBaseRequest` producer before the core read; forged source, actor and span
rejections remain. Partial report and failure screenshot are in
`/private/tmp/zorid-bases-browser-actual-20261022-002/`. Worker GET200, exact WASM
GETs and clean owned-resource/database teardown were observed. Groups5–8 were
unaccepted until the successful run003 above.

The fixture uses the normal `BrowserCoreRuntime`, admitted client,
`defaultBrowserAdapter.documentSemantics`, unchanged product Worker, generated
Rust/WASM and actual IndexedDB. Notes, folders, attachments and edits go through
public admitted adapter commands. It neither calls a detached evaluator nor
constructs an index generation, modifies an IDB store, substitutes a Worker,
injects a registry, or supplies expected results to product code.

The original nine independently authored groups cover:

1. Ordinary notes **without Properties.yaml**: source-relative wikilinks,
   recursive list/object links, cross-file `.asFile`, URLs, dates, missing values
   and file/link summaries retaining original target identities.
2. Exact raw edit-value transport and TypeScript projection, CRLF/Unicode body,
   wiki alias/quote/comment retention, durable compare-and-write and stale CAS
   refusal. This uses the product property transformation and admitted save;
   it does not claim mounted NoteBuffer/widget or undo interaction acceptance.
3. Overall and group summaries over final sorted/limited rows, rather than all
   matches or mounted DOM rows.
4. Overall versus selected-group summary previews and stale group rejection.
5. HTML/image/icon/recursive link-label values; fixed-seed repeatability and seed
   changes; explicit-timezone Moment formatting; missing files and explicit
   unsupported-regex/unknown-function/cycle diagnostics. HTML remains inert data;
   this fixture does not mount or claim a renderer sanitization test.
6. Saved fenced configuration with UTF-8 byte spans around Unicode/CRLF and `this`
   context, rejecting forged source, invalid spans and wrong contextual identity.
7. Optional property settings: filtered relation target choices, reverse
   relations, counts, averages and formulas/filtering over derived values.
   Configured plain Link properties offer every Markdown note, including a note
   with invalid metadata, while filtered relations keep their own candidates.
   Existing aliases, a date-shaped filename and a manual external URL retain
   exact raw baselines and typed saved-target identities/revisions.
   Current-note relation frames must carry the exact actor revision, raw alias
   baseline and typed resolved target, while no-current requests omit the field.
8. Exact saved settings source/witness proof for Base reads and ordinary-note
   property target reads, plus invalid option rejection.
9. Retained old pins after edits/settings creation, foreign-client denial,
   explicit close, real Worker/IDB restart and exact durable source readback.
   An independent target eligibility change removes it from picker candidates
   while retaining the existing saved link display. A subsequent current-note
   edit to an unresolved alias remains raw and unresolved; the old pin keeps its
   original actor/target witnesses and candidate list. These disposable sources
   are restored exactly through fresh admitted CAS before restart assertions.

Actual run004 passed groups0–5, then correctly reported unavailable reverse
rollups because the added malformed note made incoming-link coverage incomplete.
Its report and failure screenshot are in
`/private/tmp/zorid-bases-browser-actual-20261022-004/`; owned resources and the
synthetic database were cleaned up. The fixture now starts that note valid,
asserts healthy rollups, temporarily saves malformed metadata through admitted
CAS, and checks both identity-only Link suggestions and explicit unavailable
aggregate diagnostics. It proves the retained healthy pin stays exact, restores
the original source through fresh CAS, and requires complete healthy rollups
again before the remaining checks. The corrected plain Link oracles passed in actual run005 above; successful
run003 predates these assertions.

Expected values are hand-authored (`7 + 3 + 5 = 15`; global limit keeps `7, 5`;
Ada has two books with average five). Seed checks assert the public bounded,
repeatable contract rather than deriving an oracle from the PRNG implementation.
Snapshot and file witnesses come from the actual admitted host; they are checked
against returned values, never forged by a source factory. Warm cache work counts
may differ and are not semantic expectations. Differential `editValues` are
combined with typed `values` only for unchanged editable properties; exact
alias/date/nested raw override assertions remain separate.

The runner reuses the existing owned Chrome PID/profile/Vite cleanup helper. It
uses the same two CommonJS aliases as normal Vite startup, without rewriting
product source. It serves the existing generated glue and WASM bytes unchanged
and verifies both SHA-256 digests and the complete Rust input fingerprint before
and after execution. All TypeScript/product fixture sources, the two local CJS
boundaries and dependency/config files are fingerprinted as well. CDP passively
records a dedicated Worker target plus its completed normal script GET URL,
exact WASM asset GETs, browser identity, console/protocol events, fixture
screenshot (including on failure when CDP is available) and cleanup receipts.
The separate HTTP receipt is required because Chromium may announce its Worker
target with an empty URL. The screenshot
shows this semantic proof page, not product UI parity.

A stale artifact or changed source rejects evidence. The runner never compiles,
installs dependencies, repairs generated metadata or manufactures a passing
report. It records partial groups, unexecuted groups and failures honestly.

After the coordinator integrates the harness and grants matching build/runtime:

```sh
# The coordinator owns the serialized build and exact toolchain paths.
# Do not run a second build or browser against another owner's active slot.
node tests/bases-browser-integration/run.mjs \
  --expect-head FULL_40_HEX_FROZEN_COMMIT \
  --runtime-authorized \
  --wasm-dir /absolute/path/to/existing/generated/assets \
  --out /private/tmp/zorid-bases-browser-RUN_ID
```

`--wasm-dir` defaults to `target/browser-wasm/generated` and may point at the
coordinator's matching generated output. It must contain `build.json`,
`zorid_wasm.js` and `zorid_wasm_bg.wasm`. The root source fingerprint must match.
The assigned build uses the existing toolchain, including
`/Users/ctk/Projects/Zorid/tmp/stage4-tools/wasm-bindgen` and the shared Rust
sysroot; only the coordinator should launch that build.

The next `report.json` must have all 19 authored groups passed, no unexecuted group,
observed product Worker and WASM GETs, no cleanup failures and no runner error.
Full rendered Electron heavy-user acceptance, normal web UI/CLI, native/mobile,
sync and large-vault performance are separate evidence.
