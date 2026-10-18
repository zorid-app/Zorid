# Vault-key recovery bundle v1

Owner: `livesync_audit`, branch `tingkai-c/core-recovery-bundle`, main base
`fbf55c07c3a28cca82c94a5cc427b2897b3c8e48`. Scope: portable recovery wrapper
and disposable CLI/relay fixture. Independent design review: `recovery_review`
and `mobile_readiness`. Source and runtime review are tracked separately below.

## Purpose and trust boundary

A random 32-byte `RecoveryKey` wraps one random 32-byte `VaultKey`, for one
independently selected realm, vault and positive key epoch. It is a separate
Rust type and binary purpose from `vault_update`; neither type is Debug, Clone
or serializable. No password derivation or custom cryptographic primitive is
introduced. The existing pinned RustCrypto XChaCha20Poly1305 implementation
provides encryption/authentication; entropy uses the existing fail-closed host
capability. Browser bindings and recovery UI are not included in this change.

Store the ciphertext bundle alongside a backend ciphertext backup if desired.
Keep the external recovery secret in separate protected custody. Possessing the
backend backup and bundle alone must not recover the content key. The backend
never receives that external secret or plaintext vault key. The public bundle
reveals its realm/vault identifiers, format/suite and key epoch.

Callers must supply expected context independently, not trust incoming bundle
metadata to select it. Old authentic bundles remain replayable. This wrapper
proves neither backup freshness/completeness nor a device signature; it does not
revoke a previously leaked secret. Managed server restore independently changes
server epoch and revokes restored tokens. Neither server epoch nor tokens are
bound into the bundle, so restoring the server does not invalidate the content
key recovery mechanism. Account verification and new credential issuance remain
separate privileged operations.

## Exact framing

All integers are unsigned; multi-byte integers are big endian. No JSON or
optional fields exist in this first format. Unknown versions/suites fail closed.

| Field | Bytes |
| --- | --- |
| Magic `ZRBK` | 4 |
| Format version `1` | 1 |
| Cipher suite `1` (XChaCha20Poly1305) | 1 |
| Realm byte length, canonical realm ID | 1 + 1..128 |
| Vault byte length, canonical vault ID | 1 + 1..128 |
| Key epoch (nonzero) | 4 |
| Random nonce | 24 |
| Encrypted vault key | 32 |
| Authentication tag | 16 |

Total is 86..340 bytes, with an exact-length check and no trailing bytes.
The raw maximum precedes all parse allocations; each ID length is checked
before copying and its existing protocol constructor enforces canonical ASCII.
AAD is `b"Zorid/recovery/vault-key/v1\0"` followed by the exact header bytes
through key epoch, including magic/version/suite/lengths. AEAD also authenticates
the nonce. A purpose-specific format and AAD prevent use as a vault update.

`seal_recovery_bundle` returns bytes for durable retention; retransmit those
bytes instead of resealing. `open_recovery_bundle` checks framing/context and
then authenticates into a zeroizing fixed-size buffer, moving its owner directly
into `VaultKey`. The in-place detached API keeps error-path temporary plaintext
inside a zeroizing owner. Caller exports, host buffers, compiler temporaries and
internal cipher state still carry best-effort erasure limitations. Errors do not
include secrets and cannot diagnose wrong-secret versus corruption.

## Acceptance scope

Source tests cover maximum/minimum IDs, every byte tamper, every truncation,
trailing/oversize input, unknown format/suite, invalid IDs/zero epoch, each wrong
context and independently matched tampered context, wrong recovery secret,
entropy failure, separate envelope purposes and system entropy round trip.

The Unix CLI integration fixture authors and uploads a known note, snapshots the
actual relay, removes the original local vault/database/credential/input files,
then restores the server into a new database. It checks fresh server epoch,
old token rejection (including a post-backup revocation), fresh device authority,
old cursor rejection and preserved ciphertext. Only the separately held recovery
secret unwraps the backup's content key. A new CLI local store receives the note
and another process resumes without receiving or uploading it again.

That earlier text-v1 fixture supplied the note path, stable ID and text bootstrap
explicitly. It is superseded by the file-v2 clean-client fixture in
`crates/zorid-cli/tests/recovery.rs`: the receiver starts without namespace or
bootstrap bindings and reconstructs text and a multi-chunk binary attachment
after original client state removal. Executed acceptance is recorded in
[shared-core-milestone-acceptance.md](history/shared-core-milestone-acceptance.md).
This bounded fixture does not establish every namespace history or product
recovery setup. There is no hidden trusted metadata export from the lost client.
Multi-key-epoch history/rotation, automatic
backup scheduling, production enrollment/recovery UI, recovery-secret custody,
mobile/browser integration and independent security review remain open.

Independent implementation source review: `recovery_review` approved all five
changed paths with no scoped blocker, then approved the narrow nonce/tag fixed-
array conversion followup after the first run exposed deprecated API warnings.

Focused runtime verification on macOS, source `7a54d70` plus that reviewed
conversion followup, using the coordinator-granted idle target
`/Users/ctk/orca/workspaces/Zorid/core-native-sync-integration/target`:

- `cargo test --locked --offline -p zorid-crypto -j1 -- --test-threads=1`:
  exit 0, 15 tests + 1 compile-fail doc test. Final rerun warning-free.
- `cargo test --locked --offline -p zorid-crypto --no-default-features -j1 -- --test-threads=1`:
  exit 0, 13 tests + 1 compile-fail doc test.
- `cargo test --locked --offline -p zorid-cli --test recovery -j1 -- --test-threads=1`:
  exit 0, 1 actual restored-relay/independent CLI fixture (1.12s).

All commands used `CARGO_TARGET_DIR` above and ran sequentially. Server/child
processes stopped at fixture completion and the heavy slot was released.
No deployment, migration, full namespace restoration or production key lifecycle
is claimed.

## Reference provenance

The key hierarchy/wrapping separation is informed by independently inspected
[Etebase Rust SDK account key-wrapping source](https://github.com/etesync/etebase-rs/blob/c0c74b777724777713d0fbbaeb968ba1521aa8e8/src/service.rs#L135-L163)
and [crypto manager](https://github.com/etesync/etebase-rs/blob/c0c74b777724777713d0fbbaeb968ba1521aa8e8/src/crypto.rs#L66-L95).
See `etebase-reuse-assessment.md` for the stronger limits around password change,
revocation and backup restoration. This implementation is original; no SDK or
AGPL server code was copied. SDK adaptation would require BSD-3-Clause notices.

LiveSync remains a reference for dependency completeness and checkpoint recovery,
not a replacement protocol. Its pinned
[storage reflection design](https://github.com/vrtmrz/livesync-commonlib/blob/5f79422c96565ee33f26449668cda2f6d67376f7/docs/storage-events-and-reflection.md)
informs the separation between durable remote receipts and local projection.
The broader edge-case matrix is owned by `mobile_readiness`; this wrapper alone
does not establish missing-chunk recovery, compaction safety or full restore.
