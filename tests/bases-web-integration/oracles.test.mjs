import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { databaseName, noteName, notePath, marker, source, savedNote, editorFrame, reloadFrame, searchFrame, readOnlyDatabaseSnapshot, harnessInputs, trackedHarnessInputs, trackOwnedStartup, finalEvidence, phaseNames, classifyRuntimeErrors, awaitRuntimeHealth, waitForObservation, streamingStorageSchema, storageObservationSnapshot } from './oracles.mjs';

const entry = { id: 'ui-created-entry', revision: 'saved-revision', path: notePath, kind: 'file', deleted: false };
const snapshot = () => ({ database: databaseName, version: 8, entries: [{ ...entry }], contents: [{ id: entry.id, bytes: [...new TextEncoder().encode(source)] }] });
const editor = () => ({ workspace: true, desktopBridge: false, fixtureMarker: false, title: noteName, editors: 1, connected: true, editable: true, text: source, saveState: '', focusedEditor: true });
const search = () => ({ query: marker, total: '1 match in 1 file', status: '', groups: [{ entryId: entry.id, path: notePath, title: noteName, badge: '1', snippets: [{ text: marker, marks: [marker] }] }] });

test('the handwritten complete source is exactly51 UTF8 bytes including final newline', () => {
  assert.equal(Buffer.byteLength(source), 51); assert.equal(source, 'Ordinary browser note.\nZoridFunctionalUiMarker7c42\n');
  assert.deepEqual(savedNote(snapshot(), notePath, source), entry);
});
test('durability oracle rejects lost newline, wrong content identity, extra entry, wrong path and schema', () => {
  for (const change of [s => s.contents[0].bytes.pop(), s => { s.contents[0].id = 'other'; }, s => s.entries.push({ ...entry, id: 'extra' }), s => { s.entries[0].path = 'Other.md'; }, s => { s.version = 7; }]) {
    const s = snapshot(); change(s); assert.throws(() => savedNote(s, notePath, source));
  }
  assert.throws(() => savedNote(snapshot(), notePath, source, { id: 'replaced-entry' }));
});
test('normal title transfer must focus the actual editable editor before input', () => {
  editorFrame(editor(), noteName, source, true);
  for (const change of [f => { f.focusedEditor = false; }, f => { f.desktopBridge = true; }, f => { f.fixtureMarker = true; }, f => { f.editors = 2; }, f => { f.saveState = 'Saving…'; }]) {
    const f = editor(); change(f); assert.throws(() => editorFrame(f, noteName, source, true));
  }
});
test('the actual runner frame expression parses and reads multiline public DOM without losing the final newline', () => {
  const runner = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  const authoredFrame = runner.slice(runner.indexOf('async function frame('), runner.indexOf('async function phase('));
  const templates = [...authoredFrame.matchAll(/await dom\(((?:String\.raw)?`[\s\S]*?`)\);/g)];
  assert.equal(templates.length, 1, 'Compile the actual authored frame body, not a test copy');
  const body = new vm.Script(templates[0][1]).runInNewContext();
  const expression = new vm.Script(`(()=>{${body}})()`);
  const node = (visible = true) => ({ isConnected: true, getClientRects: () => visible ? [{}] : [], getAttribute: name => name === 'contenteditable' ? 'true' : null, querySelectorAll: selector => { assert.equal(selector, '.cm-line'); return source.split('\n').map(textContent => ({ textContent })); } });
  for (const count of [0, 1, 2]) {
    const editors = Array.from({ length: count }, () => node()), hidden = node(false);
    const document = { activeElement: editors[0], querySelectorAll: selector => { assert.equal(selector, '.pane.is-active .cm-content[contenteditable="true"]'); return [...editors, hidden]; }, querySelector: selector => {
      if (selector === '.workspace') return {};
      if (selector === 'meta[name="zorid-core-fixture-build"]') return null;
      if (selector === '.pane.is-active .note-title') return { value: noteName };
      if (selector === '.save-state') return { textContent: '' };
      assert.fail('Unexpected public DOM selector ' + selector);
    } };
    const frame = JSON.parse(JSON.stringify(expression.runInNewContext({ document, window: {}, performance: { timeOrigin: 123 } })));
    assert.equal(frame.editors, count); assert.equal(frame.timeOrigin, 123);
    if (count === 1) { assert.equal(frame.text, source); editorFrame(frame, noteName, source, true); }
    else assert.throws(() => editorFrame(frame, noteName, source, true));
  }
});
test('reload requires a new document and the identical entry/revision', () => {
  reloadFrame(100, 200, entry, { ...entry });
  assert.throws(() => reloadFrame(100, 100, entry, { ...entry }));
  assert.throws(() => reloadFrame(100, 200, entry, { ...entry, revision: 'other' }));
});
test('rich search requires exact count, file identity, raw marker highlight and complete ready presentation', () => {
  searchFrame(search(), entry);
  for (const change of [f => { f.total = '1+ matches in 1 file'; }, f => { f.status = 'Results are from an earlier snapshot.'; }, f => { f.groups[0].entryId = 'other'; }, f => { f.groups[0].snippets[0].marks = []; }, f => f.groups.push(f.groups[0])]) {
    const f = search(); change(f); assert.throws(() => searchFrame(f, entry));
  }
});

const schema = () => ({ database: databaseName, version: 8, stores: structuredClone(streamingStorageSchema.stores) });
async function withStorage(options, run) {
  const old = globalThis.indexedDB, actualSchema = options.schema ?? schema();
  const data = { entries: options.entries ?? [{ ...entry }], contents: options.contents ?? [{ id: entry.id, bytes: new TextEncoder().encode(source) }] };
  const receipt = { opens: [], transactions: [], reads: [], closes: 0, aborts: 0, upgradesAborted: 0 };
  const database = { version: actualSchema.version, objectStoreNames: actualSchema.stores.map(row => row.name), close() { receipt.closes++; }, transaction(names, mode) {
    assert.equal(mode, 'readonly'); receipt.transactions.push([names, mode]);
    const captured = structuredClone(data); let aborted = false;
    const tx = { abort() { aborted = true; receipt.aborts++; queueMicrotask(() => tx.onabort?.()); }, objectStore(name) {
      const descriptor = actualSchema.stores.find(row => row.name === name); assert.ok(descriptor);
      return { keyPath: descriptor.keyPath, autoIncrement: descriptor.autoIncrement, indexNames: descriptor.indexes.map(row => row.name), index(name) { return descriptor.indexes.find(row => row.name === name); }, getAll() {
        assert.ok(name === 'metadata' || name === 'content', 'Observer may inspect other schema metadata, never other store contents'); receipt.reads.push(name);
        if (name === 'metadata') options.onMetadataRead?.(data);
        return { result: captured[name === 'metadata' ? 'entries' : 'contents'] };
      } };
    } };
    queueMicrotask(() => { if (!aborted) tx.oncomplete?.(); }); return tx;
  } };
  try {
    globalThis.indexedDB = { databases: async () => options.inventory ?? [{ name: databaseName, version: actualSchema.version }], open(...args) {
      receipt.opens.push(args); assert.deepEqual(args, [databaseName], 'Existing open must not request any version upgrade');
      const request = { result: database, transaction: { abort() { receipt.upgradesAborted++; } } };
      queueMicrotask(() => options.upgrade ? request.onupgradeneeded() : request.onsuccess()); return request;
    } };
    await run(receipt, data);
  } finally { if (old === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = old; }
}
const observe = () => readOnlyDatabaseSnapshot(databaseName, streamingStorageSchema);

test('normal streaming contract pins exactly31 stores and explicit version8 read-layout markers', () => {
  assert.equal(streamingStorageSchema.version, 8); assert.equal(streamingStorageSchema.stores.length, 31);
  assert.deepEqual(streamingStorageSchema.stores.find(row => row.name === 'metadata'), { name: 'metadata', keyPath: 'id', autoIncrement: false, indexes: [{ name: 'by_path', keyPath: 'path', unique: false, multiEntry: false }] });
  assert.deepEqual(streamingStorageSchema.stores.find(row => row.name === 'sync_source_payloads').keyPath, ['realmId', 'vaultId', 'updateId']);
});
test('an absent database is captured and never opened or created', async () => {
  await withStorage({ inventory: [] }, async receipt => { const probe = await observe(); assert.equal(probe.kind, 'fatal'); assert.deepEqual(probe.inventory, []); assert.equal(probe.schema, null); assert.throws(() => storageObservationSnapshot(probe), /already-existing/); assert.deepEqual(receipt.opens, []); });
});
test('the observer aborts an unexpected upgrade instead of allowing a raced database creation', async () => {
  await withStorage({ upgrade: true }, async receipt => { const probe = await observe(); assert.equal(probe.kind, 'fatal'); assert.equal(probe.code, 'unexpected_storage_upgrade'); assert.equal(receipt.upgradesAborted, 1); assert.deepEqual(receipt.transactions, []); });
});
test('legacy6 and unknown future schemas are observed before strict fatal rejection with no data reads', async () => {
  for (const version of [6, 9]) {
    const actual = schema(); actual.version = version;
    await withStorage({ schema: actual }, async receipt => { const probe = await observe(); assert.equal(probe.kind, 'fatal'); assert.equal(probe.code, 'unsupported_streaming_schema'); assert.deepEqual(probe.inventory, [{ name: databaseName, version }]); assert.deepEqual(probe.schema, actual); assert.equal(receipt.transactions.length, 1); assert.deepEqual(receipt.reads, []); assert.equal(receipt.closes, 1); assert.throws(() => storageObservationSnapshot(probe), /streaming version8/); });
  }
});
test('version8 wrong store/key/index/autoIncrement layouts remain fatal and captured', async () => {
  for (const change of [s => { s.stores.find(row => row.name === 'metadata').keyPath = 'path'; }, s => { s.stores.find(row => row.name === 'metadata').indexes[0].unique = true; }, s => { s.stores.find(row => row.name === 'content').autoIncrement = true; }, s => { s.stores = s.stores.filter(row => row.name !== 'sync_publication_refs'); }]) {
    const actual = schema(); change(actual);
    await withStorage({ schema: actual }, async receipt => { const probe = await observe(); assert.equal(probe.kind, 'fatal'); assert.deepEqual(probe.schema, actual); assert.deepEqual(receipt.reads, []); assert.equal(receipt.closes, 1); });
  }
});
test('one consistent readonly transaction reads actual inline bytes and retains metadata/content revision agreement', async () => {
  await withStorage({ onMetadataRead(data) { data.entries[0].revision = 'concurrent-next'; data.contents[0].bytes = new TextEncoder().encode('Concurrent bytes.\n'); } }, async (receipt, data) => {
    const probe = await observe(); assert.equal(probe.kind, 'ready'); assert.deepEqual(probe.schema, schema());
    assert.deepEqual(savedNote(storageObservationSnapshot(probe), notePath, source), entry);
    assert.equal(data.entries[0].revision, 'concurrent-next'); assert.deepEqual(receipt.transactions, [[streamingStorageSchema.stores.map(row => row.name), 'readonly']]); assert.deepEqual(receipt.reads, ['metadata', 'content']); assert.equal(receipt.closes, 1);
  });
});
test('only the known-schema empty projection is retryable; encoded/chunked/missing inline bodies have no fallback', async () => {
  await withStorage({ entries: [], contents: [] }, async () => { const probe = await observe(); assert.equal(probe.kind, 'not-ready'); assert.equal(probe.code, 'entry_not_committed'); assert.throws(() => storageObservationSnapshot(probe), /not committed/); });
  for (const contents of [[], [{ id: entry.id, bytes: 'encoded payload' }], [{ id: entry.id, bytes: new ArrayBuffer(8) }]]) {
    await withStorage({ contents }, async receipt => { const probe = await observe(); assert.equal(probe.kind, 'fatal'); assert.equal(probe.code, 'unsupported_inline_projection'); assert.equal(receipt.closes, 1); assert.throws(() => storageObservationSnapshot(probe)); });
  }
});
test('a stable wrong schema exits after one observation with no readiness sleep', async () => {
  const actual = schema(); actual.version = 6;
  await withStorage({ schema: actual }, async () => {
    let calls = 0, pauses = 0;
    await assert.rejects(waitForObservation(async () => { calls++; return storageObservationSnapshot(await observe()); }, { now: () => 0, deadline: 120000, assertHealthy: async () => {}, pause: async () => { pauses++; }, label: 'Normal storage' }), /streaming version8/);
    assert.equal(calls, 1); assert.equal(pauses, 0);
  });
});
test('an unknown schema cannot masquerade as a retryable empty projection', async () => {
  const actual = schema(); actual.version = 9;
  const probe = { kind: 'not-ready', code: 'entry_not_committed', schema: actual, inventory: [{ name: databaseName, version: 9 }], snapshot: { database: databaseName, version: 9, entries: [], contents: [] } };
  let calls = 0, pauses = 0;
  await assert.rejects(waitForObservation(async () => { calls++; return storageObservationSnapshot(probe); }, { now: () => 0, deadline: 120000, assertHealthy: async () => {}, pause: async () => { pauses++; }, label: 'Normal storage' }), /Unexpected normal streaming storage schema/);
  assert.equal(calls, 1); assert.equal(pauses, 0);
});

const final = () => ({ workflowCompleted: true, phases: phaseNames.map(name => ({ name, status: 'passed' })), exceptions: [], errorEvents: [], networkReceipts: [], ambientNetworkErrors: [], pendingNetworkErrors: [], eventOverflow: 0, provenanceVerified: true, finalProvenanceVerified: true, normalClose: { requested: true }, cleanup: { failures: [], chrome: { exitCode: 0, signalCode: null, signals: [] }, vite: { closeResolved: true } }, startupCleanupTimedOut: false, startupResources: [{ creationSettled: true, expired: false, cleanupStatus: 'not_required' }] });
test('an error arriving after the five phases and initial proof still fails final acceptance', () => {
  const evidence = final(); finalEvidence(evidence);
  evidence.exceptions.push({ method: 'Runtime.exceptionThrown', params: { message: 'late actual failure' } });
  assert.throws(() => finalEvidence(evidence), /Late renderer errors/);
  for (const change of [f => { f.phases[4].status = 'unexecuted'; }, f => { f.finalProvenanceVerified = false; }, f => f.cleanup.chrome.signals.push('SIGTERM'), f => { f.startupResources[0].creationSettled = false; }, f => { f.startupCleanupTimedOut = true; }]) {
    const value = final(); change(value); assert.throws(() => finalEvidence(value));
  }
});
test('all four executing harness files and shared helpers must belong to the tracked frozen closure', () => {
  const tracked = [...harnessInputs, 'tests/tasks-electron-integration/cdp.mjs', 'tests/bases-electron-integration/ui.mjs', 'tests/browser-workblocks-worker/cleanup.mjs'];
  trackedHarnessInputs(tracked);
  for (const omitted of tracked) assert.throws(() => trackedHarnessInputs(tracked.filter(name => name !== omitted)), /must be tracked/);
});
test('late owned Vite creation waits for its actual close and retains a close failure', async () => {
  let created, finishClose;
  const resource = { fixture: 'owned server' }, work = new Promise(resolve => { created = resolve; });
  const closed = new Promise(resolve => { finishClose = resolve; });
  let selected;
  const owned = trackOwnedStartup(work, 'Vite createServer', async value => { selected = value; await closed; });
  owned.state.expired = true; created(resource); await Promise.resolve();
  assert.equal(selected, resource); assert.equal(owned.state.cleanupStatus, 'running');
  finishClose(); await owned.settled; assert.equal(owned.state.cleanupStatus, 'closed');
  const rejected = trackOwnedStartup(Promise.resolve(resource), 'Vite listen', async () => { throw Error('owned close failed'); });
  rejected.state.expired = true; await rejected.settled;
  assert.equal(rejected.state.cleanupStatus, 'failed'); assert.match(rejected.state.cleanupError, /owned close failed/);
  const evidence = final(); evidence.startupResources = [rejected.state]; assert.throws(() => finalEvidence(evidence), /Late owned resource cleanup failed/);
});

// The exact lone network error from failed actual web002. That run had no
// Network request/response receipts, so it remains unclassified and failed.
const origin = 'http://127.0.0.1:60741';
const faviconError = () => ({ method: 'Log.entryAdded', params: { entry: { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', timestamp: 1793044989745.856, url: origin + '/favicon.ico', networkRequestId: '52753.243' } } });
const faviconReceipt = () => ({ requestId: '52753.243', requestCount: 1, responseCount: 1, request: { method: 'GET', url: origin + '/favicon.ico', type: 'Other', initiatorType: 'other', initiatorHasStack: false, redirected: false }, response: { url: origin + '/favicon.ico', status: 404, type: 'Other' } });
const classify = (events, network, options = {}) => classifyRuntimeErrors(events, network, origin, options);
test('recorded web002 favicon text alone stays fatal; only complete matching automatic GET404 receipts classify as ambient', () => {
  const event = faviconError(); assert.deepEqual(classify([event], [], { final: true }).exceptions, [event]);
  const receipt = faviconReceipt(), state = classify([event], [receipt], { final: true });
  assert.deepEqual(state.exceptions, []); assert.deepEqual(state.pendingNetworkErrors, []);
  assert.deepEqual(state.ambientNetworkErrors, [{ reason: 'automatic-optional-favicon-404', event, receipt }]);
  assert.deepEqual(classify([event], [receipt, faviconReceipt()], { final: true }).exceptions, [event], 'Duplicate correlation sidecars cannot choose a preferred witness');
});
test('favicon classification rejects JS/console errors, other assets/origins/queries, scripts, redirects and mismatched status/request witnesses', () => {
  for (const change of [
    (e, r) => { e.method = 'Runtime.exceptionThrown'; }, (e, r) => { e.method = 'Runtime.consoleAPICalled'; },
    (e, r) => { e.params.entry.source = 'javascript'; }, (e, r) => { e.params.entry.url = origin + '/src/main.ts'; },
    (e, r) => { e.params.entry.url = origin + '/favicon.ico?version=1'; }, (e, r) => { e.params.entry.url = 'https://other.example/favicon.ico'; },
    (e, r) => { r.request.method = 'POST'; }, (e, r) => { r.request.type = 'Fetch'; }, (e, r) => { r.request.initiatorType = 'script'; },
    (e, r) => { r.request.initiatorHasStack = true; }, (e, r) => { r.request.redirected = true; },
    (e, r) => { r.request.url += '?different'; }, (e, r) => { r.response.url += '?different'; },
    (e, r) => { r.response.status = 500; }, (e, r) => { r.response.status = '404'; },
    (e, r) => { r.requestId = 'another-request'; }, (e, r) => { r.requestCount = 2; }, (e, r) => { r.responseCount = 2; },
    (e, r) => { delete r.request; }, (e, r) => { delete r.response; },
  ]) {
    const event = faviconError(), receipt = faviconReceipt(); change(event, receipt);
    const result = classify([event], [receipt], { final: true }); assert.deepEqual(result.exceptions, [event]); assert.deepEqual(result.ambientNetworkErrors, []);
  }
});
test('Log-before-Network ordering blocks positive work until exact correlated receipts arrive', async () => {
  const event = faviconError(), network = []; let now = 100, waits = 0, positiveWork = 0;
  const read = () => ({ ...classify([event], network, { observedAt: [100], now }), eventOverflow: 0 });
  assert.equal(read().pendingNetworkErrors.length, 1); assert.deepEqual(read().exceptions, []);
  await awaitRuntimeHealth(read, async expiresAt => {
    assert.equal(expiresAt, 1100); assert.equal(positiveWork, 0); waits++; now += 100;
    if (waits === 1) { const receipt = faviconReceipt(); delete receipt.response; receipt.responseCount = 0; network.push(receipt); }
    else { network[0].response = faviconReceipt().response; network[0].responseCount = 1; }
  });
  positiveWork++; assert.equal(waits, 2); assert.equal(positiveWork, 1); assert.equal(read().ambientNetworkErrors.length, 1);
});
test('missing correlation expires after the bounded receipt barrier and is fatal at final proof', async () => {
  const event = faviconError(); let now = 100, waits = 0;
  await assert.rejects(awaitRuntimeHealth(() => ({ ...classify([event], [], { observedAt: [100], now }), eventOverflow: 0 }), async expiresAt => { waits++; now = expiresAt; }), /Fatal renderer or unclassified network error/);
  assert.equal(waits, 1); assert.deepEqual(classify([event], [], { observedAt: [100], now: 100, final: true }).exceptions, [event]);
});
test('a fatal JS event during a pending favicon barrier stops without waiting for a receipt or permitting positive work', async () => {
  const events = [faviconError()]; let wakes = 0;
  await assert.rejects(awaitRuntimeHealth(() => ({ ...classify(events, [], { observedAt: [100, 100], now: 100 }), eventOverflow: 0 }), async () => {
    wakes++; events.push({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'actual fatal JS error' } } });
  }), /Fatal renderer or unclassified network error/);
  assert.equal(wakes, 1);
});
test('fatal observation errors stop before another readiness check or sleep', async () => {
  for (const point of ['before', 'during-failed-check', 'after-successful-check']) {
    let fatal = point === 'before', calls = 0, pauses = 0;
    await assert.rejects(waitForObservation(async () => { calls++; fatal = true; if (point === 'during-failed-check') throw Error('not mounted yet'); return true; }, { now: () => 0, deadline: 120000, assertHealthy: async () => { if (fatal) throw Error('known actual JS failure'); }, pause: async () => { pauses++; }, label: 'Normal Workspace' }), /known actual JS failure/);
    assert.equal(calls, point === 'before' ? 0 : 1); assert.equal(pauses, 0);
  }
});
test('ordinary readiness retains the existing100ms polling and whole-run budget', async () => {
  let now = 0, calls = 0; const pauses = [];
  await assert.rejects(waitForObservation(async () => { calls++; throw Error('not mounted yet'); }, { now: () => now, deadline: 150, assertHealthy: async () => {}, pause: async ms => { pauses.push(ms); now += ms; }, label: 'Normal Workspace' }), /Normal Workspace: not mounted yet/);
  assert.equal(calls, 2); assert.deepEqual(pauses, [100, 100]);
});
test('final acceptance independently recomputes raw errors and requires retained ambient correlation', () => {
  const value = final(), event = faviconError(), receipt = faviconReceipt(); value.origin = origin; value.errorEvents = [event]; value.networkReceipts = [receipt]; value.ambientNetworkErrors = classify([event], [receipt], { final: true }).ambientNetworkErrors;
  finalEvidence(value); value.ambientNetworkErrors = []; assert.throws(() => finalEvidence(value), /Ambient error evidence/);
  const hidden = final(); hidden.origin = origin; hidden.errorEvents = [event]; assert.throws(() => finalEvidence(hidden), /Unclassified final runtime error/);
});
