# Native retained-source Tasks query binding

Owner F: `term_ef51c268-5804-46f1-b07c-f634a3c318a7`, task
`task_ae28d6f0ea84`, dispatch `ctx_f5e664da3636`; isolated branch
`tingkai-c/managed-firstparty-consumer-contract`. Accepted domain prefix through
`fc711906` remains unchanged. New source/tests freeze:
`e666ee67f201509cd36440dd03da9a7f4d2ed4ed`.

The managed-data coordinator relayed named root grant `msg_285fa432fce5` in
`msg_e473b381ade0` for the exact native document, host Documents-channel, CJS
semantic codec and optional core/desktop semantic transport seams. Canonical
integration remains with `term_2fbd0185-6f86-4649-824c-92faf46852f7`; the coordinator
assembles in isolation. No main mutation or push occurred.

## Delivered behavior

`NativeVault::query_task_documents(pin, type_ids, options)` now returns an ordinary
`DocumentQueryResult<DocumentTasksResult>` on the existing retained pin. Caller IDs
are selectors, never source authority or renderer-provided AST. For every selected
Type, it reads actual retained projection bytes and EntryState/witness through
`Store::read_document_projection`, then compiles/query-checks against the same
immutable generation. It rechecks native path safety and pin retention on final
result delivery. Live Type/note changes cannot substitute current bytes into an
older pin. Missing, foreign, expired or unavailable source/pin reads fail closed.

Inputs are bounded to 128 distinct selectors, 256 KiB per Type source and 1 MiB
aggregate source bytes before parsing. The existing Store projection read has its
own 16 MiB eligible-text ceiling; this slice does not introduce a streaming source
reader or change Store limits. The bases helper `compile_type_yaml` reuses public
`zorid_document::parse_yaml_mapping`, with no new parser, Markdown framing or JS
evaluator. Invalid YAML retains its exact source witness and shared YAML diagnostic
in the registry; it yields no typed definition or capture defaults. Original files
are never written by this query path.

The shared decoder's existing bounded benign-alias/core-tag semantics remain in
force; the previously delivered TS Type configuration editor is deliberately
stricter about aliases/explicit tags. This query slice does not claim their lexical
acceptance policies are identical or change the document parser. Unsupported or
semantically invalid Type configurations continue to produce domain diagnostics.

Result fields:

- `definitions`: actual selected pinned EntryStates, in selector order.
- `types`: validated task-capable summaries with definition witness, stable Type
  ID/label, mapped status/date properties/options and explicit exact-key capture
  default pairs (including present nulls). These are data for a future admitted
  capture command, not filesystem write authorization.
- `result`: existing Rust Task query snapshot, Type witnesses, rows/groups,
  diagnostics, coverage and truncation. Outer envelope coverage remains the pinned
  document generation coverage; nested Task coverage additionally reflects invalid
  Type configuration/metadata. Invalid configuration can therefore return outer
  true and nested false without changing pin identity.

Selected IDs define the query's configuration set. This slice does not discover
or install all vault Types; the real UI must supply its captured Type inventory and
honor diagnostics. It does not convert checkboxes, mirror tasks into managed
records, or mutate note status/deadlines when querying.

## Existing desktop channel and lifecycle

`crates/zorid-desktop-host/src/documents.rs` adds `Tasks` inside the existing
Documents channel; no host `lib.rs` or native `native.rs` edits. Requests contain
only `pinId`, `typeIds` and typed filter/clock/timezone/showDone/maxRows options.
Existing admitted client/lease and per-client pin selection remain authoritative.
Unknown fields/AST are rejected by the typed frame parser; the normal CJS codec
rejects them before sending any frame.

Omitted clocks are captured **once in native TaskOptions**. Explicit zero/custom
safe integer clocks never read the host clock. This differs intentionally from
the existing Base wrapper's caller-side `Date.now` default; Tasks carries omission
through the optional transport and tests that policy explicitly. UTC, All,
showDone=false and maxRows=1000 are native defaults.

`desktop/document-semantics.cjs` captures bounded known request fields and checks
response source/snapshot, definition witnesses, Type identities, row/group scope
and bounded shape. Rust remains the semantic validator. The desktop TS binding
routes Tasks through its existing pending-call/release drain. Core `DocumentPin`
and `DocumentTransport` gain an optional `tasks` method; transports without it
return pins without that method. Browser/mobile selection is unchanged, and there
is no Base/JS fallback pretending to execute Tasks. Core rejects closed/mixed-pin
results and copies selector/options data before asynchronous calls.

Only granted source files changed: bases `types.rs`, native `document_api.rs` /
`document_index.rs`, host `documents.rs`, CJS `document-semantics.cjs`, core
`document-semantics.ts`, desktop `desktop-document-semantics.ts`. New focused tests
are separate files. No root manifest/lock, host `lib.rs`, native `native.rs`,
WorkBlock bindings/admission hooks, Workspace, NoteBuffer, mobile, WASM or UI files
changed.

## Focused evidence

Existing official toolchain and shared cached target, offline, serialized `-j1`:

```sh
# For each cargo invocation:
# RUSTC=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/rustc
# RUSTDOC=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/rustdoc
# CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified
# cargo=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/cargo
cargo test --offline --locked -j1 -p zorid-bases --test task_yaml
cargo test --offline --locked -j1 -p zorid-native --test task_documents
cargo test --offline --locked -j1 -p zorid-desktop-host --test task_documents
cargo test --offline --locked -j1 -p zorid-desktop-host --lib tasks_clock
node --test --test-concurrency=1 tests/task-document-binding.test.ts tests/desktop-document-semantics.test.ts tests/desktop-document-semantics.test.cjs tests/document-base-defaults.test.ts tests/document-base-context-options.test.ts
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --allowImportingTsExtensions --skipLibCheck src/core/document-semantics.ts src/platform/desktop-document-semantics.ts
git diff --check
```

**PASS: bases YAML 3, native query 4, actual framed host process 1, host clock 1;
Node 17 (6 new + 11 existing), scoped TypeScript and whitespace.**

Native tests prove actual pinned Type bytes/revisions plus saved note state survive
live writer changes, new pins see new Type labels/status, invalid YAML returns
witness/diagnostic without a typed summary, missing/duplicate/oversized selectors
fail, source byte limits reject with exact selected bytes retained, and foreign or
rebuild-expired pins fail. The real framed stdio process test exercises client
leases, retained-source query, another client's foreign pin rejection, external
writer changes, close/rebuild expiry and raw malformed-frame rejection. It spawns
the actual built Rust host with disposable fixture files, not a mocked engine or
Electron renderer.

The first host fixture run failed with UnexpectedEof because it expected a
recoverable error for an unknown extra AST field. Existing protocol intentionally
terminates on malformed typed frames. The fixture now runs normal valid queries
first and asserts exact process exit code 1 for the forged frame last; normal CJS
rejection is tested independently. No protocol validation was weakened. Final host
run passes; its expected termination message is not an omitted application error.
Native initially passed 3 checks, then the final added source-limit case passed in
the 4-check run. Existing crate dead-code/unreachable warnings remain unchanged.

Final local logs:

- `/private/tmp/zorid-task-query-bases.log`
- `/private/tmp/zorid-task-query-native-final.log`
- `/private/tmp/zorid-task-query-host-final.log`
- `/private/tmp/zorid-task-query-clock.log`
- `/private/tmp/zorid-task-query-node-final.log`

Owned host/watchdog/temporary fixture resources exited and cleaned up. Compiler
and shared binary were released to the coordinator in `msg_1013ca26795a`; no later
builds or shared binary mutations by F. No installs, network, full suites, iOS,
simulator or Electron app runs occurred in this dispatch.

Independent T review at `ctx_c9f6c07276c3` approved exact source
`e666ee67f201509cd36440dd03da9a7f4d2ed4ed` with no blocking findings in
`msg_0f0280a8ed9d`. T independently reran focused Node15/15 and inspected the
final Rust9 and Node17 logs without duplicating builds. Its early coverage concern
was withdrawn after checking frozen `query_tasks`, which already includes registry
configuration diagnostics in nested coverage. This approval is scoped source
acceptance, not product/native UI acceptance.

## Remaining delivery

This is a real native/stdio query binding and source-validated DTO, not usable
Tasks product UI or normal Electron interaction acceptance. Next owners can
connect a captured Type inventory, preset creation, task capture/status/date edits
and Tasks/Base views through the existing durable save route. Capture must
revalidate source witnesses and current admission before committing; returned
capture defaults alone do not authorize writes. W/B WorkBlock service/binding and
Calendar UI remain separate owners. The coordinator's composed build/Electron pass
must revalidate the integrated behavior; this isolated process test is not that
assembly, sync convergence, browser activation, mobile shell or native UI proof.
