import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import type { VaultAdapter, VaultEntry } from '../src/core/types.ts';

const bytes = (...values: number[]) => new Uint8Array(values);

test('memory binary storage preserves arbitrary bytes, slice boundaries, UTF-8 text and ownership', async () => {
  const original = bytes(9, 0, 255, 128, 10, 8), slice = original.subarray(1, 5);
  const adapter = new MemoryAdapter({ 'seed.bin': slice, 'note.md': '🌱 café' });
  original.fill(7);
  assert.deepEqual(await adapter.readBinary('seed.bin'), bytes(0, 255, 128, 10));
  assert.equal((await adapter.stat('seed.bin'))!.size, 4);
  const data = bytes(1, 0, 254, 255);
  await adapter.writeBinary('image.png', data); data.fill(99);
  const read = await adapter.readBinary('image.png'); read.fill(22);
  assert.deepEqual(await adapter.readBinary('image.png'), bytes(1, 0, 254, 255));
  assert.deepEqual(await adapter.readBinary('note.md'), new TextEncoder().encode('🌱 café'));
  await adapter.writeBinary('text.md', new TextEncoder().encode('\uFEFF# Heading 🌱'));
  assert.equal(await adapter.read('text.md'), '\uFEFF# Heading 🌱');
  await adapter.write('image.png', 'text replacement');
  assert.deepEqual(await adapter.readBinary('image.png'), new TextEncoder().encode('text replacement'));
  await adapter.writeBinary('empty.bin', new Uint8Array());
  assert.equal((await adapter.readBinary('empty.bin')).length, 0);
  assert.equal((await adapter.stat('empty.bin'))!.size, 0);
});

test('mixed text and binary folders rename and trash without decoding or changing bytes', async () => {
  const adapter = new MemoryAdapter({ 'Folder/image.png': bytes(0, 255, 254), 'Folder/Note.md': 'text' });
  await adapter.rename('Folder', 'Moved');
  assert.deepEqual(await adapter.readBinary('Moved/image.png'), bytes(0, 255, 254));
  assert.equal(await adapter.read('Moved/Note.md'), 'text');
  await assert.rejects(adapter.readBinary('Folder/image.png'), /does not exist/);
  await adapter.trash('Moved');
  assert.deepEqual(await adapter.list(), []);
  await assert.rejects(adapter.readBinary('Moved/image.png'), /does not exist/);
  await assert.rejects(adapter.writeBinary('../outside', bytes(1)), /escape/);
  await assert.rejects(adapter.writeBinary('Missing/file.bin', bytes(1)), /Parent folder/);
});

test('creating and changing attachments avoids text reads and exposes file links and byte stats', async () => {
  class AttachmentAdapter extends MemoryAdapter {
    textReads: string[] = [];
    blockAllReads = false;
    override async read(path: string): Promise<string> {
      this.textReads.push(path);
      if (this.blockAllReads || /\.(png|pdf)$/.test(path)) throw new Error('Attachment must not be decoded');
      return super.read(path);
    }
  }
  const adapter = new AttachmentAdapter({ 'Note.md': '![[scan.pdf#page=2]] ![scan](scan.pdf)' });
  const vault = new Vault(adapter);
  await vault.initialize();
  const metadata = vault.metadata.get('Note.md');
  adapter.textReads = []; adapter.blockAllReads = true;
  const events: string[] = [];
  vault.on('create', change => events.push(`create:${change.path}`));
  vault.on('modify', change => events.push(`modify:${change.path}`));
  const created = await vault.createBinary('scan.pdf', bytes(0, 255, 1));
  assert.equal(created.size, 3);
  assert.deepEqual(created, await adapter.stat('scan.pdf'));
  assert.equal(vault.metadata.get('Note.md'), metadata);
  assert.equal(vault.metadata.get('scan.pdf'), undefined);
  assert.equal(vault.metadata.resolveLink('Note.md', 'scan.pdf'), 'scan.pdf');
  assert.equal(vault.metadata.backlinks('scan.pdf').length, 2);
  await vault.modifyBinary('scan.pdf', bytes(128, 255));
  assert.deepEqual(await vault.readBinary('scan.pdf'), bytes(128, 255));
  assert.equal(vault.entries.get('scan.pdf')!.size, 2);
  assert.deepEqual(adapter.textReads, []);
  assert.deepEqual(events, ['create:scan.pdf', 'modify:scan.pdf']);
});

test('vault attachment rename updates reference names and preserves mixed-folder bytes', async () => {
  const adapter = new MemoryAdapter({ 'Assets/image.png': bytes(255, 0, 128), 'Note.md': '![[Assets/image.png]] ![alt](Assets/image.png)' });
  const vault = new Vault(adapter);
  await vault.initialize();
  await vault.rename('Assets/image.png', 'Assets/new image.png');
  assert.deepEqual(await vault.readBinary('Assets/new image.png'), bytes(255, 0, 128));
  assert.equal(await vault.read('Note.md'), '![[Assets/new image.png]] ![alt](Assets/new%20image.png)');
  assert.equal(vault.metadata.backlinks('Assets/new image.png').length, 2);
  await vault.trash('Assets');
  assert.equal(vault.metadata.resolveLink('Note.md', 'Assets/new image.png'), null);
  assert.equal(await vault.read('Note.md'), '![[Assets/new image.png]] ![alt](Assets/new%20image.png)');
  await assert.rejects(vault.readBinary('Assets/new image.png'), /does not exist/);
});

test('binary writes to Markdown retain correct note metadata and cached content', async () => {
  const adapter = new MemoryAdapter({ 'Other.md': '[[Binary]]' }), vault = new Vault(adapter);
  await vault.initialize();
  const text = '# Binary 🌱\n[[Other]]';
  await vault.createBinary('Binary.md', new TextEncoder().encode(text));
  assert.equal(vault.metadata.get('Binary.md')!.headings[0].heading, 'Binary 🌱');
  assert.equal(vault.metadata.backlinks('Other.md').length, 1);
  assert.equal(await vault.cachedRead('Binary.md'), text);
  await vault.modifyBinary('Binary.md', new TextEncoder().encode('# Changed é'));
  assert.equal(vault.metadata.get('Binary.md')!.headings[0].heading, 'Changed é');
  assert.equal(vault.metadata.backlinks('Other.md').length, 0);
  assert.equal(await vault.cachedRead('Binary.md'), '# Changed é');
  assert.equal(vault.entries.get('Binary.md')!.size, new TextEncoder().encode('# Changed é').length);
});

test('queued binary operations copy caller bytes immediately and concurrent creates cannot overwrite', async () => {
  const vault = new Vault(new MemoryAdapter());
  await vault.initialize();
  const input = bytes(1, 2, 3), creating = vault.createBinary('file.bin', input);
  input.fill(9); await creating;
  assert.deepEqual(await vault.readBinary('file.bin'), bytes(1, 2, 3));
  const update = bytes(4, 5), modifying = vault.modifyBinary('file.bin', update);
  update.fill(9); await modifying;
  const returned = await vault.readBinary('file.bin'); returned.fill(7);
  assert.deepEqual(await vault.readBinary('file.bin'), bytes(4, 5));
  const results = await Promise.allSettled([vault.createBinary('race.bin', bytes(1)), vault.createBinary('race.bin', bytes(2))]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.deepEqual(await vault.readBinary('race.bin'), bytes(1));
});

test('fresh collision checks protect external files and directories even before watcher refresh', async () => {
  const adapter = new MemoryAdapter(), vault = new Vault(adapter);
  await vault.initialize();
  await adapter.writeBinary('external.bin', bytes(255));
  await adapter.mkdir('Folder');
  await assert.rejects(vault.createBinary('external.bin', bytes(0)), /already exists/);
  await assert.rejects(vault.createBinary('Folder', bytes(0)), /already exists/);
  await assert.rejects(vault.createBinary('Missing/file.bin', bytes(0)), /Parent folder/);
  await assert.rejects(vault.modifyBinary('missing.bin', bytes(0)), /does not exist/);
  await assert.rejects(vault.createBinary('../outside', bytes(0)), /escape/);
  assert.deepEqual(await adapter.readBinary('external.bin'), bytes(255));
  await vault.createBinary('Folder/new.bin', bytes(3));
  assert.equal(vault.entries.get('Folder')!.type, 'folder');
  assert.deepEqual(await vault.readBinary('Folder/new.bin'), bytes(3));
  await adapter.trash('Folder');
  await vault.createBinary('Folder', bytes(4));
  assert.equal(vault.entries.has('Folder/new.bin'), false);
  assert.equal(vault.entries.get('Folder')!.type, 'file');
  // Bare extensionless targets are note lookups, even when a binary has that exact name.
  assert.equal(vault.metadata.resolveLink('external.bin', 'Folder'), null);
  assert.deepEqual(await vault.readBinary('Folder'), bytes(4));
});

test('binary failures preserve published metadata and allow subsequent operations', async () => {
  class FailingAdapter extends MemoryAdapter {
    failWrite = false;
    failStat = false;
    override async writeBinary(path: string, data: Uint8Array): Promise<void> {
      if (this.failWrite) throw new Error('disk full');
      await super.writeBinary(path, data);
    }
    override async createBinary(path: string, data: Uint8Array): Promise<void> {
      if (this.failWrite) throw new Error('disk full');
      await super.createBinary(path, data);
    }
    override async stat(path: string): Promise<VaultEntry | null> {
      if (this.failStat) throw new Error('cannot stat');
      return super.stat(path);
    }
  }
  const adapter = new FailingAdapter({ 'file.bin': bytes(1), 'Note.md': '# Keep' }), vault = new Vault(adapter);
  await vault.initialize();
  const previous = vault.entries.get('file.bin'), note = vault.metadata.get('Note.md');
  const events: string[] = [];
  vault.on('modify', event => events.push(event.path));
  adapter.failWrite = true;
  await assert.rejects(vault.modifyBinary('file.bin', bytes(2)), /disk full/);
  await assert.rejects(vault.createBinary('new.bin', bytes(2)), /disk full/);
  assert.equal(vault.entries.has('new.bin'), false);
  assert.equal(vault.metadata.resolveLink('Note.md', 'new.bin'), null);
  assert.deepEqual(await adapter.readBinary('file.bin'), bytes(1));
  adapter.failWrite = false; adapter.failStat = true;
  await assert.rejects(vault.modifyBinary('file.bin', bytes(3, 4)), /cannot stat/);
  assert.equal(vault.entries.get('file.bin'), previous);
  assert.equal(vault.metadata.get('Note.md'), note);
  assert.deepEqual(events, []);
  adapter.failStat = false;
  await vault.modifyBinary('file.bin', bytes(5, 6, 7));
  assert.equal(vault.entries.get('file.bin')!.size, 3);
  assert.deepEqual(await vault.readBinary('file.bin'), bytes(5, 6, 7));
  assert.deepEqual(events, ['file.bin']);
});

test('unsupported binary APIs fail clearly, and fallback stat remains compatible with older adapters', async () => {
  const backing = new MemoryAdapter({ 'file.bin': bytes(1), 'Note.md': '# Keep' });
  const adapter: VaultAdapter = {
    list: () => backing.list(), read: path => backing.read(path), write: (path, text) => backing.write(path, text),
    mkdir: path => backing.mkdir(path), rename: (from, to) => backing.rename(from, to), trash: path => backing.trash(path),
  };
  const vault = new Vault(adapter); await vault.initialize();
  await assert.rejects(vault.readBinary('file.bin'), /does not support binary reads/);
  await assert.rejects(vault.createBinary('new.bin', bytes(2)), /does not support explicit binary creation/);
  await assert.rejects(vault.modifyBinary('file.bin', bytes(2)), /does not support binary writes/);
  adapter.readBinary = path => backing.readBinary(path); adapter.writeBinary = (path, data) => backing.writeBinary(path, data);
  await assert.rejects(vault.createBinary('new.bin', bytes(2)), /does not support explicit binary creation/);
  assert.equal(await backing.stat('new.bin'), null);
  adapter.createBinary = (path, data) => backing.createBinary(path, data);
  await vault.createBinary('new.bin', bytes(3, 4)); await vault.modifyBinary('file.bin', bytes(5, 6, 7));
  assert.deepEqual(await vault.readBinary('new.bin'), bytes(3, 4));
  assert.equal(vault.entries.get('file.bin')!.size, 3);
  assert.equal(vault.metadata.get('Note.md')!.headings[0].heading, 'Keep');
});

test('explicit attachment notifications invalidate same-stat bytes without reading unrelated files', async () => {
  class FixedStatAdapter extends MemoryAdapter {
    reads: string[] = [];
    binaryReads: string[] = [];
    lists = 0;
    override async list(): Promise<VaultEntry[]> {
      this.lists++;
      return (await super.list()).map(entry => ({ ...entry, mtime: 12 }));
    }
    override async stat(path: string): Promise<VaultEntry | null> {
      const entry = await super.stat(path); return entry ? { ...entry, mtime: 12 } : null;
    }
    override async read(path: string): Promise<string> { this.reads.push(path); return super.read(path); }
    override async readBinary(path: string): Promise<Uint8Array> { this.binaryReads.push(path); return super.readBinary(path); }
  }
  const adapter = new FixedStatAdapter({ 'image.png': bytes(1, 2, 3), 'Other.md': '# Unrelated', 'other.pdf': bytes(9, 8, 7) });
  const vault = new Vault(adapter); await vault.initialize();
  adapter.reads = []; adapter.binaryReads = []; adapter.lists = 0;
  const events: string[] = [];
  vault.on('modify', change => events.push(change.path));
  const before = vault.entries.get('image.png');
  await adapter.writeBinary('image.png', bytes(4, 5, 6));
  await vault.reload(['image.png', 'image.png']);
  assert.deepEqual(vault.entries.get('image.png'), before);
  assert.deepEqual(events, ['image.png']);
  assert.equal(adapter.lists, 0);
  assert.deepEqual(adapter.reads, []);
  assert.deepEqual(adapter.binaryReads, []);
  const result = await vault.readBinary('image.png');
  assert.deepEqual(result, bytes(4, 5, 6)); result.fill(99);
  assert.deepEqual(await vault.readBinary('image.png'), bytes(4, 5, 6));
  assert.deepEqual(adapter.binaryReads, ['image.png', 'image.png']);
  await vault.reload(['image.png']);
  assert.deepEqual(events, ['image.png', 'image.png']); // Duplicate explicit invalidations are intentional.
  await vault.reload();
  assert.deepEqual(events, ['image.png', 'image.png']); // A full scan remains metadata-only for attachments.
});
