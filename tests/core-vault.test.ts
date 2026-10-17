import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault, normalizePath } from '../src/core/index.ts';

test('vault CRUD persists UTF-8 notes, folders, events and rejects unsafe/duplicate writes', async () => {
  const adapter = new MemoryAdapter();
  const vault = new Vault(adapter);
  const events: string[] = [];
  const stop = vault.on('create', change => events.push(change.path));
  await vault.initialize();
  await vault.createFolder('Notes');
  await vault.create('Notes/One.md', 'Hello 🌱');
  assert.equal(await vault.read('Notes/One.md'), 'Hello 🌱');
  assert.equal(vault.entries.get('Notes/One.md')?.size, new TextEncoder().encode('Hello 🌱').length);
  assert.deepEqual(events, ['Notes', 'Notes/One.md']);
  await assert.rejects(vault.create('Notes/One.md', 'lost'), /already exists/);
  await assert.rejects(vault.create('Missing/One.md'), /Parent folder/);
  await assert.rejects(vault.create('../outside.md'), /escape/);
  await assert.rejects(vault.create('/outside.md'), /Absolute/);
  await assert.rejects(vault.modify('missing.md', 'text'), /does not exist/);
  await vault.modify('Notes/One.md', '# Heading');
  assert.equal(vault.metadata.get('Notes/One.md')?.headings[0].heading, 'Heading');
  stop();
  await vault.create('Two.md');
  assert.equal(events.length, 2);
  await vault.trash('Notes');
  assert.equal(vault.entries.has('Notes/One.md'), false);
  assert.equal(vault.metadata.get('Notes/One.md'), undefined);
  assert.equal(await vault.read('Two.md'), '');
});

test('concurrent duplicate creates are serialized without overwriting the winner', async () => {
  const vault = new Vault(new MemoryAdapter());
  await vault.initialize();
  const results = await Promise.allSettled([vault.create('One.md', 'first'), vault.create('One.md', 'second')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(await vault.read('One.md'), 'first');
});

test('note rename updates wiki, heading, embed, and Markdown links but leaves code and external URLs intact', async () => {
  const source = '[[One|Label]] [[One#Heading]] ![[One]] [one](One.md#Heading) [web](https://example.com/One.md)\n`[[One]]`\n```md\n[[One]]\n```';
  const vault = new Vault(new MemoryAdapter({ 'One.md': '# Heading', 'Other.md': source }));
  await vault.initialize();
  await vault.rename('One.md', 'New name.md');
  assert.equal(await vault.read('Other.md'), '[[New name|Label]] [[New name#Heading]] ![[New name]] [one](New%20name.md#Heading) [web](https://example.com/One.md)\n`[[One]]`\n```md\n[[One]]\n```');
  assert.equal(vault.metadata.backlinks('New name.md').length, 4);
  assert.equal(vault.entries.has('One.md'), false);
});

test('moving a folder preserves both incoming links and outgoing relative links', async () => {
  const vault = new Vault(new MemoryAdapter({
    'Root.md': '[[Folder/One]]',
    'Folder/One.md': '[root](../Root.md) [two](Two.md) [[#Heading]]',
    'Folder/Two.md': '[[Folder/One#Section]]',
    'Destination/Keep.md': '',
  }));
  await vault.initialize();
  await vault.rename('Folder', 'Destination/Moved');
  assert.equal(await vault.read('Root.md'), '[[Destination/Moved/One]]');
  assert.equal(await vault.read('Destination/Moved/One.md'), '[root](../../Root.md) [two](Two.md) [[#Heading]]');
  assert.equal(await vault.read('Destination/Moved/Two.md'), '[[Destination/Moved/One#Section]]');
  await assert.rejects(vault.rename('Destination', 'Destination/Moved/Inner'), /inside itself/);
  await assert.rejects(vault.rename('Root.md', 'Destination/Keep.md'), /already exists/);
});

test('failed link write rolls a rename back without losing note text', async () => {
  class FailingAdapter extends MemoryAdapter {
    async write(path: string, text: string): Promise<void> {
      if (path === 'Other.md' && text === '[[New]]') throw new Error('disk full');
      return super.write(path, text);
    }
  }
  const vault = new Vault(new FailingAdapter({ 'One.md': 'important', 'Other.md': '[[One]]' }));
  await vault.initialize();
  await assert.rejects(vault.rename('One.md', 'New.md'), /disk full/);
  assert.equal(await vault.read('One.md'), 'important');
  assert.equal(await vault.read('Other.md'), '[[One]]');
  assert.equal(vault.entries.has('New.md'), false);
});

test('external reload detects same-size changes and stale writes reject without clobbering', async () => {
  const adapter = new MemoryAdapter({ 'One.md': 'old' });
  const vault = new Vault(adapter);
  await vault.initialize();
  const changed: string[] = [];
  vault.on('modify', change => changed.push(change.path));
  await adapter.write('One.md', 'new');
  await assert.rejects(vault.modify('One.md', 'editor', { expectedContent: 'old' }), /outside this editor/);
  assert.equal(await adapter.read('One.md'), 'new');
  await vault.reload();
  assert.deepEqual(changed, ['One.md']);
  await vault.modify('One.md', 'merged', { expectedContent: 'new' });
  assert.equal(await vault.read('One.md'), 'merged');
});

test('path normalization rejects Windows absolute paths, nulls, traversal and root', () => {
  for (const path of ['C:\\outside.md', '../x', 'folder/../x', '\u0000file', '/', './']) assert.throws(() => normalizePath(path));
  assert.equal(normalizePath('./Folder\\Note.md'), 'Folder/Note.md');
});

test('host compare-and-write is preferred and conflict does not publish a snapshot', async () => {
  class AtomicAdapter extends MemoryAdapter {
    comparisons: string[][] = [];
    async compareAndWrite(path: string, expected: string, content: string) {
      this.comparisons.push([path, expected, content]);
      if (await super.read(path) !== expected) throw new Error('File changed outside this editor');
      await super.write(path, content);
    }
    async write(): Promise<void> { throw new Error('ordinary write must not run'); }
  }
  const adapter = new AtomicAdapter({ 'One.md': '# Old' });
  const vault = new Vault(adapter); await vault.initialize();
  const changes: string[] = []; vault.on('modify', change => changes.push(change.path));
  await assert.rejects(vault.modify('One.md', '# Bad', { expectedContent: 'stale' }), /outside this editor/);
  assert.deepEqual(changes, []);
  assert.equal(await vault.read('One.md'), '# Old');
  assert.equal(vault.metadata.get('One.md')?.headings[0].heading, 'Old');
  await vault.modify('One.md', '# New', { expectedContent: '# Old' });
  assert.equal(await vault.read('One.md'), '# New');
  assert.deepEqual(changes, ['One.md']);
  assert.deepEqual(adapter.comparisons, [['One.md', 'stale', '# Bad'], ['One.md', '# Old', '# New']]);
});

test('failed readback after successful host comparison preserves unpublished snapshot', async () => {
  class AtomicAdapter extends MemoryAdapter {
    failRead = false;
    async compareAndWrite(path: string, _expected: string, content: string) { await super.write(path, content); this.failRead = true; }
    async read(path: string) { if (this.failRead) throw new Error('readback unavailable'); return super.read(path); }
  }
  const adapter = new AtomicAdapter({ 'One.md': '# Old' });
  const vault = new Vault(adapter); await vault.initialize();
  const changes: string[] = []; vault.on('modify', change => changes.push(change.path));
  await assert.rejects(vault.modify('One.md', '# New', { expectedContent: '# Old' }), /readback unavailable/);
  assert.deepEqual(changes, []); assert.equal(vault.metadata.get('One.md')?.headings[0].heading, 'Old');
  adapter.failRead = false; assert.equal(await adapter.read('One.md'), '# New');
});


test('full reload sees mixed structural and same-stat binary changes by opaque revision', async () => {
  class RevisionAdapter extends MemoryAdapter {
    revision = 'opaque-first';
    async list() {
      return (await super.list()).map(entry => ({ ...entry, mtime: 10,
        revision: entry.path === 'image.bin' ? this.revision : 'structural' }));
    }
  }
  const adapter = new RevisionAdapter();
  await adapter.writeBinary('image.bin', new Uint8Array([1, 2]));
  const vault = new Vault(adapter);
  await vault.initialize();
  const modified: string[] = [], created: string[] = [];
  vault.on('modify', change => modified.push(change.path));
  vault.on('create', change => created.push(change.path));
  await adapter.mkdir('New folder');
  await adapter.writeBinary('image.bin', new Uint8Array([3, 4]));
  adapter.revision = 'opaque-second';
  await vault.reload();
  assert.deepEqual(created, ['New folder']);
  assert.deepEqual(modified, ['image.bin']);
  assert.deepEqual(await vault.readBinary('image.bin'), new Uint8Array([3, 4]));
  await vault.reload();
  assert.deepEqual(modified, ['image.bin']);
  // A new incarnation at the same spelling is also a new opaque revision.
  await adapter.trash('image.bin');
  await adapter.writeBinary('image.bin', new Uint8Array([5, 6]));
  adapter.revision = 'another-incarnation';
  await vault.reload();
  assert.deepEqual(modified, ['image.bin', 'image.bin']);
});

test('legacy adapters without revisions retain metadata-based binary reload behavior', async () => {
  class LegacyAdapter extends MemoryAdapter {
    stamp = 10;
    async list() { return (await super.list()).map(entry => ({ ...entry, mtime: this.stamp })); }
  }
  const adapter = new LegacyAdapter();
  await adapter.writeBinary('image.bin', new Uint8Array([1, 2]));
  const vault = new Vault(adapter);
  await vault.initialize();
  const modified: string[] = [];
  vault.on('modify', change => modified.push(change.path));
  await vault.reload();
  assert.deepEqual(modified, []);
  await adapter.writeBinary('image.bin', new Uint8Array([3, 4]));
  adapter.stamp = 11;
  await vault.reload();
  assert.deepEqual(modified, ['image.bin']);
});
