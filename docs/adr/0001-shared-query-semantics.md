# Shared Rust queries with dedicated language modules

Zorid keeps Bases compilation/evaluation in its own Rust module and reuses shared
index/query capabilities for actual search, task and calendar consumers. This
avoids duplicated semantics and invalidation across features while preserving
separate documented Obsidian Bases and vault-search languages; an unrestricted
universal language is not a prerequisite. Supported syntax targets documented
results, and existing dialect deviations require explicit review before retention
or change; this boundary was confirmed on 2026-10-18.

See the [confirmed design](../architecture/indexing-search-design.md) and
[implementation slices](../plans/indexing-search.md). This records direction,
not completed runtime compatibility.
