# Current architecture decisions

[Architecture](README.md) · [Execution checkpoint](../deferred-product-roadmap.md)

Accepted on 2026-10-18 in the documentation/architecture discussion. These decisions
supersede older execution sequencing where they conflict; they do not certify
implementation or authorize discarding existing vault/recovery content.

| Decision | State |
| --- | --- |
| Design for desktop, browser and mobile from the outset | Accepted; native clients retain vaults, browser joins existing sync groups |
| Shared TypeScript editor/UI and portable Rust data semantics | Implemented foundation; full feature/runtime acceptance is separate |
| Storage layer, saving and local recovery first; Rust indexing/search/cache performance next | Latest user priority; editor correctness is mostly satisfactory |
| Complete desktop Bases, Tasks, Calendar, Google integration and core performance before resuming iOS implementation | Current delivery order; preserve paused native work |
| Use SQLite and a unified Rust database infrastructure layer | Accepted direction; native Store exists, unified layer does not |
| Explicit modular-interface review for storage, indexing and caching | S0A gate after S0 and before S1; storage contract review starts during S0 design |
| Browser joins existing sync groups and retains a persistent local working replica/indexes | Latest correction; low-latency local use and incremental catch-up, no native vault directory |
| Browser attachment bodies | On-demand fetch and bounded cache; note text/metadata prioritized |
| Browser SQLite/WASM + OPFS | Optional implementation choice; earlier mandatory persistence target superseded |
| Keep authoritative native state in vault `.zorid/vault.sqlite` | Current and accepted placement |
| Keep native per-vault cache/recovery databases in platform app-local storage | Accepted for desktop/mobile; current native index still shares authority DB |
| Separate expiring recovery snapshots from rebuildable caches | Accepted data lifecycle distinction |
| Match the inspected Obsidian autosave/File Recovery behavior for this subsystem, without accumulating per-save backups | Accepted behavior; save strategy/cutover still needs design |
| Keep local File Recovery and caches out of sync | Accepted; future synced history is a separate feature |
| Optimize shared parsing/index/search and Bases queries with bounded adaptive parallelism | Confirmed design; editing/saves/active queries prioritized |
| Query languages | Documented Obsidian Bases and search syntax/results; separate languages over shared Rust capabilities |
| Cache/freshness | Persist parse/search indexes; bounded memory Base programs/answers; committed source, coherent updates/partial first-build coverage, time-aware refresh |
| Workload targets | 10,000-note representative and 100,000-note stress cases; numerical performance budgets follow measurements |

## Delivery sequence

The [product roadmap](../roadmap.md) is the single maintained order and capability
register. **S0 storage/saving/recovery is immediate**, then S0A interface review
before S1 indexing/search
performance, sync and managed-data foundations, usable desktop features/Google,
then hosted/web and native iOS delivery. Read the roadmap's dependencies and exit
gates rather than interpreting older execution-stage numbers as a competing plan.

One milestone implements at a time, with independent owned tasks/reviews inside
that milestone. Current architecture decisions do not mark implementation or
runtime acceptance complete. Keep detailed owners, commits and evidence in the
execution checkpoint and new user findings in the queue.
