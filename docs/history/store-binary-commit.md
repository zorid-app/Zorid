# Binary stage commit authority

`request_commit_binary_stage` authorizes one sealed Command stage. It fixes the
original target, selected event, manifest, source commitment, final event bytes,
metadata revision and graph revision in a durable plan before all-history binary
verification. Receiving stages are never automatically sealed or authorized.
`commit_binary_stage` requires that authorization and returns the ordinary
operation receipt plus the original target and projection job IDs.

The final writer compares the exact metadata snapshot, sorted EntryStates,
retained Text commitments, stage ownership and immutable sources. Source promotion
adds ledger references without copying bytes. Graph membership, classifier and
history, the operation receipt, pending authored envelopes, one materialization
job and the Command stage terminal transition commit atomically. The classifier's
changed identities and stored states must equal the core receipt.

An unrelated metadata change may reprepare the same request using its original
final event and reserved revisions. Re-emitting different final event bytes is a
retryable conflict. A genuinely stale original target produces a retained typed
rejection; SQL, I/O, corrupt sources and optimistic conflicts never become a
target rejection. The exact serialized CommitResult must fit 24 KiB. An oversized
result rolls back every publication effect, then stores `too_large` against the
same immutable authorized request in a separate transaction.

Receipt replay runs before current target, phase, classifier or source access.
It validates the original BinaryRef operation locator and minimal local owner,
then resolves the one original materialization job. Thus restart or an unknown
commit result does not retarget a command, create another job, or require a later
file revision or damaged source to match the original result. Rejected stages
likewise query their original typed reason without rehashing the retained source.

The small inline adapter uses the same pipeline and the shared 16 MiB limit. Its
full original target, mode, length and digest are durable before the first append.
A restart compares that complete call before accepting more bytes. A nonempty
explicit stream without this draft cannot be adopted by an inline call. The
internal client namespace may bind an otherwise empty Receiving stage after the
begin/draft crash gap; it grants no publication without explicit authorization.

Capture stages remain inert and Sealed. Only a private physical-import guard may
authorize their promotion, and its physical proof/baseline is revalidated in the
final writer. Physical resolution and baseline changes share that transaction.
The capture remains readable afterwards. Replaying an already committed Capture
receipt grants no new import and does not require a fresh physical guard.

Nine focused fixtures cover explicit authorization and normalized source
promotion, restart/new revision/corrupt-source receipt replay, stale Write
atomicity, inline partial restart identity, final-writer rollback/retry, unrelated
graph reprepare and equal empty writes, oversized receipt rejection, and guarded
Capture import with retained readability, and SQL NULL nonterminal handling.
All nine passed in Store library gate19472; native/client acceptance is separate.

`binary_stage_content_manifest` returns the original sealed manifest metadata,
including length and whole SHA256, without constructing a private read proof.
Its terminal path reads the original operation/plan before current graph or
source bodies. CLI callers can compare retry input against that commitment;
hosts can populate the existing terminal finalized diagnostic. A manifest alone
does not authorize reads or publication. `BinaryContentManifest` re-exports the
portable diagnostic type for native adapters without another direct dependency.
