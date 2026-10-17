import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopNotices } from '../scripts/desktop-notices.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const packages = {
  '@bufbuild/protobuf': { version: '2.16.0', license: '(Apache-2.0 AND BSD-3-Clause)', repository: { url: 'https://github.com/bufbuild/protobuf-es.git' } },
  '@connectrpc/connect': { version: '2.2.0', license: 'Apache-2.0', repository: { url: 'https://github.com/connectrpc/connect-es.git' } },
  '@connectrpc/connect-web': { version: '2.2.0', license: 'Apache-2.0', repository: { url: 'https://github.com/connectrpc/connect-es.git' } },
};
async function fixture(t, selected = Object.keys(packages)) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-notice-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(relative, bytes) {
    const filename = path.join(root, relative); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, bytes);
  }
  const metadata = { dependencies: Object.fromEntries(selected.map(name => [name, packages[name]?.version ?? '1.0.0'])), devDependencies: { electron: '44.8.0' } };
  await write('package.json', JSON.stringify(metadata));
  for (const name of selected) await write(`node_modules/${name}/package.json`, JSON.stringify({ name, ...packages[name] }));
  await fs.cp(path.join(project, 'third-party'), path.join(root, 'third-party'), { recursive: true });
  await write('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '44.8.0' }));
  await write('node_modules/electron/path.txt', 'Electron.app/Contents/MacOS/Electron');
  await write('node_modules/electron/dist/version', '44.8.0');
  await write('node_modules/electron/dist/LICENSE', 'Electron fixture notice');
  await write('node_modules/electron/dist/LICENSES.chromium.html', 'Chromium fixture notices');
  const executable = Buffer.alloc(8); executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(0x0100000c, 4);
  await write('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', executable);
  return { root, metadata, write };
}

test('exact audited RPC packages include Apache, Google BSD and immutable source attribution without npm LICENSE files', async t => {
  const f = await fixture(t), notices = await desktopNotices(f.root, f.metadata);
  const aggregate = notices.get('THIRD_PARTY_NOTICES.txt').toString();
  for (const name of Object.keys(packages)) assert.ok(aggregate.includes(`${name}@${packages[name].version}`));
  assert.match(aggregate, /Apache License/); assert.match(aggregate, /Copyright 2021-2026 Buf Technologies, Inc/);
  assert.match(aggregate, /Copyright 2008 Google Inc/); assert.match(aggregate, /Neither the name of Google Inc/);
  assert.match(aggregate, /Copyright 2021-2026 The Connect Authors/);
  assert.match(aggregate, /b3b232f7f466eda27c66e8f63c82f930578b6cc6\/packages\/protobuf\/src\/wire\/varint.ts/);
  assert.match(aggregate, /378bb8fde1209afc3ab6a9b0aa97c00d0db58c24\/LICENSE/);
  assert.equal(notices.get('licenses/electron/LICENSE').toString(), 'Electron fixture notice');
});

test('an installed partial Apache notice never suppresses the pinned Protobuf BSD notice', async t => {
  const f = await fixture(t, ['@bufbuild/protobuf']); await f.write('node_modules/@bufbuild/protobuf/LICENSE', 'Installed partial Apache notice');
  const aggregate = (await desktopNotices(f.root, f.metadata)).get('THIRD_PARTY_NOTICES.txt').toString();
  assert.match(aggregate, /Installed partial Apache notice/); assert.match(aggregate, /Copyright 2008 Google Inc/);
});

test('audited notice exceptions never apply to another version, license, repository or unknown package', async t => {
  const f = await fixture(t, ['@bufbuild/protobuf']);
  for (const changed of [{ version: '2.16.1' }, { license: 'Apache-2.0' }, { repository: { url: 'https://example.test/protobuf.git' } }]) {
    await f.write('node_modules/@bufbuild/protobuf/package.json', JSON.stringify({ name: '@bufbuild/protobuf', ...packages['@bufbuild/protobuf'], ...changed }));
    await assert.rejects(desktopNotices(f.root, f.metadata), /No distribution license text found/);
  }
  await f.write('node_modules/unknown-package/package.json', JSON.stringify({ name: 'unknown-package', version: '1.0.0', license: 'Apache-2.0' }));
  await assert.rejects(desktopNotices(f.root, { dependencies: { 'unknown-package': '1.0.0' } }), /No distribution license text found/);
});

test('missing, modified or incorrectly attributed audited notices fail closed', async t => {
  const f = await fixture(t, ['@bufbuild/protobuf']), relative = 'third-party/notices/protobuf-es-2.16.0/BSD-3-Clause-varint.txt';
  const bytes = await fs.readFile(path.join(f.root, relative)); await fs.rm(path.join(f.root, relative));
  await assert.rejects(desktopNotices(f.root, f.metadata), /ENOENT/);
  await f.write(relative, Buffer.concat([bytes, Buffer.from('changed')]));
  await assert.rejects(desktopNotices(f.root, f.metadata), /Audited distribution notice content mismatch/);
  await f.write(relative, bytes);
  const manifestPath = 'third-party/notices/protobuf-es-2.16.0/provenance.json';
  const manifest = JSON.parse(await fs.readFile(path.join(f.root, manifestPath)));
  manifest.commit = '0'.repeat(40); await f.write(manifestPath, JSON.stringify(manifest));
  await assert.rejects(desktopNotices(f.root, f.metadata), /Audited distribution notice provenance mismatch/);
});

test('audited notice files and parent directories cannot be symlinks', async t => {
  const f = await fixture(t, ['@bufbuild/protobuf']), directory = path.join(f.root, 'third-party/notices/protobuf-es-2.16.0');
  const filename = path.join(directory, 'LICENSE'); await fs.rm(filename); await f.write('substitute.txt', 'external notice');
  await fs.symlink(path.join(f.root, 'substitute.txt'), filename);
  await assert.rejects(desktopNotices(f.root, f.metadata), /must be a regular file/);
  await fs.rm(directory, { recursive: true }); await fs.mkdir(path.join(f.root, 'substitute-directory'));
  await fs.symlink(path.join(f.root, 'substitute-directory'), directory);
  await assert.rejects(desktopNotices(f.root, f.metadata), /must be real directories/);
});
