# S1.0 language and performance baseline

Baseline protocol established against main
`776a8fd221c70a9c4ccce12c0446e85cffc7afe3`; S1.0 implementation is now underway
after [S0 and S0A acceptance](../roadmap.md). The deterministic workload and
[native CLI tool](../../scripts/indexing-search-baseline/README.md),
[actual browser harness](../../scripts/indexing-search-baseline/WEB.md), and
[language matrix](../reference/query-language-support.md) are integrated.
These initial tools cover subsets of this protocol; unsupported metrics/scenarios
remain explicit. No complete representative/stress measurement or performance
acceptance is claimed. Follow the
[accepted design](../architecture/indexing-search-design.md) and
[S1 slices](indexing-search.md); this document defines their baseline evidence.

## Frozen inputs and semantic oracles

Implement one versioned deterministic generator, producing UTF-8 files, a sorted
manifest of path/entry ID/content SHA-256/byte count, fixed presentation facts and
a scenario journal. Generation and import/setup time are separate measurements.
No network, random seed, current date, filesystem timestamp or machine locale may
change its contents. Set ctime to 1704067200000 ms and mtime to that value plus
1000*i ms; query clock is 1704110400000 ms and timezone is UTC except dedicated
timezone cases. Record generator revision, fixture hashes, source/build SHA,
release/debug mode, compiler/runtime versions, OS, hardware and executor settings.
Physical storage identities may differ between isolated runs; compare logical
fixture identities through an explicit mapping, never discard revision witnesses.

Use these existing independent expectations before timing changed behavior:

- [Markdown corpus](../../tests/fixtures/document-semantics/markdown/corpus.json)
  through [Rust parser](../../crates/zorid-document/tests/markdown_corpus.rs) and
  [persisted restore](../../crates/zorid-index/tests/metadata_corpus_restore.rs).
- [Accepted Base expressions](../../tests/fixtures/document-semantics/bases/accepted-expressions.json),
  [queries](../../tests/fixtures/document-semantics/bases/accepted-queries.json) and
  [generation queries](../../tests/fixtures/document-semantics/bases/accepted-generation-queries.json),
  including typed values, ordering/groups, relationships, diagnostics and context.
- [Search fixtures](../../tests/search-query.test.ts), classified in the language
  matrix against the [current contract](../search-reference.md). The TypeScript
  engine is a comparison implementation, not an authority for every future Rust
  result. Preserve supported exact ranges/semantics; explicitly mark accepted
  advanced JavaScript regex exclusions. Never turn an unsupported pattern into a
  literal or silently omit a clause. Record safe equivalent rewrites case by case.

Retain each corpus revision and the reviewed expectation provenance. Existing
fixtures do not establish complete upstream compatibility. New expected outputs
must come from reviewed language examples or explicit fixture arithmetic, not
regeneration from the optimized evaluator. Keep current Rust literal behavior
separate from target operator behavior when collecting the initial baseline.

## Representative and stress vaults

Generate exactly N Markdown notes, N=10,000 normally and N=100,000 for the milestone
stress pass, with zero-based index i. Decimal note suffixes have six digits. Use
`Notes/Gggg/Note-iiiiii.md`, where ggg is floor(i/1000), padded to three digits;
entry IDs are `note-iiiiii`. All line endings are LF. Use this stable header/body:

```text
---
project: project-P
status: STATE
rank: I
---
# Note iiiiii

common-marker café 😀
unique-iiiiii
```

Substitute P=i mod 10, STATE from [todo, doing, done][i mod 3], and I=i.
After that template, append `rare-marker\n` iff i mod 997=0, then
`prefixSUBSTRsuffix\n` iff i mod 37=0. Next, even i appends one absolute-vault
internal link to note (i+1) mod N using its full path without `.md`, followed by LF;
odd i appends nothing. Then append `- [ ] Task\n` for even i or `- [x] Task\n` for
odd i. Append ASCII `ordinary filler\n` repeatedly, then a
prefix of that byte string, to reach exactly the target UTF-8 length: i mod 100
in 0..69 → 1 KiB, 70..94 → 4 KiB, 95..98 → 16 KiB, 99 → 64 KiB. Preserve a final LF
by reserving its byte before padding. Padding contains none of the query markers.
Freeze the exact rendered template in generator version 1 before any comparison.

This intentionally mixes text sizes and gives sparse/common/no-match, substring,
Unicode, properties and relationships with calculable membership. It is a
reproducible proxy, not evidence of the distribution of real user vaults. Add a
small fixed set of Base definitions and attachment metadata outside the N-note
count. Attachment bodies are excluded from initial indexing; record this scope.

Use small, separate semantic fixtures for invalid YAML, exclusions, CRLF, BOM,
ambiguous links, missing targets and alias/case collisions. Reuse accepted corpus
cases where possible. They need not be multiplied across 100,000 notes.

Run a separate large-note profile with exact 1 MiB, 16 MiB and 16 MiB+1 UTF-8 byte
sources. Include Unicode before a marker, a long single line and a many-line note;
use a few named cases rather than a Cartesian product. Separate pure extraction
from source admission: the parser rejects oversized input and the index/WASM
builder can classify it as SourceLimit. Ordinary native inline admission instead
returns StreamRequired above 16 MiB; a retained streamed BinaryRef is classified
Binary by the current native index, regardless of its filename. Check that actual
admission/classification and exact source preservation rather than claiming a
native SourceLimit integration pass. Binary exclusion is not proof of text
extraction coverage. A second small duplicate-content cohort checks cross-entry
parse reuse/contextual rebinding without making the main corpus an artificial
cache-hit best case.

## Query set and expected work

Use one fixed, reviewed query manifest across scanning and accelerated execution.
For the generated corpus, exact membership is independent of the implementation:
all notes contain `common-marker`; only note 42 contains `unique-000042`;
`rare-marker` has ceil(N/997) files; `SUBSTR` has ceil(N/37) files; an absent marker
has zero. Expected byte/UTF-16 ranges follow the frozen template/padding offsets.
Include an ASCII case override and Unicode/astral range witness. Check complete
ordered IDs, ranges, relevant counts/coverage, diagnostics and pagination, not
only a hash of the first result page. Large outputs may be streamed to a digest
plus retained count/first/last witnesses after independently checking the oracle.

As supported Rust search becomes available, add the existing reviewed cases for
file/path/property filters, conjunction/OR/negation, quotes, task/section scopes,
portable regex and explicit unsupported regex diagnostics. Retain short one/two
character and punctuation substring cases. Match count, file count and snippet
count are different observations. Do not benchmark unsupported operators as
successful no-match queries.

For Bases use a small set: property filter with sparse results; formula + sorting
+ grouping; relationship-dependent filter; repeated unchanged query; changed
view/current entry; and one time-dependent expression from accepted fixtures.
Freeze clock and an explicit timezone per invocation. Vary them only in dedicated
invalidation cases, including local midnight. Current frontend UTC behavior is a
known implementation gap, not the accepted configured/device-local policy.

## Measurement scenarios

| Scenario | State and observation |
| --- | --- |
| Derived-cold | Existing committed authority, disposable index/cache absent, fresh process. Time lifecycle start → first coherent coverage publication → complete permitted coverage. Keep authority, recovery and pending data intact. |
| Warm restart | Same source/cache and cleanly restarted process. Separate cache validation/load, source reread/hash, reused parsing and first query. OS file cache may be warm. |
| Warm repeated query | Same pinned generation/options; separate initial preparation from repeated execution and presentation. Record program/graph/answer cache hits independently. |
| Incremental | Separate single body edit, metadata edit, rename, create/delete and a fixed 100-note burst. Record commit → invalidation → queryable publication. Unrelated notes must not be reparsed unnecessarily. |
| Missed notification | Commit through an independent CLI/import/sync-origin fixture, then restart/resume the consumer. Check durable-progress catch-up without renderer pumping. Implement only the admitted source-change routes. |
| Foreground contention | During cold indexing, issue a fixed sequence of 20 normal note saves and ten superseding queries, then a short rename burst. Measure queue wait and completion for each operation; also measure one normal paste/read attachment flow. |
| Eviction/invalidation | Clear disposable derived state, alter parser semantic version in a controlled fixture, and use bounded cache corruption cases. Check rebuild/error classification and unchanged source/recovery/pending receipts. |
| Stop/release | Cancel obsolete query/index work, release its pin/session, and admit a save. Observe actual worker stop/resource release and forbidden stale publication. |

Use distinct fixtures per scenario, with exact preconditions and expected source
bytes recorded. A dirty editor draft stays outside committed query results; include
one witness showing its own immediate editor rendering and no durable-index overlay.
Do not use the user's real vault or visible manual Playground for automation.

Start with one untimed correctness run. For the 10k comparison retain five cold/
warm runs and twenty repeated-query samples in stable scenario order, reporting
all samples, median and range. These small samples do not justify a p99 claim.
The foreground sequence provides individual samples, not a statistical tail
promise. Run the 100k stress once initially and once at the final gate unless a
specific regression requires another pass; report failures and limit exits.

"Derived-cold" does not mean cold OS page cache. Do not purge global OS caches or
claim disk-cold timing without a separately controlled method. Repeat comparisons
on the same machine with matched cache state, build mode and fixture hashes;
record thermal/load/storage-space conditions and any competing processes. Heavy
passes remain serialized on the 8 GB machine. No throughput or latency budget is
selected by this specification; set native/browser budgets from the baseline and
foreground behavior before accepting a speedup.

## Phase counters and evidence scopes

Collect monotonic timings and work counters at the shared module interface and
host executor, with bounded aggregate telemetry rather than one log per row:

- Admission/queue wait, source enumeration/progress reconciliation, reads and
  bytes, hash time/bytes, parse invocations/bytes, reusable parse hits/misses and
  invalidations, contextual rebinding, cache validation/read/write and publication.
- Program compile hits/misses, generation/file-fact/relationship preparation,
  candidate IDs, exact rows/source bytes evaluated, regex compilation, sorting/
  grouping, output encoding, complete pages and coverage/exclusion reasons.
- Jobs admitted/queued/running/coalesced/cancelled, cancellation requested/observed,
  worker CPU/work time, executor count, peak in-flight input/output bytes, cache
  entries/estimated bytes/evictions, pin counts and release acknowledgments.
- Peak process memory plus method, CPU time, total wall time, derived cache size,
  and browser message/serialization/transfer bytes. Memory scopes must identify
  renderer, Electron main, native host or browser Worker; avoid summing shared
  pages or labeling JavaScript heap size as total process memory.

A pure Rust harness isolates extraction/evaluation work. Native Store/host/CLI
runs include real SQLite, source reads, publication and transport where invoked.
Electron runs additionally measure actual note input/save and result rendering;
record dispatch → durable acknowledgment → index freshness → visible replacement
separately. Do not infer typing responsiveness from backend throughput alone.

Actual browser runs use its real Worker/WASM and retained storage on a named
browser/version/origin. Record worker startup and message overhead, restart with
the same storage, incremental catch-up, storage errors/eviction behavior and result
presentation. A native thread-pool pass is not browser multicore evidence. Compare
bounded browser extraction Workers only where useful; retain single-worker fallback
and measured overhead. Portable Rust tests do not establish native mobile runtime
or performance; paused iOS builds remain outside this baseline.

## Existing limits and coverage gaps

These are current implementation ceilings, not chosen performance budgets:

| Source at baseline | Current limit/behavior |
| --- | --- |
| [Document types](../../crates/zorid-document/src/types.rs) | 16 MiB source maximum. |
| [Index pumps](../../crates/zorid-index/src/snapshot.rs) and [generation](../../crates/zorid-index/src/generation.rs) | 32 documents / 1 MiB soft pump budget; one permitted large document can exceed the soft byte budget; 64 MiB generation metadata ceiling. |
| [Store admission](../../crates/zorid-store/src/entry_content.rs) and [index](../../crates/zorid-store/src/document_index.rs) | 16 MiB inline admission maximum; oversized writes require streaming. BinaryRef is indexed as Binary exclusion. Four query pins; publication and retained snapshot witnesses remain mandatory. |
| [Browser index host](../../src/core/browser-document-index.ts) | 100,000 records, 256 MiB projection per generation, 512 MiB total projection cache, 64 MiB metadata, 16 MiB header limit, four pins/stages and three generations. Host capture/open can impose further bounded header envelopes. |
| [Literal search](../../crates/zorid-index/src/literal.rs) | Exact case-sensitive literal, one hit per matching line; bounded pages, 1..1000 requested hits and 4096-byte query maximum. |
| [Base query](../../crates/zorid-bases/src/query.rs), [graph](../../crates/zorid-bases/src/graph.rs), [library](../../crates/zorid-bases/src/lib.rs) | 50,000 scanned records, 10,000 rows, 5,000 groups, 2 million query steps, 8 MiB output, 100,000 relationship edges and 64 MiB request. |
| [Current search presentation](../../src/ui/workspace.ts) | Additional bounded scan/page/result display limits. Reaching a display cap is not complete search coverage. |

The specified 100k note bodies total 291.015625 MiB before Base definitions or
attachment metadata. This exceeds the browser single-generation projection cap;
adding the extra files also exceeds its record ceiling. A complete browser
generation is therefore currently impossible for this fixture, independently of
possible earlier header/metadata limits. A complete Base scan also exceeds its
50,000-record ceiling. Record the earliest actual resource rejection, exact scope
and source preservation; do not report full-coverage latency for these cases.
The 10k workload supplies current successful-path comparisons where admitted.
Do not silently take a prefix, raise limits or label resource rejection a successful
full-vault query. Large-vault streaming/planning changes require reviewed
bounded-memory contracts.

Current [document interface](../../src/core/document-semantics.ts) publishes only
ready staged generations and current consumers drive catch-up before querying.
Accepted first-build growing coherent partial results and previous coherent
results while refreshing are not established by those facts. Measure the current
behavior and record this contract gap. Each visible publication/page must name one
immutable source/generation, expose incomplete coverage and preserve unindexed
absence as unknown. No mixing rows from in-progress writes, no false complete
counts, and no stale result action without current identity/revision validation.

The pure [Base evaluator](../../crates/zorid-bases/src/lib.rs) has cooperative
cancellation, but [native FIFO transport](../../desktop/rust-vault-service.cjs)
and [browser Worker FIFO](../../src/platform/browser-core-worker.ts) do not prove
a live request can receive it. UI result suppression, a rejected promise, posted
cancel message or terminated client alone is insufficient. Retain cancellation
request/observation/resource-release evidence, including save queue latency, while
preserving already committed mutations and their receipts.

## Accelerator comparison and completion evidence

Compare the bounded scanning baseline with a gram candidate filter plus the same
exact evaluator; this specification does not select a library, gram width or storage
format. Measure build/restart/update cost, bytes, candidate selectivity, source reads,
query latency and memory. Exercise sparse/common/no-match/short/Unicode literals,
negation/OR and supported regex. Candidate extraction must be sound: uncertainty
falls back to scanning, and NOT cannot treat unknown/unindexed rows as excluded.
Verify exact matches/ranges/order/pagination/coverage against the same oracle.
An accelerator that omits valid matches fails regardless of speed.

Retain one machine-readable report and a short human findings record per frozen
composition: scenario/input/build identities; all timings/counters; correctness
results; limit/unsupported cases; memory method; actual platform scope; and honest
remaining gaps. Keep logs/artifacts outside the architecture guide. Before S1.1,
review baseline bottlenecks and choose the first optimization plus measured budgets.
Reorder later S1 slices only with recorded evidence and without bypassing their
language, storage, freshness or cancellation contracts.
