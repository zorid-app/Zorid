# Native mobile integration

## Canonical history and durable tab metadata — 2026-10-18

Main71c2bb7d..a49d6d72 integrates the reviewed batch through1f7ecc59. Root
verified all ios/App files byte-identical to that tested candidate; project/plist
lint and diff check pass. Managed-data/core work is preserved. Documentation
conflicts retain both coordinators' findings; no source conflict was changed.

Actual Simulator evidence includes Back/Forward/exact folder return, metadata
failure blocking activation and Retry recovery, typed Rust save/reopen, malformed
metadata explicit error and healthy restart preserving tab UUID/body. The app
and helper are closed. Keyboard-toolbar interaction remains unverified; no
NewNote/import/edge-swipe or full mobile parity is claimed. The subsequent link
candidate5bc70762/89be64c8 is excluded pending actual WK verification.

## Canonical connected File/Home tabs — 2026-10-18

Main a56c2d16 integrates exact reviewed native candidate2add282b. All iOS files
match the frozen candidate; Info.plist/project plutil checks pass. Independent
integration review confirmed source provenance and project membership, with no
shared Rust/renderer/build/dependency edits. Current managed-data work is preserved.

Full Simulator build39003 passed at fb1c04d7. Actual native Pages→existingnote→
close/overview→Home→Showtabs→two tabs→originalnote/body→ReturnFiles passed;
no new edits were typed in this pass. User subtitle-only correction2add was
independently reviewed, then full signed Dev10 build21794 and strict artifact,
bundle/version/signature checks passed. Phone installation remains unconfirmed:
CoreDevice1011/tunnel unavailable; existing artifact retained for reconnection.
Simulator app/helper closed; native owner retains device-only deployment authority.

Configured back/forward history, native NewNote helper/UI, import destination
router, Share and Duplicate UI remain followups. Import staging support is present
but its router is unregistered. Source/model/compiler proof does not establish
keyboard, failure-path, background or full mobile parity. Historical checkpoints
below retain their original evidence and exclusions.

## Native file authority and recovery library — 2026-10-18 00:28 UTC

Main bb155f3a integrates reviewed583cebce: picker-selected parent identity is
checked atomically for moves; compact commands and read-only status retain the
original operation/root/projection identity, including oversized full replies.
All17 focused checks passed (host6, portable2, Store9). Combined main import/menu
host cargo check11217 exit0; log /private/tmp/native-import-menu-composed-check.log.
Swift menu/recovery/loader consumers remain isolated pending their own composition,
typing and native runtime checks. This library merge does not deliver those screens.

## Native import library — 2026-10-18 00:15 UTC

Main d1ceed0a integrates the reviewed staged-import helper and native C ABI;
all six source files match tested candidate d9836528. Host tests50497 passed10/10,
ABI tests63416 passed5/5. Logs: tmp/native-import-host-fixed-test.log and
tmp/native-import-abi-test.log. Collision authorization now inspects the original
durable stage before deciding whether failure is terminal or uncertain.
Swift provider/import UI, composed device execution and full64MiB transfer remain
unverified. No import screen is claimed delivered by this library integration.

## Canonical native9 integration — 2026-10-18 00:03 UTC

Main60ffc972 integrates only reviewed native9 Settings/search/navigation and caret
source: b947801b first-parent delta→3f940fc2,0beb0268→2e0d1b0b,
e0070be2→e2d8d2fc. All four final source files compare byte-identical with frozen
3288c1bb. Independent composed review approved; full TypeScript99639 exit0 and
focused native-caret/empty-focus55162 exit0,66/66 pass. Logs:
tmp/native9-composed-typecheck.log, tmp/native9-composed-focus-tests.log.
Vite/dependency/package/notices and other platform/workspace seams unchanged.

Actual owner evidence: Simulator8 Settings/config/back and Rust two-hit search
open/save/return pass; Simulator9 build89358/install/launch pass, final-item Remove
disabled80842, extracted actual Foundation minimum-one/drop34/34. Signed Dev9
build63961/signature/version and install75081 pass. Initial launch was Locked;
repeat install/launch65171 both exit0, user phone left running. This supersedes
the lock-only status. Caret tap-only pixel visibility and physical drag-out UI
remain unverified. No general mobile/reference parity claim.

Menus, import, destination loader, native tabs and Share candidates remain
isolated and absent from this integration. Task/Bases/calendar implementation
remains held for the user-requested typed-record design discussion.

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
[Delivery commands/contracts](native-mobile-delivery.md), [Apple diagnostics](../../mobile/apple/README.md).

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


### Build8 actual evidence and next minimum-one candidate

Frozen95df87fa Simulator8 build exec30987 terminal0 BUILD SUCCEEDED. Vite972ms,
cached Rust0.49s, fresh output/private/tmp/zorid-ios-v8-sim-20261017; log
/private/tmp/mobile-v8-simulator-build.log. Bundle/version assertions, install
and launch0 (PID5143), Orca helper5261. Actual full native Settings/config/back
works; Notes removal->Available Add->re-add works under OLD empty-valid rule,
which user then superseded. Restored Notes before cleanup. Actual native Rust
content search returned two NativeSearchNeedle hits at displayed lines7/9;
selected hit opens matching shared editor body, normal save/return and clear
work. Long-note literal search found line85, opened same stable ID. One AX
transport error recovered by observation; this was not an app crash.

Caret pixel acceptance remains UNVERIFIED: lower-paragraph tap showed software
keyboard/native toolbar, initial framebuffer left lower caret offscreen. Later
framebuffer showed paragraph4/caret above toolbar but also unintended "hh"
input; no known test typing command was issued in that note. This contaminated
the no-typing criterion, so do not claim tap-only reveal from that capture.
Desktop Simulator captures/scroll automation also returned incomplete white
window images while simctl framebuffer remained valid. Native Undo, keyboard
dismiss and save/return succeeded; disposable fixture only. No broad caret feel
or momentum/native-phone claim. Close test app/helper; leave Simulator booted.

User minimum-one navigation rule supersedes empty-valid source. Worker reviewed
c1faeda136012b76e5b36d3c6aaa017932afc1ef imported ase0070be2 after8build
completed (existing8artifact unchanged). Owner regenerated actual-source minimum
Foundation harness and Swift exec47159 terminal0:34/34PASS, injected disposable
UserDefaults domain cleaned. Full UIKit remove/drag-out proof pending9. Root
msg2d36653c37bf directs skip phone8, prepare tiny patch, request exact new frozen
head before Simulator/phone9 compile. Phone remains signed Dev7.

New isolated native tab worker started with source-only named grant35680aa23345:
/Users/ctk/orca/workspaces/Zorid/mobile-document-tabs, branch
tingkai-c/mobile-document-tabs, terminal2f48a270-8a1f-4f4c-9fe4-1b9f1be5b8d0.
Only NEW NativeDocumentTabs.swift/NativeTabOverview.swift; existing NativePages
371/wiring scope retained. Startup defaultorigin base7467c22a stale; instructed
to fast-forward isolated branch to current LOCALcanonicalmain ea1e209d before
edits (exactbase correction receipt pending), never mutate main. Tabs outside9.

Import stack8c94529d+708012df+c62bc79b+cc3e7721 independently SOURCE accepted
117 after fixing terminal text-collision resurrection and missing recursive test
field. Host10/ABI4 test bodies UNRUN. FFI exact-error envelope followup3e9b6574
adds source case, review pending. Root isolated b21d18d9 composes productionsha2
and mobilelock edge, not compiled. Native staging/admission source2ab4e411 and
subsequent typed wrapper work unregistered/unbuilt; no completed import claim.


### Signed Dev9 install checkpoint — 2026-10-17 23:55 UTC

Frozen3288c1bb Simulator9 build89358 terminal0 BUILD SUCCEEDED. Fresh output
/private/tmp/zorid-ios-v9-sim-20261017; actual Notes final Remove disabled PASS
80842 after explicitly opening disposable vault. Drop-last rule has actual
Foundation helper proof34/34; physical drag-out UI not separately demonstrated.
AppPID48653 terminated0 and Orcahelper48803 killed0, Simulator retained booted.

Signed device build63961 terminal0 BUILD SUCCEEDED using generic iOS destination
while phone temporarily unavailable: exact existing development script flags,
App-Dev/Debug-Dev, version9, official cached device Rust --locked -j1 (0.40s),
existing Apple Development identity/profile, no provisioning/account/source/tool
changes. Private log/private/tmp/mobile-v9-phone-build.log0600; fresh output
/private/tmp/zorid-ios-v9-phone-20261017. Bundle app.zorid.notes.dev/version9/
ZoridAppEnvironment development and strict/deep codesign verification PASS.
Initial assertion mistakenly used nonexistent ZoridEnvironment key; corrected
to actual script/project key before installing, no source defect/change.

Device reconnected after user confirmation: tunnel connected/DDI true. Install
75081 EXIT0: Dev9 IS INSTALLED on physical iPhone. Launch EXIT1: CoreDevice10002/
FBSOpenApplicationErrorDomain7 explicitly Locked (device relocked). No launch/
phone editing/keyboard/tab runtime proof yet. Requested unlock again; retry is
authorized without rebuild. Private install/launch logs0600 in/private/tmp.
Phone8 skipped; Dev9 replaces Dev7 installation. Heavy compiler slot can return
now while waiting for unlocked launch; no simulator test app/helper remains.


### Source queue after phone9 delivery — 2026-10-18 00:00 UTC

Exclusive heavy slot returned msg6f4746c927eb; root acknowledged02a5f76d3f71 and
claimed frozen import5fc59cae host10/ABI5 checks. No owner compiler/Simulator job
may start until new acknowledgement. Install-free phone launch retry70606 still
EXIT1 Locked; lockState passcodeRequired=false does not prove launch-unlocked.
Stop retries until explicit unlock/new evidence. Phone9 installation remains
confirmed, phone UX not verified.

Reviewed source queue, NOT composed into phone9:
- Menu5adb0e4a only Move/Rename/Delete; independent117 c88b03d9d6b6 withheld
 acceptance for atomic selected destination-folder witness race, native pending
 journal ownership across startup/editor/history/newnote/import handoff, and
 known no-authority lender completion. Large folder receipts >1MiB can remain
 uncertain forever; never infer original receipt from current listing. Root
 assigned native-consumer read-only minimal Rust parent/status proposal.371
 owns native recovery/lender corrections and row flash; not complete UX.
- Loading7128f1d8 source parsed/reviewed initially. Owner full review requested
 d809 followup: picker viewDidAppear resets opening while popped loader open
 remains pending, permitting a new open before old returned host close ACK.
 Keep picker reservation until successful transfer or canceled open/close drain.
 File loader already owns explicit busy/close gate. No loading source composed.
- Native import source979327ce atop2ab4e411 typed/staging/helper source ready;
 noauthority lender dependency, project registrations/router integration and real
 native pipeline evidence still pending. Root composes Rust source/dependencies.
- Tabs source5824bbfe +2d5e934e on canonical-baseea1e209d reviewed by root/owner
 without concrete source blocker, TWO NEW files only. Opaque store identity
 String, ticket+source-owner nonce, one committed file/Home per tab, mixed scopes,
 explicit bounded restore disposition; memory-only bounded native snapshots.
 Temporary actual-source model harness requested, not executed during root slot.
 Existing header/FAB/overview/editor/snapshot/lifecycle wiring requires exact
 proposal and named scope before edits; tabs are not available in9.
- Bounded Share source helper newly assigned bd57: ONLY NEW NativeFileExport.swift
 in separate branch from preserved979; native read_presented exact revision/raw
 bytes <=16MiB file-only -> own private export -> system activity sheet. No Swift
 vault IO or Rust/NativePages/NativeMobile/project changes granted; frozen API to
371 before wiring. Source/review/runtime all pending.

Confirmed native9 batch sent sole main integrator msgd455052bc708: first-parent
b947801b merge delta,0beb0268,e0070be2 plus delivery ledgers. No main mutation or
push here. Integration hashes/semantic reconciliation remain coordinator-owned.


Physical phone9 follow-up — 2026-10-18 00:02 UTC: user explicitly asked to build
to phone again. Reused exact verified frozen3288 signed Dev9 artifact, no new
compiler/source/provisioning change. Repeat install AND launch exec65171 both
EXIT0. Dev9 is now installed and successfully launched on the physical iPhone;
left running for the user to try. This supersedes prior Locked-only launch
status, not the remaining phone editing/keyboard/tab/runtime gaps. Private repeat
logs/private/tmp/mobile-phone9-repeat-{install,launch}.log0600.

Root offered bounded tab harness slot, but terminal revalidation found the worker
idle and harness not yet prepared: mailbox-only request had not started a turn.
Explicit followup cce6ebe0 started; preparation source-only. Offered slot returned
msg62a9ddf75ecd until exact harness ready, no owner compiler run. Root targeted
Rust checks may proceed. Bounded Share API accepted and focused new test SOURCE
NativeFileExportTests.swift approved, no registration or execution granted.


Physical phone redeployment — 2026-10-18 00:10 UTC: user again requested phone
build. Connected/available device confirmed through devicectl JSON. Reused exact
frozen3288 signed Dev9 artifact; actual exec99761 strict/deep signature0, install0,
launch0. Left app running for user. Private logs mobile-phone9-again-{signature,
install,launch}.log and devicectl JSON under/private/tmp. No compilation or new
source included; document tabs/import/menu/loading successors remain outside9.
Offered two-file typecheck slot returned unconsumed msg3f74b5f9974e; fresh ACK
required before compiler use. Main untouched.


Successor composition — 2026-10-18 00:14 UTC (NOT Dev9): owner reviewed
actual c5357 reservation diff and composed loading7128+c5357 as c9b2ad14 and
6871a511. Picker reservation now survives Back until late open and returned host
close completion, or releases on Pages transfer. Source review/model checks do
not prove actual UIKit scheduling; new build/runtime matrix remains required.

Tabs source5824+2d5 composed a011dc4a+527fe77e; root ran actual-source model
harness207 PASS (exec42964), not repeated here. Scoped project grant6fe356
permits minimal source registration: NativeDocumentTabs.swift and
NativeTabOverview.swift each occur exactly once in App Sources; plutil parses
project and diff check passes. No linker/typecheck/build claim. Fresh bounded
two-file typecheck slot requested c3406b1241a2; no fresh ACK yet, no compiler.

Explicit existing-worker followups now started:2f model active binding/Home and
overview busy props; d809 editor close without pop/snapshot/current-document
validation. Reviewed actual model/view followup diff source-only, no blocker;
UIKit pop guard and recovery cancel-pending remain caller integration gates.
371 retains NativePages pending-journal/no-authority recovery then header/FAB
and tabs source adapters; root atomic folder witness/status wire stays separate.
Native owner retains scoped root catalog/coordinator/picker integration after
bd57 ownership reconciliation. No file-wide takeover or main mutation.

Apple bounded diagnostics exec37303 at00:05UTC still returns403
REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED for apps/bundleIds/users/invitations.
Existing support case103000040642 remains; no duplicate case or repeated API
loop. TestFlight/internal tester acceptance remains blocked by account access.


Native successor checkpoint — 2026-10-18 00:20 UTC:
- Actual exclusive-slot frontend exec57718 terminal0, EMPTY diagnostics for
  EXACT original527fe77e NativeDocumentTabs.swift + NativeTabOverview.swift,
  extracted by git show into/private/tmp/zorid-tabs-frozen527-typecheck. Swift5
  arm64-apple-ios15.0-simulator, SDK26.2, cached Simulator9 modulecache. No project
  build/link/runtime or newer-source proof. Slot returned ee0c71d827be, root
  ACK3ecb15; root Rust menu worker now owns compiler slot.
- Reviewed new model9ecedf6f + overview873b4989 composed as1d903448+883d2c7e.
  Their actual-source binding harness is PREPARED only, not run. Original207
  proof and original two-file frontend do not cover these successors.
- Root grantc25665 assigns owner NEW NativeDocumentTabCoordinator.swift and
  minimal catalog/picker retention hooks; source draft currently UNTRACKED,
  unregistered and NOT composition accepted. No catalog/picker hook edited yet.
  Independent2f audit0e5 identified quarantine/identity/persistence/lifecycle/
  UIKit transition issues; owner correcting explicit source role+assignedtab,
  exact target witness, metadata-dirty admission gate/retry, foreground epoch,
  reservation cleanup callback and deferred stack mutations. Final review and
  actual wiring remain required; do not call this a working tab UI.
- Lifecycle5742 source held after concrete owner/root review: true saveACK +
  actual hostclose followed by background epoch failure must expose exact-owner
  terminal retirement separately from navigation eligibility. Covered editor
  also misses SceneDelegate top-only background delivery. d809 explicit followup
  c504bc0a now source correction in progress; opaque retirement query + same-scene
  background/latch proposal owner/root ACK. No composition/runtime acceptance.
-371 menu correction batch4a1e1381+6b67a887+09734eb4 source ready, independent
  source assertions only; requires root atomic folder/status Rust wire actual
  validation. New tab Pages adapters remain separate followup. Root integrated
  import library main d1ceed0a (host10/10, ABI5/5); no Swift import UI proof.


Tab wiring checkpoint — 2026-10-18 00:28 UTC (SOURCE ONLY):
- Owner read mandatory retirement correction a02b7397 and composed WITH5742
  as150ad6dd+99be269a. Exact container/session/owner terminal receipt is minted
  after true lifecycle ACK + actual workerclose, before callbacks; same-scene
  covered-editor background delivery is internal, no Scene edits. No compiler
  or actual native-background proof. Typed witness depends on371 next patch.
- Fresh catalog resolve(vaultID) committed87e73a4a, independent2f SOURCE approved
  e4b8. bd57 explicitly confirmed no catalog/picker ownership14162ada42f8; owner
  retains catalog/picker/coordinator hunks. No picker retention hooks edited yet.
- Coordinator remains UNTRACKED/unregistered, awaiting exact final review.
  Review corrections include prepared-destination validation before/after UIKit
  transition, strict host-free Home, exact editor role/tab/vault/store/stableID,
  separate foreground admission epoch, terminal retirement query, recoverable
  quarantine, independent persistence error/retry state and post-cleanup intent.
  Prepared controllers never navigate themselves. Required didInstall handshake
  follows root Source registration+controller installation, allowing buffered
  validated identity to bind without restarting editor. Installed quarantine
  cleanup uses Source save/quiesce; unlaunched cleanup uses factory reservation.
- Explicit worker starts (mail alone does not wake idle turns):37189889d43
  implements owned Pages ShowTabs/header,60pt NewNote FAB, OpenInNewTab, typed
  validated witness and read/search/lease drain+retirement query. bd57266e5bb7
  owns ONLY NEW NativeTabDestinationFactory.swift, root ACKd32/e3e210; resolver
  injection, one exact reservation, fresh Rust listing/store/stableID, prepared
  File/Home without view load/navigation; didInstall buffers early validation.
  Newnote remains separate PROPOSAL pending coordinator durability/retry review,
  never a generic Home host. No duplicate creation replay on restart authorized.
- d80926becc7f explicit followup narrow rootACK88c920: native header callbacks
  onShowDocumentTabs/onReturnToNativePages installed afterviewload; configured
  routes root-owned; UNCONFIGURED alreadyclosed explicit foreground/topself
  legacy return may pop without repeat save/close. Source review stillpending.
- Final2f coordinator re-review ecd52284 started; latest didInstall handshake
  delta89ff sent. No native compiler after granted57718 returned; root Rust
  menu corrections own slot. No new phone/simulator build or runtime claim.


Coordinator source acceptance — 2026-10-18 00:30 UTC:
Independent2f final acceptance2ddc5763f101 inspected exact SHA256
a83c45cb8fda3db5c56c0d471e6ef782381a1558fad7cc20b018a7c28d910d05, including
persistence retry ordering, quarantined ShowTabs preservation, required
didInstall acknowledgement and installed-source save/quiesce cleanup. Owner
verified bytes, committed875fc451 plus minimal project membership. plutil and
diffcheck pass. This is SOURCE acceptance only: no compiler/project/link/native
UI proof. No source-byte changes after freeze. Factory Source/Prepared signatures
explicitly frozen72e15ce25739; no draft-hash substitution for API agreement.

Root canonical Rust native/menu bb155f3a now integrated17/17 focused tests,
combinedmain host cargo check11217 terminal0; no native build grant. Pages09a4
source ready; headerhook683f source ready; factory File/Home source review ready
pending coherent commit. None composed/runtimeaccepted by this ledger. Settings
Choosevault fourth rootcallback298c proposed/workerfollowup explicitlystarted;
configured editor <> history must use root route intent, not legacy Boolean
return. That routehistory integration remains mandatory. Newnote separate
once-only/durability contract still pending root review, no genericHomehost.
Phone9 unchanged, simulator retained booted without test app/helper.


Composed API typing evidence — 2026-10-18 00:35 UTC:
Canonical main consumed ONLY in isolated ownerbranch merge37da1be0; two additive
ledger conflicts preserve both sessions' records. Approved import admission
source2ab4+979 composed80887ea6+12b58a05; frozen NativePages f9c7cc27 composed
as c39f525c (explicit provenance; owner already had7128 loader). Header hooks
683f composed3e002a1d. No main mutation/push.

Coordinator-granted bounded Swift frontend exec54060 TERMINAL0 for EXACT frozen
c39f525ca6eaa586ee59cdb41d9ce40896086db6 TWELVE app Swift sources, actual
integrated C bridgingheader, arm64 iOS15 Simulator target/SDK26.2/Swift5, cached
Simulator9 dependencies. Command+source hashes+result.log in
/private/tmp/zorid-mobile-composed-typing-c39f525c. Zero errors, concurrency/
Sendable warnings remain in import closures and Pages main-queue observers.
Not a warning-free/Swift6/link/project-membership/runtime pass. Factory excluded.
Slot explicitly returned44cbd86376d2; new grant required before morecompilers.

Factory sourcea83f+3acc composed2bf146e6+47f64497 AFTER compiler terminal; root
approved3acc source8450. Fixed nonexistent listing.scanComplete and removed
global reconciliation-complete admission gate: known freshly listed exactstore/
stableID livefile remains openable, unknown/missingtarget still rejected.
Reconciliation warning remains distinct; no empty/complete assertion. Actual
File/Home factory integration and project source membership stillpending; no
newcompile/runtime proof from54060. Configuredhistory/Settings/latch/rootpicker
wiring and separate Newnote remain acceptance gates. Phone9 unchanged.


Connected File/Home root wiring checkpoint — 2026-10-18 00:55 UTC:
Owner remains native-mobile-recovery / tingkai-c/native-mobile-recovery, committed
HEAD ae81678d. Current uncommitted owned changes are NativeMobile picker/loader,
NativeDocumentTabCoordinator and minimal project membership for import/factory
files. Root now injects a single coordinator/factory, binds Pages callbacks,
shows editor destination loading before asynchronous host drain, reserves vault
opening/native routing through exact receipt consumption, and retains validated
document identity when tab metadata binding fails. Native page changes require
actual close receipts; no second editor/host is opened while admission is held.

Independent review b8a0/f560 found missing recovery after successful close plus
a late foreground-invalidated UIKit receipt. Corrected source retains matching
owner/original route identities until foreground recovery presentation; it does
not automatically reopen a destination. Final review explicitly started via
Orca request 9d5f48d7; SOURCE acceptance remains pending.

Immutable 13-file first typecheck30104 TERMINAL1 caught one fileprivate
showMessage access. Fixed with a private coordinator alert, without widening
shared visibility. Original failed snapshot remains unchanged in
/private/tmp/zorid-connected-tabs-source-snapshot. Corrected immutable snapshot
/private/tmp/zorid-connected-tabs-retry-20261018 includes command.json,
source-hashes.json, provenance.txt, result.log and exit-code.txt. Hash manifest
SHA256 d1aff3f450949e636871b5a23215fc5537366251aa6bd420e643c4f3347d90ec.
Granted retry25349 TERMINAL0, SDK26.2 / Swift5 / arm64 iOS15 Simulator / all13 app
Swift sources including factory / actual integrated C header / cached Sim9
dependencies. Zero errors; existing concurrency and Sendable warnings remain.
Not a full project, link, simulator UI, Swift6 or phone validation. Slot explicitly
returned 5dfe2132d4ba; coordinator acknowledged6340 and assigned another owner.

Phone remains successfully installed/launched Dev9 (3288c1bb); no newer phone
app is implied by source checks. NewNote FAB stays disabled: helper f00ebadc
is library-only source ready, root conditional review requires honoring original
creation/tab identity and recoverable occupied-name handling before UI exposure.
Configured editor history and stable folder-origin restoration remain required;
371 worker explicitly resumed request db178915 to propose minimal scene-RAM
history and scoped Pages stable-route restoration. External import router and
Share/Duplicate UI wiring remain incomplete. Full Simulator build follows
reviewed source freeze and a fresh acknowledged slot, independently of those
remaining feature gates. Apple agreement API403/support case unchanged.

Final independent source acceptance 6dd0cb36048c received00:55:22UTC for exact
Coordinator SHA256 d6b0a0a992db6eb5cd10b50334752f9ba1eb736cb2b6a2f71a6c070e8812e8c2
and NativeMobile SHA256130cb790e63f676e9e4aba08526b765105f1ca9f38db04533fb83d371a1473bd.
Owner verified matching bytes before commit. Acceptance covers initial connected
File/Home wiring only; all compilation/runtime and feature limitations above
remain distinct. Project plist validation and git diff check passed.


Simulator10 integrated evidence — 2026-10-18 01:06 UTC:
Home Show tabs source d7e77c3c composed fb1c04d7 after first full script16736
TERMINAL1 at package-manager verification (no compiler). Shell pnpm9 parsed
pnpm12 multi-document manager lock incorrectly; canonical lock is valid. Owner
removed only its node_modules symlink, preserving shared worker dependencies.
Existing /Users/ctk/.local/share/pnpm/pnpm12.14 frozen offline ignore-scripts
install36802 TERMINAL0; no manifests/locks/toolchain download. Full retry39003
TERMINAL0, BUILD SUCCEEDED: Vite native renderer, cap copy ios only, Rust1.95
locked-j1 staticlib, Xcode App Debug arm64 Simulator jobs1. Exact command/provenance
/private/tmp/zorid-ios-v10b-sim-command.json; build log/exit file adjacent. Artifact
/private/tmp/zorid-ios-v10b-sim-20261018/DerivedData/Build/Products/Debug-iphonesimulator/App.app.

Actual install/launch/Orca attach67686 TERMINAL0 on existing1274 simulator.
Disposable Orca Mobile Test native vault and Pages open PASS87003; configured
file destination shows existing saved Markdown body PASS84378. Actual editor
close to overview, +Home, native Home Show tabs, two-card overview PASS51920.
Original note reactivation retains original saved body and Return to Files
reaches usable native list PASS99193. No new text typed in this pass; no new
edit/keyboard/background/failed-save/cursor pixel claims. Screenshot actual
framebuffer /private/tmp/zorid-mobile-v10-tabs.png inspected: two thumbnails,
selected purple outline, labels and footer. Footer button identifiers inherited
parent overview ID; automation used observed labels. One AX transport failure
and transient empty AX tree retried without restarting app; not an app crash.
Overview screenshot also shows a system Back affordance despite requested
hidesBackButton; behavior/polish remains to inspect. Test app/helper cleanup77553
TERMINAL0, simulator kept booted.

Direct user now requests phone installation and removing vault subtitle above
Recents/Files. Only six-line decorative NativePages header removal, independently
source approved533a8a056bfb at SHA256a41bac4800e95a4d779ba83618919026f0a5ccf89606ffa095788c0d5ceb175e;
full phone compilation and visual proof still pending. Existing private manual
contract bundle is old app.zorid.notes; wrapper assertion stopped BEFORE build.
Dev9 evidence uses automatic existing wildcard development profile, so use same
automatic Dev signing with team/device contract fields, no provisioning updates,
not that old bundle-specific manual profile. Device wired/paired/tunnel connected
and Developer Mode enabled per devicectl01:06. Coordinator0c249 extends exclusive
slot for signed development build/install/launch after simulator check; no new
account/production capability changes. Phone remains Dev9 until actual receipt.


Signed phone10 artifact checkpoint — 2026-10-18 01:10 UTC:
Frozen source2add282bf6c79b201ec04259f643dd3749df6ef8, signed development full
script21794 TERMINAL0. Pinned pnpm12.14, Rust1.95 locked-j1, App-Dev Debug-Dev
Xcode jobs1, automatic existing development profile, no provisioning updates.
Exact redacted command /private/tmp/zorid-ios-v10-phone-command.json; private0600
log /private/tmp/zorid-ios-v10-phone-build.log and exit0 file. Artifact:
/private/tmp/zorid-ios-v10-phone-20261018/DerivedData/Build/Products/Debug-Dev-iphoneos/App.app.
Verified Info bundle app.zorid.notes.dev/version10/environmentdevelopment/iPhoneOS,
codesign strict/deep exit0, actual application entitlement exactteam+Dev bundle
and get-task-allowtrue. This full compilation includes six-line vault subtitle
removal. No actual header pixel verification from this phone build.

INSTALL NOT YET SUCCESSFUL. Hardware UDID install and observed CoreDevice UUID
retry both returned CoreDevice1011 unable to locate ECID. Fresh device details
show tunnelState unavailable, previously wired+connected; lockState also1011.
No app launch attempted after failed install. Actual private install logs/JSON
/private/tmp/zorid-phone-v10-{install,current-install}.* preserve failures.
User asked asynchronously to reconnect/unlock phone; pending reply. Phone last
proven installation remains Dev9, not Dev10. No signing/account failure inferred.
All compiler handles terminal, Simulator app/helper closed, Simulator still booted.
Reviewed connected source merge_ready a683f5263647 sent sole coordinator; main
untouched by owner. NewNote/history/import future source remains uncomposed.


Next source successor — 2026-10-18 01:11 UTC:
After all compiler handles terminal and slot returned76a4822c6e49, composed
independently reviewed371 history77018 as ce6e78cd, plus minimal new Swift project
membership. NativeRouteHistory exact source161lines / Pages scoped restoration,
header removal preserved. Owner read both actual diffs; plutil/diffcheck pass.
This source successor is NOT the frozen2add Dev10 artifact or submitted main
batch, and has no new compiler/runtime proof. Root editor/history callbacks and
validated folder-origin restoration still need wiring. Harness source exists
unexecuted in /private/tmp/zorid-native-route-history-harness.

Metadata store API proposal4e6c owner ACK0682234: bounded128KiB validated existing
schema, fixed app-owned ApplicationSupport path, checked atomic file/directory
durability with explicit post-rename uncertainty, no note content authority or
arbitrary vault writes. bd57 may implement NEW file only after root ACK; owner
picker integration remains separate. Import destination router proposal d809
a197/3da received, explicit selection/recovery constraints and owned loan cleanup
API agreement still pending; no implementation grant inferred.

Device-only deployment retained after build slot release; latest bounded phone
check01:11 still tunnel unavailable, no install/launch success or user reconnect
reply. Do not rebuild for connection retry. Use exact ready signed Dev10 artifact
when live phone connection is restored.


Configured history wiring checkpoint — 2026-10-18 01:22 UTC:
Named root scope ddfa107bf45a: owner coordinator/picker/loader/factory optional
navigate callback,371 scoped Pages root callback/availability. Reviewed1915
composed d1d2860e;94fa durable metadata library composed27366b55 plus pendingPBX
registration, not yet root persistence wiring. ONE scene history and pending
original ticket/expected installed owner; document history commits only exact
fresh validated target, ordinary validated navigation records separately.
Stable folder restoration uses sole prepared Pages host before binding/install.

Independent root-wiring review d1d46 found temporary UIKit readiness overwriting
logical arrow flags and one-shot installed-page receipt lost on backgrounding.
Corrected owner source preserves logical flags with dynamic action guards and
retains weak Pages/exact bound owner/route/history ticket receipt, revalidating
via SAME owned host on matching foreground/settled install. Superseding native
intent cancels cursor ticket only, never grants storage ownership. Re-review
explicitly started c5f82a7b; source acceptance, combined typing and runtime still
pending. Current source files frozen for that review; no compiler started.
Managed adapter owner holds resource slot through concrete test fix/retry.

Root prioritizes missing NewNote collision terminal capability with native
consumer owner012884a15469; generic rejection/status absence remains insufficient.
Link caret source audit and edge swipe followups tracked in user-findings.
Phone Dev10 exact2add signed artifact remains ready, last device connection
unavailable and async user reconnect question pending. No rebuild required.

Configured history source accepted46405425b880 at exact Mobile4ab5cdec,
Coordinator e46b3ec9 and Factory9d41f71c. Third review correction honors a
different validated folder/mode as superseding normal intent instead of replaying
old restoration. Owner verified full hashes before commit; acceptance SOURCE
only, compiler/actual history UI still pending. Metadata root wiring separate.

Metadata root caller source accepted df59f87afe38 at NativeMobile SHA256
5e9f48d1e80586440b81ffac4fb0e0e2e963f722c77a39c6ab9a681e533dedf1.
ONE retained main-actor store, development-only read-only legacy fallback ONLY
for absent file, existing invalid/unreadable file error propagated before host
open, persist closure throws into existing metadata Retry. No NewNote ACK/UI.
Combined15-source compiler +actual history Foundation harness next; no runtime
filesystem/failure-injection evidence yet.


Combined native compilation/history checks — 2026-10-18 01:29 UTC:
Frozen588bc684, immutable snapshot /private/tmp/zorid-history-metadata-15-source-20261018
contains ALL15 Swift sources plus copied actual C/bridging headers, source manifest
SHA25667c1cf0e2db4e5df72ae9aeec1f28ce860cf72b0e3df05cf854f37ab9f802a66.
Granted61e/b726 handle54862: Swift frontend TERMINAL0, SDK26.2/Swift5/arm64 iOS15
Simulator, existing pinned cache/frameworks. Existing actor/Sendable warnings;
zero errors. Not full project/link/runtime proof.

Initial host harness compile TERMINAL1 unable to load default macOS26 standard
library; no test executed. Exact original command/failure preserved. Corrected
ONLY host compiler command66308 with explicit installed MacOSX26.2.sdk, arm64
macOS13 deployment and task-local module cache; compile0, executable0. PASS193
actual Foundation history checks. Harness actual source prefix matches
NativeRouteHistory SHA256447501956850a36a556aa73c4d10fecab2201bd28131e25f505f6b831eb21d26;
harness SHA25665fe62375fd3b861382a977e638d5ea77f2a8afb633206899f3e3425a322ed87.
This executes actual history source, not a mirrored model. It does not prove
UIKit transitions, lease/host close, lifecycle or metadata filesystem behavior.
Snapshot keeps commands/logs/results for both failure and corrected pass.
Slot returned b423e36035cc, no compiler live. Full focused Simulator history and
durable metadata fault/retry/restart checks remain next.

Root approved minimal native-only rejected-intent terminal protocol a38e; bd57
explicitly resumed d7638a6b, exact plan2baf owner ACKca1e: parsed original create
invalid_request/false +same-held-loan exact status not_committed, per-CID terminal
CAS before current terminal CAS, verify both then exact release/fence ACK. This
is a native journal protocol, not universal core tombstone/collision proof.
Actual-helper partialCAS/lateCID/release tests required before NewNote exposure.
Link source worker d809 started isolated main07415616 branch; touch-event plan
refined under root43d860 (recognize short tap, preserve pan/longpress, consume
accepted touchend, no blind touchstart prevention). No link fix/runtime claim.
371 read-only edge gesture proposal6b80 started, no implementation before history
transition proof. Phone Dev10 artifact remains2add, connection still unavailable.


Simulator11 actual history readiness correction — 2026-10-18 01:46 UTC:
Full project build95537 succeeded at c8fd423c/588bc684. Actual Orca UI confirmed
subtitle removal, Files listing, folder entry and Nested.md opening. Actual
Back restored the folder but exposed a startup/menu-loan readiness race, leaving
a pending history ticket and disabled Forward; failing AX024 and screenshot
retained in /private/tmp/zorid-history11-evidence. No typed save proof yet.
Healthy durable tab metadata actual write:334 bytes, mode0600. Original failing
executable preserved before rebuild. Test app/helper cleanup10993 exited0; owned
Simulator remains booted.

Root c943/64f grants narrow correction and incremental rebuild within held iOS
slot. Independent review56ae accepts Mobile307436a1/Pagesbb71e208: defer the
installed receipt until the same Pages host is idle, its menu recovery clear
and UI active; coalesce a false-to-true readiness callback and reread current
route/owner. Preinstall folder reads retain their original idle guard. No new
host, timer, lease or gesture/link source. Source acceptance only; new build
and actual Back/Forward/metadata failure recovery remain to verify.


Focused actual Simulator11 verification at2cdbd86f — 2026-10-18 01:54 UTC:
Incremental App Debug build exited0 (BUILD SUCCEEDED); command/head and log are
/private/tmp/zorid-history11-readiness-command.json and -build.log, exit0file.
Install/launch/attach82359 exited0. Actual34175 exited0: editor Back restored
exact Orca-folder, Forward enabled and reopened same Nested.md/body, Return to
Files preserved exact folder. No root readiness error after correction.

Actual41968 exited0: replace disposable Simulator metadata file with an empty
directory; note activation pauses on opening route with explicit metadata error
and Retry, no editor activation. finally restored original regular0600 file;
Retry opens original pending note. No real vault/schema changes.
Actual typing80858 inserted NativeHistory11Verified into disposable Nested.md,
but its software-keyboard-dismiss assertion failed because that control was
absent; do not claim software-keyboard/formatting-toolbar behavior. Followup42179
exited0: native Return drain saved the edit and reopening shows sentinel.
Actual85084 exited0: malformed metadata on process restart yields explicit
Could not prepare tabs/error, no fresh Home fallback; original restored in
finally. Healthy relaunch retains original selected tab UUID81c2dab5 and opens
same Nested.md with saved sentinel. AX evidence retained in history11-evidence.
App/helper cleanup51374 exited0; owned Simulator left booted.

Root b302 grants next bounded retained slot for unchanged approved link89be64c8
only, after this terminal checkpoint. No edge/NewNote mix; frontend/cap copy
and incremental Xcode, actual WK tap/caret/pan/longpress still required.
Phone current details still paired but tunnel unavailable (last connection
01:08 UTC); signed Dev10 artifact remains uninstalled, no new build needed.


Native loading presentation follow-up — 2026-10-18 02:40 UTC:
Owner: native mobile terminal term_bbf1787b-d2e5-402a-b366-24d40a2385c3.
Source-only successor: /Users/ctk/orca/workspaces/Zorid/native-vault-context,
branch tingkai-c/native-vault-context, based on canonical main0496b721.
NativePages removes transient vault/search-preparation/searching/file-action
and startup-check copy. Existing first-list/search skeletons and their Reduce
Motion behavior remain; ordinary refresh retains the trusted listing. Loading,
loan, admission, pending-action, error/retry and lifecycle gates are unchanged.
Swift frontend syntax parse and git diff --check passed. Independent source
review375419ce approved the exact NativePages SHA02075c9e; no Xcode build or visual/runtime proof
for this presentation change yet. This does not improve measured load time.

Latest user observation: native app feels slower than Obsidian's Capacitor app.
Source inspection identifies repeated fresh editor WKWebView construction and
whole-vault Markdown reads/indexing before the selected note. Their individual
runtime costs have not yet been measured; Obsidian internals were not measured.
One warm editor per current vault with logical per-tab state is a recommendation
under discussion, not implemented or approved lifecycle/session redesign. Root
b24 explicitly preserves that discussion boundary. No WebView pool or Rust
storage authority change is included in this source batch.

Delivery correction to earlier chronological entries: physical Dev10 was
successfully installed and launched (actual process7774 exit0); receipts are
/private/tmp/zorid-phone-dev10-reconnected-install.json and -launch.json.
Clean Simulator14 build/install succeeded for reviewed link source11c91da1,
but final matching tap/caret proof is still pending. No newer phone build or
install is claimed. Prior Simulator app/helper cleanup68963 exited0; device
remains booted. Retained resource slot returned to coordinator msg_4bb6b32ee050.


Bounded existing-artifact Simulator14 short-fixture attempt — 2026-10-18:
Coordinator ecd6/c2 granted one no-build pass. Launch/attach49363 exited0,
App PID80084, helper80377. Existing actual link14 artifact was unchanged.
Probe67283 exited0 but printed no file targets (AX returned empty application).
Probe46046 exited1 missing short-note; screenshot short-current2 showed a folder
route. Probe82674 exited1 missing short-editor-open; final screenshot showed an
audio player rather than the requested43-byte Markdown fixture. These target/
route misses mean no controlled rendered external-link tap, browser activation
or no-refocus caret measurement was delivered. This is INCONCLUSIVE tooling/
interaction evidence, not a pass or a demonstrated link regression. No new
fixture body was typed and no performance conclusion follows. Screenshots and
AX records remain /private/tmp/zorid-link14-short-*.png and link14-evidence.
No phone15 build/install. Cleanup process55623 terminates only the owned test
app/helper and keeps the existing Simulator booted; terminal result sent to the
coordinator separately. Future verification needs reliable visible-coordinate
input and fresh screenshot observation before measuring the editor behavior.


Vault-scoped native caller composition — 2026-10-18:
Owner branch/worktree remains tingkai-c/native-vault-context. Reviewed source
6a5a6d7404937b91c9c7a1ef0ad4070ce8c4828a is composed with NativeMobile picker/
coordinator/factory callers in one batch, not integrated alone. Explicit trusted
catalog UUID chooses the model/store; current v2 invalid bytes throw, absence
alone creates Home. Old global/defaults metadata remains untouched and unread.
Existing same-vault coordinator is reused. Switching vault requires the current
coordinator canEnterVault, empty/settled host-free Home factory, picker at top,
no opening ticket and no bound Pages. All actual editor/host retirement retains
its original close ACK. New scoped data validates before context publication;
exact UUID/context fences reject old callbacks, including deferred error alerts.
Home Choose file now opens Pages in its current vault. Scope change clears only
scene route-history metadata, never notes or storage authority.

Model/store hashes match source6a exactly; its85 actual-source host checks were
already observed and are not presented as new caller/runtime proof. Owner Swift
frontend parse and diff checks pass. Independent reviewa18fcce9 accepts caller
flow; final deferred-alert guard source469aadfb ACK4127d14c confirms exactly
that one additional guard and no other delta.
No Xcode compile, A/B vault switch/restart or corrupt-vault UI proof yet for this
batch. NewNote caller handoff/ACK and strict8 gesture consumer remain queued;
this batch does not expose or acknowledge NewNote. No warm WebView/pool change.



Bounded actual16 per-vault tab isolation/restart — 2026-10-18:
Fresh A CC60CCCC-6DA3-4022-85E9-7A00C42562F2 persisted two Home tab IDs
75bbf60e-2149-46ed-8177-f8c6b1571662 and e02ce808-4b69-4dcd-bc6c-3bd7e1b0a670,
selected e02ce808. Actual native Home > Choose file returned same A Files.
Native Settings > Choose vault closed its Pages source. Picker bar bug required
explicit unchanged16 process restart48030 solely to expose Create again.
Fresh B FCF63970-E8E3-47B9-BF39-23D302584E0C opened Files; actual37027 confirms
its initial overview had one NEW Home ID disjoint from A before adding B's
second Home tab. B real scoped metadata file persisted two IDs disjoint from A,
mode0600. Native B Home > Files > Settings > Choose vault94588 exited0.
Actual B > A5633 then86568 exited0: overview restores EXACT original two A IDs.
Restart99513 exited0; actual B reopen5094 then33912 exited0: B overview restores
EXACT original B IDs, no A IDs; both real v2 JSON files retain original selected
IDs and contents, mode0600. Evidence restart-isolation-pass.json and all AX in
/private/tmp/zorid-vault16-evidence. No fixture bytes/metadata manually modified.

This proves the bounded fresh-vault Home-tab identity/scope switch/restart gate,
not file-tab bodies, route swipes, keyboard, old-fixture compatibility or latest
new-tab Home presentation. Old vault failure and hidden-picker-bar screenshot
remain retained. Build16 predates header92ce and picker9320; source fixes still
need next combined compile/runtime. Physical phone remains Dev15. Cleanup19165
closes owned app/helper, leaves Simulator booted; terminal receipt sent separately.

User's latest new-tab clarification: new tab must show the SAME native current-
vault Recents/Files landing page as initial vault entry; no blank Choose file
screen and no vault chooser. Tabs are nested inside a vault. This supersedes
current Home controller presentation; existing build16 blank Home behavior is
not accepted as the desired UX despite passing metadata scope checks. Native
owner owns current-vault Home factory/root activation follow-up. Per-tab route
registry source is separate, not yet composed/delivered. Warm-page comparison
now prioritizes one retained current-vault Workspace/host over per-nav fresh
initialization; ready adjacent pages do not mandate a fixed WebView count.


Imported docs-only evidence from native c8a6dfa6; delivered native source is
not thereby integrated into canonical main or accepted for interaction parity.


Physical Dev17 delivered — 2026-10-18:
User requests connected-iPhone delivery; device query confirms wired connected
iPhone16Pro. Root ae6b905b grants slot transition; Simulator terminate6922 and
helper kill74761 both exit0, preserving exact booted simulator. Root1121 confirms
no competing compiler/Electron. Source remains reviewed2ccce (docs HEAD649b3acc).
First script preflight32567 exited1 before compilation because pnpm cache-path
verification rejects the linked workspace; retained phone17-build.log/exit.
Second runner uses private pnpm CLI flag only after exact package/lock comparison;
repository build tooling/cache unmodified. Actual70888 exit0,221.24s: fullTS/native
Vite, cap copy ios only, official device Rust --locked-j1, Xcode App-Dev Debug-Dev
jobs1, Automatic existing development signing, provisioning updates disabled.
Signature deep strict0; Info app.zorid.notes.dev /Zorid Dev/build17. Frozen Swift
hashes still match after build. Actual22381 terminal0: device install0 AND launch0,
both devicectl JSON outcomes success. Phone app remains open for user.

Persistent source/command/artifact/signature/install/launch receipts are under
/Users/ctk/orca/artifacts/zorid-native-20261018 (phone17-command2.json,
phone17-artifact.json, phone17-signature.log, phone17-install.json,
phone17-launch.json and matching logs/exits); signed app is phone17-build2/
DerivedData/Build/Products/Debug-Dev-iphoneos/App.app. Temporary owned cache
symlinks removed. No production app or unrelated data changed.
This proves compile/sign/install/launch only, not phone gesture/keyboard/
loading acceptance. Dev17 includes scoped tab histories/new Home/header/picker/
strict8 gesture source; it does NOT include optional one-WK channel now in main.
Simulator post-restart scene-startup issue remains inconclusive, sample retained.


### NewNote18 actual Simulator checkpoint — 2026-10-18 04:24 UTC

Owner native mobile, worktree `native-new-note-candidate`, branch same, product source `9cf7fe9f` (canonical c233362a plus reviewed NewNote4e390d70). Acknowledged slot76c4f1ebca9d. Build18 exited0; actual install and launch succeeded on owned Simulator1274C6C8. Orca automation tapped enabled New Note FAB in fresh disposable Orca NewNote18 vault, typed `NewNote18 saved proof`, and confirmed exact projected vault file bytes. Background/foreground retained text. Termination/relaunch followed by actual same vault/file opening restored exact text; native Back then returned Files with unchanged stable entry ID.

Direct NewNote activation leaves the native navigation bar hidden. Normal file reopening restores Back/Forward/Show tabs. The NewNote owner is fixing the narrow editor appearance hunk; this candidate is not yet approved for phone delivery. In-flight create interruption/recovery, interactive two-live-editor swipe and warm channel runtime remain unproved. Phone remains delivered Dev17. Evidence `/Users/ctk/orca/artifacts/zorid-native-20261018/sim18-runtime-report.md`, `sim18-artifact.json`, AX snapshots and screenshots. Product source freeze unchanged by this documentation.


### NewNote19 chrome verified and Dev19 delivered — 2026-10-18 04:33 UTC

Frozen product source `b46a2e3ebe74f3efde1684cef56dcfdbe4c57022` adds only reviewed appearance fix e6c37771 to NewNote18. Acknowledged slot20bf9476077d; build19 Simulator92.04s/exit0, install/launch0. Actual direct FAB creation shows native Back/Show Tabs enabled and Forward disabled. Typed `NewNote19 chrome proof`; refreshed current simulator container (old18 container path had changed during install), verified exact Rust-backed projected file bytes. Native Back returned Files; tapped same stable entry4dd149d4-515b-4100-9688-49b0ff7a9535 and actual editor restored exact text with controls. Loaded-editor evidence is `sim19-reopened-editor-ax.json`, not the pre-tap Files snapshot.

Device build19 finished116.77s/exit0. Verified development bundle app.zorid.notes.dev, version19, unchanged frozen Swift hashes and codesign deep/strict0. Actual connected iPhone install and launch both exited0 with JSON outcome success; process10310. App intentionally left open. Simulator test app/helper stopped0; exact device kept booted. Slot returned coordinator9e92b7187dc4. No warm source included, no physical-phone UI acceptance or interrupted-in-flight-create proof claimed. Persistent exact command/artifact/install/launch evidence in `/Users/ctk/orca/artifacts/zorid-native-20261018/phone19-*.json` and `sim19-artifact.json`. Native/main composition remains coordinator-owned.
