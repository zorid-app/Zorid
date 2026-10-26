import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseName, noteName, notePath, marker, source, savedNote, editorFrame, reloadFrame, searchFrame, readOnlyDatabaseSnapshot, harnessInputs, trackedHarnessInputs, trackOwnedStartup, finalEvidence, phaseNames, classifyRuntimeErrors, awaitRuntimeHealth, waitForObservation } from './oracles.mjs';

const entry = { id: 'ui-created-entry', revision: 'saved-revision', path: notePath, kind: 'file', deleted: false };
const snapshot = () => ({ database: databaseName, version: 6, entries: [{ ...entry }], contents: [{ id: entry.id, bytes: [...new TextEncoder().encode(source)] }] });
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

test('the observer never opens an absent or wrong-version database', async () => {
  const old = globalThis.indexedDB;
  try {
    for (const databases of [[], [{ name: databaseName, version: 7 }]]) {
      let opens = 0; globalThis.indexedDB = { databases: async () => databases, open() { opens++; throw Error('Must not open'); } };
      await assert.rejects(readOnlyDatabaseSnapshot(databaseName), /Expected existing version6/); assert.equal(opens, 0);
    }
  } finally { if (old === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = old; }
});

test('the observer aborts unexpected upgrade instead of allowing creation', async () => {
  const old = globalThis.indexedDB; let aborted = 0;
  try {
    globalThis.indexedDB = { databases: async () => [{ name: databaseName, version: 6 }], open(name, version) {
      assert.equal(name, databaseName); assert.equal(version, 6);
      const request = { transaction: { abort() { aborted++; } } }; queueMicrotask(() => request.onupgradeneeded()); return request;
    } };
    await assert.rejects(readOnlyDatabaseSnapshot(databaseName), /refused database creation/); assert.equal(aborted, 1);
  } finally { if (old === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = old; }
});

test('the observer uses one readonly metadata/content transaction and closes the connection', async () => {
  const old = globalThis.indexedDB, calls = []; let closed = 0;
  try {
    const database = { version: 6, objectStoreNames: { contains: name => ['metadata', 'content'].includes(name) }, close() { closed++; }, transaction(names, mode) {
      calls.push([names, mode]);
      const tx = { objectStore(name) { return { keyPath: 'id', getAll() { return { result: name === 'metadata' ? [{ ...entry }] : [{ id: entry.id, bytes: new TextEncoder().encode(source) }] }; } }; } };
      queueMicrotask(() => tx.oncomplete()); return tx;
    } };
    globalThis.indexedDB = { databases: async () => [{ name: databaseName, version: 6 }], open() { const request = { result: database }; queueMicrotask(() => request.onsuccess()); return request; } };
    assert.deepEqual(savedNote(await readOnlyDatabaseSnapshot(databaseName), notePath, source), entry);
    assert.deepEqual(calls, [[['metadata', 'content'], 'readonly']]); assert.equal(closed, 1);
  } finally { if (old === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = old; }
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
