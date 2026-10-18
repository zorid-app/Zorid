# Mobile live editor window

Accepted direction updated 2026-10-18 04:48 UTC. This is an implementation plan,
not runtime acceptance. User supersession: Orca `msg_f2da5c302596`; root source
and interface grants `msg_9e9c67f23f8d`, `msg_bd1b57ba7e01`.

One initialized retained WebView per vault owns logical document tabs, selected
tab/document, history, live editor window and route commit. Native owns the
physical host/session, vault picker, Files/Recents/settings/tab overview/chrome
and gesture input. Native renders authoritative web state; it does not maintain
a second document cursor. New Note uses the existing web Workspace/Rust adapter,
without another editor host, core initialization or client claim.

Keep at most three actual Markdown editor runtimes globally: previous/current/next.
User requires two actual editors visible during an interactive swipe; snapshots
are insufficient. Preserve live-view cursor, scroll and undo. Repeated visits
may share a canonical document buffer but not view state. Passive preparation
reads immutable identity without NoteBuffer.load/checkpoint recovery or a writer.

During a gesture both visible views have authored input disabled. Progress is
latest-only presentation, without I/O, history changes or per-frame state results.
Cancel restores the source. Commit follows source flush, immutable target
admission/render and final scope/identity/revision checks; web commits route and
writer together. Publication failure retains latest state for retry and cannot
roll back a committed route. Competing navigation/lifecycle invalidates a gesture;
phase publications for the same accepted gesture do not invalidate themselves.

## Bridge and presentation

Optional webRouting:1 is mutually exclusive with sameVaultNavigation:1. Strict
bounded DTOs pin actual localStoreId/clientId and web session, not a path string.
Ordinary commands carry expectedVersion; replay is bounded and changed-payload
reuse rejected. Gesture end names its accepted begin/session/gesture ID plus
monotonic sequence, rather than borrowing a newer route version. Progress is a
separate resultless event. Native receives authoritative state before applied
result; receipt is presentation acknowledgment, not route authorization.

Actions include open, createNote, new/select/close tab, traverse, logical Home,
gesture begin/end and setPresentation(editor|native). Closing the last tab yields
Home. Logical Home retains WebView/client. Files/Recents overlays do not change
selected tab/history until an open command. Native presentation requires a real
web drain/flush/checkpoint acknowledgment and input revocation before hiding;
editor presentation restores only fresh authority. Actual vault disposal still
uses the existing lifecycle acknowledgment, without timeout-as-success.

Bounded scene-RAM routing is an intermediate proof only. Final delivery preserves
selected tabs/current stable IDs across restart using existing client-scoped
session storage with bounded web-encoded metadata. It does not promise undo
across restart. Metadata caps are64 tabs/100 visits per tab; this does not allocate
an editor or full undo capsule for every visit. Eviction/lifetime is explicit.

## Named source boundaries

- TS371 owns branch/worktree mobile-web-router, base a4ee37ea: new
  src/platform/mobile-web-routing.ts, src/ui/mobile-web-router.ts,
  src/ui/mobile-document-view-window.ts, narrow mobile Workspace adapter and
  optional platform seams/tests. Root mobile-web-router-2 is integration reserve,
  not a second implementation owner. Preserve Tasks and ordinary desktop routes.
- Editor owner term_0f955add in mobile-editor-interaction owns src/ui/editor.ts,
  src/editor/live-tables.ts and transfers.ts plus focused tests. Optional active
  interaction state defaults to desktop behavior. Inactive construction disables
  editing before plugin mount; temporary writer freeze keeps contenteditable and
  focus/keyboard. Every refresh invalidates old async authoring authority.
  Narrow context-menu.ts caller/platform ownership is granted for owned menu
  lifetime/epoch validation, including role side effects. Passive neighbors must
  not dismiss another editor's menu. Native IPC changes require exact named hunks.
  Existing reviewer term_a0c7b independently reviews exact source; no duplicate audit.
- Native lead owns retained physical host/plugin/gesture presentation. Existing
  helper reviewer term_c6a reviews exact gesture/packet changes. No native document
  history authority may be reintroduced behind the new capability.
- Native Pages owner term_1f2f receives external-services initializer/backend/UI
  scope after exact API agreement with native lead and TS371. Pages receives typed
  operations, not raw root/session/lease. Listing/search/mutations use the same
  initialized web core boundary. Reads cannot claim/release the shared client;
  hiding cancels UI delivery, not durable operations. Original mutation/recovery
  identity survives uncertainty. Existing pending native journals require explicit
  same-client recovery/admission before activation, never silent erasure/rebinding.
- Root alone integrates confirmed source into main. No new Rust, NoteBuffer or
  storage API is granted by this plan. Exact source review and a composed actual
  WebKit two-editor drag/cancel/commit proof remain required, including writer
  fencing and retained view/undo state. Source checks are not physical proof.

## Superseded candidate and delivered baseline

Old native-authoritative ddbc83a7 is archived/reference only. Simulator20 preflight
stopped before compilation; there is no old build/runtime prerequisite. Dev19
remains installed/open on the physical iPhone, unchanged. Its Simulator19 create,
save and loaded-editor reopen proof does not establish the new routing/window.
Busy-skeleton source3bd remains separate until composed review and verification.
