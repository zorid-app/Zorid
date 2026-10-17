import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: generate-proto.mjs [--check]');
const output = mkdtempSync(join(tmpdir(), 'zorid-proto-generate-'));
const paths = ['crates/zorid-proto/src/generated', 'src/generated/zorid'];
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
try {
  const result = spawnSync('cargo', ['run', '--locked', '--manifest-path', join(root, 'tools/proto-codegen/Cargo.toml'), '--', output], {
    cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_BUILD_JOBS: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else if (check) {
    for (const path of paths) {
      const generated = files(join(output, path)).map(file => relative(output, file)).sort();
      const checkedIn = files(join(root, path)).map(file => relative(root, file)).sort();
      if (JSON.stringify(generated) !== JSON.stringify(checkedIn)) throw new Error(`Generated file list differs: ${path}`);
      for (const file of generated) {
        if (!readFileSync(join(output, file)).equals(readFileSync(join(root, file)))) throw new Error(`Stale generated file: ${file}`);
      }
    }
    console.log('Protobuf generated sources match checked-in sources.');
  } else {
    for (const path of paths) {
      // Only these generated subtrees are owned by this generator.
      rmSync(join(root, path), { recursive: true, force: true });
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(output, path), join(root, path), { recursive: true });
    }
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
