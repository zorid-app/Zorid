import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createDesktopDocumentRuntime, createDesktopDocumentService} from '../src/platform/desktop-document-semantics.ts';
import type {DesktopDocumentRequest} from '../src/platform/desktop-document-semantics.ts';
const {captureDocumentRequest} = createRequire(import.meta.url)('../desktop/document-semantics.cjs');
const capture = {ownerNonce: 'owner', stageId: 'stage', serial: '1'};
const source = {localStoreId: 'store', watermark: '2'};
const progress = {preparedFiles: 1, totalFiles: 3, pendingFiles: 2};
const snapshot = {localStoreId: 'store', generationEpoch: 'epoch', generation: '1', versions: {schema: 1, extraction: 'v1', resolver: 'v1', query: 'v1'}};
const opened = (previewId: unknown) => ({previewId, capture: {...capture}, source: {...source}, progress: {...progress}});
const pin = (pinId: unknown) => ({pinId, snapshot, source, coverageComplete: false});
function result(previewId: unknown = '1') {
  return {
    previewId, capture: {...capture}, source: {...source},
    definition: {id: 'base', revision: 'r1', path: 'Board.base', kind: 'file', deleted: false},
    result: {
      status: 'indexing', complete: false, aggregatesComplete: false, countsScope: 'preparedSubset', progress: {...progress},
      preparedScanComplete: true, unavailablePreparedFiles: 0, unavailableFilterRows: 0, view: {type: 'table'},
      rows: [], groups: [], groupOptions: [], properties: [], availableProperties: [],
      counts: {scanned: 1, matched: 0, afterGroupOrder: 0, afterSearch: 0, returned: 0},
      diagnostics: [], stepsUsed: 1, relationshipsAvailable: false, metadataIssues: [], metadataComplete: false, refreshHint: null,
    },
  };
}
const encoded = (value: unknown, op = 'preview_base') => new TextEncoder().encode(JSON.stringify({schemaVersion: 1, op, value}));
const raw = (value: unknown) => ({previewBytes: encoded(value)});
const marked = (value: unknown) => ({documents: true, schemaVersion: 1, ok: true, value});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; }
function maintenance() {
  return createDesktopDocumentRuntime({
    scope: {localStoreId: 'store', clientId: 'client'}, subscribe: () => () => {},
    invoke: async method => ({documentRuntime: true, schemaVersion: 1, ok: true, value: method === 'documentRuntimeObserve' ? {version: 1, scope: {localStoreId: 'store', clientId: 'client'}, update: null, outcomes: []} : true}),
  });
}
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;

test('desktop preview capability is positive only with maintenance and does not eagerly open a capture', async () => {
  const calls: DesktopDocumentRequest[] = [];
  for (const basePreviewAvailable of [undefined, false]) {
    const binding = createDesktopDocumentService(async input => {calls.push(input); throw Error('No eager or legacy preview access');}, undefined, {basePreviewAvailable});
    assert.equal(binding.service.basePreviewAvailable === true, false);
    assert.equal(binding.service.openPreview, undefined);
    await binding.release();
  }
  assert.throws(() => createDesktopDocumentService(async () => null, undefined, {basePreviewAvailable: true}), {code: 'unsupported_host_capability'});
  const runtime = maintenance();
  const binding = createDesktopDocumentService(async input => {calls.push(input); throw Error('No eager preview access');}, runtime.transport, {basePreviewAvailable: true});
  assert.equal(binding.service.basePreviewAvailable, true);
  assert.equal(typeof binding.service.openPreview, 'function');
  assert.equal(calls.length, 0);
  await binding.release(); runtime.retire();
});

test('desktop preview forwarding uses the real request codec and approved common raw decoder', async () => {
  const runtime = maintenance(), calls: DesktopDocumentRequest[] = [];
  let ipc = false;
  const binding = createDesktopDocumentService(async input => {
    const captured = captureDocumentRequest(structuredClone(input)); calls.push(captured);
    const command = captured.command;
    const value = command.op === 'preview_open' ? opened(command.previewId) : command.op === 'preview_close' ? {closed: true} : raw(result(command.previewId));
    return ipc ? marked(value) : value;
  }, runtime.transport, {basePreviewAvailable: true});
  const preview = (await binding.service.openPreview!())!;
  assert.equal(preview.previewId, '1');
  assert.equal(Object.hasOwn(preview, 'snapshot'), false);
  const input = {id: 'base', viewName: null, options: {searchTerms: ['before'], clockMs: 0, maxRows: 3, maxSteps: undefined, currentEntryId: undefined}};
  const pending = preview.base(input); input.options.searchTerms[0] = 'changed';
  const read = await pending;
  assert.equal(read.result.countsScope, 'preparedSubset');
  assert.equal(read.result.complete, false);
  assert.equal(Object.isFrozen(read.result.progress), true);
  assert.deepEqual(calls.find(call => call.command.op === 'preview_base')!.command.options, {searchTerms: ['before'], clockMs: 0, maxRows: 3});
  ipc = true;
  assert.equal((await preview.base({id: 'base', options: {clockMs: 0}})).definition.id, 'base');
  await preview.close(); await binding.release(); runtime.retire();
  assert.deepEqual(calls.map(call => call.command.op), ['preview_open', 'preview_base', 'preview_base', 'preview_close']);
});

test('renderer preview validation fails closed on foreign capture source progress and malformed raw envelopes', async () => {
  const runtime = maintenance(); let reply: unknown = raw(result());
  const binding = createDesktopDocumentService(async input => input.command.op === 'preview_open' ? opened(input.command.previewId) : input.command.op === 'preview_close' ? {closed: true} : reply, runtime.transport, {basePreviewAvailable: true});
  const preview = (await binding.service.openPreview!())!;
  const invalid = [
    {...result(), capture: {...capture, serial: '2'}},
    {...result(), capture: {...capture, ownerNonce: 'foreign'}},
    {...result(), source: {...source, watermark: '3'}},
    {...result(), source: {...source, localStoreId: 'foreign'}},
    {...result(), previewId: '2'},
    {...result(), definition: {...result().definition, id: 'other-base'}},
    {...result(), result: {...result().result, complete: true}},
    {...result(), result: {...result().result, progress: {...progress, preparedFiles: 2, pendingFiles: 1}}},
  ];
  for (const value of invalid) {
    reply = raw(value);
    await assert.rejects(preview.base({id: 'base', options: {clockMs: 0}}), error => code(error) === 'invalid_document_response');
  }
  const proper = encoded(result());
  for (const previewBytes of [new Uint8Array([255]), encoded(result(), 'base'), proper.subarray(1), new Uint8Array(16 * 1024 * 1024 + 1)]) {
    reply = {previewBytes};
    await assert.rejects(preview.base({id: 'base', options: {clockMs: 0}}), error => code(error) === 'invalid_document_response');
  }
  reply = raw(result());
  assert.equal((await preview.base({id: 'base', options: {clockMs: 0}})).result.status, 'indexing');
  await binding.release(); runtime.retire();
});

test('release drains an admitted preview open then closes previews before pins and stages', async () => {
  const runtime = maintenance(), gate = deferred<unknown>(), entered = deferred<void>(), operations: string[] = [];
  const binding = createDesktopDocumentService(async input => {
    const c = input.command; operations.push(c.op + ('previewId' in c ? ':' + c.previewId : 'pinId' in c ? ':' + c.pinId : ''));
    if (c.op === 'open') return pin(c.pinId);
    if (c.op === 'begin') return {snapshot};
    if (c.op === 'preview_open') {entered.resolve(); return gate.promise;}
    if (c.op === 'preview_close') return {closed: true};
    if (c.op === 'close' || c.op === 'discard') return true;
    throw Error('Unexpected operation');
  }, runtime.transport, {basePreviewAvailable: true});
  await binding.service.open(); await binding.service.begin();
  const opening = binding.service.openPreview!(); await entered.promise;
  const releasing = binding.release();
  await assert.rejects(binding.service.openPreview!(), error => code(error) === 'client_not_admitted');
  assert.equal(operations.some(op => op.startsWith('preview_close')), false);
  gate.resolve(opened('1'));
  const outcome = await Promise.allSettled([opening, releasing]);
  assert.equal(outcome[1].status, 'fulfilled');
  assert.deepEqual(operations, ['open:1', 'begin', 'preview_open:1', 'preview_close:1', 'close:1', 'discard']);
  if (outcome[0].status === 'fulfilled' && outcome[0].value) await assert.rejects(outcome[0].value.base({id: 'base'}), error => code(error) === 'client_not_admitted');
  await binding.release(); runtime.retire();
});

test('release retries the exact uncertain preview close before disposing pins or stages', async () => {
  const runtime = maintenance(), operations: string[] = []; let fail = true;
  const binding = createDesktopDocumentService(async input => {
    const c = input.command; operations.push(c.op + ('previewId' in c ? ':' + c.previewId : 'pinId' in c ? ':' + c.pinId : ''));
    if (c.op === 'preview_open') return opened(c.previewId);
    if (c.op === 'open') return pin(c.pinId);
    if (c.op === 'begin') return {snapshot};
    if (c.op === 'preview_close') {if (fail) {fail = false; throw {code: 'transport_error'};} return {closed: true};}
    if (c.op === 'close' || c.op === 'discard') return true;
    throw Error('Unexpected operation');
  }, runtime.transport, {basePreviewAvailable: true});
  await binding.service.openPreview!(); await binding.service.open(); await binding.service.begin();
  await assert.rejects(binding.release(), {code: 'transport_error'});
  assert.deepEqual(operations, ['preview_open:1', 'open:1', 'begin', 'preview_close:1']);
  await binding.release(); await binding.release(); runtime.retire();
  assert.deepEqual(operations, ['preview_open:1', 'open:1', 'begin', 'preview_close:1', 'preview_close:1', 'close:1', 'discard']);
});

test('closing a preview drains a held Base read and rejects its late result before backend close', async () => {
  const runtime = maintenance(), gate = deferred<unknown>(), entered = deferred<void>(), operations: string[] = [];
  const binding = createDesktopDocumentService(async input => {
    const c = input.command; operations.push(c.op);
    if (c.op === 'preview_open') return opened(c.previewId);
    if (c.op === 'preview_base') {entered.resolve(); return gate.promise;}
    if (c.op === 'preview_close') return {closed: true};
    throw Error('Unexpected operation');
  }, runtime.transport, {basePreviewAvailable: true});
  const preview = (await binding.service.openPreview!())!;
  const pending = preview.base({id: 'base', options: {clockMs: 0}}); await entered.promise;
  const closing = preview.close();
  await assert.rejects(preview.base({id: 'base'}), {code: 'document_preview_closed'});
  assert.equal(operations.includes('preview_close'), false);
  gate.resolve(raw(result()));
  await assert.rejects(pending, {code: 'document_preview_closed'});
  await closing; await preview.close(); await binding.release(); runtime.retire();
  assert.deepEqual(operations, ['preview_open', 'preview_base', 'preview_close']);
});

test('release fences held preview Base success and failure before cleanup relinquishes capture ownership', async () => {
  for (const success of [false, true]) {
    const runtime = maintenance(), gate = deferred<unknown>(), entered = deferred<void>(), operations: string[] = [];
    const binding = createDesktopDocumentService(async input => {
      const c = input.command; operations.push(c.op);
      if (c.op === 'preview_open') return opened(c.previewId);
      if (c.op === 'preview_base') {entered.resolve(); return gate.promise;}
      if (c.op === 'preview_close') return {closed: true};
      throw Error('Unexpected operation');
    }, runtime.transport, {basePreviewAvailable: true});
    const preview = (await binding.service.openPreview!())!;
    const pending = preview.base({id: 'base', options: {clockMs: 0}}); await entered.promise;
    const releasing = binding.release();
    assert.equal(operations.includes('preview_close'), false);
    if (success) gate.resolve(raw(result())); else gate.reject({code: 'index_preview_expired'});
    await assert.rejects(pending, error => code(error) === 'client_not_admitted');
    await releasing;
    assert.deepEqual(operations, ['preview_open', 'preview_base', 'preview_close']);
    runtime.retire();
  }
});

test('invalid preview open capture is never exposed and its allocated ID remains owned for cleanup', async () => {
  const runtime = maintenance(), operations: string[] = [];
  const binding = createDesktopDocumentService(async input => {
    const c = input.command; operations.push(c.op + ':' + c.previewId);
    if (c.op === 'preview_open') return {...opened(c.previewId), capture: {...capture, serial: '0'}};
    if (c.op === 'preview_close') return {closed: true};
    throw Error('Unexpected operation');
  }, runtime.transport, {basePreviewAvailable: true});
  await assert.rejects(binding.service.openPreview!(), error => code(error) === 'invalid_document_response');
  await binding.release(); runtime.retire();
  assert.deepEqual(operations, ['preview_open:1', 'preview_close:1']);
});

test('uncertain accepted preview open remains owned and release retries its exact close before pins or stages', async () => {
  const runtime = maintenance(), operations: string[] = []; let failClose = true;
  const binding = createDesktopDocumentService(async input => {
    const c = input.command; operations.push(c.op + ('previewId' in c ? ':' + c.previewId : 'pinId' in c ? ':' + c.pinId : ''));
    if (c.op === 'preview_open') throw {code: 'transport_error', commitUncertain: true}; // Backend already accepted ID 1.
    if (c.op === 'open') return pin(c.pinId);
    if (c.op === 'begin') return {snapshot};
    if (c.op === 'preview_close') {if (failClose) {failClose = false; throw {code: 'transport_error', commitUncertain: true};} return {closed: true};}
    if (c.op === 'close' || c.op === 'discard') return true;
    throw Error('Unexpected operation');
  }, runtime.transport, {basePreviewAvailable: true});
  await assert.rejects(binding.service.openPreview!(), {code: 'transport_error', commitUncertain: true});
  await binding.service.open(); await binding.service.begin();
  await assert.rejects(binding.release(), {code: 'transport_error', commitUncertain: true});
  assert.deepEqual(operations, ['preview_open:1', 'open:1', 'begin', 'preview_close:1']);
  await assert.rejects(binding.service.openPreview!(), error => code(error) === 'client_not_admitted');
  await binding.release(); await binding.release(); runtime.retire();
  assert.deepEqual(operations, ['preview_open:1', 'open:1', 'begin', 'preview_close:1', 'preview_close:1', 'close:1', 'discard']);
});
