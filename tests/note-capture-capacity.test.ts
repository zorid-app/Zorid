import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNoteCaptureCapacityRecovery,recoverNoteCaptureCapacity} from '../src/ui/note-capture-capacity.ts';
import type {DurableWrites,PendingSavedSourceRequest,ConditionalSavedSourceRequest} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
function gate<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
const scope={vaultId:'capacity-vault',clientId:'capacity-client'};
const pending=(entryId='old',number=1):PendingSavedSourceRequest=>({captureId:`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`,legacy:false,logicalWitness:{entryId,revision:'r1',path:`${entryId}.md`}});
function checkpoint(request:PendingSavedSourceRequest):Checkpoint{
  const w=request.logicalWitness,input={operationId:'original-op',path:w.path,expectedEntryId:w.entryId,expectedRevision:w.revision,expectedContent:'Saved',content:'Accepted',conditionalSavedSource:{captureId:request.captureId,logicalWitness:w}};
  const encodedState=JSON.stringify({version:1,base:{entryId:w.entryId},operation:{input,content:'Accepted'}});
  return{version:1,...scope,key:`note/v1/${w.entryId}`,revision:'00000000-0000-4000-8000-000000000099',sequence:'1',deleted:false,byteLength:encodedState.length,encodedState};
}
function fixture(rows=[pending()]){
  const resumed:string[]=[],loads:string[]=[];let lists=0,open=false,valid=true;
  const writes={checkpoints:{scope:{...scope},load:async(key:string)=>{loads.push(key);return checkpoint(rows.find(row=>key===`note/v1/${row.logicalWitness.entryId}`)!);}},listSavedSourceRequests:async()=>{lists++;return rows;}} as unknown as DurableWrites;
  const owner={validate:()=>{if(!valid)throw Error('retired owner');},unopened:()=>!open,resume:async(request:ConditionalSavedSourceRequest)=>{resumed.push(request.captureId);return true;}};
  const unregister=registerNoteCaptureCapacityRecovery(writes,owner);
  return{writes,rows,resumed,loads,owner,unregister,get lists(){return lists;},open(){open=true;},retire(){valid=false;}};
}
test('capacity recovery resumes one exact original operation and concurrent callers join that unit',async()=>{
  const f=fixture([pending('old',1),pending('another',2)]),held=gate<readonly PendingSavedSourceRequest[]>();f.writes.listSavedSourceRequests=async()=>held.promise;
  const a=recoverNoteCaptureCapacity(f.writes,'selected',()=>{}),b=recoverNoteCaptureCapacity(f.writes,'another-selected',()=>{});held.resolve(f.rows);await Promise.all([a,b]);
  assert.deepEqual(f.resumed,[f.rows[0].captureId]);assert.deepEqual(f.loads,['note/v1/old']);f.unregister();
});
for(const kind of ['requester','loaded','legacy','foreign','malformed','ref','mismatched-capture','mismatched-witness','too-many','duplicate'] as const)test(`capacity recovery retains ${kind} evidence without resuming or authoring`,async()=>{
  const f=fixture();if(kind==='loaded')f.open();if(kind==='legacy')Object.assign(f.rows[0],{legacy:true});
  if(kind==='too-many')f.rows.push(...Array.from({length:8},(_,i)=>pending(`entry${i}`,i+2)));if(kind==='duplicate')f.rows.push({...f.rows[0]});
  const original=f.writes.checkpoints.load;f.writes.checkpoints.load=async key=>{const h=(await original(key))!;if(kind==='foreign')return{...h,clientId:'foreign'};if(kind==='malformed')return{...h,encodedState:'invalid'};
    const raw=JSON.parse(h.encodedState!);if(kind==='ref')raw.operation.ref={operationId:'prepared'};if(kind==='mismatched-capture')raw.operation.input.conditionalSavedSource.captureId='other';if(kind==='mismatched-witness')raw.operation.input.conditionalSavedSource.logicalWitness.revision='changed';return{...h,encodedState:JSON.stringify(raw)};};
  await recoverNoteCaptureCapacity(f.writes,kind==='requester'?'old':'selected',()=>{});assert.deepEqual(f.resumed,[]);f.unregister();
});
test('a concurrent open while the selected head is held prevents automatic resume',async()=>{
  const f=fixture(),held=gate<Checkpoint|null>(),entered=gate<void>();f.writes.checkpoints.load=async()=>{entered.resolve();return held.promise;};
  const recovering=recoverNoteCaptureCapacity(f.writes,'selected',()=>{});await entered.promise;f.open();held.resolve(checkpoint(f.rows[0]));await recovering;assert.deepEqual(f.resumed,[]);f.unregister();
});
test('cancellation and provider-scope replacement fence a held capacity continuation',async()=>{
  for(const kind of ['cancel','scope','unregister']){
    const f=fixture(),held=gate<Checkpoint|null>(),entered=gate<void>();let current=true;f.writes.checkpoints.load=async()=>{entered.resolve();return held.promise;};
    const recovering=recoverNoteCaptureCapacity(f.writes,'selected',()=>{if(!current)throw Error('request canceled');});await entered.promise;
    if(kind==='cancel')current=false;else if(kind==='scope')Object.assign(f.writes.checkpoints.scope,{clientId:'foreign'});else f.unregister();
    held.resolve(checkpoint(f.rows[0]));await assert.rejects(recovering);assert.deepEqual(f.resumed,[]);f.unregister();
  }
});
test('pending metadata is snapshotted before waiting for the canonical head',async()=>{
  const f=fixture(),held=gate<Checkpoint|null>(),entered=gate<void>(),h=checkpoint(f.rows[0]);f.writes.checkpoints.load=async()=>{entered.resolve();return held.promise;};
  const recovering=recoverNoteCaptureCapacity(f.writes,'selected',()=>{});await entered.promise;Object.assign(f.rows[0].logicalWitness,{revision:'mutated'});held.resolve(h);await recovering;
  assert.deepEqual(f.resumed,[f.rows[0].captureId]);f.unregister();
});

test('one canceled requester cannot transfer its cancellation into another joined capture',async()=>{
  const f=fixture(),held=gate<Checkpoint|null>(),entered=gate<void>();let firstCurrent=true;f.writes.checkpoints.load=async()=>{entered.resolve();return held.promise;};
  const first=recoverNoteCaptureCapacity(f.writes,'first',()=>{if(!firstCurrent)throw Error('first canceled');});await entered.promise;
  const second=recoverNoteCaptureCapacity(f.writes,'second',()=>{});firstCurrent=false;held.resolve(checkpoint(f.rows[0]));
  await assert.rejects(first,/first canceled/);await second;assert.deepEqual(f.resumed,[]);
  f.writes.checkpoints.load=async()=>checkpoint(f.rows[0]);await recoverNoteCaptureCapacity(f.writes,'second',()=>{});assert.deepEqual(f.resumed,[f.rows[0].captureId]);f.unregister();
});
