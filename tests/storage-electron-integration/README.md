# Actual Electron S0 save/restart subset

Run only after the coordinator freezes matching native/frontend artifacts. No
build or launch is implicit in this harness. The harness may live in its isolated
checkout and target a separate clean frozen integration checkout.

```sh
node tests/storage-electron-integration/run.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-storage-evidence \
  --ready storage-native-and-frontend-frozen
```

It launches the normal Electron entry point with a disposable Chromium profile,
recent-vault metadata, ordinary fixture folder and separate `ZORID_LOCAL_DATA_DIR`.
It creates a note using the ordinary New note control, enters five successive
versions using actual keyboard input, waits for autosave and compares exact disk
bytes with normal bridge reads. It closes the window through the normal close
guard, checks the native host drained, restarts the same profile and reopens the
created note. It checks successful saves leave no `.previous`/staging/namespace
artifacts, app-local SQLite contains the seed note's exact snapshot bytes outside
the vault, and snapshots survive restart. No private paths/status codes enter the
visible opening UI. Screenshots, hashes, process outcomes and assertions are
retained in the evidence directory. The disposable vault/profile remain there for
inspection; owned test app/host processes are closed after each pass.

This is a bounded desktop runtime subset, not complete S0 acceptance. It does not
exercise abrupt crash/power loss, external open handles, multi-client concurrency,
expiry/five-minute waiting, restore UI, browser/mobile or sync. Snapshot inspection
uses a read-only SQLite connection; it does not claim a delivered recovery UI.
