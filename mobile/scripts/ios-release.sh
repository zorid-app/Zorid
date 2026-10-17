#!/bin/bash
set +x
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ROOT="$(pwd -P)"
MODE="${1:-export}"
case "$MODE" in export|upload) ;; *) printf '%s\n' 'Usage: ios-release.sh [export|upload]' >&2; exit 1 ;; esac
[[ "$(uname -s)" == Darwin ]] || { echo 'Signing requires macOS and full Xcode.' >&2; exit 1; }
: "${IOS_TEAM_ID:?Missing IOS_TEAM_ID}"
: "${IOS_BUILD_NUMBER:?Missing IOS_BUILD_NUMBER}"
umask 077
SIGNING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zorid-ios-signing.XXXXXX")"
cleanup() {
  result=$?
  trap - EXIT INT TERM
  python3 "$ROOT/mobile/scripts/ios-signing.py" cleanup "$SIGNING_DIR" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
SIGNING_DIR="$(cd "$SIGNING_DIR" && pwd -P)"
case "$SIGNING_DIR/" in "$ROOT/"*) echo 'Temporary signing storage must be outside the repository.' >&2; exit 1 ;; esac
export IOS_OUTPUT_DIR="${IOS_OUTPUT_DIR:-${TMPDIR:-/tmp}/zorid-ios-output}"
# Validate upload inputs before spending time on an archive.
if [[ "$MODE" == upload ]]; then
  : "${ASC_API_KEY_ID:?Missing ASC_API_KEY_ID}"
  : "${ASC_API_ISSUER_ID:?Missing ASC_API_ISSUER_ID}"
  python3 mobile/scripts/ios-signing.py upload-key "$SIGNING_DIR"
fi
python3 mobile/scripts/ios-signing.py prepare "$SIGNING_DIR"
export IOS_PROFILE_UUID="$(cat "$SIGNING_DIR/profile-uuid")"
export IOS_SIGNING_IDENTITY="$(cat "$SIGNING_DIR/signing-identity")"
# Do not propagate raw signing/API secrets into webpack, Cargo or Xcode children.
unset IOS_DISTRIBUTION_P12_BASE64 IOS_DISTRIBUTION_P12_PASSWORD IOS_PROVISION_PROFILE_BASE64 ASC_API_PRIVATE_KEY_BASE64
unset IOS_DISTRIBUTION_P12_PATH IOS_PROVISION_PROFILE_PATH ASC_API_PRIVATE_KEY_PATH
bash mobile/scripts/ios-build.sh device
xcrun xcodebuild -exportArchive -archivePath "$IOS_OUTPUT_DIR/App.xcarchive" -exportPath "$IOS_OUTPUT_DIR/ipa" -exportOptionsPlist "$SIGNING_DIR/ExportOptions.plist"
shopt -s nullglob
IPAS=("$IOS_OUTPUT_DIR/ipa/"*.ipa)
[[ ${#IPAS[@]} -eq 1 ]] || { echo 'Expected exactly one exported IPA.' >&2; exit 1; }
if [[ "$MODE" == upload ]]; then
  # altool searches API_PRIVATE_KEYS_DIR for AuthKey_<id>.p8; never copy to ~/.appstoreconnect.
  API_PRIVATE_KEYS_DIR="$SIGNING_DIR/private_keys" xcrun altool --upload-app --type ios --file "${IPAS[0]}" --apiKey "$ASC_API_KEY_ID" --apiIssuer "$ASC_API_ISSUER_ID"
  printf '%s\n' 'Upload command succeeded. App Store Connect processing/TestFlight availability still requires confirmation.'
else
  printf 'Exported IPA: %s\n' "${IPAS[0]}"
fi
