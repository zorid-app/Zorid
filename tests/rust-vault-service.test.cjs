'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { RustVaultService, reconciliationStatus, MAX_BINARY_FRAME } = require('../desktop/rust-vault-service.cjs');

// Actual subprocess tests of the JS transport. This intentionally tiny fake host
// tests framing/lifecycle only; Rust process.rs separately executes NativeVault.
async function fixture(t, mode = 'normal', options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'zorid-host-transport-'));
  const executable = path.join(root, 'host');
  const source = `#!${process.execPath}
const mode = ${JSON.stringify(mode)};
function send(header, body = Buffer.alloc(0)) {
 const bytes = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(8);
 prefix.writeUInt32BE(bytes.length,0); prefix.writeUInt32BE(body.length,4);
 // Split prefix and frame boundaries to exercise incremental parsing.
 process.stdout.write(prefix.subarray(0,3)); process.stdout.write(prefix.subarray(3)); process.stdout.write(bytes); process.stdout.write(body);
}
const reconciliation=mode.startsWith('reconciliation_')?{scanId:'scan',complete:false,scanComplete:false,finished:true,observed:12,imported:0,namespaceApplied:0,issueCount:1,issuesTruncated:false,issues:[{path:null,code:'scan_limit'}]}:null;
if(mode==='reconciliation_bad_path')reconciliation.issues[0].path='/private/secret';
send({version:1,request_id:'0',ok:true,result:{reconciliation,transport:'zorid-native-stdio',max_header:1048576,max_body:16777216,capabilities:reconciliation?['reconciliation_status']:[]}});
let buffer=Buffer.alloc(0);
process.stdin.on('data', chunk => {buffer=Buffer.concat([buffer,chunk]); while(buffer.length>=8){
 const h=buffer.readUInt32BE(0),b=buffer.readUInt32BE(4); if(buffer.length<8+h+b)return;
 const req=JSON.parse(buffer.subarray(8,8+h)), body=Buffer.from(buffer.subarray(8+h,8+h+b)); buffer=buffer.subarray(8+h+b);
 if(mode==='exit'){process.exit(1);return;}
 if(mode==='stall')continue;
 if(mode==='oversized'){process.stdout.write(Buffer.alloc(8,255));continue;}
 if(mode==='reject'){send({version:1,request_id:req.request_id,ok:false,error:{code:'revision_conflict',commit_uncertain:false}});continue;}
 if((mode==='document_rejection'||mode==='document_bad_rejection')&&req.command.method==='documents'){send({version:1,request_id:req.request_id,ok:false,error:{code:mode==='document_rejection'?'stale_source':'stale-source',commit_uncertain:false}});continue;}
 let responseBody = Buffer.alloc(0);
 let result = req.command.method==='apply' ? {commit:{operation_id:req.command.operation_id,sequence:'1',changes:[{before:null,after:{id:req.command.mutation.id,path:req.command.mutation.path,kind:'file',revision:'new',deleted:false}}]},projection:{state:'pending'},captured:[...body]} : {pending_outbox:'0',pending_projection:'0',attempts:[],observations:[],command:req.command};
 if(mode.startsWith('family_journal_') && req.command.method==='changes_after') {
  const origin=mode==='family_journal_remote'?{kind:'received_update',realm_id:'realm',vault_id:'vault',update_id:'update'}:{kind:'local_command',operation_id:'operation'};
  result={changes:[{cursor:'1',origin,requires_full_reload:true,entries:[]}],next_cursor:'1',head_cursor:'1',has_more:false};
  if(mode==='family_journal_bad_entries')result.changes[0].requires_full_reload=false;
  if(mode==='family_journal_bad_origin')result.changes[0].origin={kind:'received_update'};
 }
 if(req.command.method==='checkpoint_cas') {
  responseBody=body;
  result={checkpoint:{version:1,...req.command.scope,key:req.command.key,revision:req.command.next_revision,sequence:'1',deleted:!req.command.has_state,byteLength:body.length}};
  if(mode==='checkpoint_wrong_state')responseBody=Buffer.from('other');
  if(mode==='checkpoint_bad_metadata')result.checkpoint.revision='00000000-0000-0000-0000-000000000099';
  if(mode==='checkpoint_missing')result.checkpoint=null;
 }
 if(mode.startsWith('checkpoint_page_')) {
  const item={version:1,...req.command.scope,key:'entry',revision:'00000000-0000-0000-0000-000000000001',sequence:'1',deleted:false,byteLength:1};
  result={items:[item,{...item,key:'other',sequence:'2'}],cursor:null,highWater:'3'};
  if(mode==='checkpoint_page_duplicate')result.items[1].sequence='1';
  if(mode==='checkpoint_page_unordered')result.items.reverse();
  if(mode==='checkpoint_page_deleted'){result.items[0].deleted=true;result.items[0].byteLength=0;}
  if(mode==='checkpoint_page_key')result.items[1].key='entry';
  if(mode==='checkpoint_page_empty'){result.items=[];result.cursor='next';}
 }
 if(mode.startsWith('intent_')) {
  result={intent:{token:'token',client_id:'client',operation_id:'operation',entry_id:'file',mutation_kind:'write',order:'1',state:'committed',acknowledged:false,error:null,projection:{state:'pending'},receipt:{operation_id:'operation',sequence:'1',changes:[{before:null,after:{id:'file',path:'file.md',kind:'file',revision:'new',deleted:false}}]}}};
  if(mode==='intent_wrong_token')result.intent.token='other';
  if(mode==='intent_wrong_receipt')result.intent.receipt.operation_id='other';
  if(mode==='intent_nonterminal') {result.intent.state='commit_requested';result.intent.receipt=null;result.intent.projection=null;}
  if(mode==='intent_bad_ack')result.intent.acknowledged=true;
 }
 if(mode.startsWith('family_') && !mode.startsWith('family_journal_')) {
  const scope={realm_id:'realm',vault_id:'vault'};
  const family={scope,cursor:null,limits:{max_file_bytes:16777216,max_graph_encoded_bytes:134217728,max_records:4096},graph_records:0,graph_encoded_bytes:2,pending_authored:'0',pending_dependencies:'0',pending_projection:'0',recovery_entries:'0'};
  const status={scope:'fixture_families_v2',family_sync_supported:true,all_file_sync_supported:false,synced:false,family,pending_envelope_sample:0,pending_envelope_sample_complete:true,pending_envelopes:[],unsupported_capabilities:['larger_file_streaming','production_enrollment']};
  if(req.command.method==='fixture_family_enroll')result={family};
  else if(req.command.method==='fixture_family_apply') {
   const command=req.command.family.request;
   result={commit:{operation_id:command.operation_id,sequence:'1',changes:[{before:null,after:{id:command.mutation.id,path:command.mutation.path,kind:'file',revision:'new',deleted:false}}]},projection:{state:'pending'},captured:[...body],mode:req.command.family.create_mode};
  } else if(req.command.method==='fixture_family_once')result={sync:{...status,server_accepted:0,locally_received:0,locally_applied_updates:0,duplicate_receipts:0,dependency_pending_receipts:0,receive_projection_pending:0,pull_snapshot_complete:req.command.max_pages>0,pull_through:req.command.max_pages>0?'0':null}};
  else result={sync:status,args:process.argv.slice(2)};
  if(mode==='family_wrong_receipt')result.commit.operation_id='other';
  if(mode==='family_missing_recovery')delete result.sync.family.recovery_entries;
  if(mode==='family_bad_recovery')result.sync.family.recovery_entries='01';
  if(mode==='family_false_synced')result.sync.synced=true;
  if(mode==='family_bad_cursor')result.sync.family.cursor={...scope,vault_id:'other',server_epoch:'epoch',after:'1'};
  if(mode==='family_bad_counts')result.sync.server_accepted=req.command.max_push+1;
  if(mode==='family_bad_pending'){result.sync.pending_envelopes=[{scope,update_id:'update',family:'text',sealed:true,accepted:true}];result.sync.pending_envelope_sample=1;}
 }
 if(req.command.method==='binary') {
  if(mode==='binary_oversized'){const prefix=Buffer.alloc(8);prefix.writeUInt32BE(2,0);prefix.writeUInt32BE(147457,4);process.stdout.write(prefix);continue;}
  result={binary:true};responseBody=body;
 }
 if(mode==='missing')result=undefined;
 if(mode==='wrong_receipt')result.commit.operation_id='wrong';
 setTimeout(()=>send({version:1,request_id:req.request_id,ok:true,result},responseBody),15);
 }});
process.stdin.on('end',()=>process.exit(0));
`;
  await fs.writeFile(executable, source, { mode: 0o700 });
  let host;
  t.after(async () => { if (host) await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  host = await RustVaultService.open(root, { executable, timeoutMs: 1000, ...options });
  return host;
}

test('frames copy binary and command before queueing; pending projection is success', async t => {
  const host = await fixture(t);
  const bytes = new Uint8Array([0, 255, 128, 10]);
  const command = { method: 'apply', operation_id: 'original', mutation: {type:'create',id:'file',path:'file.md',kind:'file'} };
  const pending = host.request(command, bytes);
  bytes.fill(7); command.operation_id = 'changed';
  const reply = await pending;
  assert.deepEqual(reply.result.captured, [0, 255, 128, 10]);
  assert.equal(reply.result.commit.operation_id, 'original');
  assert.equal(reply.result.projection.state, 'pending');
  await host.close(); assert.equal(host.exited, true);
});

test('close drains accepted operations, rejects new calls and reaches child exit', async t => {
  const host = await fixture(t);
  const a = host.request({ method: 'status', marker: 'first' }); const b = host.request({ method: 'status', marker: 'second' });
  const closed = host.close();
  await assert.rejects(host.status(), { code: 'host_closed' });
  assert.equal((await a).result.command.marker, 'first');
  assert.equal((await b).result.command.marker, 'second');
  await closed; assert.equal(host.exited, true);
});

test('bounded admission rejects excess requests without killing accepted work', async t => {
  const host = await fixture(t);
  const pending = Array.from({length:32}, () => host.status());
  await assert.rejects(host.status(), {code:'request_limit'});
  await Promise.all(pending);
});

test('request errors preserve a usable transport and stable code', async t => {
  const host = await fixture(t, 'reject');
  await assert.rejects(host.status(), { code: 'revision_conflict', commitUncertain: false });
  await assert.rejects(host.status(), { code: 'revision_conflict', commitUncertain: false });
});

for (const mode of ['exit', 'stall', 'oversized']) {
  test('transport ' + mode + ' rejects every accepted request with uncertain acknowledgement', async t => {
    const host = await fixture(t, mode);
    const results = await Promise.allSettled([host.status(), host.status()]);
    for(const result of results){ assert.equal(result.status,'rejected'); assert.equal(result.reason.commitUncertain,true); }
    await host.close(); assert.equal(host.exited,true);
  });
}

for (const mode of ['missing', 'wrong_receipt']) {
  test('malformed successful mutation reply ' + mode + ' cannot clear a durable intent', async t => {
    const host = await fixture(t, mode);
    await assert.rejects(host.apply('original', { type: 'create', id: 'file', path: 'file.md', kind: 'file' }, new Uint8Array([1])),
      { code: 'invalid_response', commitUncertain: true });
    await host.close(); assert.equal(host.exited, true);
  });
}

for (const mode of ['intent_wrong_token', 'intent_wrong_receipt', 'intent_nonterminal']) {
  test('malformed intent commit ' + mode + ' retains uncertain consumer recovery', async t => {
    const host = await fixture(t, mode);
    await assert.rejects(host.commitIntent({ client_id: 'client', token: 'token' }), { code: 'invalid_response', commitUncertain: true });
  });
}
test('mismatched intent acknowledgment receipt cannot release recovery', async t => {
  const host = await fixture(t, 'intent_bad_ack');
  await assert.rejects(host.acknowledgeIntent({ client_id: 'client', token: 'token' },
    { state: 'committed', operation_id: 'operation', sequence: '2' }), { code: 'invalid_response', commitUncertain: true });
});

test('durable intent commit with pending publication remains a committed receipt', async t => {
  const host = await fixture(t, 'intent_valid');
  const result = await host.commitIntent({ client_id: 'client', token: 'token' });
  assert.equal(result.state, 'committed');
  assert.equal(result.receipt.operation_id, 'operation');
  assert.equal(result.projection.state, 'pending');
  assert.equal(result.acknowledged, false);
});


test('checkpoint response restores exact raw UTF8 state without JSON header expansion', async t => {
  const host = await fixture(t, 'checkpoint_normal');
  const state = '\ufeffdraft \ud83d\ude80\n';
  const result = await host.checkpointCompareAndSwap({ vaultId: 'authority', clientId: 'client' },
    { key: 'entry', expectedRevision: null, nextRevision: '00000000-0000-0000-0000-000000000001', encodedState: state });
  assert.equal(result.encodedState, state);
  assert.equal(result.byteLength, Buffer.byteLength(state));
});
for (const mode of ['checkpoint_wrong_state', 'checkpoint_bad_metadata', 'checkpoint_missing']) {
  test('malformed checkpoint CAS ' + mode + ' cannot authorize the next save step', async t => {
    const host = await fixture(t, mode);
    await assert.rejects(host.checkpointCompareAndSwap({ vaultId: 'authority', clientId: 'client' },
      { key: 'entry', expectedRevision: null, nextRevision: '00000000-0000-0000-0000-000000000001', encodedState: 'draft' }),
      { code: 'invalid_response', commitUncertain: true });
  });
}


for (const mode of ['checkpoint_page_duplicate', 'checkpoint_page_unordered', 'checkpoint_page_deleted', 'checkpoint_page_key', 'checkpoint_page_empty', 'checkpoint_page_after']) {
  test('malformed checkpoint metadata ' + mode + ' cannot advance recovery', async t => {
    const host = await fixture(t, mode);
    const scope = { vaultId: 'authority', clientId: 'client' };
    const result = mode === 'checkpoint_page_after'
      ? host.checkpointChanges(scope, { after: '2', limit: 100 }) : host.checkpointList(scope, { limit: 100 });
    await assert.rejects(result, { code: 'invalid_response', commitUncertain: true });
  });
}


test('family command captures explicit mode and exact bytes; pending projection remains durable success', async t => {
  const host=await fixture(t,'family_valid');
  const command={version:1,request:{operation_id:'family-create',mutation:{type:'create',id:'file',path:'drawing.data',kind:'file'}},create_mode:'binary'};
  const bytes=Buffer.from([0,255,128]);
  const pending=host.fixtureFamilyApply(command,bytes);
  command.create_mode='text';command.request.operation_id='different';bytes.fill(42);
  const result=await pending;
  assert.equal(result.commit.operation_id,'family-create');assert.equal(result.mode,'binary');
  assert.deepEqual(result.captured,[0,255,128]);assert.equal(result.projection.state,'pending');
});

test('family create mode is required and non-create commands require explicit null', async t => {
  const host=await fixture(t,'family_valid');
  const create={version:1,request:{operation_id:'op',mutation:{type:'create',id:'file',path:'a',kind:'file'}}};
  await assert.rejects(host.fixtureFamilyApply(create),{code:'invalid_family_command'});
  await assert.rejects(host.fixtureFamilyApply({...create,create_mode:null}),{code:'invalid_family_command'});
  await assert.rejects(host.fixtureFamilyApply({version:1,request:{operation_id:'op',mutation:{type:'write',id:'file',expected:'rev'}},create_mode:'text'}),{code:'invalid_family_command'});
  assert.equal(host.queuedCount,0,'invalid commands never enter transport queue');
  assert.equal((await host.fixtureFamilyStatus()).scope,'fixture_families_v2');
});

test('family fixture config is a startup-only path, and sweep limits fail before dispatch', async t => {
  const config=path.join(tmpdir(),'trusted fixture config.json');
  const host=await fixture(t,'family_valid',{fixtureSyncConfig:config});
  const reply=await host.request({method:'fixture_family_status'});
  assert.deepEqual(reply.result.args,['--vault',host.root,'--fixture-sync-config',config]);
  await assert.rejects(host.fixtureFamilyOnce({maxPush:1001}),{code:'request_limit'});
  await assert.rejects(host.fixtureFamilyOnce({maxPages:-1}),{code:'request_limit'});
  const result=await host.fixtureFamilyOnce({maxPush:0,maxPages:0});
  assert.equal(result.pull_through,null);assert.equal(result.synced,false);
});

for(const mode of ['family_missing_recovery','family_bad_recovery','family_wrong_receipt','family_false_synced','family_bad_cursor','family_bad_counts','family_bad_pending']) {
  test('malformed family response '+mode+' preserves uncertain caller intent',async t=>{
    const host=await fixture(t,mode);
    const promise=mode==='family_wrong_receipt'
      ?host.fixtureFamilyApply({version:1,request:{operation_id:'op',mutation:{type:'create',id:'file',path:'a',kind:'file'}},create_mode:'text'},Buffer.from('text'))
      :mode==='family_bad_counts'?host.fixtureFamilyOnce({maxPush:0,maxPages:0}):host.fixtureFamilyStatus();
    await assert.rejects(promise,{code:'invalid_response',commitUncertain:true});
  });
}

// Regression from the actual enrolled-vault Electron save: native family
// materialization emits full-reload events for both local and remote origins.
test('family journal full reload accepts local and received events without poisoning later RPCs', async t => {
  for (const mode of ['family_journal_local', 'family_journal_remote']) {
    const host = await fixture(t, mode);
    const page = await host.changesAfter('0', 100);
    assert.equal(page.changes[0].requires_full_reload, true);
    assert.deepEqual(page.changes[0].entries, []);
    assert.equal((await host.status()).pending_outbox, '0');
  }
});
test('family journal still rejects empty incremental events and malformed origins', async t => {
  for (const mode of ['family_journal_bad_entries', 'family_journal_bad_origin']) {
    const host = await fixture(t, mode);
    await assert.rejects(host.changesAfter('0', 100), { code:'invalid_response', commitUncertain:true });
  }
});

test('incomplete startup is a validated live host and legacy startup cannot silently omit required diagnostics',async t=>{
  const host=await fixture(t,'reconciliation_incomplete',{initializeLocal:true});
  assert.equal(host.reconciliation.complete,false);assert.equal(host.reconciliation.issues[0].code,'scan_limit');
  assert.equal((await host.status()).pending_outbox,'0');
  await assert.rejects(fixture(t,'normal',{initializeLocal:true}),{code:'invalid_handshake'});
  await assert.rejects(fixture(t,'reconciliation_bad_path',{initializeLocal:true}),{code:'invalid_handshake'});
});
test('reconciliation diagnostics reject false completeness, unbounded issues and unsafe paths',()=>{
  const status={scanId:'scan',complete:false,scanComplete:true,finished:true,observed:2,imported:1,namespaceApplied:0,issueCount:1,issuesTruncated:false,issues:[{path:'folder/note.md',code:'recovery_retained'}]};
  assert.equal(reconciliationStatus(status),true);
  assert.equal(reconciliationStatus({...status,complete:true}),false);
  assert.equal(reconciliationStatus({...status,issues:Array(33).fill(status.issues[0]),issueCount:33}),false);
  for(const path of ['/private/secret','../secret','C:/secret','.zorid/private','x\\secret','line\nsecret'])assert.equal(reconciliationStatus({...status,issues:[{path,code:'reconciliation_blocked'}]}),false,path);
  assert.equal(reconciliationStatus({...status,issuesTruncated:true}),false);
  assert.equal(reconciliationStatus({...status,details:'/private/secret'}),false);
  assert.equal(reconciliationStatus({...status,issues:[{...status.issues[0],reason:'/private/secret'}]}),false);
});

// The fake host echoes opaque protobuf bytes; semantic protobuf/native checks
// belong to the Rust/renderer adapters, not a second main-process DTO codec.
test('binary protobuf frames preserve bytes/lease and reject oversized requests before queueing',async t=>{
  const host=await fixture(t),lease={local_store_id:'local',client_id:'client',token:'token'};let checked=0;
  const admitted=host.withClientLease(lease,()=>{checked++;});
  const bytes=new Uint8Array([8,1,82,0]),pending=admitted.binaryCommand('client',bytes);bytes.fill(9);
  assert.deepEqual([...await pending],[8,1,82,0]);assert.ok(checked>=2);
  await assert.rejects(admitted.binaryCommand('client',new Uint8Array(MAX_BINARY_FRAME+1)),{code:'request_limit'});
  assert.equal(host.queuedCount,0);
});
test('oversized binary response is rejected before frame allocation and retains uncertain outcome',async t=>{
  const host=await fixture(t,'binary_oversized');
  await assert.rejects(host.binaryCommand('client',new Uint8Array([8,1])),{code:'invalid_response',commitUncertain:true});
});


test('document query rejection preserves strict frames and does not poison the next request',async t=>{
  const host=await fixture(t,'document_rejection');
  await assert.rejects(host.documentCommand('client',{schemaVersion:1,command:{op:'base',pinId:'1',id:'base',options:{currentEntryId:'missing-current',clockMs:0}}}),{code:'stale_source',commitUncertain:false});
  assert.equal(host.fatal,null);await host.status();assert.equal(host.fatal,null);
});
test('hyphenated document frame errors still fail strict transport validation',async t=>{
  const host=await fixture(t,'document_bad_rejection');
  await assert.rejects(host.documentCommand('client',{schemaVersion:1,command:{op:'base',pinId:'1',id:'base',options:{currentEntryId:'missing-current',clockMs:0}}}),{code:'invalid_response',commitUncertain:true});
});
