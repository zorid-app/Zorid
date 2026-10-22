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
owned app runs at a time; by default it is verified hidden before edits so CDP
input cannot type into another app. Positive creation and changes use ordinary UI controls;
prelaunch files and explicit external-editor negative fixtures are separately
labeled. Normal quit/restart requires signal-free exit; cleanup signals cannot
satisfy that assertion. Cleanup validates exact owned native processes.

The journey fails on unavailable controls or assertions. An unexecuted section is
not reported as passed. The scope ledger in
`docs/history/bases-heavy-user-e2e-plan.md` distinguishes authored scenarios from
actual runtime acceptance. This is functional end-to-end verification, not a
performance/large-vault benchmark, OS foreground-focus test or mobile claim.

Pass the explicit `--show-window` flag for campaigns that require a genuinely
visible document, including ordinary-note property queries gated on visibility.
This brings the owned page forward and sends AppKit unhide/activation requests.
The runner then verifies the exact owned app PID is active/unhidden, a CoreGraphics
on-screen layer0 window owned by that PID has positive bounds, and the renderer's
actual `document.visibilityState`, `document.hidden` and `document.hasFocus()`
report visible/false/true. Native receipts and renderer observations are retained.
It does not override visibility, clock policy or production queries. Such a run
uses an actual foreground window and can be affected by user interaction; input
is still CDP automation and does not establish physical keyboard parity.
The default hidden proof and cleanup behavior remain unchanged.

Offline evidence-policy checks:
`node --test tests/bases-electron-integration/window-visibility.test.mjs`.
They reject activation-only or wrong-window evidence but do not replace a native
visible-window runtime pass.

Explicit supplemental campaigns can reuse this same bootstrap with
`--campaign-module /absolute/tests/OWNED-CAMPAIGN/campaign.mjs`. The fixed owned
directories are visual-reference, safety, config, properties, clipboard, layouts and recovery under
tests/bases-*. A module exports `fixtureFiles(): Map<string,string|Buffer>` and
`async journey(c)`, optionally `template` and a safe `vaultName` basename. It owns
the complete fixture map: automatic Properties.yaml and Created injection are
disabled. The default heavy journey has the same original fixtures and behavior.

The context supplies `ui`/`cdp` getters; `vault`, `yaml`, `template`, `evidence`,
`outputDirectory`; `launch(name)`, `quit(name)`, `read(file)`,
`saved(file, check, name)`, `frontmatter(source)`, `screenshot(label)`,
`external(file, source, label)`, `diskGuard()` and `prepareDownloads()`. Existing
helper signatures are unchanged. Staged offline fixtures require an awaited
normal quit before guarded filesystem writes and explicit fixture evidence.
Positive user mutations still use actual UI. All admitted sibling campaign
directories are hashed before/after, including imported clipboard helpers and
explicit absent directories. The same explicit freeze/runtime grant applies.
Initial fixture writes, normal readback and external-editor writes share a strict
vault-relative path guard that rejects absolute names, traversal, backslashes,
NULs and existing symlinks. Bounded offline guard checks run with
`node --test tests/bases-electron-integration/owned-fixtures.test.mjs`.

Only the explicitly admitted recovery campaign may additionally export
`createNativeRelay({ native, directory })`. The native path remains the exact
matched genuine host. The factory returns its generated regular executable,
`directory`, immutable `provenanceFiles`, exact `processIdentity` executable/argv
prefix, and `arm`, `release`, `events`, `dispose` controls. The runner hashes the
genuine host, generated wrapper, helper sources and Node executable separately.
The normal application still receives only its existing host-executable option.

Recovery context adds a frozen `relay` facade with `arm`, `release`, `events` and
an explicit `forceShutdown(name)` negative interruption. It never satisfies a
normal quit assertion. Startup validates the actual app→relay→genuine-host PID,
parent and exact-command chain. Cleanup retains both PID/command identities even
after reparenting, waits for closure, and reports/kills leftovers as failures.
Lifecycle evidence and genuine response/receipt hashes remain with the campaign.
The recovery module owns selection/hold/drop of real frames; this bootstrap does
not manufacture acknowledgements. No relay is created for any default/other run.

Bounded ownership checks require no application or native host:
`node --test tests/bases-electron-integration/native-ownership.test.mjs`.
