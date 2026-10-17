# Rust/WASM boundary fixture

This fixture executes the real `zorid-crdt` and `zorid-core` crates in a browser
module worker. It creates and merges binary CRDT updates and executes the Rust
mutation planner through a JSON boundary. There is no native process, duplicate
JavaScript planner, database, sync backend or editor involved.

## Build and run

Use the same rustup toolchain for Cargo and the installed WASM standard library.
Toolchain installation/builds need the coordinator's shared-machine build slot:

```sh
rustup target add wasm32-unknown-unknown --toolchain stable
cargo +stable install wasm-bindgen-cli --version 0.2.129 --locked -j 1
PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN=stable prototypes/core-wasm/build.sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory prototypes/core-wasm
```

Open `http://127.0.0.1:8766/`. The worker runs all checks; the page displays its
result and exposes `window.__zoridWasmResult` for browser automation. The worker
is terminated after completion. Stop the fixture HTTP server after testing.
No npm install, CDN or app bundle is required. Generated `pkg/` is ignored.

`CARGO` and `WASM_BINDGEN` may specify executable paths; `CARGO_TARGET_DIR` may
override the isolated build directory. The script requires matching
`wasm-bindgen` library/CLI version 0.2.129. Native helper tests can be run with:

```sh
cargo test --manifest-path crates/zorid-wasm/Cargo.toml -j 1 -- --test-threads=1
```

[Official runtime version](https://docs.rs/wasm-bindgen/0.2.129/wasm_bindgen/)
and [official web target deployment guide](https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html).
The `web` target generates browser-loadable ES modules without another bundler.

## Browser host integration seam

Import from `../core-wasm/pkg/zorid_wasm.js` inside the browser-storage worker and
call the default async initializer once. The generated class provides:

```js
const doc = new WasmTextReplica(actor); // Unique uint32 fixture actor.
doc.apply(storedSnapshot);             // Uint8Array of v1 Yrs/Yjs update bytes.
const before = doc.stateVector();
doc.insert(0, 'hello');                // UTF-16 positions, checked in Rust.
const state = doc.snapshot();
const outgoing = doc.changesSince(before);
// Host transaction conditionally persists state + outgoing + operation receipt.
// Only after commit may the host report a durable save.
doc.free();
```

`delete(index, length)`, `text()` and `stateVector()` complete the text surface.
Numbers are checked before conversion to Rust u32, avoiding silent JS wraparound
or fractional truncation. Locally splitting a surrogate pair is rejected. JS
strings crossing a UTF-8 Rust binding cannot represent lone surrogate code units;
this is not a lossless arbitrary-binary/text-file API.

`validatePath(string)` returns the unchanged valid logical path. The planner:

```js
const changes = JSON.parse(planMutation(JSON.stringify({
  request: {
    operation_id: 'op-create',
    mutation: {
      type: 'create', id: 'file-1', path: 'photo.custom',
      kind: 'file', content: [0, 255, 128]
    }
  },
  entries: [], // Complete, current transaction metadata, including tombstones.
  next_revision: 'rev-1' // Host allocates a fresh durable revision.
})));
```

This returns `EntryChange[]` metadata only. The host must atomically persist all
changes, payloads, journal/outbox and receipts; planning does not perform a save.
Run idempotency lookup and revision allocation in that same storage transaction.
Do not plan against a stale renderer snapshot and later write it unconditionally.
The current single-key IndexedDB fixture does not establish multi-entry planner
atomicity. Do not reuse its single-record test as evidence of folder safety.

Errors throw strings: domain failures are JSON-serialized `ContractError` values;
malformed JSON/bytes and invalid numeric inputs carry descriptive strings. This
is an experimental boundary rather than a frozen production error contract.

## Limits

These are bounded compatibility/error fixtures, not hostile-input safety or
resource-limit guarantees. The legacy replica groups exchange raw unencrypted
CRDT bytes. The current-family groups use disposable keys and authenticated
encrypted envelopes entirely in memory; they do not exercise durable storage,
relay transport or account enrollment. Actor allocation remains fixture-only.
State-vector equality cannot establish no changes (deletions do not advance it).
No browser persistence, crash safety, real editor undo/IME/selection, Safari or
Firefox claims follow from this worker fixture alone.

## Actual native ↔ browser exchange

The independent native and browser tests above are not cross-target evidence.
`exchange-server.mjs` adds a round trip using the existing native Rust example
executable and the real WASM module in a browser worker:

```sh
# In the integrated workspace, after the coordinator grants a build slot:
cargo build -p zorid-crdt --example interop -j 1
# Build pkg/ using build.sh above if not already generated from current sources.
ZORID_CRDT_INTEROP_BIN="$PWD/target/debug/examples/interop" node prototypes/core-wasm/exchange-server.mjs
```

Open the exact localhost URL printed by the server (it includes a per-run fixture
token). The page exposes `window.__zoridCrossTargetResult`; the server prints the
final verification result and stops automatically after completion. It fails and
stops after five minutes without completion. `ZORID_EXCHANGE_PORT=0` asks the OS
for a free port; default is 8768. No npm dependencies are added.

The native executable creates a seed and two dependent offline updates. Browser
WASM independently edits the seed, then integrates native updates out of order
and duplicated. The browser exports its own two dependent updates; native Rust
receives those out of order and duplicated, compares text, and reconstructs the
browser snapshot. Both directions also deliver deletion-only updates before the
seed they delete from, despite unchanged insertion state vectors. The committed
Yjs13 fixture is replayed by both targets. Native then edits the merged document
and returns a delta plus snapshot to browser WASM; its final exported snapshot is
reconstructed once more by native Rust before reporting success.

This fixture is source-only until an actual browser run completes. A Node-hosted
WASM run, two separately passing suites, or successful HTTP serving must not be
reported as this browser/native exchange passing. Its local HTTP endpoints are
a test driver, not the E2EE sync backend. It proves neither durable storage nor
real editor interactions, filesystem operations or production protocol safety.

## Rust idempotency binding for storage adapters

`checkIdempotency` validates the same Rust `MutationRequest` and
`RecordedOperation` types used by native storage:

```js
const decision = JSON.parse(checkIdempotency(JSON.stringify({
  request,
  record: storedOperation ?? null
})));
if (decision.status === 'replay') {
  return decision.result;
}
// status === 'new': allocate revision, plan and commit atomically.
```

Read `storedOperation` by the request's operation ID **inside the same write
transaction**, before checking the current target revision. Exact retries return
the original receipt even when the entry has since changed. Never treat a missing
record caused by an I/O/lookup error as `null`. The wrapper performs no lookup,
authorization, revision allocation, commit or retention decision of its own.

A record has `{request: MutationRequest, result: CommitResult}`. `CommitResult`
contains operation ID, positive decimal-string sequence and the metadata changes.
Unknown fields, invalid nested requests and malformed sequences are rejected.
The Rust contract rejects mismatched request bytes, mismatched operation IDs and
structurally invalid receipts. A sequence greater than JavaScript's safe integer
range remains a string through JSON and WASM; never convert it to `Number`.

The browser fixture checks new/replay outcomes, replay after a later move, altered
binary payload, incorrect operation ID, empty changes, unknown fields and numeric
sequence rejection. Native helper tests cover the same binding serialization.
These added checks require rebuilding the WASM package before running the page;
source changes alone are not new browser evidence.

## Trusted-host crypto binding and native/browser exchange

`generateKey()` returns a `WasmVaultKey` using the browser's platform CSPRNG through
`zorid-crypto/web`. `new WasmVaultKey(bytes)` imports exactly 32 bytes; `.free()`
drops its zeroizing Rust key. `.exportSecret()` explicitly copies the secret to
JavaScript for trusted-host enrollment/recovery. These are not plugin APIs.

`key.seal(headerJson, plaintextBytes)` returns the bounded binary envelope;
`key.open(expectedContextJson, envelopeBytes)` returns plaintext bytes. Context
fields are `realm_id`, `vault_id`, `update_id`, and positive `key_epoch`. They must
come from independently authorized host state, not be copied wholesale out of the
incoming header. Unknown context fields and unsupported required header semantics
fail. Header/envelope bounds and document version checks reuse the existing Rust
protocol/crypto implementation. No cryptographic primitives are implemented here.

Rust checks input sizes before parsing/decrypting. wasm-bindgen may already have
copied JS strings/byte arrays before the method begins, so the trusted host must
bound arguments before calling; this is not adversarial-JavaScript allocation
isolation. Input key transfer allocations are cleared after importing. Exported
keys, returned plaintext, JS strings/structured clones and generated binding
transfer allocations are not guaranteed erased by freeing a Rust handle. This
fixture does not implement secret persistence, enrollment UX or recovery UX.

After obtaining the coordinator's build slot:

```sh
cargo build -p zorid-crypto --example crypto-interop -j 1
# Rebuild core-wasm/pkg using build.sh, including the new crypto exports.
ZORID_CRYPTO_INTEROP_BIN="$PWD/target/debug/examples/crypto-interop" node prototypes/core-wasm/crypto-server.mjs
```

Open the printed token-bearing localhost URL. The native helper generates a
**disposable** key and seals two independent updates. A real browser worker opens
them, checks tampering/context/key failures, generates its own key and seals two
updates which the native helper opens and adversarially checks. Native/browser
keys and sampled nonces come from their actual system entropy APIs; observing
distinct samples is a smoke check, not a statistical randomness proof.

Fixture keys cross a trusted loopback test-harness connection as explicit
out-of-band enrollment; this test HTTP server is **not** the encrypted relay.
The native helper receives requests through stdin and returns protocol data
through captured stdout, including explicit fixture key generation. The Node
harness never logs those secret-bearing requests/responses or decrypted payloads.
Only pass/fail labels and browser metadata are printed/displayed. The final result
is available as `window.__zoridCryptoResult`; the server stops on completion or
five-minute timeout. `ZORID_CRYPTO_PORT=0` selects a free port (default 8769).

Tests cover binary bytes and Unicode, native seal/browser open, browser
seal/native open, tampered header/nonce/ciphertext/tag, wrong key and every
independent context field, malformed/oversized input and invalid key lengths.
The script is source-only until a real browser run completes. A compiled WASM
module or native-only roundtrip is not cross-target evidence. No real vault,
backend sync, account isolation, stored keys, recovery or security certification
is established by this fixture.

## Current-format synchronous sync planning

The new bindings require text-v2 and file-v2 plus the shared portable transport
codec. Root verified native tests and a pinned WASM build at `f79a294`, then
Chrome passed ten worker groups with fixture `6f3ade8`. Subsequent file-intent
canonicalization and namespace-metadata strengthening require their own rerun;
that earlier result does not verify new source. These are trusted-host APIs, not
plugin capabilities.

- `createEmptyTextState({identity,version})` creates JSON for an agreed empty
  text bootstrap. The input is a JSON string. The host still verifies empty
  content, stable identity and matching namespace binding atomically.
- `materializeTextState(stateJson)` validates persisted text state and returns
  its UTF-8 bytes.
- `planTextReplace(inputJson, desiredBytes)` returns an opaque
  `WasmAuthoredTextPlan`. Input fields: `state`, `namespace_state`, `request`
  (shared `AuthorRequest`, empty edits), `namespace` (shared v2 context), and
  `next_namespace_version`.
- `key.planReceivedText(contextJson, inputJson, exactWire)` returns an opaque
  `WasmReceivedTextPlan`. Independently selected context has realm/vault/update
  IDs and key epoch. Input fields: `state`, `namespace_state`, `request` (shared
  `ReceiveRequest`), `next_namespace_version`, `prior` and `cursor`.
  Authentication, strict v2 decoding and BOTH domain planners execute in Rust;
  there is no JavaScript constructor for authenticated plaintext or activities.
- Both handles provide `resultJson()` with `{text, namespace:{next_state,view}}`
  and `checkPreconditions(actualJson)`. Author checks require `state`,
  `namespace_state`, `update_id_unused`; receive checks require `state`,
  `namespace_state`, `prior`, `cursor`. Call against values read inside the same
  IDB transaction; free the handle afterward. Returned bytes/state are plans,
  never a durable-save acknowledgment.

The host must commit text state, namespace state, common exact-wire ledger,
receive cursor, bytes/recovery visibility, revisions, receipts and journal in one
transaction. The common family ledger may contain non-text updates: the host must
reject ID collisions against that entire ledger, not merely supply a missing text
record. Namespace view decides publication/recovery/deletion; merged text alone
must never resurrect a tombstone. Missing dependencies must follow the shared
family pending policy rather than advancing a cursor without retaining the wire.
These bindings do not implement physical external-edit baseline imports.

`decodeSyncHello(expectedJson,rawBytes)`, `decodeSyncAccepted(expectedJson,rawBytes)`
and `decodeSyncPage(expectedJson,rawBytes)` delegate to the portable Rust response
codec. Expected fields are respectively `{realm_id,server_epoch}`,
`{vault_id,update_id,server_epoch}`, and `{server_epoch,after,through}`.
`encodeSyncCursor({server_epoch,after})` returns canonical cursor JSON. Pass JSON
strings for those inputs and decimal strings for log positions. Pass raw response
bytes without JavaScript parsing so duplicate-field rejection is preserved.

Inputs are capped before Rust parsing (32 MiB state envelope; protocol control
limit for transport context); UTF-8 edits retain the shared 256 KiB text cap and
wire bytes retain the protocol cap. Serialized output is bounded while writing
at 64 MiB. These bounds can explicitly reject larger graphs: this is not evidence
of arbitrary-size vault support or optimal performance. wasm-bindgen may allocate
argument transfer memory before Rust runs; the worker must enforce bounds before
calling. No network waits or asynchronous crypto belong inside IDB transactions.

For common-family ingestion, use `key.openSyncUpdate(contextJson, exactWire)`.
It returns an opaque `WasmSyncUpdate` only after Rust authentication and strict
current-format family decoding. `metadataJson()` returns the native ledger shape:
`{key:{realm_id,vault_id,update_id},family,format_version,payload_digest,payload_bytes,
text_binding}`; text_binding is null or `{entry_id,text_bootstrap_id,namespace}`. The namespace
contains the exact strict text payload bootstrap and parent frontier. `exactWire()`
returns the authenticated bytes. Its `planText(inputJson)` uses the receive input
above; `planFile({state,prior,next_version})` returns `WasmReceivedFilePlan`.
A handle has no JavaScript constructor, and cannot be reconstructed from JSON.
Wrong-family planning fails. The host may derive a missing text bootstrap from
authenticated metadata for pre-Create staging, but must retain pending namespace
state and prohibit publication until graph dependencies arrive.

File helpers: `createEmptyFileState({scope,version})`,
`inspectFileState(stateJson)` and `materializeFile(stateJson,manifestJson)` return
JSON. Materialization returns an array of bytes or null for missing chunks;
empty bytes remain distinct. This JSON binding rejects files exceeding its bounded
output capacity before materialization, so large-file streaming remains required.
`planFileMutation({state,payload,next_version})` yields `WasmAuthoredFilePlan`.
Its result is `{namespace:{next_state,view},payload,payload_bytes}` and precondition
input is `{state,update_id_unused}`. A received file plan returns
`{namespace:{next_state,view},received_record}` and checks `{state,prior}`.
Use JSON strings for all brace-notation arguments. File receive has no separate
cursor; the host's one common ledger/cursor transaction governs every family.

Both authored plan handles also provide `metadataJson()` for the same common
ledger shape, with digest computed synchronously in Rust from the planned exact
payload. `WasmSyncUpdate.matchesPayload(bytes)` compares exact authenticated
plaintext bytes for seal-winner validation without asynchronous WebCrypto or a
second JavaScript payload decoder. Semantic JSON equality is insufficient.

Every successful plan additionally limits each persisted text/namespace state to
8 MiB of serialized JSON, checked with a counting writer before returning the
handle. Two such states plus a bounded prior wire and request fit the 32 MiB input
envelope on subsequent calls. This explicit fixture vault limit prevents saving
an output that cannot be passed back to the binding; it is not an arbitrary-size
vault claim. A received duplicate with retained text receipt but missing namespace
activity is rejected as inconsistent atomic history, rather than silently repaired.

`validateAuthoredSyncPayload(metadataJson,payloadBytes)` checks retained local
intent metadata, exact length/digest and strict current-family payload semantics.
It returns no authenticated capability. `validateSyncWire(metadataJson,wireBytes)`
checks only bounded framing and realm/vault/update identity consistency while the
key is locked. It cannot validate AEAD, encrypted family/digest or independently
authorized key epoch. A tampered tag can pass this framing-only check and must
still fail `openSyncUpdate` before received state changes.


`encodeFilePayload(rawJson)` strictly decodes current file-v2 plaintext and returns
canonical bytes. Use it to compare a retained authored intent on exact retry before
calling a graph planner that correctly rejects reuse of an existing update ID.
Unknown fields, duplicate fields and old format versions fail. It does not create
a plan, activity or authentication capability. Text ledger metadata includes the
strictly derived namespace context; retained activity parents/bootstrap must match
that witness as well as entry identity, payload digest and byte length.

`materializeRetainedFile(stateJson, entryIdentityJson, contentEventId)` validates
historical binary content with the shared Rust file-v2 helper. Identity JSON must
contain exactly `{entry_id,bootstrap_id}`; the event ID is a plain string. Rust
derives the manifest from the resolved retained Create/SetContent event, validates
immutable binary mode and exact identity, and checks page/chunk/content digests.
The returned JSON is bytes or null: null means unavailable dependencies, while
`[]` is a verified empty file. Retained bytes do not authorize current-path
publication. State/control input caps apply, and the shared bounded helper rejects
oversized expanded output before allocating it. This source addition requires a
new native/build/browser verification gate; previous fixture evidence excludes it.
