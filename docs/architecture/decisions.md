# Current architecture decisions

[Architecture](README.md) · [Execution checkpoint](../deferred-product-roadmap.md)

Accepted on 2026-10-18 in the documentation/architecture discussion. These decisions
supersede older execution sequencing where they conflict; they do not certify
implementation or authorize discarding existing vault/recovery content.

| Decision | State |
| --- | --- |
| Design for desktop, browser and mobile from the outset | Accepted; platform implementations currently differ |
| Shared TypeScript editor/UI and portable Rust data semantics | Implemented foundation; full feature/runtime acceptance is separate |
| Editor correctness is mostly satisfactory; focus first on saving/recovery and Rust performance | Current user priority |
| Complete desktop Bases, Tasks, Calendar, Google integration and core performance before resuming iOS implementation | Current delivery order; preserve paused native work |
| Use SQLite and a unified Rust database infrastructure layer | Accepted direction; native Store exists, unified layer does not |
| Browser SQLite/WASM + OPFS | Target to validate; current browser authority is IndexedDB |
| Keep authoritative native state in vault `.zorid/vault.sqlite` | Current and accepted placement |
| Keep per-vault cache/recovery databases in platform app-local storage | Accepted placement; current native index still shares authority DB |
| Separate expiring recovery snapshots from rebuildable caches | Accepted data lifecycle distinction |
| Match the inspected Obsidian autosave/File Recovery behavior for this subsystem, without accumulating per-save backups | Accepted behavior; save strategy/cutover still needs design |
| Keep local File Recovery and caches out of sync | Accepted; future synced history is a separate feature |
| Optimize indexing/search with reuse and bounded parallelism | Accepted direction; current cache reuse exists, parallel pump work remains |

## Delivery sequence

1. Reproduce saving/reconciliation issues and account for retained `.previous`
   artifacts. Specify save/cleanup behavior and verify actual desktop persistence.
2. Establish shared SQLite infrastructure incrementally, proving browser feasibility
   and preserving authoritative transaction boundaries before backend replacement.
   Use it for app-local recovery/cache separation as those services are implemented.
3. Measure and optimize Rust parsing/indexing/search: reuse, incremental work,
   bounded parallel extraction, cancellation and stale-result rejection.
4. Finish usable integrated desktop Bases, Tasks, Calendar and Google integration.
5. Resume native iOS implementation using the settled shared interfaces.

Independent read-only audits/reviews can run in parallel. Do not open another wave
of dependent feature implementations before the current coherent milestone closes.
These architecture docs are the maintained design; execution records hold owners,
branches, commits and evidence. Record newly discovered requirements in the findings
queue without turning this page into a transcript.
