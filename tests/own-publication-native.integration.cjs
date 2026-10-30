'use strict';
// Explicit actual-host target; no missing-binary skips or timing acceptance.
// ZORID_DESKTOP_HOST_BIN=/absolute/built/zorid-desktop-host node --test --test-concurrency=1 tests/own-publication-native.integration.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { CoreVaultFixtureService } = require('../desktop/core-vault-fixture-service.cjs');

function selectedProof(root, scanId) {
  const database = new DatabaseSync(path.join(root, '.zorid/vault.sqlite'), { readOnly: true });
  try {
    return database.prepare("SELECT record FROM family_external_scan_proofs WHERE scan_id=? AND path='a-own.md'").get(scanId)?.record;
  } finally { database.close(); }
}

test('actual host and automatic Core polling finish positive hints before a fresh namespace scan', { timeout: 30000 }, async t => {
  const executable = process.env.ZORID_DESKTOP_HOST_BIN;
  assert.ok(executable && path.isAbsolute(executable), 'ZORID_DESKTOP_HOST_BIN must identify the actual built host; no skip or fallback');
  await fs.access(executable, fs.constants.X_OK);
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'zorid-own-publication-'));
  const root = path.join(parent, 'vault');
  let core, unsubscribe, recorder;
  t.after(async () => {
    try {
      core?.listeners.delete(recorder);
      unsubscribe?.();
      if (core) {
        await core.close();
        assert.equal(core.host.child.exitCode, 0);
        assert.equal(core.host.child.signalCode, null);
        assert.equal(core.host.fatal, null);
      }
    } finally { await fs.rm(parent, { recursive: true, force: true }); }
  });
  await fs.mkdir(root);
  const original = '\ufeffOriginal saved body 😀\r\n';
  await fs.writeFile(path.join(root, 'a-own.md'), original);
  const previousData = process.env.ZORID_LOCAL_DATA_DIR;
  process.env.ZORID_LOCAL_DATA_DIR = path.join(parent, 'local-data');
  try {
    core = await CoreVaultFixtureService.open(root, { fixture: true, executable, initializeLocal: true, familyMode: true, pollMs: 100, rescanMs: 30000 });
  } finally {
    if (previousData === undefined) delete process.env.ZORID_LOCAL_DATA_DIR;
    else process.env.ZORID_LOCAL_DATA_DIR = previousData;
  }
  // Complete ordinary initial admission before adding the new source set.
  for (let turn = 0; !core.reconciliation.complete && turn < 128; turn++) await core.pollNow();
  assert.equal(core.reconciliation.complete, true);
  const before = await core.readEntry('a-own.md');
  assert.equal(Buffer.from(before.bytes).toString('utf8'), original);
  const clientId = randomUUID();
  const lease = await core.host.claimClient(clientId);
  const scoped = Object.create(core);
  Object.defineProperty(scoped, 'host', { value: core.host.withClientLease(lease) });

  const tail = 'z-last.md', tailBody = '# Last independently captured source\n';
  for (let index = 0; index < 64; index++) {
    await fs.writeFile(path.join(root, `n-${String(index).padStart(3, '0')}.md`), `# External ${index}\n${'body\n'.repeat(1600)}`);
  }
  await fs.writeFile(path.join(root, tail), tailBody);
  // Observe the real notify sink without starting automatic polling yet. This
  // includes any attention emitted on the very first retired-header handoff.
  const events = [], statuses = [];
  recorder = event => {
    events.push(event);
    if (event.type === 'reconciliation') statuses.push(structuredClone(event.reconciliation));
  };
  core.listeners.add(recorder);
  core.needsScan = true;
  await core.pollNow();
  assert.equal(core.reconciliation.complete, false);
  assert.equal(core.reconciliation.work.pending, true);
  assert.equal(core.reconciliation.work.phase, 'discovery');
  const oldScan = core.reconciliation.scanId, oldObserved = core.reconciliation.observed;
  const immutable = selectedProof(core.root, oldScan);
  assert.equal(typeof immutable, 'string');

  const saved = '\ufeffOrdinary exact host-intent save 🚀\r\n';
  const plan = await scoped.planTextWrite('a-own.md', saved, { operationId: randomUUID(), entryId: before.entry.id, expectedRevision: before.entry.revision, expectedContent: original });
  const prepared = await scoped.prepareIntent(clientId, plan);
  const reference = { client_id: clientId, token: prepared.token };
  const committed = await scoped.commitIntent(reference);
  assert.equal(committed.state, 'committed');
  assert.equal(committed.projection, 'projected');
  assert.deepEqual((await scoped.commitIntent(reference)).receipt, committed.receipt, 'exact intent replay cannot author a second save');
  assert.equal(await fs.readFile(path.join(root, 'a-own.md'), 'utf8'), saved);

  // Journal reloads may precede the next rescan. Reach its actual framed reply
  // before testing automatic scheduling of this truthful retired header.
  for (let turn = 0; !core.reconciliation.finished && turn < 16; turn++) await core.pollNow();
  assert.equal(core.reconciliation.scanId, oldScan);
  assert.equal(core.reconciliation.finished, true);
  assert.equal(core.reconciliation.scanComplete, false);
  assert.equal(core.reconciliation.complete, false);
  assert.equal(core.reconciliation.observed, oldObserved);
  assert.equal(core.reconciliation.issueCount, 0);
  assert.deepEqual(core.reconciliation.issues, []);
  assert.deepEqual(core.reconciliation.work, { pending: true, phase: 'discovery', workUnits: core.reconciliation.work.workUnits });
  assert.ok(core.reconciliation.work.workUnits <= 16);
  assert.equal(selectedProof(core.root, oldScan), immutable);
  assert.equal(await core.readEntry(tail), null, 'fixture tail must still require continuation');

  let timer;
  try {
    await new Promise((resolve, reject) => {
      // A watchdog bounds the test; its duration is not a latency acceptance.
      timer = setTimeout(() => reject(new Error('automatic Core polling did not finish source reconciliation')), 20000);
      unsubscribe = core.subscribe(event => {
        if (event.type === 'error') reject(new Error(`unexpected maintenance attention: ${event.code}`));
        if (event.type === 'reconciliation') {
          if (event.reconciliation.complete) resolve();
        }
      });
    });
    if (core.polling) await core.polling;
  } finally { clearTimeout(timer); core.listeners.delete(recorder); unsubscribe?.(); unsubscribe = null; }
  assert.ok(statuses.some(status => status.scanId === oldScan && status.finished && !status.complete && !status.scanComplete && status.work.pending), 'record the first retired-header transition itself');
  assert.ok(statuses.some(status => status.scanId !== oldScan && status.complete && status.scanComplete && status.finished), 'automatic consumer must reach a fresh complete namespace inventory');
  assert.ok(statuses.filter(status => status.scanId === oldScan).every(status => !status.complete && !status.scanComplete && status.work.pending && status.work.phase === 'discovery'));
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(selectedProof(core.root, oldScan), immutable);
  const last = await core.readEntry(tail);
  assert.ok(last?.entry?.id);
  assert.equal(Buffer.from(last.bytes).toString('utf8'), tailBody);
  assert.equal(await fs.readFile(path.join(root, tail), 'utf8'), tailBody);
  const final = await core.readEntry('a-own.md');
  assert.equal(final.entry.id, before.entry.id);
  assert.equal(final.entry.revision, committed.receipt.changes[0].after.revision);
  assert.equal(Buffer.from(final.bytes).toString('utf8'), saved);
  assert.equal(await fs.readFile(path.join(root, 'a-own.md'), 'utf8'), saved);
});
