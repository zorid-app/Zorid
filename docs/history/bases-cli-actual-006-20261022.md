# Actual standalone Bases CLI campaign 006 — 2026-10-22

**Passed all 125 commands and 17 checks: seven original checks plus all ten Q3
groups.** The Q3 assertions covered 133 typed row values, 16 expression diagnostic
entries and ten exact legacy-context diagnostic entries, one per Q3 query. This
is actual standalone CLI acceptance of the authored campaign, not complete Q3
input coverage or GUI/browser/mobile acceptance.

The coordinator authorized this sole runtime pass with the source checkout
frozen through the final integrity receipt. The normal runner initialized a new
disposable vault and app-local cache, spawned sequential CLI processes, built the
document index and used the existing CLI commands. It launched no Electron app,
desktop host, browser or special IPC service and supplied no evaluator or query
answers to the product.

## Source and executable association

| Witness | Exact value |
| --- | --- |
| Frozen campaign checkout | `5796d3a5b9f75e5ac112a818d30fd34ed683cb5f` |
| Executable build source | `f95ab6beea41999fe45eabfe9e882f7bdb1bec3c` |
| Shared Rust `crates` tree, identical at both commits | `958b19aca4666414e956fbb2f406558af5a18366` |
| Cargo manifest Git object | `dae521160181b50ce45ed9c7032b25609616b1c7` |
| Cargo lockfile Git object | `3c5ae0aac485e1739fa57e824c28bae89c2cce7b` |
| Preserved executable | `/private/tmp/zorid-bases-final-native-958b19ac/zorid` |
| Executable SHA-256 | `39ac002915dc6a17c9fd58d477ffb5d3a3dd52b6bc37684c33224a38a6080d3c` |
| Build receipt | `/private/tmp/zorid-bases-final-native-958b19ac/receipt.json` |

The associated build receipt records terminal exit 0 for the locked offline
release build, and a passing 359-test core suite. The coordinator reports that
suite across 20 targets for the same Rust source closure. Its recorded core-suite
log SHA-256 is
`4e7f9cf424fcb687b824d6b78004e5baf9b8297257a9b10741d6e134ceccb75e`.
Campaign 006 did not rerun Cargo or that suite. The runner verified the supplied
executable hash and matching Rust/Cargo source objects; the build receipt supplies
the executable/source association, not executable version text.

All four harness/oracle sources were hashed before and after the campaign:

| Input | SHA-256 |
| --- | --- |
| `tests/bases-cli-integration/run.mjs` | `642f81eb8f4e37f5baa079e89faba0e0f15fe64df67ace0567138ffbe228df4d` |
| `tests/bases-cli-integration/fixtures.mjs` | `29c532d8455c6e8da9bb9d63fb9775cf964407e5300461b688114cda9d2ab836` |
| `tests/bases-cli-integration/q3-oracles.mjs` | `a66f3211cce7be631094a0538f7fae27f9c099e056ed3f4de3db110ad491abe6` |
| `tests/fixtures/bases-q3-semantics.mjs` | `476be17dcb5d2c4ba4fd485037791f8edde51db1f31180dee65baf2e658aa944` |

## Executed scope and integrity

The seven original checks covered saved views, formulas, summaries, relations and
rollups; exact source preservation; revision CAS and operation replay; stale
snapshots and explicit reindexing; Base configuration changes; file identity
through rename; dangling relations after deletion; and derived-index rebuild.

All ten appended Q3 groups passed: Object callbacks; Tag hierarchy and subtype
boundaries; registered signatures and exact special-call spelling; strings,
regexes and numbers; strict collections; two captured Duration/calendar clocks;
nested Tag summaries; strict Object Link-child provenance; and returned summary
Error values versus formula-namespace throws. The shared fixture contains 14
additional files. The exact diagnostic multiset includes phase, entry identity,
path, property and code; unexpected, missing, changed or duplicate entries fail.

The run began `2026-10-22T11:38:48.536Z` and finished
`2026-10-22T11:38:51.574Z`; reported campaign elapsed time was 3,032 ms. This
small disposable fixture is not a performance acceptance workload.

The separate post-run integrity read verified:

- All 250 stdout/stderr hashes and 29 captured stdin hashes.
- All 54 unchanged query JSON/raw-source export hashes.
- Exact physical source bytes for all 14 Q3 files after the complete query plan.
- The frozen checkout, Rust/Cargo closure, four oracle sources and executable
  hash remained unchanged.
- All 125 owned child close events were observed, with no signal termination:
  121 exit 0, two expected revision/snapshot rejection exits 3, and two expected
  unavailable-index/view rejection exits 4.

The full plan ended at 125 commands under the existing 128-command ceiling.
No command or Q3 group was skipped. The runtime slot and checkout freeze were
released after the final receipt. Disposable evidence was retained; no test app
or special IPC service was started or left running by this campaign.

## Earlier failed campaigns and reviewed oracle corrections

Campaigns 004 and 005 remain failed historical evidence. Neither was resumed
from its failure point or relabeled as passed; 006 started again at initialization
and executed the complete plan against the same preserved executable/Rust tree.

- **004:** frozen `f95ab6beea41999fe45eabfe9e882f7bdb1bec3c`, stopped at command
  102. The CLI fixture deliberately deletes Grace and preserves Delta's raw
  author link. Generation-wide property diagnostics consequently include the
  exact legacy `property` / `delta` / `Books/Delta.md` / `note.author` /
  `unresolved_relation` entry even for filtered Q3 views. Reviewed source-only
  correction `6513e19b`, composed at `c9560248`, declares that context separately
  from the 16 Q3 expression diagnostics and binds its identity/path to committed
  receipts. It retains complete diagnostic comparisons and negative tests.
- **005:** frozen `c9560248b7513c743752d1a116f6bfc0c77ea9bc`, stopped at command
  110 after eight Q3 groups passed. An ordinary unconfigured inferred Link keeps
  raw public path `/Q3/Source`; its target witness and `.asFile()` File lookup
  independently identify canonical `Q3/Source.md`. Reviewed source-only correction
  `90ea41e3`, composed at `885e50bd`, fixes the shared expected raw path and adds
  six raw String/canonical File row assertions. Exact target witnesses, two
  strict Object groups, distinct opaque group IDs and unique count two remain
  required, with negative oracle tests.

Both corrections followed independent source-contract review rather than taking
query output as an expected-value generator. They changed test fixtures/oracles
and documentation, not the product or preserved executable.

## Evidence and remaining boundaries

- Passing report:
  `/private/tmp/zorid-bases-cli-actual-20261022-006/zorid-bases-cli-m3XxfB/report.json`
- Report SHA-256:
  `5b78c104af8bd0c36bad1558ff6acb81e5c15756b8b58542dbe9a02c48149d7b`
- Separate integrity receipt: `post-run-integrity.json` in the same directory.
- Failed 004 report:
  `/private/tmp/zorid-bases-cli-actual-20261022-004/zorid-bases-cli-QAGBqc/report.json`
- Failed 005 report:
  `/private/tmp/zorid-bases-cli-actual-20261022-005/zorid-bases-cli-5Set89/report.json`

This record does not accept current GUI behavior, the expanded browser/Worker/
WASM campaign, mobile, rendered or visual reference parity, sync, crash recovery,
stress/performance or primary-main integration. Historical browser results and
other native/UI campaigns retain their own exact source and scope boundaries.
