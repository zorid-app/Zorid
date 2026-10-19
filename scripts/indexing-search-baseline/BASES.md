# Existing-corpus Base semantic baseline

This bounded S1.0 tool measures existing Rust Base operations using the ten
accepted detached-query cases and seven accepted generation-query cases. It
changes no language, cache or production query behavior. These small semantic
fixtures are not a representative 10k/100k Base performance workload or complete
S1.0 acceptance. Follow the [baseline specification](../../docs/plans/indexing-search-baseline.md)
and [language matrix](../../docs/reference/query-language-support.md).

The example is `crates/zorid-bases/examples/s1-baseline.rs`. Build and execute only
in the coordinator's serialized slot. The wrapper accepts an already-built matching
example and never invokes Cargo. Example build command: `cargo build --offline
--release -p zorid-bases --example s1-baseline --jobs 1`. This shares the example
name with the index harness, so retain the exact binary SHA/source for each run;
building one crate's example can replace the other crate's executable path.

```sh
node scripts/indexing-search-baseline/bases.mjs \
  --out /private/tmp/zorid-s1-bases-UNIQUE \
  --bases /absolute/path/to/already-built/examples/s1-baseline \
  --samples 1 --timeout-ms 30000 \
  --build-sha EXACT_40_CHARACTER_SOURCE_SHA --build-mode release
```

The fresh destination must not exist. The wrapper creates it with private directory
permissions, copies the exact two corpus files, and pins their reviewed SHA-256
values. Captured input bytes remain unchanged and are checked again after execution.
No fixture regeneration, private SQL, native import or live user vault is involved.
The corpus retains its own invocation clocks (including zero), UTC settings,
configuration, limits, current-entry context, source generations and revisions.
No ambient date replaces these inputs.

## Execution and timing scope

The Rust example reads bounded files and deserializes directly into typed
`PropertyValue`, `BaseSnapshot`, source and option structures. A generic JSON-value
round trip could reorder property maps; it must not precede this typed decoding.
Input read/decode/setup durations are reported separately from execution.

Detached cases use `compile_base` and `query_base`. Generation cases first use
bounded `Generation::from_sources`, then `compile_base` and `query_generation`.
The generation fixtures contain only two or three files and use the existing
32-source convenience-import limit. This does not model a large-vault loader.

The example reports one generation-construction duration where applicable, one
configuration-compile duration, and individual query/typed-result output durations.
`compile_base` validates already decoded configuration; it does not measure YAML
parsing or all expression AST compilation. `query_generation` includes current
row/file-fact/graph adaptation and query evaluation. `query_base` also performs
relationship preparation and property discovery; neither timer isolates pure
formula evaluation. Engine resource-accounting serialization remains inside the
query, while final NDJSON encoding/writing is reported separately.

One compiled program is reused within a case for one to twenty samples. The
existing process-global AST/regex caches may also warm across cases and samples.
No cold-cache, restart, whole-program cache implementation or speedup claim follows.
Small-case timer values are observations with substantial fixed/timer overhead;
they do not establish application latency or tail distributions. Peak RSS, CPU and
internal cache/preparation counters remain unavailable.

## Independent assertions and supplemental observations

The external Node wrapper checks every declared expected observable using the
same comparison scope as existing accepted corpus tests:

- Full declared path order, selected properties/counts/groups/group options and
  declared snapshot/relationship/metadata fields compare exactly.
- Only the explicitly declared row/cell values are asserted. Typed values preserve
  array order and shape; error values compare their code, excluding prose.
- Diagnostic expectations are required subsets. Additional diagnostics and fields
  outside the frozen assertions remain observed rather than independently verified.

Returned rows additionally require their exact requested path, stable ID and
revision; duplicate/foreign rows fail. Generation/source/version envelopes must
match the fixture. Counts obey the existing pipeline invariants. Metadata issues
must name an input entry/revision. Missing samples/results/final acknowledgment,
out-of-order cases or false completion fail the wrapper.

`bases.stdout.ndjson` retains every actual full typed result. The report includes
a SHA-256 of Node's JSON serialization of each full result as a supplemental
observation. This hash is not an independent expected result, does not bless
unasserted cells, and must not replace the frozen oracle. Validating all seventeen
cases means their declared fixture assertions passed, not full upstream language
compatibility or an independently specified complete result for every case.

`bases-report.json` retains the corpus identities, binary/source provenance,
environment, phase observations, results, scope and limitations. Exact executable
bytes are hashed before/after execution; build source/mode are caller supplied,
while Rust reports its actual `debug_assertions` setting. This does not infer source
correspondence from executable bytes. Process wall time includes startup, output,
wrapper validation and pipe scheduling; it is separate from query timers.

Input is limited to 2 MiB per corpus, samples to twenty, individual NDJSON records
to 16 MiB, total stdout to 128 MiB and stderr to 1 MiB. The owned child has a bounded
timeout. On rejection, timeout, protocol failure or engine budget error, retain a
failed-or-incomplete report and terminate only that exact child. No uncertain
mutation is retried; the tool has no source-mutation path. Existing engine input,
row/work/output limits remain unchanged.

Lightweight checks without Rust execution or a timing workload:

```sh
node --check scripts/indexing-search-baseline/bases.mjs
node scripts/indexing-search-baseline/bases.mjs --self-test
```

The focused validator checks pin all seventeen inputs and reject changed paths,
source revisions, IDs, snapshots, missing rows, false counts, foreign metadata
issues and malformed result sequencing. An actual optimized Rust pass remains a
separate gate. Representative Base workloads, native/browser/Electron consumers,
cache reuse/invalidation, cancellation and foreground contention remain later
baseline requirements.
