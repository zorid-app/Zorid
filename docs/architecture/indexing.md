# Documents, indexing and caches

[Architecture](README.md) · [Search](search.md) · [SQLite](sqlite.md)

## Current systems

`zorid-document` extracts source-aware Markdown metadata: properties/frontmatter,
aliases, tags, headings, links and task occurrences. Parsing is derived work;
invalid YAML produces metadata diagnostics rather than a refusal to save the note.
The parser exposes identity-free `ParseFacts` through `parse_markdown_facts`;
explicit binding supplies the current entry ID and revision. The existing
`parse_markdown` facade returns the same document metadata and diagnostics.

`zorid-index` defines source manifests, immutable generations, semantic versions,
publication fences, retained snapshots and metadata projection. Pure generation
validation is not storage publication. Hosts must recheck source identity/heads
and atomically publish matching rows and generation metadata.

Native `Store::pump_document_index` performs bounded work, reuses compatible
records from a prior generation before parsing, and keeps parsing outside storage
write transactions. It already persists derived metadata; caching is not being
introduced from nothing. Native cache tables now live on an independent app-local `cache.sqlite`
connection (or an in-memory fallback for bare embedders). Source remains in
`vault.sqlite`; old optional authority cache tables are recognized but inert.

The browser host stores local-only persisted generation data in IndexedDB and
uses the same Rust semantics through WASM. Neither cache is sync authority.

## Accepted optimization direction

Measure cold/warm startup, incremental update cost, large-note parsing, large-vault
queries, memory and UI responsiveness before claiming improvement. Add bounded
parallel Rust extraction where independent documents permit it. Keep storage
publication coordinated and reject results for stale revisions/generations.

The shared [extraction boundary](../../crates/zorid-index/src/extraction.rs)
now provides typed keys/results and validated binding. Keys include the local
store scope, exact source SHA-256 and byte/UTF-16 lengths, Markdown/plain-text
mode, parser schema/dialect/extraction versions and facts encoding version.
Current parser options are compiled into those semantic versions. Facts retain
raw links and source positions without entry identity, path, resolved targets or
generation context. Binding checks integrity and structural ranges, then attaches
the captured current witness; cache data never authorizes a source mutation.

Shared optional cache admission uses a1MiB encoded-row cap,64MiB total payload
and100,000 rows, with FIFO admission order and at most32 victim removals per write.
Oversized supported facts still extract/bind normally and skip caching. This cache
budget is separate from existing generation/metadata and bounded transport limits.
These are initial resource bounds, not measured memory or latency promises.

The pure extraction/policy layer is integrated and tested. New native reusable
facts tables and the browser derived prefix are **being implemented**; persistent
content-derived reuse is not yet an accepted runtime capability. Existing
same-entry generation reuse remains distinct. Browser retains joined-group working
data and persisted derived indexes between visits; its storage engine need not
mirror native databases. Cache failures and eviction must preserve source,
receipts, pending writes, recovery and pinned generations.

The [confirmed performance design](indexing-search-design.md) includes Bases query
execution and search/backlinks. Persist parse/search-index reuse; keep compiled
Bases and final answers initially in bounded memory. Index successful saves,
prioritize interactive work, retain coherent previous results during updates and
mark first-build partial coverage explicitly. Time-dependent answers refresh in
configured/device-local timezone. See the [S1 slices](../plans/indexing-search.md)
for implementation and measurement gates.

## Interface review gate

[S0A module interface review](interfaces.md) checks supported consumer operations,
identity/transaction boundaries, errors, lifecycle and platform capabilities before
S1 optimization/downstream feature work. Storage contracts are reviewed during S0
design as well; the gate must not wait until an incompatible layer is built.

## Source map

[Parser](../../crates/zorid-document/src/lib.rs),
[index contracts](../../crates/zorid-index/src/lib.rs),
[typed extraction/cache policy](../../crates/zorid-index/src/extraction.rs),
[native persistence/pump](../../crates/zorid-store/src/document_index.rs),
[native query facade](../../crates/zorid-native/src/document_index.rs),
[browser cache host](../../src/core/browser-document-index.ts).
