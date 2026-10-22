# Standalone Bases CLI scenario

This explicit scenario runs the actual `zorid` executable against a new disposable
vault. It does not launch Electron, a desktop host, a daemon, or a JavaScript query
evaluator. It is outside the default `tests/*.test.*` glob and never builds Rust.

## Current validation status

**CLI008 passed all 125 commands and 17 checks**, including all 162 current typed
expectations, 16 exact Q3 diagnostics and 10 legacy-context diagnostics. It used
preserved CLI SHA `fca404ed6d75ca973aa7cb120b86df4d3a08fd5d60798afc11ab8dcf21c55ce9`
on frozen `e38e246144efeb5a194a314a3c0a22ebf39d3415`, Rust tree `dbfc9221`.
The 16 added Date/String comparison cases passed; null cases pin the existing
guard rather than a new behavior change. Independent proof confirms source,
executable, four oracles, 250 streams, 29 inputs, 54 exports and 14 physical Q3
files. All CLI children closed; no GUI/host/service was launched by this campaign.
See [CLI008 evidence](../../docs/history/bases-cli-actual-008-20261022.md).
This is separate from current browser/WASM, GUI, mobile, sync or stress acceptance.

### Earlier verified campaigns

**CLI007 passed all125 commands and17 checks**, including its then-current146
typed row expectations,16 exact Q3 diagnostics and10 legacy-context diagnostics.
It used preserved CLI SHA `3fdcdbdcb61ca2b158b64689bb2019ef1a26ac459402d820fe037e7e54e18bc7`
on frozen source `2fe6e0552d3b504edea3bff042a8055e12d1ab2f`, Rust tree8074eabf.
Post-run integrity confirms source/artifact/oracles unchanged,250 stdout/stderr
hashes,29 stdin hashes,54 exports and14 physical Q3 files. All owned children
closed. See [CLI007 evidence](../../docs/history/bases-cli-actual-007-20261022.md).
This includes the13 new literal-percent/raw-date eligibility cases; browser009's
historical133 checks do not cover them. GUI/browser/mobile/sync/stress acceptance
remain separate.

[CLI006](../../docs/history/bases-cli-actual-006-20261022.md) passed125 commands
with133 typed expectations on the earlier Rust958 tree. Earlier results and
failed partial campaigns below retain their original source and scope.

### Earlier campaign history

The actual standalone CLI campaign passed all 85 commands against source
`44d9ae46a5d705337eb60a51241d29d199f43b5c` on October 22, 2026. Seven oracle
checks and 30 unchanged JSON/raw exports passed. See the exact artifact/source
receipt and limits in [the acceptance record](acceptance-20261022.md).
A second campaign against the final rebuilt source
`9d086a97b9f7fb16c3dc54452c16914ae5918c18` also passed 85 commands, seven
checks and 30 exports. Its command exits, evidence hashes and saved-view coverage
were independently rechecked; see campaign 002 in the same acceptance record.
Campaign 003 against source `cfe5627e10dec9cc290ff0da92fcf5ff5a5a25f2`
also passed 85 commands, seven checks and 30 exports with the rebuilt plain-link
core. Its separate post-run check verified numeric oracles and all ten remaining
authoritative files byte-for-byte; see campaign 003 in the acceptance record.
A new run still requires a matched build receipt and a coordinated runtime slot.

The authored Q3 extension (`64bee169` → `19ae330c`, composed at `eb6e0346`)
adds **40 CLI invocations**, for **125 commands under a128-command ceiling**.
The complete plan passed in CLI006, CLI007 and CLI008.
Campaign 003's 85 executed commands above remain historical evidence for the
original scenario, not acceptance of this extension.

The 40 added invocations are one mkdir, 14 creates, one index build, ten saved
Base queries and 14 exact raw reads. The shared
[Q3 fixture](../fixtures/bases-q3-semantics.mjs) has 14 added files (four ordinary
Markdown notes and ten Bases), 162 current typed row-value oracles and 16 expected
diagnostic entries. Assertions are not CLI commands. The runner checks that the original
phase ends at 85 and that the completed new plan ends at 125.

These ten query groups cover Object/Tag behavior; registered signatures and exact
special-call spelling; strings/regex/numbers; strict collections; two explicitly
captured Duration clocks (January 31 and February 1); Tag and Object Link provenance
through grouped/overall summaries; and returned Error data versus formula access
rethrows. Exact fixture-source reads follow the queries. CLI008 supplies current
actual CLI acceptance for these cases. Source/oracle checks alone do not establish
CLI, native/WASM or rendered application acceptance.

The G9–G15 follow-up retains all original Q3 assertions and appends
35 explicit row-value expectations inside the same ten queries. The file count,
125-command plan and 128-command ceiling are unchanged. New cases cover dead-branch
regex construction; recursive Object display strings with unchanged typed JSON;
configured relation raw-string coercion; normalized File folder/tag methods;
literal-space title boundaries; rich String raw-date selection; and stable natural
List sorting. Inert `__proto__` user data is deliberately preserved. Collation is
the pinned English base-sensitivity/numeric policy, not universal locale parity.
This follow-up passed in CLI006 and CLI007; earlier partial failures remain
recorded below. The G16/G17 follow-up adds13 literal-percent and raw compact-date
selection cases inside the same queries; CLI007 passed these too. The G18
follow-up adds 16 Date/String relational and existing null-guard expectations;
CLI008 passed them, with no extra commands or query groups.

Actual campaign 004 on frozen `f95ab6beea41999fe45eabfe9e882f7bdb1bec3c`
stopped at command 102, the first Q3 query, after the original seven checks passed.
Its exact diagnostic assertion omitted the unresolved Delta relation deliberately
left by the original Grace-deletion scenario. The failed evidence is retained at
`/private/tmp/zorid-bases-cli-actual-20261022-004/zorid-bases-cli-QAGBqc/report.json`.
No Q3 group completed, and this is not a 125-command campaign pass.

The corrected CLI oracle separately declares that original fixture diagnostic:
phase `property`, entry `delta`, path `Books/Delta.md`, property `note.author`, code
`unresolved_relation`. It binds the authored identity/path to the normal committed
receipt and compares the complete diagnostic multiset, including phase and entry
identity. Missing, changed, duplicate or unknown diagnostics still fail. The 16
Q3 expression diagnostics remain distinct from this one legacy context diagnostic
expected in each Q3 query. At that correction, browser expectations, all 127 typed
row oracles and the 125-command plan remained unchanged. A fresh actual campaign
was still required.

Actual campaign 005 on `c9560248b7513c743752d1a116f6bfc0c77ea9bc` stopped at
command 110 after the original seven checks and eight Q3 groups passed. The common
provenance oracle incorrectly expected canonical public Link path `Q3/Source.md`
for the ordinary inferred `[[/Q3/Source]]` value; that unconfigured Link retains
raw public path `/Q3/Source`, while its target witness and `.asFile()` lookup remain
canonical. Failed evidence remains at
`/private/tmp/zorid-bases-cli-actual-20261022-005/zorid-bases-cli-5Set89/report.json`.
The corrected shared oracle retains the exact target witness, two strict Object
groups and unique count of two, and adds six raw String/canonical File row
expectations (133 total). File, query, command and diagnostic counts are unchanged.
Campaign005 remains failed; the corrected full plan subsequently passed in
CLI006, then CLI007 with the additional date cases.

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

The original fixture has five ordinary book notes, two author notes, one excluded project note,
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
Commands run sequentially, with at most 128 invocations, a 25-second child timeout,
a 12 MiB combined-output bound, and a five-minute scenario guard. These are test
containment limits, not a performance acceptance campaign.

The final stdout line identifies `report.json`. Evidence retains exact executable
and harness hashes, Rust input identities, all command argv/exit codes/stdout/
stderr hashes, expected source inputs, unchanged JSON query exports, raw source
exports, and the disposable vault. A failure exits nonzero and keeps the report
and completed command evidence for diagnosis. No passing result is claimed by
the presence of this harness alone.
