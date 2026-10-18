# S1 implementation slices

[Roadmap](../roadmap.md#s1--rust-parsing-indexing-caching-and-search-performance) ·
[Confirmed design](../architecture/indexing-search-design.md)

Status: planned. S0 storage and S0A interface acceptance precede this work. Existing
code and accepted tests are reusable foundations; this plan starts no new feature
or compiler campaign. Deliver one coherent slice at a time, with independent owned
subtasks/review where the contracts permit them.

| Slice | Deliverable | Acceptance evidence |
| --- | --- | --- |
| S1.0 Language and workload baseline | Maintained Bases/search syntax support/deviation matrix tied to official references and accepted corpora; representative workloads; source/latency/memory baseline | Identify current versus target behavior, missing operators/functions and intentional differences; retain measured baseline, no claimed improvement |
| S1.1 Reusable parse/index persistence | Versioned content-derived cache behind S0/S0A services, correct contextual rebinding, incremental invalidation and restart reuse | Observe warm reuse; unrelated edits avoid unnecessary parsing; changed content/version invalidates; cache clearing/corruption preserves authority and rebuilds correctly |
| S1.2 Base/query preparation reuse | Bounded in-memory compiled Base programs, generation adapters/relationships and eligible answer reuse | Compare results with accepted semantics; edits/rename/context/view/relationship changes invalidate; snapshots/pins release correctly; dependency keys include relevant versions/facts/time |
| S1.3 Shared search execution | Intended Obsidian search syntax in Rust over retained indexed source; choose acceleration only after defining matches/ranges/coverage | Correct text/metadata/filter/substring cases and coherent pagination; unsupported/missing capability explicit; no silent word-only or case-semantics regression |
| S1.4 Scheduling and multicore work | Bounded adaptive extraction/queries, interactive priorities, bounded chunks and actual cancellation where supported | Measure foreground typing/save/query latency during indexing; stale work cannot publish; cancellation doesn't erase committed operations; resources remain bounded |
| S1.5 Freshness and first-build behavior | Previous coherent results while updating; clearly incomplete first-build results/counts; time-dependent refresh in selected timezone | Changed results refresh without mixed generations; first-build absence/aggregates aren't presented as complete; midnight/timezone/now dependencies invalidate relevant visible views |
| S1.6 Integrated performance gate | Same frozen implementation across required desktop/native and actual browser bindings, with retained before/after scenarios | 10,000-note baseline and 100,000-note stress case plus large notes; cold/warm/index/query/memory results; semantic regressions resolved and agreed measured budgets met |

## Scope and order constraints

The table is the default slice order. If baseline evidence changes the best order,
record why before reordering; do not launch all slices together. S1.0 identifies
semantic gaps without requiring the later Bases feature UI. The language reference
must separate documented upstream behavior, current implementation and planned
support; broad historical audits are not a complete public grammar.

S1.1 separates reusable extraction from entry/path/revision witnesses. Hash equality
alone does not authorize mutation or cross-vault reuse. S1.2 cache reuse includes
all relevant source/configuration/view/context/graph/presentation/time inputs;
bounded memory and expiry are required. New parser/dialect versions invalidate
incompatible cache state rather than relabeling it.

For S1.3, benchmark candidate accelerators only after fixing required literal,
substring, regex/operator and result-range semantics. This plan selects no FTS or
inverted-index library. S1.4 uses pure work and coordinated durable publication;
network waits and long parsing do not run inside write transactions. A dropped
UI reply is not evidence that underlying computation was cancelled.

Browser uses retained working data with incremental catch-up; attachment bodies
are fetched on demand and cached within bounds. Reuse existing real browser
persistence where appropriate; S1 does not require changing its database engine
or implementing S10 enrollment first. Unsent edits/receipts are not evictable cache.

## Validation discipline

Use behavior checks against real storage at changed boundaries, accepted semantic
fixtures, stale/cancellation/coverage cases and representative actual app flows.
Measure rather than invent millisecond or memory promises. The 100,000-note run is
a milestone stress scenario, not a repeated test after every edit. Serialize heavy
work on the 8 GB machine and keep concurrency bounded. Reuse existing proof only
when its exact relevant source/input composition still applies.

Native mobile follows the desktop gate; S1 verifies portable semantics/bindings
without starting paused iOS builds or claiming phone/runtime performance. Record
scope, owner, branch, tested source and limitations in the execution checkpoint.
After S1.6 acceptance, update the roadmap and archive detailed logs separately.
