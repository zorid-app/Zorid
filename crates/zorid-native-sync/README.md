# Native fixture sync runner

`FixtureSync` is the shared blocking runner used by standalone CLI and desktop
hosts. It embeds no desktop process dependency and starts no daemon. Its HTTP
transport and protected credentials were extracted from the reviewed CLI family
runner; the portable protocol codecs and NativeVault retain authority over wire
validation and atomic persistence.

```rust,ignore
let sync = FixtureSync::load(&trusted_config_path, &trusted_vault_root)?;
sync.check_binding(&vault)?;
let report = sync.once(&mut vault, SyncLimits::default())?;
```

Only trusted host startup code selects the config file and vault root. Load
requires an absolute protected file outside that root, validates its bounded
contents and accepts literal loopback HTTP endpoints only. The caller must use
the same root to open NativeVault. The public scope is logical realm/vault
metadata; it does not prove a filesystem lease. No key, bearer token or endpoint
is accepted through renderer operations. Credential containers are neither
serializable nor debug-printable; errors retain only stable static codes.

`enroll` supports fresh disposable family fixtures. `status` is read-only and
requires the persisted logical binding. `once` checks that binding, validates the
relay hello, pushes at most `max_push` exact persisted ciphertexts and pulls at
most `max_pages` pages from one fixed high-water snapshot. Defaults are 64 and 4;
maximums are 1000 and 100. A zero value disables that part of the sweep. Each
bounded page is authenticated before its updates are individually committed.
Server ACK, local receive and physical projection are separate report fields.
An error can follow earlier durable progress: retain state and retry the same
work. It never authorizes new update IDs or cursor replacement.

Transport timeouts, redirect/proxy/retry prohibitions, response bounds before
JSON/base64 parsing, exact ACK checks and strict raw response codecs are unchanged
from the CLI implementation. Calls block: desktop hosts run them on their
existing worker, not the UI thread. Native locking is per core operation, never
held across HTTP calls. All exposed capabilities remain explicit fixture scope;
production enrollment, large-file streaming and automatic scheduling are not
implemented here.

The existing CLI process fixtures remain the integration tests for the extracted
runner (lost ACK, independent offline processes, no received echo, mode identity,
namespace/binary payloads and protected credentials). Focused library tests cover
its new public limit validation and body-free error surface. Native schema8 and
actual CLI/desktop process gates are required before claiming integration.
