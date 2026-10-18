import test from 'node:test';
import assert from 'node:assert/strict';
import {rowDiffs,abortedAtomicityEvidence} from './assertions.mjs';
const key='document-index:v1/catalog',database='owned';
const row={key,value:{version:1,localStoreId:'authority',head:null,generations:[],pins:[]}};
function fixture(){
  const before={control:[{key:'local-store-id',value:{key:'local-store-id',value:'authority'}}],managed_records:[{key:['record'],value:{bytes:[1,255]}}],sync_cursors:[],sync_authored:[]};
  const after=structuredClone(before);after.control.push({key,value:structuredClone(row)});
  const event=(ordinal,extra)=>({workerId:'worker',database,ordinal,...extra});
  const events=[event(2,{event:'rpc-in',rpc:'release-client',id:'release'}),event(3,{event:'transaction',witness:{id:24,operation:'op',mode:'readwrite',requested:'strict',actual:'strict',outcome:'abort',writes:[]}}),event(4,{event:'rpc-reply',rpc:'workblock-command',id:'mutation',operation:'op',ok:false,error:{commitUncertain:false}}),event(5,{event:'transaction',witness:{id:25,mode:'readwrite',requested:'strict',actual:'strict',outcome:'complete',stores:['control'],reads:[{store:'control',method:'get',key:'local-store-id'},{store:'control',method:'get',key}],writes:[{store:'control',method:'put',key,value:structuredClone(row)}]}}),event(6,{event:'rpc-reply',rpc:'release-client',id:'release',ok:true})];
  return {before,after,events,operation:'op',database};
}
test('exact absent empty catalog creation requires separate strict close write and correlated release',()=>{
  const f=fixture();assert.equal(abortedAtomicityEvidence(f).diffs.length,1);
  const same=fixture();same.after=structuredClone(same.before);same.events[3].witness.writes=[];assert.deepEqual(abortedAtomicityEvidence(same).diffs,[]);
  for(const mutate of [
    f=>f.after.control.push({key:'sequence',value:{key:'sequence',value:'2'}}),
    f=>f.after.managed_records[0].value.bytes[1]=254,
    f=>f.after.sync_authored.push({key:'op',value:{pending:1}}),
    f=>f.after.sync_cursors.push({key:'scope',value:'2'}),
    f=>f.after.control[1].value.value.pins.push({id:'pin'}),
    f=>f.after.control[1].value.value.extra=true,
    f=>f.after.control[1].value.value.localStoreId='foreign',
    f=>f.before.control.push({key,value:{...row,value:{...row.value,head:'old'}}}),
    f=>f.events.splice(0,1),f=>f.events.at(-1).id='unrelated',
    f=>f.events[3].ordinal=7,f=>f.events[3].workerId='other',
    f=>f.events[3].witness.writes[0].value.value.head='unexpected',
    f=>delete f.events[3].witness.writes[0].key,
    f=>f.events[3].witness.actual='relaxed',
    f=>f.events[3].witness.reads.push({store:'control',method:'get',key:'sequence'}),
    f=>f.events[1].witness.outcome='complete',
    f=>f.events[2].error.commitUncertain=true,
  ]){const bad=fixture();mutate(bad);assert.throws(()=>abortedAtomicityEvidence(bad));}
});
test('full keyed diff detects deletions, byte changes, counters and extra stores without hiding control',()=>{
  const f=fixture();f.after.managed_records=[];f.after.control[0].value.value='other';f.after.extra=[];
  assert.equal(rowDiffs(f.before,f.after).length,3);
  assert.throws(()=>abortedAtomicityEvidence(f),/inventory/);
});

// Reproduce the retained raw3 ordering, supplying newly required full snapshots
// and write contents as synthetic evidence, never as a claim about old raw data.
function twoTransactionFixture(){
  const f=fixture(),close=f.events[3],released=f.events[4];
  f.events[0].ordinal=59;f.events[1].ordinal=64;f.events[2].ordinal=65;
  close.ordinal=67;released.ordinal=70;
  f.events.splice(4,0,{workerId:'worker',database,ordinal:69,event:'transaction',witness:{id:26,mode:'readwrite',requested:'strict',actual:'strict',outcome:'complete',stores:['control','binary_reads'],reads:[{store:'control',method:'get',key:'local-store-id'},{store:'binary_reads',method:'openCursor'}],writes:[]}});
  return f;
}
test('raw3-shaped catalog tx25 plus empty readwrite tx26 selects only the write-bearing close',()=>{
  const f=twoTransactionFixture(),evidence=abortedAtomicityEvidence(f);
  assert.equal(evidence.catalogException.close.witness.id,25);
  assert.equal(evidence.diffs.length,1);
  // Staged writes in the actual aborted mutation are allowed, then rolled back.
  f.events[1].witness.writes=[{store:'managed_records',method:'put'}];
  assert.equal(abortedAtomicityEvidence(f).catalogException.close.witness.id,25);
});
test('all other intervening transactions must have zero writes even with unchanged durable rows',()=>{
  for(const method of ['put','add','delete','clear'])for(const outcome of ['complete','abort']){
    const f=twoTransactionFixture();f.events[4].witness.writes=[{store:'control',method,key:'sequence'}];f.events[4].witness.outcome=outcome;
    assert.throws(()=>abortedAtomicityEvidence(f),/unique separate close write/);
  }
  const same=twoTransactionFixture();same.after=structuredClone(same.before);
  assert.throws(()=>abortedAtomicityEvidence(same),/another write transaction/);
  same.events[3].witness.writes=[];
  assert.deepEqual(abortedAtomicityEvidence(same).diffs,[]);
  same.events[4].witness.writes=[{store:'managed_records',method:'put'}];
  assert.throws(()=>abortedAtomicityEvidence(same),/another write transaction/);
});
test('two-transaction close rejects wrong catalog, stores, counters, strictness and causality',()=>{
  for(const mutate of [
    f=>f.events[3].witness.stores.push('managed_records'),
    f=>f.events[3].witness.writes[0].key='other-catalog',
    f=>f.events[3].witness.writes[0].value.value.generations.push('generation'),
    f=>f.events[3].witness.writes[0].value.value.extra=true,
    f=>f.events[3].witness.writes[0].value.value.localStoreId='foreign',
    f=>f.events[3].witness.writes.push({store:'control',method:'put',key:'sequence'}),
    f=>f.after.control.push({key:'sequence',value:{key:'sequence',value:'1'}}),
    f=>f.events[4].witness.actual='relaxed',
    f=>delete f.events[4].witness.writes,
    f=>f.events[4].witness.id=25,
    f=>f.events[4].workerId='other',
    f=>f.events[4].database='foreign',
    f=>f.events[3].ordinal=71,
    f=>f.events[5].ordinal=66,
    f=>f.events[3].witness.outcome='abort',
    f=>f.events[3].witness.mode='readonly',
    f=>f.before.control.push(structuredClone(f.before.control[0])),
    f=>f.after.sync_cursors.push({key:'cursor',value:'1'}),
    f=>f.after.managed_records[0].value.bytes[0]=2,
    f=>f.after.extra=[],
  ]){const f=twoTransactionFixture();mutate(f);assert.throws(()=>abortedAtomicityEvidence(f));}
});
