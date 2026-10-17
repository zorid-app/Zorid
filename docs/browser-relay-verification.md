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

Remaining: moves/deletions/folders, actual disconnected/restart
flow, account-B browser isolation, integrated CLI/Electron and backup/restore.
This is runtime/core proof, not the main editor's storage integration or production
security acceptance.

Continuation state: relay session60287 and static server session52832 remain live
for the next smoke steps. Fixture credentials are outside served content at
`/private/tmp/zorid-browser-sync-20261017-0026`. Do not print credential contents.
Browser A database suffix `a2c5692f-b739-4d11-b152-f896b97989f7`, client
`936a7a24-d28c-451f-8e35-0f2a0b3bbb4d`; browser B database suffix
`fde725e6-d973-4b54-a9aa-b9127e2cb344`, client
`49993312-25d9-4dd1-b7c9-ded0da898753`.
