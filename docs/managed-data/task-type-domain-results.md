# First functional portable Task/type domain

Owner F: `term_ef51c268-5804-46f1-b07c-f634a3c318a7`, task
`task_95d7cb7608bd`, dispatch `ctx_281274a8adb5`; isolated branch
`tingkai-c/managed-firstparty-consumer-contract`. Canonical main integration remains
with `term_2fbd0185-6f86-4649-824c-92faf46852f7`. No main mutation or push.

Contract correction commit: `b8bcdc1006a67d20fcfbab41e5d8ced8c71354ba` (after
`d3494464`), sent to the coordinator before implementation. The old R dispatch
was settled and refused further delivery; the coordinator acknowledged the prior
contract acceptance and routed the minor correction for review. Source/tests
freeze: `e9e0cdeb64562ea5e1d9040ad8b794a7a82cfe15`. Independent source review was
requested at that exact commit; this report does not claim it has completed.

## Delivered production modules

- `crates/zorid-bases/src/types.rs`: bounded host-fed `PropertyValue` Type AST
  interpretation, immutable compiled registry with original sources and invalid
  source diagnostics, stable IDs/options/status categories, exact-key mappings,
  capture defaults including explicit nulls, duplicate type IDs suppressed even
  when one colliding definition has unsupported/invalid semantics. One type per
  note and optional task capability; no special type name or checkbox promotion.
- `crates/zorid-bases/src/tasks.rs`: All/Today/Unscheduled query over an existing
  immutable `Generation`, validating captured Type file ID/path/revision against
  its manifest. Reuses `BaseSnapshot::from_generation` and existing metadata
  extraction/coverage. Date-only planned/deadline remain separate from block
  reservations. Missing status displays the persisted Type default; unknown
  status IDs and invalid dates produce diagnostics without rewriting source.
  Result includes saved entry/revision, Type witnesses, snapshot, metadata issues,
  coverage, category/option groups and explicit bounded output/truncation.
- `src/tasks/types-document.ts`: bounded existing `yaml` library AST read/edit,
  surgical stable-ID label/default editing with unknown keys/comments retained,
  failed-edit atomicity and invalid/unknown source inspection that retains exact
  original source. Rust is the domain authority for the host-fed AST. No YAML or
  Markdown parser/evaluator was added in Rust.
- `src/tasks/presets.ts`: ordinary `Types/Task.yaml` and `Bases/Tasks.base` contents,
  explicit capture defaults, destination configuration and nonoverwrite inventory
  planning. Existing folders are permitted; conflicting files/ancestors/descendants
  and case/Unicode aliases are surfaced. The plan is advisory: real host creation
  still must perform durable non-clobber admission to close races. No filesystem
  writes, registry activation or UI are performed by these functions.

Only existing source edit is two module exports in `zorid-bases/src/lib.rs`.
`graph.rs`, index/parser authorities, Cargo manifests/lock, bridge/WASM bindings,
native shell, workspace and NoteBuffer remain unchanged. The Task preset uses the
ordinary shared Base expression evaluator; its creation metadata is data for the
future caller, not a claim the current Base controller consumes it.

## Focused verification

Final source was checked with the existing official toolchain and cache, offline:

```sh
RUSTC=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/rustc \
RUSTDOC=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/rustdoc \
CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified \
/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/cargo test --offline --locked -j1 -p zorid-bases --test tasks
node --test --test-concurrency=1 tests/task-types.test.ts tests/bases-document.test.ts
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --allowImportingTsExtensions --skipLibCheck src/tasks/types-document.ts src/tasks/presets.ts
git diff --check
```

**10/10 Rust checks, 15/15 Node checks (5 new + 10 existing Base document), scoped
TypeScript and whitespace checks pass.** Rust checks cover exact custom mappings,
explicit persisted defaults, missing/unknown status, checkbox separation, captured
Toronto today versus UTC, leap/invalid dates, stale Type witnesses, duplicate and
invalid configurations, bounded AST/query output, incomplete malformed metadata,
and identical saved record selection through the existing Base evaluator. TS
checks cover source preservation/atomic edit failure, unsafe/malformed YAML,
invalid mappings/options/versions, real preset content and collision planning.
Both languages consume `tests/fixtures/tasks/task-type.json` for mapped-key/unknown
source expectations.

The first Rust fixture run compiled production modules but used invented index
semantic versions and failed generation construction (2 pass/5 fail). Corrected
fixtures now use the existing index extraction/resolver/query constants; subsequent
7-check and final 10-check runs passed. Initial scoped TS found an unsafe YAMLSeq
cast; it was replaced by runtime isSeq guards before the passing runs. Existing
Bases expression dead-code/unreachable warnings remain; no unrelated cleanup.

Final logs: `/private/tmp/zorid-firstparty-tasks-rust-final.log` and
`/private/tmp/zorid-firstparty-tasks-node-final.log`. An ignored dependency-tree
symlink was used locally for the existing app packages and removed afterward.
No installs, network, full build/suite, Electron, browser or native process ran.

## Remaining delivery boundaries

Type AST source provenance is the host's responsibility: host must capture YAML
bytes/revision, parse through the approved bounded adapter, and provide matching
AST; manifest witness equality alone cannot prove AST-to-byte identity. The
portable API does not mint authority or bypass host capture. It validates ordinary
core EntryId/revision/path identities and refuses stale generations.

Next owners wire real capture/preset non-clobber creation, query bindings and
Tasks/Base UI using the existing durable file save route. WorkBlock W owns its
separate managed domain; task references are core EntryIds in the same vault.
No managed task mirror, feature sync/outbox/cursor, independent checkbox index,
public plugin API or arbitrary migration callback is introduced. Native Store
WorkBlock desktop service can proceed before browser listing/activation. Normal
Electron/browser authoring/reopen/convergence, independent review/integration and
native current-owner UI/verification remain separate required gates.
