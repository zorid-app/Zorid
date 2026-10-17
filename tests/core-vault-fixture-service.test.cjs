'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CoreVaultFixtureService } = require('../desktop/core-vault-fixture-service.cjs');
const failure = code => Object.assign(new Error(code), { code });
function service(host) {
  return new CoreVaultFixtureService({ root: '/fixture', ...host }, { pollMs: 750, rescanMs: 30000 });
}
const state = { id: 'file', revision: 'revision', path: 'a.md', kind: 'file', deleted: false };
const presented = { state, presentation: { id: 'file', ctime_ms: 1, mtime_ms: 2, size_bytes: 3 } };

test('oversized journal pages shrink without advancing past unseen changes', async () => {
  const calls = [];
  const core = service({ changesAfter: async (cursor, limit) => {
    calls.push([cursor, limit]);
    if (limit > 25) throw failure('response_limit');
    return { changes: [{ cursor: '1', origin: { kind: 'local_command', operation_id: 'op' }, requires_full_reload: false, entries: [presented] }],
      next_cursor: '1', head_cursor: '1', has_more: false };
  }});
  const events = []; core.listeners.add(change => events.push(change));
  await core.poll();
  assert.deepEqual(calls, [['0', 100], ['0', 50], ['0', 25]]);
  assert.equal(core.cursor, '1'); assert.equal(events[0].path, 'a.md');
});

test('typed reload adopts snapshot before publishing a full reload', async () => {
  const core = service({ changesAfter: async () => { throw failure('reload_required'); },
    listSnapshot: async () => ({ entries: [presented], cursor: '7' }) });
  const events = []; core.listeners.add(change => events.push({ change, cursor: core.cursor }));
  await core.poll();
  assert.equal(core.cursor, '7');
  assert.deepEqual(events, [{ change: { type: 'change' }, cursor: '7' }]);
  assert.deepEqual(core.entries.get('file'), presented);
});

test('failed reload and generic corruption never skip the old cursor', async () => {
  let snapshots = 0;
  const core = service({ changesAfter: async () => { throw failure('reload_required'); },
    listSnapshot: async () => { snapshots++; throw failure('corrupt_storage'); } });
  await core.poll(); assert.equal(core.cursor, '0'); assert.equal(snapshots, 1);
  core.host.changesAfter = async () => { throw failure('corrupt_storage'); };
  await core.poll(); assert.equal(core.cursor, '0'); assert.equal(snapshots, 1);
});

test('timer overflow is rejected before opening any process or vault', async () => {
  await assert.rejects(CoreVaultFixtureService.open('/unused', { fixture: true, pollMs: 2147483648 }), { code: 'invalid_poll_interval' });
});

test('write plan captures exact bytes and observed revision before inert prepare', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const calls = [];
  const core = service({ readPath: async () => { await ready; return { entry: state, has_content: true, bytes: Buffer.from('old') }; },
    prepareIntent: async (...args) => { calls.push(args); return { token: 'token', state: 'prepared' }; },
    commitIntent: async () => { throw new Error('preparation must not commit'); } });
  const input = Buffer.from('new');
  const options = { operationId: 'operation', expectedBytes: Buffer.from('old'), expectedRevision: 'revision' };
  const pending = core.planWrite('a.md', input, options);
  input.fill(0); options.operationId = 'changed'; options.expectedRevision = 'changed'; release();
  const plan = await pending;
  assert.equal(plan.operation_id, 'operation');
  assert.deepEqual(plan.mutation, { type: 'write', id: 'file', expected: 'revision' });
  assert.equal(Buffer.from(plan.content_base64, 'base64').toString(), 'new');
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.mutation));
  await core.prepareIntent('client', plan); await core.prepareIntent('client', JSON.parse(JSON.stringify(plan)));
  assert.deepEqual(calls[0], calls[1], 'lost prepare ACK repeats exact request');
  assert.equal(calls.length, 2);
});

test('stale bytes or identity reject before preparation and legacy saves stay gated', async () => {
  const core = service({ readPath: async () => ({ entry: state, has_content: true, bytes: Buffer.from('old') }) });
  await assert.rejects(core.planTextWrite('a.md', 'new', { operationId: 'op', expectedContent: 'stale' }), { code: 'revision_conflict' });
  await assert.rejects(core.planTextWrite('a.md', 'new', { operationId: 'op', entryId: 'other' }), { code: 'revision_conflict' });
  await assert.rejects(core.planTextWrite('a.md', 'new', { operationId: 'op', expectedBytes: Buffer.from('stale') }), { code: 'revision_conflict' });
  await assert.rejects(core.planTextWrite('a.md', 'new', { operationId: 'op', expectedBytes: Buffer.from('old'), expectedContent: 'old' }), { code: 'ambiguous_precondition' });
  await assert.rejects(core.write('a.md', 'new'), { code: 'durable_consumer_required' });
});

test('text plans reject unpaired UTF16 surrogates and preserve valid supplementary/BOM bytes', async () => {
  let reads = 0;
  const original = '\ufeffold \ud83d\ude00';
  const core = service({ readPath: async () => { reads++; return { entry: state, has_content: true, bytes: Buffer.from(original) }; } });
  for (const malformed of ['\ud800', '\udfff', 'x\ud800y', '\ud800\ud800\udc00']) {
    await assert.rejects(core.planTextWrite('a.md', malformed, { operationId: 'op' }), { code: 'invalid_text' });
    await assert.rejects(core.planTextWrite('a.md', 'valid', { operationId: 'op', expectedContent: malformed }), { code: 'invalid_text' });
  }
  assert.equal(reads, 0);
  const content = '\ufeffnew \ud83d\ude80';
  const plan = await core.planTextWrite('a.md', content, { operationId: 'op', expectedContent: original });
  assert.deepEqual(Buffer.from(plan.content_base64, 'base64'), Buffer.from(content));
  await assert.rejects(core.planWrite('a.md', Buffer.from('x'), { operationId: 'op', expectedBytes: new Uint8Array(16 * 1024 * 1024 + 1) }), { code: 'invalid_body' });
  assert.equal(reads, 1);
});

test('incomplete scan diagnostics persist through failure and clear only with a later complete report',async()=>{
  const status={scanId:'scan',complete:false,scanComplete:true,finished:true,observed:1,imported:1,namespaceApplied:0,issueCount:1,issuesTruncated:false,issues:[{path:'retained.md',code:'recovery_retained'}]};
  const core=service({reconciliation:status,rescan:async()=>({complete:false,reconciliation:status}),changesAfter:async()=>({changes:[],next_cursor:'0',head_cursor:'0',has_more:false})});
  const events=[];core.listeners.add(event=>events.push(event));
  const incomplete=await core.retryReconciliation();assert.equal(incomplete.complete,false);assert.equal(incomplete.imported,1);
  assert.equal(events[0].type,'reconciliation');assert.equal(core.reconciliation.issueCount,1);
  core.host.rescan=async()=>{throw failure('host_timeout');};
  await assert.rejects(core.retryReconciliation(),{code:'host_timeout'});assert.equal(core.reconciliation.complete,false);assert.equal(core.reconciliation.failure,'scan_failed');
  const complete={...status,scanId:'later',complete:true,issueCount:0,issues:[]};
  core.host.rescan=async()=>({complete:true,reconciliation:complete});
  await core.retryReconciliation();assert.equal(core.reconciliation.complete,true);assert.equal(core.reconciliation.failure,undefined);
});

test('metadata stat preserves identity and rejects large convenience reads before asking for bodies',async()=>{
  let payloadReads=0;const large={...state,path:'large.bin'},presentation={...presented.presentation,size_bytes:20*1024*1024};
  const core=service({readMetadata:async()=>({entry:large,presentation,has_content:true}),readPath:async()=>{payloadReads++;throw new Error('must not allocate bytes');}});
  assert.deepEqual(await core.stat('large.bin'),{path:'large.bin',entryId:'file',revision:'revision',type:'file',mtime:2,size:20*1024*1024,ctime:1});
  await assert.rejects(core.readBinary('large.bin'),{code:'stream_required'});assert.equal(payloadReads,0);
});
