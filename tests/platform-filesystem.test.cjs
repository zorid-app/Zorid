const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { VaultService } = require('../desktop/vault-service.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-vault-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, vault: await VaultService.open(directory) };
}

test('Markdown survives atomic replacement and recursive inventory preserves empty folders', async t => {
  const { directory, vault } = await fixture(t);
  await vault.mkdir('Empty');
  await vault.write('Research/Note.md', '# First\n');
  await vault.write('Research/Note.md', '# Second\n[[Another note]] — café\n');
  assert.equal(await vault.read('Research/Note.md'), '# Second\n[[Another note]] — café\n');
  assert.equal(await fs.readFile(path.join(directory, 'Research/Note.md'), 'utf8'), '# Second\n[[Another note]] — café\n');
  const list = await vault.list();
  assert.deepEqual(list.map(({ path, type }) => ({ path, type })), [
    { path: 'Empty', type: 'folder' }, { path: 'Research', type: 'folder' }, { path: 'Research/Note.md', type: 'file' },
  ]);
  assert.equal(list[2].size, Buffer.byteLength('# Second\n[[Another note]] — café\n'));
  assert.deepEqual(await fs.readdir(path.join(directory, 'Research')), ['Note.md']);
});

test('rename preserves a tree and refuses to overwrite an existing note', async t => {
  const { vault } = await fixture(t);
  await vault.write('Folder/Note.md', 'keep me');
  await vault.write('Other.md', 'existing');
  await assert.rejects(vault.rename('Folder/Note.md', 'Other.md'), /already exists/);
  assert.equal(await vault.read('Other.md'), 'existing');
  await assert.rejects(vault.rename('Folder', 'Folder/Child'), /itself/);
  await vault.rename('Folder', 'Archive/Folder');
  assert.equal(await vault.read('Archive/Folder/Note.md'), 'keep me');
});

test('trash retains a recoverable copy and excludes recovery files from note inventory', async t => {
  const { directory, vault } = await fixture(t);
  await vault.write('Folder/Note.md', 'recover me');
  await vault.trash('Folder');
  assert.deepEqual(await vault.list(), []);
  const recoveries = await fs.readdir(path.join(directory, '.trash'));
  assert.equal(recoveries.length, 1);
  assert.equal(await fs.readFile(path.join(directory, '.trash', recoveries[0], 'Folder/Note.md'), 'utf8'), 'recover me');
});

test('all operations reject path traversal, absolute paths and symlink escapes', async t => {
  const { directory, vault } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-outside-test-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'Secret.md'), 'untouched');
  await fs.symlink(outside, path.join(directory, 'Link'), 'dir');
  for (const target of ['../Secret.md', '/tmp/Secret.md', 'Link/Secret.md', 'dir/../../Secret.md', 'dir\\file.md']) {
    await assert.rejects(vault.read(target));
    await assert.rejects(vault.write(target, 'bad'));
    await assert.rejects(vault.mkdir(target));
    await assert.rejects(vault.trash(target));
  }
  await vault.write('Note.md', 'safe');
  await assert.rejects(vault.rename('Note.md', 'Link/Secret.md'));
  assert.equal(await fs.readFile(path.join(outside, 'Secret.md'), 'utf8'), 'untouched');
  assert.deepEqual((await vault.list()).map(entry => entry.path), ['Note.md']);
});

test('subscribers receive external file changes and can stop watching', async t => {
  const { directory, vault } = await fixture(t);
  let stop;
  const change = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No filesystem change received')), 3000);
    stop = vault.subscribe(event => {
      if (event.path === 'External.md') { clearTimeout(timeout); resolve(event); }
    });
  });
  t.after(() => stop?.());
  await fs.writeFile(path.join(directory, 'External.md'), 'written by another app');
  assert.equal((await change).path, 'External.md');
  stop();
});

test('binary attachments preserve zero/high bytes, view boundaries and replacement stats', async t => {
  const { directory, vault } = await fixture(t);
  const data = new Uint8Array([9, 0, 127, 128, 255, 0, 9]).subarray(1, 6);
  await vault.writeBinary('Attachments/image.png', data);
  assert.deepEqual(await vault.readBinary('Attachments/image.png'), data);
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(directory, 'Attachments/image.png'))), data);
  assert.equal((await vault.stat('Attachments/image.png')).size, 5);
  await vault.writeBinary('Attachments/image.png', new Uint8Array([255, 0]));
  assert.deepEqual(await vault.readBinary('Attachments/image.png'), new Uint8Array([255, 0]));
  assert.equal((await vault.stat('Attachments/image.png')).size, 2);
  assert.deepEqual(await fs.readdir(path.join(directory, 'Attachments')), ['image.png']);
  await vault.writeBinary('empty.bin', new Uint8Array());
  assert.equal((await vault.readBinary('empty.bin')).length, 0);
  await assert.rejects(vault.writeBinary('bad.bin', 'not bytes'), /Uint8Array/);
  await assert.rejects(vault.writeBinary('../escape.bin', data), /Invalid/);
  await fs.symlink(path.join(directory, 'Attachments/image.png'), path.join(directory, 'Link'));
  await assert.rejects(vault.readBinary('Link'), /Symbolic/);
  await assert.rejects(vault.writeBinary('Link', data), /Symbolic/);
});

test('single-entry stats report UTF-8 bytes, missing paths and reject symlinks', async t => {
  const { directory, vault } = await fixture(t);
  await vault.write('Folder/Note.md', 'café 🌱');
  assert.deepEqual(await vault.stat('Folder/Note.md'), (await vault.list()).find(entry => entry.path === 'Folder/Note.md'));
  assert.equal((await vault.stat('Folder/Note.md')).size, Buffer.byteLength('café 🌱'));
  assert.equal((await vault.stat('Folder')).type, 'folder');
  assert.equal(await vault.stat('Missing/Note.md'), null);
  await fs.symlink(path.join(directory, 'Folder'), path.join(directory, 'Linked'));
  await assert.rejects(vault.stat('Linked/Note.md'), /Symbolic links/);
  await assert.rejects(vault.stat('../Escape'), /Invalid/);
});

test('permanent removal uses explicit recursive force and never creates a recovery copy', async t => {
  const { directory, vault } = await fixture(t);
  await vault.write('Folder/Visible.md', 'visible');
  await vault.write('Folder/.hidden', 'hidden');
  await assert.rejects(vault.remove('Folder'));
  assert.equal(await vault.read('Folder/Visible.md'), 'visible');
  assert.equal(await vault.read('Folder/.hidden'), 'hidden');
  await assert.rejects(vault.remove('Folder', 'yes'), /boolean/);
  await vault.remove('Folder', true);
  assert.equal(await vault.stat('Folder'), null);
  await vault.write('One.md', 'one');
  await vault.remove('One.md');
  assert.equal(await vault.stat('One.md'), null);
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(vault.remove('Missing.md'));
});

test('permanent removal refuses traversal and symlinks before deleting original fixture contents', async t => {
  const { directory, vault } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'zorid-remove-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'Keep.md'), 'outside');
  await vault.write('Folder/Keep.md', 'inside');
  await fs.symlink(outside, path.join(directory, 'Folder/Link'), 'dir');
  for (const name of ['../Keep.md', outside, 'Folder/Link/Keep.md', 'Folder/Link', 'Folder']) {
    await assert.rejects(vault.remove(name, true));
  }
  assert.equal(await fs.readFile(path.join(outside, 'Keep.md'), 'utf8'), 'outside');
  assert.equal(await vault.read('Folder/Keep.md'), 'inside');
});

test('desktop stats expose the filesystem birth time without substituting modification time', async t => {
  const { directory, vault } = await fixture(t);
  await vault.write('Note.md', 'note');
  const raw = await fs.stat(path.join(directory, 'Note.md'));
  const stat = await vault.stat('Note.md');
  assert.equal(stat.ctime, raw.birthtimeMs);
  assert.equal((await vault.list()).find(entry => entry.path === 'Note.md').ctime, raw.birthtimeMs);
});
