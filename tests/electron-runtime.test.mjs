import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installElectron } from '../scripts/install-electron.mjs';
import { electronExecutable, verifyElectronRuntime } from '../scripts/electron-runtime.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-runtime-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'node_modules/electron');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '44.8.0' } }));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '44.8.0' }));
  await fs.writeFile(path.join(directory, 'install.js'), '// original inert installer fixture');
  function distribution(architecture = 'arm64') {
    const executable = Buffer.alloc(8); executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4);
    for (const [name, contents] of Object.entries({ 'path.txt': electronExecutable, 'dist/version': '44.8.0', 'dist/LICENSE': 'new Electron fixture notice', 'dist/LICENSES.chromium.html': 'new Chromium fixture notices', [`dist/${electronExecutable}`]: executable })) {
      const target = path.join(directory, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, contents);
    }
  }
  return { root, directory, distribution };
}

test('explicit bootstrap pins requested x64 on Rosetta and verifies installed runtime/notices', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyElectronRuntime(f.root), { code: 'ENOENT' });
  let calls = 0;
  const runtime = await installElectron(f.root, {
    platform: 'darwin', architecture: 'x64', environment: { ELECTRON_INSTALL_ARCH: 'arm64', npm_config_arch: 'arm64', electron_use_remote_checksums: '1', npm_config_electron_use_remote_checksums: '1' },
    run(command, args, options) {
      calls++;
      assert.equal(command, process.execPath); assert.deepEqual(args, [path.join(f.directory, 'install.js')]);
      assert.equal(options.env.ELECTRON_INSTALL_ARCH, 'x64'); assert.equal(options.env.npm_config_arch, 'x64');
      assert.equal(options.env.ELECTRON_INSTALL_PLATFORM, 'darwin'); assert.equal(options.env.npm_config_platform, 'darwin');
      assert.equal(options.env.electron_use_remote_checksums, ''); assert.equal(options.env.npm_config_electron_use_remote_checksums, '');
      f.distribution('x64'); return { status: 0 };
    },
  });
  assert.equal(calls, 1); assert.equal(runtime.architecture, 'x64'); assert.equal(runtime.version, '44.8.0');
  assert.equal(runtime.license.toString(), 'new Electron fixture notice');
  assert.equal(runtime.chromiumNotices.toString(), 'new Chromium fixture notices');
});

test('same-version wrong architecture cannot reuse upstream installer fast path or reach staging', async t => {
  const f = await fixture(t); f.distribution('arm64');
  let calls = 0;
  await assert.rejects(installElectron(f.root, { platform: 'darwin', architecture: 'x64', environment: {}, run: () => { calls++; return { status: 0 }; } }), /architecture is arm64, expected x64/);
  assert.equal(calls, 0);
  await assert.rejects(verifyElectronRuntime(f.root, 'x64'), /architecture is arm64, expected x64/);
});

test('bootstrap fails closed for missing output, installer failure and mismatched installed package', async t => {
  const f = await fixture(t);
  const options = { platform: 'darwin', architecture: 'arm64', environment: {} };
  await assert.rejects(installElectron(f.root, { ...options, run: () => ({ status: 1 }) }), /installer failed/);
  await assert.rejects(installElectron(f.root, { ...options, run: () => ({ status: 0 }) }), { code: 'ENOENT' });
  await fs.writeFile(path.join(f.directory, 'package.json'), JSON.stringify({ version: '31.6.0' }));
  await assert.rejects(installElectron(f.root, { ...options, run: () => assert.fail('must not run wrong installer') }), /does not match the release pin/);
});

test('runtime verification rejects mismatched version, arbitrary executable paths and symlink notices', async t => {
  const f = await fixture(t); f.distribution();
  await fs.writeFile(path.join(f.directory, 'dist/version'), '31.6.0');
  await assert.rejects(verifyElectronRuntime(f.root), /distribution does not match/);
  f.distribution(); await fs.writeFile(path.join(f.directory, 'path.txt'), '/outside/runtime');
  await assert.rejects(verifyElectronRuntime(f.root), /executable path/);
  f.distribution(); await fs.rm(path.join(f.directory, 'dist/LICENSE'));
  await fs.symlink(path.join(f.directory, 'package.json'), path.join(f.directory, 'dist/LICENSE'));
  await assert.rejects(verifyElectronRuntime(f.root), /regular file/);
});

test('bootstrap rejects distribution overrides and symlink installer before execution', async t => {
  const f = await fixture(t);
  const options = { platform: 'darwin', architecture: 'arm64', run: () => assert.fail('must not execute') };
  await assert.rejects(installElectron(f.root, { ...options, environment: { ELECTRON_OVERRIDE_DIST_PATH: '/other' } }), /unsupported/);
  for (const name of ['ELECTRON_MIRROR', 'npm_config_electron_customversion', 'NPM_CONFIG_ELECTRON_CUSTOM_FILENAME', 'npm_package_config_electron_customDir']) {
    await assert.rejects(installElectron(f.root, { ...options, environment: { [name]: 'fixture override' } }), /overrides are unsupported/);
  }
  await fs.rm(path.join(f.directory, 'install.js'));
  await fs.symlink(path.join(f.directory, 'package.json'), path.join(f.directory, 'install.js'));
  await assert.rejects(installElectron(f.root, { ...options, environment: {} }), /regular file/);
});

test('bootstrap never overwrites a symlink path marker or accepts an external app directory', async t => {
  const f = await fixture(t); f.distribution();
  const options = { platform: 'darwin', architecture: 'arm64', environment: {}, run: () => assert.fail('must not execute') };
  await fs.rm(path.join(f.directory, 'path.txt'));
  await fs.symlink(path.join(f.directory, 'package.json'), path.join(f.directory, 'path.txt'));
  await assert.rejects(installElectron(f.root, options), /regular file/);
  await fs.rm(path.join(f.directory, 'path.txt')); f.distribution();
  await fs.rename(path.join(f.directory, 'dist/Electron.app'), path.join(f.root, 'external-app'));
  await fs.symlink(path.join(f.root, 'external-app'), path.join(f.directory, 'dist/Electron.app'));
  await assert.rejects(installElectron(f.root, options), /real directories/);
  await assert.rejects(verifyElectronRuntime(f.root), /real directories/);
});
