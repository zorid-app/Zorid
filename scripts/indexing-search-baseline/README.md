# S1.0 deterministic workload and standalone CLI baseline

This is the first bounded baseline tool for the
[accepted measurement specification](../../docs/plans/indexing-search-baseline.md).
It generates fixtures and exercises the existing Rust-backed CLI on macOS. It
makes no optimization, full S1.0 acceptance, browser/Electron or mobile performance
claim. Runtime passes need the coordinator's resource slot; generation and Node
unit tests do not build Rust or launch an app.

## Generate a fixture

```sh
node scripts/indexing-search-baseline/generate.mjs --out /private/tmp/zorid-s1-fixture-UNIQUE --notes 10000
```

The destination must not exist. The generator never deletes or replaces it.
Counts 10,000 and 100,000 select the agreed representative/stress profiles; smaller
counts are labeled smoke. Sequential writes bound setup memory and I/O. The
100,000-note profile writes 305,152,000 note bytes (291.015625 MiB) plus three extra
files; generate/run it deliberately, not after every edit.

Version 1 freezes the exact UTF-8 template, leading-root wiki link spelling,
final-LF padding and eight literal queries in `workload.mjs`. Every 100 notes uses
70×1 KiB, 25×4 KiB, 4×16 KiB and 1×64 KiB. Two Base definitions and one opaque PNG
are outside the note count. Extra files contain no literal query markers.

The output contains:

- `vault/`: exact note, Base and attachment bytes.
- `manifest.json`: path-sorted logical IDs, content hashes/lengths, source kind and
  fixed presentation facts. Its canonical JSON SHA-256 is the fixture hash.
- `queries.json`: current `literal-lines-exact-v1` inputs and independent analytic
  membership counts. `literalOracle(queryRow, count)` yields ordered expected
  note IDs/paths, zero-based lines and exact byte/UTF-16 ranges from the frozen
  template. It never invokes the production search implementation.
- `scenarios.json`: fixed later mutation/scenario inputs, marked `executed:false`.
- `fixture.json`: completion marker, fixture hash and generator source-file hash.

The manifest's ctime is synthetic. Filesystem mtime is set, but the public native
import path supplies its own presentation fields; the runner does not mutate
private SQL or claim native timestamps equal the manifest. No ctime-dependent Base
oracle is exercised. Generated logical IDs map explicitly to admitted physical
entry IDs and revisions.

## Run the existing CLI

```sh
node scripts/indexing-search-baseline/cli.mjs \
  --out /private/tmp/zorid-s1-cli-UNIQUE \
  --cli /absolute/path/to/already-built/zorid \
  --notes 100 --timeout-ms 30000 --samples 1 \
  --build-sha SOURCE_SHA --build-mode debug \
  --native-host /absolute/path/to/matching/zorid-desktop-host
```

The runner creates a fresh fixture and app-local data directory. With explicit
`--native-host`, it initializes local-family authority through the same native
`--initialize-local` entry point used by desktop, validates the single bounded
ready frame and observes normal host exit after stdin EOF. CLI `rescan` then
continues durable family inventory in bounded passes (5-second soft work budget,
32 passes by default, `--max-import-passes` 1..1000). Each CLI process still has
the explicit process timeout. Raw scan progress is retained; three passes without
proven same-inventory observed/imported/finished progress stop as incomplete.
Setup/import timing remains separate from indexing. The tool records its exact
logical/physical identity mapping and checks native
committed bytes for the first/last note and all three extras, builds a cold derived
index, opens a fresh CLI status process and executes all eight literals. Repeated
samples restart the CLI; they do not measure an in-process retained-pin cache.
`--samples` is bounded to 1..20. Process wall times include startup/transport/JSON.
The supplied build SHA/mode are labeled caller provenance; the CLI and optional
native-host exact SHA-256 values are measured before/after the run and a changed
executable fails the report. These are boundary checks, not continuous executable
identity monitoring. The tool does not infer correspondence between
binary bytes and a source checkout.

`report.json` retains every command's wall time, exit/timeout/signal, output sizes,
query snapshot/full source watermark identity, warm-restart source equality, analytic match count, verified hit count and
coverage. Per-command stdout/stderr files retain full bounded outputs. Physical
source bytes for every generated file are checked again outside timed work;
`filesystemSourcePreserved` refers specifically to that check. `authoritySamples`
identifies the subset separately read and hashed through the actual CLI.

Omitting `--native-host` retains a separately labeled legacy profile using
public CLI `init` and a single `rescan`. Legacy rescan starts a new inventory;
this tool does not claim it has a durable continuation. An incomplete legacy
scan remains incomplete rather than repeatedly restarting its inventory. Neither
profile measures an Electron renderer. In the first legacy smoke, inline PNG
import was classified
`unreadable` by the existing index, so generation coverage was incomplete while
all 100 Markdown notes matched the complete literal oracle. Keep that observed
coverage gap; do not relabel it as successful binary text extraction.

The CLI returns at most 1,000 matches and 1,000 internal pages per invocation.
Common queries therefore often verify an exact ordered prefix, explicitly labeled
`ordered-prefix-only`; this is not full-vault oracle acceptance. Sparse complete
scans compare all expected IDs/ranges. A false complete response or changed
revision/range fails validation. Source import/build/query budget exits and
unsupported/unknown outcomes remain recorded failures or incomplete runs, not
zero-match successes. The runner stops after a timeout/rejection instead of
retrying an uncertain mutating request with a new identity. Timeouts terminate
only the exact owned CLI child; fixture data and logs remain for inspection.

`--notes 100000` additionally requires `--stress`. At current limits this fixture
cannot produce a complete browser generation, and a complete Base scan exceeds its
50,000-record bound. The native runner also retains scan/header/metadata/page exits
as observed; it never raises engine ceilings or silently takes a smaller fixture.

## Current evidence gaps

This tool does not yet execute the separate large-note/duplicate-content profiles,
mutation journal, Base queries, richer search language, cache-corruption/eviction,
foreground saves, cancellation, missed-notification or actual browser/Electron
scenarios. It has no internal parse/cache/queue counters or peak-RSS measurement;
those fields must stay unavailable until instrumentation is admitted. OS page
cache and thermal/load conditions are uncontrolled. Representative five cold/warm
runs and twenty same-pin repeated queries remain separate milestone work.

Run the bounded tool tests with:

```sh
node --test scripts/indexing-search-baseline/baseline.test.mjs
```

Tests freeze source bytes, analytic membership/ranges and cross-directory fixture
identity; reject source-witness/range/coverage corruption; and prove the wrapper's
owned Node child timeout. They do not substitute for a real CLI runtime pass.
