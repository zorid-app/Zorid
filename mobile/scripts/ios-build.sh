#!/bin/bash
set +x
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
fail() { printf '%s\n' "$*" >&2; exit 1; }
MODE="${1:-simulator}"
SCHEME=App
case "$MODE" in
  simulator) TARGET=aarch64-apple-ios-sim; PROFILE=debug; CONFIG=Debug; SDK=iphonesimulator; DEST='generic/platform=iOS Simulator' ;;
  development) TARGET=aarch64-apple-ios; PROFILE=debug; SCHEME=App-Dev; CONFIG=Debug-Dev; SDK=iphoneos; DEST='generic/platform=iOS' ;;
  device) TARGET=aarch64-apple-ios; PROFILE=release; CONFIG=Release; SDK=iphoneos; DEST='generic/platform=iOS' ;;
  *) fail 'Usage: ios-build.sh [simulator|device|development]' ;;
esac
[[ "$(uname -s)" == Darwin ]] || fail 'iOS builds require macOS and full Xcode.'
for cmd in pnpm xcrun python3; do command -v "$cmd" >/dev/null || fail "Missing command: $cmd"; done
# Executable overrides are scalar paths/names, never command strings or shell code.
CARGO_BIN="${CARGO:-cargo}"
RUSTC_BIN="${RUSTC:-rustc}"
CARGO_BIN="$(command -v -- "$CARGO_BIN")" || fail 'CARGO must name an executable file (no arguments).'
RUSTC_BIN="$(command -v -- "$RUSTC_BIN")" || fail 'RUSTC must name an executable file (no arguments).'
[[ -f "$CARGO_BIN" && -x "$CARGO_BIN" ]] || fail 'CARGO must name an executable file.'
[[ -f "$RUSTC_BIN" && -x "$RUSTC_BIN" ]] || fail 'RUSTC must name an executable file.'
# Keep rustup proxy basenames intact; resolve relative paths before Cargo changes directory.
case "$CARGO_BIN" in /*) ;; *) CARGO_BIN="$ROOT/$CARGO_BIN" ;; esac
case "$RUSTC_BIN" in /*) ;; *) RUSTC_BIN="$ROOT/$RUSTC_BIN" ;; esac
export RUSTC="$RUSTC_BIN"
# The selected compiler's sysroot is authoritative, including non-rustup installations.
TARGET_LIBDIR="$("$RUSTC" --print target-libdir --target "$TARGET")" || fail "Selected RUSTC cannot locate target libraries for $TARGET."
[[ -d "$TARGET_LIBDIR" ]] || fail "Selected RUSTC lacks installed target libraries for $TARGET."
shopt -s nullglob
TARGET_LIBCORE=("$TARGET_LIBDIR"/libcore-*.rlib)
[[ ${#TARGET_LIBCORE[@]} -gt 0 && -f "${TARGET_LIBCORE[0]}" ]] || fail "Selected RUSTC has no libcore for $TARGET; install the official target into this compiler's toolchain."
[[ -f mobile/rust/Cargo.lock ]] || fail 'Missing mobile/rust/Cargo.lock; integrate the native-core batch first.'
[[ -f ios/App/App.xcodeproj/project.pbxproj ]] || fail 'Missing iOS Xcode project.'
[[ -d node_modules ]] || fail 'Run pnpm install --frozen-lockfile first.'
# Xcode selection is caller-owned: DEVELOPER_DIR is honored by xcrun.
xcrun --find xcodebuild >/dev/null
XCODE_MAJOR="$(xcrun xcodebuild -version | python3 -c 'import sys; print(sys.stdin.readline().split()[1].split(".")[0])')"
[[ "$XCODE_MAJOR" =~ ^[0-9]+$ && "$XCODE_MAJOR" -ge 26 ]] || fail 'Select Xcode 26 or later with DEVELOPER_DIR (Capacitor 8 and current upload requirement).'

: "${IOS_BUILD_NUMBER:?Set an unused, increasing IOS_BUILD_NUMBER (1..9999).}"
[[ "$IOS_BUILD_NUMBER" =~ ^[1-9][0-9]{0,3}$ ]] || fail 'IOS_BUILD_NUMBER must be an integer from 1 through 9999.'
if [[ "$MODE" == development ]]; then
  [[ -f ios/App/App.xcodeproj/xcshareddata/xcschemes/App-Dev.xcscheme ]] || fail 'Integrate native development variants (9f507594) before a development build.'
  : "${IOS_OUTPUT_DIR:?Set a fresh IOS_OUTPUT_DIR outside the repository.}"
  : "${IOS_TEAM_ID:?Set the nonsecret development IOS_TEAM_ID.}"
  : "${IOS_DEVICE_ID:?Set the paired iPhone hardware UDID (one device only).}"
  [[ "$IOS_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || fail 'IOS_TEAM_ID must be a ten-character Apple team ID.'
  [[ "$IOS_DEVICE_ID" =~ ^([A-Fa-f0-9]{40}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16})$ ]] || fail 'IOS_DEVICE_ID must be one hardware UDID, not a name or list.'
  case "${IOS_ALLOW_PROVISIONING_UPDATES:-0}" in 0|1) ;; *) fail 'IOS_ALLOW_PROVISIONING_UPDATES must be 0 or 1.' ;; esac
  DEV_SIGNING_STYLE=Automatic
  if [[ "${IOS_DEV_PROFILE_UUID+x}" == x || "${IOS_DEV_SIGNING_IDENTITY+x}" == x ]]; then
    : "${IOS_DEV_PROFILE_UUID:?Manual development signing requires IOS_DEV_PROFILE_UUID.}"
    : "${IOS_DEV_SIGNING_IDENTITY:?Manual development signing requires IOS_DEV_SIGNING_IDENTITY.}"
    [[ "$IOS_DEV_PROFILE_UUID" =~ ^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$ ]] || fail 'IOS_DEV_PROFILE_UUID must be a profile UUID.'
    [[ "$IOS_DEV_SIGNING_IDENTITY" =~ ^[A-Fa-f0-9]{40}$ ]] || fail 'IOS_DEV_SIGNING_IDENTITY must be the exact certificate SHA1 fingerprint.'
    [[ "${IOS_ALLOW_PROVISIONING_UPDATES:-0}" == 0 ]] || fail 'Manual development signing forbids provisioning updates; unset IOS_ALLOW_PROVISIONING_UPDATES or set 0.'
    DEV_SIGNING_STYLE=Manual
  fi
  # Resolve existing ancestors/symlinks before creating any output. Never reuse a stale build.
  IOS_OUTPUT_DIR="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().resolve())' "$IOS_OUTPUT_DIR")"
  PHYSICAL_ROOT="$(pwd -P)"
  case "$IOS_OUTPUT_DIR/" in "$PHYSICAL_ROOT/"*) fail 'Development output must be outside the repository.' ;; esac
  [[ ! -e "$IOS_OUTPUT_DIR" ]] || fail 'Development output already exists; choose a fresh IOS_OUTPUT_DIR.'
  DEST="platform=iOS,id=$IOS_DEVICE_ID"
fi
OUTPUT="${IOS_OUTPUT_DIR:-${TMPDIR:-/tmp}/zorid-ios-output}"
mkdir -p "$OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd)"
case "$OUTPUT/" in "$ROOT/"*) fail 'IOS_OUTPUT_DIR must be outside the repository.' ;; esac
if [[ "$MODE" == device ]]; then
  : "${IOS_TEAM_ID:?Missing IOS_TEAM_ID}"
  : "${IOS_PROFILE_UUID:?Use ios-release.sh to prepare the signing profile}"
  : "${IOS_SIGNING_IDENTITY:?Use ios-release.sh to prepare the signing identity}"
  [[ ! -e "$OUTPUT/App.xcarchive" ]] || fail 'Archive exists; choose a fresh IOS_OUTPUT_DIR.'
fi
# No WASM build or Electron runtime is needed by the mobile web bundle.
pnpm exec webpack --mode production --env target=desktop
[[ -f dist/index.html ]] || fail 'Webpack did not produce dist/index.html.'
# Copy runtime assets/config only. Never cap sync/update/add: they mutate native source/SPM.
pnpm exec cap copy ios
[[ -f ios/App/App/public/index.html ]] || fail 'Capacitor did not copy the web bundle.'
export CARGO_TARGET_DIR="$ROOT/mobile/rust/target"
# Optional compiler overrides (paths, not shell command strings); otherwise use selected Xcode.
export CC="${IOS_CC:-$(xcrun --sdk "$SDK" --find clang)}"
export CXX="${IOS_CXX:-$(xcrun --sdk "$SDK" --find clang++)}"
export AR="${IOS_AR:-$(xcrun --sdk "$SDK" --find ar)}"
export SDKROOT="$(xcrun --sdk "$SDK" --show-sdk-path)"
CARGO_ARGS=(build --locked --manifest-path mobile/rust/Cargo.toml --target "$TARGET" -j1)
[[ "$PROFILE" != release ]] || CARGO_ARGS+=(--release)
"$CARGO_BIN" "${CARGO_ARGS[@]}"
[[ -f "$CARGO_TARGET_DIR/$TARGET/$PROFILE/libzorid_mobile_ffi.a" ]] || fail 'Missing zorid_mobile_ffi static library.'
XCODE_ARGS=(-project ios/App/App.xcodeproj -scheme "$SCHEME" -configuration "$CONFIG" -sdk "$SDK" -destination "$DEST" -derivedDataPath "$OUTPUT/DerivedData" -jobs 1 "ARCHS=arm64" "CURRENT_PROJECT_VERSION=$IOS_BUILD_NUMBER" 'MARKETING_VERSION=0.1.0' )
if [[ "$MODE" == development ]]; then
  # Command-line overrides only: preserve the project's OTHER_LDFLAGS and native source.
  # Override both general and SDK-specific paths so no iphoneos Release library is selected.
  XCODE_ARGS+=(
    'PRODUCT_BUNDLE_IDENTIFIER=app.zorid.notes.dev'
    'ZORID_APP_DISPLAY_NAME=Zorid Dev'
    "DEVELOPMENT_TEAM=$IOS_TEAM_ID" 'PROVISIONING_PROFILE='
    'LIBRARY_SEARCH_PATHS="$(PROJECT_DIR)/../../mobile/rust/target/aarch64-apple-ios/debug"'
    'LIBRARY_SEARCH_PATHS[sdk=iphoneos*]="$(PROJECT_DIR)/../../mobile/rust/target/aarch64-apple-ios/debug"'
  )
  if [[ "$DEV_SIGNING_STYLE" == Manual ]]; then
    XCODE_ARGS+=(CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=$IOS_DEV_SIGNING_IDENTITY" "PROVISIONING_PROFILE_SPECIFIER=$IOS_DEV_PROFILE_UUID")
  else
    XCODE_ARGS+=(CODE_SIGN_STYLE=Automatic 'CODE_SIGN_IDENTITY=Apple Development' 'PROVISIONING_PROFILE_SPECIFIER=')
    if [[ "${IOS_ALLOW_PROVISIONING_UPDATES:-0}" == 1 ]]; then
      XCODE_ARGS+=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration)
    fi
  fi
  xcrun xcodebuild "${XCODE_ARGS[@]}" build
  printf 'Development app (app.zorid.notes.dev): %s\n' "$OUTPUT/DerivedData/Build/Products/Debug-Dev-iphoneos/App.app"
  printf '%s\n' 'Build finished; installation and launch are separate explicit ios-run.sh actions.'
elif [[ "$MODE" == simulator ]]; then
  xcrun xcodebuild "${XCODE_ARGS[@]}" PRODUCT_BUNDLE_IDENTIFIER=app.zorid.notes CODE_SIGNING_ALLOWED=NO build
  printf 'Unsigned simulator app: %s\n' "$OUTPUT/DerivedData/Build/Products/Debug-iphonesimulator/App.app"
else
  xcrun xcodebuild "${XCODE_ARGS[@]}" PRODUCT_BUNDLE_IDENTIFIER=app.zorid.notes "DEVELOPMENT_TEAM=$IOS_TEAM_ID" CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=$IOS_SIGNING_IDENTITY" "PROVISIONING_PROFILE_SPECIFIER=$IOS_PROFILE_UUID" -archivePath "$OUTPUT/App.xcarchive" archive
fi
