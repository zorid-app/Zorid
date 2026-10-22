# Bases expression completion audit — 2026-10-22

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

## Complete inventory-to-handler matrix

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

## Real gaps and documented choices

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
