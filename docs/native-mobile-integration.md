# Native mobile integration

Owner: terminal `term_bbf1787b-d2e5-402a-b366-24d40a2385c3`, original base
main `f69dc90`. Current isolated branch `tingkai-c/native-mobile-recovery`, Orca
worktree `/Users/ctk/orca/workspaces/Zorid/native-mobile-recovery`. Canonical main
`a160739` was merged into this isolated branch. Coordinator inbox
`run:run_3e72b2c9ab72` is sole main integrator; this owner never mutates main/pushes.

## Framework and binding decision

SwiftUI owns the requested native Recents/Files pages and page controls, hosted
alongside UIKit launch, app-local vault creation/selection and editor navigation.
UIKit retains safe-area/keyboard viewport layout around the existing Capacitor8
WKWebView and shared web editor. A small independent `mobile/rust` staticlib/C ABI
embeds the existing Rust host dispatcher/vault/SQLite core in-process. No third-party
UI framework, daemon, new editor or Swift Markdown/Base/index implementation is
introduced. Stage4 query APIs will
be consumed incrementally. Existing Capacitor/filesystem code stays in source.

Native selects trusted roots before editor launch; web requests cannot select a
filesystem root, executable, sync endpoint or credentials. Same bounded typed
JSON/binary frames, client leases, checkpoints and durable intents as desktop.
The embedded entrypoint additionally denies trusted-main apply/recover/rescan and
fixture sync mutations even when the web caller omits a lease. Terminal framing
errors/panics fence and drop that host generation; retained request/checkpoint IDs
remain authoritative on reopen. Swift serial queue owns every ABI call/free/close.
Sanitized startup reconciliation status must be visible, including incomplete
inventory/recovery; a trusted bounded native refresh supports retry.

Initial roots are app-owned local `Documents/Vaults/<UUID>` folders; catalog and
canonical lowercase consumer UUIDs persist before use. Arbitrary iCloud/provider
folders and Android SAF need separate permission/storage integration. Android can
reuse Capacitor plus JNI/C ABI, but Rust1.89 File::try_lock is unsupported there;
source cfg enablement alone does not establish usable Android storage. See
[Unix readiness](mobile-unix-readiness.md). No real vault migration has run.

## Lifecycle contract

Native plugin emits `lifecycleRequest {id,reason:background|switchVault}`. Adapter
subscribes before context/open. Workspace must flush existing shared save/checkpoint
paths, save session and await an explicit native ACK callback. Switch quiesces
editing until ACK success; failed/stale ACK restores editing. Never destroy/release
the workspace before ACK, because a native timeout must retain a usable editor.
Successful native switch ACK owns queued-call drain, Rust lease/host drop and pop.
Background uses a bounded UIApplication task, never destroys/closes the workspace,
and timeout/OS expiry makes no completed-save claim. Missing handlers fail closed.
The precise workspace flush/session/ACK hook was scoped and implemented in913618a;
its focused harness passes, with native runtime verification still pending.

## Scoped commits and checks

- Original worker adapter8dff9a2 importedde0f223; lifecycle85e292b imported35e98ad.
  Focused combined24/24 tests passed, Node --test --test-concurrency=1; these are
  mock transport/contract checks, not native runtime evidence.
- Shell d2f84b4 imported1f5358f; canonical UUID/startup followup e9fdea6 imported
  0dceefd. Swift frontend syntax parse and plutil checks passed, no type/link claim.
- Shared Rust extraction/C ABI edcbc8b includes focused host embedding admission,
  checkpoint/restart and trailing-frame tests; rerun after recovery remains required.
- Platform/PBX/header wiring76b346b, independent mobile lock3fae504. Root manifests
  and locks unchanged. Desktop/browser earlier selection paths remain unchanged.
- Independent Unix review a36d9ae imported5484300; source review caught/fixed uppercase
  client IDs, embedded unleased trusted-command bypass, missing startup diagnostics
  and unpoisoned panic-session reuse. No runtime acceptance follows from review.
- Apple helpers d495348 imported7302ed4. Delivery9ac5f1a imported1140486 owns only
  new mobile-ios workflow/scripts/delivery doc. Source validation only; no upload.

## Observed environment and runtime evidence

Coordinator granted exclusive feasibility slot. Global rustup download/toolchain
directories are root-owned; no ownership was changed. A task-owned copy-on-write
Rust1.95 with both iOS targets and WASM target passed `cargo check --manifest-path
mobile/rust/Cargo.toml --target aarch64-apple-ios-sim -j1 --offline`, explicit owned
Cargo and RUSTC, exec73583 exit0 in1m32s. Initial Homebrew attempt failed missing
target because PATH rustc ignores RUSTUP_HOME. This was target compilation only.

Orca attached iPhone17 UDID1274C6C8-5F07-4A30-8B8C-415B286E6801, iOS26.3.1,
helper41097. First accessibility read timed out. Orca shutdown completed ok:true,
exec93135 exit0. No app was installed/launched in that pass. Slot explicitly released.

At19:16UTC the active original native-mobile-ios checkout and owned toolchain
unexpectedly disappeared, as did some other sessions' worktrees. Coordinator
notified; cause unknown. Committed source recovered through Orca into this branch,
uncommitted extraction recovered from retained scripts then committed. Original
check applies to its observed source only; recovered/fixed source requires repeat
compile/link/runtime. No test app/simulator is currently owned/running.

## Signing, TestFlight and delivery

User directly authorizes `~/certificates` credentials, ASC management, TestFlight
setup/internal tester `tingkaichiu.ca@gmail.com`, GitHub CI and local deployment.
Keys/passwords/JWT stay out of source/logs. API authentication works; existing
Developer ID material is macOS, iOS distribution certificate/profile unverified.
Official apps/bundleIds/users/invitations API returned403
REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED. User accepted the agreement; refreshed
Developer page verifies October13 agreement acceptedOctober17. Subsequent Apple
API still403 through19:17:39; exact fresh retries recorded separately. Do not ask
the user to sign again solely from stale ASC warning. No app/group/tester/signing
mutation, GitHub secret write, signed archive or upload has succeeded yet.
[Delivery commands/contracts](native-mobile-delivery.md), [Apple diagnostics](../mobile/apple/README.md).

## Next acceptance gates

Obtain next acknowledged heavy slot, recreate/reuse stable owned toolchain, build
staticlib and affected host/process tests serially, then existing web bundle/Xcode
simulator link. Through Orca automatically create/select disposable vault, edit
and save note, reopen and independently inspect exact disk/core bytes. Verify
keyboard/safe-area/selection/rotation/navigation, background flush, terminate/reopen
retained draft/conflict recovery and core filesystem locking/fsync/no-clobber.
Then incrementally connect existing sync under native-owned credentials, and make
actual signed device archive/TestFlight upload once Apple account access permits.
Simulator, device, source, compile and signed-upload results stay separate.

## Follow-up checkpoint — 19:28 UTC

Shared toolchain recovered to stable canonical ignored
`/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin`.
Actual simulator staticlib build41020 passed exit0 in1m15s (82MiB library; exported
open/request/startup/refresh/free/close symbols verified). Subsequent ABI guard
refactor/tests7932b4b requires incremental rebuild before using the app artifact.

Affected host check71034: unit tests8/8 pass; existing subprocess13/15 pass,
command unoptimized `cargo test --locked -p zorid-desktop-host --lib --test process
-j1 --offline -- --test-threads=1`. Two failures remain explicitly unaccepted:
old family fixture startup failed credentials_invalid; streaming test host ended
at60s watchdog, causing UnexpectedEof. Separate disposable process probe confirms
same v1/no-transport config fails and v2/grpc starts successfully. Coordinator
approved fixture-only736cc82 correction, preserving production protocol/budgets.
Matching prior accepted command-only test opt-level1 rerun remains required;
watchdog coincidence alone is not regression diagnosis. All owned test hosts exit.
Exclusive slot released; coordinator Stage4 parser owns the next slot.

Independent source review4d37f97 imported e6c8eaa found three mobile P2s, all now
addressed in source: release commands omit outer lease dc32278, Android keeps its
existing adapter until JNI727c985, validated host commit_uncertain is preserved
d860a67. Native fixed-consumer claims and lowercase lifecycle IDs03ed9cf,
validated reconciliation+retry f0ea3b5, compiler override8ccaad4 and workspace
flush/session/ACK seam913618a are integrated only in this isolated branch.
Combined focused mobile60+workspace7 checks pass67/67; separate affected existing
platform checks14/14 pass. These use mocks/small DOM harnesses, not app runtime.
Independent closure source review is running. No Swift link, simulator app, signed
archive, TestFlight readiness or mobile sync success is claimed.

User asked what the native shell is like and noted no mobile UI discussion had
occurred. Clarified this is a minimal UIKit/local-vault/nav plus existing-editor
prototype to prove Rust integration, not a settled mobile product design. Broader
visual/navigation design remains open; no editor polish redesign is underway.

Remote GitHub configuration (2026-10-17, after direct user authorization): GET for
both delivery environments returned404; created `ios-build` and `ios-testflight`
with custom branch policies enabled, then added `main` of type `branch`. Follow-up
GET confirmed each lists exactly that policy. No signing/API secrets written,
workflow pushed/dispatched, runner build or deployment performed. This configures
the protected destination for the committed manual workflow; it does not establish
that workflow/build/sign/upload succeeds. Latest fresh Apple four-endpoint retry
still returned403 agreement-required after the user acceptance was verified.

## User shell design steering — 2026-10-17

User supplied `/Users/ctk/Downloads/IMG_1738.PNG` as visual direction: dark native
home, top-left settings/avatar control, horizontal pill-style tab row. Users add,
remove and choose their native page tabs. Full requested default-page inventory:
Recents, Home, Files, Tasks, Calendar. Implement **Recents and Files only now**;
Home/Tasks/Calendar stay deferred. Both lists/pages must be native SwiftUI pages,
with current Rust metadata/snapshot APIs as data authority; no new Swift Markdown,
Base or index semantics. Existing shared web editor remains the note editor.

This supersedes the minimal launch-picker/direct-editor prototype as the desired
shell presentation. Vault creation/selection remains native onboarding/settings.
User confirmed: tapping a note opens the existing editor, then Back returns to
the originating native page. Notes do not become top-row native page tabs.
No screenshot-proprietary source/assets copied.

User explicitly requests the installed SwiftUI/iOS skills, Liquid Glass and
animations. Native Recents/Files use SwiftUI hosted alongside the existing UIKit
Capacitor editor bridge. Apply iOS26 Liquid Glass to functional navigation and
controls, group related effects, retain an availability-gated earlier-iOS fallback,
and respect Reduce Motion/Transparency, Dynamic Type and VoiceOver. Keep animation
state on the main actor, stable row/control IDs, and expensive Rust work outside
animation closures. Applied skills: swiftui-liquid-glass, swiftui-animation,
swiftui-navigation, swiftui-uikit-interop, swift-architecture, ios-accessibility
and ios-simulator. These are implementation requirements; visual/accessibility
acceptance still requires actual app verification.

Native Swift worker owns NativeMobile.swift, SceneDelegate.swift and new
NativePages.swift in mobile-ios-shell. Shared initialPath/noteOpened seams are
requested from coordinator before edits. Native-owned recent-open history is
device-local UI state keyed by vault and stable Rust entry ID; current paths and
file listings come from Rust snapshots. No Swift Markdown/Base/index semantics.
