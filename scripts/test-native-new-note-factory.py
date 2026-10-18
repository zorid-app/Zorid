#!/usr/bin/env python3
"""Bounded host checks of extracted production factory NewNote methods.

The helper and session are controllable boundary doubles. This verifies callback
ordering and retained factory ownership, not real UIKit, helper, Rust or iOS.
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
production = (repo / 'ios/App/App/NativeTabDestinationFactory.swift').read_text()

def section(start, end):
    first = production.index(start)
    return production[first:production.index(end, first)]

parts = [
    section('    private enum Failure:', '    private let resolveVault:'),
    section('    private func inspectNewNote(', '    private func installContainer('),
    section('    func recoverReservation(', '    private func closeContainer('),
    section('    private func settleRecovery(', '\n}\n\n@MainActor'),
]
glue = '\n'.join(parts)
prepare = section('    func prepare(', '    private func inspectNewNote(')
assert '.create(' not in glue and 'helper.execute(.inspectPending)' in glue
assert prepare.index('inspectNewNote(') < prepare.index('installContainer(')
fixture = (repo / 'scripts/native-new-note-factory-harness.swift').read_text()
source = fixture.replace('// INSERT ACTUAL FACTORY METHODS', glue)
generated = out / 'ActualNativeNewNoteFactory.swift'
generated.write_text(source)
(out / 'source-provenance.txt').write_text(
    'NativeTabDestinationFactory.swift sha256: ' + hashlib.sha256(production.encode()).hexdigest() + '\n'
    'Extracted production method blocks sha256: ' + hashlib.sha256(glue.encode()).hexdigest() + '\n'
    'Actual blocks: Failure + Reservation declarations; inspectNewNote; recoverNewNote; recoverReservation; cleanup; settleRecovery; deliver; retire.\n'
    'Boundary doubles: helper, admission binding, session, UIViewController/editor, model tab, unused editor-close path.\n'
    'Static admission assertion: inspect before install; no create dispatch in extracted methods.\n'
    'Not tested: full factory typing, UIKit lifecycle/presentation, real helper/transport, Rust, device.\n')
binary = out / 'native-new-note-factory-host'
compiled = subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(out / 'module-cache'), str(generated), '-o', str(binary)], text=True, capture_output=True)
(out / 'compile.log').write_text(compiled.stdout + compiled.stderr)
if compiled.returncode:
    print(compiled.stdout + compiled.stderr)
    raise SystemExit(compiled.returncode)
run = subprocess.run([str(binary)], text=True, capture_output=True)
(out / 'checks.log').write_text(run.stdout + run.stderr)
print(run.stdout + run.stderr)
raise SystemExit(run.returncode)
