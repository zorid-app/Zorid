'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RustVaultService } = require('../desktop/rust-vault-service.cjs');
const { CoreVaultFixtureService } = require('../desktop/core-vault-fixture-service.cjs');
const { admitDesktopFixtureClient } = require('../desktop/client-admission.cjs');
const clientId = '10000000-0000-4000-8000-000000000001';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const host = Object.create(RustVaultService.prototype), calls = [];
  let active = null, owner = true, row = null, checkpoint = null, releaseFailures = 0;
  let readGate, queryGate;
  const lease = { local_store_id: 'authority', client_id: clientId, token: '10000000-0000-4000-8000-000000000002' };
  host.request = async (command, bytes = new Uint8Array(), reference) => {
    calls.push(command.method);
    if (command.method === 'claim_client') { active = lease; return { result: { lease } }; }
    if (command.method === 'release_client') {
      if (releaseFailures-- > 0) throw Object.assign(new Error('lost release'), { code: 'timeout', commitUncertain: true });
      active = null; return { result: { released: true, reference: command.reference } };
    }
    assert.deepEqual(reference, active, 'each admitted RPC carries the owned native lease');
    let result;
    switch (command.method) {
      case 'document_drafts':if(readGate)await readGate.promise;return {result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()};
      case 'binary':if(readGate)await readGate.promise;return {result:{binary:true},bytes:new Uint8Array(bytes)};
      case 'identity': result = { identity: { local_store_id: 'authority', realm_id: null, vault_id: null } }; break;
      case 'read_path':
        if (readGate) await readGate.promise;
        return { result: { entry: { id: 'entry', revision: 'rev', path: 'note.md', kind: 'file', deleted: false }, has_content: true,
          presentation: { id: 'entry', ctime_ms: 1, mtime_ms: 2, size_bytes: 4 } }, bytes: Buffer.from('base') };
      case 'prepare_intent': result = { intent: row ??= { client_id: clientId, token: 'intent', operation_id: command.operation_id,
        entry_id: 'entry', mutation_kind: 'write', state: 'prepared', acknowledged: false, receipt: null, error: null, order: '1' } }; break;
      case 'query_intent': if (queryGate) await queryGate.promise; result = { intent: row }; break;
      case 'commit_intent': result = { intent: row = { ...row, state: 'committed', receipt: { operation_id: row.operation_id, sequence: '1',
        changes: [{ before: null, after: { id: 'entry', revision: 'new-rev', kind: 'file', deleted: false } }] } } }; break;
      case 'checkpoint_load': result = { checkpoint }; break;
      case 'checkpoint_cas': checkpoint = { version: 1, vaultId: 'authority', clientId, key: command.key,
        revision: command.next_revision, sequence: '1', deleted: !command.has_state, byteLength: bytes.length };
        return { result: { checkpoint }, bytes };
      default: throw new Error(`unexpected ${command.method}`);
    }
    return { result, bytes: new Uint8Array() };
  };
  const service = new CoreVaultFixtureService(host, { pollMs: 750, rescanMs: 30000 });
  return { host, service, calls, options: { fixture: true, clientId, assertOwner() { if (!owner) throw Object.assign(new Error('retired'), { code: 'grant_retired' }); } },
    set owner(value) { owner = value; }, set readGate(value) { readGate = value; }, set queryGate(value) { queryGate = value; },
    set releaseFailures(value) { releaseFailures = value; }, get active() { return active; } };
}

test('release drains accepted work, admits only explicit flush calls, then invalidates context', async () => {
  const f = fixture(), context = await admitDesktopFixtureClient(f.service, f.options);
  const gate = deferred(); f.readGate = gate;
  const pending = context.durableWrites.readText('note.md');
  let gateEntered = false;
  const closing = context.release(async admitted => {
    gateEntered = true; admitted.assertActive();
    assert.deepEqual(admitted.scope, context.scope);
    await admitted.durableWrites.checkpoints.compareAndSwap({ key: 'note', expectedRevision: null,
      nextRevision: '10000000-0000-4000-8000-000000000003', encodedState: 'checkpointed' });
  });
  await assert.rejects(context.durableWrites.readText('note.md'), { code: 'client_not_admitted' });
  assert.equal(gateEntered, false); assert.ok(f.active);
  gate.resolve(); await pending; await closing;
  assert.equal(gateEntered, true); assert.equal(f.active, null);
  assert.ok(f.calls.indexOf('checkpoint_cas') < f.calls.indexOf('release_client'));
  assert.throws(() => context.assertActive(), { code: 'client_not_admitted' });
  await context.release(() => { throw new Error('must not reflush released context'); });
});

test('failed flush retains native ownership and uncertain release retries the exact release only', async () => {
  const f = fixture(), context = await admitDesktopFixtureClient(f.service, f.options);
  await assert.rejects(context.release(async () => { throw new Error('checkpoint failed'); }), /checkpoint failed/);
  context.assertActive(); assert.ok(f.active);
  assert.equal(f.calls.includes('release_client'), false);
  f.releaseFailures = 1;
  await assert.rejects(context.release(async () => {}), { code: 'timeout' });
  assert.throws(() => context.assertActive(), { code: 'client_not_admitted' });
  await context.release(() => { throw new Error('do not repeat successful flush'); });
  assert.equal(f.active, null);
  assert.equal(f.calls.filter(name => name === 'release_client').length, 2);
});

test('ownership is checked again after query immediately before commit authorization', async () => {
  const f = fixture(), context = await admitDesktopFixtureClient(f.service, f.options), writes = context.durableWrites;
  const read = await writes.readText('note.md');
  const plan = await writes.planWrite({ operationId: 'op', path: read.path, expectedEntryId: read.entryId,
    expectedRevision: read.revision, expectedContent: read.content, content: 'next' });
  const intent = await writes.prepare(plan);
  const gate = deferred(); f.queryGate = gate;
  const committing = writes.commit(intent.ref);
  f.owner = false; gate.resolve();
  await assert.rejects(committing);
  assert.equal(f.calls.includes('commit_intent'), false);
});

test('admission requires trusted fixture configuration and releases superseded claims', async () => {
  const f = fixture();
  await assert.rejects(admitDesktopFixtureClient(f.service, { ...f.options, fixture: false }), { code: 'invalid_admission' });
  assert.deepEqual(f.calls, []);
  let checks = 0;
  await assert.rejects(admitDesktopFixtureClient(f.service, { ...f.options, assertOwner() { if (++checks === 2) throw new Error('superseded'); } }), /superseded/);
  assert.deepEqual(f.calls, ['claim_client', 'release_client']); assert.equal(f.active, null);
});


test('queued mutation rechecks ownership at actual transport dispatch', async () => {
  const host = Object.create(RustVaultService.prototype), gate = deferred(), frames = [];
  Object.assign(host, { sequence: 0n, queuedCount: 0, queuedBytes: 0, tail: gate.promise, ready: Promise.resolve(),
    child: { stdin: { write: bytes => frames.push(bytes) } }, expect() { throw new Error('revoked request must never expect a reply'); } });
  let owner = true;
  const scoped = host.withClientLease({ local_store_id: 'authority', client_id: clientId, token: 'token' }, () => {
    if (!owner) throw Object.assign(new Error('retired'), { code: 'grant_retired' });
  });
  const pending = scoped.commitIntent({ client_id: clientId, token: 'intent' });
  assert.equal(host.queuedCount, 1);
  owner = false; gate.resolve();
  await assert.rejects(pending, { code: 'grant_retired' });
  await host.tail;
  assert.deepEqual(frames, []); assert.equal(host.queuedCount, 0); assert.equal(host.queuedBytes, 0);
});

test('a retained flush capability never revives on a later release attempt', async () => {
  const f = fixture(), context = await admitDesktopFixtureClient(f.service, f.options);
  let retired;
  await assert.rejects(context.release(admitted => { retired = admitted; throw new Error('first gate failed'); }), /first gate failed/);
  assert.throws(() => retired.assertActive(), { code: 'client_not_admitted' });
  await context.release(async current => {
    current.assertActive();
    assert.throws(() => retired.assertActive(), { code: 'client_not_admitted' });
    await assert.rejects(retired.durableWrites.checkpoints.load('note'), { code: 'client_not_admitted' });
    assert.equal((await current.durableWrites.readText('note.md')).content, 'base');
  });
  await assert.rejects(retired.durableWrites.readText('note.md'), { code: 'client_not_admitted' });
  assert.equal(f.calls.filter(name => name === 'release_client').length, 1);
});

test('successful gate revokes its capability before draining an already accepted async commit', async () => {
  const f = fixture(), context = await admitDesktopFixtureClient(f.service, f.options), writes = context.durableWrites;
  const read = await writes.readText('note.md');
  const intent = await writes.prepare(await writes.planWrite({ operationId: 'op', path: read.path,
    expectedEntryId: read.entryId, expectedRevision: read.revision, expectedContent: read.content, content: 'next' }));
  const query = deferred(), entered = deferred(); f.queryGate = query;
  let retained, accepted;
  const closing = context.release(admitted => {
    retained = admitted;
    accepted = admitted.durableWrites.commit(intent.ref);
    entered.resolve();
    // Return synchronously while the accepted operation awaits queryIntent.
  });
  await entered.promise;
  assert.throws(() => retained.assertActive(), { code: 'client_not_admitted' });
  await assert.rejects(retained.durableWrites.checkpoints.load('late'), { code: 'client_not_admitted' });
  assert.ok(f.active); assert.equal(f.calls.includes('commit_intent'), false);
  query.resolve();
  assert.equal((await accepted).state, 'committed');
  await closing;
  assert.ok(f.calls.indexOf('commit_intent') < f.calls.indexOf('release_client'));
  assert.equal(f.active, null);
});

test('failed gate revokes before drain and restores active ownership only after accepted work settles', async () => {
  const f = fixture(), context = await admitDesktopFixtureClient(f.service, f.options);
  const gate = deferred(), entered = deferred(); f.readGate = gate;
  let retained, accepted, settled = false;
  const closing = context.release(admitted => {
    retained = admitted; accepted = admitted.durableWrites.readText('note.md'); entered.resolve();
    throw new Error('persist failed');
  });
  const rejected = assert.rejects(closing, /persist failed/).then(() => { settled = true; });
  await entered.promise;
  assert.throws(() => retained.assertActive(), { code: 'client_not_admitted' });
  assert.throws(() => context.assertActive(), { code: 'client_not_admitted' });
  await assert.rejects(context.durableWrites.readText('note.md'), { code: 'client_not_admitted' });
  assert.equal(settled, false); assert.ok(f.active);
  gate.resolve(); await accepted; await rejected;
  context.assertActive(); assert.ok(f.active);
  assert.equal(f.calls.includes('release_client'), false);
});


test('unexpected window retirement drains work and releases lease without clearing recovery', async () => {
  const f=fixture(),context=await admitDesktopFixtureClient(f.service,f.options);
  const gate=deferred();f.readGate=gate;
  const read=context.durableWrites.readText('note.md');
  const retiring=context.retire();
  assert.ok(f.active);
  await assert.rejects(context.durableWrites.readText('note.md'),{code:'client_not_admitted'});
  gate.resolve();await read;await retiring;
  assert.equal(f.active,null);
  assert.equal(f.calls.includes('checkpoint_cas'),false);
  assert.equal(f.calls.includes('acknowledge_intent'),false);
});

test('binary admission drains one bounded call before release and rejects overlapping chunk copies',async()=>{
  const f=fixture();f.host.capabilities=['binary_streams'];
  const context=await admitDesktopFixtureClient(f.service,f.options);
  const gate=deferred();f.readGate=gate;const pending=context.binaryCommand(new Uint8Array([8,1]));
  await assert.rejects(context.binaryCommand(new Uint8Array([8,1])),{code:'binary_busy'});
  const closing=context.release(()=>{});await assert.rejects(context.binaryCommand(new Uint8Array([8,1])),{code:'binary_busy'});
  gate.resolve();assert.deepEqual([...await pending],[8,1]);await closing;assert.equal(f.active,null);
  await assert.rejects(context.binaryCommand(new Uint8Array([8,1])),{code:'client_not_admitted'});
});

test('metadata advertisement comes only from frozen positive host capability before any pin opens',async()=>{
  for(const capabilities of [[],['documents'],['documents','document_metadata_rows']]){
    const f=fixture();f.host.capabilities=capabilities;const context=await admitDesktopFixtureClient(f.service,f.options);
    assert.equal(context.metadataRowsAvailable,capabilities.includes('document_metadata_rows')?true:undefined);
    assert.equal(typeof context.documentCommand,capabilities.includes('documents')?'function':'undefined');assert.equal(f.calls.includes('documents'),false);
    f.host.capabilities=[];assert.equal(context.metadataRowsAvailable,capabilities.includes('document_metadata_rows')?true:undefined,'admitted capability does not follow later mutable host fields');
    await context.release(()=>{});assert.equal(f.active,null);
  }
  const broken=fixture();broken.host.capabilities=['document_metadata_rows'];
  await assert.rejects(admitDesktopFixtureClient(broken.service,broken.options),{code:'unsupported_host_capability'});assert.equal(broken.active,null);
});


function enableDrafts(f){
  f.host.capabilities=['documents','document_runtime','document_drafts'];f.service.documentRuntimeEnabled=true;
  f.service.registerDocumentRuntimeOwner=()=>({observe(){},control(){},ackControl(){},ackOutcome(){},subscribe(){return()=>{};},async pause(){},resume(){},async prepareRelease(){},release(){},async revoke(){}});
}

test('draft capability is positive before open and incomplete trusted scheduling fails closed',async()=>{
  const legacy=fixture();legacy.host.capabilities=['documents','document_drafts'];const context=await admitDesktopFixtureClient(legacy.service,legacy.options);assert.equal(context.draftsAvailable,undefined);assert.equal(context.documentDrafts,undefined);await context.release(async()=>{});
  const broken=fixture();enableDrafts(broken);broken.service.registerDocumentDraftOwner=undefined;
  await assert.rejects(admitDesktopFixtureClient(broken.service,broken.options),{code:'unsupported_host_capability'});assert.equal(broken.active,null);
  const partial=fixture();enableDrafts(partial);partial.service.registerDocumentDraftOwner=()=>({notify(){},subscribe(){return()=>{};},revoke(){},release(){}});
  partial.service.registerDocumentRuntimeOwner=()=>({observe(){}});partial.service.releaseDocumentDraftClient=reference=>partial.host.releaseClient(reference);
  await assert.rejects(admitDesktopFixtureClient(partial.service,partial.options),{code:'unsupported_host_capability'});assert.equal(partial.active,null);assert.equal(partial.calls.filter(op=>op==='release_client').length,1);

});
test('draft retire drains late requests and retains exact native lease until trusted release resolves',async()=>{
  const f=fixture(),events=[],releaseGate=deferred();let onRetire=()=>{};
  enableDrafts(f);
  f.service.registerDocumentDraftOwner=()=>({notify(){events.push('notify');},subscribe(_listener,retired){onRetire=retired;return()=>{};},revoke(){events.push('revoke');onRetire();},release(){events.push('drop-handle');}});
  f.service.releaseDocumentDraftClient=async reference=>{events.push('trusted-release');assert.equal(reference.client_id,clientId);assert.ok(f.active);await releaseGate.promise;return f.host.releaseClient(reference);};
  const context=await admitDesktopFixtureClient(f.service,f.options);assert.equal(context.draftsAvailable,true);context.documentDrafts.subscribe(()=>{},()=>events.push('retired'));
  const readGate=deferred();f.readGate=readGate;const request=context.documentDrafts.invoke({op:'snapshot'}),late=assert.rejects(request,{code:'client_not_admitted'});
  const closing=context.retire();readGate.resolve();await late;await new Promise(resolve=>setImmediate(resolve));assert.ok(f.active);assert.equal(events.includes('drop-handle'),false);assert.equal(events.includes('notify'),false);
  await assert.rejects(context.documentDrafts.invoke({op:'snapshot'}),{code:'client_not_admitted'});
  releaseGate.resolve();await closing;assert.equal(f.active,null);assert.ok(events.indexOf('revoke')<events.indexOf('trusted-release'));assert.equal(events.at(-1),'drop-handle');
});
test('draft successful flush retires readers before the internal release drain without repeating flush',async()=>{
  const f=fixture(),events=[],releaseGate=deferred();enableDrafts(f);
  f.service.registerDocumentDraftOwner=()=>({notify(){},subscribe(){return()=>{};},revoke(){events.push('revoke');},release(){events.push('drop-handle');}});
  f.service.releaseDocumentDraftClient=async reference=>{events.push('trusted-release');await releaseGate.promise;return f.host.releaseClient(reference);};
  const context=await admitDesktopFixtureClient(f.service,f.options),closing=context.release(async()=>{events.push('flush');});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['flush','revoke','trusted-release']);assert.ok(f.active);await assert.rejects(context.documentDrafts.invoke({op:'snapshot'}),{code:'client_not_admitted'});releaseGate.resolve();await closing;assert.equal(f.active,null);assert.equal(events.at(-1),'drop-handle');
});

test('ordinary property target capability is frozen from native handshake before any query',async()=>{
  const f=fixture();f.host.capabilities=['documents','document_property_targets'];const context=await admitDesktopFixtureClient(f.service,f.options);
  assert.equal(context.propertyTargetsAvailable,true);assert.equal(typeof context.documentCommand,'function');f.host.capabilities=[];assert.equal(context.propertyTargetsAvailable,true);await context.release(()=>{});
  const broken=fixture();broken.host.capabilities=['document_property_targets'];await assert.rejects(admitDesktopFixtureClient(broken.service,broken.options),{code:'unsupported_host_capability'});
});
