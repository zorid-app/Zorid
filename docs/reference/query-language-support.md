# Search and Bases language support

S1.0 baseline at source `5c10cbf3f5d0b66a0bf4496acc43a97d6cfc660b`, 2026-10-18.
This is a bounded support/deviation matrix, not full Obsidian compatibility or
native/browser runtime acceptance. Follow the [accepted design](../architecture/indexing-search-design.md),
[baseline protocol](../plans/indexing-search-baseline.md) and
[implementation slices](../plans/indexing-search.md). No query engine changes are
introduced by this record. Newly identified compatibility gaps are not authorized
behavior changes.

Primary references retrieved on 2026-10-18: [Search](https://obsidian.md/help/plugins/search),
[Bases syntax](https://obsidian.md/help/bases/syntax) and
[Bases functions](https://obsidian.md/help/bases/functions). These unversioned pages
define the documented target, not a frozen executable oracle. Existing
[search reference](../search-reference.md) and
[Base reference](../bases-query-reference.md) preserve separately bounded artifact
observations. Do not equate those observations, current implementation, approved
Zorid corrections and documented target behavior.

## Shared rich-search implementation checkpoint

As of2026-10-19, `a24a4fa5` adds the pure Rust
[rich evaluator](../../crates/zorid-index/src/search/mod.rs), dialect
`zorid-search-rust-unicode-1`. The historical matrix below still describes the
retained S1.0/live literal path; platform migration is pending. Do not interpret
that table as the capability inventory of the new pure evaluator.

The new evaluator supports default-insensitive search, the case-sensitive option,
scoped case modifiers, all-occurrence substring matches, Boolean/group/exclusion
operators, quotes, file/path/content scopes, typed properties/tags and parser-backed
line/block/section/task scopes. It reports invalid and unsupported syntax
separately from unavailable source/metadata. Filename, property and source ranges
have explicit distinct origins.

Regex uses pinned Rust Unicode scalar/simple-fold semantics, with no locale
folding or normalization. Lookaround, backreferences and suffix flags diagnose;
there is no JavaScript fallback. Quotes use Unicode Letter/Decimal_Number
boundaries. Root empty queries do not fabricate content ranges; headingless files
form one whole-source section. Frontmatter tag locations preserve the actual
selected property key. These deliberate provenance/engine choices are documented
in the module rather than presented as executable Obsidian parity.

The exact candidate `76d8e9d9` passed14 focused checks, covering19 accepted target
cases and36 explicit Unicode/regex cases, plus the unchanged literal baseline at
page sizes1/100. A4MiB dense control retains all8192 occurrences for ordinary,
quoted and plain-slash literals within unchanged work/output caps. Those are
correctness and work-accounting checks, not a measured CPU or app speedup.
Rich paging/counts/snippets/order, bindings and the grouped UI remain separate
implementation/runtime gates. The execution checkpoint tracks their evidence.

## S1.0 search matrix (retained baseline and live literal path)

Current shared Rust search is `literal-lines-exact-v1` in
[literal.rs](../../crates/zorid-index/src/literal.rs). The live shared desktop/web/CLI
path does not use the richer TypeScript [search parser/evaluator](../../src/search/query.ts).
Literal input that resembles an operator or regex is currently ordinary text,
not evidence that its operator was parsed and returned no matches.

The [S1 fixture](../../tests/fixtures/document-semantics/search/s1-language.json)
contains independently written exact expectations, separated into current Rust
literal hits and intended language results. Target comparison in TypeScript does
not establish target Rust implementation. The current Rust consumer runs every
fixture with page sizes one and one hundred, preserving snapshot/entry/revision,
byte ranges, UTF-16 ranges and completion. All fixture generations are complete;
partial coverage remains an integrated lifecycle gate.

| Capability / example | Current shared Rust | Intended language / fixture evidence |
| --- | --- | --- |
| Plain substring, punctuation | Exact case-sensitive content substring; first occurrence per matching line | Preserve substrings, including inside words and punctuation. `literal-inside-word`, `literal-punctuation`, `literal-no-match` |
| Case and occurrences | No case option; repeated same-line matches collapse to first hit | Default insensitive, explicit case modifiers; return all required normalized spans. `literal-case-and-all-occurrences`; broader case fixtures in existing search suite |
| Unicode/CRLF | Distinct half-open UTF-8/UTF-16 ranges; line handling is literal engine policy | Preserve exact source coordinates through migration. `unicode-crlf-ranges`; do not reinterpret scalar indexes as editor offsets |
| Adjacent terms, OR, negation, grouping | Entire input searched literally | Parse operators separately from content and preserve exclusion-only success. `implicit-conjunction`, `or-operator`, `content-group-negation`, `exclusion-only-success` |
| Quotes | Quote characters are literal | Keep reviewed content-boundary versus filename/path behavior. `quoted-word-boundary`; this finer distinction comes from the maintained Zorid contract, not a new inference from help wording |
| `file:`, `path:`, `content:` | No named scopes | Scope selection and attachment name/metadata coverage; `filename-scope` plus existing path/content fixtures. Attachment body extraction/OCR is outside S1 |
| Properties and tags | No property/tag operators | Evaluate saved typed metadata with correct source/range provenance. `property-value`, `tag-descendant`; no speculative nested-object query language |
| `line:`, `block:`, `section:`, task variants | No scope operators | Use exact parser-produced segment/task metadata. `line-local-negation`, `task-todo-range`; existing search suite covers other scopes. Supplying metadata to a pure test does not establish integrated metadata production |
| Portable regex | Slash syntax searched literally | Engine-supported subset with multiline/case/range fixtures; `regex-portable-multiline`. Freeze Unicode/case behavior explicitly before porting |
| Lookaround/backreferences | Slash syntax searched literally | Accepted unsupported advanced forms must diagnose, never become false matches or literal fallback. `regex-lookbehind-rejected`, `regex-constant-backreference-rewrite` |
| Invalid/unknown operators | Literal text | Structured language error, `unknown-operator-error`; target diagnostic category is specified, new Rust wire code is not invented here |

The regex rewrite fixture has exactly one fixed capture/backreference which can
be replaced by a constant pattern without changing search spans. It is not a
rewriter implementation or permission to erase arbitrary capture/condition logic.
The TypeScript comparison deliberately accepts these legacy JS-only patterns;
that observation proves the capability gap, not successful shared rejection.

[Search documentation](https://obsidian.md/help/plugins/search) supplies the
operator families; the local contract/fixtures preserve detailed precedence,
ranges and malformed-input behavior. Remaining migration fixtures include scoped
case combinations, partial metadata availability, attachment filtering, parser
limits and cancellation. Preserve explicit unsupported versus unavailable inputs;
no-match is a result only for an actually supported and sufficiently covered query.

## Bases syntax and execution matrix

Rust keeps a dedicated Base compiler/evaluator over shared index/query facts.
Sources: [program](../../crates/zorid-bases/src/program.rs),
[query](../../crates/zorid-bases/src/query.rs),
[expression](../../crates/zorid-bases/src/expression.rs) and
[graph](../../crates/zorid-bases/src/graph.rs).

[Bases syntax](https://obsidian.md/help/bases/syntax) documents YAML configurations,
filters/formulas/views, property namespaces and summaries. The table below is a
source audit of Zorid; implementation presence is not proof of every documented
edge case. The fixture's `baseOracles` pins existing accepted corpus bytes and
named cases. New evaluator results must not regenerate those expectations.

| Area | Current shared Rust evidence | Status / acceptance distinction |
| --- | --- | --- |
| YAML/source handling | Bounded shared YAML decoder; compilation preserves raw source ownership and unknown configuration | Existing document tests check BOM/CRLF/invalid YAML. Semantic compilation is not a source writer |
| Root/view filters | Recursive `and`/`or`/`not` and expressions; root/view composition in query reducer | `empty-or-composed`, `filter-error-isolated`; accepted direct Boolean correction, not optimizer-dependent truth |
| Formulas/namespaces | Formula dependency/cycle handling, `note`, `file`, `formula`, snapshot-selected `this` | `formula-dependency`, `formula-cycle`, `current-file-context`, generation current-entry cases; no live caller-supplied file facts |
| Sort/group/search/limit | Typed groups and stable portable ordering; visible-property search is distinct from vault full-text search | `default-natural-order`, `typed-group-keys`, `group-search-limit-pipeline`; counts refer to separate pipeline stages |
| File facts/relationships | Exact snapshot witnesses; generation-bound outgoing/embed/backlink resolution | `file-host-facts`, `complete-outgoing-embeds-unique-backlinks`, `incomplete-graph-is-unavailable`; unavailable graph is not an empty graph |
| View configuration | Type/name/order/sort/group/limit handled; unknown options retained | Retention alone does not mean an option executes. Zero/fractional limits and unknown views require explicit compatibility review |
| Summaries | Configuration can retain summary keys; no summary aggregate fields/execution in shared `BaseQueryResult` | Documented capability gap; list `sum`/`mean` helpers are not a complete view-summary engine |
| Scope/output ceilings | Query/work/rows/graph/byte budgets and explicit failures | Current 50k scan/10k row limits remain; a Base limit does not authorize silently truncating the input scan |

## Built-ins and known deviations

The function names below are inventoried from the current Rust dispatch paths;
this is not an assertion that all coercion, locale, invalid-input and rounding
cases match the [function reference](https://obsidian.md/help/bases/functions).

| Family | Current implementation | Remaining gap / evidence |
| --- | --- | --- |
| Globals | `if`, `escapeHTML`, `date`, `duration`, `list`, `min`, `max`, `now`, `number`, `today` | `if` is lazy; time is invocation supplied. Date formatting/parsing is bounded, not unrestricted Moment/JS compatibility |
| Any/object | `isTruthy`, `isType`, `isEmpty`, `toString`; object `keys`, `values` | Exact-first case lookup and source-order fixtures matter; preserve typed null versus false/zero/empty |
| String | contains variants, starts/ends, lower/title/trim, replace/repeat/reverse/slice/split, scalar `length` | Existing `contains` case-folds while containsAll/Any use direct matching; classify as an unresolved compatibility discrepancy, not a silently accepted intentional rule |
| Number/date | abs/ceil/floor/round/toFixed; date fields/date/format/time/relative | `number(date(...))` currently errors despite documented date conversion. Precision/format bounds and captured clock/timezone must remain explicit |
| Lists | contains variants, filter/map/reduce, flat/join, reverse/slice/sort/unique, sum/mean | Frozen context/callback semantics and work budgets; `list(null)` currently remains null. Its null edge lacks a new accepted compatibility decision here |
| Regex | `matches`, regex replacement/split via bounded Rust engine | Accepted portable subset; stateless repetition. Unsupported flags/patterns diagnose; no JS fallback |
| File | hasLink/asLink/hasProperty/hasTag/inFolder and file fields | Relationship access depends on exact graph coverage; mutations still require current source validation |
| Global host/value constructors | `random`, `file`, `link`, `html`, `image`, `icon` are explicitly rejected by the first matching global dispatch arm | Current deliberate capability restriction, not complete function support. Later unreachable constructor arms do not establish availability. No ambient IO/plugin callbacks are authorized |
| Link coercion | `asFile`, `linksTo` return unsupported | Documented capability gap. Supported file.asLink and parsed link values do not imply these operations work |

Current dispatch's prefix-number parsing, Unicode scalar string operations,
finite-result errors, stateless regex, typed structural groups and direct Boolean
filters are recorded separately in the
[accepted correction ledger](../stage4-base-contract.md#required-semantic-decisions-before-consumer-replacement)
and existing accepted fixtures. They must remain deliberate and visible even where
upstream's general JavaScript wording is broader. Configured/device-local timezone
and time-dependent visible-view invalidation are accepted S1 requirements; the
current shared Base UI's UTC input is still an implementation gap.

No behavior change is selected by finding a discrepancy. Add a narrowly sourced
oracle and review it against accepted product decisions before altering a builtin;
then update the support row and implementation evidence together. This avoids
optimizing a new dialect into the code accidentally.

## Evidence and next gate

Lightweight check: `node --test tests/query-language-baseline.test.ts` verifies
hand-counted coordinate witnesses, the TypeScript comparison, explicit legacy
regex differences and pinned Base-oracle identities. It does not execute Rust.
Current literal check: `cargo test -p zorid-index --test s1_language_baseline
--jobs 1` executes the frozen Rust oracle; run under the coordinator's serialized
resource slot. Existing Base corpus runners remain the semantic Rust checks; the
new hash check is an expectation-provenance guard, not Base evaluator execution.

Integrated macOS Electron, actual browser bindings and standalone/concurrent CLI
verification remain distinct gates. No mobile/other-OS runtime acceptance follows
from this matrix. Record exact checked commits and results in the execution
checkpoint, and measure optimizations against these fixed semantics.
