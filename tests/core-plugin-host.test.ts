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

test('execution-time guards reject stale handles after queued deletion and replacement', async () => {
  const actions = [
    (vault: Vault, validate: () => void) => vault.modify('One.md', 'corrupt', { validate }),
    (vault: Vault, validate: () => void) => vault.modifyBinary('One.md', new TextEncoder().encode('corrupt'), { validate }),
    (vault: Vault, validate: () => void) => vault.renameEntry('One.md', 'Moved.md', validate),
    (vault: Vault, validate: () => void) => vault.deleteEntry('One.md', false, validate),
    (vault: Vault, validate: () => void) => vault.trash('One.md', validate),
    (vault: Vault, validate: () => void) => vault.read('One.md', validate),
    (vault: Vault, validate: () => void) => vault.readBinary('One.md', validate),
    (vault: Vault, validate: () => void) => vault.cachedRead('One.md', validate),
  ];
  for (const action of actions) {
    const adapter = new MemoryAdapter({ 'One.md': 'original' });
    const vault = new Vault(adapter); await vault.initialize();
    let stale = false;
    vault.on('delete', () => { stale = true; });
    const validate = () => { if (stale) throw new Error('stale handle'); };
    const deletion = vault.trash('One.md');
    const replacement = vault.create('One.md', 'replacement');
    const guarded = action(vault, validate);
    await assert.rejects(guarded, /stale handle/);
    await Promise.all([deletion, replacement]);
    assert.equal(await vault.read('One.md'), 'replacement');
    assert.equal(vault.entries.has('Moved.md'), false);
    await vault.modify('One.md', 'next edit');
    assert.equal(await vault.read('One.md'), 'next edit');
  }
});

test('link-updating rename revalidates caller policy against the freshly read destination inventory', async () => {
  class DestinationAppearsAdapter extends MemoryAdapter {
    injectDestination = false;
    moves = 0;
    override async list() {
      if (this.injectDestination) {
        this.injectDestination = false;
        await super.write('Renamed.md', 'external destination');
      }
      return super.list();
    }
    override async rename(from: string, to: string) { this.moves++; return super.rename(from, to); }
  }
  const adapter = new DestinationAppearsAdapter({ 'One.md': '# Original', 'Link.md': '[[One]]' });
  const vault = new Vault(adapter); await vault.initialize();
  adapter.injectDestination = true;
  let validations = 0;
  await assert.rejects(vault.rename('One.md', 'renamed.md', () => {
    validations++;
    if ([...vault.entries.keys()].some(path => path.normalize('NFC').toLocaleLowerCase() === 'renamed.md')) {
      throw new Error('case-insensitive destination conflict');
    }
  }), /case-insensitive destination conflict/);
  assert.equal(validations, 2);
  assert.equal(adapter.moves, 0);
  assert.equal(await vault.read('One.md'), '# Original');
  assert.equal(await vault.read('Link.md'), '[[One]]');
  assert.equal(await vault.read('Renamed.md'), 'external destination');
  // No global case-insensitive rename restriction: callers choose their policy.
  await vault.rename('One.md', 'ONE.md');
  assert.equal(await vault.read('ONE.md'), '# Original');
  assert.equal(await vault.read('Link.md'), '[[ONE]]');
});

test('link-updating rename rejects a queued stale source before refreshing or mutating it', async () => {
  const adapter = new MemoryAdapter({ 'One.md': '# Original', 'Link.md': '[[One]]' });
  const vault = new Vault(adapter); await vault.initialize();
  let stale = false;
  vault.on('delete', () => { stale = true; });
  const deletion = vault.trash('One.md');
  const replacement = vault.create('One.md', '# Replacement');
  const rename = vault.rename('One.md', 'Moved.md', () => { if (stale) throw new Error('stale drag source'); });
  await assert.rejects(rename, /stale drag source/);
  await Promise.all([deletion, replacement]);
  assert.equal(await vault.read('One.md'), '# Replacement');
  assert.equal(await vault.read('Link.md'), '[[One]]');
  assert.equal(vault.entries.has('Moved.md'), false);
});

test('folder creation applies caller collision policy inside the queue against fresh entries', async () => {
  class TrackedAdapter extends MemoryAdapter {
    folders: string[] = [];
    override async mkdir(path: string) { this.folders.push(path); return super.mkdir(path); }
  }
  const adapter = new TrackedAdapter();
  const vault = new Vault(adapter); await vault.initialize();
  const first = vault.createFolder('UNTITLED FOLDER');
  const alias = vault.createFolder('Untitled folder', () => {
    if ([...vault.entries.keys()].some(path => path.normalize('NFC').toLowerCase() === 'untitled folder')) {
      throw new Error('folder alias collision');
    }
  });
  await assert.rejects(alias, /folder alias collision/);
  await first;
  assert.deepEqual(adapter.folders, ['UNTITLED FOLDER']);
  assert.equal(vault.entries.has('Untitled folder'), false);
});

test('folder creation rechecks refreshed parent policy before mkdir', async () => {
  class ParentChangesAdapter extends MemoryAdapter {
    invalidateParent = false;
    folders: string[] = [];
    override async list() {
      if (this.invalidateParent) {
        this.invalidateParent = false;
        await super.trash('Parent');
        await super.mkdir('Parent');
        parentCurrent = false;
      }
      return super.list();
    }
    override async mkdir(path: string) { this.folders.push(path); return super.mkdir(path); }
  }
  let parentCurrent = true;
  const adapter = new ParentChangesAdapter({ 'Parent/Keep.md': 'keep' });
  const vault = new Vault(adapter); await vault.initialize();
  adapter.invalidateParent = true;
  let validations = 0;
  await assert.rejects(vault.createFolder('Parent/New', () => {
    validations++;
    if (!parentCurrent) throw new Error('parent lifetime changed');
  }), /parent lifetime changed/);
  assert.equal(validations, 2);
  assert.deepEqual(adapter.folders, []);
  assert.equal(vault.entries.has('Parent/New'), false);
  await vault.createFolder('Parent/Next');
  assert.ok(vault.entries.has('Parent/Next'));
});
