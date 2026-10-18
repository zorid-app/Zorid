# Bounded v1 managed-record compatibility implementation contract

2026-10-18 UTC. **Proposed implementation contract, not implemented migrations or
a public API freeze.** Owner: `term_06f49726-24ba-4006-b062-c3c7f30af67f`, task
`task_f9ad0b71e1f3`, dispatch `ctx_b7c2998a892e`; isolated branch
`tingkai-c/managed-tasks-desktop-ui`. This dispatch owns only this new document.
Frozen Tasks source `cbe9dff6` and report `214a7079` remain untouched. Canonical main
integration belongs solely to `term_2fbd0185-6f86-4649-824c-92faf46852f7`.

Source inspected in canonical `/Users/ctk/Projects/Zorid` at `f2988dee` and
`bdad72253467d3f1f88af11d15a9ff57d640699d`; between those revisions only the roadmap
and mobile Cargo.lock changed. Read the current execution checkpoint, user
findings, [implementation plan Phase 2](implementation-plan.md),
[schema proposal](schema-evolution-proposal.md),
[optional-only guard results](schema-registration-results.md), and actual files
named below. The older proposal's missing optional-only guard is now fixed;
its mixed-version admission recommendation remains unimplemented.

## Decision and scope

Implement **declaration compatibility without rewriting record history** first.
One trusted compiled first-party release supplies a bounded lineage of complete
schemas. Rust validates its append-only compatibility; hosts persist it with
registration and use it on local preparation, receive, retry, reopen and export.
Compatible activation authors **zero migration operations**. No per-record backfill,
migration lease, startup loop over user values, arbitrary plugin callback, new
outbox, sync cursor, registry downloaded from a peer or general migration engine.

This meets the first additive part of Phase 2, not destructive migration, provider
jobs/leases, secrets, public plugin publication or complete Phase 2 acceptance.
Task Markdown/Types files are file-authoritative and outside this records schema
mechanism. The concrete first-party workload is WorkBlocks, not a task mirror.

| Change | v1 behavior |
| --- | --- |
| Exact canonical declaration/lineage repeat | Idempotent; keep authorization revision/handles. Replay maintenance may independently progress. |
| Add optional supported field | Higher version, certified append-only successor; required=false; preserve all existing declarations and policy. Respect current kind/null/default constraints. |
| Add required field, even defaulted scalar or intrinsic-empty Set | Reject even on empty collection; canonical guard already does this. |
| Version-only bump | Explicit certified identity step permitted; avoid unnecessary bumps. |
| Change label | Keep stable field/member/collection IDs. Presentation-only compiled metadata can change without semantic version or authored operation. No new synced label configuration API in this slice. |
| Add/rebuild physical index | Core-owned derived projection only; no schema-version bump or authored operation solely for index layout. Existing query meaning/order remains unchanged. New query semantics require their own contract. |
| Remove/rename/reuse ID; change existing kind, required, nullability or default | Reject, including apparently permissive conversions. No implicit copy from old field ID. |
| Convert Synced/Local/Cache or realm/vault/owner/collection | Reject. Requires separate explicit recoverable export/import plan; remote payload cannot register or change policy. |

Defaults materialize only when a new local Create is prepared under that schema.
Old records and delayed old offline Creates keep absence; null stays null, unset
stays unset, patches/reopen/replay never backfill. Optional Set is logically empty
without manufacturing a projection entry. User-facing display placeholders must
not become stored/filter/export values. Unknown supported fields retain their
existing causal history and inferred-kind limits; becoming a known field requires
revalidating all that history and may make an otherwise additive upgrade fail.

## What exists and what must change

| Actual hook on inspected main | Current behavior / required change |
| --- | --- |
| `crates/zorid-records/src/lib.rs`: Schema::validate, State::{new,restore,union,prepare}, validate_operation_structure | One active Schema; nonzero operation version is structural validity, not lineage authorization. Required Create fields and supported unknown kinds already checked. Add origin-schema validation through a bounded validated-lineage helper; do not weaken these rules. |
| `crates/zorid-records/src/admission.rs`: registration_change | Validates both inputs and scope; exact repeat=false; optional-only higher-version additions=true. Extend to validate full lineage prefix and active declaration, preserving existing rejection boundary. |
| Same file: received_gate | **Exact schema_version equality today.** Replace only with explicit validated-lineage membership after conflict/missing-registration/policy gates; never `version <= active`. |
| Same file: restore_accepted/admit_received | Shared restoration, union, pending, projection and quota decisions. Route history/origin validation here so adapters cannot widen versions independently. |
| `crates/zorid-store/src/managed_records.rs`: ManagedRegistration, portable, managed_register, load, snapshot, check_restore, activate, managed_export | Registration is persisted in managed_collections.registration; IMMEDIATE registration transaction restores accepted states before replacing revision. All accepted-state restore paths need lineage-aware validation, not only receive gate. |
| Same file: managed_apply, managed_local_operations | Exact authorized request replay is checked before new revision/default preparation. Preserve this ordering after upgrades; stale handle still fails, reacquire then replay original request. |
| Same file: receive_in_transaction, retry_in_transaction, transition | Retains authenticated exact payload/source/status; receive shares ledger/cursor transaction; bounded retry uses persisted fair continuation. Reuse unchanged durability boundaries. |
| `crates/zorid-wasm/src/records.rs`: registration, validate_registration, validate_accepted, recordsSnapshot, prepare_local_inner, prepare_received, prior_restore, validate_stored_binding | Rust owns canonical bytes, schemas and facts/plans. Replace every raw accepted State::restore bypass with lineage-aware restore; preserve structural-only stored-source validation for unresolved future payloads. |
| `src/core/browser-managed-records.ts`: register, apply, receive/retryPage, validate | Registration validation and every accepted-state check happen inside IDB readwrite transaction; same bytes preserve revision, changed bytes rotate it. Keep registration revision in final plan/CAS read set. JS must not interpret lineage compatibility. |
| `src/platform/browser-managed-records-host.ts`, registry | Startup/foreground bounded maintenance already has separate ownership. Product registry is empty on inspected main; a fixture consumer is not normal WorkBlock activation. Coordinate any hook change explicitly. |

WorkBlocks have additional compiled constraints in
`crates/zorid-records/src/first_party.rs`: `validate_schema` requires exact `schema()`,
`validate_operation` requires schema_version=1, and `validate_export` rechecks both.
`crates/zorid-native/src/workblocks.rs` constructs the registration and restores
snapshots with `State::restore(domain::schema(), ...)`. These are real blockers
for a production WorkBlock v2; generic receipt widening alone cannot support it.
The range is an atomic validated object, title an optional String, task_refs an
optional Set with EntryId validation and MAX_TASK_REFS=64. Keep those domain
invariants on local, incoming, restore and export paths at every supported origin.

## Private lineage representation and deterministic identity

Recommended internal DTO (names are proposals, not current APIs): retain
`Registration {realm,vault,owner,schema}` and add mandatory
`lineage: {format_version:1, schemas: Vec<Schema>}`. `schema` must canonically equal
the last declaration. This duplicates one declaration but preserves current
identity extraction shape and uses existing registration blobs; no new SQL table
or IDB store is needed. Root must approve this representation before source edits.

1. One to sixteen complete declarations, positive strictly increasing versions;
   max existing 1 MiB for the entire registration, each Schema within current
   MAX_FIELDS=64/value limits. No eviction of older lineage to fit a budget.
2. All declarations have identical collection and policy; validate IDs/scope and
   every schema/default, including exact repeats. Each adjacent pair satisfies
   optional-only preservation. Same-version differing declaration is rejected.
3. Replacement must extend the entire previously committed canonical prefix;
   cannot remove, reorder or rewrite an earlier declaration. New install at v2
   must supply v1 explicitly if v1 is supported. Numeric gaps are allowed only as
   unlisted unsupported versions, not invented intermediate declarations.
4. Use Rust-owned canonical **bytes** as identity, with a domain-separated tuple
   containing format tag, realm/vault/owner/collection and full ordered schemas.
   A step identity is the canonical tuple of prior prefix and next declaration.
   Do not use random registration revision, path, timestamp, device ID or a hash
   of labels/indexes as semantic identity. Equality must compare canonical bytes,
   not only f64 PartialEq/default equality; freeze recursively ordered object-key
   and numeric serialization with cross-native/WASM golden fixtures. A digest
   for display/cache may be computed by existing adapter hashing, but full bytes
   remain authority; no new core hashing dependency is required for this slice.
5. A first-party compiled manifest maps each version to exactly one declaration
   **and its domain validation rules**. Host-supplied compatible structure is not
   permission to change compiled WorkBlock semantics. Validate the manifest against
   the compiled catalog, including initial registration without a predecessor.

There is no new migration-operation UUID because this slice creates no migration
operation. Existing operations retain exact IDs, schema_version, parents, command,
set tags, scope, generation/restores and tombstones; their canonical bytes must be
identical after activation. New ordinary user writes use existing caller-retained
operation IDs; Create ID equals generation. Same operation ID plus different
request/content remains an integrity collision, including across upgrades.
Registration revision remains a local random authorization fence, not synced data.

Future transformations/backfills are **not** authorized here. Before one is
implemented, require a reviewed recoverable plan with retained source and rollback/
export, deterministic transform/version/source-bound operation identity, defined
causal parents and offline concurrent-edit policy. Deriving a UUID from migration
name alone is insufficient: different observed heads can produce conflicting
commands under one ID, and including heads can create duplicate concurrent effects.
Do not hide that unresolved design behind “idempotent callback” or a single flag.

## Admission algorithm and offline/concurrent behavior

Proposed new `crates/zorid-records/src/compatibility.rs` owns DTO validation and a
`ValidatedLineage` with private fields. Proposed functions:
`validate_lineage(registration) -> Result<ValidatedLineage>`,
`validate_extension(old,next) -> Result<bool>`,
`origin_schema(version) -> Option<&Schema>`, and
`validate_history(lineage,operations) -> Result<()>`. Add a crate-private
origin-operation validation helper in lib.rs that reuses actual structural/value
checks and version-dispatched compiled domain validation. Do not duplicate CRDT
merge or field validation in compatibility.rs or JS.

Receive/retry order:

1. Authenticate/admit existing envelope/scope and exact payload/source binding;
   detect equivocation before semantic application. Missing registration and
   policy mismatch remain their existing statuses.
2. If **any** operation version is absent from validated lineage, retain the whole
   payload as incompatible_schema. No partial application, invented declaration
   or invalid_operation finalization merely because its version is unsupported.
3. For supported versions, validate each operation against its own origin schema
   and that origin's compiled domain validator. Unknown supported fields retain
   current rules; membership does not grant a new action/value codec.
4. Restore accepted history with the same origin authorization, then union under
   active schema with all existing type/unknown-kind/cycle/tag/conflict checks.
   Required origin fields remain required. Current supported history failing
   semantic checks is invalid_operation on receive; accepted stored corruption
   fails reopen explicitly instead of silently dropping rows.
5. Preserve waiting_restore_source and waiting_dependencies until their actual
   evidence arrives. Validate the complete accepted candidate, projection and
   quota; commit accepted state/status/source/change atomically in existing host
   transaction. No local authored echo or migration outbox work on replay.

A desktop with certified [v1,v2] accepts phone's delayed v1 title patch/Create,
while independently authored v2 optional metadata merges under existing per-field
causality. v1 remains in history; absence is not rewritten. Old v1 client retains
v2 as incompatible; it can author independent v1 edits from its visible accepted
heads without claiming to have observed withheld v2 work. A v1 child naming a
withheld v2 parent waits; after that client upgrades, replay can accept the parent
and child. Same-field concurrency preserves existing conflict candidates; atomic
range writes are not decomposed by migration. Deletes/restores and set removals
retain the existing tombstone/generation/tag rules.

Registration is local transactional authorization, not a synced migration event.
Two identical device upgrades produce equal semantic lineage and no duplicate
record edits. Locally concurrent registrations serialize in SQLite/IDB: a request
must still extend the committed prefix, else fail without overwrite/rebase. A stale
lower declaration cannot downgrade. Conflicting same-version manifests fail locally;
independent devices with divergent numeric-version meanings cannot be detected
from today's operation wire alone, which has no schema fingerprint. Therefore this
v1 implementation is limited to identical trusted compiled first-party releases.
Do not claim arbitrary publisher fork convergence or public plugin compatibility.

## Storage, retries and development-format boundary

Native registration: validate inside IMMEDIATE transaction, revalidate **all**
accepted records and restore sources (bounded existing 1024-record/32 MiB quota),
then atomically persist lineage/revision. Failure rolls everything back and leaves
old handles valid. No accepted-state rewrite or projection-value change merely
from activation. First bounded retry page may run in that transaction; distinguish
its accepted incoming changes from activation's own zero authored changes.

Browser registration: keep synchronous Rust validation within the IDB transaction,
accepted-state cursor checks and final revision/counter updates. Persist full
lineage in CollectionRow.registration; ensure plans prepared before replacement
cannot commit against the new revision. Register-triggered replay may be scheduled
post-commit under the normal host queue. Exact repeat retains retryAfter and does
not reset fair continuation. Do not await external work inside live IDB callbacks.

Retain existing incompatible receipts and authenticated payload/source metadata
unchanged. Reuse native retry_in_transaction and browser retryPage on registration,
startup/foreground and accepted parent/restore progress; each pass stays <=16
receipts and <=1 MiB, with persisted fair continuation. Incompatible prefix cannot
starve a later eligible receipt. Replayed terminal acceptance must not duplicate
change events, ciphertext, local replay rows or advance a second relay cursor.
Integrity conflicts and invalid_operation stay terminal; compatible registration
must not revive them. Capacity/IO/transaction abort keeps the prior durable
boundary; quota failure before durable retention cannot acknowledge/advance sync.
Unknown wire family/action/value/format remains decoder failure/no progress under
current dispatcher, not a promised managed incompatible receipt.

Exact already-committed local retries, after reacquiring a current handle, return
managed_local_operations' original result before fresh digest/default preparation.
Never call State::prepare under v2 to replace an original uncertain v1 intent; its
version check can collide. Uncommitted stale plans fail and require explicit
caller reconciliation, not reuse with silently changed expected revision.

Local SQLite DDL/IDB version/index upgrades are separate physical-format mechanisms.
They may rebuild projections from retained authority but never relabel operation
versions, change policy or fabricate synced writes. Unsupported local formats fail
explicitly. User permits replacing unreleased formats: recommend mandatory new
private registration shape, regenerate disposable fixtures, and explicitly reject
old registration blobs rather than shipping default-filled lineage/dual readers
solely for development data. Do not delete/reset real vaults. This choice still
requires root approval; it is distinct from supporting real mixed-version logical
operations within the new format and does not change the records wire v1 codec.

## Proposed implementation batches, ownership and acceptance

These are requested assignments, **not grants to edit**. Root/coordinator must name
owners and serialize shared seams before implementation; no manifests/lockfiles or
UI changes are needed by this document.

| Batch / owner to assign | Proposed exact files and dependencies |
| --- | --- |
| Portable compatibility owner | NEW compatibility.rs and tests/schema_compatibility.rs under crates/zorid-records; lib.rs module/helper and admission.rs shared gates. Depends on canonical optional-only guard. Preserve existing tests/schema_registration.rs and tests/admission.rs expectations, update only explicit new-format fixtures. |
| Compiled WorkBlock domain owner | crates/zorid-records/src/first_party.rs plus existing crates/zorid-records/tests/workblocks.rs; immutable schema_v1/catalog and origin validators. No production v2 feature invented: prove optional v2 in an internal fixture or approve one concrete metadata field first. |
| Native persistence owner | crates/zorid-store/src/managed_records.rs and tests/managed_records.rs; registration bytes, restore coverage and replay/rollback. Coordinate crates/zorid-native/src/workblocks.rs registration/restore with its sole active owner; no native/mobile UI redesign. |
| WASM/browser owner | crates/zorid-wasm/src/records.rs, src/core/browser-managed-records.ts, tests/browser-managed-records.test.ts; existing browser proof fixture for real generated WASM/strict IDB. Any browser host/registry change requires named separate ownership. |
| Independent reviewer/integrator | Review origin gate and every accepted restore/export path, canonical fixture bytes, failure atomicity and operation conservation before sole-main integration. Actual normal Worker and native client proofs remain separate delivery evidence. |

Meaningful required tests (future work; none executed by this document task):

- Canonical golden schemas/lineages native vs generated WASM, nested defaults,
  numeric boundary/-0 spelling, scope separation, same-version forks, prefix
  rewrite/omission, >16 declarations and >1 MiB; no `<=active` loophole.
- Existing required-addition/default/policy/type rejection still holds on empty
  and populated collections. A newly known field incompatible with unknown
  retained history rolls registration back, preserving authorization and bytes.
- Old offline Create/patch plus new optional-field write in both delivery orders;
  same-field conflicts, Set add/remove tags, delete/restore and withheld-parent
  chains. Compare complete histories/operation bytes and final projections across
  two replicas; zero activation-authored operations/outbox entries.
- Missing/default/null/unset behavior before and after upgrade/reopen; exactly one
  new Create materializes default, no backfill on old Create/patch/retry/export.
- Two native Store instances and two IDB transactions race identical and divergent
  extensions; stale prepared local commit fails, exact committed v1 replay under
  reacquired v2 handle returns original durable result; changed ID intent collides.
- Crash/abort before registration commit, after commit before retry, and between
  retry pages; retained future payload activates once after certified registration,
  fair continuation advances past blocked prefix, no extra cursor/ciphertext/echo.
- Invalid origin semantics vs unsupported version remains the right terminal vs
  retryable classification; receive and local compiled WorkBlock checks agree on
  malformed ranges/task refs; raw export/reopen cannot bypass domain/lineage.
- Physical local layout/index rebuild leaves semantic bytes and policy unchanged;
  unsupported old private registration fails clearly without reset. Run real SQLite
  and generated WASM+strict IDB tests, not only mocked JS facts; later composed
  normal-client offline/restart/sync proof must be recorded separately.

## Decisions root must resolve before dependent implementation

1. Approve trusted compiled first-party lineage and its 16-declaration/1 MiB limits,
   mandatory private DTO vs a different explicit representation, and disposable
   fixture replacement. No public plugin registration format is settled here.
2. Keep wire unchanged for this first-party slice, relying on one compiled version
   catalog; or assign a wider authenticated per-operation schema/lineage fingerprint
   protocol before supporting divergent publishers. Merely hashing the local
   manifest does not bind remote operations to it. Public API/publisher lineage
   authorization remains an explicit later decision.
3. Select a real compatible WorkBlock v2 field if desired, or keep v2 as a test-only
   fixture until a product field is approved. Do not weaken current exact compiled
   WorkBlock gates globally just to make generic tests pass.
4. Assign shared records, native Store/domain, WASM/browser and independent review
   owners, resolving active UI/native/host ownership before edits. No destructive
   transform/type conversion is included without a new recoverable semantic plan.

Evidence for this task is source/document inspection and scoped documentation
whitespace review only. No compiler/tests, Rust/WASM build, app, network operation,
main mutation, source edit or extra worker occurred. This contract's new commit
is supplied in the completion receipt; it makes no implemented-migration claim.
