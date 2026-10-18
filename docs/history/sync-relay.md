# Local encrypted relay foundation

Owned by `/root/livesync_audit` on `feat/core-sync-relay`, based on `49f884a`.
This is an isolated native SQLite relay and loopback HTTP fixture, not production
account enrollment, deployed infrastructure, complete recovery, or an app
storage migration. Protocol and crypto contracts remain in [sync-protocol.md](sync-protocol.md).
The coordinator records integration and verification independently in the roadmap.

## Authority and persistence

`RelayStore` stores one public realm and random server epoch; account identifiers;
device identifiers and SHA-256 bearer-token digests; account/vault membership and
read/write permission; and immutable encrypted envelope bytes. Device credentials
are 32 random bytes encoded as 64 lowercase hex characters. The native CSPRNG
must succeed or issuance fails. SHA-256 here hashes high-entropy bearer tokens,
not human passwords. There are no vault encryption keys, decrypted content,
document paths or local `MutationRequest` records in this service.

Provisioning and revocation methods are privileged **local library** APIs. HTTP
does not expose them. An operator/harness creates an account and vault, grants
membership, issues separate device tokens, and puts exported tokens in protected
client secret storage. Tokens intentionally lack Debug/Serialize/Clone. SQLite
contains only token digests, but a stolen live token still grants its device's
current permissions. No production sign-in, device pairing or account recovery
flow is implemented.

The application ID and exact schema are checked before journal changes. Existing
unknown/partial schemas are rejected. Initialization repeats its check under an
immediate write transaction. SQLite foreign keys, strict tables, WAL and
`synchronous=FULL` are enabled. A first create on an absent path is allowed;
opening another application's database does not adopt or repair it.

Each append holds `BEGIN IMMEDIATE`, checks the token's current revocation state
and current vault write membership, then validates independent endpoint realm,
vault and update identity. Only after authorization can a duplicate be returned.
Identical persisted bytes return the original sequence; changed bytes for the same
vault/update identity fail. The response is produced only after transaction commit.
Revocation therefore orders before or after append, including lost-ACK retries;
an append already committed before revocation cannot be retroactively withdrawn.
Separate connections/processes coordinate using SQLite, not a process-only mutex.

Each vault has a contiguous positive signed-64-bit server log sequence. This
avoids exposing other vaults' traffic through a shared counter. Sequences appear
on the wire as canonical decimal strings through the shared protocol types.
The authenticated uploader is recorded separately from encrypted-header origin.
A currently authorized writer can replay another device's retained ciphertext
after recovery. Header origin is a vault-key-holder claim, not a device signature.
The service can validate framing/context but cannot validate the AEAD tag or the
encrypted content. It can retain a positive future document-format version while
older clients refuse to apply it. This is deliberate opaque-relay compatibility.

## Snapshot pull

Each read establishes authorization, epoch and current vault upper sequence in
one read transaction. A page has `items`, `next`, `through` and `complete`.
`through` fixes the current snapshot; pass it on subsequent pages. Concurrent
new appends are left for the next snapshot. `after > through`, `through` beyond
the current vault sequence, and stale epochs are rejected. A cursor must be
stored alongside its vault identity; the protocol Cursor alone is not a vault
capability. Authorization always comes from device membership.

Pages contain at most 64 envelopes and at most `2 * MAX_WIRE_BYTES` original
envelope bytes. A full maximum-size envelope always fits. If the byte limit is
reached, `next.after` is the last actually returned entry, never `through`.
The HTTP JSON adds bounded base64 expansion and small metadata. Clients must
bound the HTTP response before JSON allocation and decode envelopes with the
shared bounded decoder. Missing sequence rows or stored envelope/index context
mismatches fail as corruption; no GC or compaction is implemented.

The client must apply each update and its cursor atomically with local dedup and
projection work. This service does not yet implement that client ingestion path.
Transport success never implies local application or file projection success.

## HTTP fixture

Maintained primary APIs used:

- [Axum 0.8.9](https://docs.rs/axum/0.8.9/axum/) with Tokio, bounded Bytes body
  extraction and blocking SQLite work off the async executor.
- [tower-http CORS 0.7.1](https://docs.rs/tower-http/0.7.1/tower_http/cors/struct.CorsLayer.html)
  with explicit exact HTTP(S) origins, no wildcard or credential cookies.
- [RustCrypto SHA-256](https://docs.rs/sha2/0.11.0/sha2/) for token digests and
  [getrandom 0.4.3](https://docs.rs/getrandom/0.4.3/getrandom/) for CSPRNG output.
- [rusqlite 0.40.2](https://docs.rs/rusqlite/0.40.2/rusqlite/) using the same
  bundled SQLite dependency as the native store.

Run a pre-provisioned fixture database with:

```
cargo run -p zorid-sync-server -- /path/to/disposable-relay.db fixture-realm 8780 http://localhost:5173
```

The executable binds `127.0.0.1` only; `serve_loopback` rejects non-loopback
listeners. Library router embedding must preserve this restriction. No public
TLS hosting or deployment is provided. No bearer tokens appear in logs or argv.
Local fixtures provision through library methods, as the executable HTTP test
does; this is deliberately not an administration product UI.

- `GET /v1/hello`: public realm/epoch, supported outer versions and size limits.
- `PUT /v1/vaults/{vault}/updates/{update}`: `Authorization: Bearer <token>`,
  `Content-Type: application/octet-stream`, original binary envelope. Returns
  the shared `Accepted` JSON after commit.
- `GET /v1/vaults/{vault}/updates?cursor=<URL-encoded Cursor JSON>&limit=64&through=42`:
  same bearer authentication. `through` is optional for the first page. Returns
  `{items:[{sequence,envelope_base64}],next,through,complete,extensions}`. Reusing
  the shared cursor decoder preserves optional-extension and required-feature
  rejection policy. Unknown top-level query fields fail.

Every response through request middleware is `Cache-Control: no-store`.
The service limits request URI/header size to 16 KiB, envelope bodies to the shared
wire bound and active handlers and outstanding blocking database work to eight
each. Blocking work keeps its permit even if its HTTP future is canceled. This is bounded fixture
behavior, not production denial-of-service hardening or a throughput benchmark.
No request/body/token tracing is enabled. Missing/unknown/revoked credentials
return 401, inaccessible vaults 403, immutable byte conflicts and epoch mismatches
409; malformed protocol input returns 400 and oversized bodies 413. Internal
storage errors do not expose SQL or request content.

## Evidence and remaining gates

Latest coordinator evidence supersedes the historical pending statements below:
main-based candidate `91694d3` passed all 14 server checks, 5 protocol checks and
8 crypto checks plus a compile-fail doc test, including the managed backup/restore
suite. The no-default-features crypto configuration separately passed 7 checks
and its doc test. See [backend-integration-acceptance.md](backend-integration-acceptance.md)
for exact commands, scope and limitations. Actual client restoration, scheduling,
off-host storage and production enrollment remain unfinished.

### Managed backup and restore source and accepted library verification

Privileged local APIs now include `backup_to(new_path)`,
`restore_new(backup_path, new_path, expected_realm)` and
`reauthorize_device(account, device)`. There are no HTTP administration endpoints,
scheduled jobs or live-database overwrite operations. These additions are a
separate source slice from the older nine-test relay verification below. The
combined backend acceptance linked above subsequently built and executed them,
including concurrent WAL snapshots, permission state, fresh restore epoch and
revoked restored credentials. Scheduling, off-host copies and product operator
commands/UI remain separate work; source acceptance is not a hosted service.

`backup_to` pins one WAL read transaction and uses the
[SQLite online backup API](https://www.sqlite.org/backup.html) through
[rusqlite Backup](https://docs.rs/rusqlite/0.40.2/rusqlite/backup/struct.Backup.html).
Accounts, devices, memberships and ciphertext therefore come from the same
snapshot even while another connection commits newer writes. Work copies in
256-page steps; busy/locked results fail the job rather than retry indefinitely.
This is a full database backup with the existing opaque encrypted envelopes.
Account/membership metadata and credential digests are protected by file access,
not a new encryption scheme. The server never acquires content encryption keys.

Published backup artifacts have a distinct SQLite application ID, `ZSBK`, while
live relays use `ZSRL`; both use schema version 1. Normal server open rejects a
backup artifact, preventing accidental startup with its old tokens and epoch.
Managed restore accepts the marked backup, validates canonical schema, SQLite
integrity, foreign keys, ID syntax, contiguous per-vault sequences and envelope
context, then copies into a new staging file. Realm mismatch fails. It preserves
realm/account/membership/ciphertext data but changes the server epoch and marks
**all** devices revoked in the same transaction that restores the live application
ID. It never changes the input backup.
These checks are structural: the relay cannot verify encrypted content tags
without the client key. Restored clients must authenticate envelopes before
applying them; this slice has no independent off-host archive checksum manifest.

The operator must independently authorize each device/account before calling
`reauthorize_device`; backup records alone are not identity verification. That
method replaces the token hash with a fresh random credential. Old credentials
stay invalid, and existing read/write permissions still apply. Restored account
permissions may be old and must be reviewed by the operator before granting
access. Clients reject the old cursor epoch and can replay retained original
ciphertext. This does not provide an external recovery key, enrollment UI or
protection from a malicious administrator deliberately bypassing managed restore.

Publication currently supports Unix filesystems with ordinary hard-link and
directory-fsync semantics. It fails closed on other platforms until their durable
publication/ACL implementation exists. The destination directory must be owned
by the effective file creator and not writable by group/other users. A randomly
named, mode-0600 staging file is created in that directory. The copied database
is converted to a standalone DELETE-journal file, validated, closed and synced;
then a no-overwrite hard link publishes it and the directory is synced before
success. A target that already exists, including a symlink or a race winner, is
never replaced. There is no multi-file DB/WAL publication window.
The path-based implementation assumes an operator-controlled directory tree;
mode checks are not a sandbox against hostile same-user ancestor renames or
additional permissive filesystem ACLs. It does not accept untrusted plugin paths.

Errors before publication leave the requested target absent (or preserve another
writer's target). Once the hard link succeeds, a failed directory sync returns
the distinct `PublicationUnconfirmed` outcome: the complete safe target may
already exist, so callers must inspect it rather than assume failure means no
file. A process crash can leave private `.zorid-relay-stage-*` files or a second
hard link; they are never automatically opened/adopted. Operator cleanup must
respect any active snapshot jobs. A restored published inode always passed the
epoch/revocation transaction before becoming visible. Directory fsync remains
the persistence boundary; process-exit tests do not simulate hardware power loss.

New source tests cover a WAL snapshot concurrent with account/permission/log
writes, old-token and old-cursor rejection, preserved reader permissions,
reauthorization, original-envelope replay and decryption, malformed backup/FK/log
rejection, wrong realm, existing/symlink/racing destinations, failure between
epoch update and token revocation, and real subprocess exits immediately before
and after publication. Dependency changes are rusqlite's `backup` feature and
moving existing `tempfile` from dev-only to runtime use. Root owns Cargo.lock.
Independent read-only review by `/root/core_cli` approved this source's snapshot,
credential-reset and publication lifecycle. Execution remains pending.

### Executed relay evidence before the backup addition

Source tests cover durable reopen/lost-ACK retry, immutable identity, other-device
replay, account/vault/read-write isolation, revoked retry/read denial, foreign
database rejection without mutation, transaction failure rollback, future opaque
formats, independently wrong realm, byte/item bounded snapshot paging, stale
epochs, and revocation committed while an independent connection's append waits
on the SQLite writer lock. HTTP tests use a real loopback TCP listener and two
device credentials, transfer/decrypt binary ciphertext, retry a lost ACK, revoke
the sender, and exercise body/URI/CORS boundaries.

A separate cancellation test stalls the database mutex, admits eight operations,
cancels their request futures and verifies that a ninth operation remains refused
until the surviving blocking closures complete. Outer no-store/bounds middleware
also covers early errors and CORS preflights.

Observed native verification on macOS arm64, Homebrew rustc 1.99.0:

```
cargo fmt -p zorid-sync-server
cargo test -p zorid-sync-server -j 1 -- --test-threads=1
```

All nine tests passed (one cancellation unit, two HTTP, six storage), with no
warnings. The initial offline command could not resolve `tower-http`; approved
registry fetch supplied dependencies for the successful run. HTTP uses a real
loopback listener in the test; all test processes/listeners exited. Independent
read-only review by `/root/core_cli` found the canceled-request work-permit issue;
the final source retains permits inside blocking closures and passed re-review.
Root workspace Cargo.lock changes remain with the coordinator for reconciliation.
This evidence does not establish deployed service security, actual app sync,
multi-process stress or backup/restore correctness.

Still required, not claimed complete:

1. Execute and independently review the new managed backup/restore source,
   including crash/error boundaries; add backup scheduling, off-host storage and
   supported non-Unix publication. Source implementation is not verification.
2. External recovery-key bundle protection and clean-client recovery. This
   service has no content keys and cannot recover them from account credentials.
3. Actual web/Electron/standalone CLI ingestion, persistence and no-echo behavior;
   crash/partial ingestion and offline concurrent CRDT convergence.
4. Production enrollment/auth, TLS, quotas, rate limiting, operation monitoring,
   threat review and tests beyond local fixture resource limits.
5. Binary/namespace conflict semantics, history retention/compaction policy and
   later P2P. A ciphertext relay is not a complete file synchronizer.
