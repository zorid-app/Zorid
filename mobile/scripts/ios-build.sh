#!/bin/bash
set +x
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
fail() { printf '%s\n' "$*" >&2; exit 1; }
MODE="${1:-simulator}"
case "$MODE" in
  simulator) TARGET=aarch64-apple-ios-sim; PROFILE=debug; CONFIG=Debug; SDK=iphonesimulator; DEST='generic/platform=iOS Simulator' ;;
  device) TARGET=aarch64-apple-ios; PROFILE=release; CONFIG=Release; SDK=iphoneos; DEST='generic/platform=iOS' ;;
  *) fail 'Usage: ios-build.sh [simulator|device]' ;;
esac
[[ "$(uname -s)" == Darwin ]] || fail 'iOS builds require macOS and full Xcode.'
for cmd in pnpm cargo rustup xcrun python3; do command -v "$cmd" >/dev/null || fail "Missing command: $cmd"; done
[[ -f mobile/rust/Cargo.lock ]] || fail 'Missing mobile/rust/Cargo.lock; integrate the native-core batch first.'
[[ -f ios/App/App.xcodeproj/project.pbxproj ]] || fail 'Missing iOS Xcode project.'
[[ -d node_modules ]] || fail 'Run pnpm install --frozen-lockfile first.'
# Xcode selection is caller-owned: DEVELOPER_DIR is honored by xcrun.
xcrun --find xcodebuild >/dev/null
XCODE_MAJOR="$(xcrun xcodebuild -version | python3 -c 'import sys; print(sys.stdin.readline().split()[1].split(".")[0])')"
[[ "$XCODE_MAJOR" =~ ^[0-9]+$ && "$XCODE_MAJOR" -ge 26 ]] || fail 'Select Xcode 26 or later with DEVELOPER_DIR (Capacitor 8 and current upload requirement).'

rustup target list --installed | python3 -c 'import sys; target=sys.argv[1]; sys.exit(0 if target in sys.stdin.read().splitlines() else 1)' "$TARGET" || fail "Install the official Rust target: rustup target add $TARGET"
: "${IOS_BUILD_NUMBER:?Set an unused, increasing IOS_BUILD_NUMBER (1..9999).}"
[[ "$IOS_BUILD_NUMBER" =~ ^[1-9][0-9]{0,3}$ ]] || fail 'IOS_BUILD_NUMBER must be an integer from 1 through 9999.'
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
cargo "${CARGO_ARGS[@]}"
[[ -f "$CARGO_TARGET_DIR/$TARGET/$PROFILE/libzorid_mobile_ffi.a" ]] || fail 'Missing zorid_mobile_ffi static library.'
XCODE_ARGS=(-project ios/App/App.xcodeproj -scheme App -configuration "$CONFIG" -sdk "$SDK" -destination "$DEST" -derivedDataPath "$OUTPUT/DerivedData" -jobs 1 "ARCHS=arm64" "CURRENT_PROJECT_VERSION=$IOS_BUILD_NUMBER" 'MARKETING_VERSION=0.1.0' 'PRODUCT_BUNDLE_IDENTIFIER=app.zorid.notes')
if [[ "$MODE" == simulator ]]; then
  xcrun xcodebuild "${XCODE_ARGS[@]}" CODE_SIGNING_ALLOWED=NO build
  printf 'Unsigned simulator app: %s\n' "$OUTPUT/DerivedData/Build/Products/Debug-iphonesimulator/App.app"
else
  xcrun xcodebuild "${XCODE_ARGS[@]}" "DEVELOPMENT_TEAM=$IOS_TEAM_ID" CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=$IOS_SIGNING_IDENTITY" "PROVISIONING_PROFILE_SPECIFIER=$IOS_PROFILE_UUID" -archivePath "$OUTPUT/App.xcarchive" archive
fi
