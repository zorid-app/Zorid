# Documents, indexing and caches

[Architecture](README.md) · [Search](search.md) · [SQLite](sqlite.md)

## Current systems

`zorid-document` extracts source-aware Markdown metadata: properties/frontmatter,
aliases, tags, headings, links and task occurrences. Parsing is derived work;
invalid YAML produces metadata diagnostics rather than a refusal to save the note.

`zorid-index` defines source manifests, immutable generations, semantic versions,
publication fences, retained snapshots and metadata projection. Pure generation
validation is not storage publication. Hosts must recheck source identity/heads
and atomically publish matching rows and generation metadata.

Native `Store::pump_document_index` performs bounded work, reuses compatible
records from a prior generation before parsing, and keeps parsing outside storage
write transactions. It already persists derived metadata; caching is not being
introduced from nothing. Cache tables currently share `vault.sqlite`.

The browser host stores local-only persisted generation data in IndexedDB and
uses the same Rust semantics through WASM. Neither cache is sync authority.

## Accepted optimization direction

Measure cold/warm startup, incremental update cost, large-note parsing, large-vault
queries, memory and UI responsiveness before claiming improvement. Add bounded
parallel Rust extraction where independent documents permit it. Keep storage
publication coordinated and reject results for stale revisions/generations.

Reuse content-derived parse results using content hashes plus parser/schema and
relevant semantic options. Reattach path/entry/revision context correctly; cached
metadata from another identity is not an authority witness. A future cache key
must account for all inputs that affect extraction, not only file modification time.
Separate app-local `cache.sqlite` is accepted native placement direction, not
current code. Browser retains joined-group working data and persisted derived
indexes between visits, with incremental catch-up; its storage engine need not
mirror native databases.

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
[native persistence/pump](../../crates/zorid-store/src/document_index.rs),
[native query facade](../../crates/zorid-native/src/document_index.rs),
[browser cache host](../../src/core/browser-document-index.ts).
