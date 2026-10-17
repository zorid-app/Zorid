import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { stageDesktop, desktopFiles, requiredRendererFiles, requiredRendererDirectories, nativeTarget } from '../scripts/stage-desktop.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-package-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(relative, content = relative) {
    const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
  }
  const metadata = { name: 'zorid', version: '1.2.3', description: 'Original fixture', license: 'AGPL-3.0-only', dependencies: { 'fixture-dependency': '1.0.0' }, devDependencies: { electron: '44.8.0' } };
  await write('package.json', JSON.stringify(metadata));
  for (const file of [...desktopFiles, ...requiredRendererFiles, 'LICENSE', 'dist/assets/index-AbCd_12-.js', 'dist/assets/index-BcDe_23-.css',
    'dist/assets/browser-core-worker-CdEf_34-.js', 'dist/assets/lazy-note-DeFg_45-.js']) await write(file);
  await write('dist/index.html', '<!doctype html><html><head><link rel="stylesheet" href="./assets/index-BcDe_23-.css"><link rel="modulepreload" href="./assets/lazy-note-DeFg_45-.js"></head><body><script type="module" crossorigin src="./assets/index-AbCd_12-.js"></script></body></html>');
  for (const directory of requiredRendererDirectories) await write(`${directory}fixture.js`);
  await write('dist/assets/index-AbCd_12-.js.map'); await write('src/private-source.ts'); await write('.env'); await write('recovered/reference.js'); await write('vault/private.md');
  await write('node_modules/fixture-dependency/package.json', JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', license: 'MIT' }));
  await write('node_modules/fixture-dependency/LICENSE', 'Original fixture dependency notice');
  await write('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '44.8.0' }));
  await write('node_modules/electron/dist/version', '44.8.0');
  await write('node_modules/electron/path.txt', 'Electron.app/Contents/MacOS/Electron');
  const executable = Buffer.alloc(8); executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(0x0100000c, 4);
  await write('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', executable);
  await write('node_modules/electron/dist/LICENSE', 'Electron fixture license');
  await write('node_modules/electron/dist/LICENSES.chromium.html', 'Chromium fixture notices');
  const hostRelative = `target/${nativeTarget(process.arch)}/release/zorid-desktop-host`;
  const host = Buffer.alloc(64); host.writeUInt32LE(0xfeedfacf, 0);
  host.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  host.writeUInt32LE(2, 12); // MH_EXECUTE, never a script or shared library.
  await write(hostRelative, host); await fs.chmod(path.join(root, hostRelative), 0o755);
  return { root, write, metadata, hostRelative, host };
}

test('desktop staging includes runtime assets/notices and excludes source, maps, vaults and dependencies', async t => {
  const f = await fixture(t), result = await stageDesktop(f.root);
  const inputs = JSON.parse(await fs.readFile(result.inputManifest));
  assert.ok(inputs.files['desktop/menu-hotkeys.cjs']);
  for (const module of ['editor-core', 'host-location', 'client-slots', 'rust-vault-service', 'durable-checkpoints', 'durable-writes', 'document-semantics']) assert.ok(inputs.files[`desktop/${module}.cjs`]);
  assert.equal(inputs.native.architecture, process.arch);
  assert.equal(inputs.native.resource, 'native/zorid-desktop-host');
  assert.equal(inputs.native.signed, undefined);
  assert.deepEqual(await fs.readFile(path.join(f.root, '.release/native/zorid-desktop-host')), f.host);
  assert.ok((await fs.stat(path.join(f.root, '.release/native/zorid-desktop-host'))).mode & 0o111);
  assert.ok(!inputs.files['native/zorid-desktop-host'], 'native executable lives outside ASAR');
  for (const file of ['index-AbCd_12-.js', 'index-BcDe_23-.css', 'browser-core-worker-CdEf_34-.js', 'lazy-note-DeFg_45-.js']) assert.ok(inputs.files[`dist/assets/${file}`]);
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

test('staging requires every actual HTML entry, stylesheet and module-preload reference', async t => {
  const f = await fixture(t);
  for (const filename of ['index-AbCd_12-.js', 'index-BcDe_23-.css', 'lazy-note-DeFg_45-.js']) {
    const relative = `dist/assets/${filename}`, bytes = await fs.readFile(path.join(f.root, relative));
    await fs.rm(path.join(f.root, relative));
    await assert.rejects(stageDesktop(f.root), /Missing HTML-referenced renderer asset/);
    await f.write(relative, bytes);
  }
  const html = await fs.readFile(path.join(f.root, 'dist/index.html'), 'utf8');
  await f.write('dist/index.html', html.replace('rel="modulepreload"', 'rel="alternate modulepreload"'));
  await fs.rm(path.join(f.root, 'dist/assets/lazy-note-DeFg_45-.js'));
  await assert.rejects(stageDesktop(f.root), /Missing HTML-referenced renderer asset/);
});

test('staging rejects nonlocal, commented-out and missing module/style HTML bindings', async t => {
  const f = await fixture(t), script = '<script type="module" src="./assets/index-AbCd_12-.js"></script>';
  const css = '<link rel="stylesheet" href="./assets/index-BcDe_23-.css">';
  for (const html of [
    `<!-- ${script} -->${css}`,
    script,
    `${css}<script src="./assets/index-AbCd_12-.js"></script>`,
    `${css}<script type="module">import './assets/index-AbCd_12-.js';</script>`,
    `${css}<script type="module" src="/assets/index-AbCd_12-.js"></script>`,
    `${css}<script type="module" src="https://example.test/assets/index-AbCd_12-.js"></script>`,
    `${css}<script type="module" src="./assets/../assets/index-AbCd_12-.js"></script>`,
    `${css}<script type="module" src="./assets/index-AbCd_12-.js?cache=1"></script>`,
    `<base href="https://example.test/">${css}${script}`,
    `<link rel="stylesheet" href="https://example.test/assets/index-BcDe_23-.css">${script}`,
  ]) {
    await f.write('dist/index.html', html);
    await assert.rejects(stageDesktop(f.root), /Built renderer HTML|Invalid local renderer reference/);
  }
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
  await assert.rejects(stageDesktop(f.root), /must be a regular file/);
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
  await assert.rejects(stageDesktop(f.root), /must be a regular file/);
});

test('staging rejects extra files outside the compiled chunk and vendor asset allowlist', async t => {
  const f = await fixture(t); await f.write('dist/notes/private.md');
  await assert.rejects(stageDesktop(f.root), /Unexpected renderer output/);
  await fs.rm(path.join(f.root, 'dist/notes'), { recursive: true });
  await f.write('dist/lib/pdfjs/signing.p12');
  await assert.rejects(stageDesktop(f.root), /Unexpected renderer output/);
});

test('staging permits only flat hashed JavaScript and CSS assets', async t => {
  const f = await fixture(t);
  for (const relative of ['dist/main.123abc.js', 'dist/assets/unhashed.js', 'dist/assets/index-AbCd_12-.txt',
    'dist/assets/notes/private-AbCd_12-.js', 'dist/assets/private.md', 'dist/assets/source.ts']) {
    await f.write(relative);
    await assert.rejects(stageDesktop(f.root), /Unexpected renderer output/);
    await fs.rm(path.join(f.root, relative));
  }
});

test('ASAR verifier checks exact inventory and content, not just file existence', async t => {
  const { createPackage, uncacheAll } = await import('@electron/asar');
  const { verifyDesktopArchive } = await import('../scripts/verify-desktop-package.mjs');
  const f = await fixture(t), staged = await stageDesktop(f.root), archive = path.join(f.root, 'app.asar');
  await fs.cp(path.join(f.root, '.release/native'), path.join(f.root, 'native'), { recursive: true });
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
  assert.deepEqual(config.extraResources, [{ from: '.release/native', to: 'native', filter: ['zorid-desktop-host'] }]);
  assert.deepEqual(config.mac.binaries, ['Contents/Resources/native/zorid-desktop-host']);
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


test('native host input fails closed on missing, wrong-architecture, script, symlink or non-executable files', async t => {
  const f = await fixture(t), filename = path.join(f.root, f.hostRelative);
  await fs.rm(filename);
  await assert.rejects(stageDesktop(f.root), { code: 'ENOENT' });
  const wrong = Buffer.from(f.host); wrong.writeUInt32LE(process.arch === 'arm64' ? 0x01000007 : 0x0100000c, 4);
  await f.write(f.hostRelative, wrong); await fs.chmod(filename, 0o755);
  await assert.rejects(stageDesktop(f.root), /architecture does not match/);
  await f.write(f.hostRelative, Buffer.alloc(64));
  await assert.rejects(stageDesktop(f.root), /Mach-O executable/);
  await f.write(f.hostRelative, f.host); await fs.chmod(filename, 0o644);
  await assert.rejects(stageDesktop(f.root), /regular executable/);
  await fs.rm(filename); await fs.symlink(path.join(f.root, 'vault/private.md'), filename);
  await assert.rejects(stageDesktop(f.root), /regular executable/);
  await assert.rejects(stageDesktop(f.root, { architecture: 'universal' }), /Only arm64 and x64/);
});

test('native target selection supports explicit cross-architecture input and rejects a mismatched target', async t => {
  const f = await fixture(t), alternate = process.arch === 'arm64' ? 'x64' : 'arm64';
  const host = Buffer.from(f.host); host.writeUInt32LE(alternate === 'arm64' ? 0x0100000c : 0x01000007, 4);
  const relative = `target/${nativeTarget(alternate)}/release/zorid-desktop-host`;
  await f.write(relative, host); await fs.chmod(path.join(f.root, relative), 0o755);
  const staged = await stageDesktop(f.root, { architecture: alternate });
  assert.equal(JSON.parse(await fs.readFile(staged.inputManifest)).native.architecture, alternate);
  await assert.rejects(stageDesktop(f.root, { architecture: alternate, nativeHost: path.join(f.root, f.hostRelative) }), /architecture does not match/);
});

test('packaged external host is required and verified independently of ASAR', async t => {
  const { createPackage } = await import('@electron/asar');
  const { verifyDesktopArchive } = await import('../scripts/verify-desktop-package.mjs');
  const f = await fixture(t), staged = await stageDesktop(f.root), archive = path.join(f.root, 'app.asar');
  await createPackage(staged.appDirectory, archive);
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest), { code: 'ENOENT' });
  const directory = path.join(f.root, 'native'), host = path.join(directory, 'zorid-desktop-host');
  await fs.cp(path.join(f.root, '.release/native'), directory, { recursive: true });
  assert.equal((await verifyDesktopArchive(archive, staged.inputManifest)).nativeArchitecture, process.arch);
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest, { architecture: process.arch === 'arm64' ? 'x64' : 'arm64' }), /target architecture mismatch/);
  const changed = Buffer.from(f.host); changed[63] ^= 1; await fs.writeFile(host, changed);
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest), /native host content mismatch/);
  await fs.writeFile(host, f.host); await fs.chmod(host, 0o644);
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest), /regular executable/);
  await fs.chmod(host, 0o755); await fs.writeFile(path.join(directory, 'unexpected'), 'not allowed');
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest), /resource inventory/);
});

test('runtime allowlist covers each desktop CommonJS module and its local dependencies', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  for (const name of await fs.readdir(path.join(root, 'desktop'))) {
    if (!name.endsWith('.cjs')) continue;
    assert.ok(desktopFiles.includes(`desktop/${name}`), `unstaged runtime module ${name}`);
    const source = await fs.readFile(path.join(root, 'desktop', name), 'utf8');
    for (const [, dependency] of source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
      assert.ok(desktopFiles.includes(path.posix.join('desktop', dependency)), `unstaged dependency ${dependency} from ${name}`);
    }
  }
});


test('signed native host preserves source provenance and requires verified final bytes', async t => {
  const { createPackage } = await import('@electron/asar');
  const { recordSignedNativeHost, verifyDesktopArchive } = await import('../scripts/verify-desktop-package.mjs');
  const f = await fixture(t), staged = await stageDesktop(f.root), archive = path.join(f.root, 'app.asar');
  await createPackage(staged.appDirectory, archive);
  await fs.cp(path.join(f.root, '.release/native'), path.join(f.root, 'native'), { recursive: true });
  const filename = path.join(f.root, 'native/zorid-desktop-host');
  const source = JSON.parse(await fs.readFile(staged.inputManifest)).native;
  const identity = 'Developer ID Application: Zorid Fixture (ABCDEFGHIJ)';
  const signature = `Authority=${identity}\nTimestamp=Oct 17, 2026\nCodeDirectory flags=0x10000(runtime)\n`;
  let details = signature, verifyStatus = 0, calls = 0;
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, '/usr/bin/codesign'); assert.equal(args.at(-1), filename); calls++;
    return { status: args[0] === '--verify' ? verifyStatus : 0, stderr: details };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await verifyDesktopArchive(archive, staged.inputManifest, { sourceOnly: true });
  assert.equal(calls, 0, 'afterPack checks exact unsigned source bytes');
  const signedBytes = Buffer.concat([f.host, Buffer.from('fixture-signature')]);
  await fs.writeFile(filename, signedBytes);
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest, { sourceOnly: true }), /content mismatch/);
  for (const invalid of [signature.replace(identity, 'other'), signature.replace('Timestamp=', 'Date='), signature.replace('runtime', 'none'), `${signature}Signature=adhoc\n`]) {
    details = invalid;
    await assert.rejects(recordSignedNativeHost(archive, staged.inputManifest, identity, process.arch));
    assert.deepEqual(JSON.parse(await fs.readFile(staged.inputManifest)).native, source, 'failed validation leaves provenance unchanged');
  }
  details = signature; verifyStatus = 1;
  await assert.rejects(recordSignedNativeHost(archive, staged.inputManifest, identity, process.arch), /signature verification failed/);
  verifyStatus = 0;
  const stagedHost = path.join(f.root, '.release/native/zorid-desktop-host');
  await fs.writeFile(stagedHost, signedBytes);
  await assert.rejects(recordSignedNativeHost(archive, staged.inputManifest, identity, process.arch), /staging input changed/);
  await fs.writeFile(stagedHost, f.host);
  await recordSignedNativeHost(archive, staged.inputManifest, identity, process.arch);
  const recorded = JSON.parse(await fs.readFile(staged.inputManifest)).native;
  assert.deepEqual({ ...recorded, signed: undefined }, { ...source, signed: undefined });
  assert.equal(recorded.signed.identity, identity);
  assert.equal(recorded.signed.byteLength, signedBytes.length);
  assert.notEqual(recorded.signed.sha256, source.sourceSha256);
  await verifyDesktopArchive(archive, staged.inputManifest);
  details = signature.replace(identity, 'other');
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest), /identity does not match/);
  details = signature;
  const tampered = Buffer.from(signedBytes); tampered[tampered.length - 1] ^= 1;
  await fs.writeFile(filename, tampered);
  await assert.rejects(verifyDesktopArchive(archive, staged.inputManifest), /content mismatch/);
});
