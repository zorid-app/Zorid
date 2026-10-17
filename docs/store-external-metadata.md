# External metadata and captured-content imports

Current verification update (2026-10-17): Store library gate19472 passed86 tests,
0 failures,1 explicit ignored64MiB fixture. Earlier source-only/unrun wording
below records preparation state; the authoritative gate history and remaining
native/client gaps are in `docs/store-binary-streaming-activation.md`.

Owner: `external_metadata_store` under `package_sol`, isolated shared Orca
worktree `store-binary-streaming`. Main integration belongs to the coordinator.
This is source work pending joint Store compilation, independent review and
native runtime verification. No build or test command was run by this worker.

## Authority and transactions

Existing-file Text imports prepare a portable metadata activity candidate under
a read snapshot. `prepare_parts` verifies the old publication and all complete
retained manifests, including hidden history. The final writer compares the
exact observation, physical proof and baseline before the shared metadata
command writer repeats graph, source, entry and retained Text comparisons. The
observed physical Text branch retains its own immutable historical revision;
it does not replace the current merged desired publication.

Binary external imports require an inert sealed Capture source. A private
`CaptureImportAuthorization` has no deserializer and binds an independently
admitted client, the original observation and public-path physical proof, the
original historical baseline, and a fixed Create/Write target. Retention without
a public proof cannot issue import authorization. A newer unseen binary causal
head remains a revision conflict. A physical Move revision may alias only the
identical causal publication witness, preserving the prior stale-disk policy.
The common binary pipeline owns full-source verification and final publication;
it calls `validate` in its final writer and `record_committed` after creating the
real graph publication. That hook writes a Graph baseline, physical binding and
the original observation resolution in the same receipt transaction. The source
Capture remains inert and distinct from the published graph reference.

Original resolved receipt replay uses the durable observation, typed operation
and saved Create intent before consulting current graph, stage or sources. A
failed retry cannot manufacture a new target or reinterpret an empty inline
mutation as a reference operation.

## Typed physical namespace evidence

`ExternalNamespaceMember.observed_content` and nested namespace evidence carry
`StoredContent`. `ExternalScanProof::present_from_digest` accepts the real
streamed length and digest; persisted proof comparisons still check the scan
inventory, completion/coverage, original inode and parent, and historical owner.
Source-only capture helpers pass members directly to the namespace journal;
they do not retain a different external observation before the Move. Changed
content becomes an observation against the newly moved historical physical cut.

Compound MoveWithDeletions prepares transient metadata candidates only to guide
subsequent deletion planning. Every emitted bounded namespace frame is collected
into one final `AuthoredMetadataBatch` against the ORIGINAL expected metadata
state. No intermediate Move publication history, jobs or receipt are committed.
All complete manifests and observed sources are verified outside the IMMEDIATE
writer. Exact observation/baseline/scan, metadata/source, entry and Text comparisons
then fence the one final publication, original namespace receipt and satisfied
physical jobs. A binary locator counts its serialized metadata toward the 64 MiB
journal budget; streamed verification work is separately bounded at 512 MiB and
exact repeated locators share a hash pass.

## Native API seam

The following counterparts admit a client independently of serialized locators:

- `prepare_family_external_create_content(client, id, kind, mode)` returns
  `ExternalCreateIntent::{Inline, BinaryCapture}`. Existing native callers may
  discard the prepared result, then import the same saved observation identity.
- `import_family_external_create_content(client, id)` and
  `import_family_observation_content(client, id)` use the common capture pipeline.
- `record_family_namespace_observation_content(client, scan_id, action, members)`
  admits captured member sources before retaining the namespace observation.
- `family_namespace_prepare_content(client, covered, expected, evidence)` verifies
  full evidence sources in a read snapshot before attaching physical jobs.

The older methods do not infer client admission from a capture locator. They
remain available for bounded Text/folder and non-captured evidence paths. Binary
external observations must be captured, including empty and small binary files;
there is no legacy all-byte graph fallback. Fixed Capture observation identity is
its original stage operation ID. Changed path, baseline or physical proof on the
same operation conflicts; exact retries return the original observation.

## Source checks and remaining gates

`rustfmt` and `git diff --check` passed for the worker's files. Three new unit tests
are source-only and unrun: private retained captures cannot acquire public import
authority; capture Create requires an independent client and rejects a changed
saved public physical proof; resolved prepare/import retries replay before current
capture-stage validation. Existing-file stale binary, compound atomic rollback,
missing backing bytes, unknown-result replay and full native flows require the
coordinator's serialized integrated gates. No isolated source review is evidence
of native or streaming runtime acceptance.
