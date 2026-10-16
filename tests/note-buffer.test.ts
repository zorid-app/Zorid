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
  draft(): {base: string; content: string; pending?: string} | undefined {
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
async function restartSnapshot(adapter: MemoryAdapter, storage: Storage) {
  // A crash snapshot has independent disk/storage and no surviving writer.
  const copied = new Storage(); copied.values = new Map(storage.values);
  return setup(new MemoryAdapter({'One.md': await adapter.read('One.md')}), copied);
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
  assert.equal(storage.writes, 2, 'one edit checkpoint plus one durable write intent');
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
    assert.deepEqual(storage.draft(), {base: 'initial', content: 'valuable', ...(boundary === 'update' ? {} : {pending: 'valuable'})});
    await assert.rejects(note.dispose(), /disk full/);
    assert.equal(storage.attempts, boundary === 'update' ? 3 : 2, 'only a new write intent requires another checkpoint');
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
  assert.deepEqual(storage.draft(), {base: 'first', content: 'second', pending: 'second'});
  assert.equal(storage.writes, 5, 'new saved base and each write intent require checkpoints');
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
  assert.deepEqual(storage.draft(), { base: 'initial', content: 'second', pending: 'first' });
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

test('revert and overlapping input recover at every interrupted write boundary', async t => {
  const gates = Array.from({length: 2}, () => ({before: deferred(), write: deferred(), after: deferred(), finish: deferred()}));
  class PausedAdapter extends MemoryAdapter {
    writes = 0;
    async write(path: string, content: string): Promise<void> {
      const gate = gates[this.writes++];
      if (gate) { gate.before.resolve(); await gate.write.promise; }
      await super.write(path, content);
      if (gate) { gate.after.resolve(); await gate.finish.promise; }
    }
  }
  const {note, adapter, storage} = await setup(new PausedAdapter({'One.md': 'initial'}));
  t.after(async () => { for (const gate of gates) { gate.write.resolve(); gate.finish.resolve(); } await note.dispose(); });
  const assertRestart = async (expectedDisk: string, expectedText: string) => {
    const restarted = await restartSnapshot(adapter, storage);
    assert.equal(restarted.note.text, expectedText);
    assert.equal(restarted.note.savedText, expectedDisk);
    assert.equal(restarted.note.dirty, expectedText !== expectedDisk);
    assert.equal(restarted.note.error, null);
    await restarted.note.dispose();
    assert.equal(await restarted.adapter.read('One.md'), expectedText);
    assert.equal(restarted.storage.values.size, 0);
  };
  note.update('first');
  const saving = note.flush();
  await gates[0].before.promise;
  note.update('initial');
  assert.equal(note.dirty, true, 'the outstanding write still needs reconciliation after reverting');
  assert.deepEqual(storage.draft(), {base: 'initial', content: 'initial', pending: 'first'});
  await assertRestart('initial', 'initial'); // Writer has not changed disk yet.
  gates[0].write.resolve(); await gates[0].after.promise;
  await assertRestart('first', 'initial'); // Disk changed; modify has not completed.
  note.update('second');
  await assertRestart('first', 'second');
  note.update('initial');
  gates[0].finish.resolve(); await gates[1].before.promise;
  assert.deepEqual(storage.draft(), {base: 'first', content: 'initial', pending: 'initial'});
  await assertRestart('first', 'initial'); // First write confirmed; revert write pending.
  gates[1].write.resolve(); await gates[1].after.promise;
  await assertRestart('initial', 'initial'); // Revert reached disk; cleanup not yet run.
  note.update('latest');
  await assertRestart('initial', 'latest');
  gates[1].finish.resolve(); await saving;
  assert.equal(await adapter.read('One.md'), 'latest');
  assert.equal(note.dirty, false);
  assert.equal(storage.values.size, 0);
});

test('failed writes before and after disk mutation retain the reverted draft until retry resolves the outcome', async () => {
  for (const committed of [false, true]) {
    const started = deferred(), release = deferred();
    class FailingWrite extends MemoryAdapter {
      fail = true;
      writes = 0;
      async write(path: string, content: string): Promise<void> {
        this.writes++;
        if (this.fail) {
          started.resolve(); await release.promise;
          if (committed) await super.write(path, content);
          throw new Error('write interrupted');
        }
        await super.write(path, content);
      }
    }
    const {note, adapter, storage} = await setup(new FailingWrite({'One.md': 'initial'}));
    note.update('first');
    const saving = note.flush();
    const rejected = assert.rejects(saving, /write interrupted/);
    await started.promise;
    note.update('initial'); release.resolve(); await rejected;
    assert.equal(note.dirty, true);
    assert.deepEqual(storage.draft(), {base: 'initial', content: 'initial', pending: 'first'});
    const restarted = await restartSnapshot(adapter, storage);
    assert.equal(restarted.note.text, 'initial');
    assert.equal(restarted.note.savedText, committed ? 'first' : 'initial');
    assert.equal(restarted.note.dirty, committed);
    assert.equal(restarted.note.error, null);
    await restarted.note.dispose();
    adapter.fail = false;
    await note.flush();
    assert.equal(adapter.writes, committed ? 2 : 1, 'retry writes only when disk differs from the latest text');
    assert.equal(await adapter.read('One.md'), 'initial');
    assert.equal(storage.values.size, 0);
    await note.dispose();
  }
});

test('interrupted reverted drafts detect a third disk snapshot and cannot be cleared by no-op input or close', async () => {
  const storage = new Storage();
  const draft = {base: 'aaaa', content: 'aaaa', pending: 'bbbb'};
  storage.setItem('test-vault:One.md', JSON.stringify(draft));
  const {note, adapter} = await setup(new MemoryAdapter({'One.md': 'cccc'}), storage);
  assert.equal(note.text, 'aaaa');
  assert.equal(note.savedText, 'aaaa');
  assert.equal(note.dirty, true, 'equal draft base/content is still unresolved against a different disk snapshot');
  assert.match(note.error!.message, /recovery draft preserved/);
  note.update('aaaa');
  await assert.rejects(note.flush(), /outside this editor/);
  await assert.rejects(note.reload(), /outside this editor/);
  await assert.rejects(note.dispose(), /outside this editor/);
  assert.deepEqual(storage.draft(), draft);
  assert.equal(await adapter.read('One.md'), 'cccc');
  // Explicit reload can resolve the conflict after the old disk base is restored.
  await adapter.write('One.md', 'aaaa');
  await note.reload();
  assert.equal(note.dirty, false);
  assert.equal(note.error, null);
  assert.equal(storage.values.size, 0);
  await note.dispose();
});

test('post-write stat failure and failed retry reads never discard unresolved recovery', async () => {
  const started = deferred(), release = deferred();
  class FailedPublication extends MemoryAdapter {
    failStat = false;
    failRead = false;
    first = true;
    async write(path: string, content: string): Promise<void> {
      if (this.first) { this.first = false; started.resolve(); await release.promise; }
      await super.write(path, content);
    }
    async stat(path: string) {
      if (this.failStat) throw new Error('stat unavailable');
      return super.stat(path);
    }
    async read(path: string) {
      if (this.failRead) throw new Error('read unavailable');
      return super.read(path);
    }
  }
  const {note, adapter, storage} = await setup(new FailedPublication({'One.md': 'initial'}));
  adapter.failStat = true;
  note.update('first');
  const saving = assert.rejects(note.flush(), /stat unavailable/);
  await started.promise; note.update('initial'); release.resolve(); await saving;
  assert.equal(await adapter.read('One.md'), 'first', 'write committed even though vault publication failed');
  const draft = {base: 'initial', content: 'initial', pending: 'first'};
  assert.deepEqual(storage.draft(), draft);
    adapter.failStat = false; adapter.failRead = true;
  await assert.rejects(note.flush(), /read unavailable/);
  assert.equal(note.dirty, true);
  assert.deepEqual(storage.draft(), draft);
  adapter.failRead = false; adapter.failStat = false;
  await note.dispose();
  assert.equal(await adapter.read('One.md'), 'initial');
  assert.equal(storage.values.size, 0);
});

test('intent recovery publishes Vault contents and metadata before becoming clean without rewriting bytes', async () => {
  for (const action of ['flush', 'reload'] as const) for (const failedPublication of ['stat', 'read'] as const) {
    class PublicationAdapter extends MemoryAdapter {
      failStat = false;
      readFailureCountdown = 0;
      writes = 0;
      async write(path: string, text: string) { this.writes++; await super.write(path, text); }
      async stat(path: string) {
        if (this.failStat) throw new Error('stat unavailable');
        return super.stat(path);
      }
      async read(path: string) {
        if (this.readFailureCountdown > 0 && --this.readFailureCountdown === 0) throw new Error('read unavailable');
        return super.read(path);
      }
    }
    const old = '# Before\n[[Before]] #old', next = '# After\n[[After]] #new';
    const {note, vault, adapter, storage} = await setup(new PublicationAdapter({'One.md': old}));
    note.update(next); adapter.failStat = true;
    await assert.rejects(note.flush(), /stat unavailable/);
    assert.equal(await adapter.read('One.md'), next);
    assert.equal(await vault.cachedRead('One.md'), old);
    assert.equal(vault.metadata.get('One.md')!.links[0].target, 'Before');
    const draft = storage.draft();
    const events: {dirty: boolean; target: string}[] = [];
    const off = vault.on('modify', () => events.push({dirty: note.dirty, target: vault.metadata.get('One.md')!.links[0].target}));
    if (failedPublication === 'read') { adapter.failStat = false; adapter.readFailureCountdown = 1; }
    await assert.rejects(note[action](), new RegExp(`${failedPublication} unavailable`));
    assert.equal(note.dirty, true);
    assert.deepEqual(storage.draft(), draft);
    assert.equal(await vault.cachedRead('One.md'), old, 'failed publication retains the previous atomic snapshot');
    assert.equal(events.length, 0);
    adapter.failStat = false;
    await note[action]();
    assert.equal(note.dirty, false);
    assert.equal(note.error, null);
    assert.equal(adapter.writes, 1, 'reconciliation publishes without rewriting already-correct bytes');
    assert.equal(await vault.cachedRead('One.md'), next);
    assert.equal(vault.metadata.get('One.md')!.links[0].target, 'After');
    assert.deepEqual(vault.metadata.get('One.md')!.tags, ['new']);
    assert.deepEqual(events, [{dirty: true, target: 'After'}], 'listeners see the complete index while the buffer remains unresolved');
    assert.equal(storage.values.size, 0);
    off(); await note.dispose();
  }
});

test('reconciling disk back to the saved base also refreshes a cache containing the attempted write', async () => {
  class PublicationAdapter extends MemoryAdapter {
    fail = false;
    writes = 0;
    async write(path: string, text: string) { this.writes++; await super.write(path, text); }
    async stat(path: string) { if (this.fail) throw new Error('stat unavailable'); return super.stat(path); }
  }
  const base = '[[Before]]', next = '[[After]]';
  const {note, adapter, vault, storage} = await setup(new PublicationAdapter({'One.md': base}));
  note.update(next); adapter.fail = true;
  await assert.rejects(note.flush(), /stat unavailable/);
  adapter.fail = false;
  await vault.reload(['One.md']); // A watcher publishes the attempted write first.
  assert.equal(await vault.cachedRead('One.md'), next);
  await MemoryAdapter.prototype.write.call(adapter, 'One.md', base); // Unobserved external revert.
  note.update(base);
  await note.flush();
  assert.equal(note.dirty, false);
  assert.equal(adapter.writes, 1);
  assert.equal(await vault.cachedRead('One.md'), base);
  assert.equal(vault.metadata.get('One.md')!.links[0].target, 'Before');
  assert.equal(storage.values.size, 0);
  await note.dispose();
});

test('empty pending snapshots recover and malformed pending fields remain untouched until explicit edits', async () => {
  const storage = new Storage();
  storage.setItem('test-vault:One.md', JSON.stringify({base: 'before', content: 'before', pending: ''}));
  const restarted = await setup(new MemoryAdapter({'One.md': ''}), storage);
  assert.equal(restarted.note.savedText, '');
  assert.equal(restarted.note.text, 'before');
  assert.equal(restarted.note.dirty, true);
  await restarted.note.dispose();
  assert.equal(await restarted.adapter.read('One.md'), 'before');
  storage.setItem('test-vault:One.md', JSON.stringify({base: 'before', content: 'draft', pending: 0}));
  const invalid = await setup(new MemoryAdapter({'One.md': 'before'}), storage);
  assert.match(invalid.note.error!.message, /Invalid recovery draft/);
  assert.equal(JSON.parse(storage.getItem('test-vault:One.md')!).pending, 0);
  invalid.note.update('explicit edit');
  await invalid.note.dispose();
  assert.equal(await invalid.adapter.read('One.md'), 'explicit edit');
});

test('a failed in-flight revert checkpoint retains prior recovery and retries the latest text without removing it', async () => {
  const started = deferred(), release = deferred();
  class PausedAdapter extends MemoryAdapter {
    first = true;
    async write(path: string, content: string): Promise<void> {
      if (this.first) { this.first = false; started.resolve(); await release.promise; }
      await super.write(path, content);
    }
  }
  class FailingStorage extends Storage {
    fail = false;
    setItem(key: string, value: string): void {
      if (this.fail) throw new Error('recovery quota');
      super.setItem(key, value);
    }
  }
  const storage = new FailingStorage(), {note} = await setup(new PausedAdapter({'One.md': 'initial'}), storage);
  note.update('first'); const saving = note.flush(); await started.promise;
  storage.fail = true; note.update('initial');
  assert.equal(note.dirty, true);
  assert.equal(note.error?.message, 'recovery quota');
  assert.deepEqual(storage.draft(), {base: 'initial', content: 'first', pending: 'first'});
  assert.equal(storage.removals, 0, 'failed checkpoint must not remove the older recoverable snapshot');
  storage.fail = false; note.update('initial');
  assert.deepEqual(storage.draft(), {base: 'initial', content: 'initial', pending: 'first'});
  release.resolve(); await saving; await note.dispose();
  assert.equal(storage.values.size, 0);
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
  assert.deepEqual(storage.draft(), {base: 'initial', content: 'valuable', pending: 'valuable'});
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
  assert.deepEqual(storage.draft(), {base: 'external', content: 'local', pending: 'local'});
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
