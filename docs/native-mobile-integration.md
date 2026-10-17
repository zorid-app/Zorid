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


## Native SwiftUI and verification checkpoint — 19:54 UTC

Source imports: native293f52ab -> bb69fbee; adapter43247217 ->3368f734,
3686c844 ->270c84b9; PBX source registrationfec0c7bb. Native identity/visibility
fixes a9bc3b34+676e5b52 ->77531ff3+aa945e7d preserve opaque case-sensitive Rust
EntryId and exact UTF8 path bytes, resolve selected current ID before handoff,
hide dot namespaces/trash, and perform trusted refresh before Reload. Context
initialPath+initialEntryId is paired; noteOpened requires exact path+entryId and
fresh native Rust validation. Workspace seam63040493 consumes initial selection
after admission/recovery and metadata ID validation, with same-read adapter ID
fences before selected note bytes escape. Incidental indexing/recovery does not
consume the initial guard. Notifications are nonfatal and require active rendered
view success, with pending/failed/stale viewer coverage. Final Base error-state
closure checks resolved session state.error/result; no view success inferred merely
from settled ready.

Coordinator explicitly granted/froze narrow workspace/platform activation seams.
Host22634 matching prior accepted command-only CARGO_PROFILE_TEST_OPT_LEVEL=1,
official Rust1.95, --locked/-j1/one test thread: unit8/8 and subprocess15/15 PASS,
subprocess50.95s including17MiB streaming. Original unoptimized failure remains
recorded above; no production watchdog/protocol relaxation. ABI62353 PASS2/2,
including panic fences/drops invisible lease and exact owned buffer/free contract.
Updated simulator staticlib46563 PASS26.59s, aarch64-apple-ios-sim debug. All three
handles exited0; heavy slot explicitly released for coordinator Store/index/CLI
checks. Next mobile web/TypeScript/Xcode/Orca slot requested. No app/simulator is
running and no iOS app type/link/runtime/visual/accessibility claim follows.

Focused combined Node suite95adapter+7lifecycle+10navigation PASS112/112 exit0,
with injected DOM editor/viewers; subsequent11/11 navigation rerun passes including
the additional Base retained-error case. These are focused seam checks, not iOS runtime evidence.
Logs are ignored canonical tmp/mobile-host-opt1-check.log, mobile-ffi-check.log,
mobile-staticlib-final.log and mobile-navigation-check.log.

Apple helper individual-key auth source2469de9d imported4810ddf6. User explicitly
authorized trying acceptance of the agreement already read/agreed, then contacting
Apple Support. Correct same-team team key and downloaded Account Holder individual
key still return agreement-required; Developer and ASC Business have no acceptance
control because agreement already shows accepted. Actual official Apple Developer
Support email case submitted and confirmation verified19:53:16UTC under Membership
and Account / Agreements and Contracts. Private case number/message/receipt kept
outside tracked source; Apple will review/reply. No claimed root cause or access
resolution, no duplicate case or secret material sent. TestFlight provisioning and
upload remain pending Apple access; app implementation continues independently.


## Direct device trial and variants — 20:08 UTC

User plugged in iPhone16Pro and requested direct app trial plus simulator testing.
Actual CoreDevice query confirms paired wired connection, Developer Mode enabled,
DDI services available, iOS27.0.1. Apple owner verified an existing local Apple
Development identity/private key and unexpired wildcard development profile cover
this device; no ASC app record, new certificate or provisioning request is needed.
Private signing contract/profile live under ~/certificates/apple/apps/zorid/development;
no private values enter tracked source. Current direct app is separately identified
app.zorid.notes.dev / Zorid Dev to protect any existing production app/data.
Development sourceee5f7236->be3620fd plus manual-signingfa8ac4bc->bb159639,
display-name expansion4c299d86 and Apple evidencefcd035b8->54b0a621.

Full TypeScript54737 PASS exit0. Simulator app8510 production desktop-target
webpack, cap copy ios, current Rust staticlib and Xcode26.3 App Debug arm64 build
PASS exit0, including real Swift typecheck/link. Artifact retained outside repo:
/private/tmp/zorid-ios-sim-20261017/DerivedData/Build/Products/Debug-iphonesimulator/App.app.
No simulator interaction/visual acceptance follows from this compilation yet.
Physical attempt65292 exited101 at cap-copy ENOSPC before Rust/signing. Deleted
only this worktree's marked generated host/ABI target cache (761MiB); retained
source, prior logs, simulator app and mobile Rust target. df then2.7GiB available.
Retry87781 is live on the same frozen source with fresh output
/private/tmp/zorid-ios-device-20261017-r2. Actual signing/install remain pending.
Coordinator explicitly granted exclusive device/simulator slot; no concurrent
root heavy job. Native package resolution generated an iOS SwiftPM lock to review.

User additionally requires formal dev/prod variants with different names, bundle
IDs and future strings/UI. Native worker owns iOS-only xcconfigs/shared schemes,
project settings and optional AppVariant metadata accessor in its isolated
mobile-ios-shell branch; no root build-tool dependency, editor/platform redesign
or differing feature set is introduced. Dev/prod must remain independent of
Debug/Release optimization and preserve existing App/legacy-config compatibility.
Native/delivery workers coordinate exact config, output path, metadata and flags.
Owner will import project/script changes only after live phone build terminates.

## User presentation correction — 2026-10-17

The phone trial exposed full web workspace frames. User explicitly requests only
the actual document editor embedded in the native shell: retain title, properties,
body and recovery notices; remove web tabs, ribbon, sidebars, pane toolbar and
status frames. Native Back returns to the originating native page. Native New note
uses the shared Workspace.newNote path after admission, with no Swift file writer.
Native document presentation starts one pane without restoring desktop layouts;
retained durable recovery buffers still load before selection.

Latest references: Downloads IMG_1741.PNG requests a rounded keyboard toolbar
that appears on typing-area focus; 3CF4F72C-40CB-4DE1-B9C7-42AED0A69E1E.png
replaces the earlier top page pills with a system native bottom tab bar. Recents
and Files remain the implemented pages; customization/settings remain native.
Keyboard toolbar actions must call existing editor commands and preserve selection,
undo, IME and durable saves. Native source and runtime validation pending.

Actual pre-correction runtime: signed development app installed and launched on
the paired iPhone (CoreDevice install80894/launch63110 exit0). Simulator fixture
created through native vault selection; shared editor saved exact43-byte body
`Rust-backed mobile body saved and reopened.`; native Back returned to Recents
and tapping that row reopened the same content. This proves this fixture save/
reopen, not final presentation, lifecycle or keyboard parity. The full workspace
chrome was rejected by the user. Simulator terminated and exact owned device
shutdown before yielding the heavy slot to the coordinator for bounded core proof.

Editor-only followups: autosave errors remain visible in a document-level notice
with shared Retry save. Retained conflicts outside the current document expose
Review draft and Save recovery copy using the existing shared NoteBuffer APIs;
removing sidebars must never hide recovery while Back waits for a safe flush.
Focused navigation/lifecycle suite now23/23 PASS, including actual failed save
retry and offscreen durable recovered-draft copy preservation. Full TypeScript
check31524 exit0 before these notice additions; final combined check pending.
Native keyboard callbacks are opt-in; native actions revalidate current runtime,
selection, composition and history, and optional presentation failures cannot fail
saving. Foreground visibility/focus republish actual state; teardown disables.

Attachment source correction: AttachmentResources already builds owned Blob URLs
from Vault.readBinary, which the mobile adapter supplies through Rust. Therefore
no additional resource-URL service is prerequisite for files within the current
16MiB whole-file limit. Image touch/lightbox, audio/video playback, packaged PDF.js
assets and Safari link routing remain actual iOS verification gates. Capacitor's
existing navigation delegate sends external top-level/new-window URLs to the
system. No verified media/PDF runtime claim yet.

Latest user screenshot removes Reload/Open editor action row. Native pages must
refresh automatically and open a tapped file directly; New note is a native
compose action, not an entry into a separate web workspace.

## Standing development-device authorization — 2026-10-17

User explicitly states that Zorid Dev data on their connected iPhone may be
overwritten and should not block development builds. Native owner may rebuild,
sign, install/update, overwrite or reset the app.zorid.notes.dev development app
and its disposable test data as needed for verification without asking again.
This authorization is scoped to Zorid Dev; it grants no deletion or reset of
production Zorid or unrelated applications/data. Existing signing/account
authorization remains in effect. Record this explicit authorization in any
necessary execution approval request; automatic review is still tool-owned.

Latest resource instruction (2026-10-17) supersedes earlier simulator shutdown
cleanup: keep the owned iOS simulator booted between checks because cold startup
is slow. Stop only agent test apps/automation streams as appropriate. Explicit
slots apply to iOS builds/simulator work; ordinary web/desktop builds and focused
tests may proceed with bounded parallelism and actual memory-aware coordination.

Frozen simulator build64019928: full ios-build.sh simulator22914 exit0, Xcode
BUILD SUCCEEDED; unchanged official Rust staticlib cached0.34s, production
webpack/cap copy succeeded. Artifact /private/tmp/zorid-ios-editor-only-20261017/
DerivedData/Build/Products/Debug-iphonesimulator/App.app. Native history followup
9c95378f and seamless appearance79076180 were added AFTER this artifact; they
require the next build/runtime pass. Final pre-artifact TypeScript check clean;
combined158 focused adapter/commands/navigation/lifecycle checks PASS. Native
independent review closed earlier save/recovery/lifecycle findings at source
level, not runtime parity. Simulator bootstatus67270 reached boot terminal after
2m01s; app install/launch is still tracked by the same process, no restart.


## Runtime and follow-up checkpoint — 2026-10-17 21:06 UTC

Owner remains native-mobile-recovery / tingkai-c/native-mobile-recovery, sole
main integration remains the shared-core coordinator. No mobile push/integration
was performed. Simulator install/launch process67270 finished exit0; the owned
iPhone17 Simulator1274C6C8-5F07-4A30-8B8C-415B286E6801 stays booted under the
latest user instruction. Its current app artifact is source64019928, before
route-history, accessory-removal and foreground fixes.

Observed with Orca automation: Recents and Files are native bottom tabs; Files
folder chevron expands inline independently of folder-body drill-in; direct
child list and metadata display, tapping Nested.md opens only document editor
content with native navigation. Tapping the body brings up the software keyboard
and the custom formatting toolbar. The older extra WebKit Previous/Next/Done
accessory remains visible in this artifact. Native Back returned to the file
page. Resolving the current Simulator container after reinstall and reading the
disposable vault file confirmed exact53-byte UTF-8 content:
`Nested file navigation fixture.\nToolbar verification.`
This proves this save path, not undo/redo, lifecycle or media playback.

Physical development artifact source d6ed276f built successfully (15167 exit0)
using App-Dev/Debug-Dev, official Rust1.95 with cached unchanged staticlib,
production webpack/cap copy, Xcode26.3 and cached Automatic signing. Artifact:
/private/tmp/zorid-ios-native-v2-device-20261017/DerivedData/Build/Products/
Debug-Dev-iphoneos/App.app. Verification/install/launch50642 exit0: strict deep
codesign check, bundle app.zorid.notes.dev, development environment and Zorid Dev
display-name assertions, exact paired iPhone install and launch succeeded.
Build log /private/tmp/mobile-native-v2-device-build.log is private; no credentials
are recorded in this document. This artifact includes native route history and
seamless editor appearance, but predates the pending keyboard/UI fixes.

User reports retained-focus foreground toolbar disappearance, focus layout jump,
slow vault opening and abrupt clipping of top-control shadows. The screenshot
clarification is explicitly shadow clipping, not Parent-folder spacing or shadow
intensity. Latest requested UI: remove +; fixed Settings bottom tab owns page
configuration; connected Liquid Glass back/forward capsule top-left, hidden on
root pages; skeletons during native and embedded attachment loading. Native
worker owns those Swift files; loading-state worker has coordinator permission
only for additive attachment loading attributes/cleanup, with mobile-only CSS.

Committed source a6672528 imports public WK inputAccessoryView=nil plus live
keyboardLayoutGuide geometry. Adapter0e2189e1 adds typed foreground state request
(coalesced across lifecycle ACK, stale generation suppressed),132 focused tests
reported by worker. Owner2d232466 wires optional callback to the current active
editor state even during WebKit DOM visibility lag. Focused workspace navigation/
lifecycle25 tests passed exit0, full tsc exit0, diff-check passed. These source
changes still require updated native compilation and actual runtime verification.

Apple remains blocked by agreement-state403 after the one fresh dual-key pass
at20:39:59UTC; support request already submitted privately. No TestFlight app,
internal tester, distribution provisioning, secrets or upload readiness is claimed.
Sync next step is read-only exact contract planning under coordinator permission,
not permission to edit shared host Rust or relax literal-loopback restrictions.


## Build4 crash finding — 2026-10-17 21:23 UTC

Build4 source c6e16cf8 is **not accepted**. The user reports any file opening
crashes the development app. Owner reproduced opening the saved Markdown note
in the iPhone17 Simulator: process92515 exited, and the app-specific unified log
contains UIViewControllerHierarchyInconsistency. NativeHistoryControls was
hosted by a UIHostingController added as a child of NativeEditorContainer, while
its view was placed in a UIBarButtonItem customView inside UINavigationController.
UIKit explicitly requires the navigation controller parent for that hierarchy.
The same phone development build4 crash report has SIGABRT and the corresponding
UIView hierarchy exception stack. Full device crash report stays private at
/private/tmp/mobile-phone-build4-crash.ips; no device metadata is copied here.
Simulator exception evidence: /private/tmp/mobile-v3-simulator-crash.log.

Compilation and installation evidence remain separate: first fresh phone18871
failed65 with verified ENOSPC. Owner removed only stale agent-generated tmp
outputs for original Simulator, device-r2/device-r3 and failedv3; retained current
Simulator and latest phone DerivedData. Incremental Xcode phone retry62876 passed0
using existing v2 DerivedData, with new build4 metadata; strict codesign, dev
bundle/environment/name/build-number assertions passed. Install/launch72707 both
passed0, then user/runtime exposed the crash. Simulator99928 compile passed0,
install/launch39338 passed0, native Files/Settings/root hidden arrows are visible
in AX, but the first verified file-open step crashes. These compile/launch passes
do not establish usable app or keyboard-bar removal.

Native owner is fixing the exact hosting containment error. Next validation must
build Simulator first, open files and exercise Back/Forward before installing the
replacement phone build. Preserve the connected glass design with supported view
ownership; do not silently remove the requested navigation feature. No vault
migration or user-data repair is justified by this UI exception.

Source-only presentation followups imported after build4: c6ac3518 optional
adapter UI notification, d77016cb guarded native skeleton dismissal, c81c8812
PDF password/error/ready callback. Workspace consumer remains unwired at this
checkpoint; these changes are not present in installed build4 and do not close
the known bounded eight-second password/error masking gap.


## Containment hotfix runtime checkpoint — 2026-10-17 21:39 UTC

Source51d8b84f imports reviewed c110a9f2: the navigation UIBarButtonItem now
holds UIHostingConfiguration.makeContentView on iOS16+, with framework-owned
hosting and configuration updates. iOS15 uses a connected UIKit button capsule.
The shared Liquid Glass surface remains on iOS26. There is no app-managed
UIHostingController child in the navigation-bar custom-view path.

Simulator build5 first attempt71295 passed Swift compilation but failed linking
with ld write errno28 (disk full). Owner removed only regenerable dependency
caches in this worktree's mobile/rust/target: host debug and both iOS debug/deps.
Both already-validated libzorid_mobile_ffi.a files, sources, official toolchain,
logs and vaults remain. Future Cargo checks must rebuild missing dependencies;
the hotfix Xcode-only retry reused the retained unchanged static libraries. Disk
then showed5.2GiB available (do not attribute all global free-space change to this
cleanup). Retry50983 passed0 BUILD SUCCEEDED; install/launch30708 passed0 on the
same booted Simulator, app PID13562. No phone installation preceded runtime proof.

Actual Orca/runtime evidence for build5:
- Saved43-byte Markdown note opened and displayed exact body; native Back
  returned to Files. Screenshot /private/tmp/mobile-v5-after-file-open.png.
- Folder drill-in, Nested.md open, Back to folder and Forward to the same saved
  note passed. Forward was temporarily disabled during host restoration; the
  harness was corrected to await enabled state before tapping. One AX query
  failed transiently; re-observation showed the same live PID, without restarting.
- Typing appended ` Hotfix input.` to the disposable nested note. Native Back
  returned to the folder; resolving the current app container and reading the
  Markdown confirmed exact67-byte content ending in that string.
- One tap on the image inside Orca-interactions.md opened the existing image
  viewer; screenshot /private/tmp/mobile-v5-image-viewer.png.
- No Previous/Next/Done accessory appeared in the observed focused/typing AX
  state. The software keyboard was not shown in that harness state, so custom
  floating toolbar and foreground recovery are still unverified here.
- Fixed Settings bottom tab and absence of +/root history controls were observed
  in native AX. Full customization persistence, shadow clipping across scroll,
  reduce-motion/loading timing and long-document bottom clearance remain gates.
- Sanitized phase logs: open~1.46–1.55s, listing~150–220ms, editorReady~5–6s
  in these Simulator runs. They are observations, not a complete latency profile.
- PDF-opening automation needs a stable navigation frame before tapping; its
  initial transition snapshot is not evidence of successful PDF rendering.

Phone hotfix build87290 stopped70 before compilation because the paired device
was unavailable. Generic iOS destination retry40602 then passed0 BUILD SUCCEEDED
for App-Dev/Debug-Dev/build5 using cached Automatic development provisioning.
Strict deep codesign, app.zorid.notes.dev, development environment and build5
assertions passed. Existing cache/artifact path now contains build5 (the old
physical build3/4 at that path has been overwritten):
/private/tmp/zorid-ios-native-v2-device-20261017/DerivedData/Build/Products/
Debug-Dev-iphoneos/App.app. Private build log:
/private/tmp/mobile-native-v4-device-generic-build.log.

Latest device inventory remains paired/DeveloperMode enabled but tunnel
unavailable and developer services false. Build5 has NOT been installed on the
iPhone. A reconnect/unlock request is pending; installation is already authorized
when the actual connection returns. All Xcode processes are terminal; coordinator
was told the build slot is released, Simulator stays booted. Build4 remains
unaccepted; the Simulator hotfix proof does not establish device-runtime parity.

Sync source worker separately prepared bbe26f1d on
tingkai-c/mobile-host-fixture-sync at approved Stage4 candidate39a306e7, preserving
the Apple setup branch. Only the three named host files were changed; no Rust
checks have run yet. Coordinator must acknowledge the bounded Rust check slot
and cache target before execution. Mobile FFI/Swift sync and real-phone remote
TLS/enrollment/Keychain remain later work; no sync-runtime completion is claimed.


## Resumed native owner checkpoint — 2026-10-17 22:03 UTC

Owner remains terminal term_bbf1787b-d2e5-402a-b366-24d40a2385c3, branch
tingkai-c/native-mobile-recovery in the isolated Orca worktree named above.
Canonical main remains coordinator-only. Goal resumed; no main edits or push.

Resolved canonical863334c7 into isolated merge7d04f2f3 under named grant
msg_e4d21dcde2bd. Three conflicts resolved: host lib is byte-identical to the
canonical second parent; PlatformVault retains shared document service and all
native hooks; Workspace retains seventh trailing post-await commitGuard, native
activation notification and both cleanup paths. Standalone mobile/rust/Cargo.lock
was stale despite matching both branches and was reconciled using official
Cargo generate-lockfile --offline (root lock unchanged by this resolution).
Official cargo metadata --offline --locked for mobile manifest passes with192
packages; this is graph validation, not compilation. Full TypeScript passes0.
Serial workspace navigation/lifecycle/backlinks + desktop document tests pass
32/32; mobile-native + document-backlinks pass152/152. Logs:
/private/tmp/mobile-main-merge-tsc.log, mobile-main-merge-focused-tests.log,
mobile-merge-extra-tests.log and mobile-main-merge-cargo-metadata.json.
Frozen independent review is assigned existing delivery reviewer; root retains
all Rust/Xcode build resources. Source checks do not verify merged iOS runtime.

Additional actual hotfix5 Simulator evidence: two-page local PDF rendered both
fixture page texts and page count2, with native navigation present and no UIKit
containment crash. Screenshot /private/tmp/mobile-v5-pdf.png; actual AX snapshot
/private/tmp/mobile-v5-pdf-rendered.json. This supersedes the earlier pending PDF
opening automation observation, not the password/error loading-state gap.

Signed phone hotfix5 remains uninstalled: current CoreDevice inventory reports
paired, Developer Mode enabled, tunnel unavailable, developer services false.
Existing signed artifact remains untouched. Install is already authorized when
connection returns. No new build or duplicate reconnect question was issued.

Presentation consumer work is assigned to existing mobile-slice-review worker
on a fresh branch from7d04f2f3: only PlatformVault optional signature, Workspace
native presentation wiring and focused tests. It must expose password/errors
without successful noteOpened/Recents and fence stale/lifecycle notifications.
Shared document transport assessment is read-only in mobile-editor-adapter;
root granted subsequent named source scope in msg_9bf740e528d3, after reviewed
reconciliation and inclusion of published hostfixture d94c3ae3. No shared core
crate changes, no renderer-accessible fixture sync/credentials, and no duplicated
Markdown/Base/index semantics are authorized by this next source scope.


### Reviewed reconciliation and next source ownership — 22:05 UTC

Independent source review msg_e1ee38f1a87b cleared7d04f2f3 with no blockers,
including all canonical/native guards and the standalone lock graph. Published
hostfixture d94c3ae3 was then merged without conflicts as ecf6f1a0; three host
files only, no dependency changes. This is not a merged-mobile build result.

Root grants msg_9bf740e528d3 / msg_ebe90f90ef9d name these isolated owners:
- mobile-ffi-fixture-sync: mobile/rust/src/lib.rs, include/zorid_mobile.h and
  focused FFI tests. Trusted fixture open/status/once only; raw bounded owned
  result buffers, pointer+length inputs, same host/client lease, no fallback.
- mobile-ios-shell fresh branch: ios/App/App/NativeMobile.swift only; validate
  actual startup documentSemantics?:true, forward same capability in context,
  keep raw framed response body bytes/base64 unchanged and fence terminal failure.
- mobile-editor-adapter fresh branch: mobile-native.ts/tests; reuse existing
  shared DocumentService and admitted Documents transport. Root separately grants
  minimal TextEncoder UTF8 portability in desktop/document-semantics.cjs plus
  declaration/focused tests, so mobile reuses existing wire validators/pin owner.
  Portability is a separate small commit for root's newer codec reconciliation.

Read-only native audit found recoverCommands returns true even with no recovered
operations, making Workspace initialize/index a second time. First watcher poll
may also emit a redundant refresh. Adapter owner investigates truthful change
reporting and consistent snapshot baselines in a separate mobile-only fix; no
measured latency improvement is claimed. Shared Vault/metadata semantics remain
unchanged. Root owns current WASM/browser build slot; no native compile started.
