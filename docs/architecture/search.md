# Search, links and relationships

[Architecture](README.md) · [Indexing](indexing.md)

## Rust query execution

Vault Search uses the shared Rust dialect `zorid-search-rust-unicode-1` over
admitted retained source and metadata. Rust parses and evaluates substrings,
quotes, Boolean/group/exclusion expressions, file/path/content scopes, typed
properties and tags, and parser-backed line/block/section/task scopes. Case is
insensitive by default, with an explicit option and scoped case modifiers.

Regex uses the pinned Rust Unicode scalar/simple-fold semantics, without locale
folding or normalization. Unsupported lookaround, backreferences and suffix flags
produce diagnostics rather than JavaScript fallback. Quotes use Unicode
Letter/Decimal_Number boundaries. Empty predicate success can have no highlight;
filename, path, property and source locations retain distinct provenance. This is
the implemented Zorid dialect, not a claim of complete Obsidian compatibility.
The [language support record](../reference/query-language-support.md) separates
the rich evaluator checkpoint from its historical literal baseline and deviations.

The older [TypeScript engine](../../src/search/query.ts) remains a comparison
implementation. A rich-capable document service does not invoke it. The literal
API and capability-absent adapter UI remain for compatibility; a rich query error
must not silently select those paths. Attachment names/metadata can be searched
where admitted; binary bodies, PDF extraction and OCR are outside this search
path. Bases retains its separate YAML/expression language.

## Retained paging and presentation

A document pin owns one source/index snapshot. Its rich query session accepts a
`SearchSpec`, prepares a core-owned ordering, pages through opaque continuation
tokens and closes explicitly. Name, modified-time and created-time order each
have ascending/descending variants, using frozen presentation facts rather than
live UI sorting. Hosts must correlate those facts with the manifest's exact file
order and recheck pin/source ownership before admitting reads or committing pages.
Continuation never silently switches generations.

Rust supplies authoritative file/occurrence counts, typed locations, exact
snippets and every associated highlight. A transient per-file snippet projector
reuses coordinate/context work across chunks; it does not retain a source-body
cache. File counts can repeat across chunks, and a location can recur to accompany
another snippet. Consumers deduplicate stable location indices and never sum
chunks or highlights into a replacement match count.

Scan coverage, query/output completion and generation coverage are separate.
Empty progress pages are legal; scanning can finish while file chunks remain.
Counts explicitly distinguish exact, lower-bound and unknown values. Query,
source-read, output and retained-memory bounds produce explicit resource outcomes,
not silently missing matches. Regex calls remain synchronous, with cancellation
checks around bounded calls rather than mid-engine preemption.

The TypeScript controller serializes query/page ownership, debounces input,
retains the pin across option changes when source is unchanged, and closes stale
queries before replacement. It renders validated DTOs as collapsible file groups,
with bounded display retention and explicit continuation/truncation. Source
refresh keeps old coherent results marked stale. Retiring a run aborts only its
owned freshness demand; lifetime/epoch guards also reject obsolete replies.

Navigation opens by stable entry identity. A source range is selected only after
an exact current durable revision and clean, corresponding editor buffer are
confirmed after flush. Other origins and changed/dirty notes open without a forged
source offset. In-note Find is a separate editor/Reading presentation feature;
Live Edit Find searches the current unsaved editor document.

## Relationships and rollout boundary

Rust owns link resolution, backlinks and relationship traversal over retained
metadata. Search, graph, quick switching and Bases share relevant facts but keep
their own presentation/query contracts. Derived corruption requires rebuild and
must not block authoritative note saving.

Desktop grouped Search and Live/Reading Find pass the recorded bounded functional
fixture. Browser production execution currently rejects the first rich Search
with `invalid_request`; diagnosis identified pin presentation-fact ordering. The binding fix is integrated
and passes focused tests and real-WASM controls; a matching browser rebuild and
full functional run remain pending. This does not establish workload performance or platform
parity; see the [execution checkpoint](../deferred-product-roadmap.md).

Pure sealed first-build captures and rich preview queries are integrated. Their
rows remain explicitly incomplete and their identities cannot be used as
published pins or mutation witnesses. Preview platform/UI wiring, Bases preview
consumption and normal runtime activation remain pending; runtime flags stay off.
Multicore execution is outside S1. Shared lifecycle ownership, fewer repeated
computations and measured foreground responsiveness remain required.

## Source map

- [Rust dialect/evaluator](../../crates/zorid-index/src/search/mod.rs),
  [parser](../../crates/zorid-index/src/search/parser.rs),
  [ordering](../../crates/zorid-index/src/search/order.rs),
  [query/paging owner](../../crates/zorid-index/src/search/runtime.rs),
  [page DTOs](../../crates/zorid-index/src/search/page.rs) and
  [snippet projector](../../crates/zorid-index/src/search/snippet.rs).
- [Preview queries](../../crates/zorid-index/src/search/preview.rs),
  [link resolver](../../crates/zorid-index/src/resolver.rs) and
  [relationships](../../crates/zorid-index/src/relationships.rs).
- [Native binding](../../crates/zorid-native/src/document_index.rs),
  [WASM binding](../../crates/zorid-wasm/src/document_index.rs),
  [document service](../../src/core/document-semantics.ts) and
  [strict rich decoder](../../src/core/document-search-validation.ts).
- [Search controller](../../src/ui/document-search-controller.ts),
  [grouped view](../../src/ui/document-search.ts),
  [editor Find](../../src/editor/find-panel.ts) and
  [Reading Find](../../src/ui/reading-find.ts).
