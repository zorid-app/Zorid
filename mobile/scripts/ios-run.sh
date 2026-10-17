#!/bin/bash
set +x
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"
fail() { printf '%s\n' "$*" >&2; exit 1; }
ACTION="${1:-build}"
[[ $# -le 1 ]] || fail 'Usage: ios-run.sh [build|install|launch]'
case "$ACTION" in build|install|launch) ;; *) fail 'Usage: ios-run.sh [build|install|launch]' ;; esac
[[ "$(uname -s)" == Darwin ]] || fail 'iPhone development requires macOS and full Xcode.'
: "${IOS_OUTPUT_DIR:?Set the development build output directory outside the repository.}"
: "${IOS_DEVICE_ID:?Set one paired iPhone hardware UDID.}"
[[ "$IOS_DEVICE_ID" =~ ^([A-Fa-f0-9]{40}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16})$ ]] || fail 'IOS_DEVICE_ID must be one hardware UDID, not a name or list.'
# This path needs neither API credentials nor distribution-signing material.
unset IOS_DISTRIBUTION_P12_BASE64 IOS_DISTRIBUTION_P12_PASSWORD IOS_PROVISION_PROFILE_BASE64
unset ASC_API_PRIVATE_KEY_BASE64 ASC_API_KEY_ID ASC_API_ISSUER_ID
unset IOS_DISTRIBUTION_P12_PATH IOS_PROVISION_PROFILE_PATH ASC_API_PRIVATE_KEY_PATH
if [[ "$ACTION" == build ]]; then
  exec bash "$ROOT/mobile/scripts/ios-build.sh" development
fi
for cmd in xcrun python3; do command -v "$cmd" >/dev/null || fail "Missing command: $cmd"; done
xcrun --find devicectl >/dev/null || fail 'Selected Xcode does not provide devicectl.'
OUTPUT="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().resolve())' "$IOS_OUTPUT_DIR")"
case "$OUTPUT/" in "$ROOT/"*) fail 'Development output must be outside the repository.' ;; esac
APP="$OUTPUT/DerivedData/Build/Products/Debug-iphoneos/App.app"
# Validate the existing development build before either device action.
python3 - "$APP" <<'PY'
import pathlib
import plistlib
import sys
try:
    app = pathlib.Path(sys.argv[1])
    with (app / 'Info.plist').open('rb') as source:
        info = plistlib.load(source)
    if info.get('CFBundleIdentifier') != 'app.zorid.notes.dev':
        raise ValueError('bundle')
    if info.get('CFBundleSupportedPlatforms') != ['iPhoneOS']:
        raise ValueError('platform')
    executable = info.get('CFBundleExecutable', '')
    if not executable or pathlib.Path(executable).name != executable or not (app / executable).is_file():
        raise ValueError('executable')
except Exception:
    print('Expected a completed app.zorid.notes.dev iPhoneOS development app in this output directory.', file=sys.stderr)
    sys.exit(1)
PY
if [[ "$ACTION" == install ]]; then
  xcrun devicectl device install app --device "$IOS_DEVICE_ID" "$APP"
  printf '%s\n' 'Development install command succeeded; launch remains a separate explicit action.'
else
  xcrun devicectl device process launch --device "$IOS_DEVICE_ID" app.zorid.notes.dev
  printf '%s\n' 'Development launch command succeeded; verify app behavior on the iPhone.'
fi
