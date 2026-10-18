# Native WorkBlock service results

Owner: worker `term_cced0a6e-3d93-4f62-9619-76e1d885f216`, task
`task_fa2f08bc34bb`, dispatch `ctx_ac001f12b4d9`, isolated
`tingkai-c/managed-workblock-domain` branch. Source commit:
`63e2b3151fad89fec2912258a95be82b1d0abc13`; this report is a separate successor.
Root remains the sole canonical integrator. Earlier records source `8351b8e8`
and report `631dbd28` remain unchanged and are a prerequisite batch, not part of
this new service commit.

## Scope and grants

Root service grant `msg7dd7de9cf98e`, native child-module grant relayed
`msg_716e3d846eb8`, and exact helper/dependency clarification
`msg_7de2d3b2ad08` authorize the new native/host service modules and focused tests,
native lib/native child placement and export hunks, native records dependency,
promotion of existing serde_json dev dependency, corresponding isolated lock edge,
host lib command/admission/session-release/capability hunks, and the tiny
Store `managed_watermark` accessor. No host Cargo change was needed. No dependency
versions, root manifests, filesystem protocols, editor/mobile/renderer bridge
files, records domain files or earlier results were changed.

Native service uses the compiled `zorid_records::first_party` API, existing
ManagedCollection/Store journal and normal family ledger. Desktop binding worker B
received and accepted exact DTOs directly (`msg_7c6bb30b43fc`, clarification
`msg_44bd37faccd4`); its separate binding commit is `248e097f`. This service does
not include those bindings or claim their integration/runtime verification.

## Native and host behavior

`NativeVault::open_workblocks(&ClientLease)` retains a private Store-bound
collection handle, exact client lease reference, and existing enrolled family
scope. `execute_workblocks` acquires the existing native filesystem lock, verifies
paths, the real current lease, enrolled realm/vault and Store capability on every
command. No renderer namespace/schema/owner or new enrollment identity is accepted.
The host keeps one private session per admitted client and drops it on release;
handles and storage continuations are never serialized. Unsupported platforms keep
common DTO types plus explicit Unsupported methods; host-only tests are gated to
macOS/Linux. No cross-target execution was performed.

Supported semantic commands: create, read, move, title, add_ref, remove_ref, delete,
window and changes. Ranges remain canonical decimal milliseconds with IANA zone;
all domain validation is compiled Rust. Reference linking accepts structural core
EntryIds without a note-existence check. Read returns every recoverable range/title
candidate, task refs and opaque managed revision; absent/deleted records return a
structured result with revision, created/deleted flags and null block. Existing
unresolved metadata is preserved as status-to-canonical-count map, not inferred
update identities.

Create derives the original empty-state witness from exact private scope+target,
so response-loss replay after later writes or process reopen returns the original
Store receipt. Mutations retain the caller's original opaque expected revision;
remove_ref reuses its original history command and observed tags when the operation
already exists, then Store's durable request journal still decides exact replay,
target/witness matching and collisions. Replaying removal does not remove a later
re-addition. No new replay journal/outbox or alternate storage is introduced.

Window reads validate a maximum 31-day half-open interval and limits 1–64 scanned
records / 1–1,048,576 bytes of serialized storage snapshots. Native managed_export
retains its existing 64-record / 4 MiB maximum; this service requests one storage
row at a time and never advances past a row excluded by its requested byte budget.
Filtering includes any intersecting conflict range. Empty filtered pages can still
carry continuation, and deleted/filtered records consume scan budget.

The private continuation binds query, budgets, current lease/session, last consumed
key and collection change watermark. At most eight tokens are retained per session;
expired/foreign tokens fail explicitly. Before and after each page, fresh managed
changes are checked against the captured watermark. Changes between independent
clients invalidate continuation with window_changed. This is a fenced bounded
scan, not a retained SQLite snapshot. Store managed_watermark is a narrowly
handle-authorized max(sequence) query in a transaction; no global export limit or
sync cursor semantics changed. No network I/O occurs under the local lock.

## Transport contract

Existing lease envelope carries:

```json
{"method":"workblocks","client_id":"<admitted client>","request":{"schemaVersion":1,"command":{"op":"read","record":"<id>","generation":"<id>"}}}
```

Request binary body is empty; request DTO is bounded to 64 KiB. Other op fields:

- create: record, generation, operation, range, optional title.
- move: record, generation, operation, expectedRevision, range.
- title: same target/operation/witness, required title (string or explicit null).
- add_ref/remove_ref: same target/operation/witness, task (core EntryId).
- delete: target/operation/witness.
- window: fromMs, untilMs, limit, byteLimit, optional cursor.
- changes: after, limit.

Epoch milliseconds and sequences are strings. expectedRevision is the existing
opaque 32-byte array representation, preserved unchanged. Success header metadata
is `{workblocks:true,schemaVersion:1,bytes}` with UTF-8 JSON binary body
`{schemaVersion:1,op,value}` capped at 4 MiB. Window value contains blocks, cursor,
incomplete, watermark, scanned and bytes. Mutation value is the existing
operation/revision/sequence receipt. Error codes distinguish invalid input,
stale_revision, operation_collision, stale_session, window_changed, cursor_expired,
limit and storage failure; potentially uncertain storage/response failures retain
commit_uncertain and original operation/witness retry guidance. No registration
endpoint or collection capability crosses this transport.

## Observed checks

Checks ran offline with `-j1` on this host; local resource use was coordinated with
F's short Task check. No iOS/Xcode build or test app was opened. Existing unrelated
Store/Bases/native warnings remain; this work does not claim to fix them.

1. Initial native target: 4/4 passed.
2. First combined run: actual stdio process test passed; embedded-host test failed
   because its malformed-field assertion expected a framed error, while the
   existing EmbeddedHost intentionally returns an I/O decoding error before
   dispatch. The test now asserts that rejection directly; production validation
   was not relaxed. That failed run stopped before its native test target.
3. Final exact source:
   `cargo test -p zorid-native -p zorid-desktop-host --test workblocks --offline -j1 -- --test-threads=1`
   exited 0: host 2/2 and native 5/5 passed.
4. `git diff --check` passed. Frozen records/report paths unchanged from `631dbd28`.

Final host tests:

- actual_stdio_process_creates_and_reopens_without_network
- admitted_semantic_host_replay_release_reopen_and_strict_envelope

Final native tests:

- durable_create_replay_after_changes_and_reopen_preserves_original_receipt
- invalid_range_empty_read_and_replaced_lease_never_bypass_checks
- move_delete_reopen_and_cross_vault_capability_are_fenced
- observed_remove_exact_replay_does_not_erase_later_readdition
- window_continuation_retries_and_invalidates_on_collection_change

The process test starts the actual desktop-host executable twice, initializes its
normal local scope, claims a client, creates/reads a block, closes the first child,
reopens, retries the same create and verifies identical receipt and durable content.
A 20-second watchdog and cleanup guard terminate owned children on failure.
Native tests additionally cover independent NativeVault/client mutation between
window pages, changed-query rejection, byte-limit rejection, empty filtered page
continuation, invalid ranges/no authored echo, missing-title rejection, stale CAS,
reference re-addition preservation, deletion/reopen and cross-vault/session fences.

## Review and remaining gates

Independent reviewer R reported no remaining source blocker on the service and
requested exact committed SHA approval (`msg_d4821724f0cf`); the final required
nullable-title guard and corrected assertion were separately sent for final review.
Exact-hash approval is relayed to the coordinator independently before integration.

This is native library and actual stdio service evidence. It does not prove
assembled Electron bindings, normal Tasks/calendar UI, browser/WASM activation,
mobile operation, encrypted multi-client convergence, or reference parity. Root
must compose the records prerequisite, this service and separately reviewed desktop
binding, then perform the planned actual Electron scheduling/reopen verification.

Local raw final compiler/test log: `/tmp/zorid-workblocks-native-host-tests-final.log`; SHA-256 `b4736ca7d9e5d3376d7c4ba5d87220bb1bba47197a352b7e37ba93e733fa327f`. The named test output above is retained here; the temporary raw log is machine-local.
