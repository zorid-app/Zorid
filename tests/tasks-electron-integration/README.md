# Actual normal Electron Tasks UI acceptance

Explicit runtime target; preparation/syntax checks launch no app. Run only after
the coordinator supplies a **Tasks-ready** exact integration HEAD, matching
native-mode frontend/native host artifacts, and an exclusive owned app window.
No compiler, install, private Workspace access or production instrumentation.

```sh
node /absolute/binding/tests/tasks-electron-integration/run.mjs \
  --root /absolute/managed-desktop-integration \
  --expected-head FULL_TASKS_FROZEN_HEAD \
  --native /absolute/matching/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /absolute/new-owned-evidence-output \
  --ready tasks-native-and-frontend-frozen
```

All flags are required. The runner seeds an owned recent-vault profile and one
ordinary Base conflict fixture, then launches real `desktop/main.cjs` and normal
Workspace. Positive install/capture/status/date/body saves use visible DOM
controls and keyboard events only. Actual `Pin.tasks` powers the product list;
the harness never calls a fake query or private controller. Existing normal
preload reads are compared byte-for-byte with actual Markdown/config files.
Parsing those saved files is assertion-only, not a feature query implementation.

The planned three launches cover non-clobber preset install/alternate paths,
actual defaults/type/status/date properties, shared body editing and persisted
reopen, retained capture/draft close guards, and original note/Type revision rejection after
explicit external fixture edits. A normal split keeps the shared body visible
beside Tasks; the exact owned native child is briefly stopped so body autosave
cannot erase the dirty interval. Tasks must reject the edit synchronously with
its actual dirty-buffer error, retain the draft, and preserve body/metadata.
SIGCONT runs in finally before cleanup on success or failure.

A separate capture is dispatched through
real UI. After its exact unique final filename projection event, the verified
owned native child is killed; the test requires actual
unconfirmed capture UI and disabled additional capture, and observes file counts
on refresh/restart. The filesystem event is not a validated receipt and does **not** prove postcommit or lost ack.
A committed-but-unprojected note may materialize during ordinary restart recovery;
zero or one matching file is allowed, never duplicate files. No exact-once claim.

Real light/dark/narrow screenshots wait painted frames and record computed theme,
background and geometry; images need visual inspection before acceptance. Before
and after witnesses include HEAD/tracked sources, dist, native/Electron and exact
harness bytes. Runtime errors, native PID/parent/full executable+owned vault argv,
and all process exits/fallbacks are retained. Only owned processes and disposable
fixture data may be terminated/deleted. Native-child leak fails the proof.
Intentional pending-state close refusal and fallback process termination do not
establish graceful application close or unsaved draft crash persistence.

Syntax preparation:

```sh
node --check tests/tasks-electron-integration/run.mjs
node --check tests/tasks-electron-integration/cdp.mjs
```
