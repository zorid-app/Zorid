import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';

test('low-level folder rename preserves note bytes, rebuilds metadata and publishes a coherent event', async () => {
  const incoming = '[[Folder/One]] [one](Folder/One.md)';
  const outgoing = '[root](../Root.md) [[#Heading]]';
  const adapter = new MemoryAdapter({ 'Root.md': incoming, 'Folder/One.md': outgoing, 'Destination/Keep.md': '' });
  const vault = new Vault(adapter); await vault.initialize();
  const changes: string[] = [];
  let snapshot: unknown;
  vault.on('modify', change => changes.push(`modify:${change.path}`));
  vault.on('rename', change => {
    changes.push(`rename:${change.oldPath}:${change.path}`);
    snapshot = {
      oldEntry: vault.entries.has('Folder/One.md'), newEntry: vault.entries.has('Destination/Moved/One.md'),
      oldMetadata: vault.metadata.get('Folder/One.md'), newMetadata: !!vault.metadata.get('Destination/Moved/One.md'),
      incoming: vault.metadata.backlinks('Destination/Moved/One.md').filter(link => link.source === 'Root.md').length,
    };
  });
  await vault.renameEntry('Folder', 'Destination/Moved');
  assert.equal(await vault.cachedRead('Root.md'), incoming);
  assert.equal(await vault.cachedRead('Destination/Moved/One.md'), outgoing);
  assert.deepEqual(changes, ['rename:Folder:Destination/Moved']);
  assert.deepEqual(snapshot, { oldEntry: false, newEntry: true, oldMetadata: undefined, newMetadata: true, incoming: 0 });
});

test('low-level rename validates boundaries and conflicts before touching storage', async () => {
  class TrackedAdapter extends MemoryAdapter {
    moves = 0;
    override async rename(from: string, to: string) { this.moves++; return super.rename(from, to); }
  }
  const adapter = new TrackedAdapter({ 'One.md': 'one', 'Two.md': 'two', 'Folder/Inner/Note.md': 'note' });
  const vault = new Vault(adapter); await vault.initialize();
  await assert.rejects(vault.renameEntry('One.md', '../escape.md'), /escape/);
  await assert.rejects(vault.renameEntry('One.md', 'Two.md'), /already exists/);
  await assert.rejects(vault.renameEntry('Folder', 'Folder/Inner/Moved'), /inside itself/);
  await assert.rejects(vault.renameEntry('Missing.md', 'New.md'), /does not exist/);
  await vault.renameEntry('One.md', 'One.md');
  assert.equal(adapter.moves, 0);
  assert.equal(await vault.read('One.md'), 'one');
});

test('low-level rename serializes following writes and rejection leaves the queue usable', async () => {
  class RejectingAdapter extends MemoryAdapter {
    override async rename(from: string, to: string) {
      if (to === 'Blocked.md') throw new Error('move denied');
      return super.rename(from, to);
    }
  }
  const vault = new Vault(new RejectingAdapter({ 'One.md': '# Original' })); await vault.initialize();
  const events: string[] = [];
  vault.on('rename', change => events.push(change.path));
  await assert.rejects(vault.renameEntry('One.md', 'Blocked.md'), /move denied/);
  assert.equal(vault.metadata.get('One.md')?.headings[0].heading, 'Original');
  assert.deepEqual(events, []);
  await Promise.all([vault.renameEntry('One.md', 'Moved.md'), vault.modify('Moved.md', '# Edited')]);
  assert.equal(await vault.cachedRead('Moved.md'), '# Edited');
  assert.deepEqual(events, ['Moved.md']);
});

test('permanent deletion rejects unsupported adapters without silently trashing', async () => {
  class TrackedAdapter extends MemoryAdapter {
    trashed = false;
    override async trash(path: string) { this.trashed = true; return super.trash(path); }
  }
  const adapter = new TrackedAdapter({ 'Keep.md': '# Keep' });
  const vault = new Vault(adapter); await vault.initialize();
  const events: string[] = []; vault.on('delete', change => events.push(change.path));
  await assert.rejects(vault.deleteEntry('Keep.md'), /does not support permanent deletion/);
  assert.equal(adapter.trashed, false);
  assert.equal(await vault.cachedRead('Keep.md'), '# Keep');
  assert.deepEqual(events, []);
});

test('permanent deletion passes hidden-child policy to host and publishes descendant removals', async () => {
  class RemovingAdapter extends MemoryAdapter {
    removals: [string, boolean][] = [];
    async remove(path: string, force: boolean) {
      this.removals.push([path, force]);
      // Model a host-only hidden child omitted from the public inventory.
      if (path === 'Folder' && !force) throw new Error('folder contains hidden children');
      await super.trash(path);
    }
    override async trash(): Promise<void> { throw new Error('trash must not run'); }
  }
  const adapter = new RemovingAdapter({ 'Folder/One.md': '# One', 'Keep.md': '# Keep' });
  const vault = new Vault(adapter); await vault.initialize();
  const removed: string[] = [];
  const visibleDuringEvent: boolean[] = [];
  vault.on('delete', change => {
    removed.push(change.path);
    visibleDuringEvent.push(vault.entries.has(change.path) || !!vault.metadata.get(change.path));
  });
  await assert.rejects(vault.deleteEntry('Folder'), /hidden children/);
  assert.deepEqual(removed, []);
  assert.ok(vault.entries.has('Folder/One.md'));
  await vault.deleteEntry('Folder', true);
  assert.deepEqual(adapter.removals, [['Folder', false], ['Folder', true]]);
  assert.deepEqual(removed, ['Folder', 'Folder/One.md']);
  assert.deepEqual(visibleDuringEvent, [false, false]);
  assert.equal(await vault.cachedRead('Keep.md'), '# Keep');
});
