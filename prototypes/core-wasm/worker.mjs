import { runSyncChecks } from './sync-checks.mjs';
import init, { WasmTextReplica, planMutation, validatePath, checkIdempotency } from './pkg/zorid_wasm.js';

function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
function rejects(fn, label) {
  try { fn(); } catch (error) { return String(error); }
  throw new Error(`expected rejection: ${label}`);
}

self.onmessage = async () => {
  const replicas = [];
  const checks = [];
  const replica = actor => { const value = new WasmTextReplica(actor); replicas.push(value); return value; };
  try {
    await init();
    const seed = replica(1);
    seed.insert(0, 'Hello 🦀 world');
    const a = replica(2);
    const b = replica(3);
    a.apply(seed.snapshot());
    b.apply(seed.snapshot());
    const before = a.stateVector();
    a.insert(8, ' Rust');
    const first = a.changesSince(before);
    const afterFirst = a.stateVector();
    a.insert(13, '!');
    const second = a.changesSince(afterFirst);
    b.delete(9, 5);
    b.insert(9, '世界');
    const bDiff = b.changesSince(before);
    a.apply(bDiff);
    b.apply(second);
    b.apply(second);
    b.apply(first);
    b.apply(first);
    equal(a.text(), 'Hello 🦀 Rust! 世界', 'concurrent edits');
    equal(b.text(), a.text(), 'reordered dependent updates');
    if (!(a.snapshot() instanceof Uint8Array)) throw new Error('snapshot is not bytes');
    checks.push('WASM concurrent UTF-16 edits converge with duplicate and reordered delivery');

    const restored = replica(4);
    restored.apply(a.snapshot());
    equal(restored.text(), a.text(), 'snapshot reconstruction');
    checks.push('WASM binary snapshot reconstructs a fresh instance');

    const removed = replica(5);
    removed.apply(seed.snapshot());
    const originalVector = removed.stateVector();
    removed.delete(9, 5);
    equal(Array.from(removed.stateVector()), Array.from(originalVector), 'deletion vector');
    const deletionReceiver = replica(6);
    deletionReceiver.apply(seed.snapshot());
    deletionReceiver.apply(removed.changesSince(originalVector));
    equal(deletionReceiver.text(), 'Hello 🦀 ', 'deletion with equal vectors');
    checks.push('WASM deletion-only changes survive equal state vectors');

    rejects(() => restored.apply(Uint8Array.of(255)), 'malformed update');
    rejects(() => restored.changesSince(Uint8Array.of(255)), 'malformed vector');
    const bad = replica(7);
    bad.insert(0, 'a🦀z');
    rejects(() => bad.insert(2, 'x'), 'surrogate split');
    rejects(() => bad.delete(1, 1), 'surrogate delete');
    for (const value of [-1, 0.5, NaN, Infinity, 2 ** 32]) {
      rejects(() => bad.insert(value, 'x'), 'numeric index');
      rejects(() => new WasmTextReplica(value), 'actor coercion');
    }
    equal(bad.text(), 'a🦀z', 'rejected mutation preserves text');
    checks.push('WASM errors cross JS boundary for invalid bytes, UTF-16 ranges and numeric coercions');

    equal(validatePath('Notes/世界.md'), 'Notes/世界.md', 'path');
    rejects(() => validatePath('../outside'), 'path escape');
    rejects(() => validatePath('.zorid/keys'), 'reserved path');
    const plan = input => JSON.parse(planMutation(JSON.stringify(input)));
    const create = {
      request: { operation_id: 'op-create', mutation: {
        type: 'create', id: 'blob-1', path: 'photo.custom', kind: 'file', content: [0, 255, 128],
      } }, entries: [], next_revision: 'rev-1',
    };
    const created = plan(create);
    equal(created[0].after.path, 'photo.custom', 'create plan');
    const moved = plan({
      request: { operation_id: 'op-move', mutation: {
        type: 'move', id: 'blob-1', expected: 'rev-1', path: 'renamed.custom',
      } }, entries: [created[0].after], next_revision: 'rev-2',
    });
    equal(moved[0].before.path, 'photo.custom', 'move before');
    equal(moved[0].after.path, 'renamed.custom', 'move after');
    const conflict = rejects(() => plan({
      request: { operation_id: 'op-stale', mutation: {
        type: 'write', id: 'blob-1', expected: 'rev-1', content: [3],
      } }, entries: [moved[0].after], next_revision: 'rev-3',
    }), 'revision conflict');
    equal(JSON.parse(conflict).code, 'revision_conflict', 'structured contract error');
    const invalidByte = structuredClone(create);
    invalidByte.request.mutation.content = [256];
    rejects(() => plan(invalidByte), 'binary byte range');
    rejects(() => planMutation('{bad'), 'invalid JSON');
    checks.push('Real Rust planner validates paths, binary create, move and stale revisions through JSON');

    const receipt = { operation_id: 'op-create', sequence: '9007199254740993', changes: created };
    const record = { request: create.request, result: receipt };
    const checkReplay = value => JSON.parse(checkIdempotency(JSON.stringify(value)));
    equal(checkReplay({ request: create.request, record: null }), { status: 'new' }, 'new operation');
    // Target has moved to rev-2 above. Exact retry still returns the rev-1 receipt.
    equal(checkReplay({ request: create.request, record }), { status: 'replay', result: receipt }, 'original replay receipt');
    const mismatch = structuredClone(create.request);
    mismatch.mutation.content = [0, 254, 128];
    const mismatchError = rejects(() => checkReplay({ request: mismatch, record }), 'idempotency bytes');
    equal(JSON.parse(mismatchError).code, 'idempotency_conflict', 'byte mismatch code');
    const wrongId = structuredClone(create.request);
    wrongId.operation_id = 'wrong';
    equal(JSON.parse(rejects(() => checkReplay({ request: wrongId, record }), 'wrong op ID')).code, 'invalid_operation_record', 'wrong op ID code');
    const broken = structuredClone(record);
    broken.result.changes = [];
    equal(JSON.parse(rejects(() => checkReplay({ request: create.request, record: broken }), 'corrupt receipt')).code, 'invalid_operation_record', 'corrupt receipt code');
    rejects(() => checkReplay({ request: create.request, record, extra: true }), 'unknown idempotency field');
    const numericSequence = structuredClone(record);
    numericSequence.result.sequence = 9007199254740992;
    rejects(() => checkReplay({ request: create.request, record: numericSequence }), 'numeric sequence');
    checks.push('Rust idempotency checks exact replay, changed bytes, wrong IDs, corrupt receipts and decimal sequence above 2^53');


    runSyncChecks(checks);
    self.postMessage({ ok: true, checks, text: a.text(), implementation: 'Rust WASM worker; no native process or persistence' });
  } catch (error) {
    self.postMessage({ ok: false, checks, error: String(error), stack: error?.stack });
  } finally {
    for (const value of replicas) value.free();
  }
};
