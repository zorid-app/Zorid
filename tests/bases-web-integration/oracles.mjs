import assert from 'node:assert/strict';

export const databaseName = 'zorid-core-vault:default-v1';
export const noteName = 'Functional browser note';
export const notePath = noteName + '.md';
export const marker = 'ZoridFunctionalUiMarker7c42';
export const source = 'Ordinary browser note.\n' + marker + '\n';
export const phaseNames = Object.freeze(['create-and-rename', 'keyboard-edit-and-durable-save', 'normal-reload', 'rich-search', 'open-search-result']);
export const harnessInputs = Object.freeze(['run.mjs', 'oracles.mjs', 'oracles.test.mjs', 'README.md'].map(name => 'tests/bases-web-integration/' + name));
export const faviconReceiptWaitMs = 1000;

/** No text-only error exemption. The sole ambient case is the browser's
 * automatic optional favicon GET with a matching observed HTTP404 response. */
export function classifyRuntimeErrors(events, network, origin, { observedAt = [], now = 0, final = false } = {}) {
  const exceptions = [], ambientNetworkErrors = [], pendingNetworkErrors = [];
  let favicon;
  try { const url = new URL(origin); if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === origin) favicon = origin + '/favicon.ico'; } catch { /* Unknown origin never grants an exception. */ }
  const records = new Map();
  for (const row of network) records.set(row.requestId, records.has(row.requestId) ? null : row);
  for (let index = 0; index < events.length; index++) {
    const event = events[index], entry = event?.params?.entry;
    const candidate = favicon && event?.method === 'Log.entryAdded' && entry?.source === 'network' && entry.level === 'error' && entry.url === favicon
      && entry.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)' && typeof entry.networkRequestId === 'string' && entry.networkRequestId.length > 0;
    if (!candidate) { exceptions.push(event); continue; }
    const receipt = records.get(entry.networkRequestId), request = receipt?.request, response = receipt?.response;
    const contradicted = records.has(entry.networkRequestId) && receipt === null || receipt && (receipt.requestCount > 1 || receipt.responseCount > 1)
      || request && (request.method !== 'GET' || request.url !== favicon || request.type !== 'Other' || request.initiatorType !== 'other' || request.initiatorHasStack !== false || request.redirected !== false)
      || response && (response.url !== favicon || response.status !== 404 || response.type !== 'Other');
    if (contradicted) { exceptions.push(event); continue; }
    if (request && response && receipt.requestCount === 1 && receipt.responseCount === 1) {
      ambientNetworkErrors.push({ reason: 'automatic-optional-favicon-404', event, receipt: structuredClone(receipt) }); continue;
    }
    const received = observedAt[index], expiresAt = received + faviconReceiptWaitMs;
    if (!final && Number.isFinite(received) && received <= now && now < expiresAt) pendingNetworkErrors.push({ event, index, expiresAt });
    else exceptions.push(event);
  }
  return { exceptions, ambientNetworkErrors, pendingNetworkErrors };
}

/** Pending correlation is a barrier, never permission to continue UI input.
 * The caller notifies on real network receipts or the bounded receipt deadline. */
export async function awaitRuntimeHealth(read, waitForChange) {
  for (;;) {
    const state = read(); assert.deepEqual(state.exceptions, [], 'Fatal renderer or unclassified network error');
    assert.equal(state.eventOverflow, 0, 'Runtime evidence overflow');
    if (!state.pendingNetworkErrors.length) return state;
    await waitForChange(Math.min(...state.pendingNetworkErrors.map(row => row.expiresAt)));
  }
}

/** A readiness assertion can be transient; a known runtime failure cannot.
 * Health checks sit outside the retry catch and retain the original100ms poll. */
export async function waitForObservation(check, { now, deadline, assertHealthy, pause, label }) {
  let last;
  while (now() < deadline) {
    await assertHealthy();
    let value;
    try { value = await check(); }
    catch (error) { await assertHealthy(); last = error; await pause(100); continue; }
    await assertHealthy(); return value;
  }
  throw new Error(label + ': ' + (last?.message ?? 'deadline'));
}

export function trackedHarnessInputs(tracked) {
  for (const name of [...harnessInputs, 'tests/tasks-electron-integration/cdp.mjs', 'tests/bases-electron-integration/ui.mjs', 'tests/browser-workblocks-worker/cleanup.mjs']) assert.ok(tracked.includes(name), 'Executing harness input must be tracked in the frozen checkout: ' + name);
}

/** Late startup resources still have an owner after a workflow deadline. Their
 * close failures are retained for final acceptance rather than discarded. */
export function trackOwnedStartup(work, name, closeLate) {
  const state = { name, expired: false, creationSettled: false, cleanupStatus: 'not_required' };
  const settled = Promise.resolve(work).then(async resource => {
    state.creationSettled = true;
    if (state.expired) {
      state.cleanupStatus = 'running';
      try { await closeLate(resource); state.cleanupStatus = 'closed'; }
      catch (error) { state.cleanupStatus = 'failed'; state.cleanupError = String(error?.stack ?? error); }
    }
  }, error => { state.creationSettled = true; state.creationError = String(error?.stack ?? error); });
  return { state, settled };
}

export function finalEvidence(evidence) {
  assert.equal(evidence.workflowCompleted, true);
  assert.deepEqual(evidence.phases.map(({ name, status }) => ({ name, status })), phaseNames.map(name => ({ name, status: 'passed' })));
  assert.deepEqual(evidence.exceptions, [], 'Late renderer errors must fail final acceptance'); assert.equal(evidence.eventOverflow, 0);
  const classified = classifyRuntimeErrors(evidence.errorEvents, evidence.networkReceipts, evidence.origin, { final: true });
  assert.deepEqual(classified.exceptions, [], 'Unclassified final runtime error');
  assert.deepEqual(classified.ambientNetworkErrors, evidence.ambientNetworkErrors, 'Ambient error evidence must retain exact raw errors and correlated receipts');
  assert.deepEqual(evidence.pendingNetworkErrors, [], 'Final runtime receipts must not remain pending');
  assert.equal(evidence.provenanceVerified, true); assert.equal(evidence.finalProvenanceVerified, true);
  assert.equal(evidence.normalClose?.requested, true); assert.deepEqual(evidence.cleanup.failures, []);
  assert.equal(evidence.cleanup.chrome.exitCode, 0); assert.equal(evidence.cleanup.chrome.signalCode, null); assert.deepEqual(evidence.cleanup.chrome.signals, []);
  assert.equal(evidence.cleanup.vite.closeResolved, true);
  assert.equal(evidence.startupCleanupTimedOut, false);
  for (const resource of evidence.startupResources) {
    assert.equal(resource.creationSettled, true, 'Owned resource creation remains unresolved');
    assert.ok(!resource.cleanupError, 'Late owned resource cleanup failed');
    assert.ok(!resource.expired || !!resource.creationError || resource.cleanupStatus === 'closed', 'Late resource was not closed');
  }
}

export function savedNote(snapshot, expectedPath, expectedSource, previous) {
  assert.equal(snapshot.database, databaseName);
  assert.equal(snapshot.version, 6, 'The independently inspected browser schema is version6');
  assert.equal(snapshot.entries.length, 1, 'Fresh normal vault contains exactly the one UI-created entry');
  const entry = snapshot.entries[0];
  assert.equal(entry.kind, 'file'); assert.equal(entry.deleted, false); assert.equal(entry.path, expectedPath);
  assert.ok(typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 256);
  assert.ok(typeof entry.revision === 'string' && entry.revision.length > 0 && entry.revision.length <= 256);
  assert.equal(snapshot.contents.length, 1);
  assert.equal(snapshot.contents[0].id, entry.id);
  assert.deepEqual(snapshot.contents[0].bytes, [...new TextEncoder().encode(expectedSource)], 'Independent whole saved-byte oracle');
  if (previous) assert.equal(entry.id, previous.id, 'Normal rename/edit preserves entry identity');
  return structuredClone(entry);
}

export function editorFrame(frame, expectedTitle, expectedSource, focused = false) {
  assert.equal(frame.workspace, true); assert.equal(frame.desktopBridge, false); assert.equal(frame.fixtureMarker, false);
  assert.equal(frame.title, expectedTitle); assert.equal(frame.editors, 1); assert.equal(frame.connected, true);
  assert.equal(frame.editable, true); assert.equal(frame.text, expectedSource); assert.equal(frame.saveState, '');
  if (focused) assert.equal(frame.focusedEditor, true, 'Normal title Enter transfers focus; the harness never forces it');
}

export function reloadFrame(before, after, saved, reopened) {
  assert.ok(Number.isFinite(before) && Number.isFinite(after) && after > before, 'Reload creates a different normal document');
  assert.deepEqual(reopened, saved, 'Normal reload retains the exact saved entry and revision');
}

export function searchFrame(frame, entry) {
  assert.equal(frame.query, marker); assert.equal(frame.total, '1 match in 1 file'); assert.equal(frame.status, '');
  assert.equal(frame.groups.length, 1); const group = frame.groups[0];
  assert.equal(group.entryId, entry.id); assert.equal(group.path, notePath); assert.equal(group.title, noteName);
  assert.equal(group.badge, '1'); assert.equal(group.snippets.length, 1);
  assert.ok(group.snippets[0].text.includes(marker)); assert.deepEqual(group.snippets[0].marks, [marker]);
}

/** A serialized observational reader. It never creates an absent database or
 * issues a write transaction, and closes its connection at every outcome. */
export async function readOnlyDatabaseSnapshot(name) {
  if (typeof indexedDB.databases !== 'function') throw Error('Read-only database inventory unavailable');
  const matches = (await indexedDB.databases()).filter(row => row.name === name);
  if (matches.length !== 1 || matches[0].version !== 6) throw Error('Expected existing version6 normal browser database');
  return new Promise((resolve, reject) => {
    let database, settled = false;
    const fail = error => { if (settled) return; settled = true; database?.close(); reject(error); };
    const opening = indexedDB.open(name, matches[0].version);
    opening.onupgradeneeded = () => { opening.transaction?.abort(); fail(Error('Read-only observer refused database creation/upgrade')); };
    opening.onerror = () => fail(Error('Read-only observer could not open existing database'));
    opening.onblocked = () => fail(Error('Read-only observer database open blocked'));
    opening.onsuccess = () => {
      database = opening.result;
      if (settled) { database.close(); return; }
      database.onversionchange = () => fail(Error('Database version changed during observation'));
      try {
        if (database.version !== 6 || !database.objectStoreNames.contains('metadata') || !database.objectStoreNames.contains('content')) throw Error('Unexpected normal database schema');
        const tx = database.transaction(['metadata', 'content'], 'readonly');
        const metadata = tx.objectStore('metadata'), content = tx.objectStore('content');
        if (metadata.keyPath !== 'id' || content.keyPath !== 'id') { tx.abort(); throw Error('Unexpected normal database keys'); }
        const entries = metadata.getAll(), contents = content.getAll();
        tx.onerror = tx.onabort = () => fail(Error('Read-only observer transaction failed'));
        tx.oncomplete = () => {
          if (settled) return;
          try {
            if (entries.result.length > 16 || contents.result.length > 16) throw Error('Unexpected fixture storage inventory');
            const rows = contents.result.map(row => {
              if (!(row.bytes instanceof Uint8Array) || row.bytes.length > 65536) throw Error('Unexpected saved-byte representation');
              return { id: row.id, bytes: Array.from(row.bytes) };
            });
            const observation = { database: name, version: database.version, entries: entries.result.filter(row => !row.deleted), contents: rows };
            settled = true; database.close(); resolve(observation);
          } catch (error) { fail(error); }
        };
      } catch (error) { fail(error); }
    };
  });
}
