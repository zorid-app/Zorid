'use strict';
// Protocol/provider tests use explicit in-memory peers; no native process or
// filesystem commit is fabricated as acceptance evidence by these helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SOURCE_LIMIT, PATH_LIMIT, captureSavedSourceWitness, captureSavedSourceGuard, captureSavedSourceValue, validSavedSourceReply, decodeSavedSourceReply } = require('../desktop/conditional-saved-source.cjs');
const { RustVaultService } = require('../desktop/rust-vault-service.cjs');
const witness = { entryId: 'entry', revision: 'revision', path: 'Books/Note.md' };
const command = { method: 'capture_saved_source', client_id: 'client', entry_id: witness.entryId, revision: witness.revision, path: witness.path };
function response(source = '\ufeffscore: 7\u0000\n🚀') {
  const bytes = Buffer.from(source, 'utf8');
  return { result: { capture: { capture_id: 'capture-opaque', logical_witness: { entry_id: witness.entryId, revision: witness.revision, path: witness.path }, byte_length: bytes.length } }, bytes };
}

test('physical source preserves BOM, valid NUL and Unicode without replacing its logical witness', () => {
  const { result, bytes } = response();
  assert.equal(validSavedSourceReply(command, result, bytes), true);
  const capture = decodeSavedSourceReply(command, result, bytes);
  assert.equal(capture.source, '\ufeffscore: 7\u0000\n🚀');
  assert.deepEqual(capture.logicalWitness, witness);
  assert.notEqual(capture.source, 'logical score: 1');
  assert.ok(Object.isFrozen(capture) && Object.isFrozen(capture.logicalWitness));
  assert.deepEqual(captureSavedSourceGuard({ captureId: capture.captureId, logicalWitness: capture.logicalWitness }), { captureId: 'capture-opaque', logicalWitness: witness });
});

test('wire captures reject byte mismatch, foreign logical witnesses, extra fields and invalid UTF8', () => {
  const { result, bytes } = response();
  for (const patch of [{ byte_length: bytes.length - 1 }, { byte_length: -1 }, { byte_length: 1.5 }, { capture_id: '' }, { extra: true }]) {
    assert.equal(validSavedSourceReply(command, { capture: { ...result.capture, ...patch } }, bytes), false);
  }
  for (const patch of [{ entry_id: 'foreign' }, { revision: 'foreign' }, { path: 'Other.md' }, { extra: true }]) {
    assert.equal(validSavedSourceReply(command, { capture: { ...result.capture, logical_witness: { ...result.capture.logical_witness, ...patch } } }, bytes), false);
  }
  for (const malformed of [Buffer.from([0xff]), Buffer.from([0xc0, 0x80]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80])]) {
    assert.throws(() => decodeSavedSourceReply(command, { capture: { ...result.capture, byte_length: malformed.length } }, malformed), { code: 'invalid_saved_source' });
  }
  const oversized = new Uint8Array(SOURCE_LIMIT + 1);
  assert.equal(validSavedSourceReply(command, { capture: { ...result.capture, byte_length: oversized.length } }, oversized), false);
  assert.throws(() => captureSavedSourceValue({ captureId: 'capture', logicalWitness: witness, source: '\ud800' }, witness), { code: 'invalid_saved_source' });
});

test('capture control is exact bounded data and never a caller supplied physical proof', () => {
  assert.equal(captureSavedSourceWitness({ ...witness, path: 'é'.repeat(PATH_LIMIT / 2) }).path.length, PATH_LIMIT / 2);
  for (const path of ['', '/Books/Note.md', 'Books//Note.md', '../Note.md', 'Books/./Note.md', 'Books\\Note.md', '.zorid/private', 'Book\u0000.md', '\ud800', `${'é'.repeat(PATH_LIMIT / 2)}x`]) {
    assert.throws(() => captureSavedSourceWitness({ ...witness, path }), { code: 'invalid_saved_source' }, JSON.stringify(path));
  }
  assert.throws(() => captureSavedSourceWitness({ ...witness, source: 'pretend source' }), { code: 'invalid_saved_source' });
  assert.throws(() => captureSavedSourceGuard({ captureId: 'capture', logicalWitness: witness, source: 'pretend source' }), { code: 'invalid_saved_source' });
  assert.throws(() => captureSavedSourceValue({ captureId: 'capture', logicalWitness: { ...witness, revision: 'other' }, source: '7' }, witness), { code: 'invalid_saved_source' });
  let getterRan = false;
  const input = { ...witness };
  Object.defineProperty(input, 'path', { enumerable: true, get() { getterRan = true; return witness.path; } });
  assert.throws(() => captureSavedSourceWitness(input), { code: 'invalid_saved_source' });
  assert.equal(getterRan, false);
});

test('transport bounds capture/release bodies before allocating an oversized response frame', async () => {
  for (const [method, length] of [['capture_saved_source', SOURCE_LIMIT + 1], ['release_saved_source', 1]]) {
    const host = Object.create(RustVaultService.prototype);
    Object.assign(host, { prefix: Buffer.alloc(8), prefixUsed: 0, frame: null, pending: { command: { method } } });
    let rejected;
    host.abort = error => { rejected = error; host.fatal = error; };
    const prefix = Buffer.alloc(8); prefix.writeUInt32BE(1, 0); prefix.writeUInt32BE(length, 4);
    host.receive(prefix);
    assert.equal(rejected?.code, 'invalid_response');
    assert.equal(host.frame, null);
    await assert.rejects(RustVaultService.prototype.request.call({}, { method }, new Uint8Array([1])), { code: 'invalid_request' });
  }
});

test('native methods snapshot witness, carry the actual lease and reauthorize queued dispatch', async () => {
  const host = Object.create(RustVaultService.prototype), requests = [];
  host.capabilities = Object.freeze(['conditional_saved_source']);
  const lease = { local_store_id: 'store', client_id: 'client', token: 'lease' };
  let active = true, release;
  const gate = new Promise(resolve => { release = resolve; });
  host.request = async (request, bytes, reference, beforeDispatch) => {
    requests.push({ request, reference });
    await gate; beforeDispatch();
    return response();
  };
  const guarded = host.withClientLease(lease, () => { if (!active) throw Object.assign(new Error('retired'), { code: 'grant_retired' }); });
  const input = { ...witness };
  const pending = guarded.captureSavedSource('client', input);
  input.path = 'Other.md';
  assert.equal(requests[0].request.path, witness.path);
  assert.deepEqual(requests[0].reference, lease);
  active = false; release();
  await assert.rejects(pending, { code: 'grant_retired' });
});

test('prepare attaches only the exact opaque capture header, never source text or new mutation fields', async () => {
  const host = Object.create(RustVaultService.prototype), calls = [];
  host.capabilities = ['conditional_saved_source'];
  host.request = async (request, bytes) => { calls.push({ request, bytes: new Uint8Array(bytes) }); return { result: { intent: { token: 'intent' } } }; };
  const request = { operation_id: 'op', mutation: { type: 'write', id: 'entry', expected: 'revision' } }, bytes = Buffer.from('next');
  await host.prepareIntent('client', request, bytes, 'capture-original');
  await host.prepareIntent('client', request, bytes, 'capture-original');
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0].request, { method: 'prepare_intent', client_id: 'client', ...request, source_capture: 'capture-original' });
  assert.deepEqual(calls[0].request.mutation, request.mutation);
  await host.prepareIntent('client', request, bytes);
  assert.equal(Object.hasOwn(calls[2].request, 'source_capture'), false);
  assert.throws(() => host.prepareIntent('client', request, bytes, null), { code: 'invalid_saved_source' });
  const oldHost = Object.create(RustVaultService.prototype); oldHost.capabilities = [];
  await assert.rejects(oldHost.captureSavedSource('client', witness), { code: 'unsupported_host_capability' });
});
