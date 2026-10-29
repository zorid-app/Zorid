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
send({version:1,request_id:'0',ok:true,result:{reconciliation,transport:'zorid-native-stdio',max_header:1048576,max_body:16777216,capabilities:reconciliation?['reconciliation_status']:mode.startsWith('history_')?['local_recovery_maintenance']:mode.startsWith('stat_')&&mode!=='stat_legacy'?['stat_path']:[]}});
let buffer=Buffer.alloc(0),counts={};
process.stdin.on('data', chunk => {buffer=Buffer.concat([buffer,chunk]); while(buffer.length>=8){
 const h=buffer.readUInt32BE(0),b=buffer.readUInt32BE(4); if(buffer.length<8+h+b)return;
 const req=JSON.parse(buffer.subarray(8,8+h)), body=Buffer.from(buffer.subarray(8+h,8+h+b)); buffer=buffer.subarray(8+h+b);
 counts[req.command.method]=(counts[req.command.method]||0)+1;if(req.lease&&req.command.method==='stat_path')counts.leasedStat=(counts.leasedStat||0)+1;
 if(mode.startsWith('history_')&&req.command.method==='local_recovery_maintenance'){
  if(mode==='history_reject'){send({version:1,request_id:req.request_id,ok:false,error:{code:'local_recovery_unavailable',commit_uncertain:false}});continue;}
  const result={available:true,ran:true,pending:false,failed_notes:0,retry_after_ms:300000};let bytes=Buffer.alloc(0);
  if(mode==='history_extra')result.path='/private/secret';
  if(mode==='history_bad_count')result.failed_notes=2;
  if(mode==='history_bad_wait')result.retry_after_ms=0;
  if(mode==='history_bad_boolean')result.pending='false';
  if(mode==='history_bad_disabled')result.available=false;
  if(mode==='history_body')bytes=Buffer.from('unexpected');
  send({version:1,request_id:req.request_id,ok:true,result},bytes);continue;
 }
 if(mode==='exit'){process.exit(1);return;}
 if(mode==='stall')continue;
 if(mode==='oversized'){process.stdout.write(Buffer.alloc(8,255));continue;}
 if(mode.startsWith('rich_diagnostic')){
  const diagnostic={code:'unsupported-regex',queryRange:{bytes:[0,3],utf16:[0,3]},message:'Unsupported regular expression.'};
  if(mode==='rich_diagnostic_bad')diagnostic.queryRange.bytes=[0,4097];
  if(mode==='rich_diagnostic_extra')diagnostic.internal='/private/secret';
  send({version:1,request_id:req.request_id,ok:false,error:{code:'search_compile',commit_uncertain:false,details:{diagnostic},message:'/private/raw recovery'}});continue;
 }
 if(mode==='draft_oversized_header'||mode==='draft_oversized_body'){
  const prefix=Buffer.alloc(8);prefix.writeUInt32BE(mode==='draft_oversized_header'?65537:2,0);prefix.writeUInt32BE(mode==='draft_oversized_body'?131073:0,4);process.stdout.write(prefix);continue;
 }
 if(mode==='draft_normal'){
  let result={state:null,transfer:null,transfer_scratch_bytes:0},replyBody=Buffer.alloc(0);
  if(req.command.method==='document_work')result={work:null,turn:null};
  else if(req.command.request.op==='facts_read'){
   replyBody=Buffer.alloc(req.command.request.maximum,0xa9);result={job:req.command.request.job,offset:req.command.request.offset,bytes:replyBody.length,total_bytes:replyBody.length,eof:true};
  }else if(req.command.request.op==='upload_chunk'){
   result={state:{admitted:null,replay:false,execution:'wait_for_input',outcomes:[],usage:{source_bytes:0,scratch_bytes:0,facts_bytes:0}},transfer:{source_bytes_received:131072,source_bytes_expected:131072,source_sealed:false,facts_bytes:null,scratch_bytes:131072},transfer_scratch_bytes:131072};
   if(body.length!==131072||body[0]!==7){send({version:1,request_id:req.request_id,ok:false,error:{code:'draft_invalid_chunk',commit_uncertain:false}});continue;}
  }
  send({version:1,request_id:req.request_id,ok:true,result},replyBody);continue;
 }
 if(mode==='rich_oversized'){const prefix=Buffer.alloc(8);prefix.writeUInt32BE(2,0);prefix.writeUInt32BE(2097153,4);process.stdout.write(prefix);continue;}
 if(mode==='reject'){send({version:1,request_id:req.request_id,ok:false,error:{code:'revision_conflict',commit_uncertain:false}});continue;}
 if((mode==='document_rejection'||mode==='document_bad_rejection')&&req.command.method==='documents'){send({version:1,request_id:req.request_id,ok:false,error:{code:mode==='document_rejection'?'stale_source':'stale-source',commit_uncertain:false}});continue;}
 let responseBody = Buffer.alloc(0);
 let result = req.command.method==='apply' ? {commit:{operation_id:req.command.operation_id,sequence:'1',changes:[{before:null,after:{id:req.command.mutation.id,path:req.command.mutation.path,kind:'file',revision:'new',deleted:false}}]},projection:{state:'pending'},captured:[...body]} : {pending_outbox:'0',pending_projection:'0',attempts:[],observations:[],command:req.command,counts};
 if(mode.startsWith('stat_')&&['stat_path','list_snapshot','read_path'].includes(req.command.method)) {
  const kind=mode==='stat_folder'||mode==='stat_bad_folder_size'?'folder':'file';
  const state={id:'entry',revision:'revision',path:req.command.path||'Note.bin',kind,deleted:false};
  const presentation={id:'entry',ctime_ms:1,mtime_ms:2,size_bytes:kind==='folder'?0:mode==='stat_large'?20971520:4};
  if(req.command.method==='list_snapshot')result={cursor:'0',entries:mode==='stat_missing'?[]:[{state,presentation}]};
  else if(req.command.method==='read_path') {
   responseBody=Buffer.from('base');result={entry:state,presentation,has_content:true};
   if(mode==='stat_read_changed_id'){result.entry.id='replacement';result.presentation.id='replacement';}
   if(mode==='stat_read_changed_revision')result.entry.revision='new-revision';
  } else {
   if(mode==='stat_reject'){send({version:1,request_id:req.request_id,ok:false,error:{code:'not_found',commit_uncertain:false}});continue;}
   result=mode==='stat_missing'||mode==='stat_bad_null_extra'?{entry:null}:{entry:state,presentation,has_content:kind==='file'};
   if(mode==='stat_bad_body')responseBody=Buffer.from([1]);
   if(mode==='stat_bad_null_extra')result.presentation=presentation;
   if(mode==='stat_bad_path')result.entry.path='Other.bin';
   if(mode==='stat_bad_deleted')result.entry.deleted=true;
   if(mode==='stat_bad_kind')result.entry.kind='other';
   if(mode==='stat_bad_size')result.presentation.size_bytes=-1;
   if(mode==='stat_bad_folder_size')result.presentation.size_bytes=4;
   if(mode==='stat_bad_presentation')result.presentation.id='other';
   if(mode==='stat_bad_has_content')result.has_content=false;
   if(mode==='stat_bad_extra')result.extra=true;
   if(mode==='stat_bad_missing')delete result.has_content;
  }
 }
 if(mode.startsWith('family_journal_') && req.command.method==='changes_after') {
  const origin=mode==='family_journal_remote'?{kind:'received_update',realm_id:'realm',vault_id:'vault',update_id:'update'}:{kind:'local_command',operation_id:'operation'};
  result={changes:[{cursor:'1',origin,requires_full_reload:true,entries:[]}],next_cursor:'1',head_cursor:'1',has_more:false};
  if(mode==='family_journal_bad_entries')result.changes[0].requires_full_reload=false;
  if(mode==='family_journal_bad_origin')result.changes[0].origin={kind:'received_update'};
  if(mode.startsWith('family_journal_external_')){
   result.changes[0].origin={kind:'external_observation',observation_id:'bb3fd199-c11e-4348-ba95-cb62c9c0dddd'};
   const origin=result.changes[0].origin;
   if(mode==='family_journal_external_missing')delete origin.observation_id;
   if(mode==='family_journal_external_empty')origin.observation_id='';
   if(mode==='family_journal_external_number')origin.observation_id=7;
   if(mode==='family_journal_external_null')origin.observation_id=null;
   if(mode==='family_journal_external_spaces')origin.observation_id='invalid observation';
   if(mode==='family_journal_external_control')origin.observation_id='invalid'+String.fromCharCode(0)+'observation';
   if(mode==='family_journal_external_long')origin.observation_id='x'.repeat(129);
   if(mode==='family_journal_external_extra')origin.extra=true;
   if(mode==='family_journal_external_wrong_field'){delete origin.observation_id;origin.operation_id='wrong-field';}
   if(mode==='family_journal_external_unknown')origin.kind='external_reconciliation';
   if(mode==='family_journal_external_deltas'){
    const state={id:'stable-entry',revision:'rename-revision',path:'Renamed.md',kind:'file',deleted:false};
    const presentation={id:state.id,ctime_ms:1,mtime_ms:2,size_bytes:4};
    const cursor=req.command.cursor;
    result=cursor==='0'?{changes:[{cursor:'1',origin:{kind:'external_observation',observation_id:'rename-observation'},requires_full_reload:false,entries:[{state,presentation}]}],next_cursor:'1',head_cursor:'2',has_more:true}
     :cursor==='1'?{changes:[{cursor:'2',origin:{kind:'external_observation',observation_id:'delete-observation'},requires_full_reload:false,entries:[{state:{...state,revision:'delete-revision',deleted:true},presentation:{...presentation,mtime_ms:3}}]}],next_cursor:'2',head_cursor:'2',has_more:false}
     :{changes:[],next_cursor:'2',head_cursor:'2',has_more:false};
   }
  }
 }
 if(mode.startsWith('history_') && req.command.method==='recovery_list')result={versions:[{snapshotId:'2',entryId:req.command.entry_id,path:'Note.md',capturedAtMs:100,byteLength:3}]};
 if(mode.startsWith('history_') && req.command.method==='recovery_read') {
  responseBody=mode==='history_utf8'?Buffer.from([255]):Buffer.from('old');
  result={version:{snapshotId:req.command.snapshot_id,entryId:mode==='history_wrong_entry'?'other':req.command.entry_id,path:'Note.md',capturedAtMs:100,byteLength:responseBody.length}};
  if(mode==='history_wrong_length')result.version.byteLength++;
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


test('history subprocess frames preserve selected versions and exact UTF-8 content',async t=>{
  const host=await fixture(t,'history_valid');
  const page=await host.recoveryList('note',{limit:20});assert.equal(page.versions[0].snapshotId,'2');
  assert.equal((await host.recoveryRead('note','2')).content,'old');
});
for(const mode of ['history_wrong_entry','history_wrong_length'])test('history malformed successful response '+mode+' cannot reach the preview',async t=>{
  const host=await fixture(t,mode);await assert.rejects(host.recoveryRead('note','2'),{code:'invalid_response'});
});
test('malformed UTF-8 history cannot be decoded or offered for restoration',async t=>{
  const host=await fixture(t,'history_utf8');await assert.rejects(host.recoveryRead('note','2'),/encoded data/i);assert.equal(host.fatal,null);
});


test('advertised metadata stat returns file, folder and missing observations without full snapshots or bodies',async t=>{
  for(const mode of ['stat_file','stat_folder','stat_missing']){
    const host=await fixture(t,mode),value=await host.readMetadata('Note.bin');
    if(mode==='stat_missing')assert.equal(value,null);
    else{
      assert.deepEqual(value,{entry:{id:'entry',revision:'revision',path:'Note.bin',kind:mode==='stat_folder'?'folder':'file',deleted:false},presentation:{id:'entry',ctime_ms:1,mtime_ms:2,size_bytes:mode==='stat_folder'?0:4},has_content:mode!=='stat_folder'});
      assert.equal(Object.hasOwn(value,'bytes'),false);
    }
    const {result}=await host.request({method:'status'});assert.equal(result.counts.stat_path,1);assert.equal(result.counts.list_snapshot,undefined);
  }
});
test('metadata stat capability survives an owned lease wrapper and preserves dispatch authorization',async t=>{
  const host=await fixture(t,'stat_file'),reference={local_store_id:'store',client_id:'client',token:'token'};let checks=0;
  const scoped=host.withClientLease(reference,()=>{checks++;});reference.token='mutated';
  assert.equal((await scoped.readMetadata('Note.bin')).entry.id,'entry');
  assert.equal(checks,2,'authorization is checked at call and actual dispatch');
  const {result}=await host.request({method:'status'});assert.equal(result.counts.stat_path,1);assert.equal(result.counts.leasedStat,1);assert.equal(result.counts.list_snapshot,undefined);
});
test('old host metadata falls back only when stat capability is absent',async t=>{
  const host=await fixture(t,'stat_legacy');
  assert.equal((await host.readMetadata('Note.bin')).presentation.size_bytes,4);
  const scoped=host.withClientLease({local_store_id:'store',client_id:'client',token:'token'});
  assert.equal((await scoped.readMetadata('Note.bin')).entry.id,'entry');
  const {result}=await host.request({method:'status'});assert.equal(result.counts.list_snapshot,2);assert.equal(result.counts.stat_path,undefined);
});
test('advertised stat failure propagates without list fallback and leaves transport usable',async t=>{
  const host=await fixture(t,'stat_reject');await assert.rejects(host.readMetadata('Note.bin'),{code:'not_found',commitUncertain:false});
  const {result}=await host.request({method:'status'});assert.equal(result.counts.stat_path,1);assert.equal(result.counts.list_snapshot,undefined);
});
for(const mode of ['stat_bad_body','stat_bad_null_extra','stat_bad_path','stat_bad_deleted','stat_bad_kind','stat_bad_size','stat_bad_folder_size','stat_bad_presentation','stat_bad_has_content','stat_bad_extra','stat_bad_missing']){
  test('malformed metadata stat '+mode+' rejects without a compatibility retry',async t=>{
    const host=await fixture(t,mode),methods=[],request=host.request.bind(host);host.request=(command,...args)=>{methods.push(command.method);return request(command,...args);};
    await assert.rejects(host.readMetadata('Note.bin'),{code:'invalid_response',commitUncertain:true});assert.deepEqual(methods,['stat_path']);
  });
}
test('metadata stat rejects a nonempty request body before transport dispatch',async t=>{
  const host=await fixture(t,'stat_file');await assert.rejects(host.request({method:'stat_path',path:'Note.bin'},Uint8Array.of(1)),{code:'invalid_request',commitUncertain:false});
  assert.equal(host.queuedCount,0);assert.equal((await host.request({method:'status'})).result.counts.stat_path,undefined);
});
test('targeted metadata preserves small-read allocation and body identity guards',async t=>{
  const {CoreVaultFixtureService}=require('../desktop/core-vault-fixture-service.cjs');
  for(const mode of ['stat_large','stat_read_changed_id','stat_read_changed_revision']){
    const host=await fixture(t,mode),service=new CoreVaultFixtureService(host,{pollMs:750,rescanMs:30000});
    await assert.rejects(service.readBinary('Note.bin'),{code:mode==='stat_large'?'stream_required':'revision_conflict'});
    const {result}=await host.request({method:'status'});assert.equal(result.counts.stat_path,1);assert.equal(result.counts.list_snapshot,undefined);assert.equal(result.counts.read_path,mode==='stat_large'?undefined:1);
  }
});


test('rich framed compile errors preserve only bounded typed diagnostic details',async t=>{
  const host=await fixture(t,'rich_diagnostic');
  const command={method:'documents',client_id:'client',request:{schemaVersion:1,command:{op:'rich_start',pinId:'1',spec:{query:'/(?=a)/',caseSensitive:false,sort:'nameAsc',context:'line',explain:false}}}};
  await assert.rejects(host.request(command),error=>{
    assert.equal(error.code,'search_compile');assert.equal(error.commitUncertain,false);
    assert.deepEqual(error.details,{diagnostic:{code:'unsupported-regex',queryRange:{bytes:[0,3],utf16:[0,3]},message:'Unsupported regular expression.'}});
    assert.equal(error.message.includes('/private'),false);return true;
  });
  for(const command of [{method:'status'},{method:'documents',request:{command:{op:'search'}}},{method:'apply'}]){
    await assert.rejects(host.request(command),error=>{assert.equal(error.code,'search_compile');assert.equal(Object.hasOwn(error,'details'),false);return true;});
  }
});
for(const mode of ['rich_diagnostic_bad','rich_diagnostic_extra'])test(`reject malformed framed rich diagnostic: ${mode}`,async t=>{
  const host=await fixture(t,mode);
  await assert.rejects(host.request({method:'documents',request:{command:{op:'rich_start'}}}),{code:'invalid_response'});
});


test('rich page frame rejects oversized declared body before reading or allocating it',async t=>{
  const host=await fixture(t,'rich_oversized');
  await assert.rejects(host.request({method:'documents',request:{command:{op:'rich_page'}}}),{code:'invalid_response'});
});

const stdioDraftJob={lifetime:'owner',id:'1',buffer_lifetime:'buffer',text_revision:'1'};
test('actual JS subprocess framing preserves draft raw chunks and keeps work out of leased transport',async t=>{
  const host=await fixture(t,'draft_normal'),reference={local_store_id:'store',client_id:'client',token:'token'},scoped=host.withClientLease(reference);
  assert.equal(scoped.documentWork,undefined);
  const bytes=new Uint8Array(131072).fill(7),pending=scoped.documentDrafts('client',{op:'upload_chunk',job:stdioDraftJob,offset:'0'},bytes);bytes.fill(9);assert.equal((await pending).result.transfer.source_bytes_received,131072);
  const read=await scoped.documentDrafts('client',{op:'facts_read',job:stdioDraftJob,offset:'0',maximum:131072});assert.equal(read.bytes.length,131072);assert.equal(read.bytes[0],0xa9);
  assert.deepEqual(await host.documentWork({op:'snapshot'}),{work:null,turn:null});
  await assert.rejects(host.request({method:'document_work',request:{op:'snapshot'}},new Uint8Array(),reference),{code:'draft_owner_mismatch'});
  await assert.rejects(host.request({method:'document_drafts',client_id:'client',request:{op:'upload_chunk',job:stdioDraftJob,offset:'0'}},new Uint8Array(131073)),{code:'request_limit'});
  await assert.rejects(host.request({method:'document_drafts',client_id:'client',request:{op:'snapshot',padding:'x'.repeat(65536)}}),{code:'request_limit'});
  await host.close();assert.equal(host.exited,true);
});
for(const mode of ['draft_oversized_header','draft_oversized_body'])test(`draft frame preallocation rejects ${mode} from prefix alone`,async t=>{
  const host=await fixture(t,mode);await assert.rejects(host.documentDrafts('client',{op:'facts_read',job:stdioDraftJob,offset:'0',maximum:131072}),{code:'invalid_response',commitUncertain:true});assert.ok(host.fatal);
});

test('saturated actual leased host queue rejects a draft chunk before any redundant raw snapshot',async()=>{
  const host=Object.create(RustVaultService.prototype);Object.assign(host,{sequence:0n,queuedCount:32,queuedBytes:0,tail:Promise.resolve()});
  let iterations=0;const original=new Uint8Array(131072),bytes=new Proxy(original,{get(target,key){if(key===Symbol.iterator){iterations++;return target[Symbol.iterator].bind(target);}return Reflect.get(target,key,target);}});
  const scoped=host.withClientLease({local_store_id:'store',client_id:'client',token:'token'});
  await assert.rejects(scoped.documentDrafts('client',{op:'upload_chunk',job:stdioDraftJob,offset:'0'},bytes),{code:'request_limit'});assert.equal(iterations,0);assert.equal(host.queuedCount,32);assert.equal(host.queuedBytes,0);
});


// The actual R5 external rename persisted local_changes cursor1007 with this
// documented Rust origin. Rejecting it poisoned every later command on the host.
test('external observation full reload from the native journal keeps the framed host alive',async t=>{
  const host=await fixture(t,'family_journal_external_full_reload',{timeoutMs:5000});
  const page=await host.changesAfter('0',100);
  assert.deepEqual(page.changes[0],{cursor:'1',origin:{kind:'external_observation',observation_id:'bb3fd199-c11e-4348-ba95-cb62c9c0dddd'},requires_full_reload:true,entries:[]});
  assert.equal((await host.status()).pending_outbox,'0');assert.equal(host.exited,false);
  await host.close();assert.equal(host.child.exitCode,0);assert.equal(host.child.signalCode,null);
});

test('external observation rename and tombstone pages preserve cursor and logical identity without aborting the framed host',async t=>{
  const host=await fixture(t,'family_journal_external_deltas',{timeoutMs:5000});
  const renamed=await host.changesAfter('0',100),removed=await host.changesAfter(renamed.next_cursor,100),settled=await host.changesAfter(removed.next_cursor,100);
  assert.equal(renamed.has_more,true);assert.equal(renamed.changes[0].entries[0].state.path,'Renamed.md');
  assert.equal(removed.changes[0].entries[0].state.id,renamed.changes[0].entries[0].state.id);assert.equal(removed.changes[0].entries[0].state.deleted,true);
  assert.equal(removed.next_cursor,'2');assert.equal(removed.has_more,false);assert.deepEqual(settled.changes,[]);
  assert.equal((await host.status()).pending_outbox,'0');assert.equal(host.exited,false);
  await host.close();assert.equal(host.child.exitCode,0);assert.equal(host.child.signalCode,null);
});

for(const shape of ['missing','empty','number','null','spaces','control','long','extra','wrong_field','unknown'])test(`external observation journal rejects malformed or unknown ${shape} origin`,async t=>{
  const host=await fixture(t,`family_journal_external_${shape}`,{timeoutMs:5000});
  await assert.rejects(host.changesAfter('0',100),{code:'invalid_response',commitUncertain:true});
  await assert.rejects(host.status(),{code:'invalid_response',commitUncertain:true});
});

test('cooperative reconciliation work is bounded typed progress, never an unknown extra payload',()=>{
  const status={scanId:'scan',complete:false,scanComplete:false,finished:false,observed:1,imported:1,namespaceApplied:0,issueCount:0,issuesTruncated:false,issues:[]};
  for(const phase of ['discovery','import','publication'])assert.equal(reconciliationStatus({...status,work:{phase,pending:true,workUnits:16}}),true);
  assert.equal(reconciliationStatus({...status,work:{phase:'blocked',pending:false,workUnits:0}}),true);
  assert.equal(reconciliationStatus({...status,complete:true,scanComplete:true,finished:true,work:{phase:'complete',pending:false,workUnits:1}}),true);
  for(const work of [{phase:'complete',pending:false,workUnits:1},{phase:'publication',pending:false,workUnits:1},{phase:'blocked',pending:true,workUnits:1},{phase:'discovery',pending:true,workUnits:257},{phase:'discovery',pending:true,workUnits:-1},{phase:'discovery',pending:true,workUnits:1.5},{phase:'unknown',pending:true,workUnits:1},{phase:'discovery',pending:true,workUnits:1,internal:'private'}])assert.equal(reconciliationStatus({...status,work}),false);
});


test('private history transport accepts only its strict bounded DTO without extending leased capabilities',async t=>{
 const host=await fixture(t,'history_good');host.activityClock=()=>1000;host.lastActivityAt=0;
 assert.deepEqual(await host.localRecoveryMaintenance(()=>{},250),{available:true,ran:true,pending:false,failed_notes:0,retry_after_ms:300000});
 const leased=host.withClientLease({local_store_id:'store',client_id:'client',token:'token'});
 assert.equal(leased.localRecoveryMaintenance,undefined);assert.equal(leased.capabilities.includes('local_recovery_maintenance'),false);
});
for(const mode of ['history_extra','history_bad_count','history_bad_wait','history_bad_boolean','history_bad_disabled','history_body'])test(`private history transport rejects malformed reply: ${mode}`,async t=>{
 const host=await fixture(t,mode);host.activityClock=()=>1000;host.lastActivityAt=0;
 await assert.rejects(host.localRecoveryMaintenance(()=>{},250),error=>error.code==='invalid_response');
});
test('a well-formed secondary history rejection keeps transport and ordinary reads healthy',async t=>{
 const host=await fixture(t,'history_reject');host.activityClock=()=>1000;host.lastActivityAt=0;
 await assert.rejects(host.localRecoveryMaintenance(()=>{},250),error=>error.code==='local_recovery_unavailable'&&error.commitUncertain===false);
 assert.equal(host.fatal,null);const ordinary=await host.status();assert.equal(ordinary.pending_outbox,'0');
});
