# Actual standalone Bases CLI acceptance — 2026-10-22

The explicit actual-binary scenario passed **85 commands, seven oracle checks
and 30 unchanged JSON/raw exports** in 2,694 ms. All 85 child exits were observed;
no child process remained. The run used a new disposable vault, standalone CLI
processes only, and no Electron, desktop host process, IPC service or JavaScript
evaluator. No source or artifact was changed during the run.

## Exact source and artifact receipt

| Input | Identity |
| --- | --- |
| Source revision and checkout | `44d9ae46a5d705337eb60a51241d29d199f43b5c` |
| Rust `crates` tree | `b6acc9cf6400b85ba8ed942440eec4f8d1489d0d` |
| `Cargo.toml` object | `dae521160181b50ce45ed9c7032b25609616b1c7` |
| `Cargo.lock` object | `413037e553a3c10bc605004a0ad3f6012f570440` |
| CLI SHA-256 | `60abec53906f8a7acc80f6a50396b935377ead2181e281a2373655127ad83d2a` |
| Paired host SHA-256, hashed only | `a79da3d5da6d1be75ad65270488be5b5737bfeeec1587136dd0327e444f0a7f9` |
| `run.mjs` SHA-256 | `af143e1aee9aee75f2085e8f78e1ae7766aed4cce1cfc7fbd27c41a73fbcce17` |
| `fixtures.mjs` SHA-256 | `f4f2afdebe189f6e3896c5efa1d4b10ad87bc7665d2001206a4828b75ca06e7e` |
| Full report SHA-256 | `138f6d5ec80344cec32c7e99db52aa26d0d38d180385e700385e10a26ad53f96` |

Build receipt: `/private/tmp/zorid-bases-current-relations-artifacts.json`.
The CLI was `/Users/ctk/Projects/Zorid/target/s1-release/release/zorid`.
The supplied build receipt associates that artifact with the source revision;
the scenario independently checked its hash, source closure and unchanged status.

Full retained report, disposable vault, command stdin/stdout/stderr and exports:
`/private/tmp/zorid-bases-cli-actual-20261022-001/zorid-bases-cli-6Iqeu9/report.json`.
This local temporary evidence may be removed by the operating system; the source,
artifact hashes, outcome and scope are preserved here.

## Observed checks

- Every saved table, cards, list, kanban and empty view agreed with independently
  authored membership and summary oracles. Initial ratings summed to 14 with a
  scaled total of 28; note edits produced 16/32; saved formula/custom-summary
  edits produced 16/49. Limited-view summaries totaled the returned rows.
- Rust returned typed dates, exact raw edit values, formulas, relation candidates,
  reverse relations, and count/sum/average rollups. Mixed property sets and an
  ordinary note with missing properties remained valid.
- Queries did not rewrite source or materialize missing/derived properties.
  Every authoritative note, settings file and Base file matched expected raw
  bytes before and after the edits, including CRLF, Unicode filenames, comments,
  unknown settings, bodies and literal template-like strings.
- Revision-guarded writes, exact operation replay and stale-write rejection
  behaved as expected. Query snapshots remained explicitly stale until an index
  build; old expected snapshots were rejected after publication.
- Rename retained stable identity and reverse-relation membership. Deleting an
  author preserved books and readable dangling source links without cascading.
  Rebuilding changed derived snapshot identity while preserving query values.
- Thirty exports matched original `base-query` JSON or `read --raw` bytes.

## Limits

The paired desktop host was hashed, not executed. This run establishes the
standalone CLI path at the recorded source, not Electron UI, actual browser/WASM
runtime, mobile or Obsidian visual parity. The CLI has no Base-specific cell-edit
command or CSV/TSV/Markdown table-export command: edits used existing guarded
full-file writes, and exports used existing JSON/raw stdout. UI source-preserving
cell edits and clipboard formats require their separate application campaign.

## Campaign 002 — final rebuilt core

A second actual standalone run passed **85 commands, seven oracle checks and 30
exports** in 2,597 ms against the final rebuilt source below. This is a separate
vault and run, not a relabeling of the first campaign. The CLI fixture and runner
were unchanged; the first campaign's behavioral oracle and scope still apply.

| Input | Campaign 002 identity |
| --- | --- |
| Source revision and checkout | `9d086a97b9f7fb16c3dc54452c16914ae5918c18` |
| Rust `crates` tree | `2f55bd4a7a560168d9ae55144149d31926eaa750` |
| `Cargo.toml` object | `dae521160181b50ce45ed9c7032b25609616b1c7` |
| `Cargo.lock` object | `413037e553a3c10bc605004a0ad3f6012f570440` |
| CLI SHA-256 | `92870835203249518612db6003be262b5cc1b54530bbaf3d00900fbe5aa592ed` |
| Paired host SHA-256, hashed only | `0c29e8d5fd4b04b7b424303dc48ede710a2c1a1fb8658c2cfe1164e7e572a620` |
| `run.mjs` SHA-256 | `af143e1aee9aee75f2085e8f78e1ae7766aed4cce1cfc7fbd27c41a73fbcce17` |
| `fixtures.mjs` SHA-256 | `f4f2afdebe189f6e3896c5efa1d4b10ad87bc7665d2001206a4828b75ca06e7e` |
| Full report SHA-256 | `de9c314c8b1da4948cde0541f22348a2a19f0c75e3cdcc27105b15115e923f5a` |

The coordinator's completed build log is
`/private/tmp/zorid-bases-final-native-801-build.log`. Captured artifact/source
receipt: `/private/tmp/zorid-bases-cli-final-002-artifacts.json`. Executable paths
are the same release paths as the first campaign. The runner verified source
closure, clean Rust inputs and unchanged CLI identity before and after use.

Retained report and disposable fixture:
`/private/tmp/zorid-bases-cli-actual-20261022-002/zorid-bases-cli-HKZzzD/report.json`.
A separate post-run check in adjacent `independent-verification.json` rehashed
all command stdout/stderr, supplied stdin and all 30 exports. It confirmed:

- All 85 child closes were observed, with no signal termination and no child
  remaining; 81 commands succeeded.
- The four deliberate rejections had the expected exits: query-before-build and
  unknown-view exited 4; stale-note-edit and old-snapshot rejection exited 3.
- Table, cards, list, kanban, empty and author views were queried in each of the
  initial, note-edited and configuration-edited phases.

This confirms the CLI scenario still passes on the rebuilt core. It does not add
fragment-specific UI, clipboard, browser/WASM, Electron, mobile or visual-parity
acceptance. The paired host was again hashed only. Temporary evidence may be
removed by the operating system; exact identities and outcomes are retained here.

## Campaign 003 — rebuilt plain-link core

The actual standalone campaign passed **85 commands, seven oracle checks and 30
exports** in 2,339 ms at frozen source
`cfe5627e10dec9cc290ff0da92fcf5ff5a5a25f2`. A new disposable vault was used.
No Electron app or build was launched by this run, and no source or artifact was changed.
Campaigns 001 and 002 above retain their original source and artifact identities.

| Input | Campaign 003 identity |
| --- | --- |
| Frozen runtime source and checkout | `cfe5627e10dec9cc290ff0da92fcf5ff5a5a25f2` |
| Build artifact capture source | `527790c50ccd7adae9facbe9d15b131a610f656f` |
| Exact shared Rust `crates` tree | `5e010112661da69eb290d6a5edb72d4906e844a1` |
| `Cargo.toml` object | `dae521160181b50ce45ed9c7032b25609616b1c7` |
| `Cargo.lock` object | `413037e553a3c10bc605004a0ad3f6012f570440` |
| CLI SHA-256 | `b656a8e3faa52da610d21cc2646cd5eaf4ff1dc43063e18a5a227af7d9c0e5bf` |
| Paired host SHA-256, hashed only | `176fcff5a6228ba4dde53068e8703f0b53c30b9d4673020e241af6ccf57b167e` |
| `run.mjs` SHA-256 | `af143e1aee9aee75f2085e8f78e1ae7766aed4cce1cfc7fbd27c41a73fbcce17` |
| `fixtures.mjs` SHA-256 | `f4f2afdebe189f6e3896c5efa1d4b10ad87bc7665d2001206a4828b75ca06e7e` |
| Full report SHA-256 | `84e6b80a3293d5d5fb2c2aee50a9dc591adff0c0560047679bf40e9133bac714` |
| Post-run verification SHA-256 | `9e6fc8944db4f37d4dbd1b0a8275e333ef2e01fe7f7df3729aafad82d543b02b` |
| Runtime artifact receipt SHA-256 | `674011d0c6922752f0b3d775835c58db8f7480627c95326fe0bac91109801782` |

The artifact receipt is
`/private/tmp/zorid-bases-cli-final-003-artifacts.json`. Its separate build-capture
and runtime revisions have identical Rust tree, manifest and lockfile objects;
the later frozen HEAD does not imply a different Rust binary source. It links to
the completed native build log
`/private/tmp/zorid-bases-plain-link-native-build.log`. Executable paths remain
`/Users/ctk/Projects/Zorid/target/s1-release/release/zorid` and the adjacent
`zorid-desktop-host`. The runner verified the supplied CLI hash and unchanged
source closure before and after execution. The host was hashed, not executed.

Report and full retained disposable fixture:
`/private/tmp/zorid-bases-cli-actual-20261022-003/zorid-bases-cli-L02G9w/report.json`.
The adjacent `independent-verification.json` records a separate post-run check:

- All 85 child closes were observed without signal termination. There were 81
  successful commands and the four expected rejection exits: query-before-build
  and unknown-view exited 4; stale-note-edit and old-snapshot rejection exited 3.
- Every command's stdout/stderr and supplied stdin, plus all 30 exports, matched
  its recorded hash. Table, cards, list, kanban, empty and author saved views were
  queried in each of the three phases.
- Numeric output was rechecked against authored oracles: rating/scaled totals
  were 14/28 initially, 16/32 after the note edit, and 16/49 after configuration
  edits. The table retained all five book rows in each phase.
- All ten remaining authoritative files were independently reread from disk and
  compared byte-for-byte with expected fixture sources and explicit edits.
  Grace's deleted path and Birch's old renamed path were absent.

No process remained after the CLI campaign. As in earlier runs, these exports are
existing `base-query` JSON and `read --raw` outputs. This run introduces no new
CSV/TSV/Markdown export command and does not establish cell-edit UI, clipboard,
hover, browser/WASM, Electron, mobile or visual-reference acceptance. Local
`/private/tmp` evidence may be removed by the operating system; identities,
outcomes and limits remain recorded here.
