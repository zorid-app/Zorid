# Bases expression and rich-value implementation matrix

Owner: `bases_expressions`; branch `codex/bases-expressions`; isolated worktree
`.worktrees/bases-expressions`. The integration coordinator owns main and the
cross-platform acceptance record. This matrix covers built-in expression
capabilities, not community plugins, arbitrary JavaScript, or whole-app parity.

## Reference authority

Official inventory: [Obsidian Bases functions](https://obsidian.md/help/bases/functions)
and [Moment formatting](https://momentjs.com/docs/#/displaying/format/). The shipped
Obsidian artifact supplies the more precise implementation reference when its
function behavior differs from a prose description.

Inspected artifact: Obsidian 1.14.4, retained only outside project source at
`/private/tmp/zorid-obsidian-reference-20261021/1.14.4-app.js`, SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
No recovered proprietary implementation or assets are committed.

REA analysis of seven exact registration expressions for `file`, `link`, `image`,
`html`, `icon`, `asFile`, `linksTo`: parent Evidence
`ev_c32894444b6eccf2eb01a3512eb76c4c728fdac62d94f989960c81c753467464`;
2,391 bytes, 735 AST nodes, zero parse failures. Retained extracted file
`/private/tmp/zorid-bases-expression-reference/rich-values.js`, SHA-256
`0bcd3ac30b572ccdfc76e88e57c320cbac0db69e487af411e0eaacb5d30a97ef`.
Additional exact `random`, `date`, `number`, `min`, `max` expressions: parent
Evidence `ev_1d006a595ebc4f81549ee54555dcc53e6ff5a12e6ac6cf3dc15b48b176836ad4`;
2,388 selected bytes, 745 AST nodes, zero parse failures.

Ordinary frontmatter interpretation was separately inspected with REA: parent
Evidence `ev_e2499feaa9ea6ba1b78f7e8f3ce2f4880b9084bfbe387ee1c6ab7060a967c565`,
451 selected bytes, 138 AST nodes, zero parse failures; exact `fromFrontMatter`
assignment at decoded character range 2201077–2201527. Strings are interpreted as
wikilinks, then URLs, then dates; lists/nested objects reuse that interpretation.
This does not require a note Type or property registry. Direct exact-source
readings of helpers `QC`/`$C` at characters 860507/860579 establish URL-constructor
validation and the additional no-literal-space frontmatter guard.

These are static syntax observations. Unknown dynamic relationships remain;
none of these counts establishes observed reference execution. An initial
40,400-character broad slice failed parsing and was replaced with complete
registration expressions; it is not positive semantic evidence.

Useful character ranges in the exact full artifact (UTF-8 decoded character
indices, end-exclusive; they are not byte offsets):

| Registration | Range |
| --- | --- |
| link | 2218446–2218916 |
| image | 2219803–2220206 |
| icon | 2220207–2220450 |
| file | 2220451–2220860 |
| html | 2220861–2221104 |
| linksTo | 2239625–2239946 |
| asFile | 2239947–2240236 |
| random | 2217150–2217389 |
| date | 2216085–2216852 |
| number | 2218917–2219498 |
| min / max | 2217390–2217788 / 2217789–2218187 |
| Date.format | 2236156–2236452 |

Direct static readings also establish case-insensitive built-in lookup in the
registry, String inheritance for rich/Link/URL values, case-insensitive
`String.contains`, UTF-16 splitting in String.reverse, and Moment delegation for
Date.format. Those additional readings are exact-file evidence, not additional
REA runtime observations.

## Capability inventory

“Implemented” describes source, not completion of native/WASM/app acceptance.
Focused test status is recorded in the verification section and the integration
ledger. Global/member names use the reference's case-insensitive dispatch.

| Family | Built-ins and values | Implementation / acceptance coverage |
| --- | --- | --- |
| Syntax and scope | literals, lists, regex literals, unary/binary operations, named/computed access; note/file/this/formula namespaces | Existing portable parser/evaluator; bounded AST chains/depth. Unknown syntax has diagnostics. Existing accepted corpus and query/current-record tests cover the supported dialect. |
| Global scalar | `if`, `escapeHTML`, `date`, `duration`, `list`, `max`, `min`, `number`, `now`, `today` | Implemented. This pass closes Date identity/compact date parsing, number(Date), null/empty min/max, nullable HTML escaping and invalid-duration null. `if` remains lazy. |
| Ordinary properties | Wikilink, URL, ISO date/datetime inference recursively through lists/objects | Pure `infer_frontmatter_value` helper; lib/graph owner attaches source-witness resolution with bounded traversal. Explicit property settings may suppress automatic interpretation. Compact numeric date forms require explicit date(), preserving ordinary numeric text. |
| Global rich/file | `file`, `link`, `html`, `image`, `icon` | Implemented typed outputs. No global JS evaluation or ambient vault callbacks. File resolution uses sealed generation namespace; existing files are hydrated from that same generation. |
| Random | `random` | Implemented portable SplitMix64, seeded by host view-load entropy plus row identity/revision. Host preserves seed during refresh and replaces it on a new Base session. This differs intentionally from ambient `Math.random`; the output contract remains a number in [0,1). |
| Any value | `isTruthy`, `isType`, `toString`, `isEmpty` where applicable | Implemented; rich wrappers inherit String and URL has its own type. Existing empty/truth corpus retains explicit Zorid choices. |
| Date fields | year/month/day/hour/minute/second/millisecond | Existing typed date values, explicit UTC/fixed/IANA timezone, no ambient clock. |
| Date methods | `date`, `format`, `time`, `relative`, `isEmpty` | Implemented. Formatter now uses a bounded Moment token scanner instead of replacement into strftime. Relative text remains English. |
| Date formatting | calendar years, month names/numbers, ordinals, quarters, weekdays, ordinal day, locale/ISO week/year, 12/24-hour time, fractions, offsets, Unix timestamps, English long/localized formats, bracket/backslash literals | Implemented in `expression_format.rs`; expansion/bytes bounded. Captured timezone drives offsets including DST. Era/locale language customization is not claimed. |
| String | length, `contains`, `containsAll`, `containsAny`, `endsWith`, `isEmpty`, `lower`, `replace`, `repeat`, `reverse`, `slice`, `split`, `startsWith`, `title`, `trim` | Implemented, including regex replacement and split. Unicode scalar behavior is deliberately preserved; see limits below. |
| Number | `abs`, `ceil`, `floor`, `isEmpty`, `round`, `toFixed` | Existing bounded implementation, nonfinite results diagnose instead of crossing the transport as NaN/infinity. |
| List | length/indexing, `contains`, `containsAll`, `containsAny`, `filter`, `flat`, `isEmpty`, `join`, `map`, `reduce`, `reverse`, `slice`, `sort`, `unique` | Existing list evaluator with callback value/index/acc scopes. Numeric/date reducers also support summaries. |
| Link | `asFile`, `linksTo`, inherited String functions | Implemented. `linksTo(file)` follows the shipped direct target-identity comparison, rather than interpreting the prose description as a second-hop graph traversal. Missing targets remain null/false; missing metadata is unavailable. |
| File | name/basename/path/folder/ext/size/properties/tags/links/embeds/backlinks/ctime/mtime; `asLink`, `hasLink`, `hasProperty`, `hasTag`, `inFolder` | Existing metadata and graph APIs plus same-generation cross-file hydration. No empty placeholder files for unresolved or unavailable records. Property unavailability does not masquerade as absent fields. |
| Object | `isEmpty`, `keys`, `values` | Existing ordered own-property values, including nested source collisions; exact spelling wins over case-insensitive fallback. Object literals are not part of the supported expression dialect. |
| Regex | `matches`, String.replace/split | Existing bounded Rust regex implementation, no JS runtime. Unsupported features diagnose explicitly. |
| Formulas | named/computed references, per-row caching, lazy branches, cycles | Existing evaluator; rich outputs retain their type through formulas and summaries. |
| Summaries | `values` scoped typed expressions, file/link/rich round-trip | Summary expressions receive the same prepared immutable file map. No aggregate depends on mounted DOM rows. Summary owner maintains built-in/custom reducer inventory separately. |

## Wire and host responsibilities

`BaseValue` adds `{type: 'html' | 'image' | 'icon', value: string}`. Existing Link
fields remain; optional `displayValue` preserves an arbitrary typed label while
`display` remains the readable string fallback. File outputs remain canonical
paths; resolved links include a stable identity/revision witness. File metadata is
not serialized into every cell.

Rust outputs are inert. TypeScript must use the existing sanitization/resource
paths for HTML and images, approved icon rendering, ordinary safe link navigation,
and recursive rich-label rendering. Returning HTML does not authorize scripts,
event-handler execution, unsafe URL schemes, plugin callbacks, or an independent
TypeScript expression evaluator.

URL classification reuses already locked/cached `url` 2.5.8 with default
features disabled. It implements WHATWG parsing without network/host lookup;
malformed HTTP hosts and ports are not promoted to URL values by a scheme-only
regex. IDNA uses the existing static compiled data. New WASM compilation and
artifact sizing still require the coordinated build slot; dependency compatibility
is source-reviewed, not a claim that the final WASM artifact has passed.

`EvaluationOptions.randomSeed` is optional; omission deterministically uses zero.
The UI supplies a cryptographically sampled 32-bit integer once per Base session.
That seed is part of query identity. Native and WASM must interpret identical
seeds/records equivalently; no native-only random dependency is added. Random is
not a timer dependency. Unknown dynamic calls still conservatively refresh.

## Deliberate portability limits and unresolved acceptance

- Rust regex does not support JavaScript lookaround/backreferences or all JS
  flags. Such patterns return `unsupported`; they are never silently treated as
  literal text. Stateful JS regex `lastIndex` behavior is not copied.
- Existing Unicode string operations count and slice Unicode scalars, preserving
  valid Rust strings. They do not produce JavaScript lone-surrogate strings when
  reversing/slicing astral characters. Existing accepted Unicode cases document
  this choice; exact JavaScript UTF-16 edge parity is not claimed.
- Dates require an explicit valid UTC/fixed/IANA invocation timezone. English
  names/relative/localized format expansions are implemented; arbitrary Moment
  locale packs and era-specific calendar formatting are not supplied.
- Arithmetic nonfinite outcomes, resource/depth/cancellation boundaries, missing
  metadata and unsupported syntax remain explicit diagnostics. External file
  edits and incomplete metadata are not repaired by expression evaluation.
- Community-provided global/member functions and arbitrary plugin HTML execution
  are outside this first-party Bases implementation.
- Static source inventory is not an exhaustive cross-product oracle for every
  coercion/arity/locale/numeric/Unicode edge. Ordinary functional scenarios and
  deliberate deviations must be reported separately from full reference parity.

## Verification record

Authored focused unit tests cover inert rich payloads, recursive rich labels,
summary round-trip/depth/bytes, nullable/typed wrappers, String inheritance,
ordinary recursive frontmatter inference, malformed URL classification,
AST-only contextual `this` detection,
case-insensitive dispatch, file→link→file property preservation, missing-file
metadata diagnostics, direct linksTo identity, deterministic row-specific seeded
random bounds, scalar conversions and English Moment formatting/literals/offsets.

The accepted shared expression fixture replaces the obsolete `random()` rejection
case with independently authored `random() >= 0 && random() < 1` expected true,
seed 14. Historical `expressions.json` is preserved. Native/WASM use the same
accepted fixture; expectations were not generated from current implementation.

The early composed coordinator source `fce7459d` passes 11 rich/inference/URL/
context tests, two Moment-format tests and seven adjacent corpus test functions
(the latter includes 30 accepted expression cases). Commands used release,
`--offline --locked -j1`, one test thread and the root-granted serialized slot.
Existing URL/IDNA/ICU dependencies compile successfully without network access;
disk free stayed above the 1 GiB guard at observed boundaries. Exact source
hashes, commands and scope are in
[the validation record](../history/bases-expression-validation-20261021.json).

That slot did not include later lib/graph ordinary-frontmatter inference wiring,
matching WASM transport, native host binary or actual app renderer/E2E acceptance.
Those remain with the integration coordinator. Do not mark the implementation
goal complete from these focused tests or static REA evidence.
