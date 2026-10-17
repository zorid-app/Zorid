import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import type { DurableWrites, DurableWriteRead } from '../src/core/durable-writes.ts';
import type { Checkpoint } from '../src/core/durable-checkpoints.ts';
import { durableRecoveryFixture } from './helpers/durable-recovery-fixture.ts';

test('legacy and unready buffers do not invent a saved durable witness', async () => {
  const vault = new Vault(new MemoryAdapter({ 'One.md': 'body' })); await vault.initialize();
  const buffer = new NoteBuffer(vault, 'One.md');
  assert.equal(buffer.savedDurableWitness, undefined);
  await buffer.load(); assert.equal(buffer.savedDurableWitness, undefined);
  await buffer.dispose();
});

test('saved durable witnesses are immutable detached snapshots of the actual loaded baseline', async () => {
  const adapter = new MemoryAdapter({ 'One.md': 'body' }) as MemoryAdapter & { durableWrites: DurableWrites };
  let current: DurableWriteRead = { entryId: 'stable-note', revision: 'revision-1', path: 'One.md', content: 'body', stat: { ctime: 1, mtime: 1, size: 4 } };
  const scope = { vaultId: 'authority', clientId: 'client' }; let head: Checkpoint | null = null, plans = 0;
  const unused = async (): Promise<never> => { throw new Error('Unexpected write operation'); };
  adapter.durableWrites = {
    checkpoints: { scope, load: async () => head,
      compareAndSwap: async change => {
        assert.equal(change.expectedRevision, head?.revision ?? null);
        head = { version: 1, ...scope, key: change.key, revision: change.nextRevision, encodedState: change.encodedState,
          sequence: '1', deleted: false, byteLength: 0 }; return head;
      }, list: unused, changes: unused },
    readText: async () => structuredClone(current), readTextById: async id => id === current.entryId ? structuredClone(current) : null,
    planWrite: async () => { plans++; throw new Error('Getter/reload must never plan a write'); },
    prepare: unused, commit: unused, query: unused, listUnacknowledged: unused, acknowledge: unused,
  };
  const vault = new Vault(adapter); await vault.initialize(); const buffer = new NoteBuffer(vault, 'One.md');
  assert.equal(buffer.savedDurableWitness, undefined); await buffer.load();
  const first = buffer.savedDurableWitness!;
  assert.deepEqual(first, { entryId: 'stable-note', revision: 'revision-1', path: 'One.md' });
  assert.equal(Object.isFrozen(first), true); assert.notEqual(first, buffer.savedDurableWitness);
  assert.throws(() => { (first as { entryId: string }).entryId = 'replacement'; }, TypeError);
  current = { ...current, path: 'Moved.md', revision: 'revision-2', content: 'new body', stat: { ctime: 1, mtime: 2, size: 8 } };
  assert.deepEqual(buffer.savedDurableWitness, first, 'external authority changes do not silently rebind a loaded buffer');
  await buffer.reload();
  assert.deepEqual(buffer.savedDurableWitness, { entryId: 'stable-note', revision: 'revision-2', path: 'Moved.md' });
  assert.equal(buffer.path, 'Moved.md'); assert.equal(first.path, 'One.md'); assert.equal(first.revision, 'revision-1');
  assert.equal(plans, 0); await buffer.dispose();
});

test('a recovered conflicting draft reports its retained baseline rather than the newer path observation', async () => {
  const f = await durableRecoveryFixture(), vault = new Vault(f.adapter); await vault.initialize();
  const buffer = new NoteBuffer(vault, 'One.md'); await buffer.load();
  assert.ok(buffer.error); assert.equal(buffer.dirty, true);
  assert.deepEqual(buffer.savedDurableWitness, { entryId: 'retained-note', revision: 'old-revision', path: 'One.md' });
  const authoritative = await vault.readDurableText('One.md'); assert.equal(authoritative.revision, 'cli-revision');
  assert.equal(buffer.savedDurableWitness!.revision, 'old-revision');
  assert.equal(f.plans, 0); await assert.rejects(buffer.dispose(), /file advanced or write rejected/);
});
