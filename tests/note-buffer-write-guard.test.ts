import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, Vault } from '../src/core/index.ts';
import { NoteBuffer } from '../src/ui/note-buffer.ts';

test('write guard reaches queued Vault execution and survives flush, typing, retry and disposal', async () => {
  const vault = new Vault(new MemoryAdapter({ 'A.md': 'original' })); await vault.initialize();
  const buffer = new NoteBuffer(vault, 'A.md', { debounceMs: 60000 }); await buffer.load();
  let current = true;
  const stop = vault.on('delete', () => { current = false; });
  buffer.update('old-file edit', { validateWrite() { if (!current) throw new Error('File lifetime ended'); } });
  const removal = vault.trash('A.md'), replacement = vault.create('A.md', 'original');
  await assert.rejects(buffer.flush(), /lifetime/); await removal; await replacement;
  assert.equal(await vault.read('A.md'), 'original');
  buffer.update('more typing');
  await assert.rejects(buffer.flush(), /lifetime/);
  await assert.rejects(buffer.dispose(), /lifetime/);
  assert.equal(buffer.dirty, true); assert.equal(buffer.text, 'more typing');
  assert.equal(await vault.read('A.md'), 'original'); stop();
});

test('successful guarded flush releases guard and retains concurrent typing', async () => {
  class Delayed extends MemoryAdapter {
    gate?: Promise<void>;
    override async write(path: string, source: string) { await this.gate; return super.write(path, source); }
  }
  const adapter = new Delayed({ 'A.md': 'original' }), vault = new Vault(adapter); await vault.initialize();
  const buffer = new NoteBuffer(vault, 'A.md', { debounceMs: 60000 }); await buffer.load();
  let valid = true, release!: () => void;
  adapter.gate = new Promise<void>(resolve => { release = resolve; });
  buffer.update('first', { validateWrite() { if (!valid) throw new Error('expired'); } });
  const save = buffer.flush();
  await Promise.resolve(); await Promise.resolve();
  buffer.update('latest'); release(); await save;
  assert.equal(await vault.read('A.md'), 'latest');
  valid = false; buffer.update('ordinary later edit'); await buffer.flush();
  assert.equal(await vault.read('A.md'), 'ordinary later edit'); await buffer.dispose();
});

test('reverting an unpersisted guarded draft releases only guards with no pending write intent', async () => {
  const vault = new Vault(new MemoryAdapter({ 'A.md': 'original' })); await vault.initialize();
  const buffer = new NoteBuffer(vault, 'A.md', { debounceMs: 60000 }); await buffer.load();
  let valid = true;
  buffer.update('temporary', { validateWrite() { if (!valid) throw new Error('expired'); } });
  buffer.update('original'); valid = false;
  await buffer.flush(); assert.equal(buffer.dirty, false); await buffer.dispose();
});
