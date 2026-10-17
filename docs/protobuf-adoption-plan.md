# Protobuf adoption foundation

Owner: `/root/protobuf_schema_sol`. Branch: `tingkai-c/protobuf-schema-foundation`.
Worktree: `/Users/ctk/orca/workspaces/Zorid/protobuf-schema-foundation`.
Base: `454e955`. Main integration belongs exclusively to the root coordinator.
Status: narrow foundation implemented and independently source-reviewed in isolation;
focused host/TypeScript/reproducibility checks pass. Not integrated; no runtime
codecs changed. WASM compilation is unproved because the local target is missing.

## Scope and contract

The user chose protobuf on 2026-10-17. This slice establishes a single IDL with
standard generated Rust and TypeScript binary messages. It does not select gRPC,
change transport, implement client adapters, or activate a new sync wire format.
Markdown, YAML, settings and human-facing CLI output retain their formats.
JS worker hops can transfer existing typed arrays without another encoding pass.

Proposed packages:

- `zorid.common.v1`: scope, immutable entry identity, manifest/page/chunk metadata.
  Existing IDs and revision tokens remain strings, validated by their domain types.
  SHA256 values are raw bytes checked to be exactly 32 bytes by consumers.
- `zorid.stream.v1`: owner-bound stage/read locators, explicit Create or Write
  targets and bounded stage/read requests/results. Locators are ordinary untrusted
  data resolved by the owning store under admitted client/operation authority.
  No generated type represents a private verified content or sealed-stage proof.

`uint64` becomes Rust `u64` and TypeScript `bigint`; adapters using existing JSON
contracts must explicitly convert canonical decimal strings without JS numbers.
The current 128 KiB append/read limit and 64 MiB initial file cap are consumer
validation policy, not promises made by protobuf decoding. Bound framed input
before decoding/allocation; validate message presence, oneofs, enums, identities,
lengths, causality, ownership and supported required features before acting.
Unknown protobuf fields are not a feature-negotiation mechanism. Missing or
unknown command alternatives and unknown required semantics fail closed.

## Generation proposal

Use pinned Prost/prost-build 0.14.4 and matching Protobuf-ES runtime/generator
2.16.0. Checked-in generated sources let ordinary app and crate builds run without
protoc. An explicit generator tool uses standard prost-build and a pinned
protoc-bin-vendored binary, then invokes local protoc-gen-es for the same IDL.
The system Homebrew protoc is unusable here (missing abseil dylib); do not repair
the user's system install as part of this work. No hand-written protobuf codec.

Focused checks: regenerate into a temporary directory and compare exact generated
sources; focused Rust/TypeScript golden binary interop for bytes, uint64 above
2^53 and oneof presence; malformed/truncated messages and unknown required
features at a deliberately separate validation boundary. No broad app suite or
build runs without the root's serialized heavy-build slot.

Sources consulted 2026-10-17:
[Prost primary documentation](https://github.com/tokio-rs/prost),
[prost-build configuration](https://docs.rs/prost-build/0.14.4/prost_build/struct.Config.html),
[Protobuf-ES setup](https://protobufes.com/getting-started/),
[Protobuf-ES environment options](https://protobufes.com/reference/environments/).

## Sync schema mapping for separate root review

This is a field inventory, not frozen IDL or permission to replace current codecs.
The existing files-v2 and text-v2 JSON plaintext remains unchanged until an
explicit new document/family/envelope format and required-feature policy is agreed.
No same-version trial decoding, hidden fallback or migration of real vaults.
Fresh disposable fixtures are allowed by the user; deleting real data is not.

| Current source | Proposed typed mapping | Constraint retained |
| --- | --- | --- |
| sync-protocol HeaderFields | envelope_version, purpose, suite, realm/vault/update/device IDs, key_epoch, document_format_version, required_features | Exact received header bytes remain AEAD AAD; parsed header is untrusted before authentication |
| optional_extensions JSON map | Review a typed informational extension list or omit in a fresh format | Never wrap JSON as protobuf bytes; no authorization or correctness semantics in optional fields |
| files-v2 Payload | family/version, Scope, UpdateId, body oneof | Explicit new format; no mutation of files-v2 encode/decode |
| files-v2 Body | Events, ObservedDelete, ChunkPage, raw Chunk bytes | Bounded events/parents/pages/chunks; observed-delete remains distinct |
| EntryEvent/Effect | immutable identity, parents, Create/SetContent/Move/Delete/Restore oneof | Existing bootstrap, binding, antichain and namespace validation remains outside generated types |
| ContentSeed | Binary Manifest or Text bootstrap/format oneof | No mode conversion or guessed identity |
| text-v2 Payload | family/version, TextIdentity, TextNamespaceContext, ActorRegistration, raw Yrs update bytes | Yrs update framing and actor/namespace checks preserved |
| transport Cursor/Accepted | epoch, uint64 position, IDs, required features | Authenticated-channel/durable receipt authority is not established by parsing |

Protobuf is not canonical serialization. Persist/hash exact accepted plaintext
and exact header/wire bytes; never reconstruct an authenticated commitment by
re-encoding a generated semantic message. Unknown field retention differs between
runtimes and cannot supply exact-byte provenance. The relay stays opaque to E2EE
payloads; schemas add no crypto, authentication or RPC protocol.

## Evidence and handoff

Implemented: IDL, checked-in standard generated Rust/TypeScript, pure no_std crate,
pinned development tooling/locks, binary fixtures and focused interop tests.
Reviewed: root approved narrow proposal; independent schema and lock reviews pass.
Integrated: none. Verification details below.
Dependencies: portable candidate/ref APIs (`desktop_default_sol`), store stage/
receipt/read freeze (`package_sol`), desktop/browser consumer plans. Runtime
activation, schema version rollout and native/mobile behavior are separate work.

Read-only Store freeze checked at `277adb0`: target/locator/chunk receipt match
`blob_stage.rs`. Status includes `seal_requested` and response-only finalized
manifest diagnostics. Terminal receipt/rejection and pinned read APIs are forward
contracts awaiting implementation; no generated type activates them. Explicit
resume resolves owner+operation when begin acknowledgement was lost.

Additional crypto gate: if headers migrate, retain the exact authenticated header
bytes or define a separately reviewed canonical AAD independent of protobuf
encoding. Never re-encode an embedded header to recreate its authenticated bytes.

Independent read-only schema review completed: no DTO authority/precondition
blocker. Incorporated generation orphan cleanup and comments distinguishing
ChunkRef raw-data hashes, Manifest whole-file hashes, existing domain PageRef
commitments, and exact accepted payload/header commitments. Existing domain page
digests pass through unchanged; protobuf representation does not redefine them.

Dependency verification correction: the original isolated `pnpm install
--frozen-lockfile --ignore-scripts` passed under Homebrew pnpm **9.15.2**, not the
pinned 12.14.0. The shell resolves a different executable in the worktree than in
main. The earlier claim that the leading env lock document was invalid was wrong.
It is required metadata for the pinned pnpm 12 package manager. This mistake was
found when root's actual main install failed with
`ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE` for packageManagerDependencies.

The narrow correction restores the original env document unchanged ahead of the
updated project lock document. Every original project dependency entry remains
unchanged; additions are only the protobuf generator/runtime closure. The package
manager pin stays `pnpm@12.14.0`; no `pmOnFail: ignore` or pin bypass is introduced.
The `pnpm-workspace.yaml` `packages: ['.']` addition remains root-approved.

Official [pnpm lockfile documentation](https://pnpm.io/lockfile), checked
2026-10-17, specifies the env document first and project dependency document last.
Tools reading this lock must use a multi-document parser and inspect the last
document for project dependencies. Future checks must record the executable and
actual `--version` from the same working directory as the install.

## Foundation verification — 2026-10-17

Root granted the exclusive heavy slot; all Rust builds used one job. Released the
slot after completion and notified the portable owner before further work.

- `cargo generate-lockfile --manifest-path tools/proto-codegen/Cargo.toml`: pass,
  handle 92018; generator dependency closure pinned in its separate lock.
- `node scripts/generate-proto.mjs`: pass, handle 98364; standard generators built
  in 18.50 seconds. Pinned vendored compiler reports `libprotoc 36.2`.
- `node scripts/generate-proto-fixtures.mjs` then
  `node --test tests/protobuf-interop.test.mjs`: pass, 4/4.
- `CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target cargo test
  --locked -p zorid-proto`: pass, 4/4 integration tests; host no_std library builds.
  First resolving run handle 14295 passed; separate locked rerun passed.
- `node scripts/generate-proto.mjs --check`: pass, byte-for-byte generated source
  equality; `node_modules/.bin/tsc --noEmit`: pass (handle 22362 first two commands).
- Optional `cargo check --locked -p zorid-proto --target wasm32-unknown-unknown`:
  failed with E0463, missing `core` for that target. `rustup target list --installed`
  reports only `aarch64-apple-darwin` for the active stable toolchain. No target was
  installed as part of this check. This is an environment gap, not a WASM pass.

Root Cargo.lock adds only the Prost runtime/derive dependency closure and this
crate. Existing package versions remain unchanged; adding syn2 alongside existing
syn3 makes Cargo qualify existing syn dependency edges with their existing version.
No domain crate, runtime adapter, existing sync codec, encryption or transport
implementation changed. Required-feature tests show raw decoder visibility, not
production validation/adapter activation. Native UI/mobile/runtime streaming and
versioned sync adoption remain separate unverified work.

## Pinned pnpm verification correction — 2026-10-17

Exact environment findings: in `/Users/ctk/Projects/Zorid`, `command -v pnpm`
resolves `/Users/ctk/.local/share/pnpm/pnpm` and reports `12.14.0`; in this isolated
worktree it resolves `/opt/homebrew/bin/pnpm` and reports `9.15.2`. Both shells use
Node `v26.10.0`. The earlier worktree `.modules.yaml` confirms `pnpm@9.15.2`.
The explicit 12.14.0 executable must be used for the corrected proof.
No changes to main, its node_modules, global executables or package-manager policy
are authorized by this correction. Verification below used isolated modules
and disabled lifecycle scripts.

Corrected proof: `CI=true /Users/ctk/.local/share/pnpm/pnpm install
--frozen-lockfile --ignore-scripts` passed under explicit pnpm 12.14.0 in the
isolated worktree (handle 19157, 6.8 seconds, lifecycle scripts disabled). The
output says the lockfile passed supply-chain policies and resolution was skipped.
`node --test tests/protobuf-interop.test.mjs` passed 4/4 again. A repeated explicit
pnpm 12 frozen install also passes and preserves lockfile bytes exactly. The
corrective lock is byte-for-byte equal to root's owned auto-prepended lock, and
structural checks establish original env-document and foundation project-document
contents unchanged. No Rust/build commands or shared module changes occurred.
