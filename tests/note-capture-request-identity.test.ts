import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import type {Vault} from '../src/core/vault.ts';
import type {DurableWrites,ConditionalSavedSourceRequest} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
import type {IndependentDraftProvider,IndependentDraftChange} from '../src/core/independent-drafts.ts';

function held<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(predicate:()=>boolean){for(let i=0;i<50&&!predicate();i++)await tick();assert.ok(predicate());}
const scope={vaultId:'capture-vault',clientId:'capture-client'},journalScope={...scope,incarnationId:'owned-document'};
const observed={entryId:'entry',revision:'source-1',path:'One.md',content:'Original source',stat:{ctime:1,mtime:1,size:15}};
async function fixture(t:TestContext){
  let head:Checkpoint|null=null,journalGate:ReturnType<typeof held>|undefined,journalRevision:string|null=null;
  const native:ConditionalSavedSourceRequest[]=[],journal:IndependentDraftChange[]=[],releases:string[]=[];
  const unavailable=async():Promise<never>=>{throw Error('Unexpected source mutation');};
  const writes:DurableWrites={checkpoints:{scope,load:async()=>head,compareAndSwap:async change=>{
    head={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(Number(head?.sequence??0)+1),encodedState:change.encodedState,deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??'')};return head;
  },list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})},
    readText:async()=>structuredClone(observed),readTextById:async()=>structuredClone(observed),planWrite:unavailable,prepare:unavailable,commit:unavailable,query:unavailable,acknowledge:unavailable,listUnacknowledged:async()=>[],
    captureSavedSource:async request=>{native.push(structuredClone(request));return{captureId:request.captureId??'old-server-id',logicalWitness:request.logicalWitness??{entryId:observed.entryId,revision:observed.revision,path:observed.path},source:observed.content};},
    releaseSavedSource:async id=>{releases.push(id);},listSavedSourceRequests:async()=>[],
  };
  const provider:IndependentDraftProvider={scope:journalScope,list:async()=>[],read:async()=>null,compareAndSwap:async request=>{
    journal.push(structuredClone(request));if(journalGate)await journalGate.promise;
    assert.equal(request.expectedRevision,journalRevision);journalRevision=request.nextRevision;
    return{...journalScope,entryId:request.entryId,writer:request.writer,generation:request.generation,revision:request.nextRevision,deleted:false};
  },retire:async request=>({...journalScope,entryId:request.entryId,writer:request.writer,generation:request.generation,revision:request.nextRevision,deleted:true})};
  const vault={adapter:{durableWrites:writes,independentDrafts:provider},entries:new Map([['One.md',{entryId:'entry'}]]),readDurableText:writes.readText,readDurableTextById:writes.readTextById} as unknown as Vault;
  const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});await buffer.load('entry');t.after(()=>buffer.closeMetadataProjection());
  return{buffer,writes,provider,native,journal,releases,holdJournal(){return journalGate=held();},releaseJournal(){journalGate?.resolve();journalGate=undefined;}};
}

test('clean-note capture dispatch waits for a real journal ACK containing its caller-owned UUID and scope',async t=>{
  const f=await fixture(t);f.holdJournal();
  const pending=f.buffer.captureConditionalSavedSource({entryId:'entry',revision:'source-1',path:'One.md'});void pending.catch(()=>{});
  await tick();await tick();assert.equal(f.native.length,0,'No Native capture before independent ACK');
  await until(()=>f.journal.length===1);
  const capsule=JSON.parse(f.journal[0].pendingOperation!);assert.equal(capsule.schemaVersion,2);assert.equal(capsule.captureRequests.length,1);
  const request=capsule.captureRequests[0];assert.match(request.captureId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);assert.deepEqual(request.scope,journalScope);
  f.releaseJournal();const capture=await pending;assert.equal(capture!.captureId,request.captureId);assert.deepEqual(f.native,[{captureId:request.captureId,logicalWitness:request.logicalWitness}]);
  assert.equal(f.buffer.dirty,false);await f.buffer.releaseConditionalSavedSource(capture!);
});
