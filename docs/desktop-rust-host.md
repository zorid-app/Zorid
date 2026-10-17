# Desktop Rust host boundary

This is a transport implementation, not yet a selected application adapter.
The trusted Electron main process starts `zorid-desktop-host --vault ROOT` with
private pipes. It opens **existing** NativeVault storage; it never initializes a
selected user folder. The standalone CLI embeds the core independently and does
not connect to this process. No listener or daemon registration exists.

The host directly delegates list, read-by-ID, apply, reconcile, recovery and status
to NativeVault. Native storage owns locks, idempotency, journaling and projection.
The transport never implements another database, sync policy or filesystem write.
Unsupported namespace operations remain explicit errors from the native core.

Each frame has two big-endian u32 lengths (JSON header, exact binary body), followed
by those bytes. Limits are 1 MiB header, 16 MiB ordinary file body and 32 MiB checkpoint body. Both peers check lengths
before frame allocation. Response JSON serialization uses a capped writer; a valid
oversized response returns `response_limit` without breaking framing. That error
marks acknowledgement uncertain for commands that may have committed. Current
native list/status calls still allocate full results before transport serialization:
this cap is not a large-vault memory bound. Pagination/bounded native APIs remain
an integration gate, and results exceeding 1 MiB cannot be enumerated here yet. JSON requests contain version 1, decimal request_id and
one typed command; duplicate/unknown fields fail closed. Request 0 is reserved for
the startup handshake. No request can change the root. The CJS client validates successful response
shapes and checks mutation receipt operation ID, target and precondition before
resolving; malformed successes remain uncertain failures. Malformed/truncated frames
terminate the child; normal EOF releases it. Diagnostics never echo input errors,
paths, bodies, projection error strings or SQL.

The CJS service copies headers and binary bytes at admission, serializes requests,
and bounds admission to 32 requests / 64 MiB (including one maximum checkpoint frame). Child death, invalid response or timeout
rejects affected promises as `commitUncertain`; **retain/retry the exact operation
ID and mutation**, never manufacture a new one. It does not automatically restart
or retry. A successful response carries the original durable receipt even when
`projection.state` is `pending`. This is not failure and is not a remote-sync ACK.
Closing drains admitted operations, rejects new ones, sends EOF and observes exit.

## Remaining integration gates

- Runtime validation of atomic path reads, committed UI metadata and change events.
- Native move/delete semantics; folder creation and bounded rescan are available.
- WindowBroker native compare-and-write delegation, duplicate/superseded service
  cleanup, committed change notifications and preserved sender/grant validation.
- Editor operation-intent persistence and coherent receipt/snapshot publication;
  concurrency-safe rename/link updates and receipt-aware draft recovery.
- Authored/received CRDT client plans; this host does not send MutationRequest as
  a sync payload and does not imply that whole-file CAS merges remote text edits.
- Explicit startup selection and packaging inventory for the native executable;
  no environment or renderer-controlled executable selection in production.

## Verification

Source fixtures: `cargo test -p zorid-desktop-host -j1 -- --test-threads=1` executes
real host children with NativeVault, including independent writers, lost response
replay, binary bytes, malformed frames, EOF and existing-only opens.
`node --test tests/rust-vault-service.test.cjs` executes synthetic host children to
verify the JS framing, queue bounds, payload capture, failure fanout and shutdown.
These checks have not run yet. Neither suite establishes real Electron behavior,
packaged launch, actual CLI concurrency or encrypted web/desktop/CLI convergence.

An explicit native integration target also exercises the CJS service against the
actual Rust host while an independent actual CLI process races a conditional
binary write, then reconciles an external edit with the desktop host closed:

```sh
ZORID_CLI_BIN="$PWD/target/debug/zorid" \
ZORID_DESKTOP_HOST_BIN="$PWD/target/debug/zorid-desktop-host" \
node --test tests/rust-vault-cli.integration.cjs
```

It requires both binaries and fails if either is absent. It is outside the default
npm test glob, and has not run. It still does not launch Electron.

## Schema 4 presentation adapter source

The next transport slice requires native/store schema 4 (`8c13b67` or its integrated
equivalent), plus the typed `StoreError::ReloadRequired` supplied in native schema 5
(`ebd95eb`). It adds `read_path`, `list_snapshot`, `changes_after` and bounded
`rescan`, with typed result validation. Path reads return state, persisted
presentation metadata and binary bytes from one snapshot; UI times never come
from an unprojected filesystem file or an invented read-time timestamp.

`desktop/core-vault-fixture-service.cjs` is an explicit `fixture: true` factory,
also reachable through `VaultService.open(root, {coreFixture: {executable}})`,
not selected by `main.cjs`. The existing one-argument service selection is unchanged. It opens only initialized core storage, scans fixture
files, preserves exact binary bytes and UTF-8 BOMs, and rejects lossy text decoding.
Listing hides dot-paths for current UI compatibility while native storage/scanning
still includes them. Only the reserved root `.zorid` is excluded from watcher
hints. A durable change cursor drives committed events; watchers trigger native
reconciliation and bounded scans rather than synthesizing authoritative deletions.
Polling is serialized and bounded per turn. Oversized transport pages shrink
without cursor advancement; a typed reload requirement obtains a new coherent
snapshot before advancing and notifying. Generic corruption is never silently
converted into cursor reset. Poll timers reject overflow-sized intervals.
`close()` stops timers/watchers,
waits for accepted work and closes its private child.

Legacy void mutation methods explicitly reject until a durable editor consumer
checkpoints tokens and reconciles receipts. A fresh in-memory UUID is not a restart-safe mutation intent.
Native/store schema 5 (`ebd95eb`, with schema 4 and checked-conversion prerequisites) implements inert `prepared`, authorized
`commit_requested`, durable `committed` and definitive `rejected` states, with
consumer acknowledgement separate. App startup/NoteBuffer must checkpoint the
opaque token before requesting commit and reconcile receipts before acknowledging.
This file does not provide a competing intent database or migrate user vaults.


## Durable intent source (schema 5; runtime pending)

The private transport and fixture facade now expose native schema 5 intents.
The desktop wire uses snake_case identifiers; the common editor-facing wrapper
is still being negotiated. No editor or WindowBroker selection is enabled:

- `prepareIntent(clientId, exactRequest)` returns a stable opaque token/view;
  exact retries of `(clientId, operationId)` return the same prepared operation.
- `commitIntent({clientId, token})` durably records commit authorization before
  applying the stored request. The caller checkpoints the token first.
- `queryIntent(ref)` and bounded `listIntents(clientId, cursor, limit)` return
  metadata, state and receipt/error, never large plaintext bodies by default.
- `acknowledgeIntent(ref, expectedOutcome)` matches the exact committed operation
  ID/sequence or rejected operation ID/error code after durable caller recovery.

States are `prepared`, `commit_requested`, `committed`, `rejected`, with separate
`acknowledged`. Inert prepared orphans do not execute on startup. Only authorized
commit requests replay. Definitive stale-precondition errors retain their exact
request and never rebase to a newer revision. Projection pending is independent
of a durable committed receipt. Token generation is a host detail, not something
an editor derives from a mutable file path.

The fixture provides read-only `planWrite(path, bytes, options)` and
`planTextWrite(path, content, options)` before preparation. Options require an
operation ID, a new entry ID for creation, and optionally expected bytes/revision
and entry identity. The immutable JSON-serializable plan contains exact base64
bytes and the revision from one coherent path read. The future consumer must durably checkpoint this exact plan before preparation
and retain it until preparation is acknowledged; a lost prepare reply retries that plan rather
than reading a new base with the same operation ID. `prepareIntent(clientId,
plan)` durably stores it but never requests commit. Prepared orphans can be
listed and remain inert. Native storage enforces the operation identity fence.

After the consumer checkpoints the token and the broker reauthorizes the grant,
`commitIntent(ref)` executes the stored request. An intervening CLI/external
commit is rejected by native CAS without rebasing. A returned rejected view is a
terminal outcome; transport/storage uncertainty retains the checkpoint for query
and exact-token retry. The fixture does not automatically acknowledge or replay
all intents on startup: a future consumer must reconcile authorized requests
and terminal receipts. Query/list omit bytes and cannot promise current physical
projection completion. Native durable receipts remain successful when publication
is pending. Legacy writes stay gated with `durable_consumer_required`.

New source acceptance cases cover inert preparation/restart, original receipt
replay, exact acknowledgment, wrong-client lookup, retained stale-write rejection
against the actual standalone CLI, and malformed successful intent responses.
`node --test tests/core-vault-fixture-service.test.cjs` covers cursor recovery and
immutable planning; these and the real integration target remain runtime pending.

## Shared durable text-write wrapper (schema 6 source)

`desktop/durable-writes.cjs` implements the optional shared `DurableWrites`
contract. It is constructed explicitly with the fixture service and a stable
client identity; no renderer/preload/broker/startup selection is added. The
wrapper obtains `local_store_id` from the native `identity` command, never from a
caller-provided path or logical sync vault ID. Plans and refs bind this persistent
local storage authority. A folder move retains it; newly initialized replacement
storage has a different authority. A raw database copy inherently copies identity;
a future sanctioned restore/fork must rotate authority before accepting requests.

`readText(path)` and nullable `readTextById(entryId)` return current path, content,
entry ID, opaque revision and persisted stat `{ctime,mtime,size}` from one native
snapshot. Receipt witnesses expose the target entry ID/resulting revision from
the original CommitResult, not from a later read. `planWrite` requires those observed identifiers plus expected content.
Same-byte replacement or revision advancement rejects before preparation. The
existing editor must adopt this coherent read seam; separate read/stat cannot
supply equivalent evidence. This wrapper only plans existing-file text writes.

Exact provider plans are canonical JSON with base64 content and an 8 MiB UTF-8
encoded-plan cap, distinct from the private transport's 16 MiB binary limit.
The bound is checked before base64/JSON allocation. Duplicate/unknown provider
request fields, malformed base64, invalid UTF-8, ill-formed UTF-16 input and
mismatched wrapper identities fail closed. Do not reconstruct a plan after an
unknown prepare reply. The editor checkpoints the exact opaque plan first, then
the returned token before commit. Those checkpoints require an awaited strict
durable host transaction; this module does not assume localStorage durability or
implement a checkpoint store.

Native intent views expose `mutation_kind` without plaintext bodies. Query,
commit and acknowledgment reject tokens for other command kinds; unacknowledged
listing filters those commands for their separate consumers. Refs and expected
outcomes are captured before awaits and matched to returned operation/entry
identities. Enumeration is bounded to 100 pages of 100 retained records and fails
explicitly instead of returning an incomplete recovery list. Large retained
history needs native filtered enumeration before removing that bound.

Source acceptance: `node --test tests/desktop-durable-writes.test.cjs`, plus the
explicit real host/CLI target above, now cover authority replacement, folder move,
restart recovery, same-byte stale identity/revision, malformed opaque plans,
wrong-kind tokens and ref mutation across awaits. These checks remain unrun until
the coordinator grants a runtime slot with matching native schema 6 dependencies.


The wrapper now attaches `checkpoints`, backed by native checkpoint transactions
rather than a new CJS persistence layer. `scope` is the same frozen local authority
and client identity. Load/CAS return exact state bytes plus matching metadata;
list/changes expose only metadata and fixed-high-water opaque cursors. The native
store retains revision fences across tombstones and across keys within a client.
The checkpoint module dependency is `c1ed04f` (native branch equivalent `d30f76f`)
and requires schema 6 wiring; native final commit/runtime validation is pending.

Private checkpoint frames use raw UTF-8 body bytes, avoiding JSON escaping inside
the bounded header. Lengths are checked before body allocation; only checkpoint
CAS inputs may exceed the ordinary 16 MiB file limit. Success responses verify
scope, key, exact revision, byte length and exact CAS body before resolving. Invalid
successful replies stay uncertain. Checkpoint page validation checks native
sequence order, lower bounds, high water and list uniqueness; oversized pages retry
with smaller limits and the same continuation, never an advanced cursor. Store or
native I/O errors expose only stable redacted codes and uncertain outcomes.

Source fixtures now include `tests/desktop-durable-checkpoints.test.cjs`, malformed
checkpoint response/page subprocesses, and actual native/CLI restart recovery
through persisted plan, commit-ready, pending-ack and tombstone checkpoints. The
real integration target also exercises a payload above 16 MiB and verifies that
checkpoints do not create sync outbox entries. Independent source review approved
the wrapper/transport after fixing Uint8Array equality and metadata validation.
All runtime tests remain pending; no checkpoint/editor/startup path is selected.

## Fixture consumer ownership

`admitDesktopFixtureClient(service, {fixture:true, clientId, assertOwner})` is a
trusted main-process fixture initializer, not an IPC endpoint. Its canonical UUID
is fixed by the main fixture configuration across restart; each concurrent fixture
window uses a distinct UUID. Production persistent window-slot allocation remains
unfinished. The renderer cannot choose an identity or executable through this API.
The initializer returns an injected `{scope, durableWrites, assertActive, release}`
context, with scope taken from the native local storage authority.

A host `claim_client` command holds a per-client kernel advisory lock for its whole
lifetime. Permanent `.zorid/client-<uuid>.lock` inodes are never deleted on release.
The native guard verifies ownership, private permissions, link count, inode and
storage authority; symlink or changed-inode guards fail closed. Separate clients
can coexist and the standalone CLI still opens its own core independently. This
lease governs consumer recovery ownership, not whole-vault single-writer ownership.

Every host-intent and checkpoint RPC requires the exact live lease envelope and
matching client/authority. The private child checks its retained guard on every
protected call; a serialized reference alone is insufficient. The main facade
checks its captured owner/grant generation at admission and again after queue waits,
immediately before dispatch. A retired grant cannot authorize a queued commit.
`release_client` accepts exact repeated releases within the same child; child exit
releases all guards without TTL or PID guessing. Lost claim acknowledgement remains
uncertain: close the private child before retrying ownership rather than inventing
another client identity.

`release(flushGate)` blocks new external calls, drains accepted work, and passes a
temporary same-scope capability to `flushGate` for durable checkpoint/flush work.
The editor gate must use that supplied capability. Only after the gate resolves
and its accepted calls settle does the host release its lease. A failed gate leaves
ownership active; an uncertain release disables the context and permits only an
exact release retry. No automatic assumption that a failed write is clean is made:
the editor gate must reconcile/persist its pending state before resolving. This API
is not installed in Workspace, WindowBroker or preload; editor lifecycle integration
and production slot management remain separate gates.

Source verification additions: `tests/desktop-client-admission.test.cjs` covers
flush/drain, failed flush, uncertain release, superseded admission and post-queue
grant checks. Native module tests cover exclusive ownership, safe permanent inodes,
authority changes and unsafe files. The explicit real CLI/host fixture includes
duplicate-process ownership, crash/reacquire and durable checkpoint recovery. These
new tests have not yet run; source review and syntax checks are not runtime evidence.
