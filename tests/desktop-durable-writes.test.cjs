'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { desktopDurableWrites } = require('../desktop/durable-writes.cjs');
const { CoreVaultFixtureService } = require('../desktop/core-vault-fixture-service.cjs');
function fixture() {
  let current = { entry: { id: 'entry', revision: 'revision', path: 'note.md', kind: 'file', deleted: false }, has_content: true, bytes: Buffer.from('\ufeffsame \ud83d\ude80') };
  current.presentation = { id: 'entry', ctime_ms: 1, mtime_ms: 2, size_bytes: current.bytes.length };
  let localId = 'authority';
  let row;
  let commits = 0;
  const host = {
    root: '/fixture', identity: async () => ({ local_store_id: localId, realm_id: null, vault_id: null }),
    readPath: async () => current,
    readPresentedById: async id => { if (id !== current.entry.id) throw Object.assign(new Error('missing'), { code: 'not_found' }); return current; },
    prepareIntent: async (client, request) => (row ??= { client_id: client, token: 'token', operation_id: request.operation_id, entry_id: request.mutation.id,
      mutation_kind: 'write', state: 'prepared', acknowledged: false, receipt: null, error: null, projection: null, order: '1' }),
    queryIntent: async () => row ?? null,
    commitIntent: async () => { commits++; return row = { ...row, state: 'committed', receipt: { operation_id: row.operation_id, sequence: '1', changes: [{ before: current.entry, after: { ...current.entry, revision: 'committed-revision' } }] } }; },
    listIntents: async () => ({ intents: row ? [row] : [], next_cursor: row ? '1' : '0', has_more: false }),
    acknowledgeIntent: async () => (row = { ...row, acknowledged: true }),
  };
  const service = new CoreVaultFixtureService(host, { pollMs: 750, rescanMs: 30000 });
  return { service, host, get current() { return current; }, set current(value) { current = value; }, get row() { return row; }, set row(value) { row = value; }, set authority(value) { localId = value; }, get commits() { return commits; } };
}
function input(read, operationId = 'operation') {
  return { operationId, path: 'note.md', expectedEntryId: read.entryId, expectedRevision: read.revision, expectedContent: read.content, content: '\ufeffnew \ud83d\ude00' };
}

test('coherent text read binds plans to observed ID and revision, including same-byte replacement', async () => {
  const f = fixture(), writes = await desktopDurableWrites(f.service, { clientId: 'client' });
  const read = await writes.readText('note.md');
  assert.deepEqual(read, { path: 'note.md', content: '\ufeffsame \ud83d\ude80', entryId: 'entry', revision: 'revision', stat: { ctime: 1, mtime: 2, size: Buffer.byteLength('\ufeffsame \ud83d\ude80') } });
  for (const changed of [{ id: 'replacement', revision: 'revision' }, { id: 'entry', revision: 'new-revision' }]) {
    f.current = { ...f.current, entry: { ...f.current.entry, ...changed } };
    await assert.rejects(writes.planWrite(input(read)), { code: 'revision_conflict' });
    assert.equal(f.row, undefined);
  }
});

test('authority-bound exact plan survives serialization and remains inert until explicit commit', async () => {
  const f = fixture(), writes = await desktopDurableWrites(f.service, { clientId: 'client' });
  const plan = await writes.planWrite(input(await writes.readText('note.md')));
  assert.equal(plan.vaultId, 'authority'); assert.ok(Object.isFrozen(plan));
  const prepared = await writes.prepare(JSON.parse(JSON.stringify(plan)));
  assert.equal(prepared.state, 'prepared'); assert.equal(f.commits, 0);
  assert.deepEqual(await writes.prepare(plan), prepared);
  const committed = await writes.commit(prepared.ref);
  assert.equal(committed.state, 'committed');
  assert.equal(committed.receipt.entryId, 'entry');
  assert.equal(committed.receipt.revision, 'committed-revision');
  await assert.rejects(writes.acknowledge(prepared.ref, { status: 'committed', operationId: 'operation', sequence: '2' }), { code: 'intent_outcome_mismatch' });
  await writes.acknowledge(prepared.ref, { status: 'committed', operationId: 'operation', sequence: '1' });
  assert.deepEqual(await writes.listUnacknowledged(), []);
  f.authority = 'replacement-store';
  const reopened = await desktopDurableWrites(f.service, { clientId: 'client' });
  await assert.rejects(reopened.query(prepared.ref), { code: 'intent_identity_mismatch' });
  await assert.rejects(reopened.prepare(plan), { code: 'intent_identity_mismatch' });
});

test('non-write tokens and altered operation identity cannot authorize commit', async () => {
  const f = fixture(), writes = await desktopDurableWrites(f.service, { clientId: 'client' });
  const prepared = await writes.prepare(await writes.planWrite(input(await writes.readText('note.md'))));
  f.row = { ...f.row, mutation_kind: 'delete' };
  assert.deepEqual(await writes.listUnacknowledged(), []);
  await assert.rejects(writes.commit(prepared.ref), { code: 'intent_kind_unsupported' });
  assert.equal(f.commits, 0);
  f.row = { ...f.row, mutation_kind: 'write', operation_id: 'other' };
  await assert.rejects(writes.commit(prepared.ref), { code: 'intent_identity_mismatch' });
  assert.equal(f.commits, 0);
});

test('malformed or oversized encoded plans reject before preparation', async () => {
  const f = fixture(), writes = await desktopDurableWrites(f.service, { clientId: 'client' });
  const plan = await writes.planWrite(input(await writes.readText('note.md')));
  const duplicate = plan.encodedPlan.replace('{', '{"operation_id":"discarded",');
  await assert.rejects(writes.prepare({ ...plan, encodedPlan: duplicate }), { code: 'invalid_write_plan' });
  await assert.rejects(writes.prepare({ ...plan, encodedPlan: ' '.repeat(8 * 1024 * 1024 + 1) }), { code: 'encoded_plan_too_large' });
  const request = JSON.parse(plan.encodedPlan); request.content_base64 = '/w==';
  await assert.rejects(writes.prepare({ ...plan, encodedPlan: JSON.stringify(request) }), { code: 'not_utf8' });
  await assert.rejects(writes.planWrite({ ...input(await writes.readText('note.md')), content: '\ud800' }), { code: 'invalid_text' });
  assert.equal(f.row, undefined);
});

test('caller ref mutation during await cannot retarget the authorized commit', async () => {
  const f = fixture(), writes = await desktopDurableWrites(f.service, { clientId: 'client' });
  const prepared = await writes.prepare(await writes.planWrite(input(await writes.readText('note.md'))));
  let release;
  f.host.queryIntent = () => new Promise(resolve => { release = () => resolve(f.row); });
  let requested;
  const commit = f.host.commitIntent;
  f.host.commitIntent = async ref => { requested = ref; return commit(); };
  const ref = { ...prepared.ref };
  const pending = writes.commit(ref);
  ref.token = 'other'; ref.operationId = 'other'; release();
  assert.equal((await pending).state, 'committed');
  assert.deepEqual(requested, { client_id: 'client', token: 'token' });
});


test('ID read preserves current locator through rename and missing IDs return null', async () => {
  const f = fixture(), writes = await desktopDurableWrites(f.service, { clientId: 'client' });
  f.current = { ...f.current, entry: { ...f.current.entry, path: 'renamed.md', revision: 'after-rename' } };
  assert.deepEqual(await writes.readTextById('entry'), { path: 'renamed.md', entryId: 'entry', revision: 'after-rename', content: '\ufeffsame \ud83d\ude80', stat: { ctime: 1, mtime: 2, size: Buffer.byteLength('\ufeffsame \ud83d\ude80') } });
  assert.equal(await writes.readTextById('missing'), null);
  f.host.readPresentedById = async () => { throw Object.assign(new Error('corruption'), { code: 'corrupt_storage' }); };
  await assert.rejects(writes.readTextById('entry'), { code: 'corrupt_storage' });
});
