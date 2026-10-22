# Standalone Bases CLI scenario

This explicit scenario runs the actual `zorid` executable against a new disposable
vault. It does not launch Electron, a desktop host, a daemon, or a JavaScript query
evaluator. It is outside the default `tests/*.test.*` glob and never builds Rust.

## Current validation status

The actual standalone CLI campaign passed all 85 commands against source
`44d9ae46a5d705337eb60a51241d29d199f43b5c` on October 22, 2026. Seven oracle
checks and 30 unchanged JSON/raw exports passed. See the exact artifact/source
receipt and limits in [the acceptance record](acceptance-20261022.md).
A new run still requires a matched build receipt and a coordinated runtime slot.

Read-only `--help` and `base-query --help` inspection used the older existing
October 20 CLI artifact with SHA-256
`e48d7d949fb84a2c9d89d5995f3f33b757598eb64584bc3d4c8e20df4e649e78`.
That inventory establishes command availability only, not acceptance of the new
Bases implementation. The final run must use the new build receipt.

## Existing CLI surface and scope

| Operation | Existing command exercised |
| --- | --- |
| Ordinary files and property settings | `init`, `mkdir`, `create --input -` |
| Published query data | `document-index status/build/rebuild` |
| All saved view layouts | `base-query --id … --view … --clock-ms … --timezone UTC` |
| Note and Base configuration edits | `write` with entry ID, expected revision and operation ID |
| Exact source export/readback | `read --raw`, plus a physical file byte comparison |
| Query export | Capture the existing `base-query` JSON stdout unchanged |
| Identity and dangling relations | Revision-guarded `move` and `delete` |

The CLI currently has no Base-specific cell-edit command and no CSV/TSV/Markdown
table-export command. The runner does not emulate these as product commands.
Revision-guarded edits submit a complete, explicitly authored file. This is not
evidence of the application's source-preserving cell-edit UI or clipboard behavior.
The desktop campaign covers those surfaces separately.

## Independent fixture oracle

There are five ordinary book notes, two author notes, one excluded project note,
`Properties.yaml`, and two `.base` files. One book has CRLF and a Unicode filename;
one book has only `type: book`. No named note Type or Type registry is created.

The properties file supplies number/date/text/checkbox/status/select/multiselect,
one relation, one reverse relation, and count/sum/average rollups. Unknown settings,
comments, note bodies and literal template-like strings are retained as byte oracles.

| Phase | Book ratings | Overall rating sum | Scaled summary | Top two | Author counts |
| --- | --- | --- | --- | --- | --- |
| Initial | 5, 3, 4, 2, missing | 14 | 28 (`rating × 2`) | Atlas, Cedar; sum 9 | Ada 2, Grace 2 |
| Note edit | 5, 3, 6, 2, missing | 16 | 32 | Cedar, Atlas; sum 11 | Ada 3, Grace 1 |
| Config edit | Same | 16 | 49 (`rating × 3`, custom total + 1) | Same | Same |

The All books table and Board query the same membership and per-status groups.
The Reading list contains Atlas and Delta with sum 7. The Empty view has zero
rows and a custom count of zero. Top rated intentionally saves a limit of two;
its summary must total those two returned rows. Author rollups independently
expect Ada's initial total/average 8/4 and Grace's 6/3, then Ada's 14/(14/3) and
Grace's 2/2 after Cedar changes author.

The runner also checks:

- Numeric formulas and date formatting are returned by Rust in every relevant
  saved view. The CLI reports each layout's saved configuration, not rendered UI.
- Rendered dates and relations retain separate exact raw edit values; a text
  property containing a date-like string stays text.
- Queries do not add missing properties or materialize reverse relations/rollups
  into the author Markdown files.
- Exact operation replay agrees with the original commit, while a different
  stale revision write fails without replacing the accepted content.
- Queries remain explicitly stale until `document-index build`; an old expected
  snapshot is then rejected. A changed Base source also waits for explicit build.
- Rename preserves the note ID, bytes, and reverse-relation membership.
- Deleting Grace leaves Delta and its readable dangling author link intact,
  reports the unresolved relation, and never cascades to books.
- Explicit index rebuild changes derived identity while preserving query values,
  all remaining authoritative files, and exported bytes.

## Run after the final artifact freeze

Use the absolute executable path, expected hash and source revision recorded by
the final build owner. Do not substitute the hash of an arbitrary preexisting
executable merely to satisfy the guard.

```sh
node tests/bases-cli-integration/run.mjs \
  --cli "$ZORID_CLI_BIN" \
  --expected-cli-sha256 "$ZORID_CLI_SHA256" \
  --source-revision "$ZORID_BUILD_REVISION" \
  --out /private/tmp/zorid-bases-cli-evidence
```

For a paired desktop/CLI build receipt, add `--host` and
`--expected-host-sha256`. The host is hashed for correlation and never executed
by this standalone scenario.

The source revision must be a full Git SHA. The runner compares the `crates`
tree and Cargo manifest/lockfile objects with that revision and refuses dirty or
untracked Rust inputs. A later TS-only commit is allowed when those Rust inputs
still match. The executable's source association comes from the build receipt;
the runner verifies the supplied hashes rather than inferring a commit from a
version string.

Every run creates a unique `zorid-bases-cli-*` directory under `--out`, with its
own vault and app-local cache. It does not reuse or delete a preexisting vault.
Environment IPC endpoints and `DISPLAY` are removed from child processes.
Commands run sequentially, with at most 120 invocations, a 25-second child timeout,
a 12 MiB combined-output bound, and a five-minute scenario guard. These are test
containment limits, not a performance acceptance campaign.

The final stdout line identifies `report.json`. Evidence retains exact executable
and harness hashes, Rust input identities, all command argv/exit codes/stdout/
stderr hashes, expected source inputs, unchanged JSON query exports, raw source
exports, and the disposable vault. A failure exits nonzero and keeps the report
and completed command evidence for diagnosis. No passing result is claimed by
the presence of this harness alone.
