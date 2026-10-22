import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, MemoryAdapter } from '../src/core/index.ts';

test('a retained create is single-flight and successful retries never issue another write', async () => {
  class Adapter extends MemoryAdapter {
    writes = 0;
    override async write(path: string, text: string) { this.writes++; return super.write(path, text); }
  }
  const adapter = new Adapter(), vault = new Vault(adapter); await vault.initialize();
  const operation = vault.createOperation('New.md', 'literal');
  const first = operation.run(), second = operation.run(); assert.equal(first, second);
  assert.equal((await first).path, 'New.md'); await operation.run();
  assert.equal(adapter.writes, 1); assert.equal(operation.status, 'committed');
});

test('a known failed create retries the captured destination and body after absence is rechecked', async () => {
  class Adapter extends MemoryAdapter {
    fail = true; writes = 0;
    override async write(path: string, text: string) { this.writes++; if (this.fail) throw new Error('disk full'); return super.write(path, text); }
  }
  const adapter = new Adapter(), vault = new Vault(adapter); await vault.initialize();
  const operation = vault.createOperation('New.md', 'literal');
  await assert.rejects(operation.run(), /disk full/); assert.equal(operation.status, 'uncertain');
  adapter.fail = false; await operation.run();
  assert.equal(adapter.writes, 2); assert.equal(await vault.read('New.md'), 'literal');
});

test('uncertain committed destination is never adopted by matching content or replaced with another note', async () => {
  class Adapter extends MemoryAdapter {
    writes = 0;
    async createText(path: string, text: string) { this.writes++; await super.write(path, text); throw new Error('lost acknowledgment'); }
  }
  const adapter = new Adapter(), vault = new Vault(adapter); await vault.initialize();
  const operation = vault.createOperation('New.md', 'identical content');
  await assert.rejects(operation.run(), /lost acknowledgment/);
  await assert.rejects(operation.run(), error => (error as { code?: string }).code === 'create_reconciliation_required');
  assert.equal(adapter.writes, 1); assert.equal(await adapter.read('New.md'), 'identical content');
  assert.equal(operation.status, 'uncertain');
});

test('acknowledged creation followed by publication failure retries publication without recreating', async () => {
  class Adapter extends MemoryAdapter {
    failList = false; writes = 0;
    override async list() { if (this.failList) { this.failList = false; throw new Error('publication unavailable'); } return super.list(); }
    override async write(path: string, text: string) { this.writes++; await super.write(path, text); this.failList = true; }
  }
  const adapter = new Adapter(), vault = new Vault(adapter); await vault.initialize();
  const operation = vault.createOperation('New.md', 'literal');
  await assert.rejects(operation.run(), /publication unavailable/);
  await operation.run(); assert.equal(adapter.writes, 1); assert.equal(operation.status, 'committed');
});

test('retired owner and replaced adapter forbid queued creation and retries', async () => {
  const adapter = new MemoryAdapter(), vault = new Vault(adapter); await vault.initialize();
  let valid = true;
  const operation = vault.createOperation('New.md', 'body', () => { if (!valid) throw new Error('retired'); });
  valid = false; await assert.rejects(operation.run(), /retired/); assert.equal(await adapter.stat('New.md'), null);
  valid = true; vault.adapter = new MemoryAdapter(); await assert.rejects(operation.run(), /adapter changed/);
  assert.equal(await adapter.stat('New.md'), null);
});
