import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { electronExecutable, electronPackage, macRuntimeArchitecture, regularRuntimeFile, verifyElectronRuntime, verifyRuntimeDirectories } from './electron-runtime.mjs';

export async function installElectron(root, { architecture = process.arch, platform = process.platform, environment = process.env, run = spawnSync } = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(architecture)) throw new Error('Desktop bootstrap supports macOS arm64 or x64');
  if (environment.ELECTRON_OVERRIDE_DIST_PATH) throw new Error('ELECTRON_OVERRIDE_DIST_PATH is unsupported; install the pinned project runtime');
  for (const [name, value] of Object.entries(environment)) {
    if (value && /^(electron|npmconfigelectron|npmpackageconfigelectron)(mirror|nightlymirror|customdir|customfilename|customversion)$/.test(name.replaceAll('_', '').toLowerCase())) {
      throw new Error('Electron download mirror/version overrides are unsupported; install the official pinned runtime');
    }
  }
  const pkg = await electronPackage(root);
  const dist = path.join(pkg.directory, 'dist');
  for (const filename of ['path.txt', 'dist/version', 'dist/LICENSE', 'dist/LICENSES.chromium.html']) {
    try { await regularRuntimeFile(path.join(pkg.directory, filename)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    await verifyRuntimeDirectories(dist);
    // The upstream installer's same-version fast path does not check CPU type.
    const installedArchitecture = await macRuntimeArchitecture(path.join(dist, electronExecutable));
    if (installedArchitecture !== architecture) throw new Error(`Installed Electron architecture is ${installedArchitecture}, expected ${architecture}; use a separate dependency installation for each architecture`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const installer = path.join(pkg.directory, 'install.js');
  await regularRuntimeFile(installer);
  const result = run(process.execPath, [installer], {
    cwd: root, stdio: 'inherit',
    env: {
      ...environment,
      ELECTRON_INSTALL_PLATFORM: 'darwin', ELECTRON_INSTALL_ARCH: architecture,
      // Explicit npm_config_arch also prevents the installer's Rosetta fallback.
      npm_config_platform: 'darwin', npm_config_arch: architecture,
      electron_use_remote_checksums: '', npm_config_electron_use_remote_checksums: '',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Electron installer failed (${result.status ?? result.signal ?? 'unknown'})`);
  return verifyElectronRuntime(root, architecture);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter(arg => arg !== '--');
    if (args.length > 1 || (args.length && !['--arm64', '--x64'].includes(args[0]))) throw new Error('Expected optional --arm64 or --x64');
    const root = path.resolve(import.meta.dirname, '..');
    const runtime = await installElectron(root, { architecture: args[0]?.slice(2) ?? process.arch });
    console.log(`Verified Electron ${runtime.version} macOS ${runtime.architecture} runtime and notices`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
