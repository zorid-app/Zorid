# Actual browser relay verification

Candidate `49082b9` in `core-browser-combined`, integrated on main through
`3185253`. Source review covered storage, worker, WASM and relay launcher;
the small runtime page was inspected by the coordinator.

Observed through Chrome and the actual BrowserCoreRuntime worker, Rust/WASM,
IndexedDB and loopback Rust/SQLite relay (not direct storage seeding):

- WASM release build passed (single job, session48159, 25.02 seconds).
- Scoped consumer/worker TypeScript check passed.
- Webpack passed after fixing `.js` to `.ts` resolution (session40767).
- Relay compiled and started (session60287), synthetic credentials only.
- Browser A created `note.md` with `Hello from browser`; first sync uploaded
  two encrypted updates and received two, complete=true.
- Independent browser B, different database/client/device credential, received
  two updates and read the exact 18-byte text. SHA256:
  `bdaa0874486a34aec2c594e8a39064d03ccdfb81056a73888b0f90c6a2b48200`.
- Both clients saved independent appended text before exchanging updates.
  Following sync, both read `Hello from browser\nA offline\nB offline` (38 bytes),
  SHA256 `5b964c5b29c13dec92f4b94f03ff10dbe04ee62a7b2172dbdd06119e2d898720`.
  Sync was deliberately withheld during edits; network connectivity itself was
  not disabled. This proves concurrent-edit convergence in this fixture.

- Binary transfer also passed: browser A imported a 4,106-byte fixture containing
  all byte values and invalid UTF-8, then browser B received three updates and read
  the same length and SHA256 as the original local file:
  `1747d2793a50e7b872a8c354e68264a9a10043101766ed8f63d6b74d4ca74c8a`.

- Browser A reopened its persistent database and read the same merged 38-byte
  text before importing any network credentials. Normal client restart passed;
  this is not a forced mid-commit crash test.
- Browser A renamed `note.md` to `moved-note.md`; B received one update and read
  the original stable entry ID and identical 38-byte content/digest at the new path.
- Browser B deleted that note; A reopened/reconnected, received one update and
  its file listing retained only `asset.bin`. Ordinary remote deletion passed.

Remaining: folder operations, actual disconnected/mid-commit crash
flow, account-B browser isolation, integrated CLI/Electron and backup/restore.
This is runtime/core proof, not the main editor's storage integration or production
security acceptance.

Follow-up: standalone CLI candidate `e6b1a67` received the binary to disk with
the same 4,106-byte digest. It authored `cli-note.md`, then a fresh browser received
and read `Written by independent CLI\n` (27 bytes), SHA256
`d40ed38f916ee736e57b95716826a37d31060e113ee3b9e95e8bf3832b869d5f`.
CLI physical move/delete remains incomplete, despite logical convergence.

Nested-folder failure: Folder creation succeeds, child creation returns
storage_corrupt. First source fix `1cefd8d`, rebuilt as candidate `da2d162`, still
fails in fresh DB `e74ba4ea-df0d-431b-9cf2-fc2d193489f8`. Do not count folder
support as verified. Diagnostic work is ongoing; failed commits may be durable.

2026-10-17 13:21 UTC diagnostic follow-up: actual Chrome ran the expanded
existing storage fixture at localhost:8768. All 27 groups passed, including
UUID parent/child identities after received history, prepare/commit/change
refresh/inventory/receipt read/ack/inventory and reopen. Its 19 disposable
databases were cleaned up. This narrows the failure to a difference in the
smoke runtime path; it does not establish that the failing worker-backed
nested-file flow is fixed. Owner is adding phase/invariant-only diagnostics.

Normal Electron candidate `2ac9d13` with host `5c68619` opened the CLI fixture,
but later displayed `Save failed — draft retained`. Live launch handle 80439
reported repeated `invalid_response` from `RustVaultService.receive` line 307.
Desktop owner identified a response validator mismatch: family journal full
reload events use local_command/received_update origins, while the JS validator
only accepts bootstrap full reload. Fix and normal-editor save verification
remain pending. Automatic review rejected closing the retained-draft window;
it remains open. Observed disposable text was recorded outside the repository
at `/private/tmp/zorid-normal-editor-20261017/retained-draft-observation.txt`.

Continuation state: relay session60287 and static server session52832 remain live
for the next smoke steps. Fixture credentials are outside served content at
`/private/tmp/zorid-browser-sync-20261017-0026`. Do not print credential contents.
Browser A database suffix `a2c5692f-b739-4d11-b152-f896b97989f7`, client
`936a7a24-d28c-451f-8e35-0f2a0b3bbb4d`; browser B database suffix
`fde725e6-d973-4b54-a9aa-b9127e2cb344`, client
`49993312-25d9-4dd1-b7c9-ded0da898753`.
