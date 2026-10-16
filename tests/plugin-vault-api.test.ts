import assert from 'node:assert/strict';
import test from 'node:test';
import { Vault as CoreVault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Events } from '../src/plugins/events.ts';
import { Vault, TAbstractFile, TFile, TFolder } from '../src/plugins/vault-api.ts';

async function fixture(seed: Record<string, string | Uint8Array> = {}) {
  const adapter = new MemoryAdapter(seed);
  const core = new CoreVault(adapter);
  await core.initialize();
  const vault = new Vault(core, { name: 'Fixture', configDir: '.zorid' });
  return { adapter, core, vault };
}

test('shared constructors, exact lookup, root, tree and real byte stats', async () => {
  const { core, vault } = await fixture({ 'folder/note.md': 'é', 'UPPER.MD': 'upper', 'archive.tar.gz': '' });
  const file = vault.getFileByPath('folder/note.md')!;
  assert.ok(vault instanceof Events);
  assert.ok(file instanceof TAbstractFile);
  assert.ok(file instanceof TFile);
  assert.equal(file.vault, vault);
  assert.equal(file.name, 'note.md');
  assert.equal(file.basename, 'note');
  assert.equal(file.extension, 'md');
  assert.equal(String(file), 'folder/note.md');
  assert.equal(file.stat.size, 2);
  assert.equal(file.stat.mtime, core.entries.get(file.path)!.mtime);
  assert.equal(file.stat.ctime, undefined);
  assert.equal(vault.getFileByPath('archive.tar.gz')!.basename, 'archive.tar');
  assert.equal(vault.getAbstractFileByPath('folder/NOTE.md'), null);
  assert.equal(vault.getAbstractFileByPath('./folder/note.md'), null);
  assert.equal(vault.getFileByPath('folder'), null);
  assert.equal(vault.getFolderByPath(file.path), null);
  const root = vault.getRoot(), folder = vault.getFolderByPath('folder')!;
  assert.ok(folder instanceof TFolder);
  assert.equal(root.path, '/');
  assert.equal(root.isRoot(), true);
  assert.equal(root.parent, null);
  assert.equal(vault.getAbstractFileByPath('/'), root);
  assert.equal(folder.parent, root);
  assert.equal(file.parent, folder);
  assert.deepEqual(folder.children, [file]);
  assert.equal(vault.getAllLoadedFiles().length, 5);
  assert.deepEqual(vault.getAllFolders(), [folder]);
  assert.deepEqual(vault.getAllFolders(true), [root, folder]);
  assert.deepEqual(vault.getMarkdownFiles(), [file]);
  assert.equal(vault.getName(), 'Fixture');
  assert.equal(vault.configDir, '.zorid');
  assert.equal(vault.adapter, undefined);
  vault.dispose();
});

test('recurseChildren includes root and visits last sibling first', async () => {
  const { vault } = await fixture({ 'a.md': '', 'folder/b.md': '', 'folder/c.md': '' });
  const paths: string[] = [];
  Vault.recurseChildren(vault.getRoot(), file => paths.push(file.path));
  assert.deepEqual(paths, ['/', 'folder', 'folder/c.md', 'folder/b.md', 'a.md']);
  vault.dispose();
});

test('ready publishes initial create events only for newly indexed entries', async () => {
  const core = new CoreVault(new MemoryAdapter({ 'folder/note.md': 'text' }));
  const vault = new Vault(core, { name: 'Fixture', configDir: '.zorid' });
  const seen: TAbstractFile[] = [];
  vault.on('create', (file: TAbstractFile) => seen.push(file));
  await core.initialize();
  assert.deepEqual(seen.map(file => file.path), ['folder', 'folder/note.md']);
  await core.initialize();
  assert.equal(seen.length, 2);
  assert.equal(seen[1], vault.getFileByPath('folder/note.md'));
  vault.dispose();
});

test('create and modify publish live objects before resolving and preserve identities', async () => {
  const { adapter, vault } = await fixture();
  const order: string[] = [];
  const context = { events: 0 };
  const ref = vault.on('create', function(this: typeof context, file: TAbstractFile) {
    this.events++;
    assert.equal(vault.getAbstractFileByPath(file.path), file);
    assert.ok(file.parent!.children.includes(file));
    order.push(`create:${file.path}`);
  }, context);
  const folder = await vault.createFolder('folder');
  const file = await vault.create('folder/note.md', 'one');
  assert.equal(file.parent, folder);
  order.push('resolved');
  vault.on('modify', (changed: TFile) => { assert.equal(changed, file); order.push('modify'); });
  await vault.modify(file, 'éé');
  assert.equal(await adapter.read(file.path), 'éé');
  assert.equal(file.stat.size, 4);
  assert.deepEqual(order, ['create:folder', 'create:folder/note.md', 'resolved', 'modify']);
  assert.equal(context.events, 2);
  vault.offref(ref);
  await vault.create('other.md', '');
  assert.equal(context.events, 2);
  await assert.rejects(vault.create(file.path, 'replace'), /already exists/);
  assert.equal(await adapter.read(file.path), 'éé');
  vault.dispose();
});

test('text reads strip BOM, cache explicit reads, and invalidate on host modifications', async () => {
  const { adapter, core, vault } = await fixture({ 'note.md': '\uFEFFone', 'plain.txt': 'one' });
  const file = vault.getFileByPath('note.md')!, plain = vault.getFileByPath('plain.txt')!;
  assert.equal(await vault.read(file), 'one');
  assert.equal(await vault.cachedRead(plain), 'one');
  await adapter.write('note.md', 'two');
  await adapter.write('plain.txt', 'two');
  assert.equal(await vault.cachedRead(file), 'one');
  assert.equal(await vault.cachedRead(plain), 'one');
  assert.equal(await vault.read(file), 'two');
  assert.equal(await vault.cachedRead(file), 'two');
  await core.reload(['note.md', 'plain.txt']);
  assert.equal(await vault.cachedRead(plain), 'two');
  await vault.modify(file, 'three');
  assert.equal(await vault.cachedRead(file), 'three');
  vault.dispose();
});

test('binary operations copy bytes and return ArrayBuffer without text conversion', async () => {
  const { adapter, vault } = await fixture();
  const bytes = new Uint8Array([0, 255, 128, 1]);
  const pending = vault.createBinary('image.bin', bytes.buffer);
  bytes.fill(2);
  const file = await pending;
  const result = await vault.readBinary(file);
  assert.ok(result instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(result)], [0, 255, 128, 1]);
  new Uint8Array(result).fill(9);
  assert.deepEqual([...await adapter.readBinary(file.path)], [0, 255, 128, 1]);
  await vault.modifyBinary(file, new Uint8Array([4, 5]).buffer);
  assert.equal(file.stat.size, 2);
  assert.deepEqual([...await adapter.readBinary(file.path)], [4, 5]);
  vault.dispose();
});

test('core folder renames keep descendant objects, update tree, and forward old path', async () => {
  const { core, vault } = await fixture({ 'folder/note.md': 'note', 'folder/nested/child.md': 'child', 'other/target.md': '' });
  const folder = vault.getFolderByPath('folder')!, file = vault.getFileByPath('folder/note.md')!;
  const nested = vault.getFolderByPath('folder/nested')!, child = vault.getFileByPath('folder/nested/child.md')!;
  const renames: unknown[][] = [];
  vault.on('rename', (entry: TAbstractFile, oldPath: string) => {
    assert.equal(entry, folder);
    assert.equal(vault.getFileByPath('other/moved/note.md'), file);
    renames.push([entry, oldPath]);
  });
  await core.rename('folder', 'other/moved');
  assert.equal(vault.getFolderByPath('other/moved'), folder);
  assert.equal(vault.getAbstractFileByPath('folder'), null);
  assert.equal(folder.parent, vault.getFolderByPath('other'));
  assert.equal(file.parent, folder);
  assert.equal(nested.path, 'other/moved/nested');
  assert.equal(child.parent, nested);
  assert.equal(child.path, 'other/moved/nested/child.md');
  assert.deepEqual(renames, [[folder, 'folder']]);
  vault.dispose();
});

test('recursive deletion forwards each original object and rejects stale handles after recreation', async () => {
  const { core, vault } = await fixture({ 'folder/note.md': 'note', 'folder/nested/child.md': 'child' });
  const before = vault.getAllLoadedFiles().filter(file => file !== vault.getRoot());
  const deleted: TAbstractFile[] = [];
  vault.on('delete', (file: TAbstractFile) => {
    assert.equal(file.parent, null);
    assert.equal(vault.getAbstractFileByPath(file.path), null);
    deleted.push(file);
  });
  await core.trash('folder');
  assert.deepEqual(deleted, before);
  for (const file of deleted) if (file instanceof TFolder) assert.deepEqual(file.children, []);
  assert.deepEqual(vault.getRoot().children, []);
  await vault.createFolder('folder');
  const replacement = await vault.create('folder/note.md', 'replacement');
  const oldFile = before.find(file => file.path === replacement.path) as TFile;
  assert.notEqual(replacement, oldFile);
  await assert.rejects(vault.modify(oldFile, 'bad'), /live vault/);
  assert.equal(await vault.read(replacement), 'replacement');
  vault.dispose();
});

test('unsupported mutations fail before touching data, and root deletion is harmless', async () => {
  const { adapter, vault } = await fixture({ 'note.md': 'original' });
  const file = vault.getFileByPath('note.md')!;
  await assert.rejects(vault.rename(file, 'new.md'), /without link rewriting/);
  await assert.rejects(vault.delete(file), /permanent deletion/);
  await assert.rejects(vault.trash(file, true), /system or local trash/);
  await assert.rejects(vault.modify(file, 'changed', { mtime: 123 }), /timestamps/);
  await assert.rejects(vault.create('new.md', 'changed', { ctime: 123 }), /timestamps/);
  assert.throws(() => vault.getResourcePath(file), /resource URLs/);
  await vault.delete(vault.getRoot(), true);
  await vault.trash(vault.getRoot(), false);
  assert.equal(await adapter.read(file.path), 'original');
  assert.equal(await adapter.stat('new.md'), null);
  vault.dispose();
});

test('host capabilities receive paths/options and real stats without changing namespace identity', async () => {
  const { core } = await fixture({ 'note.md': 'original' });
  const calls: unknown[][] = [];
  const compatibleAdapter = {};
  const vault = new Vault(core, {
    name: 'Host', configDir: '.config', adapter: compatibleAdapter,
    getFileStats: entry => ({ ctime: 123, mtime: entry.mtime, size: entry.size }),
    rename: async (...args) => { calls.push(['rename', ...args]); },
    delete: async (...args) => { calls.push(['delete', ...args]); },
    trash: async (...args) => { calls.push(['trash', ...args]); },
    getResourcePath: path => `fixture-resource:${path}`,
  });
  const file = vault.getFileByPath('note.md')!;
  assert.equal(file.stat.ctime, 123);
  assert.equal(vault.adapter, compatibleAdapter);
  assert.equal(vault.getResourcePath(file), 'fixture-resource:note.md');
  // Contract probes only: these callbacks do not establish filesystem behavior.
  await vault.rename(file, './renamed.md');
  await vault.delete(file, true);
  await vault.trash(file, false);
  assert.deepEqual(calls, [['rename', 'note.md', 'renamed.md'], ['delete', 'note.md', true], ['trash', 'note.md', false]]);
  vault.dispose();
});

test('adapter failures preserve data and do not emit success events; disposed facade detaches', async () => {
  const { adapter, core, vault } = await fixture({ 'note.md': 'original' });
  const file = vault.getFileByPath('note.md')!;
  const failure = new Error('disk full');
  const events: string[] = [];
  vault.on('modify', () => events.push('modify'));
  const write = adapter.write.bind(adapter);
  adapter.write = async () => { throw failure; };
  await assert.rejects(vault.modify(file, 'changed'), error => error === failure);
  assert.equal(await adapter.read(file.path), 'original');
  assert.deepEqual(events, []);
  adapter.write = write;
  vault.dispose();
  vault.dispose();
  await core.modify(file.path, 'host write');
  assert.deepEqual(events, []);
  await assert.rejects(vault.read(file), /disposed/);
  await assert.rejects(vault.create('new.md', ''), /disposed/);
});
