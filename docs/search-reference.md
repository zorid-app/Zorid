# Search reference contract — Obsidian 1.14.4

Inspection date: 2026-10-16. This is a bounded static audit of global search, its shared query engine, result presentation, and update loop. It contains original behavioral descriptions, not recovered implementation. No target execution, runtime timing measurement, or proprietary source redistribution occurred.

## Identity and evidence boundary

The inspected artifact is `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`: 3,942,126 bytes, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. Payload provenance and limitations are in [reference evidence](reference-evidence.md); broader unfinished scope is in [source audit](source-audit.md).

REA E3 is `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, source-module node `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`. Its complete exported record at `/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json` was reused. This worker's connection does not retain that ID; no producer was rerun. E3 parsed the renderer as inert text but could not retain the expanded semantic graph within its memory budget. The findings below are **ordinary focused source inspection of that digest**, not newly produced REA semantic facts or observed runtime behavior.

All source ranges below are half-open, zero-based **Python Unicode character offsets** in the UTF-8-decoded artifact, not byte offsets. Query/result coordinates used by the application are JavaScript string offsets (UTF-16 code units); those are a different coordinate system. Minified names are local navigation anchors for this build only.

| Evidence range | Inspected control/data flow |
| --- | --- |
| 544936–545650 | `Gl`: deferred callback scheduling and reset-on-call option |
| 852362–852797 | `SC`: idle callback with timeout fallback, otherwise animation frame |
| 1255823–1256027; 1257450–1257540; 1258438–1258651 | Range merging, range translation, compact snippet boundaries |
| 1302360–1302470; 1306178–1307920 | Locale-aware numeric comparison; cancellable persistent queue |
| 1445788–1446445; 1450640–1452875 | Cooperative yield policy, quote boundary construction, search input/result structures |
| 1452875–1459370 | Boolean, regex, property, quoted/plain text, AND/OR/comparison/negation matchers |
| 1459259–1463555 | Recursive parser and tokenizer |
| 1463555–1471500 | Case/scope/task/tag matchers, operator registry, file/Canvas dispatch |
| 1471500–1474700 | Shared query entry points, result normalization, file scan and sort options |
| 1766300–1766730 | Supported-file and ignored-path gates |
| 1973140–1988615 | Highlight spans, file/property/snippet result objects, grouping/context, result collection and focus |
| 2031493–2033140 | Search queue subscriptions and per-file updates |
| 2043400–2044900; 3082050–3084355 | Markdown reading/editing consumers of search navigation state |
| 2048000–2048830 | Embedded query blocks |
| 2697510–2703050 | Search suggestion registration and input handling, partially inspected |
| 2703050–2708500 | Core plugin entry, menu/command/CLI registration |
| 2708500–2718335 | Search view state, settings, navigation, execution and error handling |
| 2718335–2720600 | Copy-results dialog |

## Grammar and parser behavior

The tokenizer recognizes plain text, double-quoted text, slash-delimited regex, `-`, parentheses, square brackets, colon, `<`, and `>`. Only uppercase standalone `OR`, `TRUE`, `FALSE`, and `EMPTY` become reserved tokens; lowercase forms are ordinary text. There is no registered `AND` token: adjacency is conjunction. Operator names before `:` are lowercased. These are branches in the parser/tokenizer, not conclusions from suggestion labels. [1459259–1463555]

Precedence is: unary operator/negation/comparison and parenthesized expression, then adjacent conjunction, then `OR`. An operator consumes the next single parsed expression; parentheses are needed to scope it over a conjunction or disjunction. `-` negates the following expression. `<` and `>` accept only plain or quoted text operands and otherwise throw. `[key expression: value expression]` constructs a property matcher; without a colon it tests key existence. Operators are not recognized within property brackets; another property bracket within a property throws. [1459259–1462196]

Parser permissiveness matters for fidelity:

- Literal ASCII space separates ordinary tokens. This tokenizer does not generally split on tabs/newlines. Embedded query blocks separately replace CRLF/LF with spaces before parsing.
- A quote, slash, or minus starts its special token only at the beginning of a tokenizer iteration. Inside an already accumulating ordinary token these characters remain ordinary characters. Thus a hyphen within a word is not automatically negation.
- In quoted text, a backslash consumes the following character literally. An unterminated quote still emits a quote token at end of input.
- In regex text, escaped slash is converted to slash; doubled backslash is retained as a regex escape. Other regex escapes survive. Unterminated slash syntax also emits a regex token. No regex flag suffix is consumed; trailing letters become another token.
- A missing operator operand becomes an empty plain-text matcher. Empty parentheses similarly produce an empty matcher. Unclosed parentheses/brackets can be accepted. The parser returns its built expression without a final full-token-consumption check, so unmatched closing delimiters or trailing `OR` need dedicated compatibility fixtures instead of a strict-parser assumption.
- Unknown named operators and prohibited nesting throw. Regex syntax is validated with the JavaScript regex constructor and invalid patterns produce a parse error.

These edge cases are statically derived from tokenizer/parser branches; actual input-widget behavior and visible errors remain unobserved. [1459259–1463555; 2048000–2048830]

## Matching semantics and result model

A matching context has named strings, an active key list, original content, case-sensitivity, optional metadata cache, and additional typed values. Result fields include `filename`, `filepath`, `content`, `propertyName`, and `tag`, each holding offset pairs; `properties` contains key/subkey/value-position records. A result object can be empty and still mean success. `null` means rejection; `undefined` means unavailable/not applicable in several matcher branches. The outer query maps `undefined` to an empty successful object. Preserve this three-state internal distinction rather than implementing every matcher as a Boolean. [1451437–1452875; 1471500–1472110]

AND rejects immediately on `null`, combines successful fields, and tolerates unavailable inputs. OR evaluates its children and combines positive fields rather than returning only the first hit. Negation converts a positive result to rejection and rejection to an empty success, while preserving `undefined`. This permits exclusions to yield a matching file without content highlights. Result normalization sorts and merges overlapping **and touching** intervals for the five named string fields; it does not globally deduplicate property entries. Match count is the number of resulting intervals plus property entries, not necessarily occurrences, files, or snippet rows. [1457494–1459370; 1471500–1472110; 1255823–1256027]

Plain text is escaped as literal regex and searches substrings across active keys. Regex matching uses global/multiline flags, plus ignore-case unless the context is case-sensitive; it does not add Unicode or dot-all flags. Each input resets regex position. Empty regex text is unavailable; zero-length regex matches are omitted and the scanner increments its position to progress. Regex instances are cached separately by case mode; a reset-on-call 60-second deferred callback clears both caches. This is source scheduling, not a measured expiry guarantee. [1453710–1454650; 1456610–1456910; 544936–545650]

Quoted text is **not merely a literal substring everywhere**. In content it uses conditional whole-word boundaries based on a bundled character class of letters and decimal digits: a boundary is added only when that end of the query is in that class. This is not JavaScript `\b`; underscores are not added to that word class. Filename/path fields use substring matching for quotes. A quoted property-name matcher performs case-insensitive equality regardless of the context's case flag. Ordinary property-name text remains a substring matcher respecting that flag. [1446445–1451437; 1455880–1456610]

Boolean constants use strict equality against the preserved typed property value; `EMPTY` expects `null`. Property values are also exposed as `String(value)` for text/regex searching. `<` and `>` compare the typed value to the operand's text using JavaScript relational semantics, with no explicit date/number normalization in this matcher. String-to-string comparisons are therefore lexical, while numeric values can invoke coercion. Do not replace this with a universally numeric comparator. [1451437–1451900; 1452875–1453420; 1458330–1459000]

## Operator contract

| Operator | Static implementation contract | Evidence |
| --- | --- | --- |
| `match-case:`, `ignore-case:` | Clone context and override case mode for their operand. They are not exclusive scopes. | 1463555–1463900 |
| `file:` | Evaluate operand with only filename active; the filename includes extension. Does not request content reads. | 1464240–1464590 |
| `path:` | Evaluate operand with only full vault-relative filepath active. Does not request content reads. | 1463900–1464240 |
| `content:` | Restrict active keys to content and request content input. | 1464590–1464930 |
| `line:` | Evaluate operand independently against each LF-separated line; translate successful ranges back to original offsets. CR is not stripped by this split. | 1464930–1465850 |
| `block:` | Evaluate cached non-list sections separately, then each cached list-item range. It is not limited to named block IDs and is not implemented as a blank-line split. Requires metadata and content. | 1465850–1466570 |
| `section:` | Derive heading intervals ending at the next heading, plus a preamble interval when the first heading starts after zero. Outer search considers these intervals independently. Nested `section:` traverses subordinate heading intervals using cached hierarchy counts; it does not simply append all descendant text to each parent interval. Without a headings cache, an outer section evaluates its operand against the whole context; an already nested section rejects. | 1466570–1468000 |
| `task:` | Evaluate each cached list item whose task marker is defined. Operand `""` is specially converted to an all-task matcher; empty plain text is not the same conversion. | 1468000–1468790 |
| `task-todo:` | Same task ranges, only a single-space task marker. | 1468000–1468790; 1470025–1470093 |
| `task-done:` | Same task ranges, any task marker other than a single space, not only `x`. | 1468000–1468790; 1470093–1470165 |
| `tag:` | Only a plain-text matcher is permitted; quoted/regex/group combinations that produce other matcher types throw. Adds a leading `#` when absent. Matches case-insensitively against an anchored tag prefix followed by end or `/`, including descendant tags. Reads frontmatter tags and cached inline tags, returning property records and/or content ranges. | 1468790–1469510; 1470165–1470360 |
| `[key]`, `[key: value]` | Iterate own frontmatter keys and evaluate the key expression against `propertyName`. Presence yields a key record. Scalar values are evaluated once; arrays are evaluated one level per element with `subkey: [index]`. Value matches contribute only when they contain content intervals; an empty success from negation alone does not create a property match. This is not a recursive nested-object query language. | 1454650–1455880 |

All named scopes except case modifiers are exclusive. An exclusive operator nested within another exclusive operator throws, except `section:` may nest within itself. Case wrappers do not remove the outer scope from the nesting stack. Property bracket matching has its own nesting restrictions and can occur inside scoped expressions. [1459259–1462196; 1469510–1470360]

Each split-scope result returns translated content ranges. A successful subexpression without content ranges produces a zero-width position at that segment's start, preserving a navigable occurrence for exclusion-only segment queries. [1464930–1465450]

## File selection, Canvas and embedded queries

The global scan enumerates vault files, skips user-ignored paths, and skips unsupported files. Supported means a registered extension or the `showUnsupportedFiles` configuration. It reads content through `cachedRead` only for Markdown/Canvas when required by the matcher tree. Read errors are logged and matching proceeds with the initialized empty text; cancellation is checked after the read and before evaluation. These paths do not establish disk indexing, full-text databases, or native worker execution. [1472110–1473660; 1766300–1766730]

For the ordinary file matcher, filename is active by default for the `.md`, `.canvas`, and `.base` extension set; content is additionally active for `.md`. Other extensions do not gain default filename search merely because they are supported, although explicit `file:`/`path:` can address the supplied strings. Metadata is attached for Markdown. [1258764–1259770; 1470360–1471500]

When the Canvas plugin is enabled and parsed content has a nodes array, text nodes are searched independently with node metadata from the Canvas index. Successful node content ranges use `canvas-<node-id>` result keys. A separate empty-content/filename context handles filename matching. A matching Canvas returns that aggregate; failure to parse or absence of an aggregate falls through to ordinary matching. Result display orders text nodes by vertical then horizontal coordinate and click state adds the selected node ID. The shared match-count helper's named fields do not include these dynamic Canvas keys. [1470360–1471500; 1973527–1976950]

Embedded query blocks reuse the same engine, result DOM and live queue, with case-insensitive initial mode. They replace query newlines with spaces. When evaluating their own source file, query fences are blanked with spaces while preserving line breaks before matching, preventing ordinary self-matches without shifting remaining content positions. Full fence parsing equivalence is not established by this narrow regex path. [2048000–2048830]

The plugin also registers CLI `search`, `search:context`, and `search:open`. The CLI text search scans Markdown files only, reads each one, honors ignored paths, and optionally filters a folder prefix. `search` returns file paths; `total` counts files. `search:context` maps content-hit starts to one-based line numbers and trimmed line text; it does not deduplicate multiple ranges on the same line. Limits are applied after scanning. This is a separate entry point from the incremental global UI loop. [2703050–2707290]

## Results, sorting, highlights and navigation

Six sort settings are registered: alphabetical/reverse, modified newest/oldest, and created newest/oldest. Alphabetical comparison uses basename through an `Intl.Collator` with default locale, base sensitivity, and numeric comparison. Time sorts compare `mtime` or `ctime` directly; no explicit secondary tie-breaker is present in these comparators. Unknown sort IDs fall back to alphabetical in the lookup helper. Both initial scan order and displayed results use these comparators. [1302360–1302470; 1473292–1474300; 1985355–1986600; 2031493–2033140]

Result collection is keyed by file object. Replacing a file result removes the previous item, preserves its collapsed state, and inserts the replacement. Default collection settings are alphabetical, expanded, and compact context. Empty-state visibility depends on both whether children exist and whether work is running. Results use an infinity-scroll layout; file content rows are rendered on first render. [1973527–1976950; 1985355–1988615]

Filename/path highlights use the actual result ranges. When both exist, filename ranges are shifted into the path and merged. Markdown `.md` is omitted from a filename title only when doing so would not hide a filename match in the extension. Property matches are grouped by key; scalar values and array elements are stringified and highlighted at their property positions. Content highlights are text spans with the matched-text class, not rendered Markdown inside the snippet. [1973140–1975200; 1980080–1981634]

Compact snippets extend at most 100 characters on either side of a match, stopping at LF, with ellipses when capped. Nearby match ranges are grouped into a row when their start lies inside its current context span. More-context mode first uses cached list-item ranges including descendants, then cached section ranges; fallback paths inspect line/block boundaries with bounded scanning. Each snippet can expand before/after using metadata boundaries or neighboring lines. These branch rules are known; exact layout/line-height/clipping is not. [1258438–1258651; 1975200–1978300; 1981634–1985355]

File-title activation opens the selected leaf with ephemeral state containing original content, all file content ranges, and property matches. Snippet activation passes its subset of ranges. Property activation passes its property records. Modifier handling selects the destination leaf. Hover emits the workspace's search hover-link event with an optional scroll line derived from the first range. [1978300–1982190]

Markdown editing converts offsets using the content snapshot, adds `is-flashing` highlights, places the cursor at the first range start and scrolls that first range into view; an empty range list removes these highlights. Reading mode scrolls to the first range's line with centering/highlight options. Both consumers prioritize a defined property-match field over content-match handling, and focus the first property when their property conditions permit. There is no content freshness check in these inspected consumers. Highlight expiry and behavior when the note changes between search and opening remain unresolved. [2043400–2044900; 3082050–3084355]

Keyboard result traversal changes focused tree items, scrolls them into view, and updates focus classes. Up/down traverse; left/right collapse/expand when the input is not active; Enter/Mod-Enter opens a focused file or snippet; Shift-Up/Down expands a focused content snippet's context. Property-row Enter parity is not established by the explicit file/snippet type checks in the view handler. [1985355–1988615; 2714300–2716570]

## Incremental work, settings and persistence

A new query cancels the prior queue, clears results/focus, parses, builds an explanation tree, and starts a persistent cancellable queue over files in selected sort order. Input changes schedule search with zero-delay deferred work; Enter explicitly restarts search unless composition is active. The queue waits when empty and is awakened by new items rather than terminating after the first pass. No deduplication appears in the inspected queue's `add` path. [1306178–1307920; 2708500–2710100; 2716570–2718335]

The queue subscribes to vault create/modify for non-Markdown files, rename for files, metadata-cache changed for files, and delete. Updates enqueue affected files; deletion removes pending entries and their displayed result. Markdown modifications therefore depend on metadata change notifications in this path. Queue unload cancels work. Filter/configuration-change-triggered full rescan behavior is not established by these subscriptions. [2031493–2033140]

The scan checks whether to yield every ten processed entries and yields when elapsed work exceeds five milliseconds. Its scheduler requests idle time with a 100-ms timeout/fallback when available, otherwise an animation frame. Result count updates occur on yields and queue stop. After a yield has observed the result container visible, a subsequent hidden result container can suspend further iteration until insertion. These are cooperative scheduling mechanisms, not proof of latency, throughput, or memory parity. Regex evaluation itself is synchronous in the inspected path; no per-regex timeout is present here. [1445788–1446445; 852362–852797; 1472110–1473660; 2716570–2717780]

View state serializes `query`, `matchingCase`, `explainSearch`, `collapseAll`, `extraContext`, and `sortOrder`. The constructor initializes case matching/explanation/settings visibility false, and result settings as described above. The show-settings-panel flag is not included in the inspected serialized state. Case changes rerun a nonempty query; collapse/context/explanation changes update presentation and request layout saving. Explain-search renders the matcher tree including separate property key/value branches. Parse errors are appended to its information container and logged; visibility still depends on surrounding view state, so do not promise an always-visible error banner. [2708500–2718335]

Recent nonempty queries are saved through a reset-on-call five-second deferred callback. Exact duplicates are removed, newest is placed first, and history is capped at 20 in `recent-searches` local storage. Search suggestions expose a subset of operators, not the engine's full grammar. Desktop suggestions attach automatically; mobile has an explicit suggestion button. Full suggestion ranking/completion/history deletion behavior was not audited. [2697510–2703050; 2708500–2714300]

Copy results exports the sorted file list, with full path or short name, plain/wikilink/Markdown-link style, and none/dash/asterisk/numbered prefix. The dialog persists these formatting options through global-search plugin data and copies the textarea value. It is file-list export, not snippet export. [2718335–2720600]

## Verification still required

No independent reconstruction tests or reference execution were performed in this audit. The following fixtures should gate implementation parity:

1. Operator precedence, scoping, exclusivity and malformed/incomplete input; reserved-word case; tab/newline handling; escapes and unterminated delimiters.
2. Quotes across content/filename/path/property names, Unicode and digit boundaries, regex multiline/zero-length behavior, and range merging without equating occurrence count to snippet/file count.
3. Typed null/Boolean/numeric/string property values, arrays, empty arrays, missing keys, comparisons, nested objects and exclusion-only property values.
4. Line/block/heading/list metadata positions, nested sections, preambles, nested tasks and custom task markers; descendant tags versus prefix-only lookalikes.
5. Markdown, Canvas, Bases, supported attachments and unsupported-file configuration; ignored files; read failures; metadata freshness; self-query fences.
6. File replacement/deletion/rename while searching; cancellation during reads; duplicate events; hidden views; large-vault and pathological-regex workloads under measured runtime conditions.
7. Locale/tie sorting, context grouping/expansion, collapse preservation, file/property/Canvas navigation, source-snapshot mismatch, keyboard focus and highlight lifetime.
8. Restored view state, debounce/history behavior, explanation/error visibility, copy formatting and the separately registered CLI contracts.

The matcher/parser/operator/update branches described here are inspected; complete metadata production, all suggestion behavior, renderer virtualization internals, editor-local find/replace, regex denial-of-service characteristics, full plugin API compatibility, Android equivalence, and runtime performance/visual parity remain open. This document does not close the whole search feature or certify a clone implementation.
