import test from 'node:test';
import assert from 'node:assert/strict';
import {DraftProtection} from '../src/ui/draft-protection.ts';
import type {DraftJournalChange,DraftJournalReceipt} from '../src/ui/draft-protection.ts';

const scope={vaultId:'vault',clientId:'client',incarnationId:'renderer'};
const receipt=(value:DraftJournalChange):DraftJournalReceipt=>({...scope,entryId:value.entryId,writer:value.writer,revision:value.nextRevision,generation:value.generation,deleted:false});
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
function held<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}

test('a journal ACK exposes the exact encoded CAS it accepted instead of the latest offered capture',async()=>{
  const gate=held<DraftJournalReceipt>(),writes:DraftJournalChange[]=[];
  const protection=new DraftProtection({entryId:'note',writer:'writer',transport:{scope,compareAndSwap:async value=>{writes.push(value);return writes.length===1?gate.promise:receipt(value);},retire:async()=>{throw Error('No retirement');}},encodePendingOperation:JSON.stringify});
  const base={entryId:'note',path:'One.md',revision:'file-r1',content:'Saved'};
  const first=protection.offer({generation:0,baseline:base,draft:'Saved',checkpointRevision:null,pendingOperation:Object.freeze({schemaVersion:2,captureId:'original-request'})});
  const firstBarrier=protection.flushThrough(first);await drain();assert.equal(writes.length,1);
  const second=protection.offer({generation:1,baseline:base,draft:'Newer draft',checkpointRevision:null,pendingOperation:Object.freeze({schemaVersion:2,captureId:'newer-request'})});
  gate.resolve(receipt(writes[0]));const ack=await firstBarrier;
  assert.equal(ack!.request,writes[0]);assert.equal(ack!.request.pendingOperation,'{"schemaVersion":2,"captureId":"original-request"}');
  assert.equal(Object.isFrozen(ack!.request),true);assert.equal(Object.isFrozen(ack!.request.baseline),true);
  const next=await protection.flushThrough(second);assert.equal(next!.request,writes[1]);assert.equal(next!.request.draft,'Newer draft');
});

test('reachability retains the ACKed write and the exact uncertain CAS until their responsibilities settle',async()=>{
  const writes:DraftJournalChange[]=[],lost=Object.assign(Error('Lost reply'),{code:'draft_transport_lost'});let fail=false;
  const protection=new DraftProtection({entryId:'note',writer:'writer',transport:{scope,compareAndSwap:async value=>{writes.push(value);if(fail)throw lost;return receipt(value);},retire:async value=>({...scope,entryId:value.entryId,writer:value.writer,generation:value.generation,revision:value.nextRevision,deleted:true})}});
  const snapshot=(draft:string,generation:number)=>({generation,baseline:{entryId:'note',path:'One.md',revision:'file-r1',content:'Saved'},draft,checkpointRevision:null,pendingOperation:'{"captureId":"kept-request"}'});
  const first=protection.offer(snapshot('First',1)),ack=(await protection.flushThrough(first))!;
  fail=true;const second=protection.offer(snapshot('Second',2));await assert.rejects(protection.flushThrough(second),error=>error===lost);
  assert.deepEqual(protection.retainedWriteRequests,[ack.request,writes[1]]);assert.equal(Object.isFrozen(protection.retainedWriteRequests),true);
  const third=protection.offer({...snapshot('Third',3),pendingOperation:null});assert.deepEqual(protection.retainedWriteRequests,[ack.request,writes[1]],'a later unsent capture cannot erase the exact uncertain request');
  fail=false;const final=(await protection.flushThrough(third))!;assert.equal(writes[2],writes[1],'uncertainty retries the identical CAS object');
  assert.deepEqual(protection.retainedWriteRequests,[final.request]);
  assert.equal(await protection.retireKnownClean(final,{entryId:'note',writer:'writer',generation:3,content:'Third',revision:'file-r2'}),true);
  assert.deepEqual(protection.retainedWriteRequests,[]);
});
