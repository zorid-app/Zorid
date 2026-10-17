import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';
import { createBaseMutationHost } from '../src/bases/controller.ts';
import type { DurableWrites, DurableWriteInput, DurableWriteIntent, DurableWriteRead } from '../src/core/durable-writes.ts';
import type { Checkpoint } from '../src/core/durable-checkpoints.ts';

test('real NoteBuffer admits the saved row, preserves typing across own ACKs, and then accepts later typing', async () => {
  const scope = { vaultId: 'authority', clientId: 'client' };
  let current: DurableWriteRead = { entryId: 'original', revision: 'r1', path: 'One.md', content: 'body', stat: { ctime: 1, mtime: 1, size: 4 } };
  const adapter = new MemoryAdapter({ 'One.md': 'body' }) as MemoryAdapter & { durableWrites: DurableWrites };
  const checkpoints = new Map<string, Checkpoint>(), intents = new Map<string, DurableWriteIntent>(), inputs = new Map<string, DurableWriteInput>();
  const plannedRevisions: string[] = []; let commits = 0;
  let entered!: () => void, release!: () => void;
  const firstCommitEntered = new Promise<void>(resolve => { entered = resolve; }), firstCommitGate = new Promise<void>(resolve => { release = resolve; });
  const unused = async (): Promise<never> => { throw new Error('Unexpected checkpoint enumeration'); };
  adapter.durableWrites = {
    checkpoints: { scope, load: async key => structuredClone(checkpoints.get(key) ?? null),
      compareAndSwap: async change => { assert.equal(change.expectedRevision, checkpoints.get(change.key)?.revision ?? null);
        const checkpoint: Checkpoint = { version: 1, ...scope, key: change.key, revision: change.nextRevision, encodedState: change.encodedState, sequence: '1', deleted: false, byteLength: 0 };
        checkpoints.set(change.key, checkpoint); return structuredClone(checkpoint); }, list: unused, changes: unused },
    readText: async path => { assert.equal(path, current.path); return structuredClone(current); },
    readTextById: async id => id === current.entryId ? structuredClone(current) : null,
    planWrite: async input => { assert.equal(input.expectedEntryId, current.entryId); assert.equal(input.expectedRevision, current.revision); assert.equal(input.expectedContent, current.content);
      plannedRevisions.push(input.expectedRevision); inputs.set(input.operationId, structuredClone(input));
      return { version: 1, ...scope, operationId: input.operationId, entryId: input.expectedEntryId, encodedPlan: JSON.stringify(input) }; },
    prepare: async plan => { const ref = { ...scope, operationId: plan.operationId, entryId: plan.entryId, token: plan.operationId };
      const intent: DurableWriteIntent = { state: 'prepared', acknowledged: false, ref }; intents.set(ref.token, intent); return structuredClone(intent); },
    commit: async ref => { const input = inputs.get(ref.operationId)!;
      if (commits === 0) { entered(); await firstCommitGate; }
      assert.equal(current.entryId, input.expectedEntryId); assert.equal(current.revision, input.expectedRevision); assert.equal(current.content, input.expectedContent);
      commits++; current = { ...current, revision: `r${commits + 1}`, content: input.content, stat: { ctime: 1, mtime: commits + 1, size: new TextEncoder().encode(input.content).length } };
      await adapter.write(current.path, current.content);
      const intent: DurableWriteIntent = { state: 'committed', acknowledged: false, ref, receipt: { operationId: ref.operationId, entryId: ref.entryId, revision: current.revision, sequence: String(commits) } };
      intents.set(ref.token, intent); return structuredClone(intent); },
    query: async ref => structuredClone(intents.get(ref.token) ?? null), listUnacknowledged: async () => [],
    acknowledge: async ref => { const intent = intents.get(ref.token)!; if (intent.state === 'committed' || intent.state === 'rejected') intents.set(ref.token, { ...intent, acknowledged: true }); },
  };
  const vault = new Vault(adapter); await vault.initialize(); const buffer = new NoteBuffer(vault, 'One.md', { debounceMs: 60000 }); await buffer.load();
  try {
    buffer.update('body\nUnsaved typing');
    const host = createBaseMutationHost({ getBuffer: () => buffer, validate() {} });
    const edit = host.transform('One.md', text => text + '\nBase property edit', () => {}, undefined, { entryId: 'original', revision: 'r1' });
    await firstCommitEntered;
    buffer.update(buffer.text + '\nTyped during flush'); release(); await edit;
    assert.deepEqual(plannedRevisions, ['r1', 'r2']); assert.equal(buffer.savedDurableWitness?.revision, 'r3');
    assert.equal(buffer.dirty, false); assert.equal(await adapter.read('One.md'), 'body\nUnsaved typing\nBase property edit\nTyped during flush');
    buffer.update(buffer.text + '\nLater typing'); await buffer.flush();
    assert.deepEqual(plannedRevisions, ['r1', 'r2', 'r3']); assert.equal(buffer.savedDurableWitness?.revision, 'r4');
    assert.ok((await adapter.read('One.md')).endsWith('\nLater typing')); assert.equal(buffer.dirty, false);
  } finally { release(); await buffer.dispose(); }
});
