# Backend integration candidate

Prepared 2026-10-16 by `/root/livesync_audit` for coordinator verification.
This is source preparation, not a runtime acceptance or production release.

## Exact source provenance

Base: main `aada3b062e8ce3f830ee350b38decd35358e7a66`.
Source: coordinator `b510194e6b85fbbe3d08c0a25a1480cfdb90502c`.
Candidate branch: `tingkai-c/core-backend-integration`.
Worktree: `/Users/ctk/orca/workspaces/Zorid/core-backend-integration`.

The following paths are copied byte-for-byte from that source commit. Their
source Git tree/blob identities are recorded for later comparison:

| Path | Git object |
| --- | --- |
| `crates/zorid-sync-protocol` | `1d0abb0500437586ea92a6392e1368acd6b460de` |
| `crates/zorid-crypto` | `8367eb388ce62169fa5803f22f024893ebdd8253` |
| `crates/zorid-sync-server` | `3eab08c4214d100c05e9c83199a9808bd3b63303` |
| `docs/sync-protocol.md` | `970e2fa3ca40079bd315d30efd5104b122aaae48` |
| `docs/sync-relay.md` | `13b3c92776ec0bccff9f72c205386faa55cac942` |

This includes `59e33624acd5fa3b1dfb53aa036c0fdec85d6b77`, which disables
foreign-key enforcement only on the disposable deliberately corrupted snapshot
fixture and asserts that the fixture has a foreign-key violation. Production
connections retain foreign-key enforcement. It also includes
`e64ddc78e4cef2a063a19b58240b33038d1f81be`, the source-reviewed private
`OpenedEnvelope` capability for a single bounded authenticated decryption.

No app, client-sync, WASM binding, or migration changes are in this batch.
The existing `members = ["crates/*"]` workspace glob discovers the three crates.
`Cargo.toml` is unchanged from the main base. Coordinator commit `d79705b`
resolved Cargo.lock offline with additions only; existing package pins were
preserved. The final candidate includes main through `e967d4f`.

## Source checks performed

- `git diff --cached --check`: passed.
- `git diff --cached b510194 --` followed by the five source paths above:
  empty, confirming exact staged source identity.
- Inspected each crate manifest: local path dependencies are confined to these
  three copied crates; no additional source crate is needed for this batch.
- Confirmed the documented loopback fixture and unfinished production boundaries
  remain intact. No service was started or deployed and no signup flow was added.
- Orca setup hooks were skipped. The verified unused fallback shell was closed.

The implementation already received independent source review in its owner
worktrees. Copy identity preserves that reviewed source; it does not substitute
for combined execution on this main-based candidate.

## Pending coordinator acceptance

No builds, tests, dependency resolution, or network access were run while
preparing this candidate. Earlier isolated evidence in the copied documents is
historical evidence for those versions, not a pass for this candidate. In
particular, the backup/restore fixture correction and authenticated capability
require execution here with the final lockfile.

After the shared heavy-build slot is released, the coordinator owns lockfile
resolution and bounded combined affected Rust tests, including protocol/crypto,
relay HTTP and storage, managed backup/restore and failure boundaries, plus the
no-default-features crypto configuration. Record exact commands, commit, counts,
and failures before main integration. Reconcile any newer main changes and
revalidate affected behavior; a clean cherry-pick alone is not acceptance.

Remaining product gates include production enrollment and key recovery,
complete client synchronization, scheduled/off-host backups, retained-history
policy, production TLS/auth/operations hardening, and native/browser integrated
acceptance. The relay remains an opaque-ciphertext local fixture service.

## Coordinator acceptance — 2026-10-16 22:57 local

Tested candidate: `91694d3`, clean before verification. Source remains identical
to the recorded reviewed backend snapshot. Homebrew Rust 1.99.0, macOS arm64;
fresh candidate target, bounded compilation and serial tests. The editor released
the heavy slot after its owned Electron process exited; no overlapping build.

```
cargo test --offline -p zorid-sync-protocol -p zorid-crypto -p zorid-sync-server -j1 -- --test-threads=1
cargo test --offline -p zorid-crypto --no-default-features -j1 -- --test-threads=1
```

First command: session65524 exit0, 31.89s compilation, 28 passes: 5 protocol,
8 crypto, 14 server and 1 compile-fail crypto doc test. One ignored crash-child
entry is explicitly launched by its parent process-crash test. Actual loopback
HTTP exchange/retry/revocation, account/vault permission isolation, bounded
snapshot paging, managed backup/restore of all tables, concurrent WAL snapshot,
revoked restored credentials/changed epoch and publication/crash boundaries pass.
Log: `/private/tmp/zorid-backend-integration.log`.

Second command: session5557 exit0, 7 crypto passes plus the compile-fail doc test;
7.60s compilation. Log: `/private/tmp/zorid-backend-crypto-portable.log`.
This configuration check is not a browser runtime check.

This supersedes the pending candidate-execution statements above. Integration is
approved for this bounded backend foundation. No service deployment, real-vault
migration, production security or actual web/Electron/CLI convergence is claimed.
Client recovery/key enrollment and the remaining product gates above stay open.
