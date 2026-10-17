# Etebase reuse assessment for Zorid

2026-10-16. Source/document audit only: no SDK installation, builds, server execution, migration or security audit. Latest user direction is **selective reference/reuse within Zorid’s Rust stack**, not wholesale backend adoption. The replacement-prototype assessment below is a conditional finding, not the current implementation instruction. Independent Yrs/browser review supplied by `/root/crdt_interop`.

Etebase is a useful reference before Zorid extends its account/key-management layer. If wholesale SDK/backend reuse were reconsidered, only a small, decisive prototype would be justified. It provides real reusable encrypted item storage, password-based account bootstrap, sharing and revision retrieval. It does **not** remove Zorid's need for Yrs merging, durable local transactions, crash-safe cursor advancement, recovery UX or backup operations. Several specific differences prevent calling it a drop-in replacement.

## Accepted direction: selectively reuse what passes our contracts

Retain the Rust core/backend choice. Bring over reviewed patterns and regression cases, with provenance, rather than promising Etebase wire compatibility or transplanting its server. No implementation change was made in this audit.

- Account, collection and item key separation; encrypted key wrapping; password change that rewraps retained data keys. These are reference patterns for a separately reviewed lifecycle design, not permission to invent cryptographic primitives or infer device revocation from password change.
- Client-generated item/revision identity and durable encrypted-item caching before upload. Preserve original retry identity across lost ACK; keep Zorid’s stronger exact-byte dedup validation.
- Explicit optimistic concurrency plus batch atomicity, while keeping CRDT causal handling separate. Retain Yrs for merging.
- Encrypted revision retention with an explicit user history/compaction policy. Do not equate server revisions with complete backups.
- Opaque incremental discovery plus notification hints. Keep our durable local cursor transaction and fixed snapshot/restore-epoch guarantees instead of copying the observed eager subscription cursor.
- Account/permission/ciphertext recovery tests. Preserve our managed-restore credential invalidation and add external-key recovery; do not copy raw bearer storage or assume media/database backups are automatically coherent.

For copied/adapted code, record upstream repository, exact commit/file, original license and changes. Rust/JS SDK code is BSD-3-Clause; server code is AGPL-3.0. Preserve applicable attribution/license obligations. Distinguish implementing an independently specified invariant from translating upstream implementation. Reuse established cryptographic libraries; crypto protocol/lifecycle changes need their own review and tests. A selective reference strategy still leaves us owning the resulting protocol’s maintenance and security—it does not inherit upstream correctness merely by citation.

## Conditional backend/SDK replacement assessment by subsystem

| Subsystem | Recommendation | Reason |
| --- | --- | --- |
| Account bootstrap, password change, encrypted key hierarchy | Prototype reuse | Substantially more complete than Zorid's current fixture credentials; recovery and device revocation still need explicit design/tests. |
| Server encrypted storage and sharing | Prototype replacement behind an adapter | Existing collections/items/ACLs can replace much of the custom relay, but immutable-event semantics and restored-server behavior need adaptation. |
| Native Rust CLI/desktop client | Prototype SDK | Official Rust library exists; standalone embedding is compatible in principle, with native crypto dependencies. |
| Browser | Prototype official TypeScript SDK next to shared Yrs WASM | Do not assume the native Rust SDK can be compiled unchanged into our browser core. |
| Local SQLite/IndexedDB authority, checkpoints, file projection, Yrs | Keep | Etebase is neither our local data core nor a CRDT/file-system reconciliation implementation. |
| Existing mutable-item upload as automatic conflict merger | Reject this usage | Last-write item updates and revision history do not merge Yrs deltas by themselves. |
| Existing websocket SDK token as durable receive cursor | Reject this usage | The JS SDK advances its reconnect token before the application commits ingestion. |
| Built-in recovery/admin/backup as a completed Zorid solution | Reject that claim | Useful primitives exist; complete product workflows and our restore safety contract are not established. |

This challenges custom **protocol/lifecycle ownership**, not primitive selection: Zorid already uses RustCrypto AEAD rather than inventing a cipher. A successful Etebase experiment should evaluate replacing the outer account/encryption/storage layer, not merely double-encrypting existing Zorid envelopes and retaining all custom key lifecycle work.

## Pinned evidence and maintenance

GitHub API inspection found these default-branch heads (dates describe commits, not a security verdict):

| Repository | Pinned head | Last head commit | Source version |
| --- | --- | --- | --- |
| Rust SDK | [c0c74b7](https://github.com/etesync/etebase-rs/commit/c0c74b777724777713d0fbbaeb968ba1521aa8e8) | 2025-05-28 | 0.6.1 |
| JS SDK | [24e5dd2](https://github.com/etesync/etebase-js/commit/24e5dd20aab63528b4494d0f48682bfa2053a435) | 2023-01-06 | 0.43.0 |
| Server | [6ac5412](https://github.com/etesync/server/commit/6ac54121048e104437eec861f142e7dc1bebf7eb) | 2024-07-12 | Changelog latest 0.14.2 |

These indicate relatively sparse recent activity in the exact components we would use. They do not prove abandonment or insecurity. The Rust changelog records an OpenSSL security update in 0.6.1; server changelog records Python/FastAPI/Pydantic compatibility fixes. Dependency health, supported production configurations and maintainer responsiveness need confirmation before adoption. No exhaustive vulnerability scan was performed. [Rust changelog](https://github.com/etesync/etebase-rs/blob/c0c74b777724777713d0fbbaeb968ba1521aa8e8/ChangeLog.md), [server changelog](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/ChangeLog.md).

The libraries use BSD-3-Clause; the server is AGPL-3.0. Reusing the server introduces its license obligations, rather than just copying an architectural idea. [Rust manifest](https://github.com/etesync/etebase-rs/blob/c0c74b777724777713d0fbbaeb968ba1521aa8e8/Cargo.toml), [JS manifest](https://github.com/etesync/etebase-js/blob/24e5dd20aab63528b4494d0f48682bfa2053a435/package.json), [server license](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/LICENSE).

## Rust, browser and deployment fit

The Rust SDK exposes byte-oriented item APIs and can be embedded in an independent CLI process. Its manifest includes sodiumoxide/libsodium, unconditional OpenSSL dependencies, and optional blocking reqwest networking. Disabling networking alone therefore does not establish wasm32-browser support. The inspected Rust CI is Linux/server testing, not a browser WASM matrix. [Manifest](https://github.com/etesync/etebase-rs/blob/c0c74b777724777713d0fbbaeb968ba1521aa8e8/Cargo.toml), [CI](https://github.com/etesync/etebase-rs/blob/c0c74b777724777713d0fbbaeb968ba1521aa8e8/.github/workflows/test.yml).

The separate JS SDK explicitly targets web/Node/React Native and uses libsodium wrappers and an Argon2 worker. A reasonable prototype keeps domain/Yrs logic in shared Rust/WASM while the browser SDK manages Etebase crypto/session/transport. This is an architectural seam to test, not verified shared-Rust crypto parity. Browser unlock storage, worker integration, memory limits and malformed-message bounds remain application responsibilities. [JS package](https://github.com/etesync/etebase-js/blob/24e5dd20aab63528b4494d0f48682bfa2053a435/package.json), [browser crypto implementation](https://github.com/etesync/etebase-js/blob/24e5dd20aab63528b4494d0f48682bfa2053a435/src/Crypto.ts).

The existing Etebase server is Python with Django ORM/admin and FastAPI/ASGI endpoints, not a Rust server. Default settings use SQLite; PostgreSQL is not mandatory. Redis is required for its websocket subscription path, not evidence that every polling installation needs it. Adopting this server means explicitly changing our backend technology choice while retaining the Rust local core. [Settings](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/settings.py), [websocket ticket requirement](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/fastapi/routers/websocket.py#L41-L54).

## Yrs storage, conflicts and retries

Etebase items hold arbitrary bytes inside encrypted collections. Collections have access control, and item revisions retain past encrypted states. These are useful building blocks for Yrs update storage; they are not CRDT merging. [Overview](https://docs.etebase.com/overview), [revision API guide](https://docs.etebase.com/guides/revisions).

**Proposed experiment:** one collection per Zorid vault and one application-immutable item per authored update, with encrypted metadata containing our family/version/document/update identity. Keep our local atomic outbox, actor ownership, dedup and projection semantics. Avoid repeatedly replacing a single item's content with the latest incremental delta: normal fetching returns current items, so intermediate deltas can be missed. A single full-state item is a different design requiring merge/CAS retries and retention proof.

The server's `batch` disables etag validation; `transaction` enables it. Repeating the current revision UID returns success, whereas this branch does not compare the full replayed bytes. Use transaction semantics plus persisted SDK identity and local content checks; do not claim our existing exact-byte immutable-ID server guarantee survives unchanged. This source difference is not a reproduced exploit. Application-immutable items remain a convention: ordinary Etebase writers can update/delete items, and a clean client cannot assume our append-only enforcement. The collection write transaction commits before normal response generation, but deployment-specific power-loss durability was not tested. [Upload implementation](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/fastapi/routers/collection.py#L374-L414), [transaction vs batch](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/fastapi/routers/collection.py#L577-L600).

Durably cache the full SDK item and its IDs before upload, then restore it after lost ACK; recreating an item from the same Yrs bytes creates a different identity. Prefer Rust `cache_save_with_content` explicitly and verify restored bytes. Its sibling's documentation says content is omitted, but the pinned implementation has a FIXME and currently serializes identically—a reason to test the actual contract rather than infer it. [Rust item/cache APIs](https://github.com/etesync/etebase-rs/blob/c0c74b777724777713d0fbbaeb968ba1521aa8e8/src/service.rs#L1020-L1087), [implementation discrepancy](https://github.com/etesync/etebase-rs/blob/c0c74b777724777713d0fbbaeb968ba1521aa8e8/src/encrypted_models.rs#L877-L895).

## Cursor/restart and live updates

The server's `stoken` is an opaque database token resolved to internal ordering. Listing filters current items after that position and returns the final selected token. It has no equivalent parameter for our fixed snapshot `through` or explicit restored-server epoch. Invalid missing tokens fail, but a token still present in an older restored database is not inherently a restore detector. Lack of a fixed `through` is not automatically incorrect for generic incremental synchronization; an adapter must prove our bounded-pass guarantees under concurrent writers. It also needs a deliberate rejoin/restore contract and must commit opaque cursor plus applied local state atomically. Do not coerce `stoken` into Zorid's numeric log sequence. [Token implementation](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/fastapi/stoken_handler.py).

The JS subscription implementation sets its next reconnect `stoken` before calling the application callback. Our integration must treat realtime notifications as wake-up hints and poll from the last locally committed token, or change the subscription acknowledgement contract. Otherwise reconnect can skip data whose local commit failed. [JS subscription](https://github.com/etesync/etebase-js/blob/24e5dd20aab63528b4494d0f48682bfa2053a435/src/OnlineManagers.ts#L530-L553).

Two additional **static findings, not runtime reproductions** in the pinned server require focused tests before enabling its realtime path: catch-up loops use the same `stoken` after each page; the pubsub forwarder checks membership initially but does not visibly recheck it for subsequent messages. A backlog above 50 items and revocation of an already-connected subscriber are decisive probes. Start the first experiment with polling. [Websocket source](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/fastapi/routers/websocket.py#L87-L145).

## Accounts, recovery and revocation

Etebase already supplies password-derived key bootstrap and signed challenge login; encrypted account material remains on the server. Password change rewraps account material under a new main key. This is materially more complete than our protected fixture key file/token. It does not mean an administrator can recover a lost encryption secret. [Authentication protocol](https://docs.etebase.com/protocol-specs/authentication), [client authentication guide](https://docs.etebase.com/guides/basic_authentication).

Saved account sessions contain sensitive key material. Omitting the optional storage-encryption key uses a known zero key in both SDKs; it is serialization convenience, not secret storage. Zorid must explicitly use an OS-keystore-protected wrapping key or designed browser unlock policy. An externally recoverable encrypted session/key bundle is plausible, but its lifecycle, password-change compatibility and restore UX remain unverified; no complete recovery-phrase/device-pairing workflow was established by this audit. [Rust save](https://github.com/etesync/etebase-rs/blob/c0c74b777724777713d0fbbaeb968ba1521aa8e8/src/service.rs#L418-L450), [JS save/restore](https://github.com/etesync/etebase-js/blob/24e5dd20aab63528b4494d0f48682bfa2053a435/src/Etebase.ts#L216-L255).

The server has per-login bearer records with 30-day default expiry and sliding refresh. Those bearer keys are stored directly, unlike our hashed device tokens. Logout deletes the presented token. Password change updates account fields without deleting existing tokens in the inspected handler. A named-device inventory, remote single-device revoke API and trusted-device key rotation were not verified. Existing requests authenticate before entering write transactions, so our stronger revocation/write ordering needs a dedicated race test rather than assumption. [Token model](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/django/token_auth/models.py), [authentication handlers](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/fastapi/routers/authentication.py#L140-L215), [request authorization](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/fastapi/dependencies.py).

Collection sharing and read/write/admin roles are implemented. Removing a member removes access/membership; it does not visibly replace collection encryption keys. Neither this nor any system can retract data already decrypted by that member. Preventing future decryption after key theft is a separate key-rotation question. [Membership API](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/fastapi/routers/member.py), [membership/key model](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/django/models.py#L184-L233).

## History, full backup and restore

History is real source behavior, not only marketing: updates retain older revision rows, and the revision endpoint paginates newest-first. Those snapshots are not automatically a meaningful document timeline if each item represents one Yrs update; Zorid still needs document checkpoints and a history UI. Retention guarantees, storage quotas and a supported compaction policy were not established. [Revision model](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/django/models.py#L149-L178), [revision retrieval](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/etebase_server/fastapi/routers/collection.py#L504-L536).

The official server explicitly requires backing up **both database and MEDIA_ROOT**. Users, memberships and token/account records are in the database; encrypted chunks are files. Configuration and secret.txt also need an intentional restore policy. Thus our current single consistent SQLite backup cannot simply be reused. A coordinated snapshot/quiesce procedure must prove that DB references and media belong to a recoverable point. [Backup and secret-file instructions](https://github.com/etesync/server/blob/6ac54121048e104437eec861f142e7dc1bebf7eb/README.md#data-locations-and-backups).

No equivalent to our managed-restore transaction—new server epoch plus all restored tokens revoked before publication—was established. Copying a backup can restore old live bearer records and old permissions. An adoption design must invalidate restored credentials, review restored permissions, force safe client rejoin and test missing/corrupt chunks. Rotating Django SECRET_KEY alone is not proof that raw AuthToken rows are invalidated. Server backup also cannot replace the external secret needed for E2EE clean-client recovery.

## Acceptance cases to reuse; optional future SDK/backend prototype

The following cases are immediately useful as reference acceptance requirements for our Rust implementation. If an SDK/backend replacement is later reconsidered, run them with disposable data and a pinned local Etebase server; no current vault migration. Test the replacement layer directly using plaintext Yrs update bytes inside Etebase encryption, so the experiment measures actual reuse instead of a redundant encrypted tunnel.

1. Native Rust CLI and a real browser using JS SDK + existing Yrs WASM: create/login, reopen protected sessions, create collection, exchange update bytes and binary sentinel data; inspect server storage for plaintext.
2. Offline edits on both replicas, deletion-only changes, out-of-order/duplicate delivery, and restart: preserve actor ownership and prove identical text after replay.
3. Lose upload ACK, terminate before/after local ingestion commit, restore exact SDK item, retry; verify one logical update and no durable-cursor skip. Upload conflicting same-item bytes and prove preservation/rejection policy.
4. More than 50 updates with concurrent writes; prove bounded catch-up and recovery from the **locally persisted** token. Treat websocket notifications only as hints initially.
5. Two accounts/collections, permission reduction, token deletion/password change, an in-flight append/revoke race and a connected subscriber revoke. Separate server access denial from cryptographic future-key revocation.
6. Coordinated DB/media backup, restore to new instance, invalidate old tokens, reconcile old cursors, then clean-client recovery using an independently protected recovery secret. Retrieve historical content; remove one chunk and require an explicit recoverable failure.

Adopt only if these tests pass without reimplementing most of Etebase's protocol or maintaining a substantial security-sensitive fork. A narrow adapter or upstream fixes can be reasonable; needing a separate bespoke account, key, cursor and backup system would substantially reduce the benefit. If gates fail, reject that fit with evidence rather than concluding that reuse in general is wrong.

Comparison baseline: current `docs/sync-protocol.md`, `docs/sync-relay.md`, `docs/durable-write-contract.md`, plus native schema6/CLI source snapshot `1a918a1`. Zorid's own enrollment, key recovery, full history, production deployment and complete multi-client app acceptance are unfinished; its current tests do not establish superior production maturity. Those unfinished custom layers are where selective reuse could save the most risk. A backend replacement prototype remains an optional future decision; the current user-selected direction is reference-driven reuse/adaptation into Rust.
