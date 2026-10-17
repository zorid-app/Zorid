import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformAdapter } from '../src/platform/index.ts';

for (const lateOutcome of ['success', 'terminal rejection']) {
  test(`late duplicate ${lateOutcome} preserves a newer uncertain operation ID`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const calls: { request: any; resolve: () => void; reject: (error: unknown) => void }[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { zorid: {
      getVault: async () => ({ path: '/fixture', name: 'Fixture' }),
      getDurableContext: async () => ({ admissionId: 'admitted', scope: { vaultId: 'authority', clientId: 'client' } }),
      releaseDurableContext: async () => {},
      durableInvoke: (_path: string, _admission: string, method: string, args: unknown[]) => {
        assert.equal(method, 'fileCommand');
        return new Promise<void>((resolve, reject) => calls.push({ request: args[0], resolve, reject }));
      },
    } } });
    try {
      const { adapter } = (await createPlatformAdapter())!;
      const first = adapter.write('Note.md', 'A');
      const duplicate = adapter.write('Note.md', 'A');
      assert.equal(calls[0].request.operationId, calls[1].request.operationId);
      calls[0].resolve(); await first;
      const next = adapter.write('Note.md', 'B');
      const nextId = calls[2].request.operationId;
      assert.notEqual(nextId, calls[0].request.operationId);
      if (lateOutcome === 'success') { calls[1].resolve(); await duplicate; }
      else {
        const rejected = assert.rejects(duplicate, { code: 'revision_conflict' });
        calls[1].reject(Object.assign(new Error('Old request rejected'), { code: 'revision_conflict', commitUncertain: false }));
        await rejected;
      }
      const uncertain = assert.rejects(next, { code: 'host_timeout' });
      calls[2].reject(Object.assign(new Error('ACK unknown'), { code: 'host_timeout', commitUncertain: true }));
      await uncertain;
      const retry = adapter.write('Note.md', 'B');
      calls[3].resolve(); await retry;
      assert.equal(calls[3].request.operationId, nextId);
      assert.equal(calls[3].request.entryId, calls[2].request.entryId);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}
