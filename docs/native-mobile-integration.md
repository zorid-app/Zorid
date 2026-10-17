# Native mobile integration

Owner: terminal `term_bbf1787b-d2e5-402a-b366-24d40a2385c3`, original base
main `f69dc90`. Current isolated branch `tingkai-c/native-mobile-recovery`, Orca
worktree `/Users/ctk/orca/workspaces/Zorid/native-mobile-recovery`. Published canonical main through `d94c3ae3` is included in this isolated branch
via reviewed reconciliation `7d04f2f3` and additive merge `ecf6f1a0`. Coordinator inbox
`run:run_3e72b2c9ab72` is sole main integrator; this owner never mutates main/pushes.

## Framework and binding decision

SwiftUI owns the requested native Recents/Files pages and page controls, hosted
alongside UIKit launch, app-local vault creation/selection and editor navigation.
UIKit retains safe-area/keyboard viewport layout around the existing Capacitor8
WKWebView and shared web editor. A small independent `mobile/rust` staticlib/C ABI
embeds the existing Rust host dispatcher/vault/SQLite core in-process. No third-party
UI framework, daemon, new editor or Swift Markdown/Base/index implementation is
introduced. Mobile now exposes the existing shared typed DocumentService through
admitted Rust Documents frames; actual combined WebView query verification
remains a build/runtime gate. Existing Capacitor/filesystem code stays in source.

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


## Actual keyboard pass and phone hotfix install — 22:11 UTC

Coordinator msg_2b4122caf634 granted a short UI-only pass on the same booted
iPhone17 Simulator, existing hotfix5 artifact/source51d8b84f. No new build.
Using Simulator's public I/O > Toggle Software Keyboard (CUA only for the menu),
actual Orca AX and native screenshot show the software keyboard with the native
Insert, Formatting, Undo, Redo and Dismiss controls, and no extra WK Previous/Next/
Done bar. Evidence /private/tmp/mobile-v5-software-keyboard.{json,png}.
Home and reactivation kept the same PID13562; iOS dismissed keyboard and toolbar.
The first harness assertion requiring toolbar without refocus was too strict.
Tapping the body again restored BOTH actual software keys and native formatting
toolbar, without the extra accessory. AX: mobile-v5-foreground-refocus.json.
This verifies refocus recovery for that actual artifact, not every lifecycle/IME
case. The focus-transition video exists, but a subsequent Orca AX transport failure
prevented a complete transient-jump assertion; that visual gate remains open.
Video recording and automation ended; test app terminated. Simulator stays booted.
UI slot returned in msg_ec625d0f9fd5 before coordinator desktop verification.

During the pass the physical iPhone reconnected (tunnel connected and developer
services true). Owner immediately verified artifact bundle app.zorid.notes.dev,
environment development, version5 and strict deep signature, then ran existing
ios-run.sh install and launch with private signing-contract device selection.
Owned process80513: install EXIT0 and launch EXIT0. Private logs:
/private/tmp/mobile-phone5-install.log and mobile-phone5-launch.log (0600).
Thus signed hotfix5/source51d8b84f IS NOW installed and launched on the iPhone,
superseding prior unavailable/uninstalled observations above. No new Xcode build,
production app mutation, fixture sync, TestFlight or shared-core merged runtime
claim follows. Actual phone file interaction after installation remains distinct
from the already observed Simulator open/navigation/save proof.


## Latest native page steering — 2026-10-17 22:17 UTC

Direct user correction supersedes the prior separate Recents/Files/Settings tabs:
combine Recents and Files into one bottom navigation page. A down chevron beside
the Recents heading opens a native mode menu for Recents or Files. Settings moves
out of the tab bar to a top-left gear visible only on the home/root page, never
inside a folder or editor. Owner stated the working interpretation to the user:
one Notes tab; home means the native vault root page, not a newly implemented
Home feature. Existing folder/list/history/save/lease behaviors remain required.
Both modes are available within this one page; old separate inclusion toggles
and a persisted Settings selection must not produce an empty page.

Existing Swift worker owns NativePages.swift only on a fresh isolated branch from
f7d78f6d, preserving the document-handshake branch. NativeMobile.swift, FFI and
shared editor source are frozen for this UI change. Source/syntax/focused checks
and independent review precede any next Xcode/Simulator/phone6 verification.

Combined source f7d78f6d (before this UI change) passes full TypeScript66766 exit0
and serial seven-file focused batch10205:240/240 pass, log
/private/tmp/mobile-combined-source-tests.log. FFI7523450d test85645 passes10/10,
official locked/offline/j1 exact mobile manifest, target/stage4-verified. Owner
verified FFI lib/header blob identity after import7d506d98, so no duplicate test
was launched. Independent source reviews ec40f143eddd (FFI+Swift) and
fa6a80667c3f (adapter+watch/recovery) report no blockers. These are not build6
link/runtime proofs; phone retains the actually installed hotfix5/source51d8b84f.

Orca runtime briefly became unavailable; failed latest-UI assignment explicitly
reported no input sent. Skill-directed orca open restored runtimef7efea81; worker
terminal371 was re-listed live before retry. Root durable inbox was notified.
Owner terminal listing changed, while orchestration caller still reports the
originalbbf identity; do not assume a new listed shell is the active agent.


## Single Notes page source ready — 2026-10-17 22:24 UTC

NativePages-only worker commit a23232f8 imported as0afe303c after scoped owner
and independent worker source review. One native Notes tab contains persistent
Recents/Files modes via the heading’s native Menu/Picker. Root-only top-left
glass settings gear opens a native sheet with Done and Choose vault. Folder
history capsule replaces the gear; editor contains no settings gear. Modal
dismissal precedes Choose vault; an intent arriving before page reappearance or
while reads drain is retained until the existing session can close safely.
Legacy Settings/invalid/empty optional-page preferences become Recents; valid
Files selection is retained. Both modes remain available and old inclusion
toggles are removed. Listing identities, direct file opens, folder disclosure,
compose, skeletons, glass shadow stacking and accessibility behavior are retained.
Worker Swift parse, diff check and focused source checks pass; actual Swift type/
link, menu/tab/sheet/persistence/accessibility/visual behavior are NOT yet proven.
No new Xcode build, Simulator pass or phone update followed this source import.

The remaining initial selected-entry overlay gap was closed in ec1ba9bd:
missing/replaced launch identity reveals the visible error notice immediately,
using only that original admitted launch identity, with no successful noteOpened
or replacement acknowledgement. Navigation suite43/43 and full tsc54340 pass0;
independent source review msg_612846095fe1 clean. Actual native overlay remains
a runtime gate.

Apple read-only retry22:22:39 UTC still returns403
FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED for GET apps and users. No
resource/account/legal changes, invites, upload or duplicate support case ran.
Existing Apple support case103000040642 remains the escalation. This does not
block the already installed signed development build5, but TestFlight remains
unavailable. Root retains its bounded desktop retry/build resources and will
announce canonical consumer integration before the next native build.


## Build 6 installed — 2026-10-17 22:40 UTC

Owner branch/worktree remains tingkai-c/native-mobile-recovery in
/Users/ctk/orca/workspaces/Zorid/native-mobile-recovery. Canonical308fc9ba
merged as02bf1fcc, retaining current shared document/Base/query behavior and
mobile lifecycle/presentation/lease hooks. Adapter witnessed rename fix ee94f6e3
imported as829cd2c9: capture optional entryId/revision before queue/signature,
reject stale source before mutation, preserve exact pending retry identity.
Final independent review msg_2439cdce7595 found no source blockers. Full composed
tsc5421 exits0; prior composed nine-file focused batch261/261 and locked offline
mobile metadata pass. Worker rename batch180/180 passes. No duplicate broad
checks were run after unchanged reviewed source.

Frozen runtime source829cd2c91c6a0bc72e7bac36f9818e325a9112ba built with
Xcode26.3, official Rust1.95 targets, mobile locked Cargo manifest and jobs1,
webpack desktop target and cap copy only. Root granted exclusive native slot;
Simulator54126 terminal0 BUILD SUCCEEDED, then signed Dev52508 terminal0 BUILD
SUCCEEDED. Simulator app.zorid.notes build6 installed/launched on existing booted
iPhone17. Actual initial root shows one Notes tab, Files list, settings gear and
no root history capsule. An initial assertion sampled vault-loading state and
was retried against settled UI. Detailed menu/navigation/keyboard/PDF checks
remain separately tracked. Two disposable encrypted/invalid PDF fixtures were
added only to the disposable Simulator vault; incomplete-scan status is under
source investigation and is not claimed as clean vault verification.

Physical iPhone: strict/deep signature verification and bundle/environment/build
assertions pass for app.zorid.notes.dev, development, build6. Exec24342 terminal0
reports install0 then launch0. This supersedes installed hotfix5; actual phone
file interaction remains unproven by installer success. Private build/install/
launch logs are /private/tmp/mobile-v6-phone-build.log and
/private/tmp/mobile-phone6-{install,launch}.log. Existing development signing
used with no provisioning updates. No production install, TestFlight upload or
App Store Connect changes. App artifact remains at
/private/tmp/zorid-ios-notes-v6-phone-20261017/DerivedData/Build/Products/Debug-Dev-iphoneos/App.app.

User asks whether hiding navigation on downward scroll is common. Recommended
iOS26 native bottom-tab minimization onScrollDown with restoration upward;
editor keeps route controls available. This was design advice, not an implemented
change in frozen build6.

Actual bounded build6 UI continuation passes: native heading Menu exposes Recents
and Files, selecting both updates heading under the same sole Notes tab; root
Settings opens a sheet containing Done/Choose vault, Done dismisses; folder row
drills into Orca-folder, hides settings and shows connected Back/Forward controls
(Forward disabled at history end). Exec87620 exits0; AX evidence
/private/tmp/mobile-v6-{recents-settled,files-selected,settings-sheet,folder-ready}.json.
Immediate AX after menu dismissal showed transient empty context-menu hierarchy;
the harness now waits for enabled targets and two stable frames. This is not a
product crash. Choose vault action, restart persistence, build6 note editing,
keyboard and password/error PDF flows remain pending. Simulator test app stopped
and helper closed; Simulator remains booted per user instruction.

Source-only scan investigation finds PDF decoding does not feed reconciliation:
PDFs are binary byte imports. Current native status labels overall reconciliation
complete=false as incomplete scan; this can also mean pending positive paths or
reconciliation issues after complete inventory. Actual cause needs bounded
reconciliation fields/issue codes, so do not hide warning or simply substitute
scanComplete. No speculative source fix was made.

Coordinator relays new physical-mobile finding22:41: title focused with keyboard
open, direct body tap collapses/reopens keyboard. Expected continuous title/body
focus transfer. Assigned existing presentation worker source investigation with
exact shared-file ownership required before edits; no additional build yet.
Root now owns Vite migration/root manifests, locks and asset/build pipeline.
Mobile requires dist/index.html + relative assets + desktop/native adapter
selection, then cap copy ios only; no unpublished Vite source consumed.


## Keyboard focus and native search — 2026-10-17 22:47 UTC

Previous goal turn made concrete progress: build6 compiled for Simulator and
iPhone, physical install/launch succeeded, bounded native page checks produced
actual AX evidence and ledger9c35d6d7 was sent merge_ready to sole integrator.
Full goal remains active; Apple API and multiple native/runtime gates remain.

Coordinator grants d809 the exact shared focus seam in msg22:43:18. Reviewed
worker004b9986 imported as1b9f6351: native-only blank-wrapper completed-touch
focus transfers to the owning editable CodeMirror inside the original gesture,
suppresses compatibility mouse blur, preserves scrolling/multitouch/cancellation/
selection/composition/current-owner fences and desktop mouse/content behavior.
Worker serial editor-empty-focus + workspace-note-focus31/31 and scoped strict
TypeScript pass, independent source review clean. Owner composed full tsc38124
exits0. Phone6 does not contain this candidate. Actual title-to-blank, title-to-
text, body-to-title, changed-title rename, keyboard frame/toolbar continuity and
save/reopen remain required; do not close the whole focus finding from source.

New user search request relayed through coordinator: top-center native Liquid
Glass field with leading magnifying glass. Later refinement toggles search versus
command mode using that leading icon; command semantics clarification is pending
in coordinator session. No shell execution implementation is authorized.
Swift371 owns NativePages.swift UI plus narrow NativeMobile.swift native-only
admission/derived-stage orchestration under explicit coordinator grant22:45:28;
adapter117 independently reviews contracts/lifecycle. Both work source-only while
root owns Vite build slot. Fresh isolated branch tingkai-c/mobile-ios-native-search
starts9c35d6d7. No shared Rust/index/Markdown/Base logic is duplicated in Swift.

Search uses existing documents commands and actual startup capability. Same
persisted vault client, page-active serialized admission, bounded derived-index
preparation on intent, coherent generation pin and bounded literal-search paging.
Own only newly created stage/pin; never discard preexisting stages or rebuild/
recover/reset implicitly. Cleanup closes owned pin, discards owned unpublished
stage if needed, validates exact release acknowledgement before actionable
results/editor transfer; uncertain cleanup blocks handoff for exact retry.
Cancellation and stale generations suppress display without skipping cleanup.
Zero visible hits plus continuation is partial work, never a complete no-match
result. Rust owns matching/extraction/query semantics. Result activation uses
fresh stable-ID resolution and the existing durable navigation fence.

Prepared outside the app only: Orca-native-query.md with known literal matches/
frontmatter/backlink, Orca-native-query.base using accepted table source, and
Orca-focus-long.md with final-content sentinel. These await disposable-vault
import and real runtime checks; preparation is not Base/search/viewport proof.

Root now owns Vite manifests/locks/config and mobile script command reconciliation.
Owner supplied ios-build.sh blob405eedc1387224579c9a1e833d90a81cb871f5c4 and
last-change0b7bbc10; the webpack command is line79, cap copy ios line82 (corrects
an earlier coordination message's incidental line116). No unpublished Vite
source was consumed and mobile script remains frozen.


## Silent refresh and actual PDF observations — 2026-10-17 22:56 UTC

Direct user screenshot requests removing the Files-page spinner and Updating
vault text during refresh. Ported only the small silent-refresh hunks from Swift
worker ce14e9f9 into the owner branch independently of unreviewed search: existing
listing and empty-state remain visible, initial skeleton requires no listing,
explicit refresh progress row/text removed. Failure/incomplete warnings and
refresh/navigation safety guards remain. Owner inspected the ten-line diff;
Swift frontend parse and diff check pass. Phone6 does not contain this change;
actual refresh visual/build/install verification remains pending.

Runtime-only Simulator6 slot granted22:48:29, returned22:55:30. Actual encrypted
PDF prompt and software keyboard became accessible without editorTimeout. Entered
only disposable fixture-pass; both fixture page texts render. Return to native
Recents: unlocked PDF appears, invalid PDF does not, exec52792 PASS. Evidence:
/private/tmp/mobile-v6-password-{settled,unlocked,rendered-confirm}.json and
mobile-v6-recents-after-pdf.json. Password ready log occurs after user unlock
(editorReady29921ms includes password waiting); native presentation completion
intentionally emits no editorReady phase, so absence of that phase alone is not
a failed prompt signal.

Initial invalid-PDF open showed native editorTimeout8011ms, then actual error
Invalid PDF structure. Warm reopen displays same visible error without timeout,
exec48208 PASS; /private/tmp/mobile-v6-warm-error-visible.json and
mobile-v6-pdf-warm-phase.log. Initial AX hides editor beneath native skeleton,
so it cannot date first PDF DOM error. Cold engine latency versus early callback
rejection remains unproven. Earlier callback-failure diagnosis was explicitly
corrected; no speculative retry patch was made. d809 source review found no
deterministic normal initial-error drop and preserves its clean investigation
branch. Further cold-load timing/typed presentation instrumentation is a gap.

Three prepared query/Base/long-focus fixtures were copied into only the existing
disposable Simulator vault while stopped. App stopped/helper closed; Simulator
remains booted. No new compiler or iPhone install ran in this pass.

Command mode is confirmed Zorid app actions. Coordinator22:53:27 approves the
currently supported native New note/Recents/Files/Settings/Choose vault actions
through existing coordinator, actual availability, no hidden Workspace or
speculative shared catalog. Swift371 implements a separate follow-up. Search
5f81f749 and worker silent-refreshce14e9f9 are source-ready; independent117
Rust DTO/admission review was actually started22:54 after mailbox delivery alone
left that worker idle. Do not claim search review/typecheck/runtime complete.


## Vite/native build 7 delivered — 2026-10-17 23:18 UTC

Previous goal turn made concrete source/runtime progress: isolated silent-refresh
commitcc13ae80, actual encrypted-PDF unlock/two-page rendering and Recents
error exclusion proof, corrected cold-load diagnosis, reviewed focus candidate.
Goal remains active; source readiness never substitutes for native acceptance.

Coordinator22:57:42 granted composition of reviewed Vite103428be with ownercc13
for one Simulator7/phone7 cycle. Clean merge ac404cc0 preserves all Vite root
manifest/lock/config/assets/script blobs exactly103. Independent bd57 review
found native rejected-touch compatibility fallback could bypass state/owner
rejection. Worker371cb921 imported asce1e0ace: remember tracked touch before
rejection, preserve initially ineligible status, gate native mouse down AND up
with current owner, suppress matching compatibility continuation. Full gesture
regressions39/39 pass; independent recheck closes source P2. Owner full tsc98990
exits0; prior composed tsc13565 exits0 and four-file focus/Vite batch31664
passes36/36. No unchanged broad checks were repeated.

FROZEN runtime sourcece1e0acefdb18d3f913c7a2adf018b41d3290739. Owner-only
untracked node_modules symlink repointed from canonical install to the exact
Vite candidate install; no dependency install or canonical mutation by owner.
Simulator build86404 exits0 BUILD SUCCEEDED (Vite1.34sec, cached Rust0.55sec),
Xcode26.3/official Rust1.95 locked-j1 existing mobile cache, pnpm run build:desktop
then cap copy ios only. Version7/bundle assertions, install+launch67696 exit0.
Only untracked symlink remains; no tracked generated-source changes.

Actual iPhone17 Simulator proof under Vite:
- Native vault/root opens; existing list remains during refresh, no Updating
  vault text/spinner,33719 PASS. Initial-load skeleton/error policy preserved.
- Native New note launches the document-only editor. Typed math/Python-fence
  fixture, returned through native durable save fence. Untitled.md99 bytes on
  disk contains raw math/fence/ending;59873 PASS. Saved proof retained privately
  at /private/tmp/mobile-v7-saved-proof.md. Simulator input produced smart quotes
  inside the code text; literal input substitution is separate from persistence.
- Native Recents stable-ID4c2f83b0-a524-4725-9c7b-d2edec4e448c reopens saved
  body;70052 PASS. Viewed screenshot mobile-v7-vite-math-code.png shows rendered
  MathJax equation/font glyphs and highlighted Python print token.
- Existing local PDFc9734075-590d-4f9a-8b53-966f73fe1604 renders both page
  texts;29423 PASS, mobile-v7-vite-pdf.png and mobile-v7-pdf-rendered.json.
- One transient Orca AX transport failure66125 recovered by reobserving the same
  live app; no crash evidence. App stopped/helper closed, Simulator stays booted.

Externally copied Orca-vite-assets.md exists175 bytes in the disposable vault but
did not appear in that incomplete scan. Existing/new native-owned notes remain
usable; editor shows actionable Vault import needs attention. No data-loss or
full reconciliation claim. Diagnose bounded reconciliation issue fields before
changing warning/recovery behavior. Full keyboard title/body/caret/focus-jump
matrix and loading/performance/shadow/bottom-edge refinements remain separate.

Vite acceptance reported23:12:33. Coordinator integrated verified Vite/native
source into canonical main165cf17a and pinned pnpm-manager lock follow-up
60efe609; main dependency activation/typecheck and73 focused checks pass as
reported by root. No main edits/commit/push by native owner. Exact old runtime
sourcece1e retained for phone7; docs/notices-only root followups not churned into
this frozen build.

Physical phone: development build91966 exits0 BUILD SUCCEEDED. Strict/deep
signature verification and app.zorid.notes.dev/development/version7 assertions
pass; install+launch12016 both exit0 on connected paired iPhone. User informed
installed/launched Zorid Dev7, superseding6. Private log paths:
/private/tmp/mobile-v7-phone-build.log and mobile-phone7-{install,launch}.log.
Artifact /private/tmp/zorid-ios-vite-v7-phone-20261017/DerivedData/Build/Products/Debug-Dev-iphoneos/App.app.
No provisioning update, production install, upload or TestFlight change. Actual
phone interaction remains distinct from Simulator proof.

## Next native UI/import slices — 23:18 UTC

Search source batch5f81f749/ce14e9f9/4ce063df/addff387 remains separate from7.
Independent117 found deterministic >64-pump preparation starvation and >4-page
search prefix starvation. addff387 continues SAME owned stage/pin/cursor in
yielding bounded batches until complete or genuine visible-hit cap; source ACK
23:01:23 closes both P2s. No fake first-prefix vault-wide result. Actual Swift
transport/type/link/UI search remains unverified. Prepared2100 tiny Markdown
fixtures with sole lexical-last literal match outside app only; not copied into
Vite-proof vault. Rust manifest path ordering checked from snapshot.rs175.

Latest user requests consistent full native Settings and Navigation bar config:
top replica supports reorder; unused available items below have Add; dragging out
returns item below. Swift371 owns NativePages-only implementation on fresh
tingkai-c/mobile-ios-navigation-settings from reviewedaddff387. Existing UIKit
navigation stack, no second stack/sheet; implemented-item registry currently only
Notes, Recents/Files stay modes. Explicit empty bar is valid and root/settings
remain reachable; no fake Home/Tasks/Calendar. Main-actor nonce/revision/page
guards validate successful drop only; canceled/outside-app drops keep settings.
Accessible Move earlier/later/Remove/Add and glass/reduced-motion fallbacks.
Owner regenerated actual Foundation helper harness from worker source, then
executed Swift11418 after phone compiler terminal:34/34 preference/order/drop
checks PASS in isolated random UserDefaults domain, cleaned on exit. Log
/private/tmp/mobile-navigation-state-harness.log. This is real helper execution,
not UIKit drag/push/pop or iPhone parity; native source/UI review and build pending.

New user external import: Open in/share to Zorid and Files/Photos/video picker
flows, choose external destination vault, keep existing collision contents,
stream large payload through Rust authoritative operations. Source assessment
assigned861: exact reusable core streaming/C ABI and native helper/project/
AppDelegate/SceneDelegate/AppGroup/share-extension/signing ownership proposal
before edits. No renderer-native-path shortcut, whole-video base64 or Swift
vault-write bypass. Swift371 owns Settings/NativePages, so import UI seam must
coordinate. Root task-query owner may edit document/index/native document-index/
host/WASM semantics; shared import changes require named grant. No import code,
entitlement/account changes or real-data operations claimed yet.

New user caret finding23:17: lower-content tap after scrolling leaves cursor
obscured until typing; must reveal on selection/focus/keyboard viewport settle.
Assigned d809 fresh source investigation fromce1e with exact shared seam proposal
before edits; preserve manual scroll without caret change, widget/drag/current-
owner/parked-view safety. This is queued implementation/actual runtime work.

Exclusive native slot returned23:17:21 after phone7 and bounded Foundation
harness; no compiler/test app/helper/server remains. Future iOS8/verification
requires a newly acknowledged slot. Apple API last22:22 still403 and support
case103000040642 remains; no repeated API loop or TestFlight readiness claim.


### Native UI continuation — 2026-10-17 23:30 UTC

Owner isolated native-mobile-recovery/tingkai-c/native-mobile-recovery merged
reviewed ceef6006 as b947801b. The resolved NativePages.swift is byte-identical
to ceef6006; syntax parse/diff checks passed. Search/actions and full Settings/
nav configuration have not yet passed an Xcode build or actual UIKit acceptance.
Reviewed native caret fix11b448f3 imported as0beb0268: exact three-file grant,
85/85 focused real-CodeMirror tests with controlled geometry and scoped strict
TypeScript check passed in worker against owner Vite dependencies. Owner source
inspection confirms native capability opt-in, no focus/selection/content/inset
writes, measured guarded scroll effects and manual-scroll/composition/current-
owner fences. Actual touch/keyboard visibility remains unverified.

Requested next acknowledged exclusive iOS build8 slot in msg58d501548dca; no
heavy process started while awaiting coordinator. Phone still runs signed Dev7.

Latest user context-menu reference inspected in Downloads: horizontal Duplicate/
Move/Share with icons above names, divider, Rename/Delete red. Native371 assigned
NativePages UI and workflow; d809 independent read-only existing Rust mutation/
export protocol assessment. Apple UIMenu.preferredElementSize.medium provides
three icon-and-label elements; native interaction must own lift/dismiss/haptics.
No fake enabled actions, direct Swift vault writes, or speculative shared Rust
changes. Functional source/review/build/runtime verification all still pending.

Import first-slice source now explicitly granted by root:861 host staged_import
helper/minimal lib seam and native C ABI/header; bd57 new staging/coordinator
Swift files/minimal session/Scene/Info seams, plus focused test source approved.
117 independently reviews protocol. Initial text|binary ABI proposal objected:
Rust canonical Auto classification and exact existing live admission token must
be agreed before Swift wrappers freeze. No Share extension/AppGroup/project/CI/
signing changes in this source slice, no 64MiB limit raise, no build claimed.
