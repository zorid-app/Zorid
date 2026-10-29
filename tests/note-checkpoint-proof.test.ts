import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import type {Checkpoint,CheckpointChange} from '../src/core/durable-checkpoints.ts';
import type {DurableWrites,DurableWriteInput,DurableWriteIntent,DurableWriteRead} from '../src/core/durable-writes.ts';
import type {IndependentDraftProvider} from '../src/core/independent-drafts.ts';

const scope={vaultId:'checkpoint-proof-vault',clientId:'checkpoint-proof-client'};
const key='note/v1/entry',loadedRevision='11111111-1111-1111-1111-111111111111';
const proofError={code:'invalid_durable_response',source:'protocol'};
const corruptions:Record<string,(head:Checkpoint)=>unknown>={
  vault:head=>({...head,vaultId:'foreign'}),client:head=>({...head,clientId:'foreign'}),key:head=>({...head,key:'note/v1/foreign'}),
  revision:head=>({...head,revision:'not-a-uuid'}),version:head=>({...head,version:2}),
  differentRevision:head=>({...head,revision:'22222222-2222-2222-2222-222222222222'}),
  deleted:head=>({...head,deleted:true}),body:head=>({...head,encodedState:head.encodedState+' ',byteLength:head.byteLength+1}),
  bytes:head=>({...head,byteLength:head.byteLength+1}),sequence:head=>({...head,sequence:'0'}),
  missingMetadata:head=>{const {sequence,...rest}=head;return rest;},
};
async function fixture(t:TestContext,{journalFails=false}={}){
  const adapter=new MemoryAdapter({'One.md':'Saved source'}),plans=new Map<string,DurableWriteInput>(),intents=new Map<string,DurableWriteIntent>();
  let current:DurableWriteRead={entryId:'entry',revision:'file-1',path:'One.md',content:'Saved source',stat:{ctime:1,mtime:1,size:12}},head:Checkpoint|null=null;
  let transform:(head:Checkpoint,change:CheckpointChange)=>unknown=head=>head,loadTransform:(head:Checkpoint|null)=>unknown=head=>head,sequence=0;
  const calls:CheckpointChange[]=[];
  const writes:DurableWrites={checkpoints:{scope,load:async()=>loadTransform(head) as Checkpoint|null,compareAndSwap:async change=>{
    calls.push(change);
    if(head?.revision!==change.nextRevision){assert.equal(change.expectedRevision,head?.revision??null);head={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(++sequence),deleted:change.encodedState===null,encodedState:change.encodedState,byteLength:Buffer.byteLength(change.encodedState??'')};}
    else assert.equal(head.encodedState,change.encodedState);
    return transform(structuredClone(head),change) as Checkpoint;
  },list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})},
    readText:async()=>structuredClone(current),readTextById:async()=>structuredClone(current),
    planWrite:async input=>{plans.set(input.operationId,structuredClone(input));return{version:1,...scope,entryId:'entry',operationId:input.operationId,encodedPlan:JSON.stringify(input)};},
    prepare:async plan=>{const intent:DurableWriteIntent={ref:{...scope,entryId:'entry',operationId:plan.operationId,token:plan.operationId},state:'prepared',acknowledged:false};intents.set(plan.operationId,intent);return intent;},
    query:async ref=>intents.get(ref.operationId)??null,
    commit:async ref=>{const input=plans.get(ref.operationId)!;current={...current,content:input.content,revision:'file-2'};await adapter.write('One.md',input.content);
      const intent:DurableWriteIntent={ref,state:'committed',acknowledged:false,receipt:{operationId:ref.operationId,entryId:'entry',revision:'file-2',sequence:'1'}};intents.set(ref.operationId,intent);return intent;},
    acknowledge:async()=>{},listUnacknowledged:async()=>[],
  };
  Object.assign(adapter,{durableWrites:writes});
  if(journalFails){const provider:IndependentDraftProvider={scope:{...scope,incarnationId:'renderer'},list:async()=>[],read:async()=>null,
    compareAndSwap:async()=>{throw Object.assign(Error('Independent storage unavailable'),{code:'draft_storage_failure'});},retire:async()=>{throw Error('No retirement was authorized');}};Object.assign(adapter,{independentDrafts:provider});}
  const vault=new Vault(adapter);await vault.initialize();const note=new NoteBuffer(vault,'One.md',{debounceMs:60_000});
  t.after(async()=>{(note as any).durable.stopDraftProtection();await note.closeMetadataProjection();});
  return{note,calls,plans,writes,get head(){return head;},get current(){return current;},forge(change:typeof transform){transform=change;},forgeLoad(change:typeof loadTransform){loadTransform=change;},
    seed(){const state={version:1,writer:'retained-writer',generation:0,base:current,draft:current.content,conflict:false};head={version:1,...scope,key,revision:loadedRevision,sequence:'1',deleted:false,encodedState:JSON.stringify(state),byteLength:Buffer.byteLength(JSON.stringify(state))};sequence=1;}};
}

for(const [kind,corrupt]of Object.entries(corruptions).filter(([kind])=>!['body','differentRevision'].includes(kind)))test(`a malformed ${kind} load head cannot establish checkpoint authority`,async t=>{
  const f=await fixture(t);f.seed();f.forgeLoad(head=>corrupt(head!));
  await assert.rejects(f.note.load('entry'),proofError);assert.equal(f.note.savedDurableWitness,undefined);assert.equal(f.calls.length,0);
});

for(const [kind,corrupt]of Object.entries(corruptions))test(`a malformed ${kind} CAS ACK retains the exact request before later input`,async t=>{
  const f=await fixture(t);await f.note.load('entry');f.forge(head=>corrupt(head));f.note.update('First protected body');
  await assert.rejects(f.note.flush({autoRetry:false}),proofError);const original=f.calls[0];assert.ok(original);assert.equal(f.note.dirty,true);assert.equal(f.plans.size,0);
  f.forge(head=>head);f.note.update('Later body');await f.note.flush({autoRetry:false});
  for(const call of f.calls.filter(call=>call.nextRevision===original.nextRevision))assert.equal(call,original);
  assert.ok(f.calls.filter(call=>call.nextRevision===original.nextRevision).length>=3);assert.equal(f.note.text,'Later body');assert.equal(f.current.content,'Later body');assert.equal(f.note.error,null);
});

for(const kind of ['vault','key','body','deleted'])test(`a forged final clean ${kind} ACK cannot waive failed independent protection or report close complete`,async t=>{
  const f=await fixture(t,{journalFails:true});await f.note.load('entry');f.note.update('Submitted body');
  f.forge((head,change)=>{const state=JSON.parse(change.encodedState!);return !state.operation&&state.draft===state.base.content?corruptions[kind](head):head;});
  await assert.rejects(f.note.dispose(),proofError);assert.equal(f.current.content,'Submitted body');assert.equal(f.note.dirty,true);assert.ok(f.note.error);
  assert.equal((f.note as any).durable.coreCoversCurrentDraft,false);
  f.forge(head=>head);await f.note.dispose();assert.equal(f.note.dirty,false);
});

test('a coherent tombstone remains a usable revision fence without claiming clean body coverage',async t=>{
  const f=await fixture(t);f.seed();f.forgeLoad(head=>({...head!,deleted:true,encodedState:null,byteLength:0}));await f.note.load('entry');
  assert.equal((f.note as any).durable.coreCoversCurrentDraft,false);f.note.update('After tombstone');await f.note.flush({autoRetry:false});assert.equal(f.calls[0].expectedRevision,loadedRevision);
});
