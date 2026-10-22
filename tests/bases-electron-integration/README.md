# Actual Electron Bases heavy-user journey

This launches the normal production Electron app against a fresh disposable vault,
with 72 books, heterogeneous properties, authors, a full literal template and four
saved layouts. It performs UI actions through CDP hit-tested pointer input and
keyboard input. DOM evaluation locates/reads controls and decodes the disposable
cover image for a pixel oracle. Keyboard separator focus uses actual menu
cancellation and Tab navigation.
Explicit synthetic typed Bases/plain ClipboardEvents go to the production paste
handler. No production data/controller APIs mutate positive state.

Run only after the integration coordinator freezes matching frontend/native
artifacts and grants the runtime resource slot. The harness never builds.

```sh
node tests/bases-electron-integration/run.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-bases-evidence-UNIQUE \
  --ready bases-native-and-frontend-frozen
```

The output directory must be new, with an existing parent outside source trees.
CSV export uses the actual Results action and a Chromium test download directory;
it does not exercise the native Save dialog or write to the user's Downloads.
The disposable vault, profile, app data, screenshots, exact durable content,
actions, native process outcomes and source/artifact hashes remain there. One
owned app runs at a time; it is verified hidden before edits so CDP input cannot
type into another app. Positive creation and changes use ordinary UI controls;
prelaunch files and explicit external-editor negative fixtures are separately
labeled. Normal quit/restart requires signal-free exit; cleanup signals cannot
satisfy that assertion. Cleanup validates exact owned native processes.

The journey fails on unavailable controls or assertions. An unexecuted section is
not reported as passed. The scope ledger in
`docs/history/bases-heavy-user-e2e-plan.md` distinguishes authored scenarios from
actual runtime acceptance. This is functional end-to-end verification, not a
performance/large-vault benchmark, OS foreground-focus test or mobile claim.
