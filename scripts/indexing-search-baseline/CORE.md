# Pure Rust/core S1 baseline

This bounded S1.0 tool separates shared extraction/generation/literal evaluation
from the [native CLI baseline](README.md)'s source import, SQLite and process
startup costs. It implements no optimization. It does not establish complete S1.0,
actual browser/Electron, mobile or source-durability acceptance.

The source example is `crates/zorid-index/examples/s1-baseline.rs`. Build/run only
in a coordinator-granted serialized slot; the Node wrapper never builds Rust.
A matching example can be built with `cargo build --offline -p zorid-index
--example s1-baseline --jobs 1`, adding `--release` for an optimized comparison.
Keep the exact build source and target separate from another owner's live build.

```sh
node scripts/indexing-search-baseline/core.mjs \
  --out /private/tmp/zorid-s1-core-UNIQUE \
  --core /absolute/path/to/already-built/examples/s1-baseline \
  --notes 100 --samples 1 --timeout-ms 60000 \
  --build-sha EXACT_40_CHARACTER_SOURCE_SHA --build-mode release
```

The destination must not exist. Generation is sequential and uses the existing
versioned `workload.mjs`, with the same manifest, input hashes, query membership
and independent literal oracle as the native baseline. No private database,
Store/native importer or editor state is accessed. Initial correctness uses 100
notes; the 10k representative pass follows source review and an explicit resource
slot. The 100k stress pass additionally requires `--stress`; current engine limits
remain enforced and rejection remains a failed/incomplete report.

## What is timed

The example validates bounded manifest/query input, canonical source containment,
file lengths/digests and UTF-8, and preloads exact immutable source bodies. Report
setup, source read, hash and UTF-8 decode times separately; fixture generation and
process wall time are additional wrapper measurements. Preloading is an explicit
pure-core measurement choice, not a production caching strategy. OS page cache is
uncontrolled; this is not disk-cold timing.

It constructs a real `Manifest`/`GenerationBuilder`, binds exact entry witnesses,
then calls `IndexRecord::text`. Markdown notes use the actual document parser;
Base definitions are retained text without Markdown metadata extraction and the
PNG is a declared Binary exclusion. The example never reparses a row just to reset
a pump budget. It records:

- Manifest construction, witness binding, extraction, insertion and finish times.
- Parse invocations and Markdown input bytes; generation metadata size, record
  count, explicit exclusions and pump resets.
- Per query/sample engine time, pages, hits, source bytes/document reads and page
  encoding/output time. Query time includes the engine's current digest/range
  verification; it is not raw string-scanning CPU time.

Extraction includes parsing, projection/validation, UTF-16 accounting, metadata
serialization and source hashing inside `IndexRecord::text`. It must not be labeled
parser-only time. Insertion includes the bounded record clone needed because the
current builder consumes input on a rejected pump. These costs remain visible;
this harness does not alter engine data structures to improve its result.

Literal queries run against one immutable in-memory generation with page size
100 until the actual scan completes. Up to twenty samples reuse that generation
within the process; they do not measure persistent-cache restart. Page JSON is
encoded/emitted after the engine timer stops. Wrapper validation and pipe
backpressure still affect overall scheduling and process wall time. Peak RSS,
CPU time, cache-hit and executor-queue metrics remain unavailable, not zero.

## Exact checks and retained evidence

The wrapper validates every NDJSON page against `literalOracle`, in full order:
logical ID, digest-bound revision, path/kind/deleted state, line and half-open byte/
UTF-16 ranges. It requires all oracle hits before accepting a completed scan and
checks page counts, work totals, exact query/sample order, final acknowledgment,
source/snapshot semantic versions and declared coverage. There is no successful
ordered-prefix mode in this pure-core tool.

The synthetic source identity/watermark/epoch names are scoped to this standalone
pure fixture; they are not database-backed authority or edit capabilities. Every
revision is `source-` plus its manifest content SHA-256. Binary exclusion means a
known non-text file is accounted for; complete coverage does not claim PNG body
search, OCR or a native import-path classification. Unexpected text extraction
exclusions fail the wrapper rather than silently lowering oracle membership.

The private output retains `core.stdout.ndjson` and `core-report.json`, including
all query samples, environment, measured executable SHA-256 before/after, wrapper/
workload hashes and caller-supplied source/build-mode provenance. The example also
reports its actual `debug_assertions` setting. Neither setting nor a supplied SHA
proves correspondence between executable bytes and a source checkout. Source files
are rehashed after the pass outside engine timings.

Timeout/output/protocol/resource failures retain a failed-or-incomplete report.
The timeout terminates only the exact owned child; no uncertain mutation is retried.
Limits include 64 MiB manifest, 16 MiB individual source, 512 MiB aggregate source,
64 KiB query file, bounded pages and 512 MiB total stdout. Engine metadata/pump/
source ceilings still apply. A failure before a phase report leaves its detailed
counters unavailable; no fabricated partial-phase duration is reported.

Lightweight wrapper checks, without Rust execution:

```sh
node --check scripts/indexing-search-baseline/core.mjs
node scripts/indexing-search-baseline/core.mjs --self-test
```

These reject false completion, missing/extra ordering, wrong revisions/ranges,
source/snapshot substitution and malformed lifecycle sequencing. They do not
substitute for the actual already-built Rust example run. The initial tool does
not execute Bases/graph, incremental mutation, cache reuse, cancellation, foreground
contention or the separate large-note profiles. Those remain baseline work under
the [measurement specification](../../docs/plans/indexing-search-baseline.md).
