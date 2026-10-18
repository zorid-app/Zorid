# Desktop Calendar source and verification

Worker C, dispatch `ctx_cda0bb2b5600`, task `task_2c808419ce2a`, owns the isolated
`tingkai-c/managed-calendar-desktop-ui` branch and worktree of the same name.
Source candidate: `1cec325f`, based on B binding `65a2dfdb`. Coordinator alone
owns integration. No binding, Rust, native, bridge, mobile, NoteBuffer or editor
implementation files were edited. Preserve native371's strict-eight-field
`hideNativeEditorToolbar` initializer when composing the exact Workspace hunks.

## Implemented scope

- Calendar ribbon destination and command-palette entry, month/week/day/list,
  previous/next/Today, and local-date/view state in the existing vault/window
  session. Daily notes remain separately available. Calendar resources follow
  the existing tab parking, split transfer, close and vault-release lifecycle.
- Real optional `PlatformVault.workBlocks`, used directly through the typed
  `WorkBlockService`. Unsupported vault/platform presents an unavailable message.
  There is no product memory backend, Google setup, task indexing or task-link UI.
- Timed standalone creation; explicit title and whole-range saves with the read
  revision; deletion with an explicit second confirmation. Native Create uses
  one immutable ID for both generation and operation, plus a separate record ID.
- Move/resize immediately revert the library's provisional mutation and open a
  reviewable form; Save time submits one atomic range command. Cancel/Escape
  leave durable state untouched. The same form supports keyboard editing.
- All source title/range candidates are retained and shown for conflicted blocks;
  field replacement is explicit and other fields are unchanged. Source reads
  precede editing and gesture confirmation. A stale revision is rejected without
  automatic rebase. Titles and injected content use text nodes.
- Unknown/uncertain outcomes retain an immutable exact request for an explicit
  same-ID retry, disable further mutation, and block normal close/release.
  Acknowledged retry closes its originating form. Known definite local-codec and
  native rejection codes retire the pending request. Title validation counts
  UTF-8 bytes before admitting a command. This does not claim forced-process-death
  recovery of an unacknowledged renderer request.
- Visible queries split into at-most-31-day windows, retaining 64-row/1-MiB native
  page budgets, continuation scanning even for zero matched records, equal
  collection watermarks across every page/window, and identity deduplication.
  The aggregate fails visibly above 128 pages or 8 MiB rather than truncating.
  Cancelled loads publish nothing. A shared five-second change watcher starts
  from a fully fenced window watermark, cannot regress under a held earlier
  poll response, invalidates other Calendar panes, and stops after last unsubscribe.
  B confirmed watermark and change cursor share the collection's sequence domain.
- Calendar CSS uses app typography/theme variables with narrow-split controls.
  Form times use scoped Temporal imports and reject skipped/ambiguous DST local
  times; no global Temporal polyfill is installed.

## Dependencies and primary reference

Exact direct pins are `fullcalendar@7.1.3` and `temporal-polyfill@1.0.6`.
Community exports are `fullcalendar/daygrid`, `/timegrid`, `/list`, `/interaction`
and `/themes/monarch`, with `skeleton.css` and Monarch theme CSS. Published package
exports/types were inspected before API use; installed 7.1.3 uses Date-valued
public fields and lacks the old `updateSize` API. The view uses the supported
render lifecycle and scoped Temporal conversion for form dates.

Primary docs consulted: https://fullcalendar.io/docs/vanilla-js and
https://fullcalendar.io/docs/upgrading-from-v6-js (v7.1.3 advertised Oct 15, 2026).
MIT notices for all seven newly added runtime packages are retained under
`third-party/notices/`: FullCalendar, its core and headless-calendar packages,
Preact, temporal-polyfill, temporal-spec and temporal-utils.

`pnpm@12.14.0` was inspected and used. The multi-document manager lock document
is byte-identical to baseline. Existing app package and snapshot objects remain
structurally identical; exactly seven package metadata and seven dependency
snapshot objects were added, plus the two direct importer entries. Initial
pnpm peer-resolution churn was removed before the candidate freeze.

## Observed verification

On candidate runtime source `1cec325f`:

- `pnpm install --frozen-lockfile --ignore-scripts`: PASS.
- `pnpm exec tsc --noEmit`: PASS.
- `pnpm build:desktop`: PASS, including full TypeScript and native-mode Vite
  bundle. Calendar lazy chunk 377.95 kB / 110.02 kB gzip and CSS 21.06 kB /
  4.56 kB gzip. Existing editor dynamic-import/chunk-size warnings remain.
- `git diff --check`: PASS.
- `node --test --test-concurrency=1 --test-timeout=15000
  tests/calendar-controller.test.ts tests/calendar-view.test.ts
  tests/workspace-docking.test.ts tests/workspace-hotkeys.test.ts
  tests/workspace-menus.test.ts tests/workspace-window.test.ts`: **65/65 PASS**.
  The 21 Calendar cases include native create identity, exact uncertain retry,
  local actual B codec validation, stale revision/no rebase, bounded/fenced
  pagination, watcher baseline/race/failure, Temporal DST/date handling, actual
  FullCalendar DOM view changes, safe titles, form add/edit/delete/cancel/retry,
  and Workspace parking/Live Edit defaults. CSS is ignored only by the Node test
  loader; Node tests are not rendered visual evidence or durable storage proof.
- `pnpm build`: blocked before bundling by missing `wasm-bindgen` executable in
  this worker PATH. No Rust compilation or toolchain installation was launched.

## Remaining acceptance

Independent U review found no source blocker on exact `1cec325f`, independently
reran all 21 then-current Calendar cases and passed diff checks. A tests-only
successor adds three transitions requested by review: held inspection after date
navigation cannot reopen a stale form; all conflict alternatives remain visible
and explicit whole-range resolution uses the source revision; library move/resize
callbacks revert immediately and cancellation performs no durable mutation. All
10 view tests pass, bringing focused Calendar coverage to 24 cases (14 controller
plus 10 DOM/workspace). These callbacks are not actual pointer gesture evidence. Root is
assembling native WorkBlock service + B binding + this UI for actual Electron
schedule/title/range/delete/reopen, uncertainty, gesture cancellation and
light/dark/narrow visual verification. None of those runtime gates is claimed
from the isolated tests. This worker launched no Electron app or simulator.
Task links and unscheduled tasks remain dependent on F's Rust query activation;
no raw task IDs or invented checkbox model are exposed.


## Actual first composed pass — functional success, light image rejected

Coordinator assembly `86a1c1a92808048e69f32c42460f6b3d95ca3e95` includes
native/F query + B's corrected error data envelope + Calendar. The actual normal
Workspace test ran three separate Electron 44.8.0 processes through
`tests/calendar-electron-integration.cjs`, using an isolated owned profile/vault.
All three functional phases passed: add, title change, whole-range change,
keyboard event activation, actual pointer move/resize review and cancellation,
all four views, normal split, exact edited title/range after quit/reopen, delete,
and absent event after another process reopen. Actual gesture proposals changed
12:00–13:30 to 12:30–14:00 (move) and 12:00–14:30 (resize); cancelling both kept
the original 12:00–13:30, then normal reopen returned those exact values.

Raw report is [calendar-electron-initial.json](evidence/calendar-electron-initial.json).
Source, desktop, dist, native, manifest, lock and harness digests remained equal
before/after every phase. All owned app/native children exited (process inventory
checked). This worker did not launch a simulator.

Visual review rejected `author-light-list.png`: native capture retained a stale
DARK Appearance modal despite the DOM wait. The first proof therefore does not
establish light-mode visual acceptance. The original bundle remains at
`/var/folders/yc/__symlbx5zxd7v1vhwh84z180000gn/T/zorid-calendar-proof-lFPpAm`.
Dark Month and narrow split showed readable controls; the narrow event label
clipped midword. These findings produced two reviewed successors:
`6059e0cb` makes the harness focus its owned window and wait for painted/captured
frames, records computed theme/background/modal metadata, and asserts no modal;
`0bb82e56` uses a scoped ellipsis label with complete DOM text and native tooltip.
The latter passed all 10 DOM/view checks plus full TypeScript. Neither source
was changed inside the first frozen assembly during its proof.


## Final composed actual pass — e6910442

The corrected pass ran on exact assembly
`e6910442724510666f823cb85222a03b8f4d86bb`, after coordinator full TypeScript and
native-mode Vite rebuild. All **three separate normal Electron process phases
passed**, with 22 recorded steps including screenshot-state checkpoints. No
product instrumentation, private Workspace access, fake service, or memory
backend was used. The harness drives normal visible controls/forms and actual
keyboard/pointer events, with an isolated disposable profile and vault.

Raw durable report: [calendar-electron-final.json](evidence/calendar-electron-final.json)
(SHA-256 `a486207c62b3f3f05151a3b02de828c9fad17cf3014736362fda76e29a837724`). Original report/images/logs remain in
`/var/folders/yc/__symlbx5zxd7v1vhwh84z180000gn/T/zorid-calendar-proof-Ofm3Vp`.
The driver verifies all source/build/native/harness digests after each phase.

| Provenance | SHA-256 |
| --- | --- |
| src tree | `0d66a579f15e788ae0c027d4f389bec70f80e5f5d1308500ee05175e8d9b853e` |
| desktop tree | `27dc5c5967ab8bbeb629f6204769973808f079517118d7dfcf4f9c3c21ea9e6b` |
| dist tree | `8f96956d065f86f048eabbc1d7bf22ae9726364ef4da0e9e2e70395ef1ba47eb` |
| native host | `62c6fc58b742a23c52b75919a9d8ef94474f81232a51b2ce3775a9d6957ba405` |
| harness | `495627c447f99c48e1b33f246a5e094e17757b79a1d56a9f1e76e4201db769ac` |

The native host is `/private/tmp/zorid-calendar-native-2d1d93dc/zorid-desktop-host`;
Electron is the verified official 44.8.0 runtime at
`/private/tmp/zorid-managed-electron-44.8.0/Electron.app/Contents/MacOS/Electron`.

Observed functional results: actual normal Calendar destination; standalone
create; keyboard event activation; title and atomic time save; actual pointer
move/resize proposals reverted before explicit form confirmation; cancelling
both preserved exact saved time; Month/Week/Day/List each retained the fixture;
normal split and secondary-tab close; quit/reopen restored exact title, range
and zone; explicit delete confirmation/Keep block path; another process reopen
confirmed the deletion. The edited block was `Calendar proof edited`, local
12:00–13:30 in America/Toronto, checked independently against intended values
rather than only a self-captured baseline.

Worker C visually inspected actual PNGs: `author-light-list.png` is light
Calendar with no Settings modal and readable event/time; `author-dark-month.png`
is readable dark Month; `author-dark-narrow-split.png` has wrapped accessible
controls and clean ellipsis instead of clipped words; the deletion screenshot
shows the exact restored title/time and explicit destructive confirmation.
These are disposable fixture images, with no user vault content. All owned
Electron, renderer/helper and native processes exited; process inventory was
checked after completion. No extra simulator or iOS build was launched.

Independent U evidence review is requested against this exact final bundle.
Calendar's renderer uncertainty behavior is established by source/focused tests;
B's separate actual bridge proof establishes data-envelope error metadata and
native identical-operation replay/interruption. This UI harness does not itself
inject a lost IPC response, and the result does not imply task-link, browser,
mobile, Google integration or broad calendar parity completion.
