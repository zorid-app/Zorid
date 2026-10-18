# Desktop Tasks module results

The retryable-close successor at the end of this report supersedes the original
async-destroy lifecycle description below; original source evidence remains historical.

2026-10-18 UTC. UI owner: dispatched worker `term_06f49726-24ba-4006-b062-c3c7f30af67f`,
task `task_602bebcc0819`, dispatch `ctx_b75956585eb4`, root grant `msg_b74ac93ab1aa`.
Branch/worktree: `tingkai-c/managed-tasks-desktop-ui` at
`/Users/ctk/orca/workspaces/Zorid/managed-tasks-desktop-ui`.
Ordered source commits: `38ddb380`, `052766e5`, `47fc3e28`, `d1688cc2`, `cbe9dff6`.
Source/test freeze: `cbe9dff61effeba68def601aef606f4bf85bcce4`.
Base: reviewed F query candidate `e666ee67`; existing `presets.ts` and
`types-document.ts` remain unchanged F-owned sources. Only the three new UI
modules, focused test file and this report are owned here. Canonical integration
remains exclusively with `term_2fbd0185-6f86-4649-824c-92faf46852f7`;
this worker neither changes main nor launches Electron.

## Implemented behavior

`src/tasks/controller.ts` owns transient view drafts and one serialized read/mutation
at a time. It maintains the ordinary document index with `catchUpDocumentIndex`,
opens a real `DocumentPin`, calls its actual `tasks` capability, and closes after
the read drains. Failed closes stay owned for retry before another open or on
disposal. Expiry is exposed as an explicit refresh/reopen instruction, without an
automatic cross-generation retry. No JS task query, query AST, task mirror,
feature database, index parser or managed task record exists in the product path.

`src/tasks/view.ts` exports `createTasksView(container, host)`. It offers task
capture, All/Today/Unscheduled filters, completed visibility, returned Rust status
groups, mapped status and date editing/clearing, rich-body opening, explicit
refresh, and alternate preset paths. Dates remain date-only strings. Unknown
status is visibly preserved until explicitly replaced with a known option;
changing a date does not silently write status. Coverage/truncation/type/note
metadata diagnostics remain visible alongside available rows. Labels and ordinary
paths are used in diagnostics instead of opaque entry identities.

Every editor draft retains its original task row and type revision witness, even
when a refresh changes the saved revision or filters/removes the row. Failed saves
retain drafts. A user can discard and start again from the new row; no fresh
revision is substituted into the old draft. Controls have label associations,
keyboard submission, focus restoration and narrow-pane wrapping. CSS uses existing
application color tokens and is imported by the host once.

Preset creation uses F's `createTaskPreset` and CSPRNG UUIDs; the host performs
ordinary durable non-clobber creates. Conflicts/partial installation are errors,
never permission to overwrite or delete existing files. A partially installed Type
may be valid; the UI does not claim a cross-file transaction or roll it back.

## Exact host agreement

C (`ctx_cda0bb2b5600`) solely owns Workspace integration. Initial contract agreement
is `msg_ec7a964c5233`; final amendments are acknowledged by
`msg_51878fd442b2`, with park/destructive-close guards agreed in
`msg_ad911cdf9aa7`. `TasksHost` and `TaskCaptureRequest` are exported by `controller.ts`:

- `documents: DocumentService` is the ordinary enrolled vault's service.
- `typeDefinitionIds(): readonly string[]` returns candidate ordinary YAML file
  **EntryIds**, not semantic type IDs or paths. Empty means none. Rust, on the
  retained pin, validates Type semantics. The approved initial host inventory is `Types/**/*.yaml` and `Types/**/*.yml`,
  including renamed/custom files within that folder (root `msg_2b1fea799aaf`, C
  `msg_015df40d7bce`). Out-of-folder Type selection is deferred; UI preset
  installation requires a path inside `Types/`. Discovery is host inventory policy;
  do not parse YAML in JS to manufacture authoritative task configuration. The
  current wrapper admits at most 128 selectors and must not silently truncate.
- `createTask(input: TaskCaptureRequest): Promise<void>` receives `captureId`,
  trimmed `title`, `destination`, `typeWitness` and `properties` copied from Rust's
  `captureDefaults`. It uses ordinary note creation, preserving explicit defaults
  in frontmatter and validating current Type witness and destination. A fulfilled
  promise means durable completion. Set `commitUncertain: false` on a rejected
  outcome only when definitely no note was created.
- `editTask({expectedTypeId, witness, typeWitness, properties}): Promise<void>`
  receives only changed, exact mapped keys. A cleared date is `null` (remove the
  property). C must validate original task and Type durable identity/revision,
  expected semantic type and dirty/error NoteBuffer admission; mutate through
  existing property/update/save APIs and preserve body/unrelated properties.
  No blind retry with a fresh witness. Success means durable save.
- `openTask(witness): Promise<void>` resolves the ordinary entry by identity and
  opens the shared editor; paths are display data, never task identity.
- `installPreset(preset: TaskPreset): Promise<void>` writes ordinary Type/Base
  files without clobber, including case/parent conflicts and actual-create races.
  No rollback deletion of an existing file. It reports partial failure honestly.
- Optional `subscribe(listener): () => void` announces relevant ordinary vault
  changes. The controller coalesces refreshes and disposes the subscription.

`TasksView` exposes `ready: Promise<void>`, `controller`, `refresh()`, `flush()`,
`hasPendingChanges()` and async `destroy()`. `flush` awaits explicit in-flight work;
it does not silently save or discard form drafts. The Workspace host must preserve
parked views and mutable owner callbacks through split/move, and protect pending
state from destructive close, cache eviction, vault switch and teardown. Merely
checking beforeunload is insufficient. `destroy` also rechecks pending state after draining and rejects before disposal
if drafts appeared during that drain. It then retires event handlers, makes the
root inert and disables controls synchronously before asynchronous cleanup, so
late input cannot create a draft during retained-pin release. A cleanup failure
keeps the view retired for teardown retry, rather than reopening input against a
disposed controller. After host-authorized disposal, the view
stops subscriptions, drains queries, closes retained pins and removes its root.

Capture failures without an explicit definitive rejection retain an immutable
`TaskCaptureRequest` as `unconfirmedCapture`. Additional capture calls are blocked,
including after refresh, so a lost acknowledgement cannot trigger an automatic
second note. The UI asks the user to inspect the ordinary vault and explicitly
confirm either that the task exists or that it was not created. This is manual
reconciliation, not an idempotent core replay guarantee; `captureId` is a UI intent
identity, not claimed to be the core operation ID. No host reconciliation API or
second outbox is introduced. The original title remains until confirmation.

## Verification and review

At source freeze, bounded commands passed:

```
node --test tests/tasks-desktop-ui.test.ts tests/task-document-binding.test.ts tests/task-types.test.ts
# 30 tests passed (13 new UI/controller groups, 17 existing wrapper/preset groups)
./node_modules/.bin/tsc --noEmit
# passed
git diff --check
# passed
```

Existing dependency tree is symlinked from the primary checkout; no install,
new build cache, Rust/WASM/Xcode build, simulator pass or Electron launch occurred.
The new tests exercise the actual `createDocumentService` wrapper using admitted
synthetic transport facts and a JSDOM host. They check selectors/options, pin
closure/draining/failed-close retry, default capture callback contents, original
revision retention after dirty/CAS rejection, mapped date clears, unknown status
preservation, invalid dates, explicit expiry, incomplete/truncated diagnostics,
uncertain capture non-replay, group rendering, accessible editing and teardown.
They also verify immutable retained snapshots, pending-draft teardown rejection
and late-input fencing while failed-close cleanup drains.
These are real-contract unit/DOM tests, not a live native backend or rendered
Electron application.

Independent reviewer T (`ctx_3d396045b178`) identified uncertain-create replay and
expected semantic type admission and mutable witness/default alias gaps before
freeze; all are corrected and tested. Retained draft row/type and capture requests
are detached defensive copies with deeply frozen nested data.
Final independent approval: `msg_55e9ccfc1551`, exact source
`cbe9dff61effeba68def601aef606f4bf85bcce4`; no blocking new-module source
findings remain. T independently reran all 30 focused tests and scoped whitespace
checks successfully. Review artifact: `/tmp/zorid-tasks-desktop-review.md`. This
approves source integration only; assembled Workspace and Electron delivery remain
separate required gates.

## Remaining gates and limitations

C must assemble the Workspace destination, stylesheet import, ordinary note host,
Type inventory policy and pending-draft lifecycle guards. Root must independently
review the exact frozen source and assembled C host. The coordinator then performs
the actual matching Electron rendered gate: install without clobber, capture,
status/date edits agreeing with Bases, shared rich body, external edit/dirty/CAS
failure, filters/incomplete/expired state, split/narrow/keyboard behavior and app
restart confirming persistence. This module has no feature-owned persistence:
saved tasks/config reopen from ordinary vault files; unsaved view drafts and
manual unconfirmed-capture UI state are transient, so host close guards are required.
Crash recovery is only what the ordinary note/write path actually provides.

No isolated-test delivery, integrated Electron behavior, native/mobile parity,
full Phase 3/4 completion, scheduling/WorkBlocks integration, recurrence, provider
sync or offline replica convergence is claimed here. Calendar/WorkBlocks and
future native shells retain their separately assigned owners and gates.


## Retryable close successor — 2026-10-18 03:13 UTC

Owner: same Tasks module worker, task `task_be736391a603`, dispatch
`ctx_9ff6b8109e8d`. Exact source/test freeze:
`b8b9a5ab8b96748eab87871fff3ab1acabd3f4b1`. Cherry-pick this successor alone
atop accepted Tasks source; the intervening independent migration document
`28a174cc` is not a UI dependency and remains untouched.

Concrete defect: the existing `TabViewRuntime.destroy` changes phase to disposed
before invoking its dispose callback. Original Tasks async destroy could then
reject a retained pin close after retiring the view, leaving both the runtime
and its input/subscription lifecycle irreversibly stranded. The correction moves
all rejectable close work into runtime's retryable flush phase; no shared runtime
framework source is changed.

API agreed before edits with C (`msg_fcd189862af4`) and independent reviewer R
(`msg_d1874dc3aa2a`):

- `prepareClose(): Promise<void>` synchronously enters preparing, fences control
  handlers and controller actions/refresh (including host subscriptions), and
  coalesces concurrent requests. It awaits running query/mutation work, rejects
  remaining capture/edit/unconfirmed drafts, drains every retained pin, then
  detaches the host subscription and enters prepared. Pin cleanup never overlaps
  an in-flight read. In-flight query results are not published into a closing view.
- A failed preparation returns to active, keeps owned failed-close pins and drafts,
  keeps its host subscription, exposes the error and reconstructs usable controls.
  It does not mark the controller disposed. Retrying preparation can finish cleanup.
- `cancelClose(): void` restores a prepared view and reconnects its subscription if
  the host later aborts. During preparing it records cancellation, keeps input
  fenced until running work/cleanup drains, then the preparation rejects and
  restores active state; it never permits overlapping query/pin access.
- `destroy(): void` is synchronous and idempotent after successful preparation.
  There is no pin operation, host callback or promise left to fail. Calling it
  before preparation is a host contract error and throws before mutation.
- `close(): Promise<void>` is a direct-owner convenience that prepares then calls
  synchronous destroy. Controller `dispose()` uses that same two-step discipline.
- `flush()` remains nondestructive: ordinary navigation parks the retained view
  without preparation or draft discard. Host global save/flush does not leave a
  merely saved view prepared and inert.

C owns only Workspace wiring: runtime.flush performs other fallible child/buffer
flushes first and calls prepareClose last; runtime.dispose invokes sync destroy.
Its sole runtime-destruction wrapper must call cancelClose on a prepared Tasks
view if runtime ownership/revision validation or later coordinated teardown
aborts. A multi-view preflight must roll back all already prepared views if
another participant fails. This module approval does not establish that composed
host behavior. No Workspace, NoteBuffer, editor, native or platform source changed
in this dispatch.

A coordinator scope extension `msg_4db065523110` also authorizes NEW
`src/tasks/styles.ts`, containing only `import './view.css';`, so C can lazily load
styles without making plain Node imports of the view load CSS. Existing view.css
and manifests are untouched.

Verification: all 32 combined focused tests passed with the existing command
shown above; after changing the regression to requery the actual restored input,
the 15 UI/controller tests passed again. Full `tsc --noEmit` and scoped whitespace
checks passed after the source changes. No new install, build, app or network run.

New meaningful regression imports the actual `createTabViewRuntime` and actual
Tasks view/controller: query close fails and retains a pin; runtime destructive
close fails again; runtime remains active, controls/subscription usable and a
new title draft retained; draft guard rejects close; explicit retry after draft
clear drains the pin and completes synchronous nonrejecting disposal. A held
query fixture verifies coalesced prep, refresh/subscription fencing, late input,
in-flight cancellation/drain and prepared cancellation/reconnection. Existing
immutable revision/type/default, unknown-status and uncertain-create tests remain
passing. These are bounded transport/JSDOM/runtime tests, not Electron rendering.

R (`ctx_24622e801a3d`) independently approved exact `b8b9a5ab` in
`msg_eca74c94fe2f`: no remaining concrete module-close blocker. R reviewed source
and the actual-runtime regression; R did not duplicate unchanged test execution.
C composed teardown rollback review and B/coordinator matching normal Electron
rendered/restart verification remain required. The source-only successor does
not change the previously documented transient-draft or manual uncertain-capture
reconciliation limitations and makes no delivered Electron claim.

## Retained capture visibility successor — 2026-10-18 03:25 UTC

Owner: Tasks module worker `term_4954ffa2-5680-4b6c-ab85-c04820b86905`,
task `task_9166418c0c51`, dispatch `ctx_2b800185f841`, same isolated branch/worktree
and root grant `msg_b74ac93ab1aa`. Scope is exclusively `src/tasks/view.ts`,
`tests/tasks-desktop-ui.test.ts` and this report. Base Tasks source remains approved
`b8b9a5ab` / report `3613f215`; unrelated intervening schema commit `d9fed142`
is not a Tasks dependency and must not be included in the Tasks batch.

C found a concrete retained-draft trap: after entering a capture title, removing
or invalidating the ordinary Type produces `types=[]`. The form disappeared while
the retained title still correctly blocked destructive close. The successor
renders capture whenever a title or unconfirmed capture exists, including without
available Types. It displays the exact retained title and destination, explains
Type unavailability and disables creation unless the selected Type exists in the
current Rust result. It does not manufacture a Type or silently choose a replacement.
Choosing another available Type updates creation availability explicitly.

`Discard capture draft` clears only the local title, with immediate rerender.
It never clears an unconfirmed create: that action is absent during uncertainty,
and its handler rechecks current busy/uncertain state even if a stale DOM button
is invoked. The existing two explicit vault-inspection reconciliation actions
remain visible without Types. Resolving “not created” retains the local title,
still requires a valid Type to create, and offers ordinary explicit discard;
resolving “exists” clears the title through the existing controller. No controller,
Workspace, native, platform, core, preset, stylesheet or public contract changed.
Initial empty/unsupported views retain the preset installation path.

Validation passed: 35 combined focused Node tests (18 UI/controller, 17 existing
binding/Type tests), full `tsc --noEmit`, and `git diff --check`. New regressions
cover removed and invalid Types, exact title visibility, disabled submission with
zero host creates, actual `createTabViewRuntime` destructive-close rejection then
success after explicit discard, uncertain immutable intent preservation, stale
plain-discard invocation, both reconciliation outcomes, and empty/unsupported
preset access. The test inventory follows its admitted definition list so true
Type removal does not fabricate a stale selector response. Initial execution
failed because this fresh terminal lacked dependencies; the authorized existing
primary dependency tree was symlinked without installation. An intermediate
fixture failed strict wrapper validation because its removal inventory was
inconsistent; that fixture was corrected, with no production wrapper change.

These are bounded transport/JSDOM/runtime tests only. No build, application launch,
main mutation or native validation occurred. Independent R review of the exact
successor and C composition precede the coordinator's actual matching Electron
rendered/restart gate; no isolated delivery or broad parity claim is made.

Exact source/test/report freeze: `58fd7a0c37f94fd8717c4c78b189683e85d3110f`.
Independent R approval `msg_af0b17797d93` reviewed that exact commit and found
no scoped source blocker; no duplicate original-module campaign or application
runtime check was claimed. This documentation-only approval follow-up leaves
the source/test freeze unchanged. Ordered Tasks batch: `58fd7a0c`, then this
report follow-up, atop the previously accepted `b8b9a5ab` / `3613f215`.
C host composition and actual matching Electron verification remain required.
