import test from 'node:test';
import assert from 'node:assert/strict';
import {DeferredNoteRecovery} from '../src/ui/deferred-note-recovery.ts';
import type {DurableCheckpoints,Checkpoint,CheckpointPage} from '../src/core/durable-checkpoints.ts';
const scope={vaultId:'vault',clientId:'client'};
function gate<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function head(entryId:string,dirty=true):Checkpoint {
  const content='Saved source',encodedState=JSON.stringify({version:1,writer:'writer',generation:1,base:{entryId,path:`${entryId}.md`,revision:'file-1',content,stat:{ctime:1,mtime:1,size:12}},draft:dirty?'Retained draft':content,conflict:false});
  return{version:1,...scope,key:`note/v1/${entryId}`,revision:'00000000-0000-4000-8000-000000000001',sequence:'1',deleted:false,byteLength:Buffer.byteLength(encodedState),encodedState};
}
function fixture(rows=[head('one')]){
  const loads:string[]=[],recovered:string[]=[],heads=new Map(rows.map(row=>[row.key,row]));
  let validate=()=>{},admitted=()=>false;
  const checkpoints:DurableCheckpoints={scope:{...scope},load:async key=>{loads.push(key);return heads.get(key)??null;},list:async()=>({items:rows,cursor:null,highWater:'1'}),changes:async()=>({items:[],cursor:null,highWater:'1'}),compareAndSwap:async()=>{throw Error('must never write');}};
  const runner=new DeferredNoteRecovery({checkpoints,validate:()=>validate(),admitted:()=>admitted(),recover:async id=>{recovered.push(id);}});
  return{runner,checkpoints,loads,recovered,heads,retire(){validate=()=>{throw Error('owner changed');};},admit(){admitted=()=>true;}};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('metadata discovery never hydrates bodies and an admitted actor is never replaced',async()=>{
  const f=fixture();await f.runner.discover();assert.deepEqual(f.loads,[]);assert.deepEqual(f.recovered,[]);
  f.admit();await f.runner.flush();assert.deepEqual(f.loads,[]);assert.deepEqual(f.recovered,[]);f.runner.stop();
});

test('failed recovery keeps its exact key for retry while completed clean keys stay completed',async()=>{
  const f=fixture([head('clean',false),head('one')]);let failed=true;const load=f.checkpoints.load;
  f.checkpoints.load=async key=>{if(key==='note/v1/one'&&failed){failed=false;throw Error('checkpoint read failed');}return load(key);};
  await assert.rejects(f.runner.flush(),/checkpoint read failed/);await f.runner.flush();await f.runner.flush();
  assert.deepEqual(f.loads,['note/v1/clean','note/v1/one']);assert.deepEqual(f.recovered,['one']);f.runner.stop();
});

test('stopping a held checkpoint read rejects promptly and late data cannot hydrate a buffer',async()=>{
  const f=fixture(),held=gate<Checkpoint|null>(),entered=gate<void>();f.checkpoints.load=async()=>{entered.resolve();return held.promise;};
  const flushing=f.runner.flush();await entered.promise;f.runner.stop();await assert.rejects(flushing,{code:'note_recovery_cancelled'});
  held.resolve(head('one'));await turn();assert.deepEqual(f.recovered,[]);
});

test('a checkpoint scope replacement cannot publish or hydrate a late head',async()=>{
  const f=fixture(),held=gate<Checkpoint|null>(),entered=gate<void>();f.checkpoints.load=async()=>{entered.resolve();return held.promise;};
  const flushing=f.runner.flush();await entered.promise;Object.assign(f.checkpoints.scope,{vaultId:'foreign'});held.resolve(head('one'));
  await assert.rejects(flushing,{code:'note_recovery_cancelled'});assert.deepEqual(f.recovered,[]);f.runner.stop();
});

test('metadata pagination continues through empty pages and catches changed/deleted keys',async()=>{
  const f=fixture([head('one'),head('two')]),requests:unknown[]=[];let page=0;
  f.checkpoints.list=async options=>{requests.push(options);return ++page===1?{items:[],cursor:'next-page',highWater:'2'}:{items:[head('one')],cursor:null,highWater:'2'};};
  f.checkpoints.changes=async options=>{requests.push(options);return{items:[head('two'),{...head('removed'),deleted:true}],cursor:null,highWater:'3'} as CheckpointPage;};
  await f.runner.discover();assert.deepEqual(f.loads,[]);await f.runner.flush();assert.deepEqual(f.recovered,['one','two']);
  assert.deepEqual(requests,[{limit:100,cursor:undefined},{limit:100,cursor:'next-page'},{after:'2',limit:100,cursor:undefined}]);f.runner.stop();
});

test('concurrent global flushes join one hydration and a stale owner stops before the next key',async()=>{
  const f=fixture([head('one'),head('two')]),held=gate<Checkpoint|null>(),entered=gate<void>();
  f.checkpoints.load=async key=>{f.loads.push(key);entered.resolve();return held.promise;};
  const first=f.runner.flush(),second=f.runner.flush();assert.equal(first,second);await entered.promise;f.retire();held.resolve(head('one'));
  await assert.rejects(first,/owner changed/);await assert.rejects(second,/owner changed/);assert.deepEqual(f.loads,['note/v1/one']);assert.deepEqual(f.recovered,[]);f.runner.stop();
});

test('background metadata failure remains owned without idle retries and the required flush still rejects',async()=>{
  const f=fixture(),failure=Error('metadata unavailable');let calls=0;const list=f.checkpoints.list;
  f.checkpoints.list=async()=>{calls++;throw failure;};f.runner.start();
  for(let i=0;i<100&&!f.runner.error;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(f.runner.error,failure);assert.equal(calls,1);assert.deepEqual(f.loads,[]);
  await assert.rejects(f.runner.flush(),error=>error===failure);assert.equal(f.runner.error,failure);
  f.checkpoints.list=list;await f.runner.flush();assert.equal(f.runner.error,undefined);assert.deepEqual(f.recovered,['one']);f.runner.stop();
});
