#!/bin/bash
# Actual Foundation-only transport state; no UIKit build, vault or Simulator.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
fixture_dir="$(mktemp -d /private/tmp/zorid-editor-state.XXXXXX)"
trap 'rm -rf -- "$fixture_dir"' EXIT
python3 - "$repo_dir" "$fixture_dir" <<'PY_SOURCE'
from pathlib import Path
import sys
repo, fixture = map(Path, sys.argv[1:])
source = (repo / 'ios/App/App/NativeKeyboardToolbar.swift').read_text()
assert source.count('struct NativeEditorState: Equatable {') == 1
start = source.index('struct NativeEditorState: Equatable {')
end = source.index('\n@MainActor', start)
actual = source[start:end]
assert 'struct NativeEditorStateValidator' in actual
harness = (repo / 'scripts/native-editor-state-harness.swift').read_text()
(fixture / 'main.swift').write_text('import Foundation\nimport CoreFoundation\n' + actual + '\n' + harness)
PY_SOURCE
swiftc -module-cache-path "$fixture_dir/module-cache" "$fixture_dir/main.swift" -o "$fixture_dir/state"
"$fixture_dir/state"
