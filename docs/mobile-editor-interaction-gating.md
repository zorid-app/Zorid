# Retained mobile editor interaction gate

Final source checkpoint: 2026-10-18. **Independently source-approved; 91 focused
checks pass; TypeScript check passes.** Main integration and consuming router /
native runtime validation remain with their named owners. Frozen phone19 and
finite-navigation source remain untouched.

## Ownership and provenance

- Owner: Orca terminal `term_0f955add-4708-4af3-91a3-10719e9ba77e`.
- Original grant: `msg_d354eee17d1d`; sole main integrator:
  `run:run_3e72b2c9ab72`.
- Branch: `mobile-editor-interaction`; isolated worktree:
  `/Users/ctk/orca/workspaces/Zorid/mobile-editor-interaction`.
- Base: `0ccab4508f9148af9537eb15c7fe4ead11b2c4b5`.
- Initial scope: `src/ui/editor.ts`, necessary child propagation in
  `src/editor/live-tables.ts`, async authoring in `src/editor/transfers.ts`,
  focused tests. Paired editor/platform context-menu scope was subsequently
  granted by root in `msg_d288112ac51d` / `msg_5d2ffaae736f` /
  `msg_6d24b55d3d00`. No Workspace, router, Rust, native, desktop bridge/CJS,
  or root build source was changed.

API agreement preceded source edits: native `msg_cc2cc42f9400`, coordinator
`msg_3cc10632f916` / `msg_714400a7199c`, TS owner `msg_b0dfd63ad74a` and
exact temporary-freeze semantics `msg_b4119c259011`. Root approved the
interaction-opted renderer-menu fallback in `msg_305a1d5f999c`.

Ordered source commits (documentation-only commits interspersed):

1. `71c362b00d79e9e52fca3949d757091aa18f8cae` — actual parent/child authoring
   admission, initial interaction state, in-place lease refresh and transfer epoch.
2. `ec8ca47125a8f6f0a19370b36ccd34efc93dddcd` — explicit every-lease table
   refresh, queued focus invalidation and transfer target ownership.
3. `12a8fa7267b488ba8dab3a809793f793b6109a82` — deliver denied transfer events
   to control handlers before stopping the outer CodeMirror fallback.
4. `047d568740b80d1948344e84c9f6d8d7f37daad1` — owned menu abort and role witness.

## Consuming contract

`EditorOptions.canMutate?: () => boolean` supplies the pure live writer-token
predicate; exceptions deny authoring. `interactionState?: {active: boolean}`
sets the initial state. Real `createEditor` handles implement optional
`setInteractionState({active})`; optional typing preserves existing stubs, while
a passive router must require actual support.

**All retained router editors must opt in at construction**, using both initial
interaction state and live writer predicate. Passive neighbors start inactive
with denied writer authority, before extensions mount. A later first setter
cannot retroactively protect an unmanaged native menu opened before opt-in.
The router revokes outgoing authority before enabling incoming authority and
calls the setter on every lease change, including canceled transitions.

Desktop defaults stay active. Inactive is read-only/noneditable and blurs only
an owned focused surface. Active with denied authoring is read-only with
contenteditable retained, preserving the source keyboard during a temporary
freeze. The setter never focuses or recreates CodeMirror. Each call retires
captured commands/transfers/menus, refreshes child facets and invalidates queued
table focus work even when parent facets do not change. Actual instance,
history, selection and scroll are retained.

Actual parent batches and child dispatch reject authored changes, including
`filter:false`. Private external `setValue` can refresh passive documents and
children without authored `onChange` or undo entries; existing undo maps through
snapshots. Table structure/clipboard mutations check authority before optimistic
child teardown. Denied transfer events preserve control defaults and handlers.
Already dispatched asset imports may finish storage; revoked actions cannot
insert text or start remaining queued imports. Storage cancellation is not claimed.

Interaction-managed menus capture epoch/document/selection/rectangle witnesses
and an owned abort signal. Lease refresh aborts only that editor's session,
without restoring focus. Browser roles check the witness around focus handlers
and immediately before effects. Guarded requests use the existing renderer menu
even with an Electron bridge, because raw native roles precede renderer checks.
Default unmanaged desktop menus retain their native path. This accepted future
Electron gated-mode tradeoff does not claim native-menu parity; existing browser
clipboard availability limits remain, with no fake privileged paste.

## Verification and independent review

```sh
node --test --test-concurrency=1 tests/editor-integration.test.ts tests/editor-transfers.test.ts tests/table-context-handoff.test.ts tests/native-editor-commands.test.ts tests/context-menu.test.ts
```

Observed **91 passed, 0 failed**, exit 0, bounded concurrency 1. Log:
`/tmp/mobile-editor-interaction-tests.log`. `git diff --check` passed.
Root explicitly requested one final TypeScript source check in
`msg_12f089e8a6a4`:

```sh
node --max-old-space-size=768 node_modules/typescript/bin/tsc --noEmit
```

Observed exit **0**, empty `/tmp/mobile-editor-interaction-tsc.log`.

Independent reviewer `term_a0c7b316-8546-4777-95a2-fe08cb519356`, isolated
`mobile-interaction-review`, approved exact source `047d5687` cumulatively against
`0ccab450` in `msg_4041e3080220`. Prior findings
`msg_8781e93f844d` / `msg_e1b3835ff494` were resolved by the ordered successors.
Reviewer inspected source and the reported test log; it ran no tests or builds.

No build, full test suite, Rust compilation, Xcode, simulator, phone, visual,
performance, integrated-router or native/IME acceptance was performed. Synthetic
DOM events/geometry establish source behavior only. The accepted consuming
architecture is one initialized WebView per vault, web-owned logical tabs,
document routes and history, with native outer chrome and gesture input; this
change supplies editor admission only.
