# Native iOS delivery

Delivery owner: `tingkai-c/mobile-ios-delivery`, owning only this document,
`.github/workflows/mobile-ios.yml` and `mobile/scripts/**`. Native core/project/shell
owner: `term_bbf1787b-d2e5-402a-b366-24d40a2385c3`. Apple provisioning owner:
`term_86199dce-0f1c-45f0-9ca0-8942cba829c5`, owning `mobile/apple/**` and Apple
remote mutations/signing material. Main integration/push belongs to the coordinator.
Do not interpret this source batch as integration or native verification.

## State and dependencies — 2026-10-17

Workflow/scripts prepared; shell/Python syntax checked and independent source
review performed. No dependency installation, Rust/web/Xcode build, simulator,
archive, signing, upload or GitHub push was run by the delivery worker.
Secret names are agreed with the Apple owner; no secrets have been set by this
worker. Apple initially returned `REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`;
the account holder subsequently reported acceptance. The Apple worker
rechecked and still observed API 403 after Developer account showed acceptance;
propagation or another outstanding account requirement remains unconfirmed.
App registration, profile/certificate readiness and tester availability need the
Apple owner's fresh result. Consult `mobile/apple/README.md` after that batch lands.
No TestFlight upload or installation is claimed.

Prerequisites to first run:

- Integrate the native owner's `mobile/rust/Cargo.toml` and its independent
  `Cargo.lock`, Rust/core dependencies, shell and Xcode linkage. Crate/staticlib
  name: `zorid-mobile-ffi` / `libzorid_mobile_ffi.a`. Xcode must link
  `mobile/rust/target/aarch64-apple-ios-sim/debug` for simulator Debug and
  `mobile/rust/target/aarch64-apple-ios/release` for device Release. Scripts do
  not alter native linker settings or generate a missing lockfile.
- Commit the current pnpm lockfile and `ios/App/CapApp-SPM/Package.swift` together
  when dependency changes require it. The package currently pins upstream
  Capacitor 8.5.3 and has a Filesystem dependency into the local pnpm layout.
  This exact installed layout is required; the scripts do not rewrite Package.swift.
- macOS with full Xcode 26+, accepted local Xcode license/first-launch setup,
  Node 26, pnpm 12.14.0, Rust with installed iOS target libraries, Python 3 and available Apple SDKs. CI uses
  the hosted `macos-15` image and explicitly selects Xcode 26.3; its default
  Xcode may be older. A missing pinned Xcode fails rather than silently falling back.
- Before upload: Apple owner confirms the exact `app.zorid.notes` app/bundle,
  team, valid App Store distribution profile, matching Apple Distribution
  certificate **with private key** in P12, and an upload-authorized ASC API key.
  A macOS Developer ID certificate is insufficient. Team/profile values are not
  hardcoded in source.

## Local builds

Run from any directory, using an absolute script path if outside the repo.
Install dependencies from the repo root once; no speculative tool installs or
Electron runtime install is needed:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
rustup target add aarch64-apple-ios-sim
DEVELOPER_DIR=/Applications/Xcode_26.3.app/Contents/Developer \
  IOS_BUILD_NUMBER=1 IOS_OUTPUT_DIR="$HOME/Library/Caches/zorid-ios-sim-1" \
  bash mobile/scripts/ios-build.sh simulator
```

This compiles, but does not boot/install a simulator. The unsigned app is at
`$IOS_OUTPUT_DIR/DerivedData/Build/Products/Debug-iphonesimulator/App.app`.
It is an arm64 simulator app, not an IPA or physical-device app.

The script runs `pnpm exec webpack --mode production --env target=desktop`,
which uses the existing web bundle path without the unnecessary WASM build and
has no Electron runtime dependency. `pnpm exec cap copy ios` copies `dist` into
`ios/App/App/public` and refreshes runtime config/assets. It deliberately does
not run `cap sync`, `update` or `add`, which can rewrite native project/package
source. Run on a clean disposable build checkout; runtime copies can dirty
tracked generated files. Preserve native source changes and review any unexpected
diff; do not use a blanket reset/clean to hide them.

Rust builds use `--locked --manifest-path mobile/rust/Cargo.toml -j1` with official
`aarch64-apple-ios-sim` Debug or `aarch64-apple-ios --release` targets.
`CARGO` and `RUSTC` accept one executable path or PATH-resolved executable name
(each defaults to `cargo` / `rustc`). Both are validated as executable files and
invoked as quoted scalars, with no word splitting or `eval`; arguments such as
`CARGO="cargo +stable"` are rejected. Select a toolchain with executable paths or
the normal rustup environment instead. `RUSTC` is exported to Cargo so preflight
and compilation use the same selected compiler. The preflight asks that compiler
for `--print target-libdir --target <target>`, requires its directory to exist,
and checks for `libcore-*.rlib`. A shared `rustup target list` from a different
installation is not used and rustup itself is not required by the build script.
This proves target-library presence, not successful linking or a compatible build.
Do not set Cargo configuration or Rust compiler wrappers that substitute a different
compiler after preflight; toolchain compatibility remains the build owner's gate.

The owner recovered official Rust 1.95 at the shared canonical toolchain path.
For that installation, set both executable overrides explicitly (the same variables
also flow through `ios-release.sh`):

```sh
export CARGO=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/cargo
export RUSTC=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin/rustc
```

Follow-up checks passed: shell syntax, independent source review, selected-compiler
target-libdir/libcore preflight for both iOS triples using the recovered toolchain,
and rejection of `CARGO="cargo --version"`. These were read-only preflight queries;
no Cargo compilation, staticlib build or Xcode build ran.

This is a local recovery path, not a hardcoded CI dependency. Installing targets
with rustup, when needed, must address this selected toolchain's sysroot; changing
`RUSTUP_HOME` does not redirect a Homebrew compiler. Source follow-up validation
must not take the owner's exclusive staticlib build slot.

`CARGO_TARGET_DIR` is fixed to `mobile/rust/target` to match the project.
`IOS_CC`, `IOS_CXX`, and `IOS_AR` optionally specify compiler/tool **paths**, not
shell command strings; defaults come from the selected Xcode SDK. `DEVELOPER_DIR`
selects Xcode without changing global xcode-select state. No nightly/build-std,
WASM target, cross compiler package, CocoaPods or fastlane install is performed.

## Paired physical iPhone: development build, install, launch

This path is separate from TestFlight. Source is prepared for owner recovery
`aff0665c`; the owner's reported Rust host/ABI/simulator staticlib results do not
prove a physical-device Debug build, web bundle, Xcode signing, installation or
launch. Delivery worker performed syntax/source review only, with no build,
provisioning mutation, device installation or simulator/device run. The native
owner controls the single build slot and runs these commands after integration.

Use `mobile/scripts/ios-run.sh` with three separate explicit actions: `build`
(default), `install`, and `launch`. `build` only builds. `install` uses the existing
build output without rebuilding or launching; `launch` requests launch of that
bundle without reinstalling. All actions require one `IOS_DEVICE_ID`: the paired
iPhone's hardware UDID, accepted by both Xcode destination selection and devicectl
(40 hexadecimal digits, or 8 hexadecimal digits followed by a hyphen and 16 more).
Names, lists, and CoreDevice UUIDs are rejected.
No action discovers/selects the first device, targets all devices, erases data,
uninstalls an app, or terminates a running app. Installing another development
build may update the existing **development** app; retain development test data
only with the usual care for unreleased schemas.

Native variants from `9f507594` must be integrated alongside this script update;
do not merge the entire native worker branch. `App-Dev` selects Debug-Dev for
running and Release-Dev for archiving; `App-Prod` selects Debug-Prod/Release-Prod.
Legacy `App` Debug/Release remain production aliases, and the existing simulator
CI build (`App`/Debug) and TestFlight archive (`App`/Release) stay unchanged.
Development never substitutes a bundle-only command-line override on legacy
Debug: the native variant supplies `ZoridAppEnvironment=development` and the
`ZORID_DEVELOPMENT` Swift compilation condition together. The install/launch
wrapper also rejects output whose plist environment is not `development`.

Development bundle ID is fixed to **`app.zorid.notes.dev`**. It has a separate app
sandbox from production `app.zorid.notes`, protecting production's installed data.
Development passes `ZORID_APP_DISPLAY_NAME=Zorid Dev` as one Xcode argument.
Owner commit `4c299d86` supplies the Info.plist variable and default **Zorid**;
integrate it before expecting the **Zorid Dev** icon name. This worker makes no
project/Info.plist edits. Distribution retains the owner's default name. Capacitor runtime config still comes
from the checked-in config; the native bundle override and installed app identity
are `.dev`. Future app groups/keychain groups or other shared-container features
must be reviewed before assuming this separate ID alone isolates such features.

Prerequisites: unlock/trust/pair the phone, enable iPhone Developer Mode as needed,
select full Xcode 26+, and use a signed-in Xcode Apple Account with the intended
team or existing valid development identity/profile. Apple worker coordinates
team/device/account readiness; an ASC API key is neither needed nor passed to
this path. Account restrictions or outstanding agreements may still prevent
creating development signing assets. Do not paste account credentials into commands.
Find/verify the specific phone UDID in Xcode's Devices and Simulators UI; verify it
with the owner before a run. No IDs are hardcoded in scripts or documentation.

Use the explicit official `CARGO`/`RUSTC` executable paths documented above and
installed `aarch64-apple-ios` target libraries. Set the nonsecret `IOS_TEAM_ID`,
`IOS_DEVICE_ID`, `IOS_BUILD_NUMBER` and a **new, nonexistent** external output path:

```sh
export DEVELOPER_DIR=/Applications/Xcode_26.3.app/Contents/Developer
# Set IOS_TEAM_ID and IOS_DEVICE_ID to the Apple-worker/owner-confirmed values.
export IOS_TEAM_ID IOS_DEVICE_ID
export IOS_BUILD_NUMBER=1
export IOS_OUTPUT_DIR="$HOME/Library/Caches/zorid-iphone-dev-1"
unset IOS_DEV_PROFILE_UUID IOS_DEV_SIGNING_IDENTITY
IOS_ALLOW_PROVISIONING_UPDATES=0 bash mobile/scripts/ios-run.sh build
```

Observed owner device build `87781` failed Xcode exit 65: the existing wildcard
profile is Xcode-managed, and Manual signing rejects a managed profile even when
its key, bundle and phone match. Owner separately reported the device Debug Rust
build passed in 1m05s; that does not establish Xcode signing or installation.
Owner retry `63867` is using Automatic signing with the cached profile, both manual
variables unset and `IOS_ALLOW_PROVISIONING_UPDATES=0`, without provisioning flags
or new signing assets. Its outcome is **pending** at this source checkpoint.

Manual signing requires a **manually managed development provisioning profile**,
not the existing Xcode-managed wildcard profile. Only for such a profile, set both
`IOS_DEV_PROFILE_UUID` and `IOS_DEV_SIGNING_IDENTITY` to the exact profile
UUID and certificate SHA1 fingerprint supplied by Apple owner. These are nonsecret
identifiers, passed as quoted scalar build settings. Setting either variable
requires both to be nonempty and valid; invalid/incomplete settings fail without
falling back to automatic signing. Manual signing uses `CODE_SIGN_STYLE=Manual`,
`PROVISIONING_PROFILE_SPECIFIER=<UUID>` and `CODE_SIGN_IDENTITY=<fingerprint>`.
It never adds provisioning network flags; `IOS_ALLOW_PROVISIONING_UPDATES=1` is
rejected in this branch. The matching profile must already be installed and its
private-key identity available in the local keychain; no distribution wrapper,
key export/import or provisioning mutation is performed by this script.

Apple owner reports that the private local contract at
`~/certificates/apple/apps/zorid/development/signing-contract-private.json`
contains `team_id`, `profile_uuid`, `identity_sha1`, `profile_path`,
`code_sign_identity`, `device_udid`, `development`, and `bundle_id`. The retained
`current.mobileprovision` is alongside it. Apple owner verified the existing
wildcard development profile covers the phone and development bundle, with
Developer Mode enabled. Populate `IOS_TEAM_ID` and `IOS_DEVICE_ID` privately
from that contract for the cached automatic path, leaving both manual variables
unset. Use `profile_uuid` / `identity_sha1` for the manual variables only after
Apple owner supplies a suitable manually managed profile and updates the contract.
Do not dump the contract into logs or source and do not `source`/`eval` JSON.
Owner still must verify build entitlements fit the profile and actual signing succeeds.

```sh
# Only after Apple owner supplies a manually managed profile; the cached wildcard is unsuitable.
# Use its exact profile UUID and identity_sha1, not a certificate label.
export IOS_DEV_PROFILE_UUID IOS_DEV_SIGNING_IDENTITY
export IOS_OUTPUT_DIR="$HOME/Library/Caches/zorid-iphone-dev-manual-1"
IOS_ALLOW_PROVISIONING_UPDATES=0 bash mobile/scripts/ios-run.sh build
```

With both manual variables unset, Xcode uses automatic development signing and
existing available signing assets for the explicitly supplied team, without the
provisioning update/device-registration flags. If those assets are missing, the
explicit owner-authorized command below permits Xcode automatic signing to create
or update development signing resources and register the selected phone. Use a
fresh output path even after a failed build; preserve prior evidence rather than
removing/reusing an output automatically:

```sh
unset IOS_DEV_PROFILE_UUID IOS_DEV_SIGNING_IDENTITY
export IOS_OUTPUT_DIR="$HOME/Library/Caches/zorid-iphone-dev-2"
IOS_ALLOW_PROVISIONING_UPDATES=1 bash mobile/scripts/ios-run.sh build
```

`IOS_ALLOW_PROVISIONING_UPDATES` accepts only `0` (default) or `1`. Only `1` adds
both `-allowProvisioningUpdates` and `-allowProvisioningDeviceRegistration` to
an explicit automatic-signing build only. Manual signing never uses these flags.
The scripts do not log in or accept agreements, import a
private key, use an API key/password argument, or change the project signing
settings on disk. Xcode uses its signed-in Apple Account/local keychain.

Build sequence is the production `webpack --env target=desktop` bundle plus
`cap copy ios`, then `cargo build --locked --manifest-path mobile/rust/Cargo.toml
--target aarch64-apple-ios -j1` **without `--release`**, and Xcode App project,
**App-Dev** scheme / **Debug-Dev** configuration, iphoneos, arm64, `-jobs 1`, selected phone destination, manual or automatic
development signing as selected above, explicit development team and display name
**Zorid Dev**. Both general and `iphoneos` SDK-specific
`LIBRARY_SEARCH_PATHS` are overridden to
`mobile/rust/target/aarch64-apple-ios/debug`; the existing project's iphoneos
Release path cannot accidentally supply this library. `OTHER_LDFLAGS` stays under
native project ownership. Output is
`$IOS_OUTPUT_DIR/DerivedData/Build/Products/Debug-Dev-iphoneos/App.app`, with version
0.1.0 and supplied build number. This is not a distribution archive or IPA.

After the owner confirms the build, retain the same output/device variables and
run the separate requested steps:

```sh
bash mobile/scripts/ios-run.sh install
bash mobile/scripts/ios-run.sh launch
```

Before either device action, the wrapper checks the built Info.plist for exact
`.dev` bundle ID, `development` app environment, `iPhoneOS` platform and an existing app executable. Install uses
`xcrun devicectl device install app --device "$IOS_DEVICE_ID" <built-app>`; launch
uses `xcrun devicectl device process launch --device "$IOS_DEVICE_ID"
app.zorid.notes.dev`. A failed install or launch exits nonzero; it does not erase,
uninstall, retry against another phone, or claim success. The owner must record
actual signing/install/launch output and visible app behavior separately. A locked
phone, untrusted developer identity, missing Developer Mode or unavailable
provisioning requires resolving that prerequisite before retrying.

## Signed device export and explicit upload

Use a fresh external output directory for every archive. All environment values
below are local inputs populated by the Apple owner, never pasted into a logged
command, source, issue or chat. Load the P12 password from its protected file
without shell tracing. A password file must contain exactly the password bytes
(no trailing newline). Do not export signed artifacts or credentials into Git.

```sh
rustup target add aarch64-apple-ios
export DEVELOPER_DIR=/Applications/Xcode_26.3.app/Contents/Developer
export IOS_BUILD_NUMBER=2
export IOS_OUTPUT_DIR="$HOME/Library/Caches/zorid-ios-device-2"
# Set IOS_TEAM_ID and the three path inputs using the Apple owner's secure local files.
# IOS_DISTRIBUTION_P12_PATH=/absolute/path/to/distribution.p12
# IOS_PROVISION_PROFILE_PATH=/absolute/path/to/app-store.mobileprovision
# IOS_DISTRIBUTION_P12_PASSWORD_PATH=/absolute/path/to/password-file
export IOS_DISTRIBUTION_P12_PATH IOS_PROVISION_PROFILE_PATH IOS_TEAM_ID
export IOS_DISTRIBUTION_P12_PASSWORD="$(cat "$IOS_DISTRIBUTION_P12_PASSWORD_PATH")"
bash mobile/scripts/ios-release.sh export
unset IOS_DISTRIBUTION_P12_PASSWORD
```

`export` stops after archive/export and creates exactly one IPA in
`$IOS_OUTPUT_DIR/ipa`. It requires no ASC key. To upload instead, use a fresh output
directory/build number, set `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, and
`ASC_API_PRIVATE_KEY_PATH` (the Apple owner's `AuthKey_<id>.p8`), then run:

```sh
bash mobile/scripts/ios-release.sh upload
```

The release wrapper validates a nonexpired exact-bundle App Store profile,
selects the imported valid identity whose certificate appears in that profile,
creates a random-password temporary keychain, preserves the user keychain search
list, and installs profiles in both supported Xcode profile directories. Identical
preexisting profiles stay untouched. New profiles, temporary keys and keychain
are removed on ordinary exit/error/INT/TERM, and the search list is restored.
Do not run concurrent local signing sessions: the search list is user-global.
A forced kill/power loss can bypass traps; inspect leftover `zorid-ios-signing.*`
temporary directories and remove only their recorded profiles/keychain before
another signing run. Do not change the user's default keychain. CI uses disposable
GitHub-hosted VMs, not persistent self-hosted runners.

Archive uses `ios/App/App.xcodeproj`, scheme `App`, Release, generic iOS destination,
arm64, explicit team/profile/identity, version **0.1.0**, and supplied build number.
Export uses manual `app-store-connect` signing with build-number management off.
Upload uses Xcode's documented `altool --upload-app --apiKey --apiIssuer`, with
`API_PRIVATE_KEYS_DIR` scoped to a disposable key directory; no Apple ID password
or generated JWT is printed. Apple now documents `--upload-app` as deprecated in
favor of `--upload-package`; this established interface is retained for the
requested API-key contract and requires verification on the selected Xcode.
A future switch needs numeric ASC app ID metadata and a verified upload.

## GitHub manual workflow and secret contract

Only `workflow_dispatch` on `main` runs. There are no PR, tag, push or automatic
deploy triggers. One serialized macOS job uses bounded Rust/Xcode parallelism.
`build-only` is the default and uses no signing/ASC secrets; it preserves a
seven-day `ios-simulator.tar.gz` artifact. Extract with `tar -xzf` to retain app
permissions and symlinks before a separate native verification pass.
`upload` explicitly archives, exports and uploads; it does not save signed IPA or
archive as GitHub artifacts, release the App Store app, invite testers or assign
TestFlight groups.

Owner-reported remote setup (2026-10-17): `ios-build` and `ios-testflight` were
created and read back with custom deployment policies listing exactly branch
`main`; no secrets, workflow push or dispatch accompanied that setup. Delivery
worker did not independently requery these environments. Preserve that policy
before first upload; use repository environment protections as desired.
`ios-build` is the credential-free build environment. Configure signing secrets
only in `ios-testflight`, never in a PR-accessible environment or root YAML.
No credential is passed as a workflow_dispatch input. Dependency installation
happens before the signing step receives secrets, and raw secrets are removed
from the environment before invoking build children.

Exact names agreed with the Apple worker:

| Environment secret | Content |
| --- | --- |
| `IOS_DISTRIBUTION_P12_BASE64` | Single-line base64 of iOS distribution P12, including private key |
| `IOS_DISTRIBUTION_P12_PASSWORD` | Exact P12 password (may be empty only for an unprotected P12) |
| `IOS_PROVISION_PROFILE_BASE64` | Single-line base64 of matching App Store distribution profile |
| `IOS_TEAM_ID` | Team identifier confirmed by Apple owner |
| `ASC_API_KEY_ID` | ASC upload API key identifier |
| `ASC_API_ISSUER_ID` | ASC API issuer UUID |
| `ASC_API_PRIVATE_KEY_BASE64` | Single-line base64 of the corresponding P8 private key |

After Apple owner confirms readiness, delivery owner can run
`python3 mobile/scripts/ios-set-secrets.py` with `gh` authenticated to
`zorid-app/Zorid`, required local path variables from the example above, and
`IOS_TEAM_ID`. The helper reads ASC metadata from
`~/certificates/apple/team/app-store-connect-api/metadata.txt` (override
`ASC_METADATA_PATH`) and its sibling `AuthKey_<id>.p8`. It sends all seven values
directly to `gh secret set --repo zorid-app/Zorid --env ios-testflight` through
stdin and suppresses subprocess output. It does not create the environment or
Apple resources, modify existing macOS `APPLE_API_*` secrets, or print keys,
passwords, JWTs or base64. A partial remote write failure requires rerunning the
complete contract; do not inspect secret values to diagnose it.

After coordinator integration/push, dispatch from Actions or:

```sh
gh workflow run mobile-ios.yml --repo zorid-app/Zorid --ref main -f operation=build-only -f build_number=3
# Explicit upload, only once app/signing readiness and build evidence are established:
gh workflow run mobile-ios.yml --repo zorid-app/Zorid --ref main -f operation=upload -f build_number=4
```

Build numbers must be unused and increasing for version 0.1.0 across local and CI
uploads. Contract accepts integers `1..9999`, within Apple's first-component limit.
An omitted dispatch number uses `github.run_number`; check ASC first if local
uploads or another workflow may have advanced the sequence. Rerunning a successful
upload with the same build number is invalid; dispatch a fresh number. Beyond
9999, deliberately revise version/build-number strategy before uploading.

## Verification boundary and official references

Delivery source/syntax review does not prove the current native crate compiles,
Swift linkage works, device signing succeeds, privacy/icons/export compliance
are accepted, or the mobile app functions. Record first simulator compile,
archive/export, successful upload response, processed ASC build, group assignment
and actual TestFlight installation as separate evidence. altool success alone is
not proof a build is processed or available to testers. API upload can succeed
while Apple still requires export-compliance or other account/app actions.
Heavy verification remains with the native owner and must be serialized.

Current official guidance checked 2026-10-17:

- [GitHub: Apple certificates on hosted macOS runners](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
  supports importing secrets into an ephemeral keychain and cleaning profiles;
  hosted VMs are destroyed after jobs.
- [Apple: upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
  lists current iOS Xcode requirements and distinguishes delivery from processing.
- [Apple: altool options](https://help.apple.com/asc/appsaltool/en.lproj/static.html)
  documents API-key authentication, private-key search directory and upload interfaces.
- [GitHub runner image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md)
  lists Xcode 26.3 alongside the older default; images can change.
- [Capacitor 8: copy command](https://capacitorjs.com/docs/cli/commands/copy)
  documents copying web assets and runtime configuration.
- [GitHub artifact permission behavior](https://github.com/actions/upload-artifact#permission-loss)
  explains why the simulator bundle is tarred before artifact storage.

Physical-device references checked 2026-10-17:

- [Apple: Xcode command-line tools](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)
  identifies Xcode's `devicectl` and `xcodebuild` tools.
- [Apple: signing workflow](https://help.apple.com/xcode/mac/current/en.lproj/dev60b6fbbc7.html)
  describes automatic development signing assets.
- [Apple: automatic signing controls](https://developer.apple.com/help/account/access/automatic-signing-controls)
  explains team restrictions on registering App IDs and devices.
- [Apple: command-line provisioning flags](https://help.apple.com/xcode/mac/current/en.lproj/dev86f8cf93d.html)
  documents the explicit update and device-registration flags.
