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
