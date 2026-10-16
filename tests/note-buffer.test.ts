import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import type { StorageLike } from '../src/ui/note-buffer.ts';

class Storage implements StorageLike {
  values = new Map<string, string>();
  writes = 0;
  removals = 0;
  writtenCharacters = 0;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.writes++; this.writtenCharacters += value.length; this.values.set(key, value); }
  removeItem(key: string): void { this.removals++; this.values.delete(key); }
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

test('distinct edits remain immediately recoverable while duplicate snapshots reuse checkpoint and base encoding', async t => {
  const base = 'base"\\\n😀\ud800'.repeat(16_384);
  const {note, storage} = await setup(new MemoryAdapter({'One.md': base}));
  const values = Array.from({length: 16}, (_, index) => base + String(index));
  const encoded: unknown[] = [];
  const stringify = JSON.stringify;
  const mock = t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
    encoded.push(args[0]); return stringify(...args);
  });
  try {
    for (const value of values) {
      note.update(value);
      // Recoverability is checked before timers/microtasks or explicit flush.
      assert.deepEqual(JSON.parse(storage.getItem('test-vault:One.md')!), {base, content: value});
      note.update(value); note.update(value);
    }
  } finally { mock.mock.restore(); }
  assert.equal(storage.writes, values.length);
  assert.deepEqual(encoded, [base, ...values], 'the stable saved base is encoded once, each distinct edit once');
  assert.equal(storage.writtenCharacters, values.reduce((count, content) => count + stringify({base, content}).length, 0));
  // A fresh buffer can recover before the original buffer ever saves to disk.
  const restarted = await setup(new MemoryAdapter({'One.md': base}), storage);
  assert.equal(restarted.note.text, values.at(-1));
  restarted.note.update(values.at(-1)!);
  assert.equal(storage.writes, values.length, 'the recovered checkpoint is already durable');
  await restarted.note.dispose();
  await note.dispose();
});

test('duplicate updates do not postpone autosave and disposal leaves no pending timer', async t => {
  const {note, vault, storage, adapter} = await setup();
  t.mock.timers.enable({apis: ['setTimeout']});
  let saves = 0;
  vault.on('modify', () => saves++);
  note.update('first');
  t.mock.timers.tick(30_000);
  note.update('first');
  t.mock.timers.tick(30_000);
  // Drain the in-memory adapter's promise chain without advancing a wall clock.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(await adapter.read('One.md'), 'first');
  assert.equal(saves, 1);
  assert.equal(storage.writes, 1);
  assert.equal(storage.removals, 1);
  note.update('second');
  await note.dispose();
  t.mock.timers.tick(120_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(saves, 2);
  assert.equal(storage.values.size, 0);
  assert.throws(() => note.update('late'), /disposed/);
});

test('failed recovery writes retry identical snapshots and explicit flush or close before failed disk I/O', async () => {
  for (const boundary of ['update', 'flush', 'dispose'] as const) {
    class FailingStorage extends Storage {
      fail = true;
      attempts = 0;
      setItem(key: string, value: string): void {
        this.attempts++;
        if (this.fail) throw new Error('recovery quota');
        super.setItem(key, value);
      }
    }
    class FailingAdapter extends MemoryAdapter {
      fail = true;
      async write(path: string, content: string): Promise<void> {
        if (this.fail) throw new Error('disk full');
        await super.write(path, content);
      }
    }
    const storage = new FailingStorage(), adapter = new FailingAdapter({'One.md': 'initial'});
    const {note} = await setup(adapter, storage);
    note.update('valuable');
    assert.equal(note.error?.message, 'recovery quota');
    assert.equal(storage.values.size, 0);
    storage.fail = false;
    if (boundary === 'update') note.update('valuable');
    else await assert.rejects(note[boundary](), /disk full/);
    assert.equal(storage.attempts, 2, 'failed checkpoints are not mistaken for persisted snapshots');
    assert.deepEqual(storage.draft(), {base: 'initial', content: 'valuable'});
    await assert.rejects(note.dispose(), /disk full/);
    assert.equal(storage.attempts, 2, 'successful recovery is not rewritten by another failed close');
    const restarted = await setup(new MemoryAdapter({'One.md': 'initial'}), storage);
    assert.equal(restarted.note.text, 'valuable');
    await restarted.note.dispose();
    adapter.fail = false;
    await note.dispose();
    assert.equal(storage.values.size, 0);
  }
});

test('clean checkpoint removal is deduplicated but failed removal is retried at flush', async () => {
  class FailingRemoval extends Storage {
    fail = true;
    attempts = 0;
    removeItem(key: string): void {
      this.attempts++;
      if (this.fail) throw new Error('recovery removal failed');
      super.removeItem(key);
    }
  }
  const storage = new FailingRemoval(), {note} = await setup(undefined, storage);
  note.update('saved');
  await note.flush();
  assert.equal(note.dirty, false);
  assert.equal(note.error?.message, 'recovery removal failed');
  assert.equal(storage.values.size, 1);
  storage.fail = false;
  await note.flush();
  assert.equal(storage.values.size, 0);
  assert.equal(storage.attempts, 2);
  note.update('saved'); note.update('saved');
  await note.flush(); await note.dispose();
  assert.equal(storage.attempts, 2);
});

test('recovery checkpoint advances its base between overlapping saves', async () => {
  const firstStarted = deferred(), firstRelease = deferred(), secondStarted = deferred(), secondRelease = deferred();
  class SlowAdapter extends MemoryAdapter {
    count = 0;
    async write(path: string, content: string): Promise<void> {
      if (++this.count === 1) { firstStarted.resolve(); await firstRelease.promise; }
      else { secondStarted.resolve(); await secondRelease.promise; }
      await super.write(path, content);
    }
  }
  const {note, storage} = await setup(new SlowAdapter({'One.md': 'initial'}));
  note.update('first');
  const saving = note.flush();
  await firstStarted.promise;
  note.update('second');
  firstRelease.resolve();
  await secondStarted.promise;
  assert.deepEqual(storage.draft(), {base: 'first', content: 'second'});
  assert.equal(storage.writes, 3, 'new saved base requires a new checkpoint even with unchanged current text');
  secondRelease.resolve();
  await saving;
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
  assert.equal(storage.writes, 2, 'the path change requires a new checkpoint; its second persist is redundant');
  await note.relocate('Two.md');
  assert.equal(storage.writes, 2, 'duplicate path notifications reuse the durable checkpoint');
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
