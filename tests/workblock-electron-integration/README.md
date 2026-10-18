# Actual Electron WorkBlock bridge/storage proof

This explicit target launches **only** after the coordinator supplies a frozen
integration HEAD, matched native host and native-mode frontend artifacts. It
uses the existing normal `desktop/main.cjs`, an owned temporary Electron profile
and disposable vault, the real renderer preload `getDurableContext` /
`durableInvoke('workblockCommand')`, existing window/client/vault admission,
real native stdio and SQLite. The raw preload probe bypasses the renderer
`createDesktopWorkBlocks` factory; its runtime proof remains a separate gate. It does not mock a service/store or claim Calendar
UI acceptance. No product source instrumentation is required. The probe asserts the plain
versioned WorkBlock success/failure envelope surviving `contextBridge`, then
uses the tested assembly's production `decodeWorkBlockEnvelope` to reconstruct
typed errors locally; it does not parse thrown error messages.

```sh
node /absolute/binding/tests/workblock-electron-integration/run.mjs \
  --root /absolute/managed-desktop-integration \
  --expected-head FULL_FROZEN_INTEGRATION_HEAD \
  --native /absolute/matching/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /absolute/owned-proof-output \
  --ready native-and-frontend-frozen
```

All flags are required; absent build artifacts/readiness fail, never skip. The
runner hashes tracked integration source, `dist`, native/Electron executables
and harness before and after; any difference invalidates the pass. Git tracked
changes are rejected. Native/Electron artifacts must have been built by the
coordinator for that HEAD; hashing alone does not establish build provenance.
`result.json` retains exact semantic inputs/outputs, IDs, byte-array revisions,
decimal times/receipts, admission context, runtime exceptions and owned process
shutdown mode. Provenance witnesses are separate JSON files.

The runner seeds only its own profile's normal recent-vault selection, then
creates, reads, moves, titles, adds/removes a stable task reference, pages a
window, and repeats the original create after later edits. It asserts exact
original receipt, unchanged latest state, and no duplicate durable change. It
releases the context and checks stale-ID rejection, closes its process, then
reopens the same profile/vault and checks persisted state and replay again.
A third launch follows intentionally abandoned controller observation of a real
renderer mutation; replay retains the exact request and produces one durable
change whether the initial dispatch committed or not. This proves observer
interruption recovery, not loss of a native stdio frame. Create generation and
operation share one immutable ID as required by the native records contract.
SIGTERM/SIGKILL fallback is recorded as process shutdown, not graceful UI close
acceptance. Only the spawned Electron process is signalled. The native child is identified
by exact parent PID, executable and owned vault argv, then verified exited; a
surviving owned child is force-cleaned and makes the pass fail. Temporary fixture
vault/profile data are deleted in `finally`; evidence remains in `--out`.

Preparation checks (no Electron launch):

```sh
node --check tests/workblock-electron-integration/run.mjs
node --check tests/workblock-electron-integration/cdp.mjs
```
