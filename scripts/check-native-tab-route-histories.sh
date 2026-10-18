#!/bin/bash
# Foundation-only actual-source proof. No UIKit/iOS SDK, host, lease, or storage.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
fixture_dir="$(mktemp -d /private/tmp/zorid-tab-route-histories.XXXXXX)"
trap 'rm -rf -- "$fixture_dir"' EXIT
cat "$repo_dir/ios/App/App/NativeRouteHistory.swift" "$repo_dir/scripts/native-tab-route-histories-harness.swift" > "$fixture_dir/ActualTabRouteHistories.swift"
swiftc -parse-as-library -module-cache-path "$fixture_dir/module-cache" "$fixture_dir/ActualTabRouteHistories.swift" -o "$fixture_dir/tab-route-histories"
"$fixture_dir/tab-route-histories"
