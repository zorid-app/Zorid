# Bases query and formula reference

This is a bounded static audit of the desktop Obsidian 1.14.4 Bases query engine. It supplements [Bases reference](reference/bases-reference.md), [source audit](history/source-audit.md), and [reference evidence](reference-evidence.md). It does not certify implementation or runtime parity. The scope is typed values, expression evaluation, function registration, filtering, result assembly, incremental refresh, and the shared property-edit path. View-specific gestures, complete grammar recovery, and Android equivalence remain separate work.

## Evidence identity and method

The pass used the `reverse-engineer-anything` skill and reused E3, rather than rerunning broad analysis. The exported bundle was read as data; neither the application nor extracted expressions were executed. All behavior observations below are ordinary focused source readings, **not newly produced REA semantic facts**. No recovered implementation or assets were added to the project.

| Item | Exact identity |
| --- | --- |
| Desktop source | `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js` |
| Source size | 3,942,126 UTF-8 bytes; 3,936,928 decoded Unicode characters |
| Source SHA-256 | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` |
| E3 | `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` |
| E3 source node | `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2` |
| Export | `/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json`, 1,945,570 bytes |
| Export SHA-256 | `c3ffc021982c57c8e788ad8b22cd57f2b285b9ed67a9377c7fecb81155e85562` |

E3 retained module/static facts but not the complete expanded semantic graph, because of its parent result memory limit. Its second record is a summary projection, not another application analysis. It leaves 36 inventoried files outside semantic source selection. These limitations remain in force.

All locations below are **zero-based Unicode character offsets in the UTF-8-decoded source**, with half-open ranges. They are not byte offsets, original-source line numbers, or portable identifiers. Minified identifiers are included only to locate this exact artifact.

| Bounded region | Location | Coverage |
| --- | --- | --- |
| Values, conversion, registry, built-in registrations | 2191712–2240500 | Read concrete value operations and registration declarations; selected function bodies |
| Formula wrapper, AST construction/evaluation | 2323391–2340400 | Read expression conversion, operator/call/access evaluators, summary declarations |
| Contexts, formula cache, filters | 2340722–2347330 | Read entry context, cycle detection, namespace access, filter combinators |
| Filter parser / mock context | 2356800–2361050 | Read filter deserialization and preview/type-inference context |
| New-item values derived from filters | 2371400–2376500 | Read candidate defaults and conversion to frontmatter |
| Results and shared property updates | 2488400–2500800 | Read grouping/sorting/limit/summary and edit/undo/render paths |
| Query controller | 2534431–2547950 | Read context selection, scan, notifications, search and refresh controls |
| Queue / scheduler / normalization helpers | 1306764–1307900; 1445788–1446500; 2031493–2033040; 544936–545670; 1718398–1718485 | Focused callees only |

## Query dataflow

The controller at 2534431 owns a map from file objects to entry contexts, a set of filter errors, the current query/view, and a file-change queue. Its context builder at 2542456 combines root and active-view filters using the optimizing `and` helper and supplies named formulas and the current file. Each entry (`YQ`, 2341142) snapshots cached frontmatter, wraps it as a typed object, wraps implicit file data, and creates a per-entry formula cache.

Observed flow:

1. Query/formula source is parsed into expression objects. Root and view filters become one effective predicate. The controller compares a JSON state containing that filter and formula source strings; changes trigger a scan. A view/configuration change with the same effective state requests result presentation again.
2. The queue initially supplies `vault.getFiles()`, not only Markdown notes (2031493–2033040). For each queued file, the scan removes its prior result, checks the user-ignore predicate, constructs a fresh entry, and tests the effective filter. A passing entry is retained. Filter exceptions are collected as messages and that entry is excluded (2545431–2546970).
3. When notified, the controller selects groups allowed by explicit group order, applies textual search against configured visible properties, orders candidates initially by path, and derives available property names. `BasesQueryResult` then applies configured sorting and the limit (2490902 onward). Grouping and summaries are accessed lazily from this resulting data.
4. The view receives a fresh result object and `onDataUpdated()`. The toolbar/counts and a mock expression context are updated alongside it (2543400–2545400).

**Inferred reconstruction contract:** retain a distinction between parsed query state, per-file evaluation state, and view presentation state. Sorting, grouping, limits, and search are not all predicates applied during the vault scan. Replacing the pipeline with one indiscriminate full-vault evaluator can change counts, grouping, and refresh behavior.

Search at 2547380–2547950 consumes tokenizer output, lowercases rendered values, and removes matched tokens as it checks properties. All tokens must be found somewhere across the configured property order; nulls and exceptions are skipped. It is not established as full-content vault search. Exact tokenizer, locale, and highlight behavior remain untraced.

## Contexts and dependencies

Entry identifiers `this`, `note`, `file`, and `formula` are dispatched case-insensitively; other identifiers use case-insensitive frontmatter lookup (2341142–2342596). `this` uses the controller's local/current-file entry, while `file` means the evaluated row. In contrast, persisted property namespace normalization remains case-sensitive as described in the existing Bases report. These are separate operations.

File values at 2207400–2210550 expose file/name/basename/fullname/path/folder/ext/ctime/mtime/size, outgoing references, embeds, backlinks, tags, and properties. The entry's default property inventory does not include every accessible member: `file.properties` exists in object access but is absent from the listed default file-property keys. File timestamps are typed dates. Links, backlinks, embeds, tags and properties are lazily cached on a file-value instance. Backlinks iterate `metadataCache.resolvedLinks`; outgoing references use `iterateRefsForFile`. Tags combine cache tags and frontmatter tags and pass through a deduplication helper.

The formula cache (`XQ`, 2342596) resolves names case-insensitively, caches each result, and inserts a sentinel before evaluating a formula. Revisiting the sentinel raises the infinite-loop error. A missing named formula returns JavaScript `null` here, distinct from the singleton typed null. Access through the formula object rethrows a cached typed error; the outer expression wrapper can turn that into an error value again. Exact downstream behavior for missing-formula dereferences needs fixtures.

This establishes **lazy evaluation and memoization**, not a complete dependency graph. No property-level dependency graph was observed in the inspected controller/cache. Formula references may evaluate other formulas recursively; ordinary property edits replace the affected entry context rather than selectively evicting a named formula.

The local context accessor sets a `localUsed` flag (2340722). When the local file reappears in the running queue, the controller can restart the query with a regenerated local context (2546079). The scan itself also accesses the local getter, so this flag must not be described as a proven precise expression dependency tracker.

## Typed values, nulls, and errors

The engine has a value hierarchy (`aK`, 2191712), including Error, Null, String, Number, Boolean, List, Object, RegExp, Date, Duration, File, Link, URL, Image and HTML-related values. Type inheritance affects function lookup and `isType`; string-derived link/URL/image values are not interchangeable with untyped strings for every operation.

| Observation | Location | Consequence / fixture boundary |
| --- | --- | --- |
| Typed null is a singleton, prints `null`, is falsey, and renders no text. | 2193086–2193543 | Display blankness differs from string conversion. |
| Error values retain a message, are falsey, print an error prefix, and render a warning affordance. | 2192417–2193086 | Errors are not universally thrown through to the view. |
| Primitive values use the underlying JavaScript truthiness, except Boolean returns its stored boolean. Lists are true iff nonempty; objects iff they have keys; regex/date/file/link values are always true. | 2193543–2204003; 2207400–2212220 | Empty list/object, zero, empty text, null and error require distinct tests. |
| Strict equality requires equal concrete constructors and the value's equality implementation. Loose equality tries both operands' loose comparators. Primitive loose comparison uses underlying loose equality; a one-item list can compare loosely equal to its item. | 2191712–2192417; 2193543–2193881; 2194914–2196500 | `==` is neither universal strict equality nor unrestricted JavaScript equality. |
| List/object elements are lazily converted and cached. Missing list/object elements return typed null. Object member lookup is case-insensitive. | 2194914–2201789 | Missing keys, spelling collisions and lazy conversion need separate fixtures. |
| Frontmatter strings are tested as internal links, URL-like values, and dates; `tags` receives special list/tag handling; nested objects/lists inherit the converter. | 2199918–2201789 | Raw YAML values and formula values have different representations. |
| General conversion maps null/undefined/functions to typed null, copies arrays/objects, and copies Date values. | 2212981–2213660 | Conversion does not preserve arbitrary JavaScript objects as opaque values. |

The formula wrapper at 2323391 catches errors from `getValue()` and returns an Error value. Its `test()` delegates directly without that catch. Invalid/empty expression nodes instead return typed null and test false. Therefore an invalid formula, a runtime formula error, and a thrown filter evaluation error have distinct paths. The controller accumulates filter failures in a set, emits notices at notification time, then clears that set. The formula editor/renderers have additional parse/error indicators; identical error UI across those paths is not established.

Date parsing (2201789–2204003) recognizes date-only and date/time-shaped strings. Date-only values use local midnight, retain a separate time-present flag, and print separately from locale rendering. Strict equality includes that flag; loose date equality can parse text and compares date-only values when either operand lacks time. Calendar validity, timezone conversion and DST still require runtime fixtures.

Durations (2204003–2207400) store calendar components rather than one fixed scalar. Adding a duration uses Date setters; hours/minutes/seconds/milliseconds can promote a date to datetime. Millisecond conversion adds the duration to a newly constructed current date and measures the difference, so month/year comparison can depend on the current calendar. Its parser contains an ISO-like branch requiring a `T` and a separate signed-integer/unit branch. Millisecond cases exist in dispatch but are not admitted by the visible integer/unit regex; that is a static discrepancy to test, not proof of exposed behavior. Fractional/negative ISO components, leap dates and DST are unresolved.

## Expression operators and evaluation order

The parser adapter at 2324000–2328947 maps identifiers, parentheses, unary `!`/`-`, calls, dot/bracket access, arithmetic, logical/relational/equality operations, strings, numbers, booleans, null, regex literals and array literals into evaluator classes. Parse errors preserve raw text and an optional position message. The compiled parser tables were not reconstructed; this list does not establish complete precedence, escaping, Unicode identifier rules, or all accepted syntax.

| Operation | Static semantics | Location |
| --- | --- | --- |
| `&&`, `||` | Short-circuit; return typed Boolean based on truthiness, rather than returning an operand. | 2328947–2330159 |
| `==`, `!=` | Use typed loose equality / its negation. | 2328947–2330159 |
| `<`, `>`, `<=`, `>=` | Typed null propagates. Date/duration left operands attempt to parse string right operands; numeric/date/duration scalars or text forms are then compared. Conversion is asymmetric. | 2328947–2330159 |
| Numeric `+ - * / %` | Underlying numeric operations with no explicit zero-divisor guard in this branch. | 2330159–2331868 |
| Date arithmetic | Date plus/minus duration; date plus/minus parseable duration text; date minus date yields a duration. Other date operators error. | 2330159–2331868 |
| Duration arithmetic | Duration times/divided by number; duration plus/minus duration. No symmetric number-times-duration branch was observed. | 2330159–2331868 |
| List `+` | Concatenates two lists. | 2330159–2331868 |
| Text `+` | If either side is String-derived, concatenates text forms; typed null becomes empty text. This branch precedes general null propagation. | 2330159–2331868 |
| Other arithmetic | Typed null propagates; otherwise unsupported pairs throw. | 2330159–2331868 |
| Unary `-` | Null propagates; non-numeric values error. | 2331868–2332226 |
| Unary `!` | Null propagates; otherwise typed negated truthiness. Thus it differs from `isTruthy()` followed by negation. | 2332226–2332505 |
| Bracket access | Negative list indexes count from the end; strings use `charAt`; objects require String indexes. The numeric check does not explicitly require an integer despite its error wording. | 2336202–2337475 |
| Dot access | Null propagates; invalid member access returning JavaScript null throws; typed object missing keys may instead return typed null. | 2337475–2338250 |

Arithmetic infinity/NaN, fractional indexes, negative string indexes, mismatched date/text order, nested errors, and missing formula names are priority tests. The numeric renderer has an infinity branch; this does not make every surrounding operator or filter handle non-finite results safely.

### Calls and expression bindings

The call evaluator occupies 2332505–2336202. Exact lowercase `if` is special: it accepts two or three total operands, allows a method-style subject as the condition, uses truthiness, and evaluates only the selected result branch. List `map`/`filter` bind `index` and `value`; `reduce` additionally binds `acc`, takes expression then initial accumulator, and folds in increasing index order. Object `map`/`filter` bind `key` and `value`; object map returns a list, while object filter retains an object. These are expression bindings, not ordinary callback values. Other identifiers fall back to the parent context.

Ordinary registered calls validate argument classes using `instanceof`, include a method's subject in the parameter sequence, enforce optional/variadic rules, and report missing/excess/type errors. Optional typed-null arguments become JavaScript null. A required typed-null argument whose type is not accepted returns typed null rather than raising a mismatch. Unknown methods on typed null also return typed null. Functions accepting the common base type can intentionally receive typed null, as with `isType` and `toString`.

Registry lookup (2214609–2215609) lowercases names and walks the value type's inheritance chain. The special `if`/`map`/`filter`/`reduce` branches compare original spelling. Their ordinary registration bodies are not equivalent to their special evaluators. Consequently uppercase/mixed-case spellings need explicit fixtures; case-insensitive registration alone does not establish identical lazy/binding behavior. Function objects temporarily store context and clear it in a `finally` block (2213850–2214609). Async/reentrant extension behavior remains unverified.

## Built-in function inventory

The following is the declaration inventory from the bounded contiguous registration sequence 2215609–2240500. Offsets identify each group's first and last registration start; names are observed API facts, not copied implementations. Method inheritance adds common functions to specific value types. Plugin registrations can extend or replace entries, so this is not the complete runtime registry in an arbitrary vault.

| Receiver | Declared names | Registration starts |
| --- | --- | --- |
| Global | `now`, `today`, `date`, `if`, `random`, `min`, `max`, `list`, `link`, `number`, `duration`, `image`, `icon`, `file`, `html`, `escapeHTML` | 2215609–2221105 |
| Any | `toString`, `isTruthy`, `isType` | 2221401–2221921 |
| Null | `isEmpty` | 2222322 |
| String | `startsWith`, `endsWith`, `trim`, `title`, `isEmpty`, `replace`, `reverse`, `lower`, `split`, `contains`, `containsAny`, `containsAll`, `slice`, `repeat` | 2222562–2226770 |
| Number | `round`, `ceil`, `floor`, `abs`, `toFixed`, `isEmpty` | 2227253–2228568 |
| List | `isEmpty`, `earliest`, `latest`, `median`, `mean`, `max`, `min`, `sum`, `stddev`, `join`, `reverse`, `flat`, `unique`, `contains`, `containsAny`, `containsAll`, `slice`, `sort`, `map`, `filter`, `reduce` | 2228810–2234326 |
| Object | `isEmpty`, `keys`, `values`, `map`, `filter` | 2234594–2235622 |
| RegExp | `matches` | 2235877 |
| Date | `format`, `date`, `time`, `relative`, `isEmpty` | 2236156–2237217 |
| File | `asLink`, `hasLink`, `inFolder`, `hasTag`, `hasProperty` | 2237457–2239300 |
| Link | `linksTo`, `asFile` | 2239625–2239947 |
| Tag | `matches` | 2240237 |

Selected body observations constrain a compatible implementation:

- `number` uses `parseFloat` for text, maps booleans to 1/0, and dates to timestamps; it errors for unsupported conversions (2218917). A strictly whole-string numeric parser would differ on numeric prefixes.
- String `contains` is case-insensitive and rejects an empty query; `startsWith`/`endsWith` use direct case-sensitive string operations. `containsAny`/`containsAll` do not have the same empty-query rejection (2222562–2226447).
- String replacement uses regex replacement for regex arguments, otherwise all literal occurrences; an empty literal pattern leaves the string unchanged. String reverse splits into UTF-16 code units (2224015–2224659). Unicode grapheme reversal is not observed.
- Numeric `round` applies decimal scaling only for a positive supplied digit count; `toFixed` returns text. Number/date `isEmpty` always returns false (2227253–2228810; 2237217).
- List numeric aggregators ignore non-number values for collected numeric inputs. `sum` of no numeric inputs is null; `mean` divides that numeric sum by the **entire list length**. `stddev` uses the population mean of collected numbers. `unique` uses strict typed equality, whereas membership uses loose equality (2194914–2199918).
- List `containsAny`/`containsAll` expand a single list argument, or accept variadic values (2232297–2233279). Tag-list membership additionally uses case-insensitive hierarchical tag matching (2199200–2199918).
- Regex matching calls the stored RegExp's `test`; repeated global/sticky regex state is a fixture requirement (2235877).
- File `hasProperty` tests exact membership in property keys, unlike ordinary case-insensitive property access. `hasTag` accepts multiple tag arguments and succeeds if any matches. `inFolder` normalizes the folder and accepts root or a path prefix with a slash boundary (2238353–2239625).
- `now`, `today` and `random` compute a value when called. No periodic invalidation for these functions was observed in the inspected controller. Zero-argument global `min`/`max` return JavaScript null in their body, another distinction requiring end-to-end tests (2215609–2218188).

## Filters, ordering, grouping, and summaries

Filter deserialization accepts expression strings or exactly one `and`/`or`/`not` key with an array value. Group evaluation short-circuits; `not` is NOR across all children. Empty raw groups give true/false/true respectively. Optimization removes empty groups, flattens same-kind and/or groups, collapses single children, and rewrites a single nested not-group through an and-group (2343650–2346820; 2356800–2357800). Because context construction optimizes, raw-group truth tables alone do not determine a loaded query's final result. This is especially important for empty `or` and nested `not` fixtures.

Result sorting at 2491400–2493150 drops sort keys absent from available properties and falls back to ascending file name. Numeric/date/duration pairs compare their scalar forms; remaining values use display text, including link display values. Both-null ties continue to the next criterion. A single null is returned after a non-null before the direction multiplier, so that observed branch keeps null at the end for both directions; Boolean participation has its own truthiness comparison branch before null placement. Evaluation exceptions in a comparator return a tie. Initial path ordering can influence equal-key ordering. Exact locale collation and engine sort stability remain unverified.

Explicit group order uses converted typed keys and cached positions (2488400–2490902). It filters out unlisted groups before result presentation. Without explicit order, grouping compares loose typed keys, sorts numeric keys numerically and otherwise textually, and puts the null/no-key group last. An explicit order can carry empty keys for configuration/UI purposes while displayed grouped data omits empty groups. Limits are applied before lazy grouping and summaries. These ordering stages need combined fixtures, not only isolated sort tests.

Summary evaluation (2493150–2493579) selects the first value not identical to typed null to choose the value class, obtains a custom or built-in summary expression, and evaluates it with only `values` exposed by the summary context (`qQ`, 2340167). A WeakMap caches by entry-array identity, property and summary name. Built-in registrations near 2339500 provide numeric Average/Min/Max/Sum/Range/Median/Stddev, date Earliest/Latest/Range, Boolean Checked/Unchecked, and common Empty/Filled/Unique. Several numeric summaries round their final result to two decimals. Mixed values, errors before a valid value, missing values and user-defined summary overrides remain fixture requirements.

## Refresh, scheduling, and performance boundaries

The queue wrapper at 2031493 registers vault create/modify for non-Markdown files, rename/delete, and metadata-cache changed events. Markdown changes are therefore driven through metadata updates in this observed path. Deleted files are removed from both pending queue and result map. The generator at 1306764 remains alive when empty, signals stop, waits for notification, and resumes when work arrives. Queue deduplication internals were not audited.

The query loop uses a scheduler with batch size 10, elapsed threshold 50 ms and `maxDelay` 16 (2545431; scheduler 1445788). Elapsed time is checked every ten processed items. A hidden container can await insertion/visibility notification; cancellation is checked while consuming the queue. Notifications use the 50 ms scheduling helper, whose default mode coalesces calls without simply resetting the timer on every invocation (544936; 2534431). Initial-scan presentation is deferred until the loader stop callback clears its guard.

Changing user-ignore configuration clears the query-state signature and updates. Metadata type changes request presentation refresh. Changing the current file explicitly rebuilds context and scans. A changed file gets a new entry with new lazy-value/formula caches. Link resolution has a separate microtask-tick cache (2210550–2212220). These are observed mechanisms, **not measured speed or memory guarantees**.

Unresolved invalidation cases include a target file's changed backlinks when only the linking source emits an event, renamed/resolved links held by unrelated cached entries, time-dependent functions, extension registry replacement, and rapidly alternating queries while a hidden scan awaits insertion. No full dependency closure, indexed predicate planning, wall-time limit for one expensive expression, or regex execution budget was established by these ranges. Absence from this bounded inspection does not prove global absence.

## Edits and data conversion

Shared property editing at 2495684 normalizes empty strings and empty arrays to null through the helper at 1718398. It invokes `fileManager.processFrontMatter`, finds an existing key case-insensitively, and records start/end frontmatter objects for a view transaction. Assigning null to a missing key is a no-op; assigning null to an existing key retains an assignment in this observed callback. Property rendering is disabled for non-Markdown files and uses metadata-type widgets for Markdown files (2498950–2499700). Formula/file renderers follow separate read-only rendering paths.

Transactions at 2494000–2496200 capture ephemeral view state and record only a JSON-distinguishable change. A recorded change clears redo and requests view notification. Undo/redo restore the saved view state and process files sequentially, applying the saved object only if current frontmatter JSON matches the expected end/start state. The observed restoration uses object assignment, not unconditional replacement. Added/deleted keys, reordered keys, external edits, partial write failures, and transactional atomicity therefore need explicit verification; it would be inaccurate to claim fully general database-style rollback from this code.

New-item defaults at 2371400–2376500 inspect non-negated filter leaves and derive candidate frontmatter/folder values from selected equality/range and contains/tag/folder/property predicates. Visible note properties can be initialized to null. This is a heuristic, not a solver guaranteeing that every new file satisfies arbitrary Boolean/formula filters. Conversion preserves primitive data, maps typed null to null, recursively converts lists/objects, serializes links relative to a source when available, and otherwise falls back to string form. Dropping files into the base also uses these derived defaults and can move files to the derived folder (2536000–2537600).

## Reconstruction and verification gaps

These observations support an independently implemented typed evaluator, explicit expression tree, memoized per-entry formulas, and a separate result-presentation pipeline. They do not authorize copying recovered code and do not close any implementation parity claim.

Priority reference fixtures remain:

1. Operator/type matrix: null versus absent/error, numeric/string/Boolean loose equality, one-element lists, non-finite arithmetic, asymmetric date/duration conversions, bracket indexing and malformed expressions.
2. Evaluation order: short-circuit branches, lowercase versus mixed-case special calls, nested map/filter/reduce bindings, cycle chains, missing formulas, variadics and plugin exceptions.
3. Query pipeline: empty and nested filter groups, root plus view filters, ignored files, all file extensions, search across visible properties, ties/nulls/Booleans, group order plus limit, and mixed-type summaries.
4. Updates: file/property/metadata changes, local `this` context, backlink and link-target changes, time-dependent functions, plugin registration/unregistration, hidden-view cancellation and query replacement.
5. Editing: metadata coercion, empty versus missing property, case collisions, external edits between transaction and undo, added/deleted keys, partial failure and persistence after reopen.
6. Performance: separately measure scan latency, update-to-render latency, formula fan-out, expensive filters, memory and view virtualization on fixed workloads. No reference benchmark was run here.

No target execution, fixture capture, Android query audit, plugin ABI validation, exhaustive parser audit, or end-to-end implementation mapping was completed in this pass. All behavior statements remain bounded static observations or explicitly labeled inferences.

## Original implementation foundation (2026-10-16)

`src/bases/expression.ts` now contains an original lexer, precedence parser, expression tree and interpreter. It neither evaluates JavaScript source nor exposes ambient JavaScript objects/functions. This implementation uses tagged values and explicit namespace/function capabilities rather than the reference class hierarchy. No recovered code, generated grammar tables or assets were copied into the implementation.

The public boundary is:

| API | Contract |
| --- | --- |
| `parseBaseExpression(source)` | Returns a readonly expression-tree shape; malformed/unsupported syntax throws `BaseExpressionError` with a UTF-16 source offset. Blank input parses as null. |
| `evaluateBaseExpression(sourceOrTree, context)` | Returns a typed value, including an explicit error value for a failed parse or evaluation. |
| `evaluateBaseExpressionOrThrow(...)` / `testBaseExpression(...)` | Propagate thrown parse/evaluation failures; the latter converts returned values to typed truthiness. A host function can explicitly return an error value, which remains falsey data rather than being rethrown. A caller can report thrown filter failures separately from nonmatching rows. |
| `createBaseExpressionContext(options)` | Takes detached plain note/file/current-file data, named formula expressions and optional host identifier/function capabilities. Resolves `note`, `file`, `this`, `formula` and bare note names; memoizes formulas per context with a cycle guard. Construct a new context after data/query changes. |
| `BaseFunctionRegistry` | Explicit global or receiver-type registrations, argument schemas and lifecycle removal; custom registrations take precedence over supplied built-ins. Syntax cannot call arbitrary object members. |
| `baseExpressionValue`, `baseDate`, `baseDuration` | Construct tagged values. Plain-data conversion rejects accessors, cycles and unsupported object prototypes; own prototype-like property names remain ordinary data. |

Implemented behavior includes short-circuit Boolean results, lazy lowercase `if`, arithmetic on supported typed pairs, loose typed equality, case-insensitive own-property lookup with exact-name preference, dot/bracket access, negative list indexes, arrays, regex literals, list/object `map` and `filter`, list `reduce`, per-row formula memoization and cycle errors. The memoized formula retains its row context rather than capturing a nested list/object binding. Ordinary function arguments are evaluated and validated in order; a required null can stop evaluation of later arguments. Error-returning and throwing entry points remain separate.

The supplied function subset includes numeric conversion/arithmetic helpers, date conversion and now/today, simple signed-integer calendar durations, list construction, global min/max, common type/truthiness/text operations, observed string operations, numeric rounding, list membership/slicing/reversal/flattening/joining/numeric aggregates, object keys/values, regex matching, and date-only conversion. Unsupported functions fail explicitly. Lowercase special expression calls are distinguished from ordinary case-insensitive registry dispatch, as the audited evaluator does. No function inventory completeness claim is made.

The implementation adds a configurable evaluation step budget (default 100,000; a finite nonnegative safe integer is required) and a nesting limit of 256. These are original resource controls, not recovered reference limits or measured performance guarantees. Formula budget failures are not cached, so a large surrounding expression cannot permanently poison an otherwise evaluable formula. The budget is shared through nested formula/list evaluation; it does not interrupt an individual native regex/string operation or bound data conversion, parsing input size, or every built-in loop.

A focused additional inert reading at source offsets 1445367–1445788 confirmed local date/time text fields and the exact-key-first, then first case-insensitive key lookup order. The artifact digest and E3 limitations above are unchanged. No target execution or repeat application analysis was performed.

The following differences/gaps are explicit:

- The parser uses conventional precedence (unary, multiplication, addition, relational, equality, `&&`, `||`) and left-associative binary tiers. The reference compiled grammar's exhaustive precedence/lexical acceptance was not reconstructed. The tests establish the original implementation's behavior, not reference conformance for all syntax.
- Raw note/file/current-file input conversion does not implement the reference's automatic frontmatter link/URL/date/tag specialization, File identity, link resolution, backlinks or metadata-cache integration. Callers can supply typed values through identifier/namespace capabilities. Host-dependent file/link/tag/image/HTML functions are unavailable unless registered explicitly.
- ISO duration parsing, humanized durations, calendar-unit member conversions, locale formatting, some date/list functions and the full plugin value hierarchy remain unsupported. Invalid calendar timestamps are rejected explicitly. Empty global min/max normalize to typed null; the reference body returns JavaScript null. Malformed expressions return/throw explicit errors here, whereas reference invalid-expression nodes can yield null/false. These are deliberate foundation boundaries, not parity claims.
- Formula errors are memoized within the row context, with no metadata/clock/plugin-registry invalidation beyond constructing a new context. No query dependency graph, persisted filter-tree runner, sorting/grouping/summary pipeline, `.base` view wiring, UI error renderer, editing path or save lifecycle was connected in this change. Existing `.base` document parsing remains separate from evaluation.
- Strict/loose object equality, regex state, Date behavior, mixed-case special calls and other edge cases still need controlled reference fixtures. The implementation tests are independently authored expectations grounded in bounded source findings and explicit original choices.

Validation: `node --test tests/bases-expression.test.ts tests/bases-document.test.ts` and `npm run check`. The focused tests cover operator precedence/associativity, syntax rejection, null/false/missing distinctions, short-circuiting, own-property access, coercion, explicit function capabilities, lazy formula caching/cycles, nested binding scopes, mixed list aggregates, calendar dates/simple durations, regex state and evaluation limits. Passing these checks does not establish full Bases or Obsidian parity.

## Original snapshot query runner (2026-10-16)

`src/bases/query.ts` now connects the existing `.base` document and typed expression interpreter through `executeBaseQuery(document, snapshot, options)`. It has no filesystem, UI, plugin-loader or property-write capability. The snapshot is an explicit list of normalized vault-relative file paths, detached frontmatter, optional genuine numeric creation/modification timestamps and byte sizes, and host-supplied complete tags. It includes all supplied extensions, not only Markdown. The caller supplies a string/number `version` token, echoed unchanged for stale-result rejection by hosts and asynchronous view callbacks.

The exported result is an immutable snapshot: selected full view configuration, rows, grouped rows, visible and available property IDs, configured/unlisted group counts, stage counts and diagnostics. Rows carry `path` plus a frozen mapping of typed values. Requested visible note properties remain present as typed null even when missing from every row. The configured image property and grouping property are also materialized when absent from the visible order. Table, Cards, List and Kanban configuration—including unknown options—is retained without adding rendering behavior to this module. JS-null group keys mean an ungrouped result; typed-null keys mean the missing-value group. Group row objects share identity with the result's ordered rows.

The implementation performs these stages:

1. Validate query configuration, compile expression/filter/formula sources, detach metadata and construct per-entry contexts. Invalid input rows receive diagnostics; malformed query configuration and duplicate/invalid paths fail explicitly.
2. Combine global and selected-view filters. Ignored paths are excluded. A thrown filter failure or an explicitly returned typed error excludes the row and produces an immutable diagnostic. Other falsey values simply do not match.
3. Apply explicit group order, including its unlisted-group exclusion. Group-option counts are recorded before search or limits; configured empty groups remain options but are absent from displayed groups.
4. Match caller-supplied search terms across the configured visible property order. This is not a reconstructed search tokenizer or full-content search. Null/error values do not match.
5. Order initially by path, derive available properties, discard unavailable sort criteria, then sort with ascending short file name as the fallback. Apply a positive limit (fractional limits truncate as the observed splice operation does).
6. Materialize detached typed values and form groups from the limited rows. List values remain one composite group key; they are not expanded into several memberships. Natural grouping uses the interpreter's loose typed equality, puts null last, and sorts numeric pairs numerically. Explicit ordering also permits a configured string equal to the key's display text.

A focused reread of the same hash-bound artifact clarified an important filter edge: `JQ.and` at 2343650–2344300 returns its sole non-null argument unchanged. `buildBasesContext` at 2542120–2542475 uses that helper on root/view filters. Consequently, a lone loaded `{or: []}` is false; combining it with a second filter invokes optimization and removes that empty group. The runner's fixtures cover both forms, all empty conjunctions, short-circuiting, and the observed nested-NOT-to-AND rewrite. These details supersede an inference that every loaded filter is necessarily optimized.

The result and grouping reads at 2488400–2493150 and presentation pipeline at 2543400–2545431 confirm whole-value group keys, explicit group filtering before presentation, and limit-before-grouping. The short-name method at 1412758 drops only lowercase `md`; other extensions keep the filename. Duration comparison at 2205545 uses calendar addition relative to the current date. The runner uses a single captured clock for its ordering/group comparisons, an original deterministic choice; formula `now()`/`today()` still use the supplied clock capability. Source SHA-256 remains `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, with offsets measured as decoded Unicode characters and the retained E3 limitations unchanged. Only these bounded source spans were reread; no reference code was executed or copied.

Each entry owns a lazy, case-insensitive formula cache and pending-formula set. Nested formula evaluations share the interpreter's budget and retain the row context across list bindings. Cached errors rethrow on formula access; budget failures are not cached by that formula layer. `this` refers to the selected current-file entry, including its `file`, `note`, bare frontmatter properties and `formula` namespace. No current-file entry produces typed null. Presentation materialization evaluates the available formula columns after filtering, so a formula not needed by a filter can still produce a reported value error in a surviving row.

The file namespace supports scalar metadata, `file.file`, `file.properties`, complete supplied tags, `inFolder`, `hasTag`, `hasProperty` and explicit `toString`. File values are frozen namespace capabilities named by their path, **not** an implementation of the reference's complete File/Link hierarchy. Result consumers should use `row.path` for opening or editing identity. Resolved links, backlinks, embeds, URL/image/link conversion, `asLink` and `hasLink` are not invented from filenames: their access/functions fail explicitly. File-to-string equality and every inherited `ThisFile` operation are not fully reproduced by the underlying expression foundation. Root formulas and host registry capabilities remain optional; unsupported functions retain explicit errors.

Remaining boundaries:

- The caller must rebuild a snapshot after file content/metadata, current-file, query/formula, ignore setting, clock-dependent refresh or registry changes. A fresh execution constructs all new entry caches. No watchers, queue, dependency graph, property-level incremental invalidation, background scheduler, query cancellation or full dependency closure are claimed.
- Property inventory uses supplied note-key spelling; it does not reproduce the host metadata-type manager's canonical naming/coercion. Frontmatter link/date/tag specialization beyond the expression converter remains incomplete. Missing optional file stats are null rather than fabricated timestamps. Tags must already include any frontmatter contributions.
- Sorting uses the host JavaScript locale with numeric, case-insensitive comparison and stable array sorting; exact reference locale behavior remains unverified. Comparator errors produce diagnostic ties. Group-property errors remain explicit typed-error keys instead of masquerading as a null/no-key group; this is an original recoverable-error choice.
- Summary expressions, property editing, new-item defaults, view rendering, exported query formats and `.base` workspace lifecycle are not implemented here. Existing summaries and unknown configuration survive untouched.
- The runner is synchronous. Per-expression step budgets do not bound a native regex/string operation or the total query. Natural grouping and explicit group-key matching can perform quadratic comparisons. Metadata conversion, sorting, result materialization and output memory have no claimed latency/size budget. Measurement and incremental execution remain separate work.
- Function capabilities are explicit trusted host code. Results clone/freeze composite values, error objects and regexes; unrecognized callback namespaces and cyclic/excessively nested result payloads become explicit error values. No live context or arbitrary callback namespace is intentionally exported through rows.

Validation: 23 query fixtures, six independently authored review fixtures, 23 expression fixtures and 10 document fixtures pass serially (62 total), and the query module with transitive imports passes a focused strict TypeScript check. Fixtures cover filter optimization distinctions, formula memoization/cycles/current-file context, scalar file operations, literal/prototype-like property names, numeric/date/duration/Boolean/null ordering, ties and sort errors, group order plus search/limits, whole-list groups, immutable results, all four view configurations, invalid metadata/configuration, and explicit unsupported behavior. These are original fixture expectations informed by static evidence, not native or reference-runtime parity measurements. Independent review reproduced and then cleared two defects: cyclic callback values reaching group equality before validation, and callback mutation of the reported snapshot revision/count. The runner now validates composite outputs before sorting/grouping and captures the revision/file list at entry. The independent reviewer confirmed all 29 query/review fixtures after the fixes; native/reference-runtime equivalence is still not claimed.
