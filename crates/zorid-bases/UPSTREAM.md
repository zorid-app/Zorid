# MDBASE evaluator extraction provenance

Origin: https://github.com/callumalpass/mdbase-rs
Revision: `2e8f47f3a0737766060599cf9534582bd75aa719` (`0.4.0-rc.6`).
License: MIT, Copyright (c) 2025 Callum Alpass. Full notice in LICENSE-MDBASE.
Zorid adaptations use the repository AGPL-3.0-only license; the upstream notice
continues to apply to the inherited implementation.

Copied implementation:

- `src/views/expression.rs`: lexer, AST/parser, evaluator and builtins, date/time,
  list/string/regex helpers and dependency inspection. Upstream test module is
  excluded. Provider candidate lowering, imports and JSON entrypoint are removed.
- `src/views/files.rs`: in-memory lookup collection. Frontmatter Markdown-link
  extraction and upstream tests are excluded. No filesystem authority is copied.

The local evaluator remains the upstream parser/evaluator implementation with
scoped dialect adaptations. This is not an independently invented formula engine.
No CEL evaluator, Collection, hosted provider, SQLite, filesystem access or watch
implementation is included. The inherited file lookup is not exposed as an
implicit host resolver: host-dependent functions/relationships are rejected in
the initial expression-only API.

Adaptations:

- Portable explicit UTC/fixed/IANA invocation timezone and captured clock; no
  Local/ambient clock feature or native stacker. Exact chrono-tz 0.10.4 std-only
  manifest was source-reviewed (MIT OR Apache-2.0; pure phf lookup; optional build
  tooling disabled). No runtime network or timezone-file lookup is used.
- Shared `zorid_document::PropertyValue` recursively converts to ordered internal
  IndexMap objects; no global serde_json feature changes. Case-insensitive own
  lookup prefers exact spelling then source order, including nested properties.
- Typed results are captured before upstream plain JSON erases dates/durations
  and nonfinite values. Nonfinite numbers are explicit numeric-domain errors.
- AST recursion/chain depth and source size are bounded before evaluation;
  formulas, input/output bytes, compiled regex memory and repeated strings have
  explicit ceilings. Cancellation and AST work remain cooperative.
- No fancy-regex fallback or fake random output. Unsupported regex, host functions
  and missing relationship metadata yield diagnostics. Regex split errors are not
  silently replaced with a literal split result.
- Current null/empty-container truth, strict arithmetic, explicit number-prefix
  conversion, equality cases, lazy formulas and optional current-record context
  have scoped compatibility adaptations. Unicode string helpers retain upstream
  scalar semantics and regex matching remains stateless.

Current Bases pass (2026-10-21): built-in file/link resolution now uses the
immutable generation namespace and shared hydrated metadata; no inherited
ambient filesystem resolver is exposed. HTML/image/icon and rich link labels
cross the wire as inert typed values. Hosts sanitize/resolve resources. Random
uses captured view-load entropy plus row identity/revision with a portable
bounded PRNG, rather than an ambient JavaScript/native RNG. Its accepted fixture
now checks the independently authored [0,1) invariant; historical rejected-host
expectations remain in the historical source corpus. English Moment calendar
formatting and case-insensitive built-in dispatch are reference-backed local
adaptations. See `docs/reference/bases-expression-matrix.md` for exact REA/artifact
evidence, wire responsibilities, deliberate limits and pending acceptance.
The earlier initial-API rejection notes above describe extraction history.

Status (2026-10-17): extraction and query engine integrated on main426d3a6c.
Scoped native expression/query/generation checks pass. Actual Chrome WASM runs
pass54 accepted Base cases (30 expressions,10 queries,7 generation cases and7
compile checks) plus10 malformed/options checks and2 current-entry witnesses, using the shared corpus. See
`docs/shared-document-semantics-plan.md` and its evidence ledger for exact source,
binary hashes and limits. These results establish the accepted scoped behavior,
not complete upstream builtin equivalence or measured performance improvement.
Normal Base controller migration passes actual browser/desktop checks; source-preserving editor
transformations remain TypeScript-owned. The reducer owns Zorid's filter/group-
order/search/sort/limit policy around row-scoped sessions of the reused evaluator.
Base YAML uses the document crate's Saphyr mapping decoder.

The small corpus test uses the shared accepted expectations from
`tests/fixtures/document-semantics/bases/expressions.json`, plus a few explicit
resource/host guards. Accepted corrections are frozen in the accepted fixture projections. It
is not a wholesale copy of upstream's oracle or a production-parity claim.

Duration completion (2026-10-22): fractional month interpolation in
`src/expression_duration.rs` is adapted from Moment 2.30.1's
`src/lib/moment/diff.js` (MIT, Copyright (c) JS Foundation and other contributors).
The complete notice is in `LICENSE-MOMENT`; no new dependency is introduced.
Source: https://github.com/moment/moment/blob/2.30.1/src/lib/moment/diff.js .
Duration addition uses separately implemented overflowing JavaScript calendar
setter semantics. Every conversion uses the captured clock and timezone, retains
finite/budget diagnostics, and preserves the existing explicit invalid-local-time
gap/fold policy. Reference evidence and verification boundaries are recorded in
`docs/history/bases-duration-reference-20261022.md`.

## Concrete List.sort collation (2026-10-22)

`src/list_sort.rs` uses the ICU4X Rust dependency for Unicode collation; it does
not implement an ad hoc natural-sort or locale approximation. The explicit
portable policy is English (`en`), `Strength::Primary`, `CaseLevel::Off`, and
`CollationNumericOrdering::True`, with compiled data and no runtime data download
or ambient operating-system locale lookup. The dependency and data versions are
locked below. Numeric collation compares decimal digit runs, rather than parsing
an entire text as a number. ICU handles canonical equivalence and the locale's
base-letter rules. See the official
[ICU4X 2.3.1 collator API](https://docs.rs/icu_collator/2.3.1/icu_collator/),
[options](https://docs.rs/icu_collator/2.3.1/icu_collator/options/struct.CollatorOptions.html),
and [compiled-data features](https://docs.rs/crate/icu_collator/2.3.1/features).

Reference basis: Obsidian 1.14.4 `app.js`, SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`,
Python Unicode character ranges `2196926..2197194` (List.sort) and
`1302374..1302462` (shared comparator). The shipped comparator uses
`Intl.Collator(undefined, {usage: "sort", sensitivity: "base", numeric: true})`.
The selected value slice is retained by REA Evidence
`ev_49e7bfdc2a564c07615cfa54720f5554fe8d64deaa251aa105a7958fdf532c3c`;
static source analysis does not establish runtime parity. Recovered proprietary
source remains outside this repository.

Only two actual Number operands take the numeric comparison branch. Other
operands use checked reference-derived text keys: String subclasses retain raw
string data; Dates use their formatted date/time text rather than epoch
milliseconds; Null uses `null`; List/Object/File/Error values use their checked
type-specific conversion. This is concrete list sorting, separate from the
reducer's row ordering and from Unicode scalar string indexing/slicing.

The reference's ambient locale is deliberately replaced by pinned English so
native, CLI and WASM use the same rules. This is not a universal-locale or
cross-version Intl equivalence claim. Mixed Number/String comparisons may be
nontransitive (numeric comparison for a pair of negative Numbers can disagree
with collation of those Numbers against a numeric-looking String). The bounded,
fallible index merge preserves the pairwise comparator and takes the left item
on equality. Its deterministic result does not promise the same permutation as
a particular JavaScript engine for inconsistent comparisons. No lexical or
ambient-host fallback is used if collator initialization fails.

The helper admits total text-key bytes and both index buffers against separate
8 MiB ceilings before allocation, charges both complete text lengths before each
collation call, and checks the invocation work/cancellation guard throughout the
merge. ICU comparison itself has no internal cancellation callback; cancellation
is observed between bounded comparisons. These admission limits are not a claim
to measure every allocation inside ICU.

Resolved new packages from the coordinated dependency fetch, with crates.io
package SHA-256 checksums verified against the cached `.crate` bytes and root
`Cargo.lock`:

| Package | Version | Package SHA-256 |
| --- | --- | --- |
| [icu_collator](https://crates.io/crates/icu_collator/2.3.1) | 2.3.1 | `08984ed58ac439ebf3e13d2cf26b0c46a60afcd21721c1d14087c0b240344dda` |
| [icu_collator_data](https://crates.io/crates/icu_collator_data/2.3.0) | 2.3.0 | `f7d7e54efdddeb1208c08dd5d32b53a879ac00d2d3d051b2255fd26821d16368` |
| [icu_locale_fallback](https://crates.io/crates/icu_locale_fallback/2.3.0) | 2.3.0 | `251af8e57c9400e3eb58242fe5b8b1152b2a64fdf4cf632f923c38ccee6f2fa9` |
| [icu_locale_fallback_data](https://crates.io/crates/icu_locale_fallback_data/2.3.0) | 2.3.0 | `decf2a22ec8fa68f1a0c1129a3f8583f8f8bc24e8b9ccbe98ead99f62a4dc3a8` |
| [utf16_iter](https://crates.io/crates/utf16_iter/1.0.5) | 1.0.5 | `c8232dd3cdaed5356e0f716d285e4b40b932ac434100fe9b7e0e8e935b9e6246` |
| [write16](https://crates.io/crates/write16/1.0.0) | 1.0.0 | `d1890f4022759daae28ed4fe62859b1236caebfc61ede2f63ed4e695f3f6d936` |

The four ICU4X packages above declare `Unicode-3.0` and contain byte-identical
LICENSE files. [LICENSE-ICU4X](LICENSE-ICU4X) is an exact copy, including the
ICU4C/ICU4J attribution, SHA-256
`f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2`.
`utf16_iter` and `write16` declare `Apache-2.0 OR MIT`; the combined ICU notice
does not replace their separate upstream notices. ICU4X 2.3 requires Rust 1.88.
The collator data package records CLDR 48.2.1 and ICU release-78.1rc as generation
inputs; data remains pinned by the package checksum rather than host ICU data.

Local fetched-package measurements (`du -k`, rounded allocated disk usage):
collator cache 1300 KiB / unpacked source 5836 KiB; collator-data cache 468 KiB /
unpacked source 3220 KiB. These are cache/source disk measurements, not measured
network transfer, executable, WASM, resident-memory or runtime-cost increases.
Matching native/CLI/WASM builds, size deltas and runtime acceptance require
separate recorded verification; the provenance addition itself establishes none
of those results.
