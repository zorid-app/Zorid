# Desktop Tasks integration

2026-10-18. Root integration candidate `tasks-main-integration`, based on canonical
`19a10544`. This delivers the ordinary desktop Tasks destination, not the complete
Tasks/Calendar plan or mobile/browser parity.

The 13 production/test files are byte-identical to actual-tested assembly
`15ff377b423eba222179af303da6f4fa9827dafe`. Root and managed coordinator independently
produced the same source patch, SHA256
`ecdabf27162be6132036f53941c35110d5c9f964cbd15f3e08a10483f682ec89`.
Older WorkBlock/query/Calendar changes were already canonical and were not replayed.
Main's stronger cache/event EntryId assertions in `core-vault-durable.test.ts` are
preserved; the Vault change here adds only queued create admission. The real Tasks
normal editor save/split identity regression remains included.

The module and Workspace source reports retain their independent approvals.
Managed reviewer R additionally accepted the actual three-group run, relayed in
Orca `msg_126c0f5a7195`; root independently read the raw result and inspected narrow
and unconfirmed-capture screenshots. Final reports are retained as
[actual runtime results](tasks-electron-results.md), exact `d17fc749`, and
[independent composed review](tasks-composed-review.md), exact `f4dc6752`.
Canonical product integration is `aa0a2f37`; all16 integrated files match the
isolated reviewed candidate. These report imports change no product source.

## Observed verification

- Root candidate: 44/44 tests, concurrency 1, across `tasks-desktop-ui`,
  `workspace-tasks`, `vault-create-admission` and `core-vault-durable`; full
  `tsc --noEmit` and `git diff --check` exit 0. No new Rust or app rebuild.
- Actual frozen Electron run: preset non-clobber, capture/status/date/body changes,
  ordinary save/split, dirty-buffer rejection, retained close drafts, stale note
  and Type rejection preserving exact input and authoritative Markdown, restart,
  and owned native interruption without automatic duplicate creation all pass.
- Raw result status is `passed-subset`, with equal before/after provenance and
  three completed groups. One uncertain task file remains the same single file
  after restart. Cleanup records no error; reviewer confirmed owned processes exit.
- Narrow screenshot is readable at 460px with no sidebar occlusion. Both themes
  were inspected by the managed coordinator/reviewer. Raw global IPC toast wording
  is queued as a presentation followup, not hidden as a successful UX outcome.

Raw evidence lives in
`/Users/ctk/orca/workspaces/Zorid/managed-workblock-desktop-binding/tmp/tasks-proof-15ff377b/`.
`result.json` SHA256:
`054eab3b8612e78bfa8113d10120c193cd459ad8ac2ca279df2d9a529e8a42c2`.
Root focused/typecheck logs are in
`/Users/ctk/orca/artifacts/zorid-native-20261018/tasks-main-{focused,typecheck}.log`.

Unsaved Tasks forms remain transient and protected by close guards. Unconfirmed
capture uses explicit vault inspection, not a claimed durable core replay API.
Multi-client encrypted convergence, native/mobile/browser runtime parity, task
scheduling joins, recurrence and generic Base calendars remain separate work.
