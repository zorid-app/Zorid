# Task / Base Calendar implementation ownership

2026-10-18 04:22 UTC. Coordinator: managed Run run_7a10da5526b5. Proposed
isolated batches under reviewed contract31aafe8f / review73dee4a3. Root alone
integrates main. Source grants must be acknowledged before edits; this table
reserves names, not live terminals or acceptance. Actual Task/Dispatch/terminal
receipts will be appended before each worker starts editing.

| Owner / planned worktree | Exclusive source scope | Dependency / acceptance |
| --- | --- | --- |
| CalendarStoreEvidenceOwner / managed-calendar-store-evidence | crates/zorid-store/src/managed_records.rs bounded authorized unresolved summary; new focused Store test | Existing receipt index, no schema/index changes. Receipt-only waiting/incompatible before first state must prevent false absence; stable collection fence and bounded scan. |
| CalendarTaskProjectionOwner / managed-calendar-task-projection | NEW crates/zorid-bases/src/calendar.rs and tests/calendar.rs; narrow tasks.rs and lib.rs | Same Rust-selected Base membership before cap, shared Type projection, no managed Store dependency/JS evaluator. Preserve saved view/search/limit/order/context and explicit diagnostics. |
| CalendarNativeJoinOwner / managed-calendar-native-join | NEW crates/zorid-native/src/calendar.rs/tests/calendar.rs; narrow document_api.rs/document_index.rs/workblocks.rs/lib.rs | Store summary + portable selection APIs freeze first; same lease/pin/current-source admission, distinct document/collection counter domains, bounded global inverse join/labels/windows/receipts. |
| CalendarDesktopBindingOwner / managed-calendar-desktop-binding | NEW src/core/calendar.ts; optional document-semantics.ts read, platform/desktop-document-semantics.ts, desktop/document-semantics.cjs/.d.cts; crates/zorid-desktop-host/src/documents.rs and scoped workblocks.rs only if needed; focused codec/host tests | Native DTO freeze. Existing channel/lease, strict request/response checks, no handles to renderer or mutation DTO redesign. |
| CalendarSchedulingOwner / managed-calendar-scheduling-ui | src/calendar/controller.ts/view.ts/view.css; NEW canvas.ts/continuation.ts/task-picker.ts as concrete reuse; focused tests | Agree binding/controller contract early. Exact pending refs, 64KiB single-owner durable continuation, original replay before next-task admission, partial-link/restart/storage-fail/no-loss close. Existing standalone remains functional. |
| BaseCalendarViewOwner / managed-base-calendar-view | NEW src/bases/calendar-view.ts; narrow session.ts/document.ts/toolbar.ts/toolbar-config.ts/shared-query.ts/controller.ts; focused tests | Shared canvas + optional read DTO. Saved IANA/captured clock, named pane/embed lifecycle/readonly, async close veto and no JS query imitation. |
| CalendarWorkspaceOwner / managed-calendar-workspace | Exact Calendar/Base hunks src/ui/workspace.ts, additive Calendar storage key in workspace-window.ts and named embed option threading | Reconcile canonical Tasks integration first. No NoteBuffer/native/mobile signatures/editor polish. One trusted vault/window continuation owner and guarded original-ID note open. |
| CalendarIndependentReviewOwner / managed-calendar-join-review | NEW scoped review document only | Review Rust/DTO/controller composition and meaningful negatives alongside source development. Later one frozen native+frontend+Electron UI proof, both themes/narrow/keyboard/task-to-grid proposal; close all owned apps. |

Source workers may prepare independent new-file groundwork once root grants the
named scope. Shared API owners agree DTOs before dependent edits. Heavy checks
serialize against actual machine load; iOS slots apply only to iOS. Browser-v1
runtime proof and portable-origin helper work retain their existing frozen source
ownership and must not be changed by these batches.

Generic file-date calendars remain required later; this slice delivers linked
WorkBlocks in the common Calendar and Base view. Spaced repetition is removed.
