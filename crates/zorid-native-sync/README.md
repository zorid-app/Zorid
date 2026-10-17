# Native fixture sync runner

`FixtureSync` is the shared blocking runner used by standalone CLI and desktop
hosts. Each `once` sweep owns one bounded worker with a Tokio current-thread
runtime and a generated Tonic client. It embeds no desktop dependency and starts
no daemon. NativeVault retains authority over exact ciphertext and durable state.

```rust,ignore
let sync = FixtureSync::load(&trusted_config_path, &trusted_vault_root)?;
sync.check_binding(&vault)?;
let report = sync.once(&mut vault, SyncLimits::default())?;
```

Only trusted host startup code selects the config file and vault root. Load
requires an absolute protected file outside that root and validates its bounded
contents. New fixture credentials require `version: 2`, `transport: "grpc"`, a
literal loopback HTTP endpoint with an explicit port, and independently pinned
realm/server epoch. Version1 HTTP credentials are rejected; no fallback or silent
reinterpretation exists. The existing key/token fields and protected-file checks
remain. The caller must use the same root to open NativeVault. No secret or
endpoint is accepted through renderer operations. Credential containers are
neither serializable nor debug-printable; errors retain only static codes.

`enroll` supports fresh disposable family fixtures. `status` is read-only and
requires the persisted logical binding. `once` validates the relay Hello against
transport major2, then pushes at most `max_push` exact persisted ciphertexts and
pulls at most `max_pages` pages from one fixed snapshot. Defaults are64 and4;
maximums are1000 and100. Zero disables that part of the sweep. Each bounded page
is authenticated before its updates are individually committed. Server ACK,
local receive and physical projection remain separate report fields. Failure
can follow durable progress: retain state and retry the exact existing ID/wire.
It never authorizes resealing or cursor replacement.

The generated protobuf codec enforces method-specific encoded message limits
before decode; portable RPC validators enforce required presence, version,
features, target, page continuity and exact inner wire/page bounds. This new
transport uses standard protobuf unknown-field/singular-field semantics. It does
not reinterpret the exact ZSE1 bytes, header JSON/AAD or encrypted payload format.

Connection timeout is3seconds and each unary deadline is10seconds. Compression,
automatic RPC retries, redirects and proxy forwarding are disabled. The internal
command and reply channels have capacity1; the worker and its runtime/channel
are joined and destroyed before a sweep returns. Hosts may call this blocking
API from their existing worker, including a worker using Tokio, without nesting
or dropping runtimes in its async context. Native locking remains per core
operation and is never held across a network call. Uncertain transport outcomes
retain `sync_transport` for the existing CLI watch retry allowlist.

Focused tests cover explicit config selection, loopback pinning, sanitized error
codes and runtime lifecycle. Independent CLI process fixtures retain offline,
lost-ACK/restart, exact-wire, isolation, revocation and protocol-feature checks
against the actual relay adapter. Source implementation alone does not establish
those integrated checks, desktop/browser parity, TLS deployment or enrollment UI.
