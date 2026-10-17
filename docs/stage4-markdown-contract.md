# Stage 4 Markdown extraction contract

Preparation owner: `stage4_markdown_contracts`, 2026-10-17. Baseline main is
`f69dc90de0de697dfb75a5a3d1805b69dba982b3`. Worktree
`/Users/ctk/orca/workspaces/Zorid/stage4-markdown-contracts`, branch
`tingkai-c/stage4-markdown-contracts`; root is the sole main integrator.
This document and `tests/fixtures/document-semantics/markdown/*` are the owned
paths. Dependencies: root's shared-type review, YAML library selection, then the
serialized native/WASM build slot. No parser or consumer implementation is
included. The root coordinator approved reference links, JSON-safe YAML values,
integer safety and the explicit resource bounds below for this contract.

The [accepted milestone](shared-document-semantics-plan.md) and
[reuse assessment](document-semantics-reuse-assessment.md) define the boundary:
headless metadata moves to portable Rust; CodeMirror syntax, rendering, property
and link source transformations stay in TypeScript. Invalid metadata does not
prevent reading, editing, saving or syncing raw content. No metadata operation
rewrites source, owns vault storage, resolves file paths or publishes an index.

## Existing implementation and evidence

All source links below are relative to this baseline. Inventory is deliberately
about actual code and focused tests, not inferred Obsidian parity.

| Area | Source and tests | Observed behavior |
| --- | --- | --- |
| Result | [`NoteMetadata`, `Heading`, `NoteLink`](../src/core/types.ts#L50) | Path identity only; headings have zero-based line; links have half-open JavaScript UTF-16 destination ranges. No task records, diagnostics, parser version or revision provenance. |
| Properties | [`readProperties` and parser options](../src/core/properties.ts#L63), [property tests](../tests/properties.test.ts#L8) | Ordered YAML 1.2 core mappings; dates remain strings. Nested arrays/maps, block scalars and ordinary aliases survive. Duplicate keys, warnings/custom tags, nonmapping roots, bad keys, cycles and excessive alias expansion throw. Magic object keys are safe own data. |
| Inferred types | [`inferPropertyType`](../src/core/properties.ts#L87) | `text`, string `list`, `number`, boolean `checkbox`, calendar-valid `date`, validated ISO-like `datetime`, case-insensitive `tags` key and `unknown`. Null, maps and mixed lists are unknown. A vault registry may override this inference outside extraction. |
| YAML framing | [`splitFrontmatter`](../src/core/properties.ts#L27), [`parseMetadata`](../src/core/metadata.ts#L13), [BOM/CRLF test](../tests/core-metadata.test.ts#L88) | Initial optional BOM, `---` opener, `---`/`...` closer, horizontal whitespace and delimiter comments, LF/CRLF. Closed invalid YAML is excluded but silently yields no properties. Missing closer makes `readProperties` throw while metadata scans the original Markdown. A bare EOF `---` is also rejected by the property reader. |
| Tags and aliases | [`asStrings` and projections](../src/core/metadata.ts#L5), [basic metadata test](../tests/core-metadata.test.ts#L5) | Lowercase exact plural key wins with nullish singular fallback. String fields split commas and trim; arrays stringify every value. Frontmatter tags lose one leading `#`; body tag names use letters/numbers/underscore/slash/hyphen. ASCII digit-only body tags are ignored. Dedupe is exact and stable, frontmatter before body; aliases retain order and duplicates. |
| Headings | [`parseMetadata` heading scan](../src/core/metadata.ts#L39) | Only ATX headings at up to three leading spaces; plain regex text after masking code/comments. No Setext or quote/list heading recognition; inline code is erased rather than included in heading text. |
| Links | [`parseMetadata` link scans](../src/core/metadata.ts#L47), [offset tests](../tests/core-metadata.test.ts#L15) | Wiki links/embeds and inline Markdown links/images, angle destinations, title and one-level parentheses. Raw path and `#fragment` are separate; only path receives a range. External Markdown URI schemes and protocol-relative URLs are excluded; wiki external-looking targets remain records. No reference links; an immediately preceding backslash suppresses links even with an even escape count. |
| Exclusions | [`visible` masking](../src/core/metadata.ts#L24) | Closed frontmatter, column-0–3 fences, paired HTML/`%%` comments, same-line backticks. Fenced EOF is excluded. Indented code, HTML blocks and container fences are not fully recognized. Offsets are kept stable by replacing UTF-16 units with spaces. |
| Tasks | [`listMarkers`](../src/editor/live-lists.ts#L10), [`liveTasks`](../src/editor/live-tasks.ts#L13), [Reading lists](../src/ui/markdown-lists.ts#L132), [task tests](../tests/live-tasks.test.ts#L42) | Editor/presentation only: syntax-gated leading markers on real list items. One non-CR/LF UTF-16 unit, including custom statuses. Checked means not ASCII space; completed styling only `x`/`X`. Nested/quoted/ordered tasks work; prose, code, HTML, escaped/invalid markers do not. Astral statuses are two UTF-16 units and stay literal. |
| Consumers and edits | [outline/tags/backlinks](../src/ui/workspace.ts#L1130), [rename rewrite](../src/core/vault.ts#L573), [Base properties](../src/bases/controller.ts#L206) | Existing consumers expect old types. Rename uses reverse-order exact source spans, preserving labels/fragments/title. Extraction additions do not authorize using shared reference-definition ranges for rename. Consumer adaptation needs a separate review. |

On 2026-10-17, Node `v26.10.0`,
`node --test tests/core-metadata.test.ts tests/properties.test.ts` passed 22/22
in 216 ms on the baseline checkout, without edits. Direct probes additionally
confirmed indented-code/HTML false positives, absent Setext support, mixed tag
values becoming `"[object Object]"`, `.nan`/`.inf` escaping the reader, unsafe
integer rounding, numeric scalar mapping-key stringification and ordinary aliases.
These are observations; only the explicit contract decisions below are targets.

`typescript-baseline.json` records every corpus input through both current
`parseMetadata` and `readProperties`. Reader failure is a boolean because error
prose is library-specific. Nonfinite old-reader numbers use the observation-only
object `{"tsNonFiniteNumber":"NaN"}` / `"Infinity"` to avoid JSON silently
turning them into null. This encoding is never an output of the new engine.

## Portable request and result

The JSON spelling here is the proposed wire/fixture spelling; root owns final
Rust/public API naming. Reuse `zorid_core::EntryId` and `Revision`, whose
[existing constructors](../crates/zorid-core/src/identity.rs#L14) accept only
1–128 ASCII letters, digits, `_` and `-`. Do not introduce a weaker identity type.
The request has only `entryId`, `contentRevision` and `source` (valid Unicode
text). Parsing is content-only. The index wrapper supplies an optional path and
vault scope, validates the caller's revision and rejects stale publication.

The full executable shape is in
[`corpus.json`](../tests/fixtures/document-semantics/markdown/corpus.json).
There are no optional omitted arrays; absent ranges are JSON null.

```text
MetadataRequest { entryId: EntryId, contentRevision: Revision, source: String }
SourceRange { bytes: [u32; 2], utf16: [u32; 2] }
Property { key, value: JsonValue, type: PropertyType, keyRange: SourceRange }
TagOccurrence { name, range: SourceRange }  // body occurrences only
Heading { text, level: 1..6, line: u32, range: SourceRange }
Link {
  kind: "wiki" | "markdown", embed: bool, target, fragment,
  range: SourceRange, targetRange: SourceRange,
  definitionRange: SourceRange | null
}
Task {
  status, checked: bool, completed: bool, text, line: u32,
  range: SourceRange, statusRange: SourceRange, textRange: SourceRange
}
Diagnostic { code, severity: "error" | "warning", range: SourceRange }
Metadata {
  schemaVersion: 1, dialectVersion: "zorid-markdown-1",
  entryId, contentRevision, sourceLength: { bytes: u32, utf16: u32 },
  frontmatter: {
    state: "absent" | "valid" | "invalid" | "unclosed",
    range: SourceRange | null, bodyStart: { byte: u32, utf16: u32 }
  },
  properties: Property[], aliases: String[], tags: String[],
  tagOccurrences: TagOccurrence[], headings: Heading[], links: Link[],
  tasks: Task[], diagnostics: Diagnostic[]
}
```

`JsonValue` means finite binary64 JSON numbers, strings, booleans, null, arrays
and string-keyed maps. It is not a tagged date/object/runtime value. Property
order is a vector, never a JSON object's enumeration order. Nested map ordering
is semantically irrelevant; prototype-like keys remain data. A string scalar
mapping key is retained verbatim after YAML decoding; ordinary nonstring scalar
keys are converted to their YAML string spelling as the current `stringKeys`
policy does. Collection keys, empty/whitespace-only keys and control characters
U+0000–001F/U+007F in keys invalidate the whole frontmatter.

`schemaVersion` describes result shape; `dialectVersion` describes extraction
rules/default bounds. Index invalidation includes both, as well as entry and
content revision. Do not use a crate build's package version as a cache identity
while silently changing dialect behavior. Results contain no wall-clock time,
absolute path, filesystem handle, HTML or host-specific data. Source-order arrays
and fixed diagnostic ordering must match on native and WASM.

Request errors (invalid shared ID, invalid Unicode at the binding boundary or
source over the fixed source-byte budget) are typed extraction errors without a
metadata result. They are not storage errors. WASM must reject unpaired UTF-16
surrogates before encoding rather than replace them and return shifted ranges.
The eventual binding owner must test these errors; the initial corpus contains
valid requests with metadata diagnostics, not invalid transport encodings.

## Source positions and record meaning

Every range is half-open in the original, unnormalized input. Byte indices count
UTF-8; UTF-16 indices match JavaScript slicing. Initial BOM counts three bytes and
one UTF-16 unit; an astral scalar counts four bytes/two units; combining marks
are separate scalars. Boundaries never split a UTF-8 scalar or surrogate pair.
No Unicode normalization, newline replacement or tab expansion changes source.
Lines are zero-based; CRLF is one newline, LF or bare CR is one newline each.

- `frontmatter.range` includes opening/closing delimiter lines and optional BOM,
  including the closing line ending if present. Body starts exactly after it.
  For absent frontmatter it is null and body starts at zero. An unclosed opener
  has the opening-line range, body start zero and no YAML properties; the whole
  source remains available to the Markdown parser. A leading BOM is ignored for
  Markdown syntax even without frontmatter, while all positions still count it.
- `keyRange` covers a property's source key spelling, including quotes when
  quoted; decoded `key` need not equal that spelling. Nested value-specific
  rewrite spans are intentionally absent. Source-preserving property edits keep
  their current owner.
- `Heading.range` begins at the ATX marker or first Setext text character, after
  an enclosing container prefix, and ends after the final heading line excluding
  its newline. Setext ranges include the underline. `text` is plain visible text:
  parser text/inline-code content, decoded entities and link/image labels; omit
  formatting delimiters and HTML tags, turn soft/hard breaks into spaces.
- `Link.range` covers the complete occurrence, including `!` for embeds/images.
  `targetRange` covers only raw destination path spelling, excluding angle
  wrappers, `#fragment`, alias, label and title. A local fragment has a zero-width
  target. `target` and `fragment` preserve raw spelling; fragment includes `#`.
  File lookup, percent/entity/escape normalization and path policy belong to
  link resolution. Do not substitute the parser's unescaped URL for raw source.
- Reference Markdown links have a use-site `range` and shared definition
  `targetRange`/`definitionRange`; the latter covers the whole definition excluding
  its final newline. Full, collapsed and shortcut references follow CommonMark
  label matching; unresolved references are literal. Repeated uses can share a
  destination range. Sort by occurrence, not destination. This is extraction,
  and does not grant reference-definition rewrite ownership.
- `Task.range` is only `[status]`; `statusRange` is the single status character.
  `textRange` and `text` cover the rest of that physical first line after optional
  ASCII spaces/tabs following the marker, excluding CR/LF. Keep Markdown spelling
  and trailing whitespace. Do not combine continuations or children. Empty task
  text has a zero-width range at marker end. No dates/calendar semantics arise.
- `tags` is the stable deduplicated list of frontmatter names then body names;
  `tagOccurrences` retains every body occurrence and its complete `#name` range.
  Frontmatter provenance is available through the corresponding property key.
  `aliases` retains declaration order and duplicates.

These ranges are read provenance, not permission to apply a stale edit. Every
source transformation must verify current entry/revision and its own syntax
preconditions. A clean offset slice check alone does not establish safe rewrites.

## Dialect, exclusions and malformed input

Use the established Markdown parser for block/inline structure, heading text,
reference resolution and list membership. Apply small Zorid adapters only for
frontmatter framing/typing, paired `%%` comments, tag detection, custom task
statuses and exact original-source spans. Do not build a second Markdown/YAML
parser. Pulldown's standard task marker event covers only the common statuses;
custom statuses must be recognized only within parser-confirmed list items.

Frontmatter starts only at byte zero after an optional BOM, using `---`, optional
horizontal whitespace/comment and a newline; a bare EOF opener is unclosed.
Closing `---` or `...` is at column zero with optional horizontal whitespace/comment
and newline/EOF. CRLF, LF and bare CR are accepted. Empty/comment-only YAML is a
valid empty property map. The first matching closer ends the block.

YAML uses 1.2 core values, strict duplicate detection at every map depth and no
custom/tag-driven application constructors. Dates/datetimes stay strings with the
current explicit inference rules, never timezone-dependent runtime objects.
Ordinary bounded acyclic aliases resolve to values. Missing/cyclic aliases,
custom tags, bad syntax, unsupported keys and nonmapping roots reject the entire
frontmatter. No partially trustworthy property set is published. Nonfinite
numbers and integer-valued numbers outside ±9,007,199,254,740,991 reject it with
`frontmatter_value`; finite fractions are binary64. This intentionally prevents
current reader loss when JSON serializes nonfinite numbers or rounds integers.

Plural lowercase `tags`/`aliases` use nullish fallback to singular `tag`/`alias`.
A string splits on commas and trims/omits empty pieces; an array contributes only
string entries, preserving their spelling/order. Other shapes/nonstring array
entries yield one `projection_non_string` warning for that selected property,
while retaining its full typed value. A tag loses one leading `#`. Only the
projection is restricted; a general mixed YAML property remains valid.

Body metadata excludes closed frontmatter even when its YAML is invalid; fenced
and indented code; inline code; parser-confirmed raw HTML blocks/comments; paired
`%%...%%` comments; and link destinations/reference definitions when looking for
body tags. Quote/list containers use parser structure, including nested fences.
Inline HTML tags do not hide surrounding visible text. An unmatched `%%` is
literal text; an unclosed HTML comment/code fence follows CommonMark exclusion
through EOF. Unmatched inline backticks/brackets are literal text. Ordinary
incomplete Markdown yields no generic syntax-error diagnostic. Math extension
semantics are not added in this first extraction contract; mathematical notation
continues as ordinary Markdown unless it belongs to an existing exclusion.

Body tags start at document/text start or after whitespace/`(`, followed by one
or more Unicode letters, marks, numbers or `_` `/` `-`. Exclude names composed
only of Unicode decimal digits. Keep exact case and spelling, including trailing
slashes/hyphens. Escaped `#` is literal. Detection is over original visible text
spelling; entity-created punctuation does not invent a source hashtag. Combining
marks and non-ASCII digit-only exclusion intentionally correct old regex gaps.

Headings include ATX and Setext within containers. Internal link extraction
includes wiki links/embeds and Markdown inline/reference links/images. Apply
standard odd/even backslash escaping. URI-scheme or `//` Markdown destinations
are external and omitted; external-looking wiki targets remain raw records to
preserve existing extraction (the resolver can reject them). Preserve `%23`
as part of a path; only literal `#` splits the raw fragment. No file-existence or
case/Unicode path resolution occurs in extraction.

Tasks are leading markers on a real unordered/ordered list item's first
paragraph, after list/container syntax and separating whitespace. The status is
one BMP Unicode scalar other than CR/LF (one UTF-16 unit), including a tab or
custom punctuation. The marker must be followed by ASCII space/tab or line end.
`checked = status != " "`; `completed = status in ["x", "X"]`. Keep astral and
multi-character statuses literal to preserve the current editor dialect.

## Diagnostics and resource bounds

Diagnostic prose is supplied by consumers from a stable code; no dependency
error string is an API contract. Whole-frontmatter failures point to the whole
framed block, so unrelated YAML-library error spans do not make native/WASM
results differ. The unclosed diagnostic points to the opener. Projection
warnings point to the selected property's key.

| Code | Severity | Result |
| --- | --- | --- |
| `frontmatter_unclosed` | error | No properties; source parsed as Markdown from zero. |
| `frontmatter_syntax` | error | Closed block excluded; no properties; body parsed. |
| `frontmatter_duplicate_key` | error | Same, including nested duplicates. |
| `frontmatter_mapping` | error | Same, including explicit null/scalar/sequence root. |
| `frontmatter_tag` | error | Same; unsupported explicit tag. |
| `frontmatter_alias` | error | Same; unresolved or cyclic alias. |
| `frontmatter_value` | error | Same; unsupported key/value, nonfinite/unsafe number. |
| `frontmatter_resource` | error | Same; YAML resource budget exhausted. |
| `projection_non_string` | warning | Valid properties retained; only string names projected. |

Return one whole-frontmatter diagnostic. If multiple failures are observable,
choose in this priority: resource, syntax, duplicate key, unsupported tag, alias,
nonmapping root, unsupported value. Projection warnings only follow successful
YAML decoding, in selected property source order. Body extraction does not
invent diagnostics because a note contains partial Markdown.

Fixed initial defaults, identical on native/WASM: input ≤16 MiB UTF-8; framed
frontmatter ≤1 MiB; YAML value depth ≤64 with scalar root depth zero; ≤100,000
expanded JSON value nodes, counting container and scalar values; ≤1,000 values
created by alias substitution, counting every copied container/scalar including
nested copies. Exceeding the input cap is an extraction request error; exceeding
YAML caps yields `frontmatter_resource`, preserving body extraction. Bound
iteration/recursion before materializing an oversized expansion. Never truncate
metadata silently or publish a partial YAML map. Fixed defaults are part of this
dialect and must not depend on architecture, locale, clock or host settings.

Current `yaml@2.9.0` is different: `readProperties` passes `maxAliasCount:100`,
and its `dist/nodes/Alias.js` rejects an anchor's use count times recursive alias
amplification above 100. This is not simply 100 references or 100 expanded nodes.
The old reader's ordinary-alias and nested 10×10×10 cases were verified; the
new explicit portable bounds are an intentional policy change, not claimed exact
legacy parity. Further boundary tests belong to parser implementation.

## Reuse choice and fixture execution

Proposed parser pin: `pulldown-cmark = "=0.13.4"`, `default-features = false`.
The earlier assessment examined upstream 0.13.1; this session read the locally
cached 0.13.4 `Cargo.toml`, `src/lib.rs` and `src/parse.rs` under
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`. Manifest still declares
MIT/Rust 1.71.1; defaults enable CLI `getopts`/HTML, which extraction does not
need. Source exposes `Parser::into_offset_iter`, wiki/task options,
`RefDefs::get`/`iter`, and `LinkDef { dest, title, span }` for reference provenance.
Use tables/strikethrough/tasks/wiki extensions as needed for the accepted editor
dialect; do not enable smart punctuation, generated heading IDs or unrelated
syntax. Frontmatter framing remains the small compatibility adapter because the
accepted BOM/comments/dot closer/unclosed policy is explicit above.

This is a source-based pin proposal, not an authenticated upstream package audit
or a build result. The fixed-version docs.rs pages could not be fetched by the
web tool in this session; local source was the primary evidence. Dependency
adoption/license lock review belongs to root. YAML dependency selection is still
open; evaluate a maintained portable YAML parser against these fixtures rather
than write custom YAML. MDBASE and index/query work have separate owners.

The 40-case corpus covers valid typed/nested YAML, ordinary/malicious aliases,
invalid/duplicate/tagged YAML, mixed projections, nonfinite/unsafe numbers,
BOM/CRLF/bare-CR/astral/decomposed Unicode, empty/partial Markdown, exclusions,
ATX/Setext/container headings, raw/inline/reference links and task dialect.
It is a representative initial acceptance corpus, not full CommonMark/Obsidian
conformance. Per-case `decision` separates preservation from intentional changes.

Run without dependencies or builds:

```sh
node tests/fixtures/document-semantics/markdown/verify.mjs
node tests/fixtures/document-semantics/markdown/verify.mjs --typescript /abs/checkout/src/core/metadata.ts
node tests/fixtures/document-semantics/markdown/verify.mjs --results /abs/native-results.json
node tests/fixtures/document-semantics/markdown/verify.mjs --results /abs/wasm-results.json
```

`--results` accepts exactly `[{"id":case.id,"result":actualMetadata}, ...]` in
corpus order and deep-compares every field to `expected`. Both native and browser
WASM harnesses must read `request`, execute the actual engine and emit that shape.
They must not copy `expected` into their result. The checker itself validates
IDs/provenance, byte/UTF-16 boundaries/source slices, ordering, line positions and
task invariants; it does not implement parsing. The TypeScript option checks all
recorded baseline observations, including intentional mismatches with the target.

Verification at preparation completion: the checker and all 40 current TypeScript
observations pass; 22 existing property/metadata tests pass. The first checker
run caught an accidentally empty status in the final empty task and was corrected;
fixture IDs were corrected to the existing strong-ID grammar before completion.
No dependency change, parser execution, Rust/WASM build, app migration, native
or mobile parity, lossless-edit equivalence or performance claim is established.

Next proposed implementation scope, after root review: new portable
`crates/zorid-document` metadata module/types and native tests reading this corpus,
then a minimal WASM JSON seam reading the same requests. Root owns shared/root
manifests and locks; no worker edits those until assigned. Preserve this corpus
as an independent oracle and add focused resource/request-error boundary tests.
Consumer switches and index publication occur in later coherent reviewed changes.
