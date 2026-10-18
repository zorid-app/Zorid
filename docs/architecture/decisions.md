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
| Browser joins existing sync groups rather than owning an independent durable vault | Latest user correction; standalone IndexedDB startup is current code, not target UX |
| Browser SQLite/WASM + OPFS | Optional implementation choice; earlier mandatory persistence target superseded |
| Keep authoritative native state in vault `.zorid/vault.sqlite` | Current and accepted placement |
| Keep native per-vault cache/recovery databases in platform app-local storage | Accepted for desktop/mobile; current native index still shares authority DB |
| Separate expiring recovery snapshots from rebuildable caches | Accepted data lifecycle distinction |
| Match the inspected Obsidian autosave/File Recovery behavior for this subsystem, without accumulating per-save backups | Accepted behavior; save strategy/cutover still needs design |
| Keep local File Recovery and caches out of sync | Accepted; future synced history is a separate feature |
| Optimize indexing/search with reuse and bounded parallelism | Accepted direction; current cache reuse exists, parallel pump work remains |

## Delivery sequence

The [product roadmap](../roadmap.md) is the single maintained order and capability
register. **S0 storage/saving/recovery is immediate**, followed by S1 indexing/search
performance, sync and managed-data foundations, usable desktop features/Google,
then hosted/web and native iOS delivery. Read the roadmap's dependencies and exit
gates rather than interpreting older execution-stage numbers as a competing plan.

One milestone implements at a time, with independent owned tasks/reviews inside
that milestone. Current architecture decisions do not mark implementation or
runtime acceptance complete. Keep detailed owners, commits and evidence in the
execution checkpoint and new user findings in the queue.
