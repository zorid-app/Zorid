# Stage4 Base reuse boundary and behavior contract proposal

Historical S1 extraction/portability contract and evidence. Its current-query
observations remain useful; it does not define the new feature pass or authorize
old source assignments. Use the [Bases implementation goal](plans/bases-implementation-goal.md)
for current scope; named note Types are removed, rich property definitions remain,
and New copies complete template notes. Preserve the evidence below as recorded.

Current compiler semantic version: `zorid-base-yaml-expression-v4`, covering
shared summaries, property definitions, rich values, immutable file lookup and
captured random seeds. Earlier version decisions below retain their dated scope.

Prepared 2026-10-17 by `/root/stage4_base_reuse`, against Zorid
`f69dc90de0de697dfb75a5a3d1805b69dba982b3`. Scope is this document and
`tests/fixtures/document-semantics/bases/*`. Branch
`tingkai-c/stage4-base-contract`, Orca worktree
`/Users/ctk/orca/workspaces/Zorid/stage4-base-contract`. The shared-core
coordinator owns API decisions, dependency adoption, build scheduling and main
integration. No evaluator, root manifest, lockfile, editor or shared crate is
changed by this preparation. Subsequent coordinator authorization assigns source-only
implementation under `crates/zorid-bases/**` to the same worker, with dependency
review and a separate serialized build slot; it is not part of this preparation commit.

Recommendation: evaluate a small attributed extraction of MDBASE's **existing
Bases evaluator**, preserving Zorid's typed results and host authority. Do not
write a replacement formula parser or substitute MDBASE's CEL evaluator. The
extraction boundary is concrete, but no extracted code has been compiled or
adopted. The coordinator accepted the listed core corrections on 2026-10-17;
the passing baseline corpus asserts current TypeScript behavior only.

## Current implementation and ownership

| Zorid source | Current responsibility | Stage4 boundary |
| --- | --- | --- |
| `src/bases/document.ts` | YAML 1.2 core validation; safe immutable values; source-preserving document/view edits; comments, BOM and newline handling | Rust semantic compilation must not replace this editing/writing path. Invalid source remains readable/saveable/syncable. Unknown configuration survives. |
| `src/bases/expression.ts` | Lexer/AST, typed null/primitive/list/object/date/duration/regex/error values, own-property lookup, formulas, builtins, optional explicit JS registry, per-evaluation steps | Candidate reusable Rust semantics with explicit typed transport; keep ambient JS and IO inaccessible. |
| `src/bases/query.ts` | Host-fed detached files/version, filters, per-row formulas, visible-property search, natural sorting, groups/groupOrder, counts, diagnostics and limits | Use the coherent document index snapshot; retain all file extensions and host-supplied facts. Adapt query policy around reused expression logic. |
| `src/bases/controller.ts`, `session.ts`, views and toolbar modules | App lifecycle and table/cards/list/kanban presentation/actions | Remain in the web editor. No new plugin runtime or presentation engine. |

Tests inventoried: `bases-expression.test.ts` (operators, null/coercion, safety,
case lookup, registry, formula caches/cycles, list bindings, dates, regex and
budgets); `bases-query.test.ts` and `bases-query-review.test.ts` (pipeline,
configurations, snapshots, immutable results, host methods, groups/sort/errors);
`bases-document.test.ts` (lossless untouched bytes and scoped edits, unknown fields,
malformed YAML, aliases, BOM/CRLF). Session/controller/view tests cover consumers
and do not establish portable formula parity.

A source scan finds the registry seam in the expression and query modules, with
query-owned `toString`, `inFolder`, `hasProperty`, `hasTag` methods and test-only
custom registrations. This is not evidence of a required general extension API.
Rust builtins consume detached host facts; arbitrary callbacks must not cross
WASM/CLI or silently disappear. Any actual additional consumer gets a named
capability decision before migration.

## Pinned reuse evidence and extraction cut

Re-inspected upstream revision
`2e8f47f3a0737766060599cf9534582bd75aa719` using exact raw GitHub files. This
confirms the earlier [reuse assessment](history/document-semantics-reuse-assessment.md).
Browser fetches returned cache misses; direct HTTPS source fetch succeeded.
The manifest declares `mdbase 0.4.0-rc.6`, Rust 1.94, MIT. It has unconditional
bundled `rusqlite`, filesystem/capability/watch, CEL and schema dependencies;
`--no-default-features` only disables the legacy mutation feature. Importing the
whole crate is not the portable package boundary.
[Manifest](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/Cargo.toml).

| Candidate source | Keep/reuse | Required separation/adaptation |
| --- | --- | --- |
| `src/views/expression.rs` | Existing lexer, AST parser, evaluation/builtins, formula cache/cycle tracking, date/duration logic and relationship-dependency inspection | Only project-specific imports are runtime `Candidate*` types and `OperationCancellation`; remove candidate lowering from the minimal proof or place it behind a host-independent internal module. Adapt cancellation to Zorid's request guard. Expose typed values before `to_plain`; keep errors typed, not inferred from message strings. Add parser-depth and byte bounds before removing native `stacker`. |
| `src/views/files.rs` | In-memory file collection and lookup structure; no filesystem IO imports | Supplies `BasesFiles` used by expression context. Its name/suffix fallback resolution is a policy choice: Zorid's index resolver and complete snapshot remain authoritative. For the first proof use explicit paths only. |
| `src/views/model.rs` | Small serde Base/filter/view data structures; flattened unknown fields | Validate Zorid's stricter conjunction shape, view defaults, property IDs, sort aliases, fractional limit policy and nonempty names. Parse YAML separately; never use model serialization as a source writer. |
| `src/views/execute.rs` | Consider narrowly copying pure `evaluate_property`, `combined_filter_matches` and filter evaluation after dialect adaptation | Do not import collection discovery, record extraction, wall-clock capture, canonical views or source operations. Existing full sort/group code is not equivalent to Zorid policy. |
| `src/runtime/hosted_base.rs` | Reference for exact source/revision planning, explicit clock/timezone/work budgets and complete relationship-neighborhood requirements | Do not adopt `CompiledCatalog`, collection configuration/type defaults, provider storage, hosted plan digests or reducer as Zorid authority just to obtain evaluation. |

Sources: [expression](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/src/views/expression.rs),
[files](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/src/views/files.rs),
[model](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/src/views/model.rs),
[execute](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/src/views/execute.rs),
[hosted boundary](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/src/runtime/hosted_base.rs).

This cut reuses implementation rather than reproducing it. Prefer an upstream
portable feature/package if practical; otherwise place the attributed extraction
in one clearly owned internal module and record copied file ranges, upstream
SHA, modifications and full MIT notice. Retain `Copyright (c) 2025 Callum Alpass`.
This preparation copies no upstream implementation into Zorid.
[License](https://github.com/callumalpass/mdbase-rs/blob/2e8f47f3a0737766060599cf9534582bd75aa719/LICENSE).

The expression module directly needs `chrono`, `chrono-tz`, `regex`,
`fancy-regex`, `serde_json` and `stacker`; model parsing adds `serde`.
An extraction must remove/replace `stacker` after bounded nesting is in place.
Pin `chrono` without ambient clock/local timezone support and pass an explicit
clock/timezone. `chrono-tz` enables a shared IANA dataset; measure its WASM size.
`fancy-regex` is a backtracking fallback used by `matches` only and bypasses the
AST step counter; it must have an explicit backtracking limit or unsupported
patterns must fail with a diagnostic. Regex replacement/splitting use `regex`
and already differ from that fallback. Do not claim JavaScript regex parity.

MDBASE's parser cache is limited to 1,024 entries but not source bytes; it clears
wholesale at capacity. Its regex cache is also entry-limited. Its evaluator
charges AST nodes, including formulas/list callbacks, and supports cancellation,
but a single builtin, allocation or regex may do substantial work between checks.
The extraction needs both byte/result ceilings and operation-wide accounting.
These gaps do not justify implementing a new formula engine.

## Required semantic decisions before consumer replacement

The corpus records existing results; `retain` is the proposed compatibility
choice, and `proposed-change` marks deliberate corrections accepted by the coordinator on 2026-10-17 (finite results, Unicode scalars, stateless regex, typed grouping, direct Boolean filters, explicit clock/timezone with default UTC, invalid date null, source-ordered exact-first case lookup and deterministic natural ordering). Broader local-input DST gap/fold policy and final public API remain proposals. Retain
rows are still unproven against MDBASE. Below are concrete adaptations, not
claims that the upstream library already matches them.

On 2026-10-19 the root coordinator approved one narrow builtin correction:
`today()` and `Date.date()` truncate a valid instant to the earliest representable
instant of the **same local civil date**, choosing the earliest midnight in a
fold. A midnight gap uses its first valid instant only if that instant remains
on the requested date; otherwise return `invalid-local-time`. Never reinterpret
nonexistent local midnight as UTC. This changes the Base compiler version to
`zorid-base-yaml-expression-v2`. Strict `date(string)`, typed date-property
parsing and calendar-arithmetic input handling stay unchanged. Refresh deadlines
have a separate policy: the next wake may cross a wholly skipped civil date.
New focused literal oracles record this correction; the frozen accepted corpus
is not regenerated. Source implementation does not establish executable or
native acceptance.

| Area | Current evidence / upstream difference | Proposed Zorid rule |
| --- | --- | --- |
| Null and truth | TS `!null`, `null < 1`, `null + 1` produce null; missing is null; empty lists/objects are false. MDBASE unary `!` applies ordinary truthiness and treats composite values as true. | Retain typed null propagation and current empty-container truth rules. Null must never become numeric zero implicitly. `null.toString()` remains `"null"`. |
| Equality/coercion | TS equality allows `"2" == 2`, `true == 1`, singleton-list coercion, but null differs from false/zero; arithmetic `"2" * 3` is a type error. MDBASE arithmetic number conversion accepts string/bool/null and equality largely compares plain JSON. | Retain the explicit current equality/arithmetic distinction and `number("12tail") == 12`; implement as a documented adapter to reused operators. |
| Nonfinite numbers | TS returns Infinity/NaN; MDBASE plain JSON output converts them to null. | Proposed: typed `numeric-domain` diagnostic for nonfinite numeric results. Never silently turn numeric failure into missing data. |
| Unicode | TS length/index/slice/reverse use UTF-16 code units, allowing broken surrogate reversal. MDBASE length/reverse use Unicode scalars. | Proposed: Unicode scalar string operations consistently across consumers; `"A😀é".length` is 4 and reversing `"A😀"` is `"😀A"`. No grapheme-cluster promise. Keep editor offsets separately UTF-16. |
| Regex | Reusing the same TS AST `/a/g.matches("a")` produces true, false from `lastIndex`; MDBASE matching is stateless. | Proposed: repeated evaluation gives true, true. Specify accepted flags/pattern subset and bounded fallback; unsupported regex yields a diagnostic, never false. |
| Property/formula names | TS own-property exact spelling wins, then first case-insensitive match; namespaces case-insensitive. MDBASE identifiers/formulas read exact map keys. | Retain exact-first case-insensitive behavior with stable source-property order. Define collision selection before building BTreeMap-backed values; do not lose insertion order in an adapter. |
| Current file | TS `this` refers to supplied current-file context and is null if absent; supports note/file/formulas. MDBASE `this` creates a file wrapper and falls back to the current candidate. | Retain Zorid's explicit optional current entry. No accidental candidate-relative fallback; no live vault lookup. |
| Dates | TS ambient local timezone and JS rollover; MDBASE explicit fixed/IANA/local zones; invalid parse falls back to epoch. `to_plain` erases date type. | Require invocation clock + timezone (default UTC if omitted); preserve date-only versus datetime tags and instant milliseconds. Invalid date returns null, never epoch. Preserve current date-only equality on calendar day. Reject nonexistent/ambiguous local times with diagnostics until a precise policy is accepted; no platform-dependent fallback. |
| Calendar durations | TS calendar arithmetic depends on local DST/month rules; comparisons use invocation clock. | Use the same explicit timezone and captured clock for the whole query; calendar days/months differ from fixed milliseconds. Confirm DST/month-end in the portable proof. |
| Filters | TS optimizer can erase empty OR during root/view composition and has surprising double-NOT rewrites. MDBASE's pure recursive conjunction does not need that optimization. | Proposed: direct Boolean AND of root/view, OR([])=false, AND([])=true, NOT-list=NOR; preserve short circuit and row diagnostics. |
| Sorting | TS default is file.name, numeric/case-insensitive locale comparison, then stable path pre-sort. MDBASE defaults/ties use exact path, string lexical order and reverses null ordering for DESC. | Keep useful natural file.name default; replace ambient locale with one specified portable comparator. Null last for ASC/DESC before Boolean comparison. Same-type numbers/dates compare numerically. Exact vault path breaks ties. Comparator details below are pending, not implicitly inherited from MDBASE. |
| Grouping | TS loose equality combines number 2 and string "2"; list keys remain whole. MDBASE canonical JSON separates types. | Proposed: typed structural group identity; 2 and "2" separate, lists remain whole; null last. Group order uses the selected total comparator. Preserve explicit groupOrder filtering and pre-search counts. |
| Query pipeline | TS root/view filters → explicit groupOrder inclusion/counts → visible-property search → sort → limit → display groups. MDBASE model does not implement Zorid's groupOrder/search pipeline. | Retain this pipeline and all five counts. Empty configured columns remain empty. Reuse evaluation inside Zorid's reducer, not upstream collection execution. |
| Errors and source | TS distinguishes parse/type/access/unknown-function/unsupported/cycle/budget; upstream primarily returns String errors. | Stable diagnostic codes and phases, source property/expression range when available. Invalid filter excludes affected row with diagnostics; invalid value stays typed error. No raw-source mutation; unknown view types/options remain data. |

Coordinator-approved initial sorting rule: use deterministic Unicode lowercase
mapping without locale or normalization, compare ASCII digit runs as integers
without overflow, then scalar lexical text; compare equal numeric runs by later
text and finally exact path. Apply a fixed type rank for mixed non-null values
(Boolean, Number, Date, Duration, String, List, Object, File), with structural
comparison for lists/objects; errors sort after valid values with diagnostics.
Use scalar lowercase mappings from the pinned Rust toolchain for the initial implementation and version the dialect on changes; do not use host Intl. This requires explicit
non-ASCII/case/digit/tie fixtures before acceptance; multilingual/digit/null fixtures now freeze representative cases but do not prove all collation behavior. Prefer an existing portable collation component
if broader locale-aware UX is desired; do not accidentally adopt host Intl output.

## Host authority and request/result requirements

Coordinator will settle API names/types; the following are semantic requirements:

- Plan input binds exact Base entry ID/content revision, selected view, dialect
  schema, optional current entry, explicit operation clock/timezone and limits.
  YAML parse diagnostics are separate from raw-file validity. A synthesized empty
  default view exists in the semantic result only; do not serialize it to a file.
- Evaluation consumes one immutable published index generation and per-entry
  IDs/content revisions, typed properties plus host file facts. Include binaries
  and unknown file types as rows where host metadata exists; never reinterpret
  their bytes. Preserve literal dotted/prototype-like property names safely.
- Path/ctime/mtime/size/tags and resolved relationships come from that snapshot.
  Unavailable ctime is null, not zero or wall clock. Missing relationship input is
  an explicit unsupported/incomplete condition, not an empty graph. Link resolver
  decisions come from Zorid's index policy, not an imported storage layer.
- Result carries generation/Base revision, rows keyed by stable entry IDs and
  revisions, typed values, groups/options/counts and diagnostics. Path is a
  snapshot attribute; rename does not change identity. Recompute on content,
  metadata, path, Base revision, dialect or current-context changes. No cache key
  is just a filename or caller-reused generation token.
- Evaluation is local to authorized clients with decrypted inputs. No server
  plaintext query/index requirement, network fetch, filesystem mutation, plugin
  execution or renderer callbacks. Derived indexes/plans are disposable device
  data. Stale publication/cancellation must never rewrite or lose a raw file.

Initial bounded proof defaults proposed for review: Base source 256 KiB,
expression 64 KiB, nesting 128, 100,000 AST steps per expression, 2,000,000 steps
per query, 10,000 returned rows, 5,000 groups, 8 MiB encoded result and bounded
parse/regex caches by both entries and bytes. Host can lower ceilings. These are
starting limits to measure, not implemented restrictions or a vault-size cap.
Charge list/formula recursion and large builtin work against the request budget;
check cancellation between records and inside long work. Exceeding a limit yields
an explicit incomplete/failed result, never an apparently complete truncated set.
Execute browser work off the UI thread; hard timeout/worker cancellation supplements
cooperative limits. Benchmark one realistic 1,000-row snapshot before changing
limits or claiming speedups. No broad performance campaign is needed now.

## Local readiness and smallest executable proof

Read-only machine inventory: native `rustc 1.99.0` (Homebrew); default rustup and
Homebrew sysroots list only `aarch64-apple-darwin`. This is a check of the default
visible toolchains, not a claim that other sessions' WASM environment is absent.
Cargo source cache has `chrono 0.4.43/0.4.45`, `regex 1.12.3/1.13.1`,
`serde 1.0.228/1.0.229`, `serde_json` several 1.0 versions, `fancy-regex 0.14.0`,
`wasm-bindgen 0.2.129`; **no chrono-tz or stacker source directory was found**.
No MDBASE source was found in scoped project/workspace/tmp/Cargo scans before
this task. Read-only fetched files now reside at
`/private/tmp/zorid-stage4-mdbase-*`; they are not an installed crate or complete
repository cache. No dependency install, toolchain download or Rust build ran.

Next proof, only after coordinator selects the dialect and authorizes the slot:

1. In a disposable isolated crate outside root manifests, copy only attributed
   evaluator/file modules, the few model types needed, and MIT provenance. Keep
   parser/AST/evaluation logic; remove candidate-provider lowering, replace native
   stack growth with enforced depth limits, and expose typed results. Stub neither
   formula results nor semantic operators. Pass explicit UTC first; bring IANA
   support after resolving `chrono-tz` availability rather than fabricating it.
2. Resolve/pin the minimal dependency graph above with coordinator approval; no
   whole MDBASE crate/CEL/SQLite/watch installation. A full dependency audit and
   complete upstream oracle are unnecessary for this bounded feasibility proof.
   Inspect selected transitive notices and unsafe/native boundaries.
3. Run the shared expression subset natively using `cargo test --offline -j 1` in
   the assigned serialized build slot. Record unadapted mismatches. Add only the
   agreed semantic adapters and rerun. Include formula cycle, null/coercion,
   Unicode, repeat regex, dates and a budget rejection; then the query pipeline.
4. Use the coordinator's existing browser WASM toolchain/build convention rather
   than downloading one independently. Run the identical accepted corpus in an
   actual browser worker; a native pass or successful WASM compile is insufficient.
   Confirm tagged dates/errors and immutable snapshot round trip. Measure one
   1,000-row fixture latency/output size against TS with the same clock/timezone.
5. Integrate the confirmed module only after independent scoped review. CLI first
   or another named consumer may follow; leave TS runtime consumers intact until
   their actual path passes. Editor source-preserving Base edits remain separate.

Main integration, executed native/WASM reuse, final dialect/comparator, IANA/DST
policy, fine-grained typed error adapter and actual consumer equivalence remain
open. This document does not claim Stage4 implementation acceptance.

## Preparation verification

Fixture corpus: 30 expressions, 10 query snapshots, 7 Base sources. The lightweight
`verify-current.mjs` runner checks the current TS baseline under UTC, including
snapshot/source immutability and selected diagnostic fields. It deliberately
does not assert pending `proposed` values against current code. JSON includes no
upstream oracle data or copied implementation. `portable-cases.json` specifies
additional pending portability checks and is not executed by this runner.

Command from a checkout with existing dependencies:

```sh
TZ=UTC node tests/fixtures/document-semantics/bases/verify-current.mjs --source-root /Users/ctk/Projects/Zorid
```

Observed 2026-10-17 on the baseline source: **47 passed, 0 failed**, Node 26.10.0.
An initial expected ordering in `typed-group-keys` was corrected after the runner
showed numeric key 2 before whole-list [1,2], consistent with the source comparator.
No broad suite, native app, Rust reuse or WASM check is claimed. This runner is
preparation evidence and does not add a second production formula engine.

## Generation-bound implementation checkpoint (2026-10-17)

The attributed extraction is now implemented in `crates/zorid-bases`. The
coordinator's native proof at candidate `0ce5cd40` passed the accepted 30 expression
and 10 query cases and focused guards. That evidence predates the generation
factory below; it does not establish current API, WASM or consumer acceptance.
The original TypeScript fixture observations remain unchanged, including the
legacy broken UTF-16 reverse string. `project-accepted.mjs --check` validates the
scalar-safe accepted transport projection using only explicitly approved fixture
expectations, never Rust results.

`query_generation` and `BaseSnapshot::from_generation` derive rows, type hints,
tags and relationships from the same immutable `zorid_index::Generation`. Optional
`FilePresentationFacts` can supply only size/ctime/mtime and must match strong
entry/revision witnesses. Rows and graph are sealed together. A current-record
context must exactly match a canonical row; caller metadata cannot override it.
Actual validated `IndexSnapshotId` is returned, with decimal-string generation
serde owned by the index. The native facade separately binds the Base document's
entry/revision and retained raw source. Detached expression contexts may omit a
file and witness; `1+1` does not invent an entry ID.

Accepted Zorid relationship semantics: `file.links` contains every outgoing parsed
occurrence including embeds, in parser order; `file.embeds` is its embedded subset.
`file.backlinks` contains unique incoming source files by stable ID, preserving
shared namespace order. Link values retain the parser's semantic destination,
optional resolved target entry/revision, and shared resolver external classification.
`file.hasLink` recognizes an exact written destination even when unresolved;
other target comparisons use one prebuilt shared Rust index resolver. Rename and
content revisions rebuild relationships. No imported suffix/name fallback is an
authority. Link-to-file coercion remains explicitly unsupported.

Missing or incomplete relationships return `unavailable` diagnostics, never an
invented empty complete graph. `relationshipsAvailable` reports coverage. Detached
snapshot transport rejects any non-null supplied relationship report: only the
Rust-owned generation factory can provide a graph. The canonical
`accepted-generation-queries.json` hand-authored oracle covers duplicate outgoing
links, embeds, unique backlinks, missing/external targets, a target move, source
retargeting and incomplete coverage, for identical native/WASM requests. New
factory source/tests are uncompiled until the coordinator's serialized proof.

Caller ceilings are checked before generation preparation, with record/property/
edge work lower bounds; hint/discovery lookup uses hash membership, preserving
first-seen order without quadratic scans. A shared graph is bounded to 100,000
edges and 64 MiB; rows to 64 MiB, results to 8 MiB. Cancellation is checked before
and after the shared index snapshot operation and between preflight records.
The current index snapshot API has no per-edge cancellation seam; the bounded
synchronous snapshot call remains a stated cooperative-cancellation gap, not a
claim of immediate interruption. No file write, IO resolver fallback, plugin
callback or ambient clock enters this crate.

Factory review follow-up: the 64 MiB ceiling is aggregate serialized snapshot
input (identity/envelope, ordered rows, current revision metadata issues and graph),
not 64 MiB per component. A counting writer rejects oversized encodings without
allocating a full oversized buffer. Exclusions and shared parser diagnostics carry
entry/revision witnesses in `metadataIssues`; `metadataComplete` requires a real
generation and available property extraction. Access to unavailable properties is
an `unavailable` error, so a filter cannot silently reinterpret failed extraction
as an ordinary missing property. Binary exclusions remain distinct from unreadable
or resource-excluded source.

The cancellation gap above is closed in the current source by the Index-owned
`ResolutionView::snapshot_checked` and `ResolutionSnapshot::resolver_checked`
seams. Generation construction, namespace projection, candidate scans and graph
occurrences charge one shared operation budget and check local Rust cancellation;
`file.hasLink` uses `candidates_checked` against its expression budget. Factory
preparation steps are included in the returned query total. These callbacks are
private Rust operation guards, never serialized capabilities or JavaScript/plugin
hooks. The canonical compiled/browser proof still belongs to the coordinator.

Canonical graph corpus correction after the first compiled factory run: ordinary
external Markdown URLs are intentionally omitted by the frozen document parser.
The external graph probe therefore uses `https%3A%2F%2Fexample.com`, preserving
that encoded semantic destination in the Link value while the shared resolver
classifies it as external after percent decoding (same input pattern as index
fixture commit `3dee860d`). An additional ordinary external URL remains in source
and is absent from the exact four-element outgoing list. This changes fixture
inputs/oracles coherently; it does not change extraction or derive expectations
from engine outputs. Graph `expected.values` declares selected row/cell observables;
undeclared columns are not an oracle. Declared typed lists and link fields remain
exact, errors freeze codes, and JSON numbers compare by numeric value.

The first actual Chrome Base corpus run reported 50/51 cases and all five request
checks passing; the single failure was the detached missing-relationship fixture
still expecting the historical TypeScript `unsupported` code. The generation
backed contract above already distinguishes absent/incomplete relationship input
(`unavailable`) from an unimplemented operation (`unsupported`). The original
`queries.json.current` observation is preserved. Its explicit approved `proposed`
expectation now selects `unavailable` through the accepted projector whitelist;
no engine output was used to generate an expectation and no evaluator behavior
changed. The actual failed browser report/results remain acceptance evidence;
this fixture correction requires the native detached query corpus and actual
browser Base corpus to rerun before a pass is recorded.


## Retained current-entry query option

The normal document service accepts `currentEntryId?: string` and
`maxSteps?: number` alongside its existing Base options. `currentEntryId` is a
strong entry ID, never a path or caller-authored record. Rust selects `this` from
that exact retained generation's canonical row, including its revision, ordered
properties, type hints, tags and host-owned presentation facts. Missing IDs and
folder IDs fail explicitly with `stale-source`; an additional conflicting
`evaluation.currentRecord` fails rather than overriding the selected row.
Omission preserves the existing no-`this` behavior for other API consumers. The
normal Base controller explicitly selects its Base entry by default, or the
stable ID corresponding to its requested current-file path. A non-Markdown
`.base` row has empty note properties and retained file facts; its configuration
mapping is not imported as note properties. Dirty editor overlays are not query
context authority.

`maxSteps` is a positive integer no greater than 2,000,000 and maps directly to
the portable query work ceiling, including generation preparation. Omission
retains the existing 2,000,000 query ceiling. It does not replace the independent
per-expression ceiling. Clock and maxRows defaults are unchanged. The shared
canonical generation corpus adds `.base` context, Markdown context and omitted
context cases for native/WASM parity; new source requires the coordinator's
serialized native/WASM proof before those additions are verified.


Only omission defaults the new selector/step options. Present `null`, duplicate
fields and malformed strong IDs are rejected in raw Rust and WASM decoding as
well as admitted JS transports. Shared diagnostics keep codes such as
`stale-source` and `numeric-domain`. The desktop stdio outer error category maps
hyphens to underscores (`stale_source`, `numeric_domain`) to obey its existing
strict frame grammar; typed diagnostics inside successful query reports retain
the shared codes. Unexpected non-category spellings become
`document_query_failed`, never an invalid frame or arbitrary caught text.


## Opaque group presentation identity

Rust returns `BaseGroup.keyId: string | null` and `GroupOption.keyId: string`.
The only null identity is the ungrouped sentinel (`BaseGroup.key == null` at the
outer optional level). A real grouped typed-null value has its own non-null
identity. Tokens currently use `base-key-v1:` plus the existing canonical typed
value representation; they are stable across snapshots and refreshes but are not
snapshot capabilities, source IDs or an editing authority. Consumers copy and
compare tokens exactly without parsing, normalizing, hashing or rebuilding them.
They must not use JavaScript's loose expression equality for group membership.

The existing canonical policy preserves number/string/list distinctions and date
`hasTime`, normalizes signed numeric zero, and recursively ignores object entry
order for grouping. No expression equality, formulas, ordering or source values
change. Tokens are included in the existing serialized result byte ceiling.
Native source tests cover those distinctions and recursive object equivalence;
accepted query expectations include reviewed literal identities for shared
native/WASM checks. TypeScript fixture projection carries those literals and
implements no independent canonicalization algorithm.
