# Native binary streaming execution

Owner: `/root/external_reconcile_sol`, branch
`tingkai-c/native-binary-streaming`, worktree
`/Users/ctk/orca/workspaces/Zorid/native-binary-streaming`, base `f4e6ec2`.
The coordinator owns main integration and serialized builds. This document is
the source-only implementation plan; streaming activation is not verified.

The base includes the reviewed resumable scanner. Coordinator standalone CLI
verification covered 270 directories over 22 independent 32-entry scans with
one persistent scan ID, missing-file retention until complete inventory, stable
IDs, a quiet repeat, and an exact 42,900-byte Unicode write/read. That result
does not establish the streaming path below.

## Shared dependencies before coupled edits

`/root/package_sol` owns Store schema11 activation and must freeze the public
typed content, projection, observation, stage, pin and bounded read APIs before
native consumers change. Portable metadata planner `e7827b0`, staged binary
mapper `a661bf7`, metadata classification, and the forthcoming metadata namespace
planner must be present on the coherent candidate. Main's protobuf boundary
decision applies to subsequent client transport; native must not introduce a
second unbounded JSON/base64 body path.

Required Store seams:

- `InlineBytes | BinaryRef` content in current entries, historical projection
  targets/baselines/attempts, external observations, namespace evidence and
  compound external namespace members. Missing content is distinct from an
  empty file; no empty-byte placeholders are permitted.
- A metadata-only entry reader and immutable content references bound to scope,
  entry identity, selected causal event and manifest. Equality of file hashes
  does not establish causal equality or physical ownership.
- Owner-bound pinned read references, resolved by their owning Store, with at
  most 128 KiB returned per call. Historical and recovery sources must survive
  restart and remain retained while projection/read/observation refs use them.
- Durable source staging for external public/private byte capture without
  implicitly authorizing Create or Write. Divergent bytes must be retained even
  when pending namespace work or unseen remote edits block import.
- Exact scan proof construction from actual streamed SHA256, length and physical
  identity, avoiding a full Vec solely to call the existing proof constructor.

## Native implementation sequence

1. Add descriptor-relative bounded filesystem reading, hashing, comparison and
   private staging. Preserve NOFOLLOW, single-link regular files, exact spelling,
   root/private/parent verification, original inode, length and mtime/ctime before
   and after reading, and final pathname-to-opened-inode verification. Private
   staging retains CREATE|EXCL, mode0600, file fsync and directory fsync.
2. Consume typed content through one bounded source/comparison seam in the
   existing publication and namespace recovery state machines. Preserve phase
   ordering, exact attempt/covered-job target checks, stage identity, historical
   binding and original parent checks, NOREPLACE publication, displaced inode
   recovery and late external writes. Content refs never convey inode authority.
3. Expose native stage begin/resume/append/seal/commit/abort and pinned read
   wrappers for independent CLI and host consumers. Each stage or operation keeps
   its durable retry identity. Committed receipts and physical projection remain
   separate outcomes. CLI/host adapters remain owned by their assigned workers.
4. Replace scanner whole-file captures and confirmations with streamed metadata
   proofs. Keep completed inventory authority separate from resumable content
   work. External bytes enter durable staging before import, including conflicts;
   full existing physical/history CAS remains required at final commit.

The first binary format limit is 64 MiB, with source bodies no larger than
128 KiB. Auto enrollment retains known binary-extension policy and strict
incremental UTF8/no-NUL classification. Existing Text identity never changes to
Binary because of size or an override. Unsupported large Text remains explicit
until the separately owned Text framing work is ready.

Independent filesystem foundation is prepared in `fs_stream.rs`, with ten small
fixtures in its nested test module. Snapshot callbacks fill canonical chunks
across short reads and interruptions; stage readers are bounded, prove exact EOF,
and verify both incoming and actual staged hashes. Failed callbacks or validation
retain partial private files without reporting completion. The final stage stamp
also checks owner-only permissions after callbacks, so callback-time chmod cannot
be accepted as a new valid verification baseline. Native `Cargo.toml` adds the
already pinned `sha2 = 0.11.0`; the coordinator owns the corresponding root lock
entry. The existing byte classifier delegates to one internal UTF8/NUL fact
helper with unchanged explicit-mode and known-extension precedence. No typed
Store consumer or public streaming API is activated by this foundation, and no
build or fixture execution has been run by this owner.

## Acceptance and ownership

Native files reserved to this owner: filesystem primitives, native/family/
namespace/publication_handoff/external scanners/host_intents and new native
streaming modules, their module exports, and scoped native dependency additions.
No Store, portable, protobuf, desktop host/service/renderer or CLI edits are
included. Independent source workers audit scanner and publication proof seams.

Required focused checks include a file above16 MiB, exact chunk and zero-length
boundaries, interrupted stage/restart/retry, wrong owner/stale ref, source mutation
or inode/parent replacement while reading, no-clobber publication/recovery phases,
same-byte unseen causal heads, historical folder move plus missing child, and
bounded scanner content progress. The coordinator selects and runs the coherent
Store/native/CLI/host gates and actual independent-process/native verification;
no worker heavy build is authorized by this plan.

## Coupled source checkpoint

The coordinator integrated and tested the independent primitive: aggregate
`fc886c7` (alias `f9fb565`) gate `77528` passed all ten fixtures, 18.97 seconds
compile and 0.06 seconds tests, Rust1.95 with one build job. Main `5050db9`
contains that source and the native SHA256 lock edge. This branch was rebased
onto that main, then imported reviewed Store foundations `277adb0`/`ada6e8b` and
typed interface `af49f73` (local aliases `ffa13b7`, `8d0fc82`, `f9d8576`).

Prepared coupled native source now includes typed projection/recovery and
historical publication handoff, namespace evidence/late-FD alternatives,
hash-only inventory, existing/new external observers, and metadata/stage/commit/
read adapters. Existing fixtures resolve actual small content through a bounded
test-only pin reader, preserving full-byte and durability assertions. Source
reviews cover the independently owned files; there is no coupled build result.

Current code ownership in this shared worktree:

- Parent: `native.rs`, `content_stream.rs`, `binary_api.rs`, module/type exports,
  family projection-status visibility and the existing partial-stage fault hook.
- `external_scan_review`: `publication_handoff.rs` implementation, reviewed by
  scanner worker; independent parent/public API/source-reader review completed.
- `external_cli_dispatch`: namespace/family namespace and binary wrapper source,
  reviewed independently by scanner worker.
- `scanner_streaming_sol`: `external_scan_progress.rs`, preserving cursor/Ready/
  immutable proof authority; source review remains part of the coherent freeze.
- `external_namespace_tests`: new `external_observe_stream.rs` and external
  create source; `external_namespace_streaming_sol`: external namespace caller.
- `native_fixture_streaming_sol`: five existing test-file adaptations and
  independent create/observation/namespace review.

The independently reviewed pre-capture lookup is now wired in native. It uses
exact historical baseline/physical proof plus verified length/digest before
staging, reuses namespace pending-content refs after relocation, and preserves
an accepted Create intent's original mode across Inline/Capture retries. The
returned observation still requires fresh public inode/parent/content checks;
lookup grants no import authority.
Rejected new Text enrollment before any accepted intent may still be explicitly
imported Binary; an existing Text identity never changes.

Store functional methods and schema11 activation are still being composed by
`package_sol`. Frozen read pins distinguish caller `read_id` from server-issued
`pin_id`: Open retry resolves the original view before current metadata; closing
and reopening the same caller ID creates a new pin, so stale locators do not
resurrect. Interrupted synchronous core readers explicitly close only their
reserved actor's pins under the native filesystem lock; frontend pins are never
evicted. Sealed inert captures are excluded from active-upload counts while
their immutable sources remain retained.

Root-approved initial shared policy is eight active uploads, 4096 retained
stages, a single 512 MiB exact-payload quota shared by graph/stages, 4096 chunks
and 256 pages. These are explicit admission limits, not unlimited vault support.
The per-file and per-range caps remain 64 MiB and 128 KiB. Next gates are the
coherent Store/native compile, focused crash/retry/large-file fixtures, then
independent CLI and host/native app proof. No worker build has run.

### Final native source freeze (source only)

All native production slices have independent source review, including the new
read-only `binary_stage_projection_status(StageRef)` query. It resolves only the
original committed jobs and reports completion without recovery or current-state
reinterpretation. Store failures remain typed errors. Existing small fixtures
retain full-byte oracles through bounded test-only source reads.

Root approved Store terminal `TooLarge` and a 24 KiB exact CommitResult JSON cap
with domain/outbox/job rollback before recording rejection; paths are capped at
4096 bytes for staged commands. These bounds keep immutable terminal results
within desktop frame/checkpoint budgets. Native reexports the shared constants;
Store owns the implementation and final independent review.

No native Cargo build or coupled fixture ran in this worktree. Two additional
17 MiB +17 byte fixtures are assigned source-only in a separate new test module:
stage/pin/replay behavior and external compound move/edit/delete, each comparing
all bytes with buffers no larger than128 KiB. They will be a separate follow-up
commit so initial aggregate compilation is not delayed. Coupled Store activation
commit and serialized coordinator build remain required before any activation
claim.
