# Stage 5 history, backups and management: source inventory

Audited 2026-10-18 against main0e9c1174/af8c5ef4. This is source inventory and
historical acceptance reconciliation, not a new runtime verification. Tasks,
Bases and Calendar remain ahead of Stage 5 in the accepted execution order.

## Existing foundations

- `crates/zorid-sync-server/src/lib.rs:186` exposes `backup_to` and `restore_new`.
  The snapshot covers all six current relay tables: identity, accounts, devices,
  vaults, memberships and encrypted updates. `src/snapshot.rs:40` pins a WAL read
  transaction; SQLite online backup copies a consistent permission/content state.
- Restore requires a new destination and expected realm, checks integrity and
  envelope context, rotates the server epoch and revokes all restored devices.
  No-overwrite publication, fsync and PublicationUnconfirmed remain distinct.
  Privileged reauthorization requires separate identity verification.
- `crates/zorid-store/src/text_sync.rs` retains immutable text revisions;
  `family_materialization.rs` retains publication witnesses. These are causal
  and recovery primitives, not a user version-history listing or restore API.
- `crates/zorid-file-sync/src/v2/retained.rs` authenticates retained binary
  content and bounds output. Missing dependencies are not an empty file.
- `crates/zorid-crypto/src/recovery.rs` seals a vault key for explicit context
  using a separate random recovery secret. Backup ciphertext does not itself
  recover the key, and an authentic old key bundle does not prove freshness.
- `crates/zorid-cli/tests/recovery.rs:337` starts a client without namespace or
  bootstrap bindings, removes original client state and reconstructs text plus
  multichunk binary from a managed backup using separate key recovery and fresh
  authority. Executed historical evidence is in
  [shared-core-milestone-acceptance.md](shared-core-milestone-acceptance.md) and
  [backend-integration-acceptance.md](backend-integration-acceptance.md).

## Missing product surfaces and operational limits

The CLI's `recover` resumes filesystem publication; it is not server backup or
historical-version restore. The server executable remains a loopback fixture.
HTTP and protobuf services expose Hello/Append/Pull, without management routes.
There are no product history/backup/admin commands or management web UI.

No scheduled or independently confirmed off-host copy, archive catalogue,
retention duration, coordinated history GC, multikey recovery lifecycle or
recovery-secret custody workflow is implemented. Account identifiers,
memberships and token hashes in a database backup rely on filesystem protection;
the whole artifact is not separately archive-encrypted. A restored membership
can be stale and does not prove account identity. Future identity-provider,
configuration and signing secrets require a coordinated backup boundary beyond
today's relay tables. Do not promise unlimited history or a retention duration.

## Next bounded implementation contracts

First expose operator snapshot-to-new-file and offline restore-to-new-file over
existing RelayStore APIs, requiring expected realm and retaining collision and
publication-uncertain outcomes. Keep credential reauthorization, secret export
and running-database replacement separate. A nonsecret archive manifest can
record identity, size, digest and capture time; a local snapshot is not proof of
off-host backup. Verify actual commands, not only the existing library tests.

Version history is separate: stable-ID listing and authenticated bounded preview
first, then restoration as a new ordinary mutation with expected-current
revision and retained retry identity. Never rewind CRDT history or overwrite a
current row with a historical snapshot. Explicit tombstone and binary-stream
coverage is required before calling this general file restore.

No new cryptography, public API or implementation ownership is selected by this
inventory. Preserve the existing operation, key-context and authority guards.
