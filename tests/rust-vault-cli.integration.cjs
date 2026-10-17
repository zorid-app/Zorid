'use strict';
// Explicit native integration target, outside npm's default *.test.* glob.
// Requires built binaries; absence is an error rather than a passing skip.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { RustVaultService } = require('../desktop/rust-vault-service.cjs');
const { VaultService } = require('../desktop/vault-service.cjs');
const { desktopDurableWrites } = require('../desktop/durable-writes.cjs');

function cli(root, args, input = Buffer.alloc(0)) {
  const executable = process.env.ZORID_CLI_BIN;
  assert.ok(executable && path.isAbsolute(executable), 'ZORID_CLI_BIN must identify the actual built standalone CLI');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--vault', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI fixture timeout')); }, 10000);
    child.stdout.on('data', data => stdout.push(data)); child.stderr.on('data', data => stderr.push(data));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try { resolve({ code, response: JSON.parse(Buffer.concat(code === 0 ? stdout : stderr).toString('utf8')) }); }
      catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

test('real desktop Rust host and independently executing CLI share durable vault safely', { timeout: 30000 }, async t => {
  const executable = process.env.ZORID_DESKTOP_HOST_BIN;
  assert.ok(executable && path.isAbsolute(executable), 'ZORID_DESKTOP_HOST_BIN must identify the actual built Rust host');
  const root = await fs.mkdtemp(path.join(tmpdir(), 'zorid-desktop-cli-'));
  const hosts = [];
  t.after(async () => { for (const host of hosts) await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await cli(root, ['init'])).code, 0);
  const original = Buffer.from([0, 255, 128, 10, 13]);
  assert.equal((await cli(root, ['create', 'data.unknown', '--id', 'binary', '--operation-id', 'create', '--input', '-'], original)).code, 0);
  const host = await RustVaultService.open(root, { executable });
  hosts.push(host);
  const initial = await host.readEntryById('binary');
  assert.deepEqual(Buffer.from(initial.bytes), original);
  const hostBody = Buffer.from([1, 0, 254]), cliBody = Buffer.from([2, 0, 253]);
  const hostWrite = host.apply('host-write', { type: 'write', id: 'binary', expected: initial.entry.revision }, hostBody);
  const cliWrite = cli(root, ['write', '--id', 'binary', '--expected-revision', initial.entry.revision, '--operation-id', 'cli-write', '--input', '-'], cliBody);
  const [native, standalone] = await Promise.allSettled([hostWrite, cliWrite]);
  assert.equal(standalone.status, 'fulfilled');
  const cliWon = standalone.value.code === 0;
  assert.notEqual(native.status === 'fulfilled', cliWon, 'exactly one conditional write commits');
  if (native.status === 'rejected') assert.equal(native.reason.code, 'revision_conflict');
  if (!cliWon) assert.equal(standalone.value.response.error.code, 'revision_conflict');
  const read = await host.readEntryById('binary');
  const winner = cliWon ? cliBody : hostBody;
  assert.deepEqual(Buffer.from(read.bytes), winner);
  assert.deepEqual(await fs.readFile(path.join(root, 'data.unknown')), winner);
  // An ordinary external editor changes the same file while both clients are
  // closed. A later standalone reconciliation imports exact bytes without IPC.
  await host.close();
  const external = Buffer.from([9, 0, 255, 0, 128]);
  await fs.writeFile(path.join(root, 'data.unknown'), external);
  assert.equal((await cli(root, ['reconcile', 'data.unknown'])).code, 0);
  const reopened = await RustVaultService.open(root, { executable });
  hosts.push(reopened);
  assert.deepEqual(Buffer.from((await reopened.readEntryById('binary')).bytes), external);
  await reopened.close();
});

test('fixture VaultService reads committed metadata and observes independent CLI changes', { timeout: 30000 }, async t => {
  const executable = process.env.ZORID_DESKTOP_HOST_BIN;
  assert.ok(executable && path.isAbsolute(executable), 'ZORID_DESKTOP_HOST_BIN must identify the actual built Rust host');
  const root = await fs.mkdtemp(path.join(tmpdir(), 'zorid-core-fixture-'));
  let service;
  t.after(async () => { if (service) await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await cli(root, ['init'])).code, 0);
  const bom = Buffer.from([239, 187, 191, 104, 105]);
  await fs.writeFile(path.join(root, 'note.md'), bom);
  await fs.writeFile(path.join(root, '.hidden'), Buffer.from([255, 0]));
  service = await VaultService.open(root, { coreFixture: { executable, pollMs: 100 } });
  assert.equal(await service.read('note.md'), '\ufeffhi');
  assert.deepEqual(Buffer.from(await service.readBinary('.hidden')), Buffer.from([255, 0]));
  await assert.rejects(service.read('.hidden'), { code: 'not_utf8' });
  assert.deepEqual((await service.list()).map(value => value.path), ['note.md']);
  const current = await service.readEntry('note.md');
  assert.equal((await service.stat('note.md')).size, bom.length);
  const events = [];
  const unsubscribe = service.subscribe(change => events.push(change));
  assert.equal((await cli(root, ['write', '--id', current.entry.id, '--expected-revision', current.entry.revision,
    '--operation-id', 'cli-observed', '--input', '-'], Buffer.from('changed'))).code, 0);
  const deadline = Date.now() + 5000;
  while (!events.some(value => value.path === 'note.md') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(events.some(value => value.path === 'note.md'), 'committed CLI mutation reached subscribed service');
  assert.equal(await service.read('note.md'), 'changed');
  assert.equal((await service.stat('note.md')).size, 7);
  unsubscribe();
  await service.close();
  assert.equal(service.host.exited, true);
});

test('fixture intents survive child restart, preserve CAS and require exact consumer acknowledgment', { timeout: 30000 }, async t => {
  const executable = process.env.ZORID_DESKTOP_HOST_BIN;
  assert.ok(executable && path.isAbsolute(executable));
  const root = await fs.mkdtemp(path.join(tmpdir(), 'zorid-intent-fixture-'));
  let service;
  t.after(async () => { if (service) await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await cli(root, ['init'])).code, 0);
  const open = () => VaultService.open(root, { coreFixture: { executable } });
  service = await open();
  const plan = await service.planWrite('binary.dat', Buffer.from([0, 255, 128]), { operationId: 'create-intent', entryId: 'entry' });
  const prepared = await service.prepareIntent('consumer', plan);
  assert.equal(prepared.state, 'prepared');
  assert.equal((await service.prepareIntent('consumer', plan)).token, prepared.token);
  const reference = { client_id: 'consumer', token: prepared.token };
  assert.equal(await service.readEntry('binary.dat'), null, 'prepare is inert');
  await service.close(); service = await open();
  assert.equal((await service.queryIntent(reference)).state, 'prepared');
  assert.equal(await service.readEntry('binary.dat'), null, 'restart never commits prepared orphan');
  // A real caller would now checkpoint this token before authorizing commit.
  const committed = await service.commitIntent(reference);
  assert.equal(committed.state, 'committed'); assert.equal(committed.acknowledged, false);
  assert.deepEqual(Buffer.from(await service.readBinary('binary.dat')), Buffer.from([0, 255, 128]));
  await service.close(); service = await open();
  const recovered = await service.queryIntent(reference);
  assert.deepEqual(recovered.receipt, committed.receipt); assert.equal(recovered.projection, null);
  assert.deepEqual((await service.commitIntent(reference)).receipt, committed.receipt, 'retry uses original receipt');
  await assert.rejects(service.acknowledgeIntent(reference, { state: 'committed', operation_id: 'create-intent', sequence: '999999' }));
  assert.equal((await service.queryIntent(reference)).acknowledged, false);
  const ack = { state: 'committed', operation_id: 'create-intent', sequence: committed.receipt.sequence };
  assert.equal((await service.acknowledgeIntent(reference, ack)).acknowledged, true);
  assert.equal(await service.queryIntent({ client_id: 'other', token: prepared.token }), null);
  const before = await service.readEntry('binary.dat');
  const stalePlan = await service.planWrite('binary.dat', Buffer.from('stale write'), { operationId: 'stale', expectedBytes: before.bytes });
  const stale = await service.prepareIntent('consumer', stalePlan);
  assert.equal((await cli(root, ['write', '--id', before.entry.id, '--expected-revision', before.entry.revision,
    '--operation-id', 'cli-intervenes', '--input', '-'], Buffer.from('CLI wins'))).code, 0);
  const staleRef = { client_id: 'consumer', token: stale.token };
  const rejected = await service.commitIntent(staleRef);
  assert.equal(rejected.state, 'rejected'); assert.equal(rejected.error.code, 'revision_conflict');
  assert.equal(await service.read('binary.dat'), 'CLI wins');
  assert.deepEqual(await service.commitIntent(staleRef), rejected, 'terminal rejection does not rebase');
  const page = await service.listIntents('consumer');
  assert.equal(page.intents.length, 2);
  assert.equal((await service.acknowledgeIntent(staleRef, { state: 'rejected', operation_id: 'stale', code: 'revision_conflict' })).acknowledged, true);
});


test('shared desktop write refs survive restart and vault move but reject replacement storage', { timeout: 30000 }, async t => {
  const executable = process.env.ZORID_DESKTOP_HOST_BIN;
  assert.ok(executable && path.isAbsolute(executable));
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'zorid-authority-fixture-'));
  const root = path.join(parent, 'vault'), moved = path.join(parent, 'moved');
  let service;
  t.after(async () => { if (service) await service.close(); await fs.rm(parent, { recursive: true, force: true }); });
  await fs.mkdir(root);
  assert.equal((await cli(root, ['init'])).code, 0);
  await fs.writeFile(path.join(root, 'note.md'), '\ufefforiginal \ud83d\ude80');
  const open = async folder => {
    service = await VaultService.open(folder, { coreFixture: { executable } });
    return desktopDurableWrites(service, { clientId: 'editor-fixture' });
  };
  let writes = await open(root);
  const read = await writes.readText('note.md');
  const plan = await writes.planWrite({ operationId: 'shared-write', path: 'note.md', expectedEntryId: read.entryId,
    expectedRevision: read.revision, expectedContent: read.content, content: '\ufeffsaved \ud83d\ude00' });
  const checkpointKey = read.entryId;
  const firstCheckpoint = { key: checkpointKey, expectedRevision: null, nextRevision: '00000000-0000-0000-0000-000000000001', encodedState: JSON.stringify({ phase: 'planned', plan }) };
  const beforeCheckpoint = await service.host.status();
  await writes.checkpoints.compareAndSwap(firstCheckpoint);
  assert.equal((await service.host.status()).pending_outbox, beforeCheckpoint.pending_outbox, 'local checkpoint is not sync content');
  assert.deepEqual(await writes.checkpoints.compareAndSwap(firstCheckpoint), await writes.checkpoints.load(checkpointKey), 'exact lost checkpoint ACK retry');
  const prepared = await writes.prepare(JSON.parse(JSON.stringify(plan)));
  await writes.checkpoints.compareAndSwap({ key: checkpointKey, expectedRevision: firstCheckpoint.nextRevision,
    nextRevision: '00000000-0000-0000-0000-000000000002', encodedState: JSON.stringify({ phase: 'commit-ready', plan, ref: prepared.ref }) });
  assert.equal(prepared.state, 'prepared');
  await service.close(); writes = await open(root);
  const restored = JSON.parse((await writes.checkpoints.load(checkpointKey)).encodedState);
  assert.deepEqual(restored.ref, prepared.ref);
  assert.equal((await writes.query(restored.ref)).state, 'prepared');
  await assert.rejects(writes.checkpoints.compareAndSwap(firstCheckpoint), { code: 'checkpoint_conflict' });
  assert.equal((await writes.readText('note.md')).content, read.content);
  const committed = await writes.commit(prepared.ref);
  assert.equal(committed.state, 'committed');
  assert.equal((await writes.readText('note.md')).content, '\ufeffsaved \ud83d\ude00');
  assert.equal(committed.receipt.entryId, read.entryId);
  assert.equal(committed.receipt.revision, (await writes.readTextById(read.entryId)).revision);
  await writes.checkpoints.compareAndSwap({ key: checkpointKey, expectedRevision: '00000000-0000-0000-0000-000000000002',
    nextRevision: '00000000-0000-0000-0000-000000000003', encodedState: JSON.stringify({ phase: 'pending-ack', outcome: committed }) });
  await writes.acknowledge(prepared.ref, { status: 'committed', operationId: prepared.ref.operationId, sequence: committed.receipt.sequence });
  await writes.checkpoints.compareAndSwap({ key: checkpointKey, expectedRevision: '00000000-0000-0000-0000-000000000003',
    nextRevision: '00000000-0000-0000-0000-000000000004', encodedState: null });
  const metadata = await writes.checkpoints.changes({ after: '0', limit: 100 });
  assert.ok(metadata.items.some(item => item.deleted));
  assert.ok(metadata.items.every(item => !('encodedState' in item)));
  await service.close(); await fs.rename(root, moved);
  writes = await open(moved);
  assert.equal((await writes.query(prepared.ref)).acknowledged, true, 'folder move preserves local authority');
  await service.close(); await fs.mkdir(root);
  assert.equal((await cli(root, ['init'])).code, 0);
  writes = await open(root);
  await assert.rejects(writes.query(prepared.ref), { code: 'intent_identity_mismatch' });
  await assert.rejects(writes.prepare(plan), { code: 'intent_identity_mismatch' });
});


test('checkpoint transport accepts raw state above file limit and keeps exact tombstone fences', { timeout: 30000 }, async t => {
  const executable = process.env.ZORID_DESKTOP_HOST_BIN;
  assert.ok(executable && path.isAbsolute(executable));
  const root = await fs.mkdtemp(path.join(tmpdir(), 'zorid-large-checkpoint-'));
  let service;
  t.after(async () => { if (service) await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await cli(root, ['init'])).code, 0);
  service = await VaultService.open(root, { coreFixture: { executable } });
  const writes = await desktopDurableWrites(service, { clientId: 'large-checkpoint' });
  const encodedState = 'x'.repeat(16 * 1024 * 1024 + 1);
  const request = { key: 'large', expectedRevision: null, nextRevision: '00000000-0000-0000-0000-000000000011', encodedState };
  assert.equal((await writes.checkpoints.compareAndSwap(request)).encodedState, encodedState);
  assert.equal((await writes.checkpoints.load('large')).encodedState, encodedState);
  await assert.rejects(writes.checkpoints.compareAndSwap({ ...request, key: 'other' }), { code: 'checkpoint_conflict' });
  const tombstone = await writes.checkpoints.compareAndSwap({ key: 'large', expectedRevision: request.nextRevision,
    nextRevision: '00000000-0000-0000-0000-000000000012', encodedState: null });
  assert.equal(tombstone.deleted, true); assert.equal(tombstone.encodedState, null);
  await assert.rejects(writes.checkpoints.compareAndSwap(request), { code: 'checkpoint_conflict' });
  assert.equal((await writes.checkpoints.load('large')).revision, tombstone.revision);
});
