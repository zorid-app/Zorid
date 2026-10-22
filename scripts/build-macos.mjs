import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nativeTarget } from './stage-desktop.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
}

try {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('build:mac requires an arm64 or x64 Mac');
  }
  if (process.argv.length > 2) throw new Error('Usage: pnpm build:mac');
  // Reuse the existing release cache, but let Cargo validate every source input.
  const target = path.join(root, 'target/s1-release');
  const triple = nativeTarget(process.arch);
  run(process.env.CARGO || 'cargo', ['build', '--locked', '--release', '--jobs', '1', '--target', triple, '--target-dir', target, '--package', 'zorid-desktop-host']);
  run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit']);
  run(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--mode', 'native']);
  run(process.execPath, ['scripts/package-macos.mjs', '--unsigned', '--dir', `--${process.arch}`], {
    ...process.env, ZORID_DESKTOP_HOST_BIN: path.join(target, triple, 'release/zorid-desktop-host'),
  });
  const app = path.join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Zorid.app');
  run(process.execPath, ['scripts/verify-desktop-package.mjs', app]);
  console.log(`\nBuilt local, unnotarized app: ${app}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
