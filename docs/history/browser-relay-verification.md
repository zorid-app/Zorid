# Actual browser relay verification

## Normalized browser streaming and main integration — 2026-10-17

Integrated main293df57 from reviewed candidate3a082b0. Fresh actual Chrome used
the normal BrowserCoreRuntime worker, real Rust/WASM, strict IndexedDB format7
and the production RPC2 adapter. Browser database
`zorid-core-vault:smoke-4ba2a8bb-fc53-43ca-984b-491f81a6f170`, client
`813a1117-f50f-4ac9-afff-a51c5be019be`; no direct storage seeding.

The first receive exposed `sync_revision_collision` when retained Text became
visible after its namespace dependency arrived. Reviewed66bbc8c reserves that
unchanged durable witness only once, preserving fresh allocation fences. The
same failed database reopened without repair/clearing, received its remaining
eight records, and read exact49-byte merged text plus262,163-byte Binary with
the hashes recorded below. This receive reused existing concurrent history;
it is not a fresh v7 outage/concurrent-authoring proof.

The actual file chooser selected a17,825,809-byte generated input. Sliced Blob
staging committed `normalized-large.unknown`, entry
`481976f3-cb50-484f-b7bf-4b3d47d23fa2`, revision
`df5142bb-f5eb-469e-a0ca-7fb4812e845e`. Browser RPC uploaded64+64+12 records.
Independent CLI received140 records through cursor149; final authored,
dependency and projection pending counts were zero. Its raw streamed output and
physical file match the original length and SHA256:
`0a5b261f0251db22a67635b1e614ff085870d3c06ae34a57c7f28567d8a2628b`.
Nonsecret result: `/private/tmp/zorid-normalized-browser-large-result-1017.json`.

Own echoed updates initially repeated full Binary verification/publication.
Reviewed3a082b0 authenticates an existing exact receipt and rechecks state,
ledger, source bytes, cursor and ownership in a strict transaction that writes
only the cursor. New updates retain full verification. After a real reload of
the same large-file database, catch-up received64 then52 records and completed
with stable entry/revision. No broad throughput or memory benchmark is claimed.

Actual normal production browser build58710 (nonfixture asset routing) opened
at fresh loopback origin8797 without sync credentials. New note,72-character
save, Reading mode and full reload passed. Two actual independent tabs then
edited the same baseline concurrently. Tab B committed; Tab A displayed
`Save failed — draft retained`. Reloading A restored its exact competing text
with the retained-draft panel. Save recovery copy created
`Untitled (recovered draft e7676f10).md` with A's text while the original retained
B's text. This is safe recovery, not the deferred automatic draft merge.

Combined source gates:43 Rust/WASM tests,97 browser checks, engine27 then31
focused regressions after the observed fixes, full TypeScript, actual WASM
release69772 and browser bundles pass. Current generated WASM SHA256 is
`5330ded754c628a9e3762d6f2174c0e2c2c44e3426d2f79890541231f53a1b72`.
The following main4d3c12d pass closes the preceding Electron RPC and fresh-v7
outage gaps. Actual Electron's explicit verification UI used private IPC and its
native host's RPC2 client; fresh normalized-v7 browser and independent CLI used
separate local state. After sharing one baseline, the actual relay was stopped
(socket refused connections), all three appended independently, and attempted
sync failed without losing local edits. Restarting the same DB/server epoch
converged all three to exact85 bytes:
`Shared RPC baseline\nBrowser offline append\nCLI offline append\nDesktop offline append\n`.
SHA256: `b3ae03939d06bfa6c8decbc24473d4d90b5ee0aaa614eb9fe53fcca263105496`.
Electron/CLI ended at cursor5 with all pending counts0; browser completed.
This proves actual Electron-owned RPC upload/receive, not normal-editor sync
controls or production enrollment. Original /private/tmp fixtures and reports
subsequently vanished. `tmp/shared-core-final-1017/rpc-convergence-observed.json`
reconstructs the observed tool outputs; original databases cannot be inspected.

The actual normal default Store11 Electron crash/CLI-conflict/recovery-copy
pass also now passes, with independent physical/checkpoint verification recorded
in `tmp/shared-core-final-1017/crash-observation.json`; see
native-progress-verification.md. Native undo/redo/selection and actual OS Zhuyin
composition/commit/restart also pass; owned native apps are closed. Durable
nonsecret observations: verification/shared-core-final-2026-10-17.json. Enrollment,
mobile and production security are not established by these checks.

## Production RPC adapter cross-client proof — 2026-10-17

Root served the actual BrowserCoreRuntime worker/Rust-WASM bundle from isolated
`grpc-core-integration` source eaea42a, RPC source d488583. WASM11378 and browser
bundle58735 built successfully. The bundle contains production RPC2 adapters;
this run still uses the preceding browser-v6 storage engine, not the subsequent
normalized-v7 streaming candidate. Synthetic credentials remained in private
fixture files, outside served content. No direct IndexedDB seeding was used.

Actual Chrome created `rpc-note.md`, synced it to the Rust/SQLite relay, and the
independent CLI received its exact27 bytes. Browser and CLI then independently
appended different text from that shared baseline before exchanging updates.
After catch-up both read the exact49-byte merged content; CLI physical bytes
also matched. SHA256:
`e1f07ecb09cd36487f7d4e359d2ba03fa3f98b3d4c19adcd29f45eb280df6967`.
Nonsecret result: `/private/tmp/zorid-rpc-browser-cli-result-1017.json`.

Chrome selected a generated262,163-byte binary through the actual file chooser,
created `rpc-asset.unknown` and synced five records. Independent CLI catch-up
received five records; pinned/raw output and the physical file both equal the
original input byte-for-byte. SHA256:
`c8420694bde1beb17f817fed43a5e6b12ed74424216947b4e87d1fdc87212a10`.
Nonsecret result: `/private/tmp/zorid-rpc-browser-binary-result-1017.json`.
The catch-up report had zero final pending authored/dependency/projection work;
its broader `synced` flag remains false while unsupported capabilities exist.

A continuation initially returned `sync_transport`; live process inspection
confirmed that interruption had stopped the fixture relay. Restarting the same
database and original loopback port completed the pending binary check. This
does not represent a protocol/data repair. Own Chrome tab was automatically
closed after interruption, and restarted relay60125 was closed with exit0.
There is no actual normalized-v7 browser, new Electron, >16MiB browser or mobile
proof from this run. The new batch remains isolated pending those applicable
combined gates; current main still uses HTTP1 sync.

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

Superseding nested-file result (2026-10-17): fresh actual-worker verification
with content-hashed assets passed. The prior rerun was still executing cached
JavaScript. Source `1cefd8d` plus diagnostics `58d7eb0` and hashed assets
`2205c9b` are integrated on main through `3dd3de6` after source review and this
runtime check. Fresh database suffix `fb7cbedd-655a-4615-807e-fd9df8b65cb2`,
client `51c3767c-2c4e-45f5-8b51-6fc010ad1164`, received 11 relay records,
created `FreshFolder/child.md`, reloaded, and read its exact 36 bytes before
credential reimport: `Nested browser file survives reload.` SHA256
`70197d9f11995ef2bf24f9b58965c135f5a62aac27709ba8ba460484ddd0129e`.
Reimport and HTTP sweep uploaded 3/received 3, complete true. CLI receipt of
these new nested entries remains to be verified. The older failed database
is preserved and correctly rejects open with `visible_publication_agreement`;
no automatic repair or real-vault migration was attempted.

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

## Rebuilt desktop creation and standalone CLI interop — 2026-10-17

Native candidate `292cd27` built CLI and desktop host (worker83593 exit0).
Fresh `/private/tmp/zorid-cli-family-20261017-0936` was initialized/enrolled by
standalone CLI, then received all14 relay records. Final pending projection and
dependencies were zero. Physical `note.md` and `moved-note.md` were absent;
`asset.bin` and `FreshFolder/child.md` matched the hashes above. This covers the
previous stale-file repro with fresh schema8 storage, not a migration.

Normal Electron candidate `a29605b` used its rebuilt hashed renderer
`main.0fbcd7e6f6d793c5e158.js` (SHA256
`246e46f6dad2c9fab01a29667b10a035032555d73ed1943c7d86c3a722e97055`).
Verified OS process58254 launched the isolated create-test profile and spawned
host62613 from `core-native-cli-combined/target-native-family-create/debug/`;
host SHA256 `1ae9bd653cb4603f8712db6919e6b5d00e3046c6e5cdb983225b93719f0f88a1`.
The earlier closed-window process33670 was cleaned up separately; UI selection
was confirmed on vault0936 before editing. An unrelated folder was briefly
selected in the picker; no file mutation was performed there.

Actual New note button created `Untitled.md`; typing
`Created in rebuilt desktop through Rust.` saved exact40 bytes to disk and
cleared the Saving indicator. Standalone CLI synced while Electron stayed open:
server accepted3, cursor17, final pending authored/dependency/projection all0.
Browser received3 and read exact40 bytes, SHA256
`58e53ce2a4cf3a1f0fa49cb3e99aae08a6a73ac84c6264c03b963aa888617634`.
Normal Cmd-Q then exited test launch92846 with code0. This proves desktop
create/save plus CLI upload/browser receive; simultaneous conflicting writes,
crash injection, external edits and complete milestone acceptance remain open.
Native/desktop batch integrated to main `5d29c53`. Main TypeScript check31928
exited0 and four focused create checks passed. Rust crates/Cargo sources match
built candidate292cd27 exactly; this is not a new main-bundle UI verification.

## Current browser tab ownership — 2026-10-17

On the hashed smoke artifact, opening a second actual Chrome tab with the same
database/client51c3767c-2c4e-45f5-8b51-6fc010ad1164 failed explicitly with
client_already_owned. A separate client692ea926-748b-46bc-a984-58554b2e189a
opened the same database while the first remained live, created TabPeer.md, and
the original tab read exact30 bytes `Written by second browser tab.` SHA256
`ccc1d654335ccf8376e8c9392e9a80cfbd1619073c6df2c0d3956ea5a8f162bc`.
Closing and reopening the second tab with its original identity succeeded.
These checks prove ownership fencing, independent same-vault tab writes/reads
and lifetime release; they do not force simultaneous conflicting transactions.
Extra test tabs closed; the original relay fixture remains for follow-up.

## 2026-10-17 desktop namespace receive and CLI isolation

Main2c811ef includes reviewed file-command integration. Actual browser database
smoke-fb7cbedd-655a-4615-807e-fd9df8b65cb2 uploaded its2 pending tab records and
received35 records after desktop/CLI upload. Inventory includes renamed
TestRename-verified.md, asdf/test.md and the original stable entry moved under
.trash/9d92af2f-e0f3-4360-aff9-a38132d16fcd/Test2.md. Renamed entry
0e77560f-65ea-4996-a172-cf1b7cd51bec read33 exact bytes, SHA256
fe6e12b606bbb56ad85120863a93a6cbb788036690bb62bb74bfffdd2b74d0bf,
matching CLI/disk. Reload without importing credentials retained identical bytes.
Later user edits in desktop are separate and not covered by this digest.

Actual standalone CLI account isolation passed, report
/private/tmp/zorid-client-isolation-20261017-100530/report.json: authorized B
created/uploaded its33-byte sentinel; B-token/A-scope read/upload rejected with
sync_authorization_failed; two rejected upload processes retained exact sealed
wire and2 pending updates; cursor stayed0, no remote entries appeared. B-bound
local vault rejects A config with sync_binding_mismatch. All52 A relay records
were unchanged. Browser B receive and mixed-credential rejection remain pending.

## Actual browser account isolation — 2026-10-17

Fresh database smoke-a14c24eb-8489-43f6-8462-f4fb206f36bd, client
02fea6f5-8fa7-441f-90fb-b895fe6fd3f9, imported legitimate account B fixture
credentials. Actual browser worker/WASM/HTTP received2 records and only B's
sentinel c52af72c-577a-42be-b197-b59a50007233,33 bytes SHA256
b8a0553315b015349e7f0ca38ed3ff55b960988ed9b1f88ff23e4172cdefeb30.
After reload, importing A credentials rejected sync_scope_conflict.

Fresh database smoke-6eab7e2c-a9ce-4682-a01c-f8a7c9d472ac, client
32106da5-296a-42a5-ac1c-d7ce8df85858, imported the owner-only mixed fixture
(B bearer token, A scope/key). Sync rejected sync_authorization_failed, inventory
remained empty. Reload/reimport/retry again rejected sync_authorization_failed.
Both completed isolation tabs closed. This proves client-visible authorization
and persistent scope fencing, not a production enrollment/security audit.

## Relay outage and rejoin — 2026-10-17

Common baseline OfflineRejoin1017.md id5b04e12c-d29b-4655-84c3-c823e8a5e8e1 reached browser and independent CLI vault /private/tmp/zorid-offline-rejoin-cli-20261017. Confirmed own loopback relay61606 terminated (session29766 exit143). Browser saved38 bytes offline and retained them after reload without credentials; CLI independently saved its own edit. Both actual sync attempts rejected sync_transport. Restarted same relay/database session43620, CLI uploaded1, browser uploaded1/received2, CLI received1. Both read exact55 bytes containing common baseline plus Browser outage edit and CLI outage edit, SHA256 1fc1be05e0655e0662bc244ddced0a93660c7a0a4104f6f7979e121853d9d493. CLI raw bytes equal physical file, pending authored/dependency/projection0 at cursor56. Evidence /private/tmp/zorid-offline-rejoin-result-1017.json. Static8767 server69072. This proves actual outage/rejoin convergence, not background sync or mobile.
