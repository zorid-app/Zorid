import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,equal,pageEvidence,changesEvidence,assertStrict,rejects,replayPreflightEvidence,transactionBeforeRpcEvidence} from './assertions.mjs';
const query={limit:2,byteLimit:100};
const page={scanned:1,bytes:80,blocks:[{record:'one'}],cursor:'token',incomplete:true,watermark:'2'};
test('binary witnesses compare exact bytes across clones and reject any changed receipt byte',()=>{
  equal({b:new Uint8Array([0,255]),a:1},{a:1,b:new Uint8Array([0,255]).buffer},'same');
  assert.throws(()=>equal(new Uint8Array([0,254]),new Uint8Array([0,255]),'receipt changed'),/receipt changed/);
  assert.deepEqual(canonical({z:2,a:new Uint8Array([3])}),{a:[3],z:2});
});
test('window evidence rejects over-budget, non-progress and inconsistent continuation',()=>{
  pageEvidence(page,query);
  for(const bad of [{scanned:3},{bytes:101},{scanned:0},{cursor:null},{watermark:'02'}])assert.throws(()=>pageEvidence({...page,...bad},query));
  assert.throws(()=>pageEvidence(page,{...query,cursor:'token'}),/advance/);
});
test('changes evidence binds next and detects replayed/reordered sequences',()=>{
  const row=sequence=>({sequence,record_key:'["record","generation"]',update_id:'op',status:'accepted'});
  changesEvidence({changes:[row('2'),row('3')],next:'3'},'1',2);
  changesEvidence({changes:[],next:'9'},'9',2);
  for(const bad of [{changes:[row('1')],next:'1'},{changes:[row('3'),row('2')],next:'2'},{changes:[row('2')],next:'3'},{changes:[row('02')],next:'02'}])assert.throws(()=>changesEvidence(bad,'1',2));
});
test('strict transaction proof cannot pass on absent, unsettled or relaxed observations',()=>{
  assertStrict([{requested:'strict',actual:'strict',outcome:'complete'},{requested:'strict',actual:'strict',outcome:'abort'}]);
  for(const rows of [[],[{requested:'strict',actual:'relaxed',outcome:'complete'}],[{requested:'strict',actual:'strict',outcome:'pending'}]])assert.throws(()=>assertStrict(rows));
});
test('expected rejection helper rejects missing and wrong failures, preserves uncertainty',async()=>{
  assert.deepEqual(await rejects(()=>Promise.reject({code:'stale_revision',source:'rust',commitUncertain:false}),'stale_revision'),{code:'stale_revision',source:'rust',commitUncertain:false});
  await assert.rejects(()=>rejects(()=>Promise.resolve(),'stale_revision'));
  await assert.rejects(()=>rejects(()=>Promise.reject({code:'storage_corrupt'}),'stale_revision'));
});

test('journal-first evidence rejects hidden source, accepted-state, quota reads and replay writes',()=>{
  const base={mode:'readwrite',outcome:'complete',writes:[],reads:[{store:'control',method:'get',key:'local-store-id'},{store:'managed_collections',method:'get'},{store:'managed_local_operations',method:'get'}]};
  replayPreflightEvidence(base);
  for(const store of ['managed_records','managed_operation_sources','sync_state','sync_source_payloads'])assert.throws(()=>replayPreflightEvidence({...base,reads:[...base.reads,{store,method:'get'}]}));
  assert.throws(()=>replayPreflightEvidence({...base,reads:[...base.reads,{store:'control',method:'get',key:'quota'}]}));
  assert.throws(()=>replayPreflightEvidence({...base,writes:[{store:'managed_changes',method:'add'}]}));
});

test('causal terminal/RPC evidence rejects reversed, cross-worker and mismatched mutation pairs',()=>{
  const terminal={event:'transaction',workerId:'worker1',ordinal:4,witness:{id:2,mode:'readwrite',outcome:'complete',operation:'op'}};
  const reply={event:'rpc-reply',rpc:'workblock-command',workerId:'worker1',ordinal:5,id:'request1',operation:'op'};
  assert.equal(transactionBeforeRpcEvidence(terminal,reply).transaction,2);
  for(const bad of [{ordinal:3},{ordinal:4},{workerId:'worker2'},{operation:'other'},{event:'rpc-in'},{id:undefined}])assert.throws(()=>transactionBeforeRpcEvidence(terminal,{...reply,...bad}));
  assert.throws(()=>transactionBeforeRpcEvidence({...terminal,witness:{...terminal.witness,outcome:'pending'}},reply));
});
