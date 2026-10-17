# Store reference-based binary activation

Owner: `/root/package_sol`, isolated worktree `store-binary-streaming`, branch
`tingkai-c/store-binary-streaming`. Root remains the sole main integrator.

Status (2026-10-17): implementation source is frozen and independently reviewed. No schema11 activation Cargo gate has run. The tested schema10
foundation (277adb0 + ada6e8b, 29 Store library +3 family/schema cases) does not
establish this activation or native/browser/desktop streaming acceptance.

## Dependencies and ownership

The branch consumes scanner a8e970d +7e114fa, portable descriptor/builder 7edbb72,
metadata candidate c319e8d, classifier 67493c4, binary mapper a661bf7, general and
external metadata planners 5ce07e5, and core metadata-only content helper e7827b0.
Their original commits were replayed in this isolated branch. No file-v2 wire
encoding or protobuf/gRPC dependency changes are included here.

| Scope | Worker | Source review |
| --- | --- | --- |
| Shared immutable source, metadata index, stages | cli_tests | Reviewed; revised fixtures unrun |
| Stage commit, original operation plan and receipt | cli_tests | Independent central review accepted, including TooLarge rollback; eight fixtures unrun |
| Read pins and bounded ranges | binary_reads | Independent review accepted; seven fixtures unrun |
| Entry metadata and bounded compatibility reads | entry_metadata | Independent review accepted; active small and ignored 64 MiB fixtures unrun |
| Metadata command and authenticated receive transactions | metadata_transactions | Independent review accepted; final host policy CAS fixture unrun |
| Typed publication and retained history | ref_materialization | Independent review accepted, including bounded digest preflight; fixtures unrun |
| Typed observations, namespace evidence, request decoder | operation_receipts | Independent review accepted; focused lookup fixtures unrun |
| External namespace/Text/capture import authorization | external_metadata_store | Independent review accepted; focused restart/ownership fixtures unrun |
| Parent schema, ledger, admission and terminal query hooks | package_sol | Independent review accepted; central integration gate pending |

Workers share this one isolated Store checkout under disjoint file ownership.
Native physical publication is owned separately by external_reconcile_sol;
Electron/host consumers by recovery_ui_sol; browser IDB authority by
default_lifecycle_review_sol. Those counterparts are not established by Store
source review.

## Authority and retry contract

Fresh-only schema11 rejects any existing nonzero different schema before WAL or
schema writes. There is no migration, ALTER, DROP, rewrite, or main activation.
`immutable_payloads` is the single exact accepted plaintext source; immutable SQL
triggers prevent update, delete and key replacement. Authored/received graph and
stage records retain references plus independent commitments. Encrypted exact
wire remains distinct. Metadata JSON never carries binary bodies.

A normal operation journal stores tagged Inline or BinaryRef requests. A BinaryRef
retains the original owner-bound stage locator, target/revision/selected event,
manifest and source commitment. Small-inline binary calls retain a digest/mode/
target draft before append, never a second body. Authorization durably reserves
the final event and both revisions before whole-manifest verification. Complete
history verification occurs outside the writer transaction. The final writer
rechecks exact metadata, entries, Text cuts, stage/source commitments and
physical authorization, then atomically records graph/outgoing references,
receipt, typed publication/history and projection job. IO/CAS failure retains
the same source/operation/plan. Target conflicts and explicit receipt policy
rejection are durable typed terminals. Terminal replay precedes current target
or source checks and returns the original receipt and original job IDs.

Capture is inert source retention, separate from authored publication. Its
request fixes path, length and digest and cannot commit Create/Write by itself.
Only the private external import authorization revalidates original observation,
public physical proof, historical baseline and original mode. Private recovery
alternatives have no manufactured public inode proof. Stale binary disk content
remains a retained conflict rather than an implicit new causal branch.

`StoredContent` distinguishes bounded InlineBytes from BinaryRef(Graph|Capture).
Current and historical Graph references retain exact identity, selected event
and manifest. Metadata reads return no body. Actual ranges use a private verified
read session and return at most128 KiB. Caller-stable read_id resolves an exact
open retry; server pin_id remains a separate random token so a closed stale
handle cannot bind to a new read. Four active pins are retained until explicit
owner close; no eviction. Bounded owner listing supports native crash cleanup.

The old generic enrolled Binary Write host-intent body path returns
`stream_required`; mode-bound file creation uses the family/stage API. Text
editor intents and explicit unenrolled legacy behavior remain available.

## Initial bounded policy

Store exports one `DEFAULT_STREAMING_LIMITS`:8 active stages,4096 retained stage
rows,512 MiB shared immutable exact plaintext,4096 stage chunk rows and256 pages.
The injected fields are max_active_stages, max_stage_records, max_staged_bytes,
max_chunk_records and max_page_records. Aborted/retained sources still count;
there is no pruning. Binary files remain capped64 MiB, chunks128 KiB and exact
file-v2 payloads1 MiB. Portable graph/metadata/verification quotas are unchanged.

Binary Create paths are bounded4096 UTF8 bytes. Exact CommitResult JSON is bounded
24 KiB before mutation commit; oversize rolls back every domain/outbox/job change
and records only a typed TooLarge terminal, retaining the source. This reserves
space for the escaped-once renderer checkpoint under64 KiB. These are initial
explicit development policies, not arbitrary-size streaming claims.

## Next evidence

The frozen central module SHA256 is
`5209b11c84b5f55468a4f0c448a7a8be0ef4479a7d72105a91e9280c480710de`;
review covered final transaction/replay and the TooLarge rollback delta. Rustfmt
parsing and `git diff --check` pass. Obtain the serialized heavy slot for bounded Store compilation and focused library/family
cases. Run the ignored64 MiB range/metadata fixture only in an explicit later
slot. Compose native/host/client counterparts and verify actual restart,
publication, transport and editor behavior before any main/runtime activation.
