# S1 implementation slices

[Roadmap](../roadmap.md#s1--rust-parsing-indexing-caching-and-search-performance) ·
[Confirmed design](../architecture/indexing-search-design.md)

Status: S1 in progress after bounded S0 delivery and S0A contract acceptance.
S1.1 bounded client cache checks pass; S1.2 core and host answer reuse are
integrated with focused checks, while full client acceptance remains pending.
S1.3 rich search and in-note Find are integrated; 32 actual desktop functional
phases pass on their recorded freeze. Browser production execution reaches Search
but its first query failed; the canonical pin-order correction is integrated,
with a matching browser rebuild and full UI rerun pending. The pure phased-parser,
draft, metadata and preview foundation passes216 scoped checks on `4da43cf7`.
Rust metadata/preview bindings pass114 checks; metadata client adapters pass275
focused Node checks and TypeScript; native draft execution passes40 checks.
Vault/Workspace metadata consumption additionally passes132 focused Node checks
and TypeScript and is integrated through `b3930388`; portable executor extraction
and duplicate Store graph-derivation removal pass67 checks through `2bf929f9`.
Portable Rust draft transfer/bindings, buffer projection and preview platform/UI
mounting are the current implementation work. The buffer-boundary62 checks and TypeScript pass and are integrated through
2759322c. Rust166 validation resumed after obsolete-build cleanup:58 planned
checks pass; a test-only SQL count type correction is required before the
remaining108. Original filter-count and compile failures remain recorded.
The common/desktop transport subset is additionally integrated through
`8a6d20d0`, with190 applicable focused checks and exact-subset TypeScript. The full
browser composition passes374 focused Node checks and TypeScript in isolation;
Rust/WASM dependencies, actual bindings and normal activation remain pending.
Platform wiring/activation and S1.4–S1.6 acceptance remain open.
The [execution checkpoint](../deferred-product-roadmap.md) records exact evidence
and remaining10k admission/cache limitations. No overall app speedup or complete
language implementation is claimed. Deliver one
coherent slice at a time, with independent owned subtasks/review where contracts
permit them; later slice implementations wait for the measured baseline.

| Slice | Deliverable | Acceptance evidence |
| --- | --- | --- |
| S1.0 Language and workload baseline | Maintained Bases/search syntax support/deviation matrix tied to official references and accepted corpora; representative workloads; source/latency/memory baseline | Identify current versus target behavior, missing operators/functions and intentional differences; retain measured baseline, no claimed improvement |
| S1.1 Reusable parse/index persistence | Versioned content-derived cache behind S0/S0A services, correct contextual rebinding, incremental invalidation and restart reuse | Observe warm reuse; unrelated edits avoid unnecessary parsing; changed content/version invalidates; cache clearing/corruption preserves authority and rebuilds correctly |
| S1.2 Base/query preparation reuse | Bounded in-memory compiled Base programs, generation adapters/relationships and eligible answer reuse | Compare results with accepted semantics; edits/rename/context/view/relationship changes invalidate; snapshots/pins release correctly; dependency keys include relevant versions/facts/time |
| S1.3 Shared search execution | Intended Obsidian search syntax in Rust over retained indexed source; choose acceleration only after defining matches/ranges/coverage | Correct text/metadata/filter/substring cases and coherent pagination; unsupported/missing capability explicit; no silent word-only or case-semantics regression |
| S1.4 Core-owned scheduling | Coalesced incremental extraction/queries, interactive priorities, bounded chunks and actual cancellation where supported | Measure foreground typing/save/query latency during indexing; stale work cannot publish; cancellation doesn't erase committed operations; resources remain bounded |
| S1.5 Freshness and first-build behavior | Previous coherent results while updating; clearly incomplete first-build results/counts; time-dependent refresh in selected timezone | Changed results refresh without mixed generations; first-build absence/aggregates aren't presented as complete; midnight/timezone/now dependencies invalidate relevant visible views |
| S1.6 Integrated performance gate | Same frozen implementation across required desktop/native and actual browser bindings, with retained before/after scenarios | 10,000-note baseline and 100,000-note stress case plus large notes; cold/warm/index/query/memory results; semantic regressions resolved and agreed measured budgets met |

The reviewed [S1.0 baseline specification](indexing-search-baseline.md) defines
workloads, semantic oracles, measurement phases and current platform limits.

## Core lifecycle and platform execution requirement

S0A defines the shared core lifecycle/caching interfaces before S1 replaces live
client paths. Within S1.1/S1.4, establish core-owned change coalescing, invalidation,
job planning, priorities and versioned update subscriptions; migrate editor-driven
index pumping into that module. Platform hosts execute work and supply storage,
clock/wake and lifecycle capabilities without duplicating index policy. Changes
from CLI, external imports and sync receive the same treatment as editor commits.
Restart/missed-notification reconciliation uses durable source progress.

Latest user steering (2026-10-19) skips multicore implementation. Optimize away
repeated scans, parsing and preparation; native pools and browser parallel
executors are outside current delivery scope. Shared core ownership of lifecycle,
priorities and bounded work remains required. Keep immediate CodeMirror
syntax/rendering local; transient semantic draft analysis is core-owned and tagged
with its buffer revision, distinct from committed query snapshots.

Search uses the explicitly accepted engine-supported regex subset. The language
matrix records advanced JavaScript-only forms as unsupported, with clear errors
and safe equivalent rewrites where possible; no silent fallback or changed matches.

## Scope and order constraints

The table is the default slice order. If baseline evidence changes the best order,
record why before reordering; do not launch all slices together. S1.0 identifies
semantic gaps without requiring the later Bases feature UI. The language reference
must separate documented upstream behavior, current implementation and planned
support; broad historical audits are not a complete public grammar.

Measured S1.0 setup prerequisites (2026-10-18/19): release10k import is still
incomplete before indexing. Scoped observation/native path selectors, complete
metadata bulk loading and invocation-local graph-view reuse are integrated and
validated within their recorded scopes. Legacy same-cap admission reached6,167
versus2,378 originally; normal-family10k reached276 versus224 in32 bounded passes.
These are partial import results, not full-vault latency or indexing speedups.
Keep the unresolved normal admission scalability requirement in S1's performance
gate; don't expand into a new trusted mutation cache or batch-command API without
resolving that design. Pure-core10k literal oracles pass independently. The accepted
parse-cache source slice proceeds from these retained known-limit baselines;
query-cache/executor implementations still wait for their owning slices.

S1.1 source foundation starts after the retained S1.0 observations: pure-core10k
full literal oracles passed, generated Base10k truthfully rejects its preparation
budget, and native normal-family10k remains incomplete during admission. These
known limits do not require the existing engine to pass later performance gates
before optimization starts. Native setup fixes continue scoped validation; this
is not full S1.0 protocol acceptance. First isolate identity-free document facts
and explicit contextual binding without changing extraction semantics; persistence,
platform wiring and runtime acceptance follow independently reviewed commits.

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

Current runtime acceptance targets are macOS Electron, actual web bindings and
the standalone CLI on macOS. Verify CLI cold/warm indexing, search and cache reuse
without a running desktop app, plus CLI-origin updates and concurrent Electron
access. Web measurements exercise browser workers and retained browser storage;
native thread results do not substitute for them. Record the actual browser engine
tested. Windows/Linux and native iOS/Android runtime checks are deferred; portable
design and core checks do not establish their runtime performance.

Use behavior checks against real storage at changed boundaries, accepted semantic
fixtures, stale/cancellation/coverage cases and representative actual app flows.
Measure rather than invent millisecond or memory promises. The 100,000-note run is
a milestone stress scenario, not a repeated test after every edit. Serialize heavy
work on the 8 GB machine and keep concurrency bounded. Reuse existing proof only
when its exact relevant source/input composition still applies.

Native mobile follows the desktop gate; S1 preserves portable semantics/bindings
without starting paused iOS builds or claiming phone/runtime performance. Record
scope, owner, branch, tested source and limitations in the execution checkpoint.
After S1.6 acceptance, update the roadmap and archive detailed logs separately.
