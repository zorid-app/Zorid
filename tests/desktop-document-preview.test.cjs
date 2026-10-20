'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {captureDocumentRequest, decodeDocumentReply, createDesktopDocumentSemantics, MAX_DOCUMENT_RESPONSE} = require('../desktop/document-semantics.cjs');
const request = (op, fields = {}) => ({schemaVersion: 1, command: {op, ...fields}});
const capture = {ownerNonce: 'owner', stageId: 'stage', serial: '9007199254740993'};
const source = {localStoreId: 'store', watermark: '9007199254740993'};
const progress = {preparedFiles: 1, totalFiles: 3, pendingFiles: 2};
const snapshot = {localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: {schema: 1, extraction: 'v1', resolver: 'v1', query: 'v1'}};
const opened = previewId => ({previewId, capture: {...capture}, source: {...source}, progress: {...progress}});
const pin = pinId => ({pinId, snapshot, source, coverageComplete: false});
function wire(op, value) {
  const bytes = new TextEncoder().encode(JSON.stringify({schemaVersion: 1, op, value}));
  return [{documents: true, schemaVersion: 1, bytes: bytes.length}, bytes];
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }
const coded = error => Boolean(error && typeof error.code === 'string');
function controller(documentCommand, options = {basePreviewAvailable: true}, client = 'client') {
  return createDesktopDocumentSemantics({documentCommand}, client, 'store', options);
}

test('preview request codec captures bounded Base options and rejects authority injection or noncanonical IDs', () => {
  const input = request('preview_base', {previewId: '9007199254740993', id: 'base', viewName: null, options: {searchTerms: ['before'], clockMs: 0, maxRows: 3, maxSteps: 1}});
  const captured = captureDocumentRequest(input);
  input.command.options.searchTerms[0] = 'changed';
  assert.deepEqual(captured.command.options.searchTerms, ['before']);
  assert.equal(captured.command.previewId, '9007199254740993');
  for (const input of [
    ...['0', '01', '18446744073709551616', 'bad', 1].map(previewId => request('preview_open', {previewId})),
    request('preview_open', {previewId: '1', pinId: '1'}),
    request('preview_open', {previewId: '1', capture}),
    request('preview_base', {previewId: '1', id: 'base', source}),
    request('preview_base', {previewId: '1', id: 'bad:path'}),
    request('preview_base', {previewId: '1', id: 'base', viewName: '\ud800'}),
    request('preview_base', {previewId: '1', id: 'base', options: {maxSteps: 0}}),
    request('preview_base', {previewId: '1', id: 'base', options: {maxRows: 10001}}),
    request('preview_base', {previewId: '1', id: 'base', options: {currentRecord: {}}}),
    request('preview_base', {previewId: '1', id: 'base', options: null}),
    request('preview_close', {previewId: '1', serial: '1'}),
  ]) assert.throws(() => captureDocumentRequest(input), coded);
  assert.throws(() => captureDocumentRequest(request('preview_base', {previewId: '1', id: 'base', options: {searchTerms: Array(256).fill('x'.repeat(4096))}})), coded);
});

test('preview open and close replies use strict small control DTOs with exact capture and progress', () => {
  const input = request('preview_open', {previewId: '1'});
  assert.deepEqual(decodeDocumentReply(input, ...wire('preview_open', opened('1'))), opened('1'));
  assert.equal(decodeDocumentReply(input, ...wire('preview_open', null)), null);
  for (const value of [
    {...opened('1'), extra: true}, opened('2'),
    {...opened('1'), capture: {...capture, serial: '0'}},
    {...opened('1'), capture: {...capture, serial: '01'}},
    {...opened('1'), capture: {...capture, stageId: 'bad:path'}},
    {...opened('1'), capture: {...capture, snapshot}},
    {...opened('1'), source: {...source, watermark: '01'}},
    {...opened('1'), progress: {...progress, pendingFiles: 1}},
    {...opened('1'), progress: {...progress, preparedFiles: -1}},
  ]) assert.throws(() => decodeDocumentReply(input, ...wire('preview_open', value)), {code: 'invalid_document_response'});
  const close = request('preview_close', {previewId: '1'});
  assert.deepEqual(decodeDocumentReply(close, ...wire('preview_close', {closed: true})), {closed: true});
  for (const value of [true, {closed: false}, {closed: true, extra: 1}]) assert.throws(() => decodeDocumentReply(close, ...wire('preview_close', value)), {code: 'invalid_document_response'});
});

test('preview Base transport validates dedicated framing and forwards bytes without UTF8 decode or JSON parse', () => {
  const fs = require('node:fs'), vm = require('node:vm'), module = {exports: {}};
  let parses = 0;
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/document-semantics.cjs'), 'utf8'), {
    module, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, structuredClone,
    JSON: {stringify: JSON.stringify, parse() { parses++; throw Error('No eager preview JSON parsing'); }},
  });
  const portable = module.exports;
  const input = request('preview_base', {previewId: '1', id: 'base'});
  const bytes = new Uint8Array([255, 0, 1]); // Deliberately not a valid result: renderer owns decoding.
  const marker = {documents: true, schemaVersion: 1, bytes: bytes.length};
  const raw = portable.decodeDocumentReply(input, marker, bytes);
  assert.equal(raw.previewBytes, bytes);
  assert.equal(parses, 0);
  for (const [badMarker, badBytes] of [
    [{...marker, bytes: 2}, bytes], [{...marker, extra: true}, bytes],
    [{...marker, documents: false}, bytes], [{...marker, schemaVersion: 2}, bytes],
    [{...marker, bytes: 0}, new Uint8Array()],
    [{...marker, bytes: 1}, new Uint8Array(new ArrayBuffer(2), 1, 1)],
    ...(typeof SharedArrayBuffer === 'function' ? [[{...marker, bytes: 1}, new Uint8Array(new SharedArrayBuffer(1))]] : []),
    [{...marker, bytes: MAX_DOCUMENT_RESPONSE + 1}, new Uint8Array(MAX_DOCUMENT_RESPONSE + 1)],
  ]) assert.throws(() => portable.decodeDocumentReply(input, badMarker, badBytes), coded);
  assert.equal(parses, 0);
});

test('preview capability defaults off and rejects all preview operations before backend IO', async () => {
  let calls = 0;
  const run = async () => { calls++; throw Error('No preview backend access'); };
  for (const options of [{}, {basePreviewAvailable: false}]) {
    const owner = controller(run, options);
    for (const input of [request('preview_open', {previewId: '1'}), request('preview_base', {previewId: '1', id: 'base'}), request('preview_close', {previewId: '1'})]) {
      await assert.rejects(owner.invoke(input), {code: 'unsupported_host_capability'});
    }
  }
  assert.equal(calls, 0);
  assert.throws(() => createDesktopDocumentSemantics({}, 'client', 'store', {basePreviewAvailable: true}), {code: 'unsupported_host_capability'});
});

test('same-ID preview open calls backend again and cannot substitute capture source progress or null', async () => {
  for (const replacement of [
    {...opened('1'), capture: {...capture, serial: '9007199254740994'}},
    {...opened('1'), source: {...source, watermark: '9007199254740994'}},
    {...opened('1'), source: {...source, localStoreId: 'foreign'}},
    {...opened('1'), progress: {preparedFiles: 2, totalFiles: 3, pendingFiles: 1}}, null,
  ]) {
    let calls = 0, reply = opened('1');
    const owner = controller(async (_client, input) => { assert.equal(input.command.op, 'preview_open'); calls++; return reply; });
    await owner.invoke(request('preview_open', {previewId: '1'}));
    await owner.invoke(request('preview_open', {previewId: '1'}));
    assert.equal(calls, 2, 'replay is revalidated by the real backend');
    reply = replacement;
    await assert.rejects(owner.invoke(request('preview_open', {previewId: '1'})), {code: 'invalid_document_response'});
    assert.equal(calls, 3);
  }
});

test('null preview consumes its ID without a slot and closed IDs cannot be rebound or confused with pin IDs', async () => {
  const seen = [];
  const owner = controller(async (_client, input) => {
    const c = input.command; seen.push([c.op, c.previewId ?? c.pinId]);
    if (c.op === 'preview_open') return c.previewId === '1' ? null : opened(c.previewId);
    if (c.op === 'open') return pin(c.pinId);
    return {closed: true};
  });
  assert.equal(await owner.invoke(request('preview_open', {previewId: '1'})), null);
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '1'})), {code: 'index_preview_expired'});
  await owner.invoke(request('preview_open', {previewId: '2'}));
  await owner.invoke(request('open', {pinId: '1'}));
  await owner.invoke(request('preview_close', {previewId: '2'}));
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '2'})), {code: 'index_preview_expired'});
  await owner.invoke(request('preview_close', {previewId: '2'})); // Exact closed history is idempotent.
  await assert.rejects(owner.invoke(request('preview_close', {previewId: '3'})), {code: 'index_preview_expired'});
  await owner.invoke(request('preview_open', {previewId: '3'}));
  assert.equal(seen.filter(([op]) => op === 'open').length, 1);
  assert.equal(seen.filter(([op, id]) => op === 'preview_open' && id === '2').length, 1);
});

test('four combined pins and previews include pending preview opens before backend work', async () => {
  const gate = deferred(), entered = deferred();
  const seen = [];
  const owner = controller(async (_client, input) => {
    const c = input.command; seen.push(c.op + ':' + (c.pinId ?? c.previewId));
    if (c.op === 'open') return pin(c.pinId);
    if (c.op === 'preview_open') {
      if (c.previewId === '2') { entered.resolve(); await gate.promise; }
      return opened(c.previewId);
    }
    return c.op === 'preview_close' ? {closed: true} : true;
  });
  await owner.invoke(request('open', {pinId: '1'}));
  await owner.invoke(request('open', {pinId: '2'}));
  await owner.invoke(request('preview_open', {previewId: '1'}));
  const pending = owner.invoke(request('preview_open', {previewId: '2'}));
  await entered.promise;
  const beforePreview = seen.length;
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '3'})), {code: 'pin_capacity'});
  const previewProbes = seen.slice(beforePreview);
  assert.ok(previewProbes.length <= 4);
  assert.ok(previewProbes.every(call => call === 'preview_open:1'), 'only the resolved preview may be probed, never pending preview 2 or new preview 3');
  const beforePin = seen.length;
  await assert.rejects(owner.invoke(request('open', {pinId: '3'})), {code: 'pin_capacity'});
  const pinProbes = seen.slice(beforePin);
  assert.ok(pinProbes.length <= 4);
  assert.ok(pinProbes.every(call => call === 'preview_open:1'), 'pressure cannot send the rejected new pin or probe pending preview 2');
  gate.resolve(); await pending;
  await owner.invoke(request('close', {pinId: '2'}));
  await owner.invoke(request('preview_open', {previewId: '4'}));
});

test('foreign preview IDs fail before IO and closing fences accepted Base replies', async () => {
  const gate = deferred(), entered = deferred();
  let baseCalls = 0;
  const host = async (_client, input) => {
    const c = input.command;
    if (c.op === 'preview_open') return opened(c.previewId);
    if (c.op === 'preview_base') { baseCalls++; entered.resolve(); return gate.promise; }
    return {closed: true};
  };
  const owner = controller(host), foreign = controller(host, {basePreviewAvailable: true}, 'foreign');
  await owner.invoke(request('preview_open', {previewId: '1'}));
  await assert.rejects(foreign.invoke(request('preview_base', {previewId: '1', id: 'base'})), {code: 'index_preview_expired'});
  await assert.rejects(foreign.invoke(request('preview_close', {previewId: '1'})), {code: 'index_preview_expired'});
  assert.equal(baseCalls, 0);
  const pending = owner.invoke(request('preview_base', {previewId: '1', id: 'base'}));
  await entered.promise;
  await owner.invoke(request('preview_close', {previewId: '1'}));
  await assert.rejects(owner.invoke(request('preview_base', {previewId: '1', id: 'base'})), {code: 'index_preview_expired'});
  gate.resolve({previewBytes: new Uint8Array([1])});
  await assert.rejects(pending, {code: 'index_preview_expired'});
  assert.equal(baseCalls, 1);
});

test('uncertain preview close keeps its exact closing identity and permits only close retry', async () => {
  let fails = true;
  const calls = [];
  const owner = controller(async (_client, input) => {
    const c = input.command; calls.push([c.op, c.previewId]);
    if (c.op === 'preview_open') return opened(c.previewId);
    if (c.op === 'preview_close') { if (fails) { fails = false; throw {code: 'transport_error'}; } return {closed: true}; }
    throw Error('No reads while closing');
  });
  await owner.invoke(request('preview_open', {previewId: '1'}));
  await assert.rejects(owner.invoke(request('preview_close', {previewId: '1'})), {code: 'transport_error'});
  await assert.rejects(owner.invoke(request('preview_base', {previewId: '1', id: 'base'})), {code: 'index_preview_expired'});
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '1'})), {code: 'index_preview_expired'});
  await owner.invoke(request('preview_close', {previewId: '1'}));
  assert.deepEqual(calls, [['preview_open', '1'], ['preview_close', '1'], ['preview_close', '1']]);
});

test('retirement rejects late preview opens and reads without recreating local ownership', async () => {
  for (const op of ['preview_open', 'preview_base']) {
    const gate = deferred(), entered = deferred();
    let hold = false;
    const owner = controller(async (_client, input) => {
      if (hold) { entered.resolve(); return gate.promise; }
      return opened(input.command.previewId);
    });
    if (op === 'preview_base') await owner.invoke(request('preview_open', {previewId: '1'}));
    hold = true;
    const pending = owner.invoke(request(op, {previewId: '1', ...(op === 'preview_base' ? {id: 'base'} : {})}));
    await entered.promise;
    owner.forget();
    gate.resolve(op === 'preview_open' ? opened('1') : {previewBytes: new Uint8Array([1])});
    await assert.rejects(pending, {code: 'client_not_admitted'});
    await assert.rejects(owner.invoke(request('preview_open', {previewId: '2'})), {code: 'client_not_admitted'});
  }
});

function admissionFixture({enabled, backendPreview = true, documents = true, malformed = null}) {
  const {RustVaultService} = require('../desktop/rust-vault-service.cjs');
  const clientId = '10000000-0000-4000-8000-000000000001';
  const lease = {local_store_id: 'store', client_id: clientId, token: '10000000-0000-4000-8000-000000000002'};
  const state = {leased: false, claims: 0, releases: [], documents: [], registrations: 0, owner: []};
  const host = Object.create(RustVaultService.prototype);
  host.capabilities = [...(documents ? ['documents'] : []), 'document_runtime', ...(backendPreview ? ['document_base_preview'] : [])];
  host.request = async (command, _bytes, reference, dispatchGuard) => {
    if (dispatchGuard) dispatchGuard();
    if (command.method === 'claim_client') {
      assert.equal(command.client_id, clientId);
      assert.equal(state.leased, false);
      state.claims++; state.leased = true;
      return {result: {lease}};
    }
    if (command.method === 'release_client') {
      assert.equal(state.leased, true);
      assert.deepEqual(command.reference, lease);
      state.releases.push(command.reference); state.leased = false;
      return {result: {released: true, reference: command.reference}};
    }
    assert.equal(state.leased, true);
    assert.deepEqual(reference, lease, 'all admitted RPCs retain the exact claimed lease');
    if (command.method === 'identity') return {result: {identity: {local_store_id: 'store', realm_id: null, vault_id: null}}, bytes: new Uint8Array()};
    assert.equal(command.method, 'documents');
    assert.equal(command.client_id, clientId);
    state.documents.push(command.request);
    const c = command.request.command;
    const value = c.op === 'preview_open' ? opened(c.previewId) : c.op === 'preview_close' ? {closed: true} : assert.fail('Unexpected preview RPC');
    const [result, bytes] = wire(c.op, value);
    return {result, bytes};
  };
  const frame = () => ({version: 1, scope: {localStoreId: 'store', clientId}, update: null, outcomes: []});
  const owner = {
    async observe() {return frame();}, async control(input) {return {...input, frame: frame()};},
    async ackControl() {return true;}, async ackOutcome() {return true;}, subscribe() {return () => {};},
    async pause() {assert.equal(state.leased, true); state.owner.push('pause');},
    resume() {state.owner.push('resume');},
    async prepareRelease() {assert.equal(state.leased, true); state.owner.push('prepareRelease');},
    release() {state.owner.push('release');}, async revoke() {state.owner.push('revoke');},
  };
  if (malformed === 'incomplete-owner') delete owner.observe;
  const service = {
    host, closed: false, documentRuntimeEnabled: enabled,
    registerDocumentRuntimeOwner(input) {
      state.registrations++;
      assert.equal(input.clientId, clientId); assert.equal(input.localStoreId, 'store');
      input.assertActive();
      return owner;
    },
  };
  if (malformed === 'missing-register') delete service.registerDocumentRuntimeOwner;
  return {service, state, lease, options: {fixture: true, clientId, assertOwner() {}}};
}

test('actual fixture admission forwards preview capability only when runtime and backend support are both positive', async () => {
  const {admitDesktopFixtureClient} = require('../desktop/client-admission.cjs');
  for (const [enabled, backendPreview] of [[false, true], [true, false], [true, true]]) {
    const f = admissionFixture({enabled, backendPreview});
    const context = await admitDesktopFixtureClient(f.service, f.options);
    const positive = enabled && backendPreview;
    assert.equal(Object.hasOwn(context, 'basePreviewAvailable'), positive);
    assert.equal(context.basePreviewAvailable === true, positive);
    assert.equal(f.state.registrations, enabled ? 1 : 0);
    if (positive) {
      // Real guarded RustVaultService.documentCommand captures the request and
      // decodes its actual stdio marker/body before the controller admits it.
      assert.deepEqual(await context.documentCommand(request('preview_open', {previewId: '1'})), opened('1'));
      assert.deepEqual(await context.documentCommand(request('preview_close', {previewId: '1'})), {closed: true});
      assert.deepEqual(f.state.documents.map(input => input.command.op), ['preview_open', 'preview_close']);
    } else {
      await assert.rejects(context.documentCommand(request('preview_open', {previewId: '1'})), {code: 'unsupported_host_capability'});
      assert.equal(f.state.documents.length, 0, 'disabled preview never reaches leased RPC');
    }
    assert.equal(f.state.leased, true);
    await context.release(() => {});
    await context.release(() => {});
    assert.equal(f.state.claims, 1);
    assert.deepEqual(f.state.releases, [f.lease]);
    assert.equal(f.state.leased, false);
    assert.deepEqual(f.state.owner, enabled ? ['pause', 'prepareRelease', 'release'] : []);
    await assert.rejects(context.documentCommand(request('preview_open', {previewId: '2'})), {code: 'client_not_admitted'});
    assert.equal(f.state.documents.length, positive ? 2 : 0);
  }
});

test('malformed positive preview admission fails closed and releases exactly its original lease', async () => {
  const {admitDesktopFixtureClient} = require('../desktop/client-admission.cjs');
  for (const malformed of ['incomplete-owner', 'missing-documents', 'missing-register']) {
    const f = admissionFixture({enabled: true, documents: malformed !== 'missing-documents', malformed});
    await assert.rejects(admitDesktopFixtureClient(f.service, f.options), {code: 'unsupported_host_capability'});
    assert.equal(f.state.claims, 1);
    assert.deepEqual(f.state.releases, [f.lease]);
    assert.equal(f.state.leased, false);
    assert.equal(f.state.documents.length, 0, 'invalid capability setup never opens a preview');
    assert.equal(f.state.registrations, malformed === 'incomplete-owner' ? 1 : 0);
  }
});

test('certain resource failures release unused preview slots while uncertain opens keep exact retry ownership', async () => {
  const attempts = new Map(), calls = [];
  const owner = controller(async (_client, input) => {
    const c = input.command; calls.push([c.op, c.previewId]);
    if (c.op === 'preview_close') return {closed: true};
    assert.equal(c.op, 'preview_open');
    const attempt = (attempts.get(c.previewId) ?? 0) + 1; attempts.set(c.previewId, attempt);
    if (BigInt(c.previewId) <= 4n) throw {code: 'index_resource', commitUncertain: false};
    if (c.previewId === '6' && attempt === 1) throw {code: 'transport_error', commitUncertain: true};
    if (c.previewId === '6' && attempt === 2) throw {code: 'index_resource', commitUncertain: false};
    return opened(c.previewId);
  });
  for (const previewId of ['1', '2', '3', '4']) {
    await assert.rejects(owner.invoke(request('preview_open', {previewId})), {code: 'index_resource', commitUncertain: false});
  }
  await owner.invoke(request('preview_open', {previewId: '5'}));
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '6'})), {code: 'transport_error', commitUncertain: true});
  await owner.invoke(request('preview_open', {previewId: '7'}));
  await owner.invoke(request('preview_open', {previewId: '8'}));
  const before = calls.length;
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '9'})), {code: 'pin_capacity'});
  const probes = calls.slice(before);
  assert.ok(probes.length <= 4);
  assert.ok(probes.every(([op, id]) => op === 'preview_open' && ['5', '7', '8'].includes(id)), 'unknown preview 6 and rejected preview 9 never enter pressure probes');
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '6'})), {code: 'index_resource', commitUncertain: false});
  // A later certain failure cannot erase the earlier uncertain allocation.
  const beforeRetryPressure = calls.length;
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '9'})), {code: 'pin_capacity'});
  const retryProbes = calls.slice(beforeRetryPressure);
  assert.ok(retryProbes.length <= 4);
  assert.ok(retryProbes.every(([op, id]) => op === 'preview_open' && ['5', '7', '8'].includes(id)));
  await owner.invoke(request('preview_open', {previewId: '6'}));
  assert.equal(attempts.get('6'), 3, 'same ID is always revalidated by the backend');
  await owner.invoke(request('preview_close', {previewId: '6'}));
  await owner.invoke(request('preview_open', {previewId: '10'}));
});

test('slot pressure revalidates stale previews by exact ID and admits an ordinary pin after backend expiry', async () => {
  const calls = [], probes = []; let publishedElsewhere = false;
  const owner = controller(async (_client, input) => {
    const c = input.command; calls.push([c.op, c.previewId ?? c.pinId]);
    if (c.op === 'preview_open') {
      if (publishedElsewhere && BigInt(c.previewId) <= 4n) {
        probes.push(c.previewId);
        throw {code: 'index_preview_expired', commitUncertain: false};
      }
      return opened(c.previewId);
    }
    if (c.op === 'open') return pin(c.pinId);
    throw Error('Expired preview must not receive a Base read');
  });
  for (const previewId of ['1', '2', '3', '4']) await owner.invoke(request('preview_open', {previewId}));
  const initialCalls = calls.length;
  publishedElsewhere = true; // Separate maintenance publication: no local notification or rebuild command.
  assert.equal(calls.length, initialCalls, 'idle ownership does not poll captures');
  await owner.invoke(request('open', {pinId: '1'}));
  assert.ok(probes.length > 0 && probes.length <= 4, 'one pressure pass has at most four candidates');
  assert.equal(new Set(probes).size, probes.length);
  assert.ok(probes.every(previewId => ['1', '2', '3', '4'].includes(previewId)));
  assert.deepEqual(calls.at(-1), ['open', '1']);
  const before = calls.length;
  await assert.rejects(owner.invoke(request('preview_base', {previewId: probes[0], id: 'base'})), {code: 'index_preview_expired'});
  assert.equal(calls.length, before, 'only backend-proven expired ownership was removed locally');
});

test('pressure cleanup preserves live previews and non-expiry failures instead of treating them as free slots', async () => {
  let pressure = false, failLive = false; const opens = [];
  const owner = controller(async (_client, input) => {
    const c = input.command;
    if (c.op === 'preview_open') {
      opens.push(c.previewId);
      if (pressure && c.previewId === '2') throw {code: 'index_preview_expired', commitUncertain: false};
      if (failLive && c.previewId === '3') throw {code: 'index_resource', commitUncertain: false};
      return opened(c.previewId);
    }
    if (c.op === 'preview_base') return {previewBytes: new Uint8Array([1])};
    throw Error('Unexpected operation');
  });
  for (const previewId of ['1', '2', '3', '4']) await owner.invoke(request('preview_open', {previewId}));
  pressure = true;
  await owner.invoke(request('preview_open', {previewId: '5'}));
  assert.equal(opens.filter(id => id === '5').length, 1);
  failLive = true;
  const before = opens.length;
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '6'})), coded);
  assert.ok(opens.length - before <= 4);
  assert.equal(opens.includes('6'), false, 'failure to prove expiry cannot overbook another capture');
  for (const previewId of ['1', '3', '4', '5']) {
    const value = await owner.invoke(request('preview_base', {previewId, id: 'base'}));
    assert.equal(value.previewBytes.byteLength, 1, 'current and resource-unavailable captures stay registered');
  }
});

test('concurrent pressure shares one bounded prune and never probes uncertain pending or closing ownership', async () => {
  const probe = deferred(), probeEntered = deferred(), pendingOpen = deferred(), pendingEntered = deferred();
  const attempts = new Map(), calls = []; let pressure = false;
  const owner = controller(async (_client, input) => {
    const c = input.command; calls.push([c.op, c.previewId]);
    if (c.op === 'preview_close') throw {code: 'transport_error', commitUncertain: true};
    assert.equal(c.op, 'preview_open');
    const attempt = (attempts.get(c.previewId) ?? 0) + 1; attempts.set(c.previewId, attempt);
    if (c.previewId === '2') throw {code: 'transport_error', commitUncertain: true};
    if (c.previewId === '3') {pendingEntered.resolve(); return pendingOpen.promise;}
    if (c.previewId === '1' && pressure) {
      probeEntered.resolve(); await probe.promise;
      throw {code: 'index_preview_expired', commitUncertain: false};
    }
    return opened(c.previewId);
  });
  await owner.invoke(request('preview_open', {previewId: '1'}));
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '2'})), {code: 'transport_error'});
  const unresolved = owner.invoke(request('preview_open', {previewId: '3'})); await pendingEntered.promise;
  await owner.invoke(request('preview_open', {previewId: '4'}));
  await assert.rejects(owner.invoke(request('preview_close', {previewId: '4'})), {code: 'transport_error'});
  pressure = true;
  const first = owner.invoke(request('preview_open', {previewId: '5'}));
  await probeEntered.promise;
  const second = owner.invoke(request('preview_open', {previewId: '6'}));
  probe.resolve();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(outcome => outcome.status === 'rejected');
  assert.equal(rejected.reason.code, 'pin_capacity');
  assert.equal(attempts.get('1'), 2, 'concurrent pressure reuses the same held revalidation');
  assert.equal(attempts.get('2'), 1, 'uncertain ownership is not probed');
  assert.equal(attempts.get('3'), 1, 'pending ownership is not probed');
  assert.equal(attempts.get('4'), 1, 'closing ownership is not probed');
  assert.equal(calls.filter(([op, id]) => op === 'preview_open' && ['5', '6'].includes(id)).length, 1, 'capacity is rechecked after the shared await');
  pendingOpen.resolve(opened('3')); await unresolved;
  owner.forget();
});

test('eight preview calls waiting on slot pressure consume admission credits before the shared await', async () => {
  const gate = deferred(), entered = deferred(), attempts = new Map();
  const calls = []; let pressure = false;
  const owner = controller(async (_client, input) => {
    const c = input.command; calls.push([c.op, c.previewId]);
    if (c.op === 'preview_base') return {previewBytes: new Uint8Array([1])};
    assert.equal(c.op, 'preview_open');
    attempts.set(c.previewId, (attempts.get(c.previewId) ?? 0) + 1);
    if (pressure && c.previewId === '1') {entered.resolve(); await gate.promise;}
    return opened(c.previewId);
  });
  for (const previewId of ['1', '2', '3', '4']) await owner.invoke(request('preview_open', {previewId}));
  pressure = true;
  const waiting = Array.from({length: 8}, (_, index) => owner.invoke(request('preview_open', {previewId: String(index + 5)})));
  const outcomes = Promise.allSettled(waiting);
  await entered.promise;
  await assert.rejects(owner.invoke(request('preview_open', {previewId: '13'})), {code: 'document_preview_capacity'});
  assert.equal(calls.some(([op, id]) => op === 'preview_open' && BigInt(id) > 4n), false);
  gate.resolve();
  const settled = await outcomes;
  assert.equal(settled.length, 8);
  assert.ok(settled.every(outcome => outcome.status === 'rejected' && outcome.reason.code === 'pin_capacity'));
  for (const previewId of ['1', '2', '3', '4']) assert.equal(attempts.get(previewId), 2, 'all callers share one bounded pressure pass');
  assert.equal(calls.some(([op, id]) => op === 'preview_open' && BigInt(id) > 4n), false);
  assert.equal((await owner.invoke(request('preview_base', {previewId: '1', id: 'base'}))).previewBytes.byteLength, 1, 'failed pressure attempts release their credits');
});
