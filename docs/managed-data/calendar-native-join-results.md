# Native Calendar join source result

Owner: CalendarNativeJoinOwner, task `task_965db883c836`, dispatch
`ctx_3b4cc32f6b20`, terminal `term_dd33591a-6916-410e-956b-5cc23e5eba28`.
Branch/worktree: `managed-calendar-native-join` at
`/Users/ctk/orca/workspaces/Zorid/managed-calendar-native-join`.
Contract: `31aafe8f`, review `73dee4a3`, canonical ownership `0778`.
Root retains main integration; this worker has not mutated main.

## Dependencies and public freeze

- Public DTO/helper freeze: `fcdc30fdd0519248b4f1fd9a21e4d2fb4d7465e6`.
- Portable API `cfcdf84d` and public context validation `9cdd273e`, locally
  cherry-picked as `9f4a11e8` / `2da7cd8a` after their owners froze them.
- Store evidence `3882acec3c28aef4c9175d63a81ed9649c96890f`, locally
  cherry-picked as `b823413b` after owner freeze.
- Coordinator acknowledged the host-owned pin state/session function in
  `msg_8f2e83d3f755`; binding owner received exact serde freeze and lifecycle
  coordination in `msg_37ad3cff043c` and `msg_c579a3fedf5f`.

`query_calendar_documents(&mut self, &ClientLease, &mut WorkBlockSession,
&DocumentQueryPin, &mut CalendarJoinState, CalendarRead)` returns the original
`DocumentQueryResult<CalendarReadValue>` header. State is nonserializable,
`Default`, exposes `has_active()` / `clear()`, and belongs to its host pin. Host
must clear/drop it before pin closure/client release and include its single slot
in the document pin's existing eight-cursor ceiling. Native also shares the
WorkBlock session's eight-window-cursor ceiling through a drop guard. The binding
owner owns actual host enforcement and tests; this library does not own host pins.
Continuation tokens rotate on successful delivery and are single-use. Reusing a
consumed/expired token errors; it never restarts against a new generation.

## Implemented source

- Discriminated window/tasks/links DTOs and strict unknown-field rejection, same
  existing lease/WorkBlock session, original EntryIds and task revision witnesses.
- Retained Types YAML and saved Base bytes/presentation/current-entry/search/view
  evaluation in Rust. Selection occurs before the 1,000-task cap, includes done
  tasks, preserves Base order, full companion Base result and original detailed
  diagnostics (task/type/metadata objects tagged with engine).
- All-time inverse membership scans every accepted record, plus bounded existing
  receipt-index evidence. Any live nondeleted reference proves presence. Deleted
  blocks do not count. Uncreated/unresolved records and settled unresolved receipt
  evidence prevent unproven absence. Domain/Store errors fail explicitly.
- No absent task rows during scan. Results paginate only after export and receipt
  summary reach EOF; unknown rows remain unknown under withoutBlocks filtering.
- Windows scan receipt evidence too, avoiding falsely complete nested membership
  evidence for receipt-only collections. Candidate intersection uses the existing
  domain half-open predicate and preserves every candidate/ref in returned blocks.
- Labels resolve original identities independently of selection/completion and
  use the same pin. Visible-manifest absence yields missing, never a live tombstone
  claim. Unavailable labels reduce nested task coverage.
- At admission and final delivery: retained pin validation, exact current document
  local Store ID plus source watermark, same client lease/session/scope, stable
  WorkBlock watermark. Document and WorkBlock counters are never compared. These
  are two-source observations, not cross-Store atomicity or remote completeness.
- One active retained receipt per host state; replacement/links/error clears the
  predecessor. Maximum 1,000 tasks, 8 MiB retained state, 128 combined export/summary
  steps and 8 MiB scanned; each step at most 64 items / 1 MiB. Expanded reply,
  including diagnostics and repeated Type labels, is independently capped at 1 MiB.
  Bounds fail explicitly rather than truncate. Scan bytes exclude expanded encoding.
- Native windows remain at most 31 elapsed days. The frontend owner must split a
  42-day month, pass the first watermark to every segment, and deduplicate by
  record+generation; no native limit increase or new IPC is introduced.

## Verification and limits

Source-only during the native iOS19 heavy turn: **no Cargo, builds, apps, installs,
or Rust test execution**. `rustfmt --edition 2021 --check` on the new source/test
files and `git diff --check` pass. These checks establish formatting/parsing only,
not Rust type correctness or test success.

A source audit corrected fixture enrollment ordering: enroll the empty vault first,
then create files through explicit `FamilyCreateMode::Text`; no legacy enrollment
bypass is used. Nine focused native/real-SQLite tests are authored in `tests/calendar.rs`:

1. Authenticated receipt-only waiting and future-schema input, zero accepted SQLite
   records, unknown task membership and unknown window membership at stable fence.
2. Past live refs prove presence; deleted block refs permit absence after refresh.
3. 1,001 unrelated tasks cannot hide the one saved-Base-selected task beyond cap.
4. Original-ID same-pin labels, missing witness, rename/current-source rejection.
5. Collection-change continuation rejection, links replacement, explicit clear/close.
6. Invalid budgets, 42-day native window rejection, changed expected watermark,
   invalid context and replaced lease.
7. Eight session join slots, ninth explicit limit, clear/drop release.
8. Expanded repeated Type summaries exceed 1 MiB and fail before results delivery.
9. Two bounded month segments share one fence, preserve task/missing labels and
   provide original record+generation identities for deduplication.

The aggregate scan/retention ceilings are explicit source guards; exhaustive
128-page/8-MiB exhaustion execution is not claimed by these authored tests. Final
source review, coordinated focused Rust execution, composed binding lifecycle and
normal Electron proof remain required. No mobile/browser/native UI parity or
Calendar product completion follows from this source result.
