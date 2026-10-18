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
Immediately after normal launcher admission, it validates the exact owned PID,
executable and profile and requests `NSRunningApplication.hide()` through AppKit.
The raw hide return and verified hidden state are recorded before any edits.
An already-hidden app or a false hide return does not invalidate observed hidden state. CDP operates the
hidden test window so incidental typing in other applications cannot land in it.
Screenshots capture the rendered surface directly because hidden apps may pause
animation-frame callbacks. This is hidden-app CDP verification, not foreground OS
keyboard/focus parity.

It creates a note using the ordinary New note control, enters five successive
versions using actual keyboard input, waits for autosave and compares exact disk
bytes with normal bridge reads. It closes the exact owned window by main-process `BrowserWindow.close()` through
a loopback Node inspector before autosave's debounce. The inspector validates
the spawned PID, one window and exact dist URL; passive close/closed listeners
record the initial prevented close and subsequent allowed close. No production
handler is wrapped. This checks the native Electron API close guard, not an OS
traffic-light/AX click or renderer `window.close()`. A prior dirty renderer
`window.close()` attempt was vetoed before native close and remains a separately
recorded gap. It checks exact dirty bytes flushed and the native
host drained, restarts the same profile and reopens the created note. It then
makes another real dirty edit and immediately requests normal application quit
through `NSRunningApplication.terminate()` via AppKit, selecting only the exact
owned PID after revalidating its executable/profile. It records the raw AppKit result and requires
normal app/host exit, exact flushed bytes and another successful restart/reopen.
AppKit may return false while Electron asynchronously flushes; a raw request
result alone never establishes quit. The main inspector disconnects before app
termination so it cannot hold the process open. Dirty witnesses establish visible pending state and unchanged disk before either
close action; elapsed deadlines prevent accepting an ordinary prior autosave as
close/quit flush proof. It checks successful saves leave no `.previous`/staging/namespace
artifacts. It edits/saves the seeded note, opens the ordinary command palette,
types Version history, selects the real command and previews the original exact
snapshot without mutating the current source. It clicks Restore version, checks
ordinary editor/disk/bridge saved bytes, quits/restarts and verifies restoration
persists. No native menu, injected UI service or bridge mutation substitutes for
the palette/dialog flow. App-local SQLite contains the seed note's exact snapshot bytes outside
the vault, and snapshots survive restart. No private paths/status codes enter the
visible opening UI. Screenshots, hashes, process outcomes and assertions are
retained in the evidence directory. The disposable vault/profile remain there for
inspection; owned test app/host processes are closed after each pass. Signals are
cleanup-only fallbacks; a fallback cannot satisfy normal application quit.
The AppKit path is macOS-specific and never targets an application by name.

For independent lifecycle diagnosis, `--scenario live-quit-history` saves one
ordinary version then starts with the dirty live-window quit and history sequence,
without repeating the native window-close scenario. `--quit-method appkit` is the
default real AppKit request; a separately labeled `--quit-method main-api` invokes
the exact-owned Electron `app.quit()` API and must not be reported as OS quit.
Passive app before-quit/will-quit/quit witnesses are retained in stdout. The main
inspector disconnects immediately after the request. A failed no-window AppKit
quit remains separate evidence even if another scenario succeeds.

This is a bounded desktop runtime subset, not complete S0 acceptance. It does not
exercise abrupt crash/power loss, external open handles, multi-client concurrency,
expiry/five-minute waiting, stale/dirty/failing restore variants, browser/mobile
or sync. Snapshot metadata inspection uses a read-only SQLite connection; UI
preview/restore acceptance is limited to the explicit existing-note scenario.


# Clipboard image event-pipeline regression

`clipboard.mjs` drives the actual CodeMirror paste handler with immutable PNG
Files in a DataTransfer/ClipboardEvent. It never reads or replaces the system
clipboard. It uses a new disposable vault/profile/app-data root, hides only its
exact owned PID, and excludes the user's separately recorded manual playground.

```sh
node tests/storage-electron-integration/clipboard.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-clipboard-evidence \
  --ready clipboard-artifacts-frozen --seed-embeds 2
```

Add `--diagnostic` only for an explicit diagnosis pass: CDP pauses caught
exceptions briefly, captures exact codes/stacks and resumes them. It changes
scheduling, so acceptance requires a separate clean run without that flag. The
normal assertions require the exact payload hash multiset and byte-for-byte files,
unchanged seed images, exact saved embed targets and one corresponding current
rendered image per target with decoded 128×64 dimensions and a SHA-256 of its
decoded RGBA pixels matching that exact filename's deterministic input pixels.
This reads the existing decoded image into a bounded 128×64 canvas and starts no
new native read. Production CSP blocks direct blob fetch; it remains enabled.
PNG file bytes are checked independently, while pixel hashes catch swapped reads
between same-sized image targets. This does not claim compressed blob-body inspection. No visible binary-transfer
failure is allowed. Rather than a fixed sleep, a 30-second observed deadline records
native-acquisition/blob-source and decoder progress. In the hidden fixture only,
targets are scrolled within the renderer, image loading is set to eager and
`img.decode()` is requested. This explicit test action distinguishes native I/O
completion from deferred hidden Chromium lazy loading. It does not establish
natural foreground lazy-loading, OS focus or system-clipboard behavior. Existing embeds are important concurrent readers; serial imports alone
do not establish concurrent preview/read behavior.

The original red diagnostic on c47d9717 preserved both PNG files and both embeds
but reported `binary_busy` from desktop openRead through Vault.readBinary and
AttachmentResources.acquire. The UI showed the generic binary transfer error.
The scheduler owner supplies the fix; this harness contains no production shim.
Evidence output is resolved through existing ancestor symlinks and rejected when
it equals or descends from source, harness or the recorded manual playground root,
before creating output. The optional manual pointer is enforced when present;
malformed pointers fail closed. Clean mode issues no Debugger commands, including
cleanup. Diagnostic capture errors fail the diagnostic result.
