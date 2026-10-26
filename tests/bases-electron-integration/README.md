# Actual Electron Bases heavy-user journey

This launches the normal production Electron app against a fresh disposable vault,
with 72 books, heterogeneous properties, authors, a full literal template and four
saved layouts. It performs UI actions through CDP hit-tested pointer input and
keyboard input. DOM evaluation locates/reads controls and decodes the disposable
cover image for a pixel oracle. Keyboard separator focus uses actual menu
cancellation and Tab navigation.
Explicit synthetic typed Bases/plain ClipboardEvents go to the production paste
handler. No production data/controller APIs mutate positive state.

The reverse-relation oracle inventories every saved Markdown file, including the
literal `Templates/Book.md`. Library's own template-folder filter does not exclude
that ordinary note from the vault-wide relation graph. After Book001's intended
reassignment, Ada has 35 numbered books plus the template (36 incoming files),
and Grace has 37 numbered books. Both exact incoming path lists, numeric counts,
rating averages and read-only derived cells are checked. All 72 original author
spellings, complete note bodies, both author sources and literal template bytes
remain guarded. This corrects the numbered-books-only Ada oracle in actual heavy
20261026-001; that failed run remains failed and requires a fresh native pass.

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
This attempts to bring the owned page forward and sends AppKit unhide/activation
requests. The runner verifies the exact owned app PID is unhidden, a CoreGraphics
on-screen layer0 window owned by that PID has positive bounds, and the renderer's
actual `document.visibilityState` and `document.hidden` report visible/false.
Request acceptance, native `isActive` and document `hasFocus()` are recorded as
diagnostics; they cannot substitute for actual visibility and are not required
to be true. macOS can decline foreground activation while a window remains on
screen. Document state is captured before policy assertions for complete failure
diagnostics. Native receipts and renderer observations are retained.
It does not override visibility, clock policy or production queries. Such a run
uses an actual visible window and can be affected by user interaction; input is
still CDP automation and establishes neither OS foreground nor physical keyboard
parity. No production activation or query policy is changed.
The default hidden proof and cleanup behavior remain unchanged.

An explicitly granted run may add `--show-window --cua-native-selects` to use
CUA for native HTML SELECT controls. This mode is source-authored and must not be
enabled for the full journey until the separate direct native-option probe passes.
It is admitted only for the default heavy journey or an existing canonical owned
campaign, and is mutually exclusive with the window bootstrap and the minimal
probe's `--cua-native-select-checkpoint` flag. With neither flag, CDP input stays
unchanged. Custom comboboxes continue through the existing CDP pointer branch.

Each native select invocation writes a fresh numbered
`native-select-cua-NNNN-UUID/ready.json` under the evidence directory and emits
`CUA_NATIVE_SELECT_READY`. Its nonce binds the current exact owned app PID,
executable/profile, one freshly observed native window and actual visible
renderer to the requested option's value, visible label and index. The request
exposes a selector SHA256 instead of the raw selector. Existing private action
frames retain their ordinary diagnostic selector. The coordinator verifies the
exact app/vault/control in CUA, opens the native menu if needed and clicks the
actually visible requested option. Do not infer success from index arithmetic.

After input, write only the ready receipt's advertised
`{"token":"EXACT_FRESH_NONCE","action":"continue"}` to its `continueFile`.
Every call has its own five-minute deadline; old tokens cannot release a later
call. The signal supplies no selected value or product state. The existing exact
DOM value readback, Apply actions, independent full-file assertions, restart and
normal cleanup remain mandatory. No input fallback, skip, value assignment or
synthetic DOM event is added. Record the CUA interactions separately; report a
successful run as mixed CDP/CUA execution without claiming hardware-keyboard or
default-CDP native-menu acceptance. The current heavy journey has two native
color selections; its other five select calls use custom comboboxes.

Offline evidence-policy checks:
`node --test tests/bases-electron-integration/window-visibility.test.mjs`.
They reject activation-only or wrong-window evidence but do not replace a native
visible-window runtime pass.

On macOS, `node --test tests/bases-electron-integration/window-native-adapter.test.mjs`
executes the runner's exact read-only CGWindow adapter against the existing desktop.
It requires macOS desktop access. Use an authorized desktop-enabled tool context
(such as `require_escalated` in the agent environment), or a desktop terminal.
A restricted sandbox can return an inaccessible CF reference; that remains a
test failure and is not bypassed with a fake window list or a visibility override.
It casts the returned CFArrayRef through `ObjC.castRefToObject` before conversion,
checks the JavaScript array length against `CFArrayGetCount`, and filters only the
test process PID. It opens/activates no application and records no window titles
or content. This native bridge regression complements the policy checks; actual
owned-window activation and document visibility still require the granted run.

For a minimal **harness-only** native-window/normal-quit probe, the coordinator
may grant an explicit source/artifact association and use:

```sh
node tests/bases-electron-integration/window-probe.mjs \
  --root /absolute/frozen/frontend --expected-head FULL_COMMIT \
  --native /absolute/explicitly-associated/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-owned-window-probe-UNIQUE \
  --ready owned-window-bootstrap-frozen
```

The wrapper opts into a genuinely visible window. This separate readiness gate
admits one harmless note fixture, launches the normal app, verifies native/window
and document visibility, captures one screenshot and quits normally. It runs no
Bases campaign or CRUD journey. Evidence explicitly disclaims Bases, Rust semantic
and matching-native product acceptance while retaining actual source/artifact
hashes. It cannot be combined with `--campaign-module`; normal product campaigns
continue to require `bases-native-and-frontend-frozen`. An intermediate host may
be used only for this limited probe with the coordinator's explicit association;
it cannot silently establish acceptance for different Rust sources.

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
