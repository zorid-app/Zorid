import test from 'node:test';
import assert from 'node:assert/strict';
import {NoteDraftProtection} from '../src/ui/note-draft-protection.ts';
import type {NoteDraftCapture} from '../src/ui/note-draft-protection.ts';
import type {DraftProtectionAcknowledgement} from '../src/ui/draft-protection.ts';
import type {IndependentDraftChange,IndependentDraftProvider,IndependentDraftReceipt,IndependentDraftRetirement} from '../src/core/independent-drafts.ts';

const scope={vaultId:'vault',clientId:'client',incarnationId:'renderer'};
const requestId='10000000-0000-4000-8000-000000000001';
const request=Object.freeze({captureId:requestId,logicalWitness:Object.freeze({entryId:'note',revision:'file-r1',path:'One.md'}),scope:Object.freeze({...scope})});
const capsule=(requests:readonly typeof request[]=[request])=>Object.freeze({schemaVersion:2,conflict:false,operation:null,checkpoint:null,captureRequests:Object.freeze([...requests])});
const capture=(pendingOperation:Readonly<object>|null=capsule(),draft='Saved',generation=0):NoteDraftCapture=>({writer:'writer',snapshot:{generation,baseline:{entryId:'note',path:'One.md',revision:'file-r1',content:'Saved'},draft,checkpointRevision:'checkpoint-r1',pendingOperation}});
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
function held<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
function receipt(value:IndependentDraftChange|IndependentDraftRetirement,deleted=false):IndependentDraftReceipt{return{...scope,entryId:value.entryId,writer:value.writer,generation:value.generation,revision:value.nextRevision,deleted};}
function fixture(){
  const gate=held<void>(),writes:IndependentDraftChange[]=[],retirements:IndependentDraftRetirement[]=[];
  let failed:unknown;
  const provider:IndependentDraftProvider={scope,list:async()=>[],read:async()=>null,compareAndSwap:async value=>{writes.push(value);await gate.promise;if(failed)throw failed;return receipt(value);},retire:async value=>{retirements.push(value);return receipt(value,true);}};
  const protection=new NoteDraftProtection({provider,writesScope:scope,coreCovered:()=>true,getCleanWitness:value=>({entryId:'note',writer:value.writer,generation:value.snapshot.generation,content:value.snapshot.draft,revision:'file-r1'})});
  protection.markInventory('ready');return{protection,writes,retirements,gate,fail(value?:unknown){failed=value;}};
}
const includes=(id:string)=>(ack:{request:IndependentDraftChange})=>JSON.parse(ack.request.pendingOperation??'null')?.captureRequests?.some((value:typeof request)=>value.captureId===id&&JSON.stringify(value.scope)===JSON.stringify(scope))===true;

test('a clean saved body with a capture-request capsule requires an actual journal ACK',async()=>{
  const f=fixture();
  try{
    f.protection.capture(capture());
    assert.equal(f.protection.status.currentProtected,false,'Core coverage cannot cover a live request ID');
    const barrier=f.protection.flush();await drain();
    assert.equal(f.writes.length,1);assert.equal(f.protection.status.currentJournalAcknowledged,false);assert.equal(f.protection.status.pending,true);
    f.gate.resolve();await barrier;
    assert.equal(f.protection.status.currentJournalAcknowledged,true);assert.equal(f.retirements.length,0,'a live request capsule cannot be retired as clean');
  }finally{f.gate.resolve();f.protection.stop();}
});

test('capture dispatch barrier remains pending until its exact ID, witness and scope actually ACK',async()=>{
  const f=fixture();let settled=false;
  try{
    f.protection.capture(capture());
    const barrier=f.protection.flushCapture(ack=>{
      const body=JSON.parse(ack.request.pendingOperation!);
      return body.schemaVersion===2&&body.captureRequests.some((value:unknown)=>JSON.stringify(value)===JSON.stringify(request));
    }).then(ack=>{settled=true;return ack;});
    await drain();assert.equal(f.writes.length,1);assert.equal(settled,false);assert.equal(f.protection.status.currentJournalAcknowledged,false);
    f.gate.resolve();const ack=await barrier;
    assert.equal(ack.request,f.writes[0]);assert.equal(ack.receipt.vaultId,scope.vaultId);assert.equal(ack.receipt.clientId,scope.clientId);assert.equal(ack.receipt.incarnationId,scope.incarnationId);assert.equal(f.retirements.length,0);
  }finally{f.gate.resolve();f.protection.stop();}
});

test('one capture waiter stays pending across the existing transient journal backoff and retries the same CAS',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.gate.resolve();f.fail(Object.assign(Error('Journal temporarily unavailable'),{code:'draft_storage_failure',source:'main'}));let settled=false;
  try{
    f.protection.capture(capture());const barrier=f.protection.flushCapture(includes(requestId)).then(ack=>{settled=true;return ack;});
    await drain();assert.equal(f.writes.length,1);assert.equal(settled,false);assert.equal(f.protection.status.retryPending,true);
    t.mock.timers.tick(499);await drain();assert.equal(f.writes.length,1);assert.equal(settled,false);
    f.fail();t.mock.timers.tick(1);const ack=await barrier;
    assert.equal(f.writes.length,2);assert.equal(f.writes[1],f.writes[0]);assert.equal(ack.request,f.writes[0]);assert.equal(f.protection.status.retryPending,false);
  }finally{f.protection.stop();}
});

test('coalescing later typing protects all live request IDs before either dispatch barrier resolves',async()=>{
  const f=fixture(),second=Object.freeze({...request,captureId:'10000000-0000-4000-8000-000000000002'});
  try{
    f.protection.capture(capture());const first=f.protection.flushCapture(includes(requestId));await drain();assert.equal(f.writes.length,1);
    f.protection.capture(capture(capsule([request,second]),'Newer raw typing',1));const later=f.protection.flushCapture(includes(second.captureId));
    f.gate.resolve();const [one,two]=await Promise.all([first,later]);
    assert.equal(one,two);assert.equal(one.request,f.writes.at(-1));assert.equal(one.request.draft,'Newer raw typing');assert.equal(includes(requestId)(one),true);assert.equal(includes(second.captureId)(two),true);
    assert.equal(f.retirements.length,0);
  }finally{f.gate.resolve();f.protection.stop();}
});

test('missing request or terminal protocol failure never resolves a generic ACK as dispatch authority',async()=>{
  const f=fixture();
  try{
    f.protection.capture(capture());f.gate.resolve();
    await assert.rejects(f.protection.flushCapture(includes('not-the-acknowledged-request')),{code:'draft_capture_unacknowledged',source:'protocol'});
    assert.equal(f.protection.status.currentJournalAcknowledged,true,'generic protection is distinct from an including-ID proof');
  }finally{f.protection.stop();}
  const terminal=fixture();terminal.gate.resolve();terminal.fail(Object.assign(Error('Bad response'),{code:'draft_storage_failure',source:'protocol'}));
  try{
    terminal.protection.capture(capture());await assert.rejects(terminal.protection.flushCapture(includes(requestId)),{source:'protocol'});
    const calls=terminal.writes.length;terminal.protection.availability();await drain();assert.equal(terminal.writes.length,calls);assert.equal(terminal.protection.status.retryPending,false);
  }finally{terminal.protection.stop();}
});

test('aborting one capture waiter removes its listener without discarding the other protected request',async t=>{
  const f=fixture(),cancelled=new AbortController();let added=0,removed=0,verified=0;
  const add=cancelled.signal.addEventListener,remove=cancelled.signal.removeEventListener;
  t.mock.method(cancelled.signal,'addEventListener',function(type,...args){if(type==='abort')added++;return Reflect.apply(add,this,[type,...args]);});
  t.mock.method(cancelled.signal,'removeEventListener',function(type,...args){if(type==='abort')removed++;return Reflect.apply(remove,this,[type,...args]);});
  try{
    f.protection.capture(capture());
    const first=f.protection.flushCapture(ack=>{verified++;return includes(requestId)(ack);},{signal:cancelled.signal});
    const other=f.protection.flushCapture(includes(requestId));await drain();cancelled.abort();await assert.rejects(first,{code:'draft_capture_cancelled'});
    assert.equal(added,1);assert.equal(removed,1);assert.equal(verified,0);assert.equal(f.writes.length,1);
    f.gate.resolve();const ack=await other;assert.equal(includes(requestId)(ack),true);assert.equal(verified,0);assert.equal(removed,1);
  }finally{f.gate.resolve();f.protection.stop();}
});

test('stopping the owner settles a transiently held waiter and cancels its existing timer',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),controller=new AbortController();let removed=0;
  const remove=controller.signal.removeEventListener;
  t.mock.method(controller.signal,'removeEventListener',function(type,...args){if(type==='abort')removed++;return Reflect.apply(remove,this,[type,...args]);});
  f.gate.resolve();f.fail(Object.assign(Error('Reply lost'),{code:'draft_transport_lost',source:'transport'}));f.protection.capture(capture());
  const barrier=f.protection.flushCapture(includes(requestId),{signal:controller.signal});await drain();assert.equal(f.protection.status.retryPending,true);
  f.protection.stop();await assert.rejects(barrier,{code:'draft_protection_stopped'});assert.equal(removed,1);
  const count=f.writes.length;t.mock.timers.tick(300_000);await drain();assert.equal(f.writes.length,count);
});

test('a request arriving while an empty inventory drain finishes waits for its own real ACK',async()=>{
  const f=fixture();let barrier!:Promise<DraftProtectionAcknowledgement>;
  try{
    queueMicrotask(()=>{f.protection.capture(capture());barrier=f.protection.flushCapture(includes(requestId));void barrier.catch(()=>{});});
    await drain();assert.equal(f.writes.length,1);
    f.gate.resolve();const ack=await barrier;assert.equal(includes(requestId)(ack),true);
  }finally{f.gate.resolve();f.protection.stop();}
});

for(const outcome of ['ack','mismatch','terminal'] as const)test(`capture waiter removes its abort listener after ${outcome}`,async t=>{
  const f=fixture(),controller=new AbortController();let removed=0;
  const remove=controller.signal.removeEventListener;
  t.mock.method(controller.signal,'removeEventListener',function(type,...args){if(type==='abort')removed++;return Reflect.apply(remove,this,[type,...args]);});
  try{
    f.gate.resolve();if(outcome==='terminal')f.fail(Object.assign(Error('Protocol failure'),{code:'invalid_draft_response',source:'protocol'}));
    f.protection.capture(capture());const barrier=f.protection.flushCapture(outcome==='mismatch'?()=>false:includes(requestId),{signal:controller.signal});
    if(outcome==='ack')await barrier;else await assert.rejects(barrier,outcome==='mismatch'?{code:'draft_capture_unacknowledged'}:{code:'invalid_draft_response'});
    assert.equal(removed,1);controller.abort();assert.equal(removed,1);
  }finally{f.protection.stop();}
});
