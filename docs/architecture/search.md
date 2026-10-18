# Search, links and relationships

[Architecture](README.md) · [Indexing](indexing.md)

## Current

Rust index generations support literal text query paging, retained source reads,
link resolution, backlinks and relationship traversal. Results are bound to a
source/index snapshot; continuation tokens must not silently switch generations.
Native and WASM bindings expose these operations through platform document services.

The TypeScript search frontend also contains a richer query/parser and presentation
layer. Not every visible search operator is established as a fully Rust-owned
inverted index. Keep the exact backend capability explicit rather than describing
all search as one completed Rust subsystem.

Search, quick switching, backlinks, graph and Bases can consume related metadata,
but have different presentation/query needs. Derived index corruption requires
rebuild without preventing authoritative note saves.

## Accepted optimization direction

Cancel stale requests when a query changes, keep work off the UI thread, reuse
parsed metadata and retained snapshots, and bound concurrent work. Parallel parsing
and parallel query execution are separate optimizations; profile each. Publish
only results matching the original vault/revision/generation and measure warm
query latency as well as indexing throughput.

## Source map

[Literal queries](../../crates/zorid-index/src/literal.rs),
[link resolver](../../crates/zorid-index/src/resolver.rs),
[relationships](../../crates/zorid-index/src/relationships.rs),
[frontend search](../../src/search/),
[document service contract](../../src/core/document-semantics.ts).
