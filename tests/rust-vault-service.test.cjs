'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { RustVaultService } = require('../desktop/rust-vault-service.cjs');

// Actual subprocess tests of the JS transport. This intentionally tiny fake host
// tests framing/lifecycle only; Rust process.rs separately executes NativeVault.
async function fixture(t, mode = 'normal') {
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
send({version:1,request_id:'0',ok:true,result:{transport:'zorid-native-stdio',max_header:1048576,max_body:16777216,capabilities:[]}});
let buffer=Buffer.alloc(0);
process.stdin.on('data', chunk => {buffer=Buffer.concat([buffer,chunk]); while(buffer.length>=8){
 const h=buffer.readUInt32BE(0),b=buffer.readUInt32BE(4); if(buffer.length<8+h+b)return;
 const req=JSON.parse(buffer.subarray(8,8+h)), body=Buffer.from(buffer.subarray(8+h,8+h+b)); buffer=buffer.subarray(8+h+b);
 if(mode==='exit'){process.exit(1);return;}
 if(mode==='stall')continue;
 if(mode==='oversized'){process.stdout.write(Buffer.alloc(8,255));continue;}
 if(mode==='reject'){send({version:1,request_id:req.request_id,ok:false,error:{code:'revision_conflict',commit_uncertain:false}});continue;}
 let responseBody = Buffer.alloc(0);
 let result = req.command.method==='apply' ? {commit:{operation_id:req.command.operation_id,sequence:'1',changes:[{before:null,after:{id:req.command.mutation.id,path:req.command.mutation.path,kind:'file',revision:'new',deleted:false}}]},projection:{state:'pending'},captured:[...body]} : {pending_outbox:'0',pending_projection:'0',attempts:[],observations:[],command:req.command};
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
 if(mode==='missing')result=undefined;
 if(mode==='wrong_receipt')result.commit.operation_id='wrong';
 setTimeout(()=>send({version:1,request_id:req.request_id,ok:true,result},responseBody),15);
 }});
process.stdin.on('end',()=>process.exit(0));
`;
  await fs.writeFile(executable, source, { mode: 0o700 });
  let host;
  t.after(async () => { if (host) await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  host = await RustVaultService.open(root, { executable, timeoutMs: 1000 });
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
