#!/usr/bin/env python3
"""Bounded macOS host checks of the actual root NewNote glue, with UI/transport fakes.

Generated source, binary and logs live in the supplied persistent evidence folder.
This does not test UIKit, the Rust transport, or repeat the helper contract suite.
"""
from pathlib import Path
import argparse
import hashlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--evidence-dir', type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
out = args.evidence_dir.resolve()
out.mkdir(parents=True, exist_ok=True)
root = (repo / 'ios/App/App/NativeMobile.swift').read_text()
start = root.index('    private final class NewNoteReservation {')
end = root.index('    private var routeHistories:', start)
glue = root[start:end]
# Factory alert presentation is a UIKit boundary, outside this root state-machine
# check. Omit exactly that declaration range, retaining all create/inspect/finish.
if '    private var pendingFactoryNewNoteRecovery:' in glue:
    ui_start = glue.index('    private var pendingFactoryNewNoteRecovery:')
    ui_end = glue.index('    private func inspectNewNote(', ui_start)
    glue = glue[:ui_start] + glue[ui_end:]
model = (repo / 'ios/App/App/NativeDocumentTabs.swift').read_text()
stubs = (repo / 'scripts/native-new-note-ui-harness.swift').read_text()
# Exact production model, including real Combine, tickets and metadata encoding.
# Exact production root block; surrounding UIKit root state is replaced below.
source = model + '\n' + stubs.replace('// INSERT ACTUAL ROOT GLUE', glue)
generated = out / 'ActualNativeNewNoteUI.swift'
generated.write_text(source)
(out / 'source-provenance.txt').write_text(
    'NativeMobile NewNote block sha256: ' + hashlib.sha256(glue.encode()).hexdigest() + '\n'
    'NativeDocumentTabs sha256: ' + hashlib.sha256(model.encode()).hexdigest() + '\n'
    'Boundary substitutes: Pages, helper, binding, coordinator, metadata-store IO.\n'
    'Not tested: UIKit, real helper/transport, Rust, device runtime.\n')
binary = out / 'native-new-note-ui-host'
compile_result = subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(out / 'module-cache'), str(generated), '-o', str(binary)], text=True, capture_output=True)
(out / 'compile.log').write_text(compile_result.stdout + compile_result.stderr)
if compile_result.returncode:
    print(compile_result.stdout + compile_result.stderr)
    raise SystemExit(compile_result.returncode)
run = subprocess.run([str(binary)], text=True, capture_output=True)
(out / 'checks.log').write_text(run.stdout + run.stderr)
print(run.stdout + run.stderr)
raise SystemExit(run.returncode)
