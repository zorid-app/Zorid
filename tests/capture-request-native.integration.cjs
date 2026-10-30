'use strict';
// Explicit actual-host target, outside npm's default *.test.* glob.
// Run with ZORID_DESKTOP_HOST_BIN=/absolute/built/zorid-desktop-host node --test --test-concurrency=1 tests/capture-request-native.integration.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { RustVaultService } = require('../desktop/rust-vault-service.cjs');

test('actual host preserves caller capture requests across EOF restart and fences exact cancellation', { timeout: 30000 }, async t => {
  const executable = process.env.ZORID_DESKTOP_HOST_BIN;
  assert.ok(executable && path.isAbsolute(executable), 'ZORID_DESKTOP_HOST_BIN must identify the actual built Rust host; no skip or fallback');
  await fs.access(executable, fs.constants.X_OK);
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'zorid-capture-request-'));
  const root = path.join(parent, 'vault');
  const hosts = [];
  t.after(async () => {
    try { for (const host of hosts) await host.close(); }
    finally { await fs.rm(parent, { recursive: true, force: true }); }
  });
  await fs.mkdir(root);
  const source = '\ufeff---\r\nscore: 9\r\n---\r\nOriginal body 😀\r\n';
  const note = path.join(root, 'note.md');
  await fs.writeFile(note, source);
  const clientId = randomUUID();

  async function open(initializeLocal = false) {
    // Keep history/cache in the disposable fixture too. The service inherits
    // this trusted startup setting; restore it before any other test can run.
    const previous = process.env.ZORID_LOCAL_DATA_DIR;
    process.env.ZORID_LOCAL_DATA_DIR = path.join(parent, 'local-data');
    let host;
    try { host = await RustVaultService.open(root, { executable, initializeLocal, timeoutMs: 10000 }); }
    finally {
      if (previous === undefined) delete process.env.ZORID_LOCAL_DATA_DIR;
      else process.env.ZORID_LOCAL_DATA_DIR = previous;
    }
    hosts.push(host);
    assert.ok(host.capabilities.includes('conditional_saved_source_requests'));
    assert.equal(host.capabilities.includes('conditional_saved_source'), false, 'old ID-less capability must not be advertised');
    const lease = await host.claimClient(clientId);
    return { host, lease, scoped: host.withClientLease(lease) };
  }
  async function close(host) {
    // EOF ends only the process; explicit releaseClient would retire pending
    // captures and would therefore test a different lifetime boundary.
    await host.close();
    assert.equal(host.exited, true);
    assert.equal(host.child.exitCode, 0);
    assert.equal(host.child.signalCode, null);
    assert.equal(host.fatal, null);
  }
  const closed = error => error.code === 'source_capture_closed' && error.commitUncertain === false;

  let current = await open(true);
  // Initial startup yields bounded discovery/import work. Finish that explicit
  // lifecycle before selecting a logical witness; never assume hello imported it.
  let reconciliation = current.host.reconciliation;
  for (let turn = 0; !reconciliation.complete && turn < 64; turn++) {
    assert.equal(reconciliation.issueCount, 0);
    reconciliation = (await current.host.rescan()).reconciliation;
  }
  assert.equal(reconciliation.complete, true, 'disposable source import must finish');
  const read = await current.host.readPath('note.md');
  assert.ok(read?.entry);
  assert.equal(Buffer.from(read.bytes).toString('utf8'), source);
  const logicalWitness = { entryId: read.entry.id, revision: read.entry.revision, path: read.entry.path };
  const request = { captureId: randomUUID(), logicalWitness };
  await assert.rejects(async () => current.scoped.captureSavedSource(clientId, logicalWitness), { code: 'invalid_saved_source' });
  // Use an exactly representable timestamp so restoration below has an exact
  // filesystem oracle rather than a Date conversion losing submillisecond bits.
  await fs.utimes(note, 1700000000, 1700000000);
  const first = await current.scoped.captureSavedSource(clientId, request);
  assert.deepEqual(first, { ...request, source });
  assert.deepEqual(await current.scoped.captureSavedSource(clientId, request), first);
  const pending = [{ ...request, legacy: false }];
  assert.deepEqual(await current.scoped.listSavedSourceRequests(clientId), pending, 'exact replay uses one pending identity and discloses no guard/body/token');
  const changedRequest = { captureId: randomUUID(), logicalWitness };
  assert.deepEqual(await current.scoped.captureSavedSource(clientId, changedRequest), { ...changedRequest, source });
  const bothPending = [...pending, { ...changedRequest, legacy: false }].sort((a, b) => a.captureId.localeCompare(b.captureId));
  assert.deepEqual(await current.scoped.listSavedSourceRequests(clientId), bothPending, 'distinct caller IDs retain distinct original guards');
  const originalLease = current.lease;
  const originalPid = current.host.child.pid;
  const before = await fs.stat(note);
  await close(current.host);

  // Change bytes while no host exists. The first replay after reopen must
  // verify persisted original evidence, rather than recapture the new bytes.
  await fs.writeFile(note, source.replace('score: 9', 'score: 7'));
  await fs.utimes(note, before.atime, before.mtime);
  assert.equal((await fs.stat(note)).size, before.size);
  assert.equal((await fs.stat(note)).mtimeMs, before.mtimeMs);
  current = await open();
  assert.notEqual(current.host.child.pid, originalPid);
  assert.equal(current.lease.client_id, originalLease.client_id);
  assert.equal(current.lease.local_store_id, originalLease.local_store_id);
  assert.notEqual(current.lease.token, originalLease.token);
  assert.deepEqual(await current.scoped.listSavedSourceRequests(clientId), bothPending);
  await assert.rejects(current.scoped.captureSavedSource(clientId, changedRequest), { code: 'conditional_source_changed', commitUncertain: false });
  await fs.writeFile(note, source);
  await assert.rejects(current.scoped.captureSavedSource(clientId, changedRequest), { code: 'conditional_source_changed' });
  assert.deepEqual(await current.scoped.listSavedSourceRequests(clientId), pending);
  assert.deepEqual(await current.scoped.captureSavedSource(clientId, request), first, 'unchanged original evidence replays under the fresh same-client lease');

  const accepted = request;
  const neverDispatched = { captureId: randomUUID(), logicalWitness };
  for (const cancelled of [accepted, neverDispatched]) {
    assert.deepEqual(await current.scoped.releaseSavedSource(clientId, cancelled.captureId), { released: true });
    assert.deepEqual(await current.scoped.releaseSavedSource(clientId, cancelled.captureId), { released: true });
    await assert.rejects(current.scoped.captureSavedSource(clientId, cancelled), closed);
  }
  assert.deepEqual(await current.scoped.listSavedSourceRequests(clientId), []);
  await close(current.host);

  current = await open();
  for (const cancelled of [accepted, neverDispatched]) await assert.rejects(current.scoped.captureSavedSource(clientId, cancelled), closed);
  await assert.rejects(current.scoped.captureSavedSource(clientId, changedRequest), { code: 'conditional_source_changed' });
  assert.deepEqual(await current.scoped.listSavedSourceRequests(clientId), []);
  assert.equal(Buffer.from((await current.host.readPath('note.md')).bytes).toString('utf8'), source);
  assert.equal(await fs.readFile(note, 'utf8'), source);
  await close(current.host);
});
