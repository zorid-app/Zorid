# Tasks Workspace host integration

C owns `tingkai-c/managed-tasks-workspace-ui` in the Orca worktree of that name.
This is a separate successor to the accepted Calendar source/runtime batch;
Calendar modules remain untouched. Coordinator alone integrates main.

Host source freeze: **0bfb9c88**. Base: accepted Calendar/F/B assembly
`e6910442724510666f823cb85222a03b8f4d86bb`. Dependencies are the independently
approved Tasks modules `38ddb380`, `052766e5`, `47fc3e28`, `d1688cc2`, `cbe9dff6`,
retryable-close/styles successor `b8b9a5ab`, and retained-capture-view correction
`58fd7a0c`. C replayed these on its isolated branch to compile and verify the
host; the coordinator already owns the matching dependency assembly. Cherry-pick
C's host commit separately, rather than copying an older whole Workspace.

The original dispatched worker is task `task_2c808419ce2a`, dispatch
`ctx_cda0bb2b5600`. Root subsequently assigned the Tasks destination/host and
explicit optional synchronous `Vault.create` admission seam (root relay
`msg_7d98b13f961a`). Existing binding, NoteBuffer, editor, Rust/native, mobile,
platform and root manifest/lock source are not edited by this host batch.
Native371 owns its additive stable-ID navigation and native toolbar initializer;
preserve those independent hunks during main composition. C sent the additive
caller coordination directly and made no `openNote` signature change here.

## Resulting behavior

- Ribbon **Open Tasks**, command **Tasks: Open Tasks**, saved Tasks tabs,
  existing split/park/restore lifecycle, real `PlatformVault.documentSemantics`
  and its Rust `Pin.tasks` query. A vault without document queries/durable note
  saves receives an unavailable message. There is no product memory backend,
  checkbox reinterpretation, JavaScript task query engine or task mirror.
- Type selector inventory is ordinary `Types/**/*.yaml/yml` file **EntryIds**,
  sorted by path, bounded to 128 with an explicit error instead of truncation.
  Empty inventory means none. Unrelated YAML elsewhere is excluded. Renamed or
  custom Type files inside Types/ remain discoverable by saved identity; arbitrary
  external Type paths remain an explicit future selection feature.
- Capture reads the exact original Type witness, validates a canonical relative
  folder before normalization, creates parents through the ordinary folder route,
  serializes returned Rust capture defaults into a normal Markdown note and uses
  ordinary non-clobber file creation. A first unique title uses its literal trimmed
  filename; existing names receive a numeric suffix. Titles are limited to 200
  UTF-8 bytes and cannot contain path/control characters.
- Capture IDs retain one selected path/input per attempt. Unknown create results
  are never retried with a new path or fresh operation by the host. The module's
  explicit inspect-and-resolve UI remains responsible for unconfirmed captures;
  replay of the same unconfirmed capture ID sends no second file create.
- Property edits reject dirty/error note buffers **before any native read**, then
  verify original note and Type EntryId/revision witnesses, original semantic Type,
  clean NoteBuffer saved durable witness and original body bytes. A final fresh
  Type read occurs immediately before synchronous draft admission, with buffer
  clean/witness/content checks repeated after that await. `setProperty` and
  `removeProperty` preserve the existing Markdown body and YAML comments; the
  normal NoteBuffer durable protocol owns expected-note-revision CAS and recovery.
  Existing loaded note views receive the accepted buffer change.
- The Type witness is checked at explicit draft admission. This is not an invented
  cross-file atomic Type+note transaction. No persistent Type-file lifetime validator
  is installed in NoteBuffer: a later Type edit must not poison unrelated future
  saves or recovery of the ordinary note. R explicitly agreed this boundary.
- Open body reads original saved identity/revision, then dispatches guarded normal
  note navigation through `Workspace.run` and returns from the controller callback.
  This avoids `controller.running -> openNote -> pane flush -> controller.running`
  self-await. Normal navigation still drains the controller, preserves parked Tasks
  drafts, and checks the original vault/pane/tab/activation/EntryId/revision and
  retirement flag after the usual navigation flush. Errors use normal notice UI.
- Presets preflight both ordinary Type/Base destinations, create without overwriting,
  and never delete a first file on partial failure. Parent creation is guarded.
  The created Type identity/revision remains checked before queued Base creation;
  partial failures report the preserved state for inspection.
- `Vault.create` accepts an optional synchronous validator. It captures its original
  adapter before queuing and invokes validation **after** its queued refresh,
  immediately before dispatch to that captured adapter. No await separates final
  admission and dispatch. Ordinary callers remain compatible. Tasks capture/preset
  use this seam rather than bypassing ordinary creation or changing persistence.
- Ordinary tab navigation only flushes explicit Tasks work and parks drafts.
  Destructive runtime flush prepares Tasks last, draining its retained pins before
  synchronous no-fail disposal. Failed runtime close cancels preparation and retains
  a usable view. Global replace, release and destroy preflight all Tasks views before
  irreversible teardown, restoring still-owned prepared siblings if any preflight
  fails. A bounded Tasks retirement fence/root inert state prevents a new Tasks
  topology or delayed mount from entering during held preparation; normal commands
  return after rollback. The original module owner owns prepare/cancel/destroy APIs.
- Note-only status mode/word/character counts are omitted for Calendar, Tasks and
  other non-note destinations, as the coordinator requested from actual screenshots.

## Observed verification

All checks use bounded concurrency; C launched no further Electron app, native
compile, iOS build or simulator after the accepted Calendar proof.

- Full `tsc --noEmit`: PASS on the final source, using the already installed
  TypeScript and unchanged dependency graph. The worker temporarily linked only
  node_modules for checks, then removed its own link before committing; no source
  symlink or dependency rewrite was used.
- `git diff --check`: PASS.
- Final focused command (concurrency 1, timeout 15 s):
  `node --test --test-concurrency=1 --test-timeout=15000
  tests/workspace-tasks.test.ts tests/vault-create-admission.test.ts
  tests/tasks-desktop-ui.test.ts` — **34/34 PASS**. This includes 16 C cases
  (13 host/Workspace plus 3 queued-create) and 18 current module cases.
- Affected regression batch before the final Open body dispatch correction and
  retained-capture module successor: **108/108 PASS**, covering C/Tasks, ordinary
  Vault/durable Vault, docking, hotkeys, window identity and all 24 Calendar cases.
  The final correction was then checked with the real controller-to-normal-editor
  regression, complete latest focused batch and full TypeScript. No claim that
  the earlier 108 run included the later correction is made.

Meaningful new cases include original-adapter queued dispatch, changed owner and
changed Type during held queued refresh; no await after admission; normal caller
compatibility; canonical capture path rejection; uncertainty with exactly one
create; real NoteBuffer durable-contract mutation preserving source body/comment
and ordinary checkbox text; dirty-before-RPC refusal; stale and semantic Type
mismatch; no-clobber/partial presets; parked drafts and split close; destructive
and release preflight rollback; held global preparation preventing new Tasks
views/topology; and real controller Open body reaching the shared editor without
self-await. Test fixtures are controlled adapters/services only in tests; they do
not establish native persistence or actual Tasks rendering.

## Acceptance and remaining gate

R independently **approved** exact C source
`0bfb9c888eaa03b0e5e5cf2bd821ece09ebd82ac` (relay `msg_244b064eb3cb`), with no
source blocker. This is source approval, not actual Tasks UI acceptance. Coordinator composes the
approved source/dependencies, performs one matched frontend build and freezes its
artifact. B owns the subsequent actual normal Electron Tasks preset/capture,
status/date, body-edit/save/reopen, dirty/stale and unknown-create proof through
normal UI, with its own disposable fixtures and explicit app/native cleanup.
No actual Tasks UI delivery, native/mobile parity, arbitrary race coverage,
forced-crash capture-draft recovery or cross-file atomic Type transaction is
claimed from these isolated checks. Calendar's separate final actual evidence
and independent approval remain at `calendar-desktop-results.md`.


## Additive native-owned navigation coordination

Native371 proposed and C acknowledged an optional eighth
`openNote(..., expectedEntryId?: string)` argument, retaining the existing first
seven arguments. 371 owns the signature and immutable-ID flow into NoteBuffer
load before checkpoint/recovery; C owns only the later Tasks caller passing the
original task witness EntryId. That caller successor depends on the committed
native-owned admission/signature and must not use a TypeScript bypass or silently
substitute a fresh identity. Current 0bfb source does not edit or replace that
shared method or any mobile initializer. The original saved EntryId+revision and
navigation guards remain in its normal body-open dispatch.

## Original task identity caller successor (2026-10-18)

Dispatch `ctx_f2688a80b862` restored this worker's latest Tasks scope; Calendar
was already accepted and was not changed. Coordinator authorized reconciliation
of canonical native-owned `a2d480e2` (same source batch as `4d04d082`) into this
isolated branch. Dependency replay is `6f747ca6`: its four Workspace conflicts
preserve both the Tasks kind and expectedEntryId, both native/Tasks cleanup,
native navigation binding with Tasks rollback, and native cleanup with the
existing Tasks destructive-close preflight. The other seven dependency files
are the native owner's committed changes, not independently authored C edits.

The separate C successor only appends the original task witness EntryId as the
eighth `openNote` argument. All original seven arguments and the saved revision,
pane/vault/activation/retirement guards remain intact. Its real controller-to-
editor regression records the dispatched arguments and checks that the admitted
tab and durable buffer retain the original identity without a self-await.

Observed on this composition: 71/71 checks pass with concurrency 1 and a 15-second
per-test timeout across `workspace-tasks`, `vault-create-admission`, and
`workspace-mobile-navigation`; full `node node_modules/typescript/bin/tsc
--noEmit` passes; `git diff --check` passes. `pnpm exec tsc --noEmit` itself was
rejected by pnpm's workspace-install verification before TypeScript started,
because this checkout temporarily linked the coordinator's installed dependency
tree. The direct unchanged TypeScript executable completed successfully; the
worker-owned link was removed afterward. No app, frontend/native build, iOS or
simulator was launched. Matching actual Tasks runtime remains B/coordinator-owned.

Read-only actual findings were sent to B/R/coordinator: the old harness performs
readiness and action in separate renderer calls, allowing a native-resume refresh
to disable the target between them. The old recovery concern used pane text from
an always-mounted hidden banner; the actual failure screenshot shows no visible
banner, while that old JSON lacks hidden/rect/computed metadata. Narrow capture
shows fixed left-sidebar occlusion, and its optional Collapse-left selector does
not match the actual Toggle-left label. No production fix was justified by these
artifacts; B owns the corrected harness and next visible/computed-state capture.

## Durable save publication identity correction (2026-10-18)

Root `msg_20c8acaa33a3`, task `task_f2b87c36d1c8`, dispatch
`ctx_27e7a8e10eb2`, grants only the exact `Vault.reconcileDurableWrite`
publication hunk and focused regressions. Source/test commit:
**`5c58850fb0849590482578b70a3fc285325400f2`**, separate from Base contract
`c2760a2f` and original caller `78b4e462`.

Actual Electron `cfc1c8b4` reached ordinary Tasks body save, then Split right
reported “The selected note identity changed”. R traced the dropped cache identity:
`durableObservation` validates readback against the original durable reference,
but the replacement `VaultEntry` omitted that validated EntryId. The correction
copies `current.entryId` into the published entry. It does not substitute a new
identity or remove any receipt/current-observation/CAS, buffer or render guard.

The existing real Tasks-controller-to-editor regression now dispatches an ordinary
CodeMirror document change (exercising Workspace's normal onChange), flushes the
real NoteBuffer durable protocol, checks persisted bytes and cache revision/ID,
then follows the ordinary split implementation. Both the new tab's expected ID and
shared buffer saved witness retain the original task identity, and its editor
shows the saved body. Before the fix, the targeted test failed at the post-save
cache identity check: expected original UUID, actual undefined. A separate core
regression supplies replacement-ID readback for the original committed receipt;
publication is rejected, maps/content/events remain unchanged, and no write occurs.

Observed on the corrected source:

- `node --test --test-concurrency=1 --test-timeout=15000
  tests/workspace-tasks.test.ts tests/core-vault-durable.test.ts
  tests/vault-create-admission.test.ts tests/workspace-mobile-navigation.test.ts`
  — **81/81 PASS**.
- `node node_modules/typescript/bin/tsc --noEmit` — PASS.
- `git diff --check` — PASS after removing an extra test-file trailing blank line.

The worker temporarily linked existing coordinator node_modules for bounded
checks, then removed its own link. No dependency/source rewrite, app launch,
frontend build, Rust/native build or mobile change occurred. R has the exact
source/test SHA for independent review. Coordinator must compose it, rebuild the
frontend and repeat B's matched actual Electron gate; passing isolated tests does
not establish complete Tasks acceptance or native/mobile parity. The prior failed
runtime evidence remains valid historical evidence and is not rewritten as success.
