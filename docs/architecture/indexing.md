# Documents, indexing and caches

[Architecture](README.md) · [Search](search.md) · [SQLite](sqlite.md)

## Extraction and authority

`zorid-document` extracts frontmatter/properties, aliases, tags, headings, links,
blocks, list items and tasks. `ParseFacts` contains source positions and semantics
without a vault, path, entry ID or revision. Binding attaches an explicitly captured
entry/revision witness. Invalid YAML produces metadata diagnostics; it does not
prevent saving the original note. Immediate CodeMirror syntax and rendering remain
local editor work.

`zorid-index` owns manifests, immutable generations, semantic versions, retained
snapshots, publication fences and query projections. Pure validation is not a
durable commit. Hosts admit retained source, recheck ownership around asynchronous
work, and publish generation rows/head atomically. Cache contents and draft facts
never authorize a source mutation.

Native indexing reads authoritative data from `vault.sqlite` and persists derived
generations and reusable facts in the separate app-local `cache.sqlite`; bare
embedders can use an in-memory cache. Older optional authority-cache tables are
inert. Browser indexing uses Rust/WASM with a Worker/IndexedDB transaction host.
Its retained working data and derived indexes need not mirror native databases.
Neither cache is sync authority. Eviction, corruption or rebuild must preserve
source, receipts, pending writes, recovery and pinned generations.

## Reuse and lifecycle

The extraction key includes local-store scope, source SHA-256 and byte/UTF-16
lengths, Markdown/plain-text mode, parser/schema/dialect/extraction versions and
facts encoding. Compatible content can reuse identity-free facts and bind them to
the current witness. Same-entry generation reuse is a separate optimization.
Generation-only rebuild preserves reusable facts; disposing that cache family
clears them. Optional parse-cache admission is bounded at 1 MiB per encoded row,
64 MiB total and 100,000 rows. Larger supported documents still extract normally
and can skip caching.

The committed document runtime is a pure Rust reducer for change coalescing,
freshness demand, recovery and bounded maintenance effects. Native and browser
hosts execute its effects and supply storage, wake and lifecycle events. The
common TypeScript facade delivers revisioned observations and separately
acknowledged request outcomes. Each consumer owns cancellation of its freshness
demand; cancelling one demand does not undo a committed save or stop other clients.
A capable service's catch-up/rebuild uses that facade, while capability-absent
providers retain the legacy helper. These must never become two active planners.

Runtime adapters and consumer cancellation are integrated, but normal activation
flags remain **off**. Autonomous no-listener indexing, foreground fairness and
platform lifecycle acceptance remain gates. Multicore execution is outside the
current S1 scope. Reduce repeated scans, extraction and preparation first; bounded
work and cancellation still require honest accounting of synchronous calls.

## Integrated foundation awaiting consumer wiring

| Foundation | Boundary and remaining work |
| --- | --- |
| Phased extraction | `ParseFactsJob` advances one whole phase per step, with source/scratch/facts limits and cancellation between phases. Markdown/YAML calls inside a phase remain synchronous and non-preemptible; this is not a small-quantum latency guarantee. |
| Draft analysis | The latest-only draft reducer tags work by client, buffer lifetime and text revision, reserves transient resources and retires obsolete jobs. The work arbiter selects one committed or draft effect per turn; the shared executor owns actual parser phases, Ready facts and disposal. Native retains committed IO and lifecycle glue. Draft facts carry no durable witness or published generation. Transient transport, browser execution and Workspace dirty-draft consumption remain pending. |
| Committed metadata paging | Body-free reset/delta pages project admitted immutable generations, including files, folders, removals, diagnostics and coverage. The Store registration fence revalidates an already admitted metadata pin without rereading bodies; it does not replace source/text/publication checks. Native/host/WASM and desktop/browser adapters are integrated. Vault metadata migration remains in progress, and browser publication epochs currently force reset pages. |
| First-build preview | Sealed captures expose only the subset admitted after successful persisted pump work. Borrowed preview facts avoid copying metadata. Preview identity cannot become an ordinary query pin, publication proof or mutation witness; platform/UI mounting remains pending. |

The current Vault metadata cache and Workspace dirty metadata callbacks still use
TypeScript parsing. Their migration must preserve outline, aliases/tags, links,
graph and mutation-range correctness. The foundation above does not establish
that migration or change NoteBuffer's durable-save protocol.

S1 also includes bounded Bases preparation and eligible answer reuse. Coherent
previous results, explicit first-build coverage and configured-timezone freshness
are shared consumer requirements. Follow the [S1 slices](../plans/indexing-search.md)
and [execution checkpoint](../deferred-product-roadmap.md) for remaining wiring
and measured acceptance. Pure checks do not establish app speed or platform parity.

## Source map

- [Parser and phased facts](../../crates/zorid-document/src/lib.rs),
  [phase execution](../../crates/zorid-document/src/phases.rs) and
  [extraction/cache policy](../../crates/zorid-index/src/extraction.rs).
- [Index contracts](../../crates/zorid-index/src/lib.rs),
  [committed runtime](../../crates/zorid-index/src/document_runtime.rs),
  [draft reducer](../../crates/zorid-index/src/draft_runtime.rs),
  [work arbiter](../../crates/zorid-index/src/document_work_runtime.rs),
  [metadata pager](../../crates/zorid-index/src/metadata_rows.rs) and
  [preview capture/facts](../../crates/zorid-index/src/preview.rs).
- [Native persistence and registration](../../crates/zorid-store/src/document_index.rs),
  [native runtime driver](../../crates/zorid-native/src/document_runtime.rs),
  [browser index host](../../src/core/browser-document-index.ts) and
  [browser runtime host](../../src/platform/browser-document-runtime-host.ts).
- [Common runtime delivery](../../src/core/document-runtime.ts) and
  [document service/catch-up](../../src/core/document-semantics.ts).
