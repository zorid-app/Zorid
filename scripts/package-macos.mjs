import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageDesktop } from './stage-desktop.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(argument => argument !== '--');
try {
  if (process.platform !== 'darwin') throw new Error('macOS packaging must run on macOS');
  if (args.some(argument => !['--unsigned', '--arm64', '--x64', '--dir'].includes(argument))) throw new Error('Expected only --arm64 or --x64, and optional --dir');
  if (args.includes('--arm64') && args.includes('--x64')) throw new Error('Build one architecture per invocation');
  const unsigned = args.includes('--unsigned');
  if (!unsigned && (!process.env.CSC_NAME?.trim() || process.env.CSC_NAME.trim() === '-' || !process.env.CSC_KEYCHAIN?.trim())) throw new Error('Signed packaging requires a non-ad-hoc CSC_NAME and an explicit CSC_KEYCHAIN');
  if (!unsigned && process.env.CSC_LINK) throw new Error('CSC_LINK conflicts with the explicit release keychain');
  const environment = { ...process.env, ZORID_UNSIGNED_BUILD: unsigned ? '1' : '0' };
  if (unsigned) {
    environment.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'CSC_KEYCHAIN']) delete environment[name];
  }
  const architecture = args.find(argument => ['--arm64', '--x64'].includes(argument)) ?? `--${process.arch}`;
  if (!['--arm64', '--x64'].includes(architecture)) throw new Error('Only arm64 and x64 macOS releases are supported');
  await stageDesktop(root);
  const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'electron-builder.cjs', '--mac', '--publish', 'never', architecture, ...(args.includes('--dir') ? ['--dir'] : [])], { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
