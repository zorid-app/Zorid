# Current architecture decisions

[Architecture](README.md) · [Execution checkpoint](../deferred-product-roadmap.md)

Accepted on 2026-10-18 in the documentation/architecture discussion. These decisions
supersede older execution sequencing where they conflict; they do not certify
implementation or authorize discarding existing vault/recovery content.

| Decision | State |
| --- | --- |
| Design for desktop, browser and mobile from the outset | Accepted; native clients retain vaults, browser joins existing sync groups |
| Shared TypeScript editor/UI and portable Rust data semantics | Implemented foundation; full feature/runtime acceptance is separate |
| Editor correctness is mostly satisfactory; focus first on saving/recovery and Rust performance | Current user priority |
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

1. Reproduce saving/reconciliation issues and account for retained `.previous`
   artifacts. Specify save/cleanup behavior and verify actual desktop persistence.
2. Establish shared native SQLite infrastructure incrementally, preserving
   authoritative transaction boundaries. Use it for app-local recovery/cache
   separation. Browser join/bootstrap and pending-edit design is separate; do not
   gate native storage work on persistent browser SQLite/OPFS.
3. Measure and optimize Rust parsing/indexing/search: reuse, incremental work,
   bounded parallel extraction, cancellation and stale-result rejection.
4. Finish usable integrated desktop Bases, Tasks, Calendar and Google integration.
5. Resume native iOS implementation using the settled shared interfaces.

Independent read-only audits/reviews can run in parallel. Do not open another wave
of dependent feature implementations before the current coherent milestone closes.
These architecture docs are the maintained design; execution records hold owners,
branches, commits and evidence. Record newly discovered requirements in the findings
queue without turning this page into a transcript.
