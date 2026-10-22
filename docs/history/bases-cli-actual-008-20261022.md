# Actual standalone Bases CLI campaign008 — 2026-10-22

**All 125 commands and 17 checks passed**, including all 162 current typed row
expectations, 16 exact Q3 diagnostics and 10 exact legacy-context diagnostics.
This is a fresh complete standalone CLI campaign against the current preserved
executable. It includes the 16 added Date/String relational and existing-null-
guard checks; it does not establish current browser/WASM, rendered Bases UI,
native GUI/mobile, sync, stress or main integration acceptance.

## Exact executable and source

```sh
node tests/bases-cli-integration/run.mjs \
  --cli /private/tmp/zorid-bases-resume-native-e38e2461/zorid \
  --expected-cli-sha256 fca404ed6d75ca973aa7cb120b86df4d3a08fd5d60798afc11ab8dcf21c55ce9 \
  --source-revision e38e246144efeb5a194a314a3c0a22ebf39d3415 \
  --out /private/tmp/zorid-bases-cli-actual-20261022-008
```

Root: `/Users/ctk/Projects/Zorid/.worktrees/types-bases-model`. Session 53195
exited 0. The coordinator authorized the bounded CLI run while a separate
parent-owned Electron campaign used its own different fixture vault. This CLI
runner launched no Electron app, host, browser, daemon or IPC service and never
closed or modified the parent's test application. The source/artifacts remained
frozen through this campaign's final integrity proof.

| Witness | Exact value |
| --- | --- |
| Frozen checkout and executable build source | `e38e246144efeb5a194a314a3c0a22ebf39d3415` |
| Rust crates tree | `dbfc92218e82c6ecb8aeb23027366c37f096f80a` |
| Cargo manifest Git object | `dae521160181b50ce45ed9c7032b25609616b1c7` |
| Cargo lock Git object | `3c5ae0aac485e1739fa57e824c28bae89c2cce7b` |
| Preserved executable | `/private/tmp/zorid-bases-resume-native-e38e2461/zorid` |
| Executable SHA-256 | `fca404ed6d75ca973aa7cb120b86df4d3a08fd5d60798afc11ab8dcf21c55ce9` |
| Executable bytes | 23430368 |
| Build receipt | `/private/tmp/zorid-bases-resume-native-e38e2461/receipt.json` |
| Build log SHA-256 | `659becf7a62cb27a134dbfa6c47bf8395e166fb31986487a89cd70e4c2bf0407` |

The build receipt records terminal exit 0 and exact executable/source association.
The runner independently verifies the supplied executable hash/stat identity,
matching Rust/Cargo objects and absence of dirty/untracked Rust inputs. CLI008
ran no Cargo or app build. It did not pass `--host`; no desktop-host runtime
acceptance is inferred from the paired build receipt.

All four frozen oracle sources were hashed before and after:

| Input | SHA-256 |
| --- | --- |
| `tests/bases-cli-integration/run.mjs` | `642f81eb8f4e37f5baa079e89faba0e0f15fe64df67ace0567138ffbe228df4d` |
| `tests/bases-cli-integration/fixtures.mjs` | `29c532d8455c6e8da9bb9d63fb9775cf964407e5300461b688114cda9d2ab836` |
| `tests/bases-cli-integration/q3-oracles.mjs` | `a66f3211cce7be631094a0538f7fae27f9c099e056ed3f4de3db110ad491abe6` |
| `tests/fixtures/bases-q3-semantics.mjs` | `c275b3f73967cc1b37ef6b10fbc017e500a9403ac6eca823e99a7a23fa560192` |

## Actual coverage and integrity

Seven original checks passed saved views/formulas/summaries/relations/rollups,
source preservation, revision CAS and exact operation replay, stale snapshots and
explicit reindexing, configuration edits, identity through rename, dangling
references without cascade, and derived-index rebuilding. All ten Q3 groups
passed exact typed rows, group/overall summaries, provenance identities and
complete diagnostic multisets.

The added Date/String cases test all four operators with Date on the left and
quoted ISO String on the right; invalid original strings yield false; reversed
String/Date comparisons remain asymmetric; numeric String fallback and raw Link
Date parsing retain their exact meanings. Two null comparisons pin the already
existing binary null guard. The product fix changes Date/String coercion, not
null behavior. Previous [CLI007](bases-cli-actual-007-20261022.md)'s 146-value
result and [browser010](bases-browser-actual-010-20261022.md)'s 146-value result
remain historical evidence for the earlier source and counts.

The independent `post-run-integrity.json` verifies all 250 stdout/stderr hashes,
29 stdin hashes, 54 unchanged JSON/raw export hashes and exact physical source
bytes for all 14 Q3 inputs. The executable identity/hash, Rust/Cargo source,
four oracle sources and build-log hash remained unchanged. All 125 invocations
resolved on child close without a signal: 121 exited 0, two expected
revision/snapshot rejections exited 3, and two expected index/view rejections
exited 4. No command or Q3 group was skipped.

The 125-command plan remains under the 128-command ceiling; the 25-second child
timeout, 12 MiB output cap and five-minute scenario guard stayed enabled. The
run began `2026-10-22T15:13:51.466Z`, finished `2026-10-22T15:13:55.160Z`, and
recorded 3685 ms elapsed. This small disposable workload is not a performance
or stress acceptance test.

## Retained evidence and remaining scope

Report:
`/private/tmp/zorid-bases-cli-actual-20261022-008/zorid-bases-cli-C8YYqK/report.json`

Report SHA-256:
`1c3c64a73f3e1f61678731b53fb74883bb2e70afd10a259c1e2f03377eae0664`

The same directory retains the independent integrity receipt, command inputs/
outputs, exports and own disposable vault/app-local cache. All owned CLI children
closed; no CLI-owned GUI or service remains. The CLI lane was released after
proof, while the whole-root freeze remained the parent's responsibility until
its separate concurrent Electron campaign also closed.

No unrelated app, user vault or data was changed. This evidence does not accept
the parent's native campaign, current full Bases UI, browser/WASM execution of
the 16 new cases, native input/clipboard/recovery, visual reference parity,
mobile, sync, stress or main integration. Those retain separate exact records.
