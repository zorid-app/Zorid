# Proposed embedded mobile fixture-sync slice

Status: **plan only; no hostlib, FFI or Swift implementation grant**.
Root permission message `msg_42aa6f2f1874` was read; it retains hostlib integration
ownership with root and keeps the Stage 4 candidate frozen during its WASM slot.
Prepared 2026-10-17 in `tingkai-c/mobile-testflight-setup` for native owner
`term_bbf1787b-d2e5-402a-b366-24d40a2385c3` and the shared-core coordinator.
Inspected recovery checkout: `tingkai-c/native-mobile-recovery`, HEAD
`2d232466db0a89bd1c7194d711f5529bc1392238`, rechecked at
`2300744647cc6ed7aa4c0c22bc62e5b29cc06fd3` (intervening change was only the
native owner's integration ledger). Its untracked `node_modules` was not
modified. This plan does not edit the native owner's integration ledger.

## Observed boundaries

- `crates/zorid-desktop-host/src/lib.rs` defines `EmbeddedHost`, holding one
  `NativeVault`, `ClientLeases` and reconciliation state. `open_local` opens and
  reconciles that vault. `dispatch` passes no sync runner to `execute` and
  explicitly rejects all fixture-family sync methods, including status, before
  ordinary lease authorization. Keep that renderer guard.
- `ClientLeases.active` owns actual kernel-backed `ClientLease` objects indexed by
  generation token. `NativeVault::verify_client_lease` checks current store
  authority, protected lock file and inode identity. Use those same guards.
- `mobile/rust/src/lib.rs` owns `MobileSession { host: Option<EmbeddedHost> }`.
  `zorid_mobile_request` dispatches through that host. Terminal failures/panics
  take the host and release its leases. FFI output uses exact owned byte slices
  and `zorid_mobile_buffer_free`; no concurrent calls/drop are allowed.
- `ios/App/App/NativeMobile.swift` serializes open, request, refresh, close and
  buffer frees on one static worker queue. Its claim-client check already binds
  renderer admission to persisted `LocalVault.clientId`.
- `zorid-native-sync::FixtureSync` already supplies `load`, `check_binding`,
  `status`, `once(SyncLimits)` and fixture `enroll`. CLI/desktop reuse this runner.
  Its protected config file must be outside the vault. Endpoint validation accepts
  only literal-loopback HTTP with explicit port; no DNS, remote URL or userinfo.
  The runner owns encryption, exact-wire retry, durable ingestion/cursor progress
  and bounded gRPC transport. It is not a production enrollment implementation.

Read source blobs (unchanged in the inspected recovery checkout):

| File | Git blob |
| --- | --- |
| `crates/zorid-desktop-host/src/lib.rs` | `e701e36ab39296b304a2dc5e533eb2082a95fa55` |
| `mobile/rust/src/lib.rs` | `c62ee61f2b7b18420122cc6ff106c9177be107b4` |
| `ios/App/App/NativeMobile.swift` | `a9e9f4c4159bb8b2246e1b7df4dd5a99e25f447c` |
| `crates/zorid-native-sync/src/lib.rs` | `9595c4e4b7171e628b7cd12963b1c90623fb3404` |

## Exact proposed first slice

Add **native-only configure-at-open + status/once**, using the same vault and
admission table as editor requests. Expose no enroll/rebind or configuration
mutation command. Normal local open and renderer framing stay unchanged.

Proposed Rust host API (new types live in `embedded_fixture_sync.rs`; host
re-exports the existing limits type so the FFI crate needs no new dependency):

```rust,ignore
pub use zorid_native_sync::SyncLimits as EmbeddedFixtureSyncLimits;
pub struct TrustedFixtureSyncOptions {
    pub client_id: zorid_core::OperationId,
    pub credentials_path: std::path::PathBuf,
}
// Native-only; not Deserialize/Serialize/Debug and never accepted from a frame.
impl EmbeddedHost {
    pub fn open_local_with_fixture(
        root: &std::path::Path, options: TrustedFixtureSyncOptions,
    ) -> Result<Self, serde_json::Value>;
    pub fn fixture_sync_status(&mut self) -> Result<MobileFixtureStatus, serde_json::Value>;
    pub fn fixture_sync_once(
        &mut self, limits: EmbeddedFixtureSyncLimits,
    ) -> Result<MobileFixtureReport, serde_json::Value>;
}
```

`open_local_with_fixture` is a separate opt-in constructor for an **already
prepared disposable fixture**. Open the existing NativeVault once, load the
runner with that exact root, and check existing persisted scope/binding **before**
`initialize_desktop_vault` can enroll a local-only scope or scan files. Reject an
unbound/wrong-scope root. Never silently convert an ordinary local vault into a
shared realm, replace logical identity, enroll from first sync, or fall back to
local-only open when fixture configuration fails. Ordinary `open_local` is untouched.

The fixture host stores `Option<EmbeddedFixtureSync>` containing the runner and
native-selected persisted client ID. Before **each** status/once, require exactly
one current active lease for that client ID in this host, pin its reference for
this call, and call the existing native lease verifier. Reject no lease, wrong
client/store, replaced lock or ambiguous ownership with the existing admission
faults; do not claim a second lease or accept any client ID from a sync request.
The existing editor claim/release operations remain the admission mechanism.
Until that persisted consumer is admitted, sync returns `client_not_admitted`.
This intentionally does not add sync from an unopened Recents screen.

No new renderer methods. In particular, keep `fixture_family_status`,
`fixture_family_once`, `fixture_family_enroll` and raw `apply` blocked in
`EmbeddedHost::dispatch`, with and without a valid renderer lease.

## Exact native boundary and configuration

Proposed extra C ABI declarations:

```c
MobileSession *zorid_mobile_open_fixture(
    const uint8_t *root, size_t root_len,
    const uint8_t *persisted_client_id, size_t client_id_len,
    const uint8_t *credentials_path, size_t credentials_path_len,
    ZoridBuffer *error_out);
ZoridBuffer zorid_mobile_fixture_status(MobileSession *);
ZoridBuffer zorid_mobile_fixture_once(
    MobileSession *, uint32_t max_push, uint32_t max_pages);
```

These are trusted shell calls, not Capacitor plugin methods. Root, client identity
and config location come only from the native catalog/test fixture selector.
Retain normal `zorid_mobile_open` for every ordinary vault. No environment scan,
web query/URL, launch deep link or JS-supplied endpoint/path/secret is authority.
Fixture selection is explicit in a Debug simulator harness, absent from normal
production startup. The new constructor takes UTF-8 byte pointers plus lengths;
root/config are nonempty and at most 4096 bytes, client ID is a canonical UUID,
and embedded NULs are rejected. Rust checks lengths/non-null/UTF-8 before parsing,
but cannot validate arbitrary pointer readability. Its unsafe caller contract
requires each non-null pointer to cover its stated readable length, writable
`error_out`, and a live/exclusive session for later calls. Swift keeps all UTF-8
byte allocations alive through the synchronous call on the serial worker. Do
not form a fixed 4097-byte slice over a shorter string allocation. Existing
`zorid_mobile_open` ABI remains unchanged. Do not expose Swift logic for binding,
transport, encryption, cursor or retry.

Use the **existing** protected-file credential DTO unchanged, parsed only in Rust:

```text
version: 2
transport: "grpc"
endpoint: literal-loopback http URL with explicit port and path "/"
realm_id, vault_id, server_epoch: independently provisioned fixture identity
key_epoch: positive integer
key_base64: existing canonical 32-byte vault-key encoding
bearer_token: existing credential format
```

No real values belong in docs, logs, frames or native display results. The fixture
harness installs a 0600 same-user, single-link regular file in a protected native
app-support directory outside the vault. Keep current size/symlink/canonical-root
checks and loopback restrictions unchanged. No credential constructor change,
Keychain provider, native-sync transport change or root Cargo.lock edit is needed
for this first simulator fixture slice. Existing `check_binding` verifies persisted
realm/vault scope only. Server epoch is checked during relay Hello (and against
retained cursor state after connecting); a positive configured key epoch is not
independently authenticated by local preflight. Key/epoch envelope mismatches
surface during existing sealing/authentication checks. This plan does not invent
an independent epoch authority or promise all mismatches fail before network;
the harness must provision mutually matching known fixture credentials.

## Results and limits

Each dedicated ABI result is bounded UTF-8 JSON, at most 64 KiB, with no binary
body: `{"version":1,"ok":true,"result":...}` or
`{"version":1,"ok":false,"error":{"code":"...","commit_uncertain":false}}`.
Use typed DTOs with these exact fields, projected from existing runner results:

- `MobileFixtureStatus`: `scope` (fixed `fixture_families_v2`),
  `family_sync_supported`, `all_file_sync_supported`, `synced` (preserve runner
  value; currently false), `pending_authored`, `pending_dependencies`,
  `pending_projection`, `recovery_entries` (canonical decimal strings),
  `pending_envelope_sample` (u32), `pending_envelope_sample_complete` (bool).
- `MobileFixtureReport`: `status` (above), `server_accepted`, `locally_received`,
  `locally_applied_updates`, `duplicate_receipts`, `dependency_pending_receipts`,
  `receive_projection_pending` (u32), `pull_snapshot_complete` (bool).

Do not serialize runner credential containers, raw errors, realm/vault/update
IDs, pending-envelope lists, endpoint, absolute paths, file names/content, tokens
or keys. ACK count is not materialization or convergence. Projecting typed status
is presentation only; Swift must not derive sync policy.

For the first foreground fixture action, accept `max_push` in 0..=1 and
`max_pages` in 0..=1; reject larger values before runner invocation with
`sync_limit`. Default 1/1. The shared runner's broader limits are unchanged.
Status makes no network request. Once runs `check_binding` and existing `once`
on the **same** NativeVault and serial worker, never opens another database.
No timers, automatic retry, background task or parallel sync worker is added.

## Lifetime, errors and cancellation

- `NativeMobileSession` adds trusted `fixtureStatus` / `fixtureOnce` wrappers,
  not entries in `NativeVaultPlugin.pluginMethods`. Every FFI call and buffer
  free remains on the existing static worker; return UI completions on main.
- Keep at most one accepted sync action per session; coalesce status polling and
  reject duplicate once submissions as native `sync_busy` before queueing. Native
  view/session generation gates discard stale UI completions. Do not retain a
  raw pointer in a second background worker.
- Native close stops accepting work, cancels queued-but-not-started actions, and
  waits for the started call/buffer free before dropping the host. Lease release,
  refresh and editor mutations cannot overlap a synchronous sweep.
- No hard interruption of an in-flight runner is proposed: its current connection
  timeout is 3 seconds and unary deadlines are 10 seconds, but local crypto/IO
  means those are **not** a hard total sweep deadline. UI cancellation detaches
  the callback and stops scheduling new work; it does not roll back or close the
  host underneath Rust. Process suspension/death relies on durable retry state.
  If stronger cancellation is required, request a separately owned runner change.
- Pre-run configuration/admission/limit errors have `commit_uncertain=false`.
  Once entered, any runner error is conservatively `commit_uncertain=true`:
  preserve existing pending update IDs, exact sealed wire, cursors and drafts;
  never reseal/recreate mutations because a UI result was lost. Keep existing
  sanitized runner codes (`sync_transport`, `sync_binding_mismatch`,
  `sync_epoch_mismatch`, etc.) and existing admission codes.
- Panic/terminal ABI failure preserves current empty-buffer/fenced-session
  convention, drops host ownership only on the serialized path, and requires a
  reopen with the same persisted consumer/operation IDs. Do not report success or
  “rolled back.” Known runner errors remain ordinary nonempty typed error replies.

## Named ownership request — not an implementation assignment

| Required owner grant | Exact files | Scope |
| --- | --- | --- |
| Root/shared-core coordinator `term_2fbd0185-6f86-4649-824c-92faf46852f7`, or its explicitly named host delegate | `crates/zorid-desktop-host/src/lib.rs`, new `src/embedded_fixture_sync.rs`, new `tests/embedded_fixture_sync.rs` | One optional runner field, trusted constructor/status/once, reuse existing lease guards, bounded DTO/errors and host tests. No relaxation of frame allowlist. |
| Native owner `term_bbf1787b-d2e5-402a-b366-24d40a2385c3` or its named FFI delegate | `mobile/rust/src/lib.rs`, `mobile/rust/include/zorid_mobile.h` | Trusted constructor and two ABI wrappers, buffer/panic tests. No root manifest or lock changes expected. |
| Same native owner or a separately named Swift worker | `ios/App/App/NativeMobile.swift`, new `ios/App/App/NativeFixtureSync.swift` | Debug fixture selector and trusted native session wrappers; no plugin registration or Swift sync engine. Native owner alone resolves any Xcode project reference required for a new file. |
| Coordinator-owned verification slot | new disposable fixture harness/test files under `mobile/fixtures/` and `mobile/rust/tests/` as assigned | Seed fixture outside real vaults, run host/FFI then simulator proof. No implicit build/simulator permission from this plan. |

Apple worker currently owns this plan/review only. Shared `zorid-native-sync`,
NativeVault/store, protocol, CLI, root build/lock files and native owner's
`docs/native-mobile-integration.md` remain untouched. Rebase/review against the
current recovery HEAD again before granting edits; clean integration is not proof.

## Disposable-fixture acceptance before calling this slice complete

1. Host tests: ordinary opens and renderer sync/raw mutations stay rejected,
   including with missing/valid/forged leases. Correct fixture scope without an
   admitted consumer is rejected; admitted current generation succeeds. Release,
   competing host, wrong store/client, lock replacement and stale generation fail.
2. Config tests: wrong/missing local scope, wrong realm, unsafe file, inside-vault
   file, final-component symlink/oversize config and DNS/remote/nonloopback URLs
   are rejected before network or vault rebind. Preserve the existing documented
   allowance for parent-component symlinks; native fixture selection remains
   within its own protected app-support directory. No local-only fallback or
   implicit fixture enrollment. Test wrong server epoch at Hello/cursor checks
   and mismatched key material at envelope authentication, without claiming a
   pre-network positive key-epoch authorization check that does not exist. Retain
   durable state after mismatch. Existing CLI/desktop behavior remains unchanged.
3. Actual bounded host+ABI fixture: same admitted handle edits/checkpoints,
   `once(1,1)` pushes exact persisted ciphertext, pulls authenticated remote text,
   then ordinary read on that same session sees committed data. Repeat/reopen and
   dropped-ACK fixtures preserve update/wire/cursor identities; preserve dirty
   editor checkpoints through a receive and surface normal conflict/recovery UX.
4. Redaction tests use sentinel credentials/paths/errors and prove neither success,
   errors nor panic outputs expose them. FFI buffers free once; invalid requests,
   queued cancellation, close-after-start and reopen cannot reuse a freed host.
   Error after server/local progress must not become a rollback/success claim.
5. **Simulator proof only after slot grant:** use Zorid Dev and disposable prepared
   same-scope vaults with a relay on the simulator-reachable host loopback. Verify
   real native status/once, editor save/receive, offline/restart/duplicate delivery
   and serialized close. Record exact simulator/relay/config identities privately,
   screenshots/results sanitized. Stop the owned fixture/simulator after the pass.

A simulator shares usable Mac loopback for this fixture; verify that reachability
in the actual run. On a real iPhone, loopback means the phone itself, not the Mac.
The first slice therefore proves **no real-phone remote sync**. A phone pointed
at a Mac LAN address must continue to fail fixture endpoint validation. Later
remote sync needs separately approved TLS/server-identity/authenticated enrollment,
revocation and native Keychain-held vault-key/device-token loading. Secrets must
stay out of synced vault files, JS, URL handlers and renderer DTOs. No Keychain
accessibility/recovery API, remote endpoint policy or enrollment design is frozen
by this fixture plan.
