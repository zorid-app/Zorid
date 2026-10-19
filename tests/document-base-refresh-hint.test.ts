import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentService } from '../src/core/document-semantics.ts';
import type { DocumentTransport } from '../src/core/document-semantics.ts';
const snapshot = { localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: { schema: 1, extraction: 'md1', resolver: 'r1', query: 'q1' } };
const source = { localStoreId: 'store', watermark: '1' };
async function read(result: unknown) {
  const service = createDocumentService({
    open: async () => ({ pinId: 'pin', snapshot, source, coverageComplete: true }), closePin: async () => {},
    base: async () => ({ snapshot, source, coverageComplete: true, value: { definition: {}, result } }),
  } as unknown as DocumentTransport);
  const pin = await service.open(); try { return await pin.base({ id: 'base', options: { clockMs: 0 } }); } finally { await pin.close(); }
}
test('actual pin Base boundary accepts absent and null hints plus each versioned dependency', async () => {
  for (const body of [{}, { refreshHint: null }, ...(['none', 'day', 'instant'] as const).map(dependency => ({ refreshHint: { dependency, timezone: 'America/Toronto', nextWakeMs: dependency === 'none' ? null : 1_000 } }))]) {
    const result = await read(body); assert.deepEqual(result.value.result, body);
  }
});
test('actual Base boundary rejects malformed scheduling hints rather than trusting casts', async () => {
  const valid = { dependency: 'day', timezone: 'UTC', nextWakeMs: 1_000 };
  for (const hint of [undefined, [], {}, { ...valid, extra: true }, { timezone: 'UTC', nextWakeMs: 1_000 }, { ...valid, dependency: 'minute' }, { ...valid, dependency: 'none' }, { ...valid, timezone: '' }, { ...valid, timezone: 'z'.repeat(129) }, { ...valid, nextWakeMs: '1000' }, { ...valid, nextWakeMs: 1.5 }, { ...valid, nextWakeMs: 0 }, { ...valid, nextWakeMs: 253402300800000 }, { ...valid, nextWakeMs: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(read({ refreshHint: hint }), error => (error as { code?: string }).code === 'invalid_document_response');
  }
});
