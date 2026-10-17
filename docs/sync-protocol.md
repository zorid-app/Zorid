# First encrypted relay contract

Engineering direction for isolated fixtures, 2026-10-16. This document and the
`zorid-sync-protocol` / `zorid-crypto` crates are a protocol/crypto foundation,
not a server, enrollment flow, working sync client or production security review.
The shared-core coordinator owns integration and tracks execution evidence in
`docs/deferred-product-roadmap.md`. Do not replace the existing editor runtime.

## Implemented boundary

`zorid-sync-protocol` defines bounded immutable ciphertext envelopes, typed opaque
identities, canonical decimal log positions, epoch-scoped cursors, target-checked
acceptance receipts and first-version transport selection. `zorid-crypto` seals
and opens those envelopes using RustCrypto XChaCha20-Poly1305. Neither crate
performs persistence, authentication, authorization, network I/O or merging.

Version domains are independent:

- Transport major 1 selects HTTP/control semantics; `negotiate_transport` selects
  the supported intersection and rejects no-overlap/oversized offers.
- Envelope version 1 selects framing/header/suite interpretation.
- Document format version 1 reserves the first encrypted content schema. The
  relay structurally accepts positive u32 future formats without interpreting them;
  client seal/open requires supported format 1 before consumption. The crypto
  boundary treats content as bytes; payload decoding is not implemented.
- Local/server database schemas remain owned by their storage implementations.

Required envelope fields are strict and unknown top-level fields fail. Unknown required
features fail; version 1 defines none. Control messages expose a defaultable
`extensions` object containing `required_features` and `optional_extensions`;
allowed optional additions roundtrip, while required additions fail before use.
Unknown top-level control fields still fail; new optional fields must use this
known lane rather than silently altering old-client behavior. Additive metadata goes in the bounded
`optional_extensions` map and is preserved and authenticated. Such extensions
cannot change authorization, deletion, merge or durability semantics. Compatible
optional features must never be required for correct processing by older clients.

## Envelope and metadata exposure

Binary wire framing is:

```
"ZSE1" | header length (4 bytes, big endian) | exact UTF-8 JSON header
       | nonce (24 bytes) | ciphertext with Poly1305 tag (16-byte overhead)
```

Header fields: `envelope_version`, `purpose="vault_update"`,
`suite="xchacha20poly1305"`, `realm_id`, `vault_id`, `update_id`,
`origin_device_id`, positive `key_epoch`, `document_format_version`,
`required_features`, `optional_extensions`.

Opaque IDs are 1–128 ASCII letters/digits/underscore/hyphen. This validates
syntax only: production ID generation must provide collision-resistant random
identities. IDs are never paths or authority grants.

Limits: 4 KiB raw header, 1 MiB plaintext per envelope, 16 optional header entries
with 1–64-byte keys. These are fixture protocol limits, not a claim of arbitrary
large-file readiness. HTTP hosts must stop reading oversized bodies before
buffering them. `Envelope::decode` checks raw total/header/ciphertext sizes before
serde or copying payload buffers; header serde does not run on an unbounded
array. Cursor/receipt `decode` entrypoints similarly cap raw control JSON at
4 KiB. Do not deserialize unbounded HTTP input directly into auxiliary ID types.

The entire original header byte string is AEAD associated data; it is never
parsed and reserialized to authenticate incoming messages. Even semantically
equivalent changes to whitespace fail authentication unless resealed. Parsing
establishes structure only. Only successful `zorid_crypto::open` authenticates
the header/content relationship. The host must also validate the decrypted
document schema before applying it.

`ExpectedContext` comes from the authorized endpoint and independently selected
local vault/key context. It binds realm, vault, update ID and key epoch. Copying
all those values from an incoming header would defeat the independent context
check. Device origin is authenticated by the shared key but is not a device
signature: every holder of the vault key can construct such a header.

The server sees account membership, vault/device/update identifiers, key epochs,
format/suite information, ciphertext sizes, optional public header metadata and
timing. Names, paths, note contents, attachments and content causal metadata must
remain inside ciphertext. Account credentials are separate from content keys.
No claim of traffic-analysis resistance or independently signed authorship is made.

## Crypto and entropy

Pinned dependencies and official references:

- [RustCrypto chacha20poly1305 0.11.0](https://docs.rs/chacha20poly1305/0.11.0/chacha20poly1305/):
  256-bit key, XChaCha20-Poly1305 192-bit nonce, AEAD with associated data. No
  reduced-round algorithms or custom cryptographic primitives.
- [getrandom 0.4.3](https://docs.rs/getrandom/0.4.3/getrandom/): platform CSPRNG;
  `wasm_js` uses browser/worker `Crypto.getRandomValues`.
- [zeroize 1.9.1](https://docs.rs/zeroize/1.9.1/zeroize/struct.Zeroizing.html):
  owned vault key and returned plaintext clear on drop. This is best effort and
  does not erase caller copies, compiler temporaries or host memory.

`SystemEntropy` fails closed on platform entropy failure. Default native builds
enable `system-entropy`; the browser adapter explicitly enables `zorid-crypto/web`.
Hosts supplying their own CSPRNG may disable default features and implement
`EntropySource`. That trait requires full CSPRNG output or failure; there is no
deterministic fallback in production code. Deterministic entropy exists only
inside tests. Native/WASM compatibility still requires actual cross-target tests.

`VaultKey` intentionally lacks Debug/Clone/Serialize. `expose_secret` is an
explicit capability for protected enrollment/storage/recovery, never logging.
`seal` generates a fresh random nonce for each new immutable update. Persist the
resulting envelope before upload; retries resend those exact bytes. Calling
`seal` again for the same update ID is not a valid retry. `check_retry` rejects
different header/nonce/ciphertext under one identity; it does not authenticate
either envelope and cannot replace endpoint authorization.

## Relay and client transaction contracts

Implementation update: the relay is on main and the native text-sync client/CLI
slice is integrated in `6b450d7`/`13214dd`. See
`native-sync-integration-acceptance.md` for exact verification. The contracts below
also constrain remaining browser and full-file integration; they do not imply
all client acceptance gates have passed.

First transport: authenticated HTTP polling with these bounded operations:

- Hello: realm/server epoch, transport versions, suite and size limits.
- PUT immutable update at a vault/update-scoped endpoint.
- GET ordered bounded updates after an epoch-scoped cursor.
- Optional GET one update for targeted reconciliation, with identical access checks.

Each device has separate high-entropy authentication credentials. Server identity
comes from authentication, never client-supplied account/device JSON. Every read,
append and retry checks device status and vault membership; append authorization
is checked within its transaction to serialize revocation with writes. Initial
fixtures may provision accounts/tokens through their harness, but that is not a
production sign-in or device-pairing implementation. Non-loopback traffic uses TLS.

SQLite stores envelope ciphertext BLOBs for the first bounded fixture. Append
checks immutable identity, then commits bytes/index before returning `Accepted`.
Exact duplicates return the original sequence; different bytes under the same ID
fail. A transport/chunk ACK is never a durable application ACK. `Accepted` parsing
alone proves nothing; it must arrive over the authorized service connection and
match the pending update/vault/server epoch.

Pull establishes its page/high-water boundary in one read snapshot. Log positions
are decimal strings, scoped to one server epoch, never CRDT state vectors or local
revision tokens. Remote ingestion atomically records update deduplication,
resulting state, required file projection work and applied cursor. Failed
decryption, unsupported required semantics or failed commit cannot advance past
the update. Remote ingestion does not create a fresh authored outbox operation.

The local `MutationRequest`/`CommitResult` are not remote operations: their CAS
revisions and sequence are replica-local. First encrypted content should carry
stable entry identity and Yjs v1 update bytes. Namespace/binary events require
explicit causal conflict semantics before extending that payload; do not silently
choose arrival order as a conflict rule. Server code never decrypts or merges.

No compaction/GC in the first slice. Keep authored encrypted envelopes locally
after upload ACK, with delivery state separate from payload retention. Later
compaction requires an explicit history/rejoin policy and recoverable checkpoints.

## Enrollment, recovery and restore contract (not implemented yet)

For the first fixture: client A generates a random vault key and the harness
provisions B out of band. A separately generated random recovery wrapping key
protects a vault-key bundle. Backend backup may contain the encrypted bundle but
never its recovery secret. Clean-client recovery requires that external secret.
The recovery key/bundle must have a distinct purpose/domain contract; the current
`vault_update` envelope must not be repurposed silently for key wrapping.

Product choices remain open: recovery phrase/file UX, trusted-device pairing,
account authentication, browser unlock persistence, individual credential roaming
and detailed key rotation. No password KDF or custom key-exchange design is chosen.

Managed restore/rebuild changes `ServerEpoch` so old numeric cursors fail. Restore
preserves realm/vault identity to decrypt retained content; server epoch is not in
AEAD headers. Restored credentials are invalidated and require controlled
reauthorization, preventing an old backup from reviving revoked device access.
Authorized surviving clients reconcile/re-upload retained original envelopes.
An epoch detects managed restore, not arbitrary malicious-server rollback/forks.
Web E2EE also cannot protect plaintext from malicious client code served to a user.

## Required acceptance evidence

Current source tests cover bounded parsing, versions/required features, optional
metadata preservation, immutable retries, decimal cursor/receipt and epoch checks,
binary AEAD roundtrip, header/nonce/content/tag/key tampering, independent context
mismatch and entropy failure. Test existence is not execution evidence.

Still required before the first integrated goal is achieved:

1. Native↔WASM crypto, then real web↔Electron/CLI encrypted sync with independent
   local persistence; offline concurrent text/deletion convergence.
2. Lost server ACK and client crash before/after commit; duplicate delivery must
   not allocate duplicate durable updates or produce echo loops.
3. Partial ingestion failure cannot skip an update via a cursor. Unsupported
   required versions pause safely; compatible optional changes still work.
4. Account/vault isolation, wrong-context substitution and revocation races,
   including reads and duplicate retries.
5. Consistent encrypted backup/restore, changed epoch, rejected old credentials,
   retained-update replay and clean-client recovery with external recovery secret.
6. Arbitrary binary bytes, missing blob recovery, file/folder moves/deletions,
   external edits and preserved competing versions; real concurrent local clients.
7. Inspect service data/logs/backups for known plaintext/key fixtures. This is
   supporting evidence, not a formal confidentiality proof or security audit.

No service has been deployed and no real user vault migration is authorized here.

## Initial native verification

In `feat/core-sync-protocol`, macOS arm64, Homebrew rustc 1.99.0, with serialized
single-job builds:

```
cargo test --offline -p zorid-sync-protocol -p zorid-crypto -j 1 -- --test-threads=1
cargo test --offline -p zorid-crypto --no-default-features -j 1 -- --test-threads=1
cargo tree --offline -p zorid-crypto --no-default-features -e normal
```

Final results: five protocol and six default crypto tests passed without warnings;
five injected-entropy crypto tests passed without default features. The default
suite exercises actual native `SystemEntropy`, empty payloads and the full 1 MiB
boundary. The feature tree confirms no `getrandom` dependency when default
features are disabled: upstream ChaCha defaults are explicitly disabled and only
its `alloc` feature is enabled. Its own default randomness feature would otherwise
defeat host entropy injection. Initial sandbox DNS access failed; approved
registry fetch populated dependencies before the final offline runs.

Only owned crate/document paths are committed by this worker. The generated root
Cargo lock changes remain for coordinator review/integration. Native results do
not establish WASM compilation, browser crypto, relay persistence or full sync.
