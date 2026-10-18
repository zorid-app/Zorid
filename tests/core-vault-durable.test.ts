import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault } from '../src/core/vault.ts';
import type { DurableCommitReceipt } from '../src/core/vault.ts';
import type { DurableWrites, DurableWriteRead, DurableWriteIntent, DurableWriteRef } from '../src/core/durable-writes.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const unsupported = async (): Promise<never> => { throw new Error('Unexpected provider operation'); };

/** A scripted host seam, not an IndexedDB/SQLite or Rust planner simulation. */
async function fixture() {
  const scope = { vaultId: 'authority-one', clientId: 'client-one' };
  const ref: DurableWriteRef = { ...scope, token: 'token-one', operationId: 'operation-one', entryId: 'entry-one' };
  let current: DurableWriteRead | null = { path: 'One.md', content: '# Old', entryId: ref.entryId, revision: 'revision-old',
    stat: { ctime: 1, mtime: 2, size: 5 } };
  let failure: Error | undefined;
  let commitGate: ReturnType<typeof gate> | undefined, queryGate: ReturnType<typeof gate> | undefined;
  let readGate: ReturnType<typeof gate> | undefined;
  const commitEntered = gate(), queryEntered = gate(), readEntered = gate();
  const calls: string[] = [];
  const outcomes = new Map<string, DurableWriteIntent>();
  class Adapter extends MemoryAdapter {
    durableWrites!: DurableWrites;
    writes = 0;
    async write(path: string, content: string): Promise<void> {
      this.writes++;
      await super.write(path, content);
      current = { ...current!, path, content, revision: `local-${this.writes}`,
        stat: { ctime: 1, mtime: 2, size: new TextEncoder().encode(content).length } };
    }
    async storeCommitted(): Promise<void> {
      await super.write('One.md', '# Saved');
      current = { path: 'One.md', content: '# Saved', entryId: ref.entryId, revision: 'revision-saved',
        stat: { ctime: 1, mtime: 2, size: 7 } };
    }
    async list() {
      return (await super.list()).map(row => current?.path === row.path
        ? { ...row, revision: current.revision, ...current.stat } : row);
    }
    async stat(path: string) {
      const row = await super.stat(path);
      return row && current?.path === path ? { ...row, revision: current.revision, ...current.stat } : row;
    }
  }
  const adapter = new Adapter({ 'One.md': '# Old' });
  const capability: DurableWrites = {
    checkpoints: { scope, load: unsupported, compareAndSwap: unsupported, list: unsupported, changes: unsupported },
    async readText(path) {
      calls.push('read-path'); readEntered.resolve();
      if (readGate) await readGate.promise;
      if (!current || current.path !== path) throw new Error('missing');
      return structuredClone(current);
    },
    async readTextById(id) {
      calls.push('read-id');
      if (failure) throw failure;
      return current?.entryId === id ? structuredClone(current) : null;
    },
    planWrite: unsupported, prepare: unsupported, listUnacknowledged: unsupported, acknowledge: unsupported,
    async commit(input) {
      calls.push(`commit:${input.operationId}`); commitEntered.resolve();
      if (commitGate) await commitGate.promise;
      await adapter.storeCommitted();
      const outcome: DurableWriteIntent = { ref: { ...input }, state: 'committed', acknowledged: false,
        receipt: { operationId: input.operationId, sequence: '9007199254740993', entryId: input.entryId, revision: 'revision-saved' } };
      outcomes.set(input.token, outcome);
      return structuredClone(outcome);
    },
    async query(input) {
      calls.push('query'); queryEntered.resolve();
      if (queryGate) await queryGate.promise;
      return structuredClone(outcomes.get(input.token) ?? null);
    },
  };
  adapter.durableWrites = capability;
  const vault = new Vault(adapter); await vault.initialize();
  async function commit(): Promise<DurableCommitReceipt> {
    const outcome = await vault.commitDurableWrite(ref);
    assert.equal(outcome.state, 'committed');
    if (outcome.state !== 'committed') throw new Error('Expected commit receipt');
    return outcome.receipt;
  }
  return { vault, adapter, capability, scope, ref, calls, outcomes, commit, commitEntered, queryEntered, readEntered,
    holdCommit() { return commitGate = gate(); }, holdQuery() { return queryGate = gate(); }, holdRead() { return readGate = gate(); },
    observe(value: DurableWriteRead | null) { current = value; }, get current() { return current; },
    failRead(error?: Error) { failure = error; } };
}

test('durable coherent reads expose one snapshot and leave legacy adapters optional', async () => {
  const f = await fixture();
  const read = await f.vault.readDurableText('One.md');
  assert.deepEqual(read, f.current); assert.deepEqual(f.calls, ['read-path']);
  assert.ok(Object.isFrozen(read)); assert.ok(Object.isFrozen(read.stat));
  assert.deepEqual(await f.vault.readDurableTextById('entry-one'), read);
  assert.equal(await f.vault.readDurableTextById('replacement'), null);
  const legacy = new Vault(new MemoryAdapter());
  assert.throws(() => legacy.readDurableText('One.md'), { code: 'durable_writes_unavailable' });
});

test('receipt reconciliation publishes cache, metadata and event atomically without another write', async () => {
  const f = await fixture(), events: string[] = [], observations: unknown[] = [];
  f.vault.on('modify', change => {
    events.push(change.path);
    // Vault isolates listener errors, so assert captured observations outside it.
    observations.push([f.vault.entries.get(change.path)?.revision,
      f.vault.metadata.get(change.path)?.headings[0].heading, f.vault.entries.get(change.path)?.entryId]);
  });
  const receipt = await f.commit();
  assert.equal(f.vault.metadata.get('One.md')?.headings[0].heading, 'Old', 'commit does not publish');
  assert.deepEqual(events, []);
  assert.equal((await f.vault.reconcileDurableWrite(f.ref, receipt)).status, 'current');
  assert.equal(await f.vault.cachedRead('One.md'), '# Saved');
  assert.deepEqual(events, ['One.md']); assert.equal(f.adapter.writes, 0);
  assert.deepEqual(observations, [['revision-saved', 'Saved', f.ref.entryId]]);
  assert.equal(f.vault.entries.get('One.md')?.entryId, f.ref.entryId);
  await f.vault.reconcileDurableWrite(f.ref, receipt);
  assert.deepEqual(events, ['One.md'], 'same snapshot is not republished');
  assert.equal(f.calls.filter(call => call.startsWith('commit:')).length, 1);
});

test('admission validator runs in the shared mutation queue before RPC; retired views can reconcile historical commits', async () => {
  const f = await fixture(), held = f.holdRead();
  const reading = f.vault.readDurableText('One.md'); await f.readEntered.promise;
  let live = true;
  const writing = f.vault.commitDurableWrite(f.ref, { validate() { if (!live) throw new Error('retired view'); } });
  live = false; held.resolve(); await reading;
  await assert.rejects(writing, /retired view/);
  assert.equal(f.calls.some(call => call.startsWith('commit:')), false);
  const receipt = await f.commit();
  assert.equal((await f.vault.reconcileDurableWrite(f.ref, receipt)).status, 'current', 'historical reconciliation has no view-admission validator');
});

test('a queued competing local mutation cannot interleave with durable commit and is not overwritten by publication', async () => {
  const f = await fixture(), held = f.holdCommit();
  const writing = f.vault.commitDurableWrite(f.ref); await f.commitEntered.promise;
  const local = f.vault.modify('One.md', '# Local');
  await Promise.resolve(); assert.equal(f.adapter.writes, 0);
  held.resolve(); const outcome = await writing; await local;
  if (outcome.state !== 'committed') throw new Error('Expected committed outcome');
  const result = await f.vault.reconcileDurableWrite(f.ref, outcome.receipt);
  assert.equal(result.status, 'advanced'); assert.equal(result.current?.content, '# Local');
  assert.equal(await f.vault.cachedRead('One.md'), '# Local');
  assert.equal(f.adapter.writes, 1);
});

test('peer advancement, rename, deletion and same-byte reincarnation remain distinct from historical success', async () => {
  for (const kind of ['advanced', 'renamed', 'deleted', 'recreated'] as const) {
    const f = await fixture(), receipt = await f.commit(), cached = f.vault.entries;
    const original = f.current!;
    f.observe(kind === 'deleted' ? null : { ...original,
      entryId: kind === 'recreated' ? 'replacement' : original.entryId,
      path: kind === 'renamed' ? 'Moved.md' : original.path,
      revision: 'peer-revision', content: kind === 'advanced' ? '# Peer' : original.content });
    const result = await f.vault.reconcileDurableWrite(f.ref, receipt);
    assert.equal(result.status, kind === 'deleted' || kind === 'recreated' ? 'missing' : 'advanced');
    if (kind === 'renamed') assert.equal(result.current?.path, 'Moved.md');
    assert.equal(f.vault.entries, cached, 'conflict observation does not rebind cached paths');
    assert.equal(f.vault.metadata.get('One.md')?.headings[0].heading, 'Old');
    assert.equal(f.adapter.writes, 0); assert.equal(f.calls.filter(call => call.startsWith('commit:')).length, 1);
  }
});

test('postcommit read failure preserves cache and retry only reads the original receipt', async () => {
  const f = await fixture(), receipt = await f.commit(), entries = f.vault.entries, metadata = f.vault.metadata;
  const events: string[] = []; f.vault.on('modify', change => events.push(change.path));
  f.failRead(new Error('readback unavailable'));
  await assert.rejects(f.vault.reconcileDurableWrite(f.ref, receipt), { code: 'outcome_unknown', source: 'host' });
  assert.equal(f.vault.entries, entries); assert.equal(f.vault.metadata, metadata);
  assert.equal(await f.vault.cachedRead('One.md'), '# Old'); assert.deepEqual(events, []);
  f.failRead(); await f.vault.reconcileDurableWrite(f.ref, receipt);
  assert.deepEqual(events, ['One.md']); assert.equal(f.adapter.writes, 0);
  assert.equal(f.calls.filter(call => call.startsWith('commit:')).length, 1);
});

test('adapter or authority changes across an await never substitute the current adapter', async () => {
  for (const change of ['adapter', 'authority'] as const) {
    const f = await fixture(), receipt = await f.commit(), held = f.holdQuery(), cached = f.vault.entries;
    const reconciling = f.vault.reconcileDurableWrite(f.ref, receipt); await f.queryEntered.promise;
    if (change === 'adapter') f.vault.adapter = new MemoryAdapter({ 'One.md': '# Other' });
    else f.scope.vaultId = 'replacement-authority';
    held.resolve(); await assert.rejects(reconciling, { code: 'intent_identity_mismatch' });
    assert.equal(f.vault.entries, cached); assert.equal(f.calls.includes('read-id'), false);
    assert.equal(f.adapter.writes, 0);
  }
});

test('mutable refs and receipt arguments are captured before queue admission; bad witnesses cannot publish', async () => {
  const f = await fixture(), receipt = await f.commit(), held = f.holdRead();
  const reading = f.vault.readDurableText('One.md'); await f.readEntered.promise;
  const ref = { ...f.ref }, witness = { ...receipt };
  const reconciling = f.vault.reconcileDurableWrite(ref, witness);
  ref.token = 'other'; witness.revision = 'other'; held.resolve(); await reading;
  assert.equal((await reconciling).status, 'current');
  await assert.rejects(f.vault.reconcileDurableWrite(f.ref, { ...receipt, revision: 'forged' }), { code: 'intent_outcome_mismatch' });
  f.outcomes.clear();
  await assert.rejects(f.vault.reconcileDurableWrite(f.ref, receipt), { code: 'intent_not_found' });
  assert.equal(f.adapter.writes, 0);
});


test('commit returns copied receipt identities and rejects invalid receipt witnesses', async () => {
  const f = await fixture();
  const retained: DurableWriteIntent = { ref: { ...f.ref }, state: 'committed', acknowledged: false,
    receipt: { operationId: f.ref.operationId, entryId: f.ref.entryId, sequence: '12', revision: 'saved' } };
  f.capability.commit = async () => retained;
  const result = await f.vault.commitDurableWrite(f.ref);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.ref));
  if (result.state !== 'committed') throw new Error('Expected committed outcome');
  assert.ok(Object.isFrozen(result.receipt));
  Object.assign(retained.ref, { token: 'mutated' });
  Object.assign(retained.receipt, { revision: 'mutated' });
  assert.equal(result.ref.token, f.ref.token); assert.equal(result.receipt.revision, 'saved');
  for (const sequence of ['-1', '1e3', '1.5', '01', '']) {
    f.capability.commit = async () => ({ ...retained, ref: f.ref, receipt: { ...result.receipt, sequence } });
    await assert.rejects(f.vault.commitDurableWrite(f.ref), { code: 'intent_outcome_mismatch' });
  }
});

test('receipt readback with a replacement identity cannot publish the saved body or rebind cache', async () => {
  const f = await fixture(), receipt = await f.commit(), entries = f.vault.entries;
  const replacement = { ...f.current!, entryId: 'replacement' };
  f.capability.readTextById = async () => replacement;
  const events: string[] = []; f.vault.on('modify', change => events.push(change.path));
  await assert.rejects(f.vault.reconcileDurableWrite(f.ref, receipt), { code: 'durable_read_invalid' });
  assert.equal(f.vault.entries, entries); assert.equal(await f.vault.cachedRead('One.md'), '# Old');
  assert.deepEqual(events, []); assert.equal(f.adapter.writes, 0);
});
