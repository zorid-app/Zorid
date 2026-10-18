# Bounded managed-record schema evolution proposal

Status: Phase 2 recommendation, 2026-10-17; no implementation or public plugin API
freeze. No arbitrary plugin migration callbacks. This document answers how a
future plugin could evolve managed records using the existing Rust authority.

## Ownership, dependencies and evidence boundary

Owner: dispatched schema-contract worker `task_f6dab800a546`, dispatch
`ctx_6f4f6ea6b33f`, terminal `term_c08c861a-b861-4259-bc0e-acc495f9474e`.
Branch: `tingkai-c/managed-schema-evolution-contract`; worktree:
`/Users/ctk/orca/workspaces/Zorid/managed-schema-evolution-contract`.
Only this new document is owned/changed. Main integration remains with the
shared-core coordinator; normal-worker host implementation proceeds separately.

Source baseline: checkout `2edada5b4e52c582154f210c893dee401812b804`.
Browser source was read separately at `tingkai-c/managed-records-browser`,
`9692e1bfa07ba71b95b2a10d63186b6d9f7a7087`; portable admission/WASM source
at `tingkai-c/managed-records-integration`,
`8bf1ca0603f3d6e68a93229f9f9d4c712d543e0c` (clean when inspected).
Those later files are absent in this proposal's base. Links to them below name
integration targets and are conditional on composing that batch; do not interpret
this branch as already containing them. Line anchors refer to these inspected
revisions, not future moving heads.

Read [execution checkpoint](../deferred-product-roadmap.md#execution-checkpoint--shared-core-coordinator),
[findings](../user-findings.md), [implementation plan](implementation-plan.md#versions-and-migration)
and [portable contract](portable-record-contract.md#versions-unknown-fields-and-limits).
Phase 2 depends on the reviewed Phase 1 admission/browser batch and explicit
ownership of its existing seams. This contract adds no work to the editor/mobile
owners and does not establish native, browser-host or cross-device runtime parity.
Verification here: source inspection and documentation checks only; no network,
compiler, heavy build or runtime test. The document's commit is reported in the
worker completion receipt rather than embedded as a self-referential hash.

## What the source actually supports

| Area | Observed behavior and gap |
| --- | --- |
| Schema representation | [`Schema`/`Field`](../../crates/zorid-records/src/lib.rs#L103) hold collection ID, positive version, policy and bounded typed field map, required/nullability/default. There are **no label, index, migration or compatibility-lineage declarations**. [`Schema::validate`](../../crates/zorid-records/src/lib.rs#L113) validates one schema, not its relationship to an older schema. |
| Defaults | [`State::prepare`](../../crates/zorid-records/src/lib.rs#L487) materializes omitted defaults into a local **Create** operation. Explicit values/null/unset take precedence subject to validation. Restore/receive do not fill defaults. Sets reject defaults/nullability. Required non-set fields must be present in each Create ([validation](../../crates/zorid-records/src/lib.rs#L376)); adding a required scalar with a default does not repair an old Create. |
| Portable versions | [`State::validate_operation`](../../crates/zorid-records/src/lib.rs#L326) requires only a nonzero operation schema version; it does not prove that version compatible. [`restore`](../../crates/zorid-records/src/lib.rs#L250) replays retained history under the supplied schema without relabeling operations. Portable acceptance alone is not version authorization. |
| Unknown fields | [`union`](../../crates/zorid-records/src/lib.rs#L272) preserves remote supported fields, infers consistent kinds across retained operations, and counts unknown fields/pending history against limits. Known-field patches preserve that history; local unknown writes fail in [`prepare`](../../crates/zorid-records/src/lib.rs#L501). These protections do not bypass the host's version gate. |
| Native registration | [`managed_register`](../../crates/zorid-store/src/managed_records.rs#L377) uses an IMMEDIATE transaction. Exact repeat retains revision; change requires higher version, identical existing field declarations and unchanged policy, then restores every accepted state. It does **not explicitly require added fields to be optional**: an empty collection can accept a new required scalar, and intrinsic-empty sets make required additions another gap. Changes to existing defaults are rejected by full `Field` equality. |
| Native received versions | [`activate`](../../crates/zorid-store/src/managed_records.rs#L820) retains any different operation version as `incompatible_schema`, including a legitimate old offline write after an additive upgrade. Raising registration to v2 therefore does not currently implement mixed-v1/v2 admission. |
| Retention/retry | [`receive_in_transaction`](../../crates/zorid-store/src/managed_records.rs#L878) binds exact authenticated source, receipt/status, sources and changes; its caller owns the shared cursor transaction. [`retry_in_transaction`](../../crates/zorid-store/src/managed_records.rs#L650) reuses retained exact plaintext with bounded fair continuation. Accepted/integrity-conflict/invalid-operation receipts are excluded from retry. Registration/local commits/accepted incoming changes trigger bounded passes; host startup/foreground must drive remaining work. Quota failure aborts durable receive rather than silently advancing. |
| Browser registration (later batch) | [`register`](../../src/core/browser-managed-records.ts#L305) validates with Rust inside the IDB transaction, revalidates matching accepted states, preserves exact-repeat revision and rotates changed revision. It does not itself call `retryPage`; lifecycle wiring must schedule replay after registration. [`retryPage`](../../src/core/browser-managed-records.ts#L563) reopens retained authenticated wire and CASes durable effects/continuation. |
| Shared admission/WASM (later batch) | [`registration_change`](../../crates/zorid-records/src/admission.rs#L211) carries the same additive check; [`received_gate`](../../crates/zorid-records/src/admission.rs#L85) still requires exact version. [`validateRecordsRegistration`](../../crates/zorid-wasm/src/records.rs#L308) delegates to that Rust check and accepted-state validation restores history. This is private adapter plumbing, not a plugin migration API. |

Existing [native fixture](../../crates/zorid-store/tests/managed_records.rs#L442)
covers a future-version retained payload becoming accepted at matching version;
it does not demonstrate safe old-version edits after an upgrade. Existing
[policy fixture](../../crates/zorid-store/tests/managed_records.rs#L466) rejects
local-to-synced conversion. These tests were inspected, not rerun for this task.

Thus “optional additions/defaults/indexes are supported migrations” overstates
current support: defaults at creation exist; optional additions can register;
index declaration/evolution does not exist; mixed-version semantic compatibility
and label metadata are planned. The portable contract's unknown-field promise is
real at the causal-state layer but not unrestricted future-version receipt
admission in current hosts.

## Proposed first contract: add declarations, never rewrite history

A feature/plugin update supplies a **trusted declarative collection schema** to
the host. Rust validates compatibility; the app persists registration and handles
normal records sync. A compatible upgrade emits no synthetic record edits and
runs no plugin code. Records retain original operation IDs, causal parents,
origin versions, conflict candidates, set tags, generations and tombstones.

Keep feature release, collection schema, wire/action semantics and local DB layout
versions independent. A numeric version increase is not evidence of compatibility.
For the first bounded implementation, allow only this table:

| Change | Decision |
| --- | --- |
| Exact same registration | Idempotent; retain registration revision and current handles. Maintenance may independently replay receipts. |
| Add optional supported field | Allowed with higher collection version and certified predecessor. `required=false`, any otherwise valid nullability/default; preserve every old field declaration exactly. Optional set has no default/null and is intrinsically empty. |
| Version-only bump | Allow only as an explicit identity step in the same certified lineage; do not imply a data transform. Prefer avoiding unnecessary bumps. |
| Change display label | Keep stable collection/field/member IDs. Presentation metadata belongs outside this semantic schema; no record migration. Label storage/sync is not implemented here. Never rename an ID to rename a label. |
| Add/rebuild local query index | Later core-owned, rebuildable projection work; no authored semantic operation or collection-version bump solely for a physical index. No arbitrary SQL/index declaration is promised. Query ordering must be specified before an index exposes new semantics. |
| Remove/rename/reuse ID; change kind, required, nullability or existing default | Reject, including apparently permissive changes. This deliberately narrow rule avoids origin-dependent interpretation and old-history revalidation surprises. A new field ID is possible; copying/translating values is a separate future migration. |
| Change synced/local/cache policy or scope | Reject for an existing scoped collection, even if empty. Collection identity is realm/vault/owner/collection. Policy conversion needs a separately authorized export/import/retention design. Incoming data cannot change registration/policy. |

For a newly optional scalar with default `"normal"`, old records stay **absent**.
Only new Creates authored under that declaration materialize `"normal"`. An old
offline Create arriving later stays absent too. Reopening/rebuilding/registering
must not invent a write; patch/unset must not reapply a default; null remains null
when allowed. A UI may render a placeholder for absent data, but filtering/export
must use actual stored values, not a hidden fallback. An optional `Unset` default
is redundant but remains legal if the current validator allows it. Do not alter
existing defaults in this slice: a fresh default requires a new field ID or a
separately specified future creation-policy change.

## Version authorization and old offline edits

Recommendation: retain a bounded, trusted **lineage of full schema declarations**
for this scoped collection, supplied by first-party release code initially. Each
step is validated with the rule above; one version maps to exactly one canonical
declaration. This is host registration evidence, not a remotely self-declared
compatibility flag. Exact representation/private DTO remains an implementation
choice; cap the lineage (proposed 16 declarations) and total bytes within existing
registration bounds. Hitting the bound blocks an upgrade explicitly; no eviction
of compatibility history is authorized. Version gaps require declarations for
actual supported versions, not invented intermediate numeric versions.

Admission may accept an operation only if its origin version is explicitly in
that validated lineage and is no newer than the active schema. Validate the
operation under its origin declaration (allowing already-supported unknown-field
retention), then union under the active schema, applying all existing causal,
type, scope, capacity, restore and equivocation checks. Do not replace the equality
gate with `version <= current`: that would authorize unproven versions. Validate
accepted history under the same rule on reopen and registration. A mixed-version
payload passes only if every operation passes; no partial acceptance. Required
fields present from the first supported declaration remain required.

Example: desktop v2 adds optional `priority` and accepts phone's delayed v1
`title` patch unchanged. Another v2 `priority` patch merges by the existing
per-field causal rules. A v1 client receiving v2 payload currently retains it as
`incompatible_schema`; it does not get to interpret uncertified future schemas.
After upgrading/registering v2, replay activates it without resealing or changing
IDs. If a v1 operation names a withheld v2 parent, it stays waiting until the
parent can be accepted. Editing known fields in a state already containing
supported unknown fields preserves them, but future-version withheld state is
not advertised as visible or causally observed by that old client.

Incompatible/future/unlisted versions remain observable unresolved receipts with
exact authenticated bytes and no accepted projection mutation. Version mismatch
is evaluated before semantic application so it remains replayable, rather than
being frozen as `invalid_operation`. Unknown wire action/value encodings are a
different boundary: current canonical decoder rejects them before semantic
receipt classification ([wire decoder](../../crates/zorid-records/src/wire.rs#L44)).
Do not promise a managed unresolved receipt/cursor advance for undecodable wire;
retain the existing dispatcher failure/no-progress behavior until opaque-family
retention is separately specified. Compatible typed unknown fields still require
consistent inferred types and bounded resources.

## Repeated/concurrent registrations, replay and crash boundaries

Registration remains a serialized durable host transaction, never an offline
synced migration event. Same declaration/lineage is idempotent. A stale lower
version is rejected without downgrade. Different declarations for the same
version are rejected, not merged or resolved by registration arrival order.
Two locally racing valid successors: transaction serialization chooses the first
commit; a second request must prove extension of the now-current lineage or fail
and reload. Independent devices with divergent same-version declarations must
not be described as convergent: there is currently no schema hash in each wire
operation. Trusted first-party release manifests must guarantee identical
version meanings; arbitrary third-party simultaneous schema publication remains
a consequential later gate. Do not union competing manifests automatically.

Rotating registration revision invalidates old handles and prepared plans;
current native [authorization](../../crates/zorid-store/src/managed_records.rs#L171)
already fences stale handles. Check registration revision again in the final
commit; old pending local requests must reacquire current authorization. Exact
previously committed local retries must return their durable prior result,
before comparing a fresh record revision or recomputing defaults. The native
[replay journal](../../crates/zorid-store/src/managed_records.rs#L488) supports
that ordering after authorization; a stale handle itself remains rejected.
Portable [`prepare` retries](../../crates/zorid-records/src/lib.rs#L504) check
current schema version and can collide across upgrades, so adapters must not
substitute a fresh portable preparation for the durable replay journal. Reusing
an operation ID with a different target/request remains an integrity error.

Commit registration only after all accepted states validate under the candidate;
rollback preserves registration, handles, history and projections. Compatible
registration does not change projection values or author outbox work. Then drive
bounded unresolved maintenance on registration, startup/foreground and accepted
parent/restore-source progress. Native's in-transaction first page and browser's
post-commit scheduled page may differ; neither promises that registration drains
all pending work before returning. Persist continuation and expose status; do not
spin until completion or starve later receipts behind an incompatible prefix.

Replay uses retained authenticated wire/plaintext and the same shared Rust
admission rules. Status/state/projection/change sequence commit together; replay
never advances a second relay cursor, recreates ciphertext or duplicates durable
accepted-change events. A crash between bounded passes may reexamine a receipt,
which must be harmless. Integrity conflicts stay quarantined; invalid operations
are not revived by a compatible upgrade. Quota/IO failure preserves the prior
durable boundary and is reported. Causal missing-parent pending and schema-
incompatible receipts are distinct states; pending in-memory union is never a
durable accepted result until dependencies and the complete candidate validate.

## Local layout upgrades are a separate mechanism

SQLite DDL/version changes and IDB object-store/index upgrades describe **local
physical storage**, run by app-owned adapters under their existing exclusive
upgrade/transaction rules. They may rebuild derived projections/indexes from
retained authority; they do not change origin versions, plaintexts or policies,
and they emit no synced record edits. Reopening an older unsupported local
format must fail explicitly, not reinterpret it. Development fixtures can be
recreated under existing disposable-data authorization; real user vaults cannot.

A **synced semantic migration** would transform user meaning (type conversion,
backfill, field removal, split/merge). It would need deterministic operation
identity, provenance, concurrent/offline-write rules and recoverable retained
source. Idempotent callbacks or a DB schema bump cannot supply those guarantees.
Defer this mechanism. No arbitrary JS/Rust plugin callback, device lease or
single migration flag is introduced for this additive slice. Example plugin
behavior initially is “declare a new optional field, update code to handle
absence, and let the host validate/register”; not “loop over all records on every
startup.” Data remains exportable without executing plugin code.

## Smallest implementable followup and acceptance

Recommend two coherent bounded commits, with independent review before main
integration. Reconcile these proposed file assignments with the active normal-
worker host owner before source edits; this document grants no source ownership.
Do not edit root manifests, editor seams or native/mobile UI for this work.

**A. Enforce the declared boundary first, without widening receipt versions.**
One Rust owner: `crates/zorid-records/src/admission.rs` and new
`crates/zorid-records/tests/schema_evolution.rs`; validate both inputs/scope and
require each added field to be optional. Existing `Schema` validation stays the
single value validator. Native adapter owner:
`crates/zorid-store/src/managed_records.rs` and
`crates/zorid-store/tests/managed_records.rs`; consume shared admission after the
Phase 1 delegation batch. WASM/browser owner only if plumbing/tests need changes:
`crates/zorid-wasm/src/records.rs`, `src/core/browser-managed-records.ts`,
`tests/browser-managed-records.test.ts`. This first commit is useful on its own
but must continue reporting mixed-version receipt admission as unsupported.

**B. Enable explicitly certified older-version edits.**
Same Rust owner adds bounded private lineage validation/admission in
`crates/zorid-records/src/admission.rs`, with focused origin-operation validation
helpers in `crates/zorid-records/src/lib.rs` only if necessary and fixtures in
`crates/zorid-records/tests/schema_evolution.rs`. Native owner changes only
`crates/zorid-store/src/managed_records.rs` plus its existing tests for durable
registration evidence/reopen/retry. WASM/browser owner changes only
`crates/zorid-wasm/src/records.rs`, `src/core/browser-managed-records.ts` and
`tests/browser-managed-records.test.ts` for private registration bytes, final
transaction checks and lifecycle replay trigger if the Phase 1 host has not
already supplied it. Reuse registration blob storage if possible; if physical
schema changes prove necessary, obtain named `crates/zorid-store/src/lib.rs`
ownership separately. Wire/protocol/server changes are excluded from this
smallest first-party manifest approach. Changes to host wiring outside those
files require a fresh named seam assignment, not incidental edits.

Acceptance fixtures (run bounded focused suites, serialized with actual machine
load; do not infer full product verification):

1. Reject required scalar/defaulted-required/set additions even with no records;
   reject removal, type/nullability/default/policy changes, downgrade, scope
   mismatch and same-version divergence; no state/revision/outbox change on error.
   Exact repeat retains revision; accepted additive change rotates it and fences
   old handles/prepared commits in SQLite and IDB.
2. Existing missing field, explicit null/unset, old offline Create, defaulted new
   Create and reopen produce exactly the specified history/projection; no replay
   backfill. Default omission becomes one authored Create value only. Set empty
   membership, tombstones and generations survive registration unchanged.
3. v1 delayed known-field patch/Create plus v2 optional-field writes, including
   reorder/concurrent same-field writes, converge after a valid v1->v2 manifest;
   original versions/IDs/parents/tags/conflicts remain byte-identical in export.
   Unlisted older version and uncertified future version stay unresolved; no
   `<= current` shortcut. Unknown supported fields survive known patches, but
   inconsistent unknown kinds and limits still fail safely.
4. Same numeric version with differing declaration is rejected locally; racing
   registrations across Store instances/IDB transactions preserve one valid
   lineage and stale contenders retry explicitly. A/B device fixtures use the
   same trusted manifest; no unsupported fork-convergence assertion.
5. Retained future receipt becomes accepted after registration; old receipt
   becomes accepted only after certified lineage admission. Missing parents and
   restore sources complete across multiple passes. More than one retry page,
   incompatible prefix, restart mid-page and concurrent replay demonstrate fair
   progress/no duplicated accepted events. Exact wire/plaintext/dedupe/cursor and
   authored outbox bytes remain unchanged.
6. Inject failure after registration write, receipt status, state/projection and
   change publication; reopen sees either whole old or whole new transaction.
   Browser post-registration crash recovers via startup maintenance. Replayed
   committed local request after upgrade returns the original durable result;
   differing request/target with the same ID fails. Local/cache never enter sync.
7. Equivalent semantic fixtures run through portable Rust, native SQLite and
   real generated WASM + IndexedDB (mock-WASM tests alone are insufficient).
   Normal browser worker and actual desktop/CLI cross-device sync remain later
   explicitly reported runtime gates; this proposal claims none of them.

## Consequential choices to resolve before B

- Approve trusted bounded full-schema lineage and its 16-entry cap, or choose
  strict equality until a stronger wire schema identity exists. Recommendation:
  use lineage for first-party collections; defer public plugin contracts.
- Decide whether older clients should eventually admit certified newer optional
  fields without upgrading. Recommendation for this slice: retain future-version
  receipts until upgrade; unknown-field storage is not blanket future semantics
  authorization.
- Decide schema-fork detection for third-party publishers before exposing this
  generally. Recommendation: no public plugin migration promise until immutable
  version identity/manifest provenance (possibly wire-bound schema digest) is
  specified and tested. Do not assume today’s version integer prevents forks.
- Approve creation-only defaults with no backfill or choose a separately planned
  semantic transform. Recommendation: creation-only, immutable existing defaults;
  postpone semantic backfill/type conversion rather than hide writes in reads.

None of these choices blocks A's validation tightening or the independent normal-
worker host slice. No decision here authorizes destructive migration, public API
release, policy conversion or broad Tasks/Calendar implementation.
