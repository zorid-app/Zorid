import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTextCreateReceipt } from '../src/core/text-create.ts';
import { Vault, MemoryAdapter } from '../src/core/index.ts';
import type { TextCreateReceipt } from '../src/core/types.ts';

const expected = { operationId: 'original-operation', entryId: 'original-entry', path: 'New.md' };
const rawReceipt = () => ({ operation_id: expected.operationId, sequence: '1', changes: [{ before: null, after: { id: expected.entryId, revision: 'original-revision', path: expected.path, kind: 'file', deleted: false } }] });
test('creation receipt uses original committed identity and accepts changed ancestor revisions', () => {
  const raw = rawReceipt();
  raw.changes.push({ before: { id: 'parent' } as never, after: { id: 'parent', revision: 'parent-next', path: 'Folder', kind: 'folder', deleted: false } });
  assert.deepEqual(decodeTextCreateReceipt(raw, expected), { ...expected, revision: 'original-revision', sequence: '1' });
  for (const change of [
    (value: any) => value.operation_id = 'other', (value: any) => value.changes[0].after.id = 'replacement',
    (value: any) => value.changes[0].before = {}, (value: any) => value.changes[0].after.deleted = true,
    (value: any) => value.changes[0].after.path = 'Other.md', (value: any) => value.changes[0].after.revision = '',
    (value: any) => value.sequence = '18446744073709551616', (value: any) => value.changes.push(value.changes[0]),
  ]) { const raw = rawReceipt(); change(raw); assert.throws(() => decodeTextCreateReceipt(raw, expected), { code: 'invalid_create_receipt' }); }
});

class ReceiptAdapter extends MemoryAdapter {
  identity = 'original-entry'; revision = 'original-revision'; writes = 0; runs = 0;
  loseReply = false; failPublication = false;
  override async list() { if (this.failPublication && this.writes) { this.failPublication = false; throw new Error('publication failed'); } return (await super.list()).map(entry => ({ ...entry, entryId: this.identity, revision: this.revision })); }
  captureTextCreate(path: string, text: string) {
    const adapter = this, receipt: TextCreateReceipt = { operationId: 'original-operation', entryId: 'original-entry', revision: 'original-revision', path, sequence: '1' };
    let committed = false;
    return { path, text, operationId: receipt.operationId, entryId: receipt.entryId, async run() {
      adapter.runs++;
      if (!committed) { await adapter.write(path, text); adapter.writes++; committed = true; if (adapter.loseReply) { adapter.loseReply = false; throw new Error('lost acknowledgment'); } }
      return receipt;
    } };
  }
}
test('receipt-backed creation replays only original command after an uncertain commit occupies the destination', async () => {
  const adapter = new ReceiptAdapter(), vault = new Vault(adapter); await vault.initialize();
  adapter.loseReply = true; const operation = vault.createOperation('New.md', 'original');
  await assert.rejects(operation.run(), /lost acknowledgment/);
  const entry = await operation.run(); assert.equal(entry.entryId, 'original-entry'); assert.equal(entry.revision, 'original-revision');
  assert.equal(adapter.writes, 1); assert.equal(adapter.runs, 2); assert.equal(await vault.read('New.md'), 'original');
});
test('receipt-backed publication retry never adopts a same-byte replacement or advanced original revision', async () => {
  for (const mutation of ['replacement', 'revision'] as const) {
    const adapter = new ReceiptAdapter(), vault = new Vault(adapter); await vault.initialize();
    adapter.failPublication = true; const operation = vault.createOperation('New.md', 'original');
    await assert.rejects(operation.run(), /publication failed/);
    if (mutation === 'replacement') adapter.identity = 'replacement'; else adapter.revision = 'advanced';
    await assert.rejects(operation.run(), { code: 'created_file_changed' });
    assert.equal(adapter.writes, 1); assert.equal(operation.status, 'uncertain'); assert.equal(await adapter.read('New.md'), 'original');
  }
});
