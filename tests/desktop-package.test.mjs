import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { stageDesktop, desktopFiles, requiredRendererFiles, requiredRendererDirectories } from '../scripts/stage-desktop.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-package-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(relative, content = relative) {
    const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
  }
  const metadata = { name: 'zorid', version: '1.2.3', description: 'Original fixture', license: 'AGPL-3.0-only', dependencies: { 'fixture-dependency': '1.0.0' }, devDependencies: { electron: '31.6.0' } };
  await write('package.json', JSON.stringify(metadata));
  for (const file of [...desktopFiles, ...requiredRendererFiles, 'LICENSE', 'dist/main.123abc.js', 'dist/main.123abc.js.LICENSE.txt']) await write(file);
  for (const directory of requiredRendererDirectories) await write(`${directory}fixture.js`);
  await write('dist/main.123abc.js.map'); await write('src/private-source.ts'); await write('.env'); await write('recovered/reference.js'); await write('vault/private.md');
  await write('node_modules/fixture-dependency/package.json', JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', license: 'MIT' }));
  await write('node_modules/fixture-dependency/LICENSE', 'Original fixture dependency notice');
  await write('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '31.6.0' }));
  await write('node_modules/electron/dist/version', '31.6.0');
  await write('node_modules/electron/dist/LICENSE', 'Electron fixture license');
  await write('node_modules/electron/dist/LICENSES.chromium.html', 'Chromium fixture notices');
  return { root, write, metadata };
}

test('desktop staging includes runtime assets/notices and excludes source, maps, vaults and dependencies', async t => {
  const f = await fixture(t), result = await stageDesktop(f.root);
  const inputs = JSON.parse(await fs.readFile(result.inputManifest));
  assert.ok(inputs.files['dist/main.123abc.js.LICENSE.txt']);
  assert.ok(inputs.files['dist/lib/pdfjs/build/pdf.worker.mjs']);
  assert.ok(inputs.files['licenses/electron/LICENSES.chromium.html']);
  assert.ok(inputs.files['THIRD_PARTY_NOTICES.txt']);
  assert.equal(Object.keys(inputs.files).some(file => /node_modules|\.map$|^src\/|^vault\/|^recovered\/|^\.env/.test(file)), false);
  const pkg = JSON.parse(await fs.readFile(path.join(result.appDirectory, 'package.json')));
  assert.equal(pkg.license, 'AGPL-3.0-only'); assert.equal(pkg.version, '1.2.3'); assert.equal(pkg.dependencies, undefined);
  const notices = await fs.readFile(path.join(result.appDirectory, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /fixture-dependency@1.0.0/); assert.match(notices, /Original fixture dependency notice/);
  await f.write('.release/app/stale.js');
  const before = await fs.readFile(result.inputManifest, 'utf8'); await stageDesktop(f.root);
  assert.equal(await fs.readFile(result.inputManifest, 'utf8'), before);
  await assert.rejects(fs.access(path.join(result.appDirectory, 'stale.js')));
});

test('staging rejects incomplete renderer output and mismatched downloaded Electron', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.root, 'dist/lib/pdfjs/build/pdf.worker.mjs'));
  await assert.rejects(stageDesktop(f.root), /Missing built renderer asset/);
  await f.write('dist/lib/pdfjs/build/pdf.worker.mjs');
  await f.write('node_modules/electron/dist/version', '99.0.0');
  await assert.rejects(stageDesktop(f.root), /distribution does not match/);
});

test('staging rejects symlinked inputs and output directories before copying', async t => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.root, 'vault/private.md'), path.join(f.root, 'dist/leak.txt'));
  await assert.rejects(stageDesktop(f.root), /must not be symlinks/);
  await fs.rm(path.join(f.root, 'dist/leak.txt'));
  await fs.symlink(path.join(f.root, 'vault'), path.join(f.root, '.release'));
  await assert.rejects(stageDesktop(f.root), /staging directory must not be a symlink/);
  assert.equal(await fs.readFile(path.join(f.root, 'vault/private.md'), 'utf8'), 'vault/private.md');
});

test('staging rejects newly introduced dependencies without distribution notice text', async t => {
  const f = await fixture(t); await fs.rm(path.join(f.root, 'node_modules/fixture-dependency/LICENSE'));
  await assert.rejects(stageDesktop(f.root), /No distribution license text found/);
  await fs.symlink(path.join(f.root, 'vault/private.md'), path.join(f.root, 'node_modules/fixture-dependency/LICENSE'));
  await assert.rejects(stageDesktop(f.root), /notice must be a regular file/);
});

test('staging never overwrites a symlinked input manifest or reads symlinked Electron version data', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, '.release'));
  await fs.symlink(path.join(f.root, 'vault/private.md'), path.join(f.root, '.release/inputs.json'));
  await assert.rejects(stageDesktop(f.root), /input manifest must be a regular file/);
  assert.equal(await fs.readFile(path.join(f.root, 'vault/private.md'), 'utf8'), 'vault/private.md');
  await fs.rm(path.join(f.root, '.release/inputs.json'));
  await fs.rm(path.join(f.root, 'node_modules/electron/dist/version'));
  await fs.symlink(path.join(f.root, 'vault/private.md'), path.join(f.root, 'node_modules/electron/dist/version'));
  await assert.rejects(stageDesktop(f.root), /notice must be a regular file/);
});

test('staging rejects extra files outside the compiled chunk and vendor asset allowlist', async t => {
  const f = await fixture(t); await f.write('dist/notes/private.md');
  await assert.rejects(stageDesktop(f.root), /Unexpected renderer output/);
  await fs.rm(path.join(f.root, 'dist/notes'), { recursive: true });
  await f.write('dist/lib/pdfjs/signing.p12');
  await assert.rejects(stageDesktop(f.root), /Unexpected renderer output/);
});

test('ASAR verifier checks exact inventory and content, not just file existence', async t => {
  const { createPackage, uncacheAll } = await import('@electron/asar');
  const { verifyDesktopArchive } = await import('../scripts/verify-desktop-package.mjs');
  const f = await fixture(t), staged = await stageDesktop(f.root), archive = path.join(f.root, 'app.asar');
  await createPackage(staged.appDirectory, archive);
  assert.equal((await verifyDesktopArchive(archive, staged.inputManifest)).fileCount, staged.fileCount);
  const packagePath = path.join(staged.appDirectory, 'package.json'), originalPackage = await fs.readFile(packagePath, 'utf8');
  const metadata = JSON.parse(originalPackage); metadata.license = 'changed';
  await fs.writeFile(packagePath, JSON.stringify(metadata));
  uncacheAll(); await createPackage(staged.appDirectory, archive); uncacheAll();
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest), /metadata differs/);
  await fs.writeFile(packagePath, originalPackage);
  await fs.writeFile(path.join(staged.appDirectory, 'desktop/main.cjs'), 'changed');
  uncacheAll(); await createPackage(staged.appDirectory, archive); uncacheAll();
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest), /content mismatch/);
  await fs.writeFile(path.join(staged.appDirectory, 'unexpected.txt'), 'extra');
  uncacheAll(); await createPackage(staged.appDirectory, archive); uncacheAll();
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest), /inventory/);
});

test('signed packaging configuration is the default and unsigned mode is explicit', () => {
  const config = path.resolve(import.meta.dirname, '../electron-builder.cjs');
  const inspect = 'const c=require(process.argv[1]);console.log(JSON.stringify({force:c.forceCodeSigning,identity:c.mac.identity,type:c.mac.type,hardened:c.mac.hardenedRuntime,notarize:c.mac.notarize,dmgSign:c.dmg.sign,appId:c.appId}))';
  const run = unsigned => JSON.parse(spawnSync(process.execPath, ['-e', inspect, config], { env: { ...process.env, ZORID_UNSIGNED_BUILD: unsigned, CSC_NAME: 'fixture identity', CSC_KEYCHAIN: '/fixture/release.keychain-db', CSC_LINK: '' }, encoding: 'utf8' }).stdout);
  assert.deepEqual(run('0'), { force: true, identity: 'fixture identity', type: 'distribution', hardened: true, notarize: false, dmgSign: true, appId: 'app.zorid.notes' });
  assert.deepEqual(run('1'), { force: false, identity: null, type: 'distribution', hardened: false, notarize: false, dmgSign: false, appId: 'app.zorid.notes' });
  const rejected = spawnSync(process.execPath, ['-e', inspect, config], { env: { ...process.env, ZORID_UNSIGNED_BUILD: '0', CSC_NAME: '', CSC_KEYCHAIN: '' }, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Signed packaging requires/);
  for (const identity of ['-', ' - ', '   ']) {
    const result = spawnSync(process.execPath, ['-e', inspect, config], { env: { ...process.env, ZORID_UNSIGNED_BUILD: '0', CSC_NAME: identity, CSC_KEYCHAIN: '/fixture/release.keychain-db' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Signed packaging requires/);
  }
  const conflicting = spawnSync(process.execPath, ['-e', inspect, config], { env: { ...process.env, ZORID_UNSIGNED_BUILD: '0', CSC_NAME: 'fixture identity', CSC_KEYCHAIN: '/fixture/release.keychain-db', CSC_LINK: '/fixture/certificate.p12' }, encoding: 'utf8' });
  assert.notEqual(conflicting.status, 0); assert.match(conflicting.stderr, /conflicts with the explicit/);
});

test('builder dependency collector excludes project dependencies after staged app fallback', async t => {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const { FileMatcher, getNodeModuleFileMatcher } = builderRequire('app-builder-lib/out/fileMatcher.js');
  const { NodeModuleCopyHelper } = builderRequire('app-builder-lib/out/util/NodeModuleCopyHelper.js');
  const f = await fixture(t);
  await f.write('node_modules/fixture-dependency/index.js', 'module.exports = {};');
  await f.write('node_modules/fixture-dependency/native/binding.node', 'original fixture');
  const configFile = path.resolve(import.meta.dirname, '../electron-builder.cjs');
  const configResult = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1])))', configFile], {
    env: { ...process.env, ZORID_UNSIGNED_BUILD: '1' }, encoding: 'utf8',
  });
  assert.equal(configResult.status, 0, configResult.stderr);
  const config = JSON.parse(configResult.stdout);
  const staged = await stageDesktop(f.root);
  const destination = path.join(f.root, 'output');
  const packager = { config, appInfo: { type: 'commonjs' }, getWorkspaceRoot: async () => f.root };
  async function collect(patterns) {
    const dependencyMatcher = getNodeModuleFileMatcher(staged.appDirectory, destination, value => value, {}, { config: { files: patterns }, debugLogger: { isEnabled: false } });
    const source = path.join(f.root, 'node_modules/fixture-dependency');
    const matcher = new FileMatcher(source, path.join(destination, 'node_modules/fixture-dependency'), value => value, dependencyMatcher.patterns);
    return new NodeModuleCopyHelper(matcher, packager).collectNodeModules(
      { name: 'fixture-dependency', dir: source }, [], 'node_modules/fixture-dependency',
    );
  }
  assert.ok((await collect(['**/*'])).some(file => file.endsWith('binding.node')), 'control reproduces unwanted native dependency collection');
  assert.deepEqual(await collect(config.files), []);
  const runtimeFilter = new FileMatcher(staged.appDirectory, destination, value => value, config.files).createFilter();
  const runtimeFile = path.join(staged.appDirectory, 'desktop/main.cjs');
  assert.equal(runtimeFilter(runtimeFile, await fs.stat(runtimeFile)), true);
});
