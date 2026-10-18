# Mobile live editor window

Accepted implementation direction, 2026-10-18. This is not implemented/runtime
acceptance. User requires two actual editors visible during an interactive swipe;
snapshots are insufficient. Existing finite navigation is a prerequisite, not the
completed live window. Source grant: Orca `msg_d354eee17d1d`.

Keep at most three actual Markdown editor runtimes globally in one initialized
WK runtime: previous/current/next, projected by native history with process-local
visit tokens and an epoch/revision. Preserve actual live-view cursor, scroll and
undo. Repeated visits may share a canonical document buffer but not view state.
Passive neighbor preparation reads by immutable ID and must not resume checkpoint
recovery or create another autosaving writer. No additional vault/index/client.

During a gesture, display the source and selected target DOM with writing disabled.
Progress only updates presentation; it performs no I/O, focus or history changes.
Cancel restores the source. Commit uses the existing finite request and positive
native ACK as the sole logical commit; only then enable the target's writer.
Rollback drains and reattests the exact source before its correlated terminal.
Lifecycle, revision, identity, attachment and history changes invalidate the loan.

## Named source boundaries

- Native lead creates isolated `MobileEditorInteractionOwner` in
  `mobile-editor-interaction`, recording actual receipts before edits. It owns
  `src/ui/editor.ts` interaction/read-only/transaction authorization plus necessary
  child-table and async-transfer guards in `src/editor/live-tables.ts` and
  `src/editor/transfers.ts`. Agree optional mutation predicate/interaction API
  with the window owner first. Preserve default desktop behavior and distinguish
  external synchronization from authored edits; reuse existing table guards.
- TS owner371 owns new `mobile-document-view-window.ts`, narrow mobile Workspace
  render/ownership/authoring adapter, optional platform interface/bridge and focused
  tests. Preserve Tasks and normal note routes; do not create synthetic user tabs.
- Native lead owns edge progress, window tickets, packet/history projection and
  root/coordinator plumbing in separate isolated sources. No persistent history
  format redesign. Name any helper worker before its narrow history edits.
- Root owns integration; independent composition/source review and one actual WK
  two-editor drag/cancel/commit proof are required. Confirm original live editor
  instances, state and writer fencing, not only screenshots or mock callbacks.

Exact live-window state is the first gate. Dormant state/capsules need an explicit
bounded lifetime/budget contract; arbitrary64-tab-by100-visit undo retention or a
new persistence framework is not required by this slice. Never silently claim
complete history preservation after eviction. Current finite candidate `ddbc83a7`
must finish compilation/runtime proof first. These new changes are excluded from
that freeze, Dev19 and separate NewNote busy-presentation polish.
