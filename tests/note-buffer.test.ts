import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import type { StorageLike } from '../src/ui/note-buffer.ts';

class Storage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  draft(): {base: string; content: string} | undefined {
    const raw = this.values.values().next().value;
    return raw ? JSON.parse(raw) : undefined;
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(adapter = new MemoryAdapter({ 'One.md': 'initial' }), storage = new Storage()) {
  const vault = new Vault(adapter);
  await vault.initialize();
  const note = new NoteBuffer(vault, 'One.md', { storage, storageKey: 'test-vault', debounceMs: 60_000 });
  await note.load();
  return { note, vault, adapter, storage };
}

test('edits immediately recover to storage; flush persists and clears the draft', async () => {
  const {note, storage, vault} = await setup();
  note.update('changed');
  assert.equal(note.dirty, true);
  assert.deepEqual(storage.draft(), { base: 'initial', content: 'changed' });
  assert.equal(await vault.read('One.md'), 'initial');
  await note.flush();
  assert.equal(await vault.read('One.md'), 'changed');
  assert.equal(note.savedText, 'changed');
  assert.equal(note.dirty, false);
  assert.equal(storage.values.size, 0);
  await note.dispose();
});

test('typing and concurrent flushes during a slow write preserve the newest text', async () => {
  const started = deferred(), release = deferred();
  class SlowAdapter extends MemoryAdapter {
    writes: string[] = [];
    async write(path: string, content: string): Promise<void> {
      this.writes.push(content);
      if (this.writes.length === 1) { started.resolve(); await release.promise; }
      await super.write(path, content);
    }
  }
  const adapter = new SlowAdapter({ 'One.md': 'initial' });
  const {note, storage} = await setup(adapter);
  note.update('first');
  const saving = note.flush();
  await started.promise;
  note.update('second');
  const anotherFlush = note.flush();
  assert.deepEqual(storage.draft(), { base: 'initial', content: 'second' });
  release.resolve();
  await Promise.all([saving, anotherFlush]);
  assert.deepEqual(adapter.writes, ['first', 'second']);
  assert.equal(await adapter.read('One.md'), 'second');
  assert.equal(note.text, 'second');
  assert.equal(note.dirty, false);
  await note.dispose();
});

test('reverting to the old base during an in-flight save is itself persisted', async () => {
  const started = deferred(), release = deferred();
  class SlowAdapter extends MemoryAdapter {
    async write(path: string, content: string): Promise<void> {
      if (content === 'first') { started.resolve(); await release.promise; }
      await super.write(path, content);
    }
  }
  const {note, adapter} = await setup(new SlowAdapter({ 'One.md': 'initial' }));
  note.update('first');
  const saving = note.flush();
  await started.promise;
  note.update('initial');
  release.resolve();
  await saving;
  assert.equal(await adapter.read('One.md'), 'initial');
  assert.equal(note.dirty, false);
  await note.dispose();
});

test('failed writes retain drafts and a later flush can retry', async () => {
  class FailingAdapter extends MemoryAdapter {
    fail = true;
    async write(path: string, content: string): Promise<void> {
      if (this.fail) throw new Error('disk full');
      await super.write(path, content);
    }
  }
  const adapter = new FailingAdapter({ 'One.md': 'initial' });
  const {note, storage} = await setup(adapter);
  note.update('valuable');
  await assert.rejects(note.flush(), /disk full/);
  assert.equal(note.error?.message, 'disk full');
  assert.equal(note.savedText, 'initial');
  assert.deepEqual(storage.draft(), {base: 'initial', content: 'valuable'});
  adapter.fail = false;
  await note.flush();
  assert.equal(await adapter.read('One.md'), 'valuable');
  assert.equal(note.error, null);
  await note.dispose();
});

test('reload follows disk when clean and preserves edits on external conflict', async () => {
  const {note, adapter, storage} = await setup();
  await adapter.write('One.md', 'external');
  await note.reload();
  assert.equal(note.text, 'external');
  note.update('local');
  await adapter.write('One.md', 'another external');
  await assert.rejects(note.reload(), /outside this editor/);
  await assert.rejects(note.flush(), /outside this editor/);
  assert.equal(note.text, 'local');
  assert.equal(await adapter.read('One.md'), 'another external');
  assert.deepEqual(storage.draft(), {base: 'external', content: 'local'});
  await assert.rejects(note.dispose(), /outside this editor/);
});

test('recovery restores matching-base edits and refuses to overwrite mismatched disk', async () => {
  for (const disk of ['initial', 'external']) {
    const storage = new Storage();
    storage.setItem('test-vault:One.md', JSON.stringify({base: 'initial', content: 'recovered'}));
    const {note, adapter} = await setup(new MemoryAdapter({'One.md': disk}), storage);
    assert.equal(note.text, 'recovered');
    assert.equal(note.dirty, true);
    if (disk === 'initial') {
      assert.equal(note.error, null);
      await note.flush();
      assert.equal(await adapter.read('One.md'), 'recovered');
      await note.dispose();
    } else {
      assert.match(note.error!.message, /recovery draft preserved/);
      await assert.rejects(note.flush(), /outside this editor/);
      assert.equal(await adapter.read('One.md'), 'external');
      assert.deepEqual(storage.draft(), {base: 'initial', content: 'recovered'});
      await assert.rejects(note.dispose(), /outside this editor/);
    }
  }
});

test('rename flushes first and reads link changes back into the editor', async () => {
  const {note, vault, storage} = await setup();
  note.update('[[One]]');
  await note.rename('Two.md');
  assert.equal(note.path, 'Two.md');
  assert.equal(note.text, '[[Two]]');
  assert.equal(await vault.read('Two.md'), '[[Two]]');
  assert.equal(vault.entries.has('One.md'), false);
  note.update('after rename');
  assert.equal(storage.values.has('test-vault:Two.md'), true);
  assert.equal(storage.values.has('test-vault:One.md'), false);
  await note.dispose();
  assert.equal(await vault.read('Two.md'), 'after rename');
  assert.throws(() => note.update('too late'), /disposed/);
});

test('debounced autosave reports failure without an unhandled rejection', async () => {
  class FailingAdapter extends MemoryAdapter {
    async write(): Promise<void> { throw new Error('unwritable'); }
  }
  const vault = new Vault(new FailingAdapter({'One.md': 'initial'}));
  await vault.initialize();
  const failed = deferred(), storage = new Storage();
  const note = new NoteBuffer(vault, 'One.md', {storage, debounceMs: 0, onState: () => {
    if (note.error) failed.resolve();
  }});
  await note.load();
  note.update('recover me');
  await failed.promise;
  assert.equal(note.error?.message, 'unwritable');
  assert.equal(storage.draft()?.content, 'recover me');
  await assert.rejects(note.dispose(), /unwritable/);
});

test('typing during a slow reload is not replaced by the read result', async () => {
  const started = deferred(), release = deferred();
  class SlowAdapter extends MemoryAdapter {
    slow = false;
    async read(path: string): Promise<string> {
      const text = await super.read(path);
      if (this.slow) { this.slow = false; started.resolve(); await release.promise; }
      return text;
    }
  }
  const adapter = new SlowAdapter({'One.md': 'initial'});
  const {note} = await setup(adapter);
  await adapter.write('One.md', 'external');
  adapter.slow = true;
  const reloading = note.reload();
  await started.promise;
  note.update('late local');
  release.resolve();
  await assert.rejects(reloading, /outside this editor/);
  assert.equal(note.text, 'late local');
  await assert.rejects(note.dispose(), /outside this editor/);
});

test('late edits during rename migrate their recovery draft and save at the new path', async () => {
  const started = deferred(), release = deferred();
  class SlowAdapter extends MemoryAdapter {
    async rename(from: string, to: string): Promise<void> {
      started.resolve();
      await release.promise;
      await super.rename(from, to);
    }
  }
  const {note, adapter, storage} = await setup(new SlowAdapter({'One.md': 'initial'}));
  const renaming = note.rename('Two.md');
  await started.promise;
  note.update('late local');
  release.resolve();
  await renaming;
  assert.equal(note.path, 'Two.md');
  assert.equal(note.text, 'late local');
  assert.equal(note.dirty, true);
  assert.equal(storage.values.has('test-vault:Two.md'), true);
  assert.equal(storage.values.has('test-vault:One.md'), false);
  await note.dispose();
  assert.equal(await adapter.read('Two.md'), 'late local');
});

test('relocate adopts folder moves and refreshes rewritten links in a clean buffer', async () => {
  const adapter = new MemoryAdapter({ 'Folder/One.md': '[root](../Root.md)', 'Root.md': '', 'Destination/Keep.md': '' });
  const vault = new Vault(adapter);
  await vault.initialize();
  const note = new NoteBuffer(vault, 'Folder/One.md');
  await note.load();
  await vault.rename('Folder', 'Destination/Moved');
  await note.relocate('Destination/Moved/One.md');
  assert.equal(note.path, 'Destination/Moved/One.md');
  assert.equal(note.text, '[root](../../Root.md)');
  assert.equal(note.savedText, note.text);
  assert.equal(note.dirty, false);
  await note.dispose();
});

test('relocate migrates a dirty draft and preserves conflict when rename rewrites its base', async () => {
  const adapter = new MemoryAdapter({ 'Folder/One.md': '[root](../Root.md)', 'Root.md': '', 'Destination/Keep.md': '' });
  const vault = new Vault(adapter), storage = new Storage();
  await vault.initialize();
  const note = new NoteBuffer(vault, 'Folder/One.md', {storage, storageKey: 'test-vault', debounceMs: 60_000});
  await note.load();
  note.update('precious draft');
  await vault.rename('Folder', 'Destination/Moved');
  await note.relocate('Destination/Moved/One.md');
  assert.equal(note.text, 'precious draft');
  assert.equal(note.savedText, '[root](../Root.md)');
  assert.match(note.error!.message, /draft preserved/);
  assert.equal(storage.values.has('test-vault:Folder%2FOne.md'), false);
  assert.deepEqual(JSON.parse(storage.getItem('test-vault:Destination%2FMoved%2FOne.md')!), {base: '[root](../Root.md)', content: 'precious draft'});
  await assert.rejects(note.dispose(), /outside this editor/);
  const recovered = new NoteBuffer(vault, note.path, {storage, storageKey: 'test-vault'});
  await recovered.load();
  assert.equal(recovered.text, 'precious draft');
  assert.match(recovered.error!.message, /recovery draft preserved/);
  await assert.rejects(recovered.dispose(), /outside this editor/);
});

test('relocate with unchanged disk base allows dirty text to save under the new path', async () => {
  const {note, vault, storage} = await setup();
  note.update('new draft');
  await vault.rename('One.md', 'Two.md');
  await note.relocate('Two.md');
  assert.equal(note.error, null);
  assert.equal(storage.values.has('test-vault:One.md'), false);
  assert.equal(storage.values.has('test-vault:Two.md'), true);
  await note.dispose();
  assert.equal(await vault.read('Two.md'), 'new draft');
});

test('relocation queued by the buffer own rename event completes without a second rename', async () => {
  const {note, vault} = await setup();
  let relocation: Promise<void> | undefined;
  let events = 0;
  vault.on('rename', change => { events++; relocation = note.relocate(change.path); });
  await note.rename('Two.md');
  await relocation;
  assert.equal(events, 1);
  assert.equal(note.path, 'Two.md');
  assert.equal(note.text, 'initial');
  await note.dispose();
});
