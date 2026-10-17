# Native mobile integration

Owner: terminal `term_bbf1787b-d2e5-402a-b366-24d40a2385c3`, original base
main `f69dc90`. Current isolated branch `tingkai-c/native-mobile-recovery`, Orca
worktree `/Users/ctk/orca/workspaces/Zorid/native-mobile-recovery`. Canonical main
`a160739` was merged into this isolated branch. Coordinator inbox
`run:run_3e72b2c9ab72` is sole main integrator; this owner never mutates main/pushes.

## Framework and binding decision

UIKit owns native launch, app-local vault creation/selection, navigation, safe-area
and keyboard viewport layout. Existing Capacitor8 WKWebView hosts the existing web
editor. A small independent `mobile/rust` staticlib/C ABI embeds the existing Rust
host dispatcher/vault/SQLite core in-process. No new UI framework, daemon, editor,
Markdown/Base parser or index implementation is introduced. Stage4 query APIs will
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
The precise workspace hook is coordinator-owned pending scoped approval.

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
