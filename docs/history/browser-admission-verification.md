# Actual Chrome admission verification

## Two actual tabs — 2026-10-17

Fixture `02f2184`, integrated as `ecbffdf`, passed TypeScript and webpack
(session60027 exit0), followed by four checks in two actual Chrome155 tabs.
Both tabs used WASM source `11d2544` and the manifest hashes recorded below.

The visible result reported `ok:true`, `passed:4`, and these outcomes:

- Duplicate same-client ownership rejected before recovery replay.
- Same-revision competing edits produced `["rejected","committed"]`;
  the winning stored content was `peer wins`.
- Reopening the peer read that winner, and both tabs observed a subsequent
  explicit edit from the new base: `peer wins\nthen peer rebased explicitly`.
- The coordinator closed the actual first Chrome tab using its tab-close API,
  then clicked verification in the surviving tab. The exact client reacquired
  ownership, retained its checkpoint, and replayed only authorized work.

Visible final flags were `ownerTabCloseConfirmed:true`,
`cleanup.workersClosed:true`, `cleanup.databasesDeleted:true`.
Run ID: `8d4bbcd6-32da-4a2a-9256-42b1d81d50dc`.
The remaining tab and loopback server session13573 were closed, and the temporary
worktree dependency symlink was removed.

This is browser-tab closure and shared IndexedDB command safety. It does not
establish browser/OS crash durability, CRDT network convergence, production
editor integration or user-facing conflict UX. Results above are a transcription
of the observed DOM, not a browser trace export.

## Single-page multi-worker run

On 2026-10-16, fixture source `e1997c6` (integrated as `8743ebd`) passed
TypeScript checking, webpack compilation (session11073 exit0), and all five
checks in Chrome 155 on macOS. Its runtime source is based on admission commit
`cdd6b49`; the generated Rust/WASM artifact is from `11d2544`.

Observed visible page results, transcribed from the browser DOM:

1. Duplicate client rejected before startup replay; prepared and authorized
   records unchanged.
2. Distinct client concurrently leased the same authority and shared notes;
   checkpoint namespaces remained separate.
3. Ordered release allowed exact-client reacquisition, retained its durable
   checkpoint, and replayed only the authorized intent.
4. Abrupt worker termination released the lease; exact-client restart retained
   its checkpoint and left the preparation inert.
5. An actual IndexedDB stall timed out the worker. The outbound trace contained
   only `inventory`; the queued checkpoint was not sent and was absent after
   restart.

Final visible result: `ok:true`, `passed:5`,
`cleanup.workersClosed:true`, `cleanup.databasesDeleted:true`.
Fixture database: `zorid-core-vault:admission-fixture-376e9b49-ff08-49cd-a9f7-305a169acea0`.

Manifest hashes observed on the page:

- JS, 40431 bytes: `0aa077122b8e32fa4146fe5352d2c167649a9d8f2af4b0ee733241ab1db28f30`.
- WASM, 2166205 bytes: `332e91b86777babfb6c826835e94a5f90931d562f5026d1ac499706b2e41d998`.

The owned browser tab and static server session62122 were closed afterward;
the temporary worktree dependency symlink was removed. No real vault was opened.

These are separate real workers in one page, not two tabs or browser/OS crash
proof. Production editor save integration and E2EE network convergence are not
established by this fixture. The record is a structured transcription, not an
exported browser trace.
