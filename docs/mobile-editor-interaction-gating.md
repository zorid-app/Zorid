# Retained mobile editor interaction gate

Source checkpoint: 2026-10-18. This successor work leaves frozen phone19 and the
finite-navigation source untouched. One initialized vault WebView, web-owned
logical tabs/routes/history and native outer chrome/gesture input are the
accepted consuming architecture; this change implements only editor admission.

## Ownership and source

- Owner: Orca terminal `term_0f955add-4708-4af3-91a3-10719e9ba77e`.
- Grant: `msg_d354eee17d1d`; sole main integration remains
  `run:run_3e72b2c9ab72`.
- Branch: `mobile-editor-interaction`; worktree:
  `/Users/ctk/orca/workspaces/Zorid/mobile-editor-interaction`.
- Base: `0ccab4508f9148af9537eb15c7fe4ead11b2c4b5`.
- Source commit: `71c362b00d79e9e52fca3949d757091aa18f8cae`.
- Source ownership: `src/ui/editor.ts`, table child/optimistic authoring propagation
  in `src/editor/live-tables.ts`, async authoring seam in
  `src/editor/transfers.ts`, and two focused editor test files. No Workspace,
  router, Rust, native or root build source changed.

API agreement preceded source edits: native `msg_cc2cc42f9400`, coordinator
`msg_3cc10632f916` / `msg_714400a7199c`, TS owner
`msg_b0dfd63ad74a` / exact freeze semantics `msg_b4119c259011`.

## Consuming contract

`EditorOptions.canMutate?: () => boolean` supplies the pure live writer-token
predicate. Exceptions deny authoring. `interactionState?: {active: boolean}`
sets the initial state, and real `createEditor` handles implement optional
`setInteractionState({active})`. The optional handle declaration preserves
existing stubs; passive routing must require actual support.

Desktop defaults remain active. Construct every passive neighbor with initial
`active: false` and a denied writer predicate. Active controls focus ownership:
inactive is read-only/noneditable and blurs only an owned focused surface.
Active with denied authoring is read-only with contenteditable retained, allowing
a temporary source freeze without dropping focus. The setter never focuses or
recreates CodeMirror, and every call retires the command/transfer epoch and old
async context-menu plugin. The router must revoke outgoing authority before
activating incoming authority and call the setter at every lease change.

The actual applied parent transaction batch and child table dispatch check live
admission, including `filter:false` changes. Parent external `setValue` uses a
private annotation to synchronize passive documents/children without authored
`onChange` or undo entries. Existing undo maps through external snapshots.
Already dispatched imports may complete storage; their assets are retained, but
revoked actions cannot insert text or begin remaining queued imports. This does
not claim cancellation of dispatched storage writes.

## Verification and review

Focused source command (bounded concurrency 1):

```sh
node --test --test-concurrency=1 tests/editor-integration.test.ts tests/editor-transfers.test.ts tests/table-context-handoff.test.ts tests/native-editor-commands.test.ts
```

Observed: **65 passed, 0 failed**, exit 0. Log:
`/tmp/mobile-editor-interaction-tests.log`. `git diff --check` passed.
Initial red run had the expected six new failures and 26 existing passes before
implementation; follow-up regressions cover freeze focus, predicate failure,
whole-batch rejection, native command state, stale menus, child editable/focus,
table structural admission, live transfer admission and two retained editors
sharing one writer token.

Independent reviewer: `term_a0c7b316-8546-4777-95a2-fe08cb519356`, isolated
`mobile-interaction-review`. Preimplementation seam audit
`msg_3540f8250b51` informed follow-up coverage; exact source review requested in
`msg_5cb441634432`. Final review/integration status remains pending at this
checkpoint; no `merge_ready` claim yet.

No build, full suite, full TypeScript check, Rust compilation, Xcode, simulator,
phone, visual, performance or integrated router verification was run. Geometry
shims and synthetic DOM events establish source behavior only. Native/runtime
acceptance and main integration belong to their named owners.

### Independent review follow-up

Reviewer `msg_8781e93f844d` withheld approval of `71c362b0`: denied transfer
handling also suppressed control defaults, child read-only could remain stale
across an equal-facet refresh, and a queued table selection callback could focus
an editor after a rapid inactive/active cycle. Source successor
`ec8ca47125a8f6f0a19370b36ccd34efc93dddcd` adds an explicit table interaction
refresh effect on every setter and target-specific transfer handling. Reviewer
`msg_e1b3835ff494` accepted both table fixes; it identified target event-handler
suppression and a separate surviving menu role lifetime gap. Source successor
`12a8fa7267b488ba8dab3a809793f793b6109a82` delivers non-editor transfer events to
their original controls before stopping CodeMirror's bubble fallback. Regression
assertions cover both target listener delivery and browser default preservation.

Current bounded command above: **69 passed, 0 failed**, exit 0. No heavy check
was run. Approval remains withheld pending the owned menu role lifetime seam and
exact follow-up review. Root grants `msg_d288112ac51d` and `msg_5d2ffaae736f`
add narrow editor/platform context-menu lifetime ownership; bridge/native edits
remain separately owned. Proposed guarded-browser fallback and per-editor
abort/epoch guard were sent for root agreement in `msg_9d2cb2fa3a1b`; no
unapproved platform/menu implementation is present at this checkpoint.
