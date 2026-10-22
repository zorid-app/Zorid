# Bases expression completion audit — 2026-10-22

## Final core successor evidence — 2026-10-22, `8f18b965`

The coordinator's pinned-tool full run completed with exit 0 at source
`8f18b96574ec7b7e5dc01ac7365a1c643bd66b9f`, `crates` tree
`958b19aca4666414e956fbb2f406558af5a18366`, `zorid-bases` subtree
`a7ea02e4a9993a1d7fde41c3601036882d37f18e`. Retained
`/private/tmp/zorid-bases-g9-final-full-composed-001.log` reports **359 passed
across 20 nonempty targets**, comprising 196 library and 163 integration tests,
plus a zero-test doc-test target. The separate focused log
`/private/tmp/zorid-bases-g9-named-key-focused-001.log` passes all 196 library
and all 10 preview tests; those 206 results are overlapping evidence, not tests
to add to the 359 total. Adjacent/deferred Tasks and Calendar targets remain
part of the full count.

The previously failing
`small_prepared_subset_does_not_prepare_a_hundred_thousand_entry_namespace`
now passes in both focused and full runs with its **500,000-step budget
unchanged**. The historical 60c1d4fd failure and preceding baselines below remain
retained; this successor supersedes that failure as a current source/test
blocker without rewriting its outcome.

The repair retains the checked conversion/admission contract. `1e9a7f25` moves
an already admitted owned String key instead of rendering/copying it a second
time. `8f18b965` projects safe ASCII property identifiers through named
AST members and borrows their text for lookup, while retaining scan work and
cancellation checks. Names outside that safe subset keep the quoted/computed
path; the tests preserve captured values and dependency planning. Named passing
cases include `computed_string_key_consumes_admitted_text_without_rendering_a_second_copy`,
`named_keys_borrow_ast_text_but_still_charge_the_lookup_scan`,
`cached_named_keys_poll_cancellation_and_leave_string_member_semantics_intact`,
`generated_named_keys_use_only_the_safe_ascii_identifier_subset` and
`generated_named_and_quoted_keys_select_the_same_captured_values`.

The earlier measured A/B diagnosis is retained at
`/private/tmp/zorid-bases-g9-cost-diagnosis.json`. After the first owned-String
repair, it records comparator totals 507,857 versus baseline 497,182 with
identical preview-admission cost 486,120: a **10,675-step delta**, accounted for
as `(127 rows × 11 computed String keys + 128 filter String literals) × 7`
checked literal-import steps. The fixture budget remains 500,000. This explains
that measured intermediate failure; it is not a new elapsed-time, memory or
universal cost claim for final source. The final named-key repair avoids
synthetic String keys where safe rather than dropping the remaining literal,
lookup or cancellation charges.

The full successor passes the named source regressions for G9 Object/raw-Link
conversion and allocation guards, G10 regex admission, G11/G15 File methods,
G12/G14 title/date extrema and G13 pinned collation recorded below. It establishes
the current Rust core test closure for these identified repairs, **not complete
Q3, native transport, actual WASM/CLI or rendered acceptance**. D1–D6 and the
explicit pinned-collation/safe-key policies remain. The authored **127 typed-value
oracles and 16 expected diagnostics** still require matching product artifacts
and actual runtime execution. Historical Browser005 nine groups and CLI003 85
commands do not become proof for this successor.

This documentation task ran no app, build or product test and changed only this
audit record; the observed test evidence belongs to the coordinator's runs.

## Historical successor evidence — 2026-10-22, `60c1d4fd`

This dated update supersedes the source-status entries in the historical
sections below, preserving their findings and earlier outcomes. It records
implementation and observed Rust tests; **product artifacts, transport/runtime
coverage and rendered acceptance remain pending**. This documentation task ran
no app, build or product test and changed no goal checkboxes.

The inspected source is `60c1d4fdaa68f99ab99d6919bcfe4344b76a11dd`, `crates`
tree `9a001d4731229c973c2b7bd8f1db7bd82c61d08e`, `zorid-bases` subtree
`0105d914730523cc7d37a34b606ed5056131559e`. The bounded 80-declaration inventory
and prior source review remain the catalogue basis; the statuses below do not
claim exhaustive input, JavaScript-engine or platform equivalence.

Observed `/private/tmp/zorid-bases-g9-composed-lib-003.log` reports **185/185
library tests passed** on the composed source. The preceding
`/private/tmp/zorid-bases-regex-file-title-full-composed-005.log` reports **317
passed across 20 nonempty targets** (154 library plus 163 integration tests),
plus a zero-test doc-test target. That earlier full pass includes regex, File,
title and rich-date changes, but predates the final G9/ICU closure; it is not a
317-test full pass for `60c1d4fd`. The current full run
`/private/tmp/zorid-bases-g9-full-composed-001.log` terminates unsuccessfully:
185 library tests pass, but preview ends with nine passed and one failure in
`small_prepared_subset_does_not_prepare_a_hundred_thousand_entry_namespace`
(`preview.rs:476`, comparator scratch exceeds query work budget). Later targets
are unexecuted in that run. The failure is under diagnosis; **there is no complete
current-core pass**, and the preceding 317-test pass remains baseline evidence.

| Identified invariant | Successor source and named evidence; acceptance boundary |
| --- | --- |
| G9.1 Object conversion | Independently reviewed `d4cc14a0` and checked-allocation successor `da1078de` route ordinary Object text through recursive typed child strings in JS own-key order while retaining typed JSON projection separately. The 14 passing `object_stringification_tests` include `object_to_string_uses_child_strings_without_changing_typed_json`, `recursive_children_use_their_actual_typed_string_representation`, `concatenation_join_sort_and_computed_access_share_checked_strings` and `groups_and_summary_values_use_the_same_reference_object_text`. `__proto__` remains inert user data rather than copying the reference temporary object's legacy setter omission; that bounded safety difference is documented in the converter. Runtime/UI acceptance remains open. |
| G9.2 Link raw data | Reviewed `7a47a17a` makes inherited String methods and length use available captured internal raw destination, retaining the canonical File lookup path, legacy fallback and unchanged external URL data. `captured_internal_link_string_methods_read_original_data_without_mutating_lookup_path` passes; `common_link_text_keeps_legacy_display_while_unique_requires_origin` pins the distinct presentation/strict-origin boundary. Source repaired and library-tested, not new transport proof. |
| G9 resource admission | Reviewed `fb07f283` adds immutable admitted clone plans and fresh bounded containers; `da1078de` budgets shared text conversion against caller scratch/headroom. Six clone tests and the 14 stringification tests pass within the 185 library tests, including `whole_plan_headroom_is_checked_before_the_first_materialization_copy`, `planning_and_materialization_each_check_work_inside_wide_inputs`, `recursive_key_scratch_is_bounded_by_the_callers_remaining_headroom` and `output_clone_admission_counts_real_enum_slots_in_nested_vectors`. This is guard evidence, not measured all-allocation or performance acceptance. |
| G10 Regex construction | The checked whole-expression literal admission, zero-row/query/summary/settings boundaries and subsequent admission-poll corrections are composed. The preceding 317-test run passes `regex_construction` two tests and `regex_query_admission` five tests; current library cases also pass. The historical failed preview record is retained; the current full-run budget failure above remains a blocker under diagnosis, without attribution to a specific admission change here. D6 unsupported-valid-JS diagnostics remain separate from malformed-literal construction failures. |
| G11 / G15 File methods | Reviewed `05a23b34` / `a9d1e09d` implement query-only folder separator/space/NFC normalization, root/empty membership and literal repeated tag prefixes. All seven `file_method_reference` cases pass in the preceding full run, including `root_folder_queries_include_root_and_nested_files`, `folder_queries_apply_only_the_shipped_separator_space_and_nfc_normalizers` and `tag_query_whitespace_and_repeated_hashes_are_literal_without_changing_other_tag_methods`. No broad filesystem-normalization or new write authority is implied. |
| G12 / G14 Title and date extrema | Reviewed `cff1239a` / `e5e1eb4d` use literal-space title boundaries and all parseable String-subclass raw payloads for earliest/latest. Four current library tests pass, including `title_only_splits_literal_spaces_and_preserves_empty_segments`, `date_extrema_accept_all_parseable_rich_string_raw_payloads` and `rich_date_scans_charge_raw_bytes_and_observe_cancellation`. Captured-zone and D5 scalar-string policies remain. |
| G13 Concrete List.sort | Reviewed `dbd9c37c` with pinned dependencies `834853e5` adds ICU4X English, primary/base-sensitive numeric collation for non-Number pairs, retaining numeric comparison only for two actual Numbers. Eleven library cases pass, including `natural_digits_are_not_lexical_or_decimal_number_parsing`, `base_sensitive_ties_preserve_input_order`, `only_two_actual_numbers_take_numeric_branch`, `complete_comparison_input_is_charged_before_icu` and `cancellation_at_each_checkpoint_never_publishes_partial_order`. English/data pinning and deterministic handling of inconsistent mixed comparisons are documented choices, not universal ambient-locale or JS-engine sort-permutation parity. See [UPSTREAM.md](../../crates/zorid-bases/UPSTREAM.md). |

The final fixture-only correction `e8a37c86` changes two typed-JSON expectations
from `1.0` to `1`, matching the existing integer projection; it changes no
product implementation; numeric value/type intent is unchanged. It does not relax work,
cancellation, ordering or value-type assertions.

G1–G8's enumerated repairs and named evidence remain recorded below. The specific
G9/G10–G15 source gaps identified by this audit now have composed implementations
and the test evidence above; this does not close the broader Q3 acceptance gate.
D1–D6 remain intentional limits. The pinned collation and safe-key handling above
are explicit source policies, not permission to hide another semantic gap.

Current authored acceptance fixtures contain **127 typed-value oracles and 16
expected diagnostics**. They still require matching artifacts and actual runtime
execution; authored assertions are not executed test results. Historical
Browser005 nine groups and CLI003 85 commands remain valid only for their older
closures. No native/actual-WASM/CLI expression-closure or rendered parity claim
is added here.

## Historical source update — frozen `bef128ba`, regex successor `24618348`

This addendum supersedes the original gap statuses below, while preserving that
baseline and its evidence. It records source and named tests, **not complete Q3,
transport or rendered acceptance**. No app, build or tests were run by this
read-only audit/update task.

The inspected snapshot is `bef128ba41bdd2ec0a98f40ccd20fcfae5b0bf25`, with
`crates` tree `513fe752302763b12c5658755f2b301a30e3bc05` and `zorid-bases`
subtree `1ebd233d68aee98f4a940ff255e7a16aa187318f`; this `crates` tree also
belongs to `8c2d4c35`. An independent complete-catalogue review found signature
admission and reachable handlers for all **80 declarations**. Handler coverage
is not an exhaustive semantic input matrix.

Observed `/private/tmp/zorid-bases-q3-full-composed-003.log` reports **288 passed
across 17 targets**: 139 library and 149 integration tests. This includes
adjacent/deferred Tasks and Calendar tests. The native target log
`/private/tmp/zorid-bases-q3-native-targets-001.log` passes only three property-
target tests. `/private/tmp/zorid-bases-q3-wasm-targets-001.log` ends with a
`js-sys` no-space compilation failure and no test result; it is not WASM proof.
Historical Browser005 nine groups and CLI003 85 commands remain separate. The
newly authored 19 browser groups and 125 CLI commands are awaiting matching
runtime evidence; they are not credited as executed by this update.

| Original gap | Current source-and-test evidence, within the frozen snapshot |
| --- | --- |
| G1 Object callbacks | Implemented exact lowercase scopes, key/value locals with outer fallback, List map output, retained Object filter output, ordered enumeration and throw propagation. The 18 passing `object_tag_expressions` tests include `object_map_returns_callback_values_in_key_order_with_exact_keys_and_typed_values`, `object_filter_retains_original_values_and_object_shape` and `object_callbacks_have_exact_arity_and_propagate_callback_errors`. |
| G2 Tags | Private Tag/TagList hydration, hierarchy, generic wire export and query/group/summary/overlay subtype provenance implemented. Passing cases include `specialized_tag_membership_and_generic_list_membership_remain_distinct`, `nested_formula_tag_lists_survive_query_group_summary_and_picker_projection` and three `frontmatter_tags_overlay` tests. Null tag-array members produce an explicit type diagnostic; this does not reproduce a reference constructor crash. Separate File.hasTag prefix gap G15 remains. |
| G3 Signatures | `expression_signatures.rs` covers the 80 declarations. Fourteen passing `call_contract_tests` cover required-null early return, optional-null omission, argument/error ordering, types, work/cancellation and returned Error data versus thrown errors. This is not every input combination for all 80 declarations. |
| G4 Special calls | Lowercase lazy global/method-style if and total arity, exact lowercase callback AST scopes and mixed-case eager registry paths implemented. Passing cases include `lowercase_if_is_lazy_supports_subject_and_checks_total_arity_first`, `mixed_case_if_uses_eager_boolean_registry_and_has_no_method_registration` and `exact_lowercase_callbacks_keep_scope_but_mixed_case_uses_eager_stubs`. Regex construction is tracked separately as G10. |
| G5 Strings/regex | Earlier enumerated membership folding, empty literal replacement, computed scalar indexes, JS replacement templates, capture-inserting split and uint32 limits implemented, with direct named cases in the 11 passing `collection_expressions` tests. D5/D6 remain. Additional title and construction gaps are G12/G10. |
| G6 Lists | Earlier recursive flat, single-list membership, required join argument and strict uniqueness corrections implemented and tested. Tests cover constructor distinctions, exact Link labels/origin, immutable File witnesses and AST Regex identity across cache eviction and query projections. List.sort collation remains G13. |
| G7 Numbers | Negative round-digit behavior, binary toFixed domains/ties/exponents, number string buckets and JS whitespace/prefix handling implemented. `number_round_and_fixed_use_reference_domains_binary_ties_and_exponents` and `number_strings_and_prefix_whitespace_keep_reference_buckets` pass. D2 remains; no exhaustive numeric proof. |
| G8 Durations | Anchored simple-unit parsing and unanchored ISO parsing with mandatory T/integer components, all eight converted fields, component truth, typed division, captured-calendar comparison, JS setter overflow, month interpolation and refresh dependencies implemented. Seven `duration_semantics_tests` pass, alongside `grouping_actual_nested_durations_adds_clock_refresh_to_pure_formulas` and `runtime_duration_sort_upgrades_advice_before_positive_fractional_limit`. D1/D2 remain. |
| G9 Inheritance/output | Partial: public ancestry, rich concatenation and returned Error versus thrown/formula-origin behavior implemented and covered by the call tests. String argument contracts are enforced, but configured-Link raw-data coercion and ordinary Object string conversion remain open below. |

D1–D6 remain the existing deliberate choices listed at the end of this record.
They do not newly approve any of the following differences. Cases below are
source-derived expectations, not newly observed application executions.

| Remaining invariant | Primary/source distinction and status |
| --- | --- |
| G9.1 Ordinary Object string conversion | Shipped `yK` 2199918–2201551 converts every child through its typed toString, then emits JSON with String values in JS key order. Rust `plain_string` at the frozen snapshot serializes `to_plain` raw values. Typed `{n:1,b:true,none:Null}` should produce `{"n":"1","b":"true","none":"null"}`; the ordinary path preserves number/bool/null. Nested Objects become escaped JSON Strings, Lists become comma-space text, Tags retain case/prefix, Links retain raw destination/typed display and returned Errors use `Error: message`. The checked `unique_bucket_key` already implements the recursive ordered String-valued bucket path; common toString/concatenation/join/group display do not reuse it. Fix active with `duration_review`; still open and untested here. Preserve work/byte/cancellation guards when unifying converters. |
| G9.2 Configured-Link raw-data coercion | Shipped String-subclass methods consume original `xK.data`, independently of resolved File identity. Frozen `string_data` returns Link.path even after a configured relation projects that public path to a canonical destination; captured `raw_destination` survives separately. The existing configured-relation provenance test proves original strict identity, not ordinary String coercion. Use available captured internal raw destination for String coercion; retain the path fallback for legacy values and unchanged external URL data. This is an open seam assigned to `duration_review`, not an approved D4 canonical-coercion choice or a passing test. |
| G10 Regex construction | Shipped `MQ`/`IQ`/`BQ` recursively constructs regex literals before lazy branch selection; malformed untaken literals invalidate the whole expression. Frozen `bef128ba` validates selected nodes only. The independently reviewed checked admission fix and query/settings boundaries are composed at successor `24618348`. `/private/tmp/zorid-bases-regex-targets-composed-001.log` passes `regex_construction` two tests and `regex_query_admission` five tests. The full run `/private/tmp/zorid-bases-regex-full-composed-001.log` passes 146 library tests, then stops at the preview target with nine passed and one budget failure in `small_prepared_subset_does_not_prepare_a_hundred_thousand_entry_namespace` (`preview.rs:476`, comparator scratch budget); later targets are unexecuted in that run. There is no full-suite pass for this successor. See [the exact reference record](bases-regex-construction-reference-20261022.md). This is source implemented/reviewed with targeted test evidence, not accepted. |
| G11 File.inFolder normalization | Registration 2238353–2238675 uses `Fl`/`Rl` at 543851–543995. Root or empty normalizes to `/` and matches nested files; the frozen Rust trailing-slash-only comparison does not. Reference query normalization also collapses slash/backslash runs, removes leading/trailing slashes, replaces NBSP/narrow NBSP with ASCII space and applies NFC; it does not ordinary-trim, case-fold or resolve dot segments. Fix active with `bases_relations`; open and untested here. |
| G12 String.title boundaries | Registration 2223409–2223757 splits literal ASCII spaces; frozen `title_case` capitalizes Unicode letter runs. ASCII `'hello-world'.title()` should be `Hello-world`, current `Hello-World`. Fix active with `bases_inline_core`; open and untested here. This example is separate from D5. |
| G13 List.sort collation | `fK.sort` 2196926–2197194 uses numeric comparison for two Numbers, otherwise `BT`, bound at 1302374–1302462 to an Intl.Collator with base sensitivity and numeric sorting. Frozen `compare_sort_keys` uses lexical String comparison for non-number pairs: `['a10','a2']` remains lexical instead of `['a2','a10']`. Controller research is active; open and untested here. Locale-wide equivalence is not established by this example. |
| G14 Date selection from rich Strings | `getDates` 2195226–2195460 accepts each `hK` String subclass's raw data as well as ordinary Strings and Dates; frozen earliest/latest accepts only String/Tag/Date. In captured UTC, `[icon('2024-01-01')].earliest()` should yield a time-bearing Date at 1704067200000, current Null. Fix active with `bases_inline_core`; open and untested here. Rendered wiki/image markup is not the raw input. |
| G15 File.hasTag repeated prefix | Registration 2238675–2239300 wraps queries with `gK`; `vK` 2199201 adds `#` only if absent. Frozen `normalize_tag` strips all leading `#`: with file tag `#work`, query `##work` wrongly matches. Fix active with `bases_relations`; open and untested here. Whitespace/case/hierarchy rules remain distinct. |

Object details are covered by the existing Object/Tag REA evidence below. The
focused File normalizer/tag follow-up is
`ev_adec5b213173bf4c29f475efced01626cf2cec1cebcf1e031b84e3bcb6ca1f7e`,
private `/private/tmp/zorid-bases-file-method-reference-20261022/provenance.json`:
five inert JS files, 547 AST nodes, zero parse failures, partial graph 150/80.
The original artifact hash and decoded-character offset convention below apply.
No recovered source was added to the repository. New source fixes still need
named regressions, independent review and exact artifact/runtime association.

## Historical baseline — `fb17f0d1`

Owner `bases_docs_model`; source-only branch `codex/bases-expression-completion`,
parent `fb17f0d1`. This completes a catalogue audit, **not Q3 implementation or
parity acceptance**. No app, build, tests, source edits or goal-checkbox changes
were performed. The frozen `crates` tree is
`5e010112661da69eb290d6a5edb72d4906e844a1`; its `zorid-bases` subtree is
`225fdd9f456faff9011117bf37318c4a73f4ef2a`. Browser005 used root
`055e985f3534af44b8fef1daafe40e372aa127cd` and this Rust closure. Newly assigned
Object/Tag fixes are not credited here. Primary main remains separate.

The [query reference](../bases-query-reference.md),
[expression matrix](../reference/bases-expression-matrix.md),
[reference ledger](bases-pass-reference-20261021.md) and
[goal](../plans/bases-implementation-goal.md) supply the existing scope. Older
“implemented” labels do not establish complete registration semantics.

## Primary evidence and verification boundary

Obsidian1.14.4 `app.js` SHA-256 is
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, retained
at `/private/tmp/zorid-obsidian-reference-20261021/1.14.4-app.js`.
Bounded registration reading **2215609–2240505** identifies **80 declarations:
16 global and64 receiver registrations**. Inheritance adds availability without
another declaration. Extracted names/receivers/offsets, without bodies:
`/private/tmp/zorid-bases-expression-completion-audit-20261022/registry-inventory.json`.
All offsets below are Python Unicode-character ranges, end-exclusive, not bytes
or UTF-16. Community registrations are outside this first-party inventory.

Retained REA includes E3
`ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`,
rich registrations `ev_c32894444b6eccf2eb01a3512eb76c4c728fdac62d94f989960c81c753467464`,
scalar globals `ev_1d006a595ebc4f81549ee54555dcc53e6ff5a12e6ac6cf3dc15b48b176836ad4`
and frontmatter inference
`ev_e2499feaa9ea6ba1b78f7e8f3ce2f4880b9084bfbe387ee1c6ab7060a967c565`.
Their limits remain in the expression matrix. New bounded Object/Tag follow-up:
`ev_052fb6ab7ee1d0bedbea7427adcf6b81f81c28ccf0a7ca713c0a26a811d38c1c`,
private `/private/tmp/zorid-bases-object-tag-reference-20261022/provenance.json`:
8 inert files/16,095 bytes/5,125 AST nodes/zero parse failures, partial graph1200/250.
Hydration/export follow-up:
`ev_4b145fd45047306a9e8b5a75a35435fa5c21e56a5a01e6db17593edcb86ae61e`,
private `/private/tmp/zorid-bases-tag-hydration-reference-20261022/provenance.json`:
6 inert files/2,015 bytes/694 AST nodes/zero parse failures, partial graph350/100.
These are inspected syntax/analyst readings, not execution. External callees and
unselected source remain unknown; recovered implementation stays in private tmp.

`/private/tmp/zorid-bases-core-plain-link-check-2.log` reports **194 passed across
13 targets**, including adjacent/deferred Task/Calendar tests. Separate native
property-target3 and native-compiled WASM property-target2 logs are not a complete
expression transport suite. Actual browser005 report
`/private/tmp/zorid-bases-browser-actual-20261022-005/report.json` passes all9
semantic groups, with no unexecuted group, runner error or artifact failure.
It observes normal Worker/WASM/IndexedDB; served WASM SHA-256
`231d9d8614c659fd1abda0e5f23c78d443e6c5a439a99e72f376c56ae64cf7e6`.
It does not exercise every registration or establish rendered UI behavior.

## Frozen baseline inventory-to-handler matrix

`S` is [expression.rs](../../crates/zorid-bases/src/expression.rs), with line
anchors for this frozen source. `E:id` is a named case in
[accepted-expressions.json](../../tests/fixtures/document-semantics/bases/accepted-expressions.json),
executed by `accepted_expression_corpus_uses_reused_engine` in
[corpus.rs](../../crates/zorid-bases/tests/corpus.rs). Other Rust names are exact
test identifiers, not new executions. `B0`–`B8` are browser005 groups in
[cases.mjs](../../tests/bases-browser-integration/cases.mjs) /
[fixture.mjs](../../tests/bases-browser-integration/fixture.mjs): ordinary
inference, raw edits, summaries, group previews, rich values, fenced context,
relations, settings proof, authority/restart. A named broad test does not imply
that it exercises every method in its row. `G#` are remaining gaps; `D#` are
already documented choices below.

| ID / complete registered names or value surface | Frozen Rust handler | Named evidence / exact remaining boundary |
| --- | --- | --- |
| Q3.01 Global `now`, `today` | `global` S2204/2217; captured clock/zone/start-of-day | `E:clock-pinned`; `civil_day_deadlines_handle_short_long_and_non_hour_days`; B4 TODAY zone. Native `base_clock.rs` contains4 named tests, but the latest native property-target log filters them out. D1. |
| Q3.02 Global `date`, `number` | `global` S2107/2205; `parse_date`, `parse_number_prefix` | `E:number-prefix,date-invalid,date-only,date-offset`; `reference_scalar_conversions_and_missing_aggregates_are_typed`; B4 formatted date. Not all conversions/Infinity-prefix inputs covered; D2. |
| Q3.03 Global `duration` | `global` S2116; `parse_duration` S4009 | `E:date-calendar-add`; ISO/text/calendar gaps G8. |
| Q3.04 Global `if` | `call` S2011 | `E:lazy-conditional`; `built_in_dispatch_is_case_insensitive_and_string_subclasses_convert`. Method-style if, exact arity and special/fallback case rules G3/G4. |
| Q3.05 Global `random` | `global` S2090; seeded row state | `random_is_bounded_seeded_row_specific_and_not_clock_dependent`; `E:random-bounded`; B4 range/type. Seeded RNG D3. |
| Q3.06 Global `min`, `max`, `list` | `global` S2177–2203 | Scalar conversion test covers min/max empty/null; list wrapping has a handler. No named test for every variadic/wrapping combination; G3. |
| Q3.07 Global `file`, `link` | `global` S2126/2161; immutable lookup/hydration | `file_round_trip_never_fabricates_metadata_for_missing_target`; `file_and_link_expressions_read_the_same_snapshot_property_overlays`; B0/B4. D4. |
| Q3.08 Global `html`, `image`, `icon`, `escapeHTML` | `global` S2100/2136–2160; inert typed values | `rich_outputs_retain_type_inert_payload_and_recursive_display`, `wrappers_follow_reference_null_and_string_inheritance`, `image_string_representation_matches_internal_and_external_resource_forms`; B4 typed output. Host sanitization/rendering separate; G3/G9. |
| Q3.09 Any `toString`, `isTruthy`, `isType` | `method` S2244; `plain_string`, `is_truthy`, `value_type` | `E:null-to-string,empty-list-truth`; rich/scalar tests. Argument validation, full ancestry, duration truth and rich concatenation G3/G8/G9. |
| Q3.10 Null `isEmpty` | common method/`is_empty` S3520 | `E:null-false-zero-empty` distinguishes values; exact method arity G3. |
| Q3.11 String `startsWith`, `endsWith`, `trim`, `title`, `isEmpty`, `lower`, `contains`, `containsAny`, `containsAll` | `string_method` S2343; common emptiness/`title_case` | All handlers present; no dedicated named cases for every method. Any/All folding and required-null/type semantics G3/G5. |
| Q3.12 String `replace`, `reverse`, `split`, `slice`, `repeat`; `length`/indexes | `string_method`; `string_slice`, `string_split`, `property` | `E:unicode-length,unicode-reverse`; numeric/calendar guard test checks repeat bound. Empty replacement/computed indexing G5; scalar Unicode D5; regex D6. |
| Q3.13 Number `round`, `ceil`, `floor`, `abs`, `toFixed`, `isEmpty` | `number_method` S2422; common emptiness | `numeric_and_calendar_edges_cannot_panic_or_erase_types` covers numeric-domain/calendar/resource guards, not individual Number methods. Negative round digits G7; type/arity G3; D2. |
| Q3.14 List `isEmpty`, `reverse`, `slice`, `sort`, `join`, `flat`, `unique`; `length`/indexes | `list_method` S2486; `property`, `slice_values`, `unique_key`, `compare_sort_keys` | Corpus covers nested lists/emptiness, not all listed operations. Recursive flat, join signature and strict uniqueness G3/G6; mixed-sort combinations unproved. |
| Q3.15 List `contains`, `containsAny`, `containsAll` | `list_method` S2515; checked loose equality | `repeated_membership_work_is_charged_before_traversal`; checked wiki/scalar tests. Single-list expansion G6; TagList behavior G2. |
| Q3.16 List `map`, `filter`, `reduce` | scoped `list_method` S2542/2590/2614 | `E:nested-list-scope`; summary callback test; B2 custom Link summaries filter/map. Exact arity/case G3/G4. |
| Q3.17 List `earliest`, `latest`, `median`, `mean`, `max`, `min`, `sum`, `stddev` | `list_method` S2667 | `numeric_builtins_keep_reference_selection_rounding_and_mean_denominator`, `date_summaries_keep_typed_dates_and_duration_range`; B2/B3 scoped summaries. Not all direct-list combinations. |
| Q3.18 Object `isEmpty`, `keys`, `values` | `method` S2307; ordered own-key lookup | `shared_metadata_date_hints_and_nested_case_order_are_observable`; `E:nested-case-source-order`; B0 nested metadata. Individual arity G3. |
| Q3.19 Object `map`, `filter` | **Absent**; Object dispatch only keys/values | G1. No named passing Rust/native/WASM case. Assigned successor not credited. |
| Q3.20 RegExp `matches` | `method` S2314; `compile_regex` S4502 | `E:regex-repeat`; corpus host/budget test; B4 explicit unsupported lookaround. JS state/feature subset D6; replacement semantics G5. |
| Q3.21 Date `format`, `date`, `time`, `relative`, `isEmpty` | `date_method` S2464; `expression_format.rs`; `start_of_day`, `relative_date` | `moment_calendar_tokens_literals_and_localized_english_formats`, `offset_tokens_use_captured_timezone_and_patterns_are_bounded`; B4 exact formatted string. Per-method input matrix absent; locale/era D1. |
| Q3.22 File `asLink`, `hasLink`, `inFolder`, `hasTag`, `hasProperty` | `file_method` S2744; prepared graph | file round-trip test; `generation_factory_canonical_graph_corpus`; B0 folder filter. Not all5 have dedicated browser005 cases. Metadata failures remain unavailable. |
| Q3.23 Link `linksTo`, `asFile`; URL/rich inherited String methods | `link_method` S2827; identity lookup/String fallback | property-overlay/subpath tests; B0/B2 asFile. Identity/origin D4; signature/inheritance G3/G9. |
| Q3.24 Tag `matches`; TagList inherited membership | **Absent subtype/handler**; tags List(String) | G2. File.hasTag is not a substitute. No named Tag callback/membership case in194/B005. |
| Q3.25 File fields `file`, `name`, `basename`, `fullname`, `path`, `folder`, `ext`, `ctime`, `mtime`, `size`, `properties`, `tags`, `links`, `embeds`, `backlinks` | `file_property` S4251; metadata/graph availability guards | generation corpus; `negative_relationship_filter_is_unavailable_not_false_absence`; B0/B6. All15 dispatch; tags subtype G2. Revision/coverage guards do not fabricate emptiness. |
| Q3.26 Date fields `year`, `month`, `day`, `hour`, `minute`, `second`, `millisecond`; Duration fields `years`, `months`, `weeks`, `days`, `hours`, `minutes`, `seconds`, `milliseconds` | `date_property` S3994 exists; **Duration access absent** | `typed_date_properties_and_unbound_context_keep_their_meaning`; timezone tests. Duration fields G8. No universal calendar/input proof. |
| Q3.27 Null/Error/Boolean/Number/String/List/Object/RegExp/Date/Duration/File/Link/URL/Image/Icon/HTML conversions/equality | RuntimeValue; `from_json`, recursive inference, `to_plain`/`typed_value`, checked equality, `plain_string` | scalar/wrapper/frontmatter/URL/subpath/equality tests; B0/B4. Tags G2; string/duration/inherited rich edges G8/G9; nonfinite D2. Not a complete coercion matrix. |
| Q3.28 Syntax/operators/access, note/file/this/formula, callback locals, cycles/filter errors | parser S315; evaluator/`identifier`/`binary`/`member`/`formula`; `program.rs` filters | All30 corpus cases, guards/current-entry corpus; B4 cycle/unknown, B5 this. String indexing G5; call scopes G1/G3/G4; duration/rich operators G8/G9. Complete grammar cross-product unproved. |

## Original baseline gaps and documented choices

**G1 Object callbacks.** IQ2332505–2336202 accepts exactly1 argument for lowercase
map/filter. Key is exact String; value is converted property; other identifiers
fall back outward (no new index/acc). Map returns **List** in Object.keys order;
filter returns **Object** retaining original keys. Thrown callback aborts, then
outer mQ2323391 catches into Error; no per-item recovery. A returned typed Error
remains a value, false in filter. Key-renaming semantics are not observed.

**G2 Tags.** gK2199252–2199660 inherits String; mK2199660–2199918 inherits List.
Prefix2199201 adds# without trimming. matches accepts String-derived queries,
compares lowercase exact/end-or-slash prefixes; ordinary String has no matches.
TagList overrides includes; inherited Any/All expand a single List first.
Strict/loose equality remain case-sensitive scalar/list operations, separate
from hierarchy. Public type names remain inherited String/List. Direct note.tags
2201077–2201527 wraps raw string/string-array; file.tags2208576–2208917 combines
inline and normalized frontmatter tags then exact Set dedup. Other '#foo'
properties remain String. Generic list transforms lose TagList membership while
retaining Tag elements. Export2374636–2375266 emits normalized strings/arrays.
The reference validator null-filters only its checking copy; original nulls can
reach construction. Safe incompatible/null handling needs an explicit decision.

**G3 Signatures.** No generic required/optional/variadic/type validation.
`startsWith(null)` yields Bool rather than null; contains(1) stringifies rather
than type-errors; (1).abs(2) ignores excess. Common methods ignore supplied args.
Required-null and optional-null must be tested separately.

**G4 Special calls.** Lowercase shipped if accepts method subject and validates
2/3 total operands; lowercase map/filter/reduce use special scope/arity. Mixed
case falls through ordinary registration. Rust canonicalizes before special
branches and has only global-style lazy if. Its uppercase-lazy-IF test proves
a difference, not user approval for that difference.

**G5 Strings/regex.** Any/All case-sensitive vs reference lowercase; empty literal
replace inserts text vs reference unchanged; computed String indexing lacks
charAt branch. Rust capture-template replacement/split semantics are not proved
JS-equivalent. These are distinct from documented Unicode/regex limits.

**G6 Lists.** Missing single-List Any/All expansion; flat is one-level vs recursive;
join allows missing separator vs required String. Serialized unique_key is not
strict constructor-aware equality; nested differently typed values can serialize
alike. Need direct named fixtures, not summary-only coverage.

**G7 Numbers.** Rust round scales negative digits; reference scales only positive
digits. Number-prefix/round/toFixed edges are distinct from nonfinite diagnostics.

**G8 Durations.** ISO branch missing; Rust accepts compound/fractional embedded
unit text beyond reference's anchored simple-unit branch. Duration fields and
zero-duration false truthiness absent; Duration/Number division lacks typed
branch. Row comparisons use fixed-unit duration_millis omitting years/months;
reference measures calendar addition to current date, while query sort separately
uses captured duration_scalar. Month-end chrono clamping differs from JS Date
overflow. These require decisions/fixtures, not implicit portability acceptance.

**G9 Inheritance/output.** isType checks concrete name/selected String inheritance
rather than full constructor ancestry including Any. Rich String-derived values
concatenate only when an operand is plain String. Missing-formula/error/object
stringification have limited cases, not complete conversion parity.

Existing documented choices, **not newly approved here**: D1 explicit captured
UTC/fixed/IANA time, English format/relative text, strict invalid/ambiguous-local
diagnostics; D2 finite transport/resource/depth/cancellation diagnostics; D3
seeded portable random; D4 immutable link identity/origin/subpath integrity; D5
Unicode scalar strings; D6 bounded stateless Rust regex with unsupported JS
features diagnosed and no lastIndex. See expression matrix, UPSTREAM.md and ledger.

Missing implementation and missing test coverage are different findings. Any
successor needs independent source review, focused named tests, new exact Rust/
artifact association and native/actual-WASM scenarios for changed behavior. The
194 count, browser005 result and this complete catalogue map do not close those
gates or the product's rendered interaction acceptance.
