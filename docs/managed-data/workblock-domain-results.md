# WorkBlock v1 portable domain results

Owner: dispatched worker `term_cced0a6e-3d93-4f62-9619-76e1d885f216`, task
`task_131c6d38b440`, dispatch `ctx_99ac115238ad`; isolated branch/worktree
`tingkai-c/managed-workblock-domain` / `managed-workblock-domain`, based on
`e5a5405b` (includes the `afb3947` records registration guard). Main integration
remains exclusively with the root coordinator. No native/mobile/reference parity
is claimed by this work.

## Ownership and dependencies

Initial new-file scope: `crates/zorid-records/src/first_party.rs`,
`crates/zorid-records/tests/workblocks.rs`, and this report. Coordinator relayed
root grants `msg_f7c1ff6a5f54` and `msg_40f9a166b912` authorize exact existing
records `lib.rs`, `admission.rs`, `wire.rs`, records `Cargo.toml`, and the three
corresponding dependency edges in `Cargo.lock`. Reuse existing locked
`chrono =0.4.45`, `chrono-tz =0.10.4` (both std, no default features) and core
`EntryId`; no version selection or root manifest changes. Store/WASM hooks were
authorized but proved unnecessary: their existing registration checks and
State restore/prepare/admission/export delegates already reach the domain hooks.

Source commit: `8351b8e8` (implementation and all 12 focused tests); this
report is a separate documentation commit.

Contract: sibling `managed-firstparty-consumer-contract` first-party consumer
contract `b8bcdc10` (initial `5fb80202`, sequencing `d3494464`, and narrowed
ownership/native page refinements). The domain does not add a public plugin API,
callbacks, another outbox, cursor authority or replication path.

## Implementation

- Exact trusted owner `zorid_firstparty_calendar`, collection `workblocks`,
  Synced schema 1: required non-null atomic Object `range`, optional non-null
  String `title` (512 UTF-8 bytes), optional Set `task_refs` (64 visible core
  EntryIds). Empty references permit standalone blocks. Alternate declarations,
  defaults, policies or versions cannot disable compiled semantics. Existing
  unknown outer fields remain losslessly preserved on remote admission.
- Range has exactly `start_ms`, `end_ms`, `timezone`: canonical signed i64 decimal
  strings, chrono-representable instants, `end > start`, and parsed IANA zone.
  No arbitrary 1970–2100 bound. Local wall-time conversion rejects gaps and
  requires an explicit matching seconds-east-of-UTC offset for DST folds.
- `State::new` performs a pure declaration check, with no constructor recursion.
  Full operation validation checks every incoming/local candidate, even pending,
  overwritten or losing writes. Snapshot/export validates domain history and
  projected reference capacity. Union checks the complete candidate state before
  installation; overflow returns `Limit` and existing admission retains `Capacity`
  for retry. No truncation or partial accepted-state mutation occurs.
- Wire-only private structural constructor and operation checker preserve the
  existing canonical/static checks. Domain-invalid and future-schema payloads
  still decode structurally so authenticated admission can retain InvalidOperation
  and IncompatibleSchema respectively. The structural helpers are not public.
- Typed helpers produce fixed registration, create/range/title/add/remove/delete
  commands, all conflict candidates, and structural EntryId references. Removal
  uses observed add tags. Existing one-action-per-field semantics mean hosts
  sequence multiple reference edits through the existing queue, not a fabricated
  multi-file/record transaction. Reference ingestion never checks note existence.
- Window queries use half-open intersection, include any intersecting whole-range
  conflict candidate, and cap windows at 31 days. `query_page` caps input at 200
  states and 1 MiB of snapshot bytes and forwards the host continuation unchanged
  with `incomplete`. Hosts still authorize pages and own revision/watermark fencing;
  native `managed_export` retains its existing 64-row page cap. These helpers do
  not establish snapshot-consistent pagination independently.

## Verification

All commands are offline and bounded with `-j1`; no concurrent heavy compiler or
Xcode process was present when compilation began. No iOS build was performed.

1. Initial 8-case WorkBlock run: 5 passed, 3 failed at the known wire scratch-schema
   boundary. This result motivated the explicitly granted structural-only seam;
   no assertion was weakened.
2. `cargo test -p zorid-records --offline -j1`: 72 passed (62 existing and 10 new),
   plus empty unit/doc-test targets, after the wire correction.
3. `cargo test -p zorid-records --test workblocks --offline -j1`: 12 passed after
   adding a malformed-range path table and query-page byte-budget check.
4. `cargo test -p zorid-records --test workblocks future_schema_decodes --offline -j1`:
   1 passed (overlaps the 12). Final targeted future-schema test includes a
   malformed future range as well as valid range/Delete, proving version-gate
   precedence over domain invalidity.
5. `git diff --check`: passed.

Coverage includes local/received/accepted-state restore equivalence, actual
Payload encode/decode before admission classification, missing-parent malformed
candidates, future Delete schema rejection, canonical strings/overflow/zone/range
keys/order, pre-1970/post-2100 instants, DST gaps/folds, UTF-8 title limits,
concurrent atomic range candidates, overwritten invalid history, invalid refs,
unknown-field preservation, observed removal, concurrent capacity/no mutation/
retry after removal, and bounded window/page continuation/byte handling.

## Remaining gates

Independent worker R inspected the final source and all 12 tests and reported
no remaining source blocker (`msg_03e7b9b368fc`); exact committed-hash approval
is being relayed separately to the coordinator before root integration.
This report establishes portable Rust behavior and existing adapter callsite
inspection. It does not prove durable Store receipt transactions with these
specific fixtures, actual WASM execution, normal browser/desktop consumer
activation, UI, encrypted multi-client convergence, or native/mobile behavior.
Native/browser hosts must supply authorized bounded listings, revision fencing,
semantic DTO admission, and ordinary local-queue operation identities. No test app
was opened. Task/config/UI work remains with its separately named owners.
