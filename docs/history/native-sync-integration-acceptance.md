# Native/desktop sync integration candidate

Prepared 2026-10-16 by `/root/livesync_audit` for coordinator verification.
This records source assembly, not a combined runtime acceptance or app rollout.

## Provenance and ownership

Main base: `a71c8df25ec91476a9abaf4f714193414bd8eb7e`.
Exact reviewed source snapshot: `1a918a10d65b56be4c1c685190049280c799f57a`.
Branch: `tingkai-c/core-native-sync-integration`.
Worktree: `/Users/ctk/orca/workspaces/Zorid/core-native-sync-integration`.

The coordinator owns integration, Cargo.lock resolution and the serialized
verification slot. Native/store and checkpoints originate with
`/root/data_readiness`; CRDT/text-sync with `/root/crdt_interop`; CLI with
`/root/core_cli`; desktop transport/wrappers with `/root/desktop_integration`;
protocol helper with `/root/livesync_audit`. This preparer materialized the
coordinator-approved allowlist and checked exact identity, rather than treating
a new copy as an independent implementation review.

Every path below is byte-identical to the source snapshot. Directory identities
are Git trees; file identities are Git blobs.

| Copied path | Source object |
| --- | --- |
| `crates/zorid-core` | `a845618771beaa6b532fc98abcee5e2d81866269` |
| `crates/zorid-crdt` | `62cb7566fdf0196fa61f5173645d27d6975c1f13` |
| `crates/zorid-store` | `e7c557a32ac0f40a93cb6b43596e98fbefbda721` |
| `crates/zorid-native` | `b4118ddf914d6de5243680e6d35202df11751a7b` |
| `crates/zorid-client-sync` | `e0541720dca9413f9164eb5f691858b470a9c259` |
| `crates/zorid-cli` | `ee22aa7273652a90d8673b13ddb08d46a85fade0` |
| `crates/zorid-desktop-host` | `05edd40c5d445be6bca266fe44c03f23db2483cc` |
| `crates/zorid-sync-protocol` | `6fbae2c78e66fd631522e33e65a90f3bd573b8c1` |
| `desktop/rust-vault-service.cjs` | `3c6ef64b044c03337f88aba7e456b458f1daf173` |
| `desktop/core-vault-fixture-service.cjs` | `d05e1c1924cf7e9067331733cc3a83eedfd0ceb3` |
| `desktop/durable-writes.cjs` | `c88bd10ad30665d0d8b7d2859ffe6e431dacf6cc` |
| `desktop/durable-checkpoints.cjs` | `215f7b017aa327d64815f6d8f1b102f85dcf123a` |
| `tests/rust-vault-service.test.cjs` | `b38cbab412b2c6626e5800dc4bc13853d9ddfda5` |
| `tests/core-vault-fixture-service.test.cjs` | `10f8b67e9ae3613492b0a2d4c8ff1d23972b7335` |
| `tests/desktop-durable-writes.test.cjs` | `b81648b61ea1294a1a4274ef7b052fafb1b567cb` |
| `tests/desktop-durable-checkpoints.test.cjs` | `92338e0e05a3a6eab7aba77c4fe90bbb974fa821` |
| `tests/rust-vault-cli.integration.cjs` | `866d680bbd74c2b0de2177128e16be9140cdc83b` |
| `docs/client-sync.md` | `3a8c0f6c1712339907ee1d24b0fce7e016bcd6a7` |
| `docs/history/core-cli.md` | `169111072ff4b9cde06976b415e67dee1940eb18` |
| `docs/history/desktop-rust-host.md` | `f137edbad035769108663791c451ce142a64417b` |

The sole patch to an existing desktop service is the exact nine-line opt-in
change from `3c9ced76340876d4ee22539d9db6a262cf581dfa` to
`desktop/vault-service.cjs`. It adds the explicit trusted-host `coreFixture`
option while retaining the one-argument ordinary service path. The staged diff
is byte-identical to that reviewed patch. `desktop/main.cjs`, preload, menus,
renderer, browser/WASM source and other desktop/editor changes stay at the main
base. No app is newly selected onto this storage path.

The protocol copy includes `9ba7ee6` as coordinator `0c98f6f`: bounded shared
control-extension decoding, independently source-reviewed by the CLI owner.
No separate file-family implementation or new WASM integration is copied; the
coordinator will assemble those separately.

## Review and historical test evidence

The source and coordinator checkpoint record independent review of native
schema6 queues, durable checkpoint fences, text ingestion, and desktop wrappers.
The native source includes fixes for historical cross-entry revision reuse,
sealed key-epoch mismatch and orphan managed-text bindings. The desktop source
includes the reviewed Uint8Array comparison and response-metadata validation
fixes. The original protocol helper's bounded decode was source-approved, with
its standalone compatibility tests included here.

Native schema6 owner evidence is 108 focused native/store tests passing in its
isolated worktree using `cargo test --offline -p zorid-store -p zorid-native -j1
-- --test-threads=1`. This is historical component evidence only. The prior
coordinator combined run, session `99512`, exited 101 at a desktop test that fed
response frames to the strict request decoder. Source snapshot includes
`9a2a113`, the reviewed test-only correction that decodes response frames while
preserving production request validation. This candidate has not executed that
correction or the new CLI HTTP sync tests; no combined pass is claimed.

The included schema6 fixtures cover local checkpoint CAS/tombstones, native
text-sync persistence/projection, durable intent process boundaries, and the
explicit native-host/independent-CLI checkpoint recovery target. CLI fixtures
exercise a real loopback relay with independently launched commands. Source
presence is not observed encrypted convergence or durable editor acceptance.

## Preparation checks and unresolved dependencies

- Exact staged source comparison against the allowlist: passed with an empty diff.
- Exact reviewed opt-in patch comparison: passed.
- `git diff --cached --check`: passed.
- Local crate path dependencies resolve to copied crates or existing main crates;
  the existing pinned Yjs fixture referenced by CRDT tests is present.
- Root `Cargo.toml` and `Cargo.lock` remain unchanged from the main base. The
  workspace glob discovers the new crates, but dependencies and lock resolution
  are deliberately unresolved in this candidate. Coordinator source has a newer
  lock; it was not copied wholesale, including unrelated file/WASM packages.
- No builds, tests, dependency resolution, network access, running services or
  deployment occurred during candidate preparation. Orca setup was skipped and
  the verified unused fallback shell was closed.

## Required coordinator acceptance

Resolve only the candidate's dependency graph without silently changing existing
pins. After obtaining the shared build slot, run combined affected Rust tests
including the corrected desktop framing fixture, protocol helper, native/store
schema6/checkpoints and CLI relay roundtrip. Build the actual CLI and desktop
host binaries, then execute the focused CJS tests and explicit
`tests/rust-vault-cli.integration.cjs` with the matching absolute binary paths.
Record commands, source/lock commits, results and cleanup before main integration.
Reconcile newer main changes as needed; copy identity or a clean cherry-pick
alone does not establish semantic compatibility.

Real Electron/editor save-handoff, restart recovery, full-vault binary/namespace
sync, production enrollment/recovery and deployed service behavior remain
separate gates. The CLI HTTP transport remains explicit loopback fixture text
sync, and no production credentials or ordinary vault migration are introduced.

## Coordinator verification — 2026-10-16

Candidate source `3660c77820511ac1c7fe323a88b4b79b9a988cfe` was tested on
macOS arm64. Root imported the resolved dependency lock from source `1a918a1`;
Cargo pruned unused workspace packages. No existing main package identity
(name/version/source) was removed or upgraded. Final tested lock SHA-256:
`e12a4485aefcd7643f236e315b00c7364a6e0c232fb96186e8f320e192812210`.

Serialized checks completed:

```sh
cargo test --offline -p zorid-core -p zorid-crdt -p zorid-store -p zorid-native -p zorid-client-sync -p zorid-cli -p zorid-desktop-host -j1 -- --test-threads=1
cargo test --offline -p zorid-sync-protocol -j1 -- --test-threads=1
cargo build --offline -p zorid-cli -p zorid-desktop-host -j1
ZORID_CLI_BIN="$PWD/target/debug/zorid" ZORID_DESKTOP_HOST_BIN="$PWD/target/debug/zorid-desktop-host" node --test --test-concurrency=1 tests/rust-vault-service.test.cjs tests/core-vault-fixture-service.test.cjs tests/desktop-durable-writes.test.cjs tests/desktop-durable-checkpoints.test.cjs tests/rust-vault-cli.integration.cjs
```

- Session14067 exited0: **202 Rust tests passed**, including independent CLI
  process offline convergence through the loopback relay and the corrected
  desktop response decoder test.
- Session72147 exited0: **6 protocol tests passed**, actual CLI/host binaries
  built, then **46 CJS tests passed**, none skipped. Actual process fixtures
  exercised desktop-host/CLI concurrency, restart, checkpoint recovery and
  byte copying. Synthetic transport fixtures remain labeled by their tests.
- Logs: `/private/tmp/zorid-native-integration-3660c77.log`,
  `/private/tmp/zorid-native-protocol-3660c77.log`,
  `/private/tmp/zorid-native-binaries-3660c77.log`,
  `/private/tmp/zorid-native-cjs-3660c77.log`.

These checks supersede the pending combined-runtime statement above for this
exact batch. They do not establish Electron UI integration, browser/server
convergence, full namespace/binary sync, the later client-admission lease batch,
production enrollment or clean-client encrypted restore. Fixture processes
finished with the test commands; no Electron window or deployed service was
opened. Main changes since this candidate base were editor commands and docs,
not these Rust/desktop service paths.
