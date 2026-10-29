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
  let casGate:Promise<void>|undefined,casFault:unknown,readFault:unknown,checkpointFault:unknown,readGate:Promise<void>|undefined,loseCAS=false,checkpointReads=0,sourceReads=0;
  const adapter=new MemoryAdapter({'One.md':current.content});
  let note:NoteBuffer;
  const writes:DurableWrites={checkpoints:{scope,load:async()=>{checkpointReads++;if(checkpointFault)throw checkpointFault;return clone(head);},compareAndSwap:async change=>{
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
  const provider:IndependentDraftProvider={scope:jscope,list:async()=>[],read:async()=>null,compareAndSwap:async change=>{journal.push(clone(change));const saved={...jscope,entryId:change.entryId,writer:change.writer,revision:change.nextRevision,generation:change.generation,deleted:false as const,baseline:change.baseline,draft:change.draft,checkpointRevision:change.checkpointRevision,pendingOperation:change.pendingOperation};jheads.set(change.writer,saved);const{baseline,draft,checkpointRevision,pendingOperation,...receipt}=saved;return clone(receipt);},retire:async value=>({vaultId:jscope.vaultId,clientId:jscope.clientId,incarnationId:value.incarnationId,entryId:value.entryId,writer:value.writer,revision:value.nextRevision,generation:value.generation,deleted:true})};
  Object.assign(adapter,{durableWrites:writes,independentDrafts:provider});const vault=new Vault(adapter);await vault.initialize();note=new NoteBuffer(vault,'One.md',{debounceMs:60000});
  t.after(async()=>{casGate=undefined;casFault=undefined;readGate=undefined;readFault=undefined;try{await note.dispose();}catch{await note.disposeUnadmitted?.().catch(()=>{});}});
  return{note,vault,adapter,writes,calls,journal,admittedAtCAS,queries,plans,raw,ref,submitted,get sourceReads(){return sourceReads;},get checkpointReads(){return checkpointReads;},
    holdCAS(promise:Promise<void>){casGate=promise;},failCAS(value:unknown){casFault=value;},loseCAS(){loseCAS=true;},failRead(value:unknown){readFault=value;},failCheckpointRead(value:unknown){checkpointFault=value;},holdRead(value:Promise<void>|undefined){readGate=value;},
    alterCheckpoint(change:(state:any)=>void){const value=JSON.parse(head.encodedState!);change(value);const encodedState=JSON.stringify(value);head={...head,encodedState,byteLength:Buffer.byteLength(encodedState)};},
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

test('lost S1 acknowledgment retries exactly S1 without reloading or inventing another pre-query checkpoint',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);f.loseCAS();await f.note.load('entry');await drain();
  const original=f.calls[0];assert.equal(f.note.hasAdmittedContent,true);assert.equal(f.calls.length,1);assert.equal(f.queries.length,0);
  t.mock.timers.tick(499);await drain();assert.equal(f.calls.length,1);
  t.mock.timers.tick(1);await drain();assert.deepEqual(f.calls[1],original);assert.equal(f.checkpointReads,1);
  assert.ok(f.queries.length>0);assert.ok(f.queries.every(value=>value.token===f.ref.token));assert.equal(f.plans.length,0);
  const calls=f.calls.length;t.mock.timers.tick(90000);await drain();assert.equal(f.calls.length,calls,'healthy recovery adds no timers or checkpoint IO');
});

test('peer checkpoint takeover terminates exact S1 replay while later typing remains independently protected',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);f.loseCAS();await f.note.load('entry');await drain();f.takeCheckpoint();
  t.mock.timers.tick(500);await drain();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(f.queries.length,0);
  f.note.update('D3 retained after peer ownership');await f.note.flushDraftProtection();assert.equal(f.journal.at(-1)!.draft,'D3 retained after peer ownership');
  t.mock.timers.tick(90000);await drain();assert.equal(f.calls.length,2);assert.equal(f.plans.length,0);assert.equal(f.note.hasAdmittedContent,true);
  await assert.rejects(f.note.flush(),{code:'checkpoint_conflict'});
});

test('canonical source retirement waits without polling and only a same-scope positive admission wakes it',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);f.failCAS(fault('client_not_admitted'));await f.note.load('entry');await drain();
  const exact=f.calls[0];t.mock.timers.tick(90000);await drain();assert.equal(f.calls.length,1);
  f.note.coreAdmissionAvailable({vaultId:'foreign',clientId:'load-client'});await drain();assert.equal(f.calls.length,1);
  f.failCAS(undefined);f.note.coreAdmissionAvailable(f.writes.checkpoints.scope);await drain();assert.deepEqual(f.calls[1],exact);assert.equal(f.note.error,null);
});

test('a typed initial read retries automatically without authorizing a blank editor or duplicate healthy reads',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t,{operation:false});f.failRead(fault());
  const loading=f.note.load('entry');await drain();assert.equal(f.note.hasAdmittedContent,false);assert.equal(f.sourceReads,1);assert.equal(f.checkpointReads,0);
  f.failRead(undefined);t.mock.timers.tick(500);await loading;assert.equal(f.note.hasAdmittedContent,true);assert.equal(f.note.text,'Original');assert.equal(f.sourceReads,2);assert.equal(f.checkpointReads,1);assert.equal(f.calls.length,0);
  await Promise.all([f.note.load('entry'),f.note.load('entry')]);t.mock.timers.tick(90000);await drain();assert.equal(f.sourceReads,2);assert.equal(f.calls.length,0);
});

test('an initial checkpoint failure cannot follow a same-path replacement on automatic retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t,{operation:false});f.failCheckpointRead(fault());
  const loading=f.note.load('entry'),failed=assert.rejects(loading,/selected note changed/);await drain();f.replace();f.failCheckpointRead(undefined);
  t.mock.timers.tick(500);await failed;assert.equal(f.note.hasAdmittedContent,false);assert.equal(f.checkpointReads,1);assert.equal(f.calls.length,0);assert.equal(f.plans.length,0);await f.note.disposeUnadmitted();
});

test('cancelling and disposing a pure held load is prompt and an old late reply cannot admit or mutate it',async t=>{
  const f=await fixture(t,{operation:false}),held=gate(),signal=new AbortController();f.holdRead(held.promise);
  const loading=f.note.load('entry',()=>{}, {signal:signal.signal}),cancelled=assert.rejects(loading,{code:'note_load_cancelled'});await drain();signal.abort();await cancelled;await f.note.disposeUnadmitted();
  assert.equal(f.note.hasAdmittedContent,false);assert.equal(f.checkpointReads,0);f.holdRead(undefined);
  const nextVault=new Vault(f.adapter);await nextVault.initialize();const next=new NoteBuffer(nextVault,'One.md');await next.load('entry');assert.equal(next.hasAdmittedContent,true);
  held.resolve();await drain();assert.equal(f.checkpointReads,1);assert.equal(f.note.hasAdmittedContent,false);assert.equal(next.text,'Original');assert.equal(f.calls.length,0);await next.dispose();
});

for(const invalid of ['ack-operation','ack-sequence','ack-status','rejected-with-ref','missing-token','null-ref','foreign-plan','bad-stat','null-operation'] as const)test(`invalid canonical ${invalid} cannot expose an editor or start checkpoint recovery`,async t=>{
  const f=await fixture(t);f.alterCheckpoint(raw=>{
    const op=raw.operation;
    if(invalid==='ack-operation')op.pendingAck={status:'committed',operationId:'foreign',sequence:'2'};
    if(invalid==='ack-sequence')op.pendingAck={status:'committed',operationId:op.ref.operationId,sequence:'invalid'};
    if(invalid==='ack-status')op.pendingAck={status:'other',operationId:op.ref.operationId,code:'other'};
    if(invalid==='rejected-with-ref')op.planningRejected='conditional_source_changed';
    if(invalid==='missing-token')delete op.ref.token;
    if(invalid==='null-ref')op.ref=null;
    if(invalid==='foreign-plan')op.plan.vaultId='foreign';
    if(invalid==='bad-stat')raw.base.stat.size=-1;
    if(invalid==='null-operation')raw.operation=null;
  });
  await assert.rejects(f.note.load('entry'));assert.equal(f.note.hasAdmittedContent,false);assert.equal(f.calls.length,0);assert.equal(f.queries.length,0);await f.note.disposeUnadmitted();
});

for(const [code,source] of [['invalid_durable_response','protocol'],['storage_busy','renderer'],['corrupt_storage','host']] as const)test(`terminal ${source} ${code} blocks later source planning while journal authoring remains available`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);f.failCAS(fault(code,source));await f.note.load('entry');await drain();
  f.note.update('D3 protected after terminal source error');await f.note.flushDraftProtection();const calls=f.calls.length;
  f.failCAS(undefined);f.note.coreAdmissionAvailable(f.writes.checkpoints.scope);t.mock.timers.tick(90000);await drain();
  assert.equal(f.calls.length,calls);assert.equal(f.plans.length,0);assert.equal(f.journal.at(-1)!.draft,'D3 protected after terminal source error');await assert.rejects(f.note.flush(),{code});
});

test('navigation may confirm independent protection while explicit close still joins the original held core barrier',async t=>{
  const f=await fixture(t),held=gate();f.holdCAS(held.promise);await f.note.load('entry');f.note.update('D3 before close');
  await f.note.flushForNavigation();assert.equal(f.note.dirty,true);assert.notEqual(f.note.savedText,'D3 before close');
  let closed=false;const closing=f.note.dispose().then(()=>{closed=true;});await drain();assert.equal(closed,false);assert.equal(f.calls.length,1);
  held.resolve();await closing;assert.equal(f.note.savedText,'D3 before close');assert.equal(f.note.dirty,false);
});

test('a loaded body cannot be readmitted after its capability or local scope is replaced',async t=>{
  const f=await fixture(t,{operation:false});await f.note.load('entry');
  const before=f.sourceReads;(f.writes.checkpoints.scope as {vaultId:string}).vaultId='foreign';
  await assert.rejects(f.note.load('entry'),{code:'intent_identity_mismatch'});assert.equal(f.sourceReads,before);assert.equal(f.calls.length,0);
  (f.writes.checkpoints.scope as {vaultId:string}).vaultId='load-authority';
});
