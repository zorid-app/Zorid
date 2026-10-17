'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { desktopCheckpoints, checkpointBytes } = require('../desktop/durable-checkpoints.cjs');
const scope = { vaultId: 'authority', clientId: 'client' };
const revision = '00000000-0000-0000-0000-000000000001';
const row = state => ({ version: 1, ...scope, key: 'entry', revision, sequence: '1', deleted: state === null, byteLength: state === null ? 0 : Buffer.byteLength(state), encodedState: state });

test('checkpoint calls capture exact scope and request before awaits', async () => {
  let release, observed;
  const mutableScope = { ...scope };
  const cp = desktopCheckpoints({ checkpointCompareAndSwap: (bound, request) => {
    observed = { bound, request }; return new Promise(resolve => { release = () => resolve(row('draft')); });
  } }, mutableScope, () => {});
  const input = { key: 'entry', expectedRevision: null, nextRevision: revision, encodedState: 'draft' };
  const pending = cp.compareAndSwap(input);
  mutableScope.vaultId = 'other'; input.encodedState = 'newer'; input.nextRevision = 'other';
  release(); assert.equal((await pending).encodedState, 'draft');
  assert.deepEqual(observed.bound, scope); assert.equal(observed.request.encodedState, 'draft');
  assert.ok(Object.isFrozen(cp.scope));
});

test('checkpoint state rejects malformed text and oversized allocation before native mutation', async () => {
  let calls = 0;
  const cp = desktopCheckpoints({ checkpointCompareAndSwap: async () => { calls++; } }, scope, () => {});
  for (const encodedState of ['\ud800', '\udfff']) await assert.rejects(cp.compareAndSwap({ key: 'entry', expectedRevision: null, nextRevision: revision, encodedState }), { code: 'checkpoint_invalid' });
  assert.throws(() => checkpointBytes('x'.repeat(32 * 1024 * 1024 + 1)), { code: 'checkpoint_limit' });
  assert.deepEqual(checkpointBytes('\ufeff\ud83d\ude80\n'), Buffer.from('\ufeff\ud83d\ude80\n'));
  assert.equal(calls, 0);
});

test('mismatched checkpoint response is uncertain and empty-page continuation is retained', async () => {
  const cp = desktopCheckpoints({ checkpointCompareAndSwap: async () => row('different'),
    checkpointList: async () => ({ items: [], cursor: 'opaque-next', highWater: '9' }) }, scope, () => {});
  await assert.rejects(cp.compareAndSwap({ key: 'entry', expectedRevision: null, nextRevision: revision, encodedState: 'draft' }), { code: 'outcome_unknown', commitUncertain: true });
  const page = await cp.list({ limit: 1 });
  assert.equal(page.cursor, 'opaque-next'); assert.equal(page.highWater, '9');
});

test('oversized checkpoint metadata pages shrink without advancing a cursor', async () => {
  const calls = [];
  const cp = desktopCheckpoints({ checkpointList: async (_scope, request) => {
    calls.push(request);
    if (request.limit > 25) throw Object.assign(new Error('large'), { code: 'response_limit' });
    return { items: [], cursor: null, highWater: '9' };
  } }, scope, () => {});
  await cp.list({ limit: 100, cursor: 'same-cursor' });
  assert.deepEqual(calls.map(value => [value.limit, value.cursor]), [[100, 'same-cursor'], [50, 'same-cursor'], [25, 'same-cursor']]);
});
