# Indexing, search and Bases performance design

Confirmed by the user on 2026-10-18 after the design interview. This is accepted
architecture direction, not an implementation or performance report. S0 storage
and S0A modular interfaces remain prerequisites to S1 implementation. Follow the
[implementation slices](../plans/indexing-search.md) and [roadmap](../roadmap.md).

## Latest user requirements — 2026-10-18

Multicore optimization applies to every platform where measured throughput and
foreground responsiveness improve. Native desktop/mobile can execute Rust worker
jobs on native threads; browsers need their own bounded worker executor around
shared Rust/WASM work. A native thread pool alone does not satisfy this direction.
Budgets consider available cores, memory, power and transfer/startup overhead;
small workloads may stay sequential. This does not resume paused mobile feature
implementation or establish unmeasured device performance.

Indexing and semantic parsing lifecycle belongs to the shared Rust core. It owns
change coalescing, invalidation, dependency tracking, cache policy, job selection,
priority, cancellation and coherent publication. Platform adapters supply storage,
executor/timer/lifecycle capabilities and deliver source changes; they do not
reimplement policy. The editor and feature views subscribe to versioned updates
and requery affected data rather than manually driving begin/pump/publish loops.
Those low-level operations may remain internal to core/host execution.

Source changes include successful commits from editor, CLI, external-file import
and sync, plus rename/delete and extraction-version changes. Index progress is
reconciled against durable source state on restart or missed events. Notifications
are hints to refresh; their loss cannot silently leave indexes permanently stale.
Use the S0A caching interface for reusable extraction, not frontend table access.
Cache failures/rebuilds must remain independent of source durability and recovery.

Core metadata parsing does not replace CodeMirror's incremental syntax parsing,
selection, composition, undo or immediate rendering. Shared search/Bases still
index committed source. Existing UI needs for unsaved semantic metadata require a
separate transient analysis path tagged with buffer revision; its scheduling and
parsing policy is core-owned and it never publishes a draft into the shared index.
Core change notifications must not overwrite dirty editor buffers.

The user accepts a documented regex subset supported by the shared engine, with
advanced JavaScript-only constructs explicitly unsupported initially. This is an
intentional compatibility gap, not full Obsidian regex compatibility. Invalid or
unsupported patterns report an explanation, never empty results masquerading as
successful evaluation. Suggest an equivalent rewrite only where matching meaning
is preserved. Full advanced compatibility remains a tracked follow-up.

## Scope and architecture

Optimize shared Rust Markdown parsing/indexing, search/backlinks and Base query
compilation/evaluation, including filters, formulas, sorting and grouping. New
Base/Task/Calendar presentation features retain their later roadmap stages.

Keep Base language compilation/evaluation in a dedicated Rust module over shared
query capabilities. Search/Tasks/Calendar reuse concrete query/index capabilities
rather than duplicating scanning, evaluator, invalidation or scheduling rules.
Do not build an unrestricted universal query language or speculative plugin API.
Existing zorid-document, zorid-index and zorid-bases are the starting point.

## Language compatibility

Use documented Obsidian Bases YAML/expression/filter syntax and built-ins as the
language target. Vault-search operators remain a distinct language with the
Obsidian search reference; shared execution does not merge the languages.
Supported expressions should produce documented results, not only parse the same
spelling. The explicit engine-supported regex subset above is a recorded exception
to complete JavaScript-flavored regex compatibility. Explicitly review existing deliberate dialect deviations before keeping
or changing them. Optimization must not silently redefine semantics.

Primary language references checked during discussion:
- https://obsidian.md/help/bases/syntax
- https://obsidian.md/help/bases/functions
- https://obsidian.md/help/Plugins/Search

Consolidate a maintained syntax/support/deviation reference from the current
stage4 contract, approved corpus and primary docs. Identify the source revision
when implementing compatibility cases; do not regenerate expected results merely
to bless new evaluator behavior. Current complete compatibility is not established.

## Caching and parallel work

- Persist reusable parsed metadata and search indexes across restart.
- Initially keep compiled Base programs and final query answers in bounded memory
  caches. Reuse requires all semantic/version/dependency inputs, not Base revision
  alone. Contextual identity is separate from reusable content-derived parsing.
- Use bounded adaptive parallel extraction and scheduling. Interactive editing,
  saves and active queries take priority over background indexing; maximizing
  occupied cores is not the objective. Derive worker/memory budgets by measurement.
- Cache corruption/eviction must not affect source, pending writes or recovery.
  Derived state can be regenerated. Preserve coherent revision-bound publication.

## Freshness and index coverage

Shared search/Bases reflect successful source saves/commits. Unsaved edits remain
immediately visible in their editors but do not overlay the durable shared index.

During refresh, show the previous coherent results with a subtle updating state,
then publish the replacement. Validate current identity/revision before actions
from older results mutate source.

On the first build, when no previous complete index exists, show coherent partial
results as coverage grows, marked Indexing/incomplete. Counts and summaries are
explicitly incomplete; no matches yet does not mean the entire vault was searched.
This does not authorize presenting partially committed rows as a coherent snapshot
or interpreting unindexed absence as deletion.

Invalidate time-dependent answers when relevant time dependencies change, e.g.
today at midnight. Refresh affected visible views rather than rerunning ordinary
queries on an unconditional timer. Use user-configured timezone, defaulting to
device local, and capture one clock/timezone per query. Current shared UTC input
needs an explicit reviewed change.

## Search coverage and browser behavior

S1 covers supported ordinary text content/properties and attachment names/metadata.
PDF-body extraction and image OCR are later capabilities. Preserve required
substring search when selecting an acceleration structure; a word-only index must
not silently narrow supported matches.

The browser retains a local working replica/cache between visits and incrementally
catches up with its joined sync group, supporting responsive local queries.
Prioritize retained note text/metadata; attachment bodies load on demand into a
bounded cache. Group joining need not download every video/PDF. Synchronized cache
can be refetched after eviction; unsent edits and receipts are not disposable cache.
This supersedes earlier optional-only persistence wording in architecture docs.
Browser storage engine/key retention/close-recovery contracts belong to the storage
and browser milestones; S1 does not silently choose a production VFS.

## Measurement and implementation gates

Use a 10,000-note representative workload and 100,000-note stress case plus large
individual notes. Measure cold/warm startup, incremental indexing, search/Base
latency, memory and foreground responsiveness before selecting numerical budgets.
These sizes are agreed test targets, not observed capacity or speed guarantees.

Implement after S0/S0A, in coherent slices: baseline measurement; reusable parse/
index persistence; compiled Base/generation relationship reuse; query execution
acceleration and bounded scheduling; integrated real-client verification. Adapt
that breakdown to measured bottlenecks, preserving semantics/coverage and source
publication fences. No implementation is started by this design record.

## Current source findings — debf68be, static only

- Native and browser pumps are sequential. Native prior-generation reuse requires
  compatible semantic versions and matching entry metadata, not just content hash;
  reused source still gets reread/hashed/copied. Native batch publication uses one
  coordinated transaction after pure work.
- Rust literal search scans retained text per bounded page. Shared sidebar search
  is currently case-sensitive literal search; a richer frontend parser is separate.
  No inverted search index is established in that path.
- Base queries recompile YAML and rebuild generation/relationship adapters per
  request. Small expression/regex caches and per-row formula memo exist; whole
  compiled-program/result caching is not established.
- Base answers depend on generation, Base/view/options, current entry, file facts,
  relationship graph and captured clock/timezone. Base revision alone is unsafe.
- Rust is outside the renderer, but serialized native requests and browser Worker
  queues can delay saves behind queries. UI cancellation does not interrupt
  already executing native/WASM query work.

Source anchors: [native index](../../crates/zorid-store/src/document_index.rs),
[literal search](../../crates/zorid-index/src/literal.rs),
[Bases modules](../../crates/zorid-bases/src/),
[shared Base runner](../../src/bases/shared-query.ts),
[native service queue](../../desktop/rust-vault-service.cjs),
[browser worker](../../src/platform/browser-core-worker.ts).
These facts are not measured bottlenecks.

## Decision record

The user accepted Q1–Q14, explicitly confirmed Q12 after Q13/Q14, and then confirmed
the consolidated design. Follow-up interviews should batch independent decisions;
technical fact-finding belongs to source audits, not user questioning. The
[query boundary ADR](../adr/0001-shared-query-semantics.md) preserves the architectural
tradeoff. Detailed benchmark/source evidence belongs in execution records.
