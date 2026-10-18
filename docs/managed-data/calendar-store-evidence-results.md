# Calendar Store unresolved evidence

2026-10-18. CalendarStoreEvidenceOwner, task `task_d1ad7e300591`, dispatch
`ctx_9141e0dedf28`, branch/worktree `managed-calendar-store-evidence`, based on
`a1d9d64f`. Root grant `msg_f1f28718656f`; canonical amended contract `31aafe8f`,
review `73dee4a3`, owners record and current roadmap/user findings read before
source. Root alone integrates main.

## Source and API freeze

The coordinator accepted the API in `msg_2c204a3c8265` and additionally assigned
only the three new DTO re-exports in `crates/zorid-store/src/lib.rs`. The Store
source is otherwise limited to additive summary types and one new method in
`managed_records.rs`; no existing mutation/export/receipt behavior changes.
NativeJoinOwner was sent exact DTOs and semantics in `msg_6badfc3c0aa0`, and the
independent reviewer in `msg_e73d8831c290`.

```rust
Store::managed_unresolved_summary(
    &self,
    handle: &ManagedCollection,
    expected_watermark: &str,
    continuation: Option<&ManagedUnresolvedCursor>,
    limit: u32,
    byte_limit: u32,
) -> Result<ManagedUnresolvedSummary>
```

`ManagedUnresolvedSummary` exposes `evidence: ManagedUnresolvedEvidence`,
`complete: bool`, `examined: u32`, `bytes: u32`, and
`next: Option<ManagedUnresolvedCursor>`. Evidence variants are `Unknown` and
`None`. Complete strictly means index EOF; any partial scan returns Unknown,
even if all examined rows are accepted. At EOF, any nonaccepted receipt retained
across all steps yields Unknown; only EOF with all accepted yields None. None
means no unresolved receipt in this collection observation, **not** proof of
absent task membership or global/remote completeness.

The cloneable native-only cursor has private collection-handle, watermark,
last-update and sticky-unresolved fields. It has no serde implementation. Each
step reauthorizes the real handle (Store/process/enrollment/registration), checks
all handle identity fields and exact canonical watermark against the cursor,
and fences the receipt read before/after in one SQLite read transaction. A
changed fence requires explicit refresh. Native must also fence before delivery;
this is no cross-store transaction or claim about changes after observation.

The existing `managed_receipts_retry` index is used directly. Initial and resumed
queries use collection plus an update-ID range, avoiding an OR predicate that
could rescan the accepted prefix. At most 64 metadata rows are fetched. Source
`payload_bytes` are charged conservatively without fetching receipt payloads;
steps admit at most 1 MiB. A receipt exceeding the caller's remaining step budget
errors if it cannot make progress. A full item page requires another step to
establish EOF. No raw receipt payloads or public receipt/record-key fields are
returned. No schema/index/wire/dependency changes were made.

Native owns the retained continuation, shared 128-page/8-MiB aggregate accounting
with record export, and conversion of incomplete/error/domain uncertainty into
unknown membership. Positive projected references can still establish presence.
Per-record unresolved counts cannot establish collection absence; receipt-only
waiting/incompatible rows are explicitly included here.

## Authored regression evidence

New `crates/zorid-store/tests/calendar_evidence.rs` reuses the narrow existing
managed fixture pattern: real SQLite Store, enrollment and registration, sealed
records envelopes, authenticated `family_receive`, and public APIs. Its five
focused tests cover:

- Waiting and incompatible receipt-only records before first accepted state,
  empty export and unchanged watermark; summary remains Unknown.
- Mixed accepted record and receipt-only unresolved record despite the exported
  record having no unresolved counts; parent settlement invalidates old
  continuation/fence and explicit fresh scan establishes None.
- 65 accepted receipts across the 64-row limit; byte-limited retained progress,
  unknown partial pages, final EOF, invalid limits and oversized single steps.
- An empty second collection gives only scoped None; wrong collection,
  noncanonical/wrong fence, reopened Store, stale registration and a refreshed
  handle with an old cursor are rejected.
- An unresolved first page remains Unknown after a final all-accepted page.

## Validation and remaining gates

**Source-only; Rust compilation and all five tests are unrun.** Coordinator
explicitly prohibited Cargo/build while the iOS19 heavy turn is active. Rustfmt
was used only for new tests and isolated new source fragments; existing source
was not reformatted. `git diff --check` passes. No compiler, Cargo, build, app,
simulator or native/UI parity check was run by this worker.

Independent source reviewer `msg_d38c9dd47e87` inspected the summary and all
five authored fixtures and found no concrete early Store blocker; final approval
still requires exact frozen-source review and executed focused checks. The
coordinator must schedule bounded `cargo test -p zorid-store --test calendar_evidence` (with
serialized compilation/test concurrency appropriate to actual load), review
results, and integrate coherent verified changes. Native join must exercise
these facts in its receipt-only membership negative regression and enforce the
shared scan ceiling; Store fixtures alone do not prove Calendar delivery.

After the frozen commit is supplied, `managed_records.rs` is released for the
coordinator's explicitly serialized transfer to the forthcoming origin-adapter
owner. No concurrent source editing or main integration is authorized here.
