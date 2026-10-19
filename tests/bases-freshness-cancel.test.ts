import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedBaseQueryRunner } from '../src/bases/shared-query.ts';
import type { SharedBaseQueryInput } from '../src/bases/shared-query.ts';
import type { DocumentService } from '../src/core/document-semantics.ts';
import type { DocumentMaintenance } from '../src/core/document-runtime.ts';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settled(check: () => boolean) { for (let i = 0; i < 300 && !check(); i++) await Promise.resolve(); assert.ok(check()); }
function fixture() {
  const demands: { cancelled: number; ack: ReturnType<typeof deferred<void>> }[] = [];
  let opened = 0, unsubscribed = 0;
  const maintenance: DocumentMaintenance = {
    async observeAndSubscribe() { return { snapshot: null, unsubscribe() { unsubscribed++; } }; },
    requestFreshness() {
      const demand = { cancelled: 0, ack: deferred<void>() }; demands.push(demand);
      return { result: new Promise<never>(() => {}), cancel() { demand.cancelled++; return demand.ack.promise; } };
    },
  };
  const service = { maintenance, async open() { opened++; throw new Error('Cancelled freshness cannot open a pin'); } } as unknown as DocumentService;
  const runner = new SharedBaseQueryRunner();
  const entry = { path: 'Work.base', name: 'Work.base', type: 'file' as const, mtime: 0, size: 0, entryId: 'base', revision: 'r1' };
  const input: SharedBaseQueryInput = { service, definition: entry, current: entry, entries: [entry], query: {}, viewIndex: 0, version: 1, isCurrent: () => true };
  return { runner, input, demands, get opened() { return opened; }, get unsubscribed() { return unsubscribed; } };
}
function outcome(promise: Promise<unknown>) { return promise.then(() => 'fulfilled', error => (error as { code?: string }).code); }
test('Base cancellation delivers real catch-up AbortSignal before the held demand cancellation ACK', async () => {
  const f = fixture(); const pending = outcome(f.runner.query(f.input));
  await settled(() => f.demands.length === 1);
  f.runner.cancel(); assert.equal(f.demands[0].cancelled, 1);
  await settled(() => f.unsubscribed === 1); assert.equal(f.opened, 0);
  let finished = false; void pending.then(() => { finished = true; }); await Promise.resolve(); assert.equal(finished, false);
  f.demands[0].ack.resolve(); assert.equal(await pending, 'document_request_cancelled'); assert.equal(f.opened, 0); f.runner.dispose();
});
test('supersession and dispose each abort only their owned freshness demand before ACK', async () => {
  const f = fixture(); const first = outcome(f.runner.query(f.input)); await settled(() => f.demands.length === 1);
  const second = outcome(f.runner.query({ ...f.input, version: 2 }));
  assert.equal(f.demands[0].cancelled, 1); await settled(() => f.demands.length === 2);
  assert.equal(f.demands[1].cancelled, 0);
  f.runner.dispose(); assert.equal(f.demands[1].cancelled, 1);
  await settled(() => f.unsubscribed === 2); assert.equal(f.opened, 0);
  f.demands[0].ack.resolve(); f.demands[1].ack.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['document_request_cancelled', 'document_request_cancelled']);
  assert.equal(await outcome(f.runner.query(f.input)), 'document_request_cancelled');
  assert.equal(f.demands.length, 2); assert.equal(f.opened, 0);
});
