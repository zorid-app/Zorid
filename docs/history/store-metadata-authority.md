# Normalized metadata authority

Current verification update (2026-10-17): Store library gate19472 passed86 tests,
0 failures,1 explicit ignored64MiB fixture. Earlier source-only/unrun wording
below records preparation state; the authoritative gate history and remaining
native/client gaps are in `docs/history/store-binary-streaming-activation.md`.

Status: source changes and eight adapted/expanded module fixtures are prepared;
no builds or tests run for this change. Owner `/root/package_sol/cli_tests`,
parent `/root/package_sol`, worktree `store-binary-streaming`. Parent owns central
schema-11 registration, ledger normalization, receipts and activation integration.

`file_state` now stores graph heads, file membership keys and bounded text
activity records. File membership references the graph head and the single
`immutable_payloads` row. It stores no body or descriptor copies. The former
`family_file_descriptors` table and legacy file-state load/persist functions are
removed. `initialize` returns `MetadataState`; no active path in these modules
reconstructs `v2::State` or gathers retained file bodies.

`blob_index::load_metadata` restores each member's descriptor from its immutable
head and independent family ledger commitments. Text activity scope, identity,
namespace context, digest and byte count must match its Text ledger binding and
immutable source. SQL checks membership counts, ID lengths, descriptor/activity
sizes and aggregate metadata bounds before loading their Strings.

Policy remains explicit: 4096 combined records/activities, 4096 events, 2048
chunks, 256 pages, 128 MiB descriptor/activity metadata and 512 MiB retained exact
plaintext across the database. The old 128 MiB aggregate raw `State` body limit
does not apply to metadata. Immutable-source writes retain their separate frame
and global byte bounds.

`file_state::persist_plan`, also exported privately through `blob_index`, checks
exact expected `MetadataState`, the portable all-history verification capability,
unchanged old records/activities, and independent source commitments. It inserts
only new memberships/activities, checks their sources after insertion and CASes
the head revision. The parent dispatcher owns the enclosing IMMEDIATE transaction,
wire/text-state/receipt conditions and atomic commit. This primitive does not
authenticate caller-provided bytes or create an outbox.

`MetadataSnapshot` serializes only scope, revision, sorted member/activity IDs and
the exact metadata fingerprint. Combined list size, ordering, uniqueness and
cross-list collisions are checked before lookup. Restore resolves those exact
historical members, so later additive writes do not change the saved state.
Missing membership, missing backing data, changed descriptors or fingerprint
mismatch fail closed. It is neither a body-bearing checkpoint nor a persisted
verification flag.

`check_sources` performs metadata-only membership/ledger/head checks.
`verify_metadata` uses the shared all-history verifier and bounded chunk source;
it does not substitute per-chunk hashes for whole-file verification. Trusted
overlays are bounded exact frames, reject duplicate/cross-scope IDs, and must
match the requested exact descriptor before a chunk is returned. A bad matching
overlay cannot fall back to another source. Native source errors are retained
by `ChunkResolver::finish`, even if a caller supplies portable success afterward.

Pre-promotion candidate verification uses `ChunkResolver::for_stage` and
`verify_staged_metadata`. Existing graph members keep the strict ordinary source
path. Only a nonmember allocated to that exact owner-bound stage may use its
independent stage commitments. The constructor accepts sealed Capture or
sealed/commit-requested Command stages and at most one bounded final event frame;
it never collects every staged body into an overlay. This grants data verification
only. Public command admission still rejects Capture, and private capture import
requires its separate physical/baseline authorization in the parent commit path.

`ChunkResolver::for_capture` resolves owner, sealed Capture purpose, manifest and
commitment without hashing the whole capture. Session opening separately calls
`capture_metadata` to verify the source. Each subsequent range read checks its
actual bounded immutable payload against independently retained stage
commitments and the expected descriptor. The resolver grants no publication or
entry identity to captured bytes.

Prepared fixtures preserve the original two descriptor/source checks and three
file-state checks, adapted to normalized metadata. Added cases cover snapshot
restoration after later writes, invalid ID lists before queries, strict overlay
matching and lightweight Capture resolver construction followed by actual-byte
corruption rejection. These are source fixtures pending the coordinator's gate;
they do not establish native/client streaming acceptance.
