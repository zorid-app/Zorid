#!/bin/bash
# Bounded macOS Foundation/Combine proof. No iOS SDK, Xcode build or Simulator.
# The only source substitution redirects Foundation's app-support lookup into
# a task fixture. All production store validation/FD/durability logic is actual.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
fixture_dir="$(mktemp -d /private/tmp/zorid-scoped-tabs.XXXXXX)"
trap 'rm -rf -- "$fixture_dir"' EXIT
python3 - "$repo_dir" "$fixture_dir" <<'PY'
from pathlib import Path
import sys
repo, fixture = map(Path, sys.argv[1:])
model = (repo / 'ios/App/App/NativeDocumentTabs.swift').read_text()
store = (repo / 'ios/App/App/NativeTabMetadataStore.swift').read_text()
lookup = 'FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first'
boundary = 'URL(fileURLWithPath: ProcessInfo.processInfo.environment["ZORID_SCOPED_TABS_FIXTURE"]!, isDirectory: true).appendingPathComponent("Library/Application Support", isDirectory: true) as URL?'
assert store.count(lookup) == 1, 'Production lookup changed; re-review fixture boundary'
store = store.replace(lookup, '(' + boundary + ')', 1)
harness = (repo / 'scripts/native-document-tabs-scoped-harness.swift').read_text()
(fixture / 'ActualScopedTabs.swift').write_text(model + '\n' + store + '\n' + harness)
PY
swiftc -parse-as-library -module-cache-path "$fixture_dir/module-cache" "$fixture_dir/ActualScopedTabs.swift" -o "$fixture_dir/scoped-tabs"
ZORID_SCOPED_TABS_FIXTURE="$fixture_dir" "$fixture_dir/scoped-tabs"
