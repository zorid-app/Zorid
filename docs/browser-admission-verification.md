# Actual Chrome admission verification

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
