import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {MemoryAdapter} from '../src/core/memory-adapter.ts';
import {Vault} from '../src/core/vault.ts';
import type {Checkpoint,CheckpointChange} from '../src/core/durable-checkpoints.ts';
import type {DurableWrites,DurableWriteRead,DurableWriteIntent,DurableWritePlan,DurableWriteRef} from '../src/core/durable-writes.ts';
import type {IndependentDraftProvider,IndependentDraftChange,IndependentDraftCandidate} from '../src/core/independent-drafts.ts';
const clone=<T>(value:T):T=>structuredClone(value);
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
const fault=(code='storage_io_retryable',source='host')=>Object.assign(Error('Actual load provider fault'),{code,source,commitUncertain:true});
async function fixture(t:TestContext,{operation=true}={}){
  const scope={vaultId:'load-authority',clientId:'load-client'},base:DurableWriteRead={entryId:'entry',path:'One.md',revision:'r1',content:'Original',stat:{ctime:1,mtime:1,size:8}};
  const submitted='Submitted recovered body';let current={...base,revision:operation?'r2':'r1',content:operation?submitted:base.content};
  const ref={...scope,entryId:'entry',operationId:'original-operation',token:'original-token'},plan:DurableWritePlan={version:1,...scope,entryId:'entry',operationId:ref.operationId,encodedPlan:'original opaque plan'};
  const raw={version:1,writer:'canonical-writer',generation:1,base,draft:operation?submitted:base.content,conflict:false,...(operation?{operation:{plan,ref,content:submitted}}:{})};
  const encodedState=JSON.stringify(raw);let head:Checkpoint={version:1,...scope,key:'note/v1/entry',revision:'11111111-1111-1111-1111-111111111111',sequence:'1',encodedState,deleted:false,byteLength:Buffer.byteLength(encodedState)};
  const calls:CheckpointChange[]=[],journal:IndependentDraftChange[]=[],admittedAtCAS:boolean[]=[],queries:DurableWriteRef[]=[],plans:DurableWritePlan[]=[];
  const intents=new Map<string,DurableWriteIntent>([[ref.token,{state:'committed',ref,acknowledged:false,receipt:{operationId:ref.operationId,entryId:'entry',revision:'r2',sequence:'2'}}]]);
  let casGate:Promise<void>|undefined,casFault:unknown,readFault:unknown,readGate:Promise<void>|undefined,loseCAS=false,checkpointReads=0,sourceReads=0;
  const adapter=new MemoryAdapter({'One.md':current.content});
  let note:NoteBuffer;
  const writes:DurableWrites={checkpoints:{scope,load:async()=>{checkpointReads++;return clone(head);},compareAndSwap:async change=>{
    calls.push(clone(change));admittedAtCAS.push(note.hasAdmittedContent);
    if(casGate)await casGate;if(casFault)throw casFault;
    if(head.revision===change.nextRevision){assert.equal(head.encodedState,change.encodedState);return clone(head);}
    if(head.revision!==change.expectedRevision)throw fault('checkpoint_conflict');
    head={...head,revision:change.nextRevision,sequence:String(Number(head.sequence)+1),encodedState:change.encodedState,byteLength:Buffer.byteLength(change.encodedState??''),deleted:change.encodedState===null};
    if(loseCAS){loseCAS=false;throw fault('durable_transport_lost','transport');}return clone(head);
  },list:async()=>({items:[],cursor:null,highWater:'1'}),changes:async()=>({items:[],cursor:null,highWater:'1'})},
  readText:async()=>{sourceReads++;if(readGate)await readGate;if(readFault)throw readFault;return clone(current);},
  readTextById:async id=>{sourceReads++;const captured=clone(current);if(readGate)await readGate;if(readFault)throw readFault;return id===captured.entryId?captured:null;},
  planWrite:async input=>{const value:DurableWritePlan={version:1,...scope,entryId:'entry',operationId:input.operationId,encodedPlan:JSON.stringify(input)};plans.push(value);return clone(value);},
  prepare:async value=>{const next={...scope,entryId:'entry',operationId:value.operationId,token:value.operationId};const intent:DurableWriteIntent={state:'prepared',ref:next,acknowledged:false};intents.set(next.token,intent);return clone(intent);},
  query:async value=>{queries.push(clone(value));return clone(intents.get(value.token)??null);},
  commit:async value=>{const input=JSON.parse(plans.find(plan=>plan.operationId===value.operationId)!.encodedPlan);current={...current,content:input.content,revision:'r'+(Number(current.revision.slice(1))+1)};await adapter.write('One.md',current.content);const intent:DurableWriteIntent={state:'committed',ref:value,acknowledged:false,receipt:{operationId:value.operationId,entryId:'entry',revision:current.revision,sequence:current.revision.slice(1)}};intents.set(value.token,intent);return clone(intent);},
  acknowledge:async()=>{},listUnacknowledged:async()=>[]};
  const jscope={...scope,incarnationId:'document'},jheads=new Map<string,IndependentDraftCandidate>();
  const provider:IndependentDraftProvider={scope:jscope,list:async()=>[],read:async()=>null,compareAndSwap:async change=>{journal.push(clone(change));const saved={...jscope,entryId:change.entryId,writer:change.writer,revision:change.nextRevision,generation:change.generation,deleted:false as const,baseline:change.baseline,draft:change.draft,checkpointRevision:change.checkpointRevision,pendingOperation:change.pendingOperation};jheads.set(change.writer,saved);return clone(saved);},retire:async value=>({...jscope,...value,revision:value.nextRevision,deleted:true})};
  Object.assign(adapter,{durableWrites:writes,independentDrafts:provider});const vault=new Vault(adapter);await vault.initialize();note=new NoteBuffer(vault,'One.md',{debounceMs:60000});
  t.after(async()=>{casGate=undefined;casFault=undefined;readGate=undefined;readFault=undefined;try{await note.dispose();}catch{await note.disposeUnadmitted?.().catch(()=>{});}});
  return{note,vault,writes,calls,journal,admittedAtCAS,queries,plans,raw,ref,submitted,get sourceReads(){return sourceReads;},get checkpointReads(){return checkpointReads;},
    holdCAS(promise:Promise<void>){casGate=promise;},failCAS(value:unknown){casFault=value;},loseCAS(){loseCAS=true;},failRead(value:unknown){readFault=value;},holdRead(value:Promise<void>){readGate=value;},
    replace(){current={...current,entryId:'replacement',revision:'replacement-r1',content:'Peer replacement'};},takeCheckpoint(){head={...head,revision:'22222222-2222-2222-2222-222222222222'};}};
}

test('confirmed canonical body becomes admitted before a held recovery CAS, and newer typing journals independently',async t=>{
  const f=await fixture(t),held=gate();f.holdCAS(held.promise);
  const loading=f.note.load('entry');let resolved=false;void loading.then(()=>{resolved=true;},()=>{});
  try{
    await drain();assert.equal(resolved,true,'opening must not wait for checkpoint acknowledgment');assert.equal(f.note.hasAdmittedContent,true);
    assert.equal(f.note.text,f.submitted);assert.ok(f.calls.length);assert.ok(f.admittedAtCAS.every(Boolean),'no core CAS may precede admission');
    f.note.update('D3 typed while original recovery is held');await f.note.flushDraftProtection();
    assert.equal(f.journal.at(-1)!.draft,'D3 typed while original recovery is held');assert.equal(f.plans.length,0);
    const phase=JSON.parse(f.journal.at(-1)!.pendingOperation!);assert.equal(phase.operation.ref.operationId,f.ref.operationId);
  }finally{held.resolve();await loading;}
  await f.note.flush();assert.equal(f.note.savedText,'D3 typed while original recovery is held');
});
