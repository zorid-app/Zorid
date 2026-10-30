import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {NoteBuffer} from '../src/ui/note-buffer.ts';
import {claimCaptureRequest} from '../src/ui/capture-request-cleanup.ts';
import type {Vault} from '../src/core/vault.ts';
import type {DurableWrites,ConditionalSavedSourceRequest} from '../src/core/durable-writes.ts';
import type {Checkpoint} from '../src/core/durable-checkpoints.ts';
import type {IndependentDraftProvider,IndependentDraftChange} from '../src/core/independent-drafts.ts';

function held<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(predicate:()=>boolean){for(let i=0;i<50&&!predicate();i++)await tick();assert.ok(predicate());}
const scope={vaultId:'capture-vault',clientId:'capture-client'},journalScope={...scope,incarnationId:'owned-document'};
const observed={entryId:'entry',revision:'source-1',path:'One.md',content:'Original source',stat:{ctime:1,mtime:1,size:15}};
async function fixture(t:TestContext,certificate=false){
  let head:Checkpoint|null=null,journalGate:ReturnType<typeof held>|undefined,coreGate:ReturnType<typeof held>|undefined;
  const journalRevisions=new Map<string,string>();
  let coreCalls=0,pendingQueries=0;
  const native:ConditionalSavedSourceRequest[]=[],journal:IndependentDraftChange[]=[],releases:string[]=[];
  const unavailable=async():Promise<never>=>{throw Error('Unexpected source mutation');};
  const writes:DurableWrites={checkpoints:{scope,load:async()=>head,compareAndSwap:async change=>{
    coreCalls++;if(coreGate)await coreGate.promise;
    head={version:1,...scope,key:change.key,revision:change.nextRevision,sequence:String(Number(head?.sequence??0)+1),encodedState:change.encodedState,deleted:change.encodedState===null,byteLength:Buffer.byteLength(change.encodedState??'')};return head;
  },list:async()=>({items:[],cursor:null,highWater:'0'}),changes:async()=>({items:[],cursor:null,highWater:'0'})},
    readText:async()=>structuredClone(observed),readTextById:async()=>structuredClone(observed),planWrite:unavailable,prepare:unavailable,commit:unavailable,query:unavailable,acknowledge:unavailable,listUnacknowledged:async()=>[],
    captureSavedSource:async request=>{native.push(structuredClone(request));return{captureId:request.captureId??'old-server-id',logicalWitness:request.logicalWitness??{entryId:observed.entryId,revision:observed.revision,path:observed.path},source:observed.content};},
    releaseSavedSource:async id=>{releases.push(id);},listSavedSourceRequests:async()=>{pendingQueries++;return[];},
  };
  const provider:IndependentDraftProvider={scope:journalScope,list:async()=>[],read:async()=>null,compareAndSwap:async request=>{
    journal.push(structuredClone(request));if(journalGate)await journalGate.promise;
    assert.equal(request.expectedRevision,journalRevisions.get(request.writer)??null);journalRevisions.set(request.writer,request.nextRevision);
    return{...journalScope,entryId:request.entryId,writer:request.writer,generation:request.generation,revision:request.nextRevision,deleted:false};
  },retire:async request=>({...journalScope,entryId:request.entryId,writer:request.writer,generation:request.generation,revision:request.nextRevision,deleted:true})};
  if(certificate)provider.isRetiredIncarnation=async()=>false;
  const vault={adapter:{durableWrites:writes,independentDrafts:provider},entries:new Map([['One.md',{entryId:'entry'}]]),readDurableText:writes.readText,readDurableTextById:writes.readTextById} as unknown as Vault;
  const buffer=new NoteBuffer(vault,'One.md',{debounceMs:60000});await buffer.load('entry');t.after(()=>buffer.closeMetadataProjection());
  return{buffer,vault,writes,provider,native,journal,releases,get pendingQueries(){return pendingQueries;},get coreCalls(){return coreCalls;},holdCore(){return coreGate=held();},releaseCore(){coreGate?.resolve();coreGate=undefined;},holdJournal(){return journalGate=held();},releaseJournal(){journalGate?.resolve();journalGate=undefined;}};
}

test('healthy ordinary note opening never queries pending saved-source requests',async t=>{
  const f=await fixture(t,true);await tick();await tick();
  assert.equal(f.buffer.hasAdmittedContent,true);assert.equal(f.buffer.text,observed.content);assert.equal(f.buffer.dirty,false);
  assert.equal(f.pendingQueries,0,'Ordinary admission must not run Native capture cleanup');assert.deepEqual(f.native,[]);assert.deepEqual(f.journal,[]);
});

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

test('request identity becomes journal protected while an earlier canonical Rust checkpoint is held',async t=>{
  const f=await fixture(t);f.holdCore();f.buffer.update('Later independent draft');await until(()=>f.coreCalls===1);
  const pending=f.buffer.captureConditionalSavedSource({entryId:'entry',revision:'source-1',path:'One.md'});void pending.catch(()=>{});
  await tick();await tick();await tick();
  const protectedRequest=f.journal.find(row=>row.pendingOperation&&JSON.parse(row.pendingOperation).captureRequests?.length);
  assert.ok(protectedRequest,'Request capture must not wait behind the Rust save queue');assert.equal(protectedRequest.draft,'Later independent draft');assert.equal(f.native.length,0);
  f.releaseCore();const capture=await pending;assert.ok(capture);await f.buffer.releaseConditionalSavedSource(capture);
});

const witness={entryId:'entry',revision:'source-1',path:'One.md'};
test('multiple live capture requests survive coalescing and exact release keeps the other claim and newer typing',async t=>{
  const f=await fixture(t),first=await f.buffer.captureConditionalSavedSource(witness);assert.ok(first);
  const second=await f.buffer.captureConditionalSavedSource(witness);assert.ok(second);assert.notEqual(first.captureId,second.captureId);
  await f.buffer.flushDraftProtection();let capsule=JSON.parse(f.journal.at(-1)!.pendingOperation!);assert.deepEqual(capsule.captureRequests.map((r:any)=>r.captureId),[first.captureId,second.captureId]);
  f.buffer.update('Newer typing');await f.buffer.releaseConditionalSavedSource(first);await f.buffer.flushDraftProtection();
  capsule=JSON.parse(f.journal.at(-1)!.pendingOperation!);assert.deepEqual(capsule.captureRequests.map((r:any)=>r.captureId),[second.captureId]);assert.equal(f.journal.at(-1)!.draft,'Newer typing');assert.equal(f.buffer.dirty,true);
  await f.buffer.releaseConditionalSavedSource(second);
});
test('the bounded collection rejects a ninth unresolved identity before Native dispatch',async t=>{
  const f=await fixture(t),captures=[];
  for(let i=0;i<8;i++)captures.push((await f.buffer.captureConditionalSavedSource(witness))!);
  await assert.rejects(f.buffer.captureConditionalSavedSource(witness),/too many retained/);assert.equal(f.native.length,8);
  for(const capture of captures)await f.buffer.releaseConditionalSavedSource(capture);
});
test('trusted capacity and unknown IO retry the same protected request without creating another claim',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);let calls=0;const requests:ConditionalSavedSourceRequest[]=[];
  f.writes.captureSavedSource=async request=>{requests.push(request);if(++calls<=2)throw Object.assign(Error('waiting'),{code:calls===1?'source_capture_capacity':'storage_io_retryable',source:'host'});return{...request,source:observed.content};};
  const pending=f.buffer.captureConditionalSavedSource(witness);await until(()=>calls===1);t.mock.timers.tick(499);await tick();assert.equal(calls,1);t.mock.timers.tick(1);await until(()=>calls===2);t.mock.timers.tick(1500);
  const capture=await pending;assert.ok(capture);assert.equal(calls,3);assert.equal(new Set(requests.map(r=>r.captureId)).size,1);assert.deepEqual(requests[0],requests[2]);await f.buffer.releaseConditionalSavedSource(capture);
});
for(const source of['protocol','transport','renderer'])test(`untrusted ${source} capacity cannot authorize automatic replay`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);let calls=0;
  f.writes.captureSavedSource=async()=>{calls++;throw Object.assign(Error('untrusted'),{code:'source_capture_capacity',source});};
  await assert.rejects(f.buffer.captureConditionalSavedSource(witness),/untrusted/);t.mock.timers.tick(90000);await tick();assert.equal(calls,1);
});
test('cancellation during a lost Native reply fences only its original ID and never adopts the late capture',async t=>{
  const f=await fixture(t),gate=held<{captureId:string;logicalWitness:typeof witness;source:string}>();let request:ConditionalSavedSourceRequest|undefined;
  f.writes.captureSavedSource=async value=>{request=value;return gate.promise;};
  const pending=f.buffer.captureConditionalSavedSource(witness);void pending.catch(()=>{});await until(()=>!!request);
  const closing=f.buffer.dispose();await assert.rejects(pending,/cancelled|closing/);await closing;assert.deepEqual(f.releases,[request!.captureId]);
  gate.resolve({...request!,source:observed.content});await tick();assert.equal(f.buffer.text,observed.content);assert.equal(f.buffer.dirty,false);
});
test('cancel while the including-ID ACK is held dispatches no Native capture and joins exact cleanup',async t=>{
  const f=await fixture(t);f.holdJournal();const pending=f.buffer.captureConditionalSavedSource(witness);void pending.catch(()=>{});await until(()=>f.journal.length===1);
  const id=JSON.parse(f.journal[0].pendingOperation!).captureRequests[0].captureId,closing=f.buffer.dispose();
  await assert.rejects(pending,/closing/);assert.equal(f.native.length,0);assert.deepEqual(f.releases,[id]);f.releaseJournal();await closing;
});
function abandonedCandidate(captureId:string,overrides:Record<string,unknown>={}){
  const entryId=typeof overrides.entryId==='string'?overrides.entryId:'entry',candidateWitness={...witness,entryId};
  return{...journalScope,incarnationId:'retired-document',entryId,writer:'retired-writer',revision:'1',generation:0,deleted:false as const,baseline:{entryId,revision:'source-1',path:'One.md',content:observed.content},draft:observed.content,checkpointRevision:null,
    pendingOperation:JSON.stringify({schemaVersion:2,conflict:false,operation:null,checkpoint:null,captureRequests:[{captureId,logicalWitness:candidateWitness,scope:{...journalScope,incarnationId:'retired-document'}}]}),...overrides};
}
for(const certificate of[true,false,undefined,'unknown'] as const)test(`restart cleanup requires a positive retired-owner certificate (${certificate}) and uses targeted lookups`,async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),candidate=abandonedCandidate(id),listed:unknown[]=[];
  f.provider.list=async options=>{assert.deepEqual(options,{entryId:'entry'});listed.push(options);return[candidate];};f.provider.read=async address=>address.writer===candidate.writer&&address.incarnationId===candidate.incarnationId?candidate:null;
  if(certificate!==undefined)f.provider.isRetiredIncarnation=async()=>{if(certificate==='unknown')throw Error('unknown');return certificate;};
  f.writes.listSavedSourceRequests=async()=>[{captureId:id,logicalWitness:witness,legacy:false}];
  const restarted=new NoteBuffer(f.vault,'One.md',{debounceMs:60000});t.after(()=>restarted.closeMetadataProjection());await restarted.load('entry');const own=await restarted.captureConditionalSavedSource(witness);
  assert.equal(restarted.text,observed.content);assert.ok(listed.length);assert.deepEqual(f.releases,certificate===true?[id]:[]);if(own)await restarted.releaseConditionalSavedSource(own);
});
test('a malformed v1 capsule is retained rather than relaxed into the new request schema',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),candidate=abandonedCandidate(id);const capsule=JSON.parse(candidate.pendingOperation);capsule.schemaVersion=1;candidate.pendingOperation=JSON.stringify(capsule);
  f.provider.list=async()=>[candidate];f.provider.read=async address=>address.writer===candidate.writer&&address.incarnationId===candidate.incarnationId?candidate:null;f.provider.isRetiredIncarnation=async()=>true;f.writes.listSavedSourceRequests=async()=>[{captureId:id,logicalWitness:witness,legacy:false}];
  const restarted=new NoteBuffer(f.vault,'One.md');t.after(()=>restarted.closeMetadataProjection());await restarted.load('entry');await tick();await tick();assert.deepEqual(f.releases,[]);
});

test('a dirty schema2 capture-only capsule restores the raw draft without inventing a transform',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),candidate=abandonedCandidate(id,{generation:2,draft:'Protected raw later typing'});
  f.provider.list=async()=>[candidate];f.provider.read=async address=>address.writer===candidate.writer&&address.incarnationId===candidate.incarnationId?candidate:null;
  const restarted=new NoteBuffer(f.vault,'One.md',{debounceMs:60000});t.after(()=>restarted.closeMetadataProjection());await restarted.load('entry');
  assert.equal(restarted.text,'Protected raw later typing');assert.equal(restarted.savedText,observed.content);assert.equal(restarted.dirty,true);assert.equal(f.native.length,0);
});
test('a schema2 wrapper preserves the original uncertain pure checkpoint while restoring later raw typing',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),candidate=abandonedCandidate(id,{generation:2,draft:'Later raw draft'});
  const original={key:'note/v1/entry',expectedRevision:null,nextRevision:crypto.randomUUID(),encodedState:JSON.stringify({version:1,writer:candidate.writer,generation:1,base:observed,draft:'Original queued checkpoint',conflict:false})};
  const capsule=JSON.parse(candidate.pendingOperation);capsule.checkpoint=original;candidate.pendingOperation=JSON.stringify(capsule);
  f.provider.list=async()=>[candidate];f.provider.read=async address=>address.writer===candidate.writer&&address.incarnationId===candidate.incarnationId?candidate:null;
  const changes:unknown[]=[],cas=f.writes.checkpoints.compareAndSwap;f.writes.checkpoints.compareAndSwap=async request=>{changes.push(structuredClone(request));return cas(request);};
  const restarted=new NoteBuffer(f.vault,'One.md',{debounceMs:60000});t.after(()=>restarted.closeMetadataProjection());await restarted.load('entry');await until(()=>changes.length>0);
  assert.equal(restarted.text,'Later raw draft');assert.deepEqual(changes[0],original);assert.equal(f.native.length,0);
});
test('eight unopened retired requests are cleaned through eight targeted entries before fresh Native admission',async t=>{
  const f=await fixture(t),pending=new Map<string,{captureId:string;logicalWitness:typeof witness;legacy:false}>(),candidates=new Map<string,ReturnType<typeof abandonedCandidate>>(),lookups:string[]=[],certificates:string[]=[];
  for(let i=0;i<8;i++){const captureId=crypto.randomUUID(),logicalWitness={entryId:`unopened-${i}`,revision:'source-1',path:`Unopened-${i}.md`},candidate=abandonedCandidate(captureId,{entryId:logicalWitness.entryId,baseline:{...observed,...logicalWitness},writer:`old-${i}`});
    const capsule=JSON.parse(candidate.pendingOperation);capsule.captureRequests[0].logicalWitness=logicalWitness;candidate.pendingOperation=JSON.stringify(capsule);candidates.set(logicalWitness.entryId,candidate);pending.set(captureId,{captureId,logicalWitness,legacy:false});}
  f.writes.listSavedSourceRequests=async()=>[...pending.values()];f.writes.releaseSavedSource=async id=>{f.releases.push(id);pending.delete(id);};
  f.provider.isRetiredIncarnation=async id=>{certificates.push(id);return true;};f.provider.list=async options=>{assert.ok(options?.entryId);lookups.push(options.entryId);return candidates.has(options.entryId)?[candidates.get(options.entryId)!]:[];};
  f.provider.read=async address=>{assert.ok(certificates.length);return candidates.get(address.entryId)??null;};
  const capture=f.writes.captureSavedSource!;f.writes.captureSavedSource=async request=>{assert.equal(pending.size,0);return capture(request);};
  const own=await f.buffer.captureConditionalSavedSource(witness);assert.equal(f.releases.length,8);assert.equal(lookups.length,8);assert.deepEqual(new Set(lookups),new Set([...candidates.keys()]));assert.ok(own);await f.buffer.releaseConditionalSavedSource(own);
});
for(const kind of['canonical','uncertain-checkpoint','journal-v1','journal-v2','corrupt','legacy'] as const)test(`${kind} evidence prevents unsafe retirement of an unopened request`,async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),candidate=abandonedCandidate(id,{entryId:'unopened'}),logicalWitness={...witness,entryId:'unopened'},capsule=JSON.parse(candidate.pendingOperation);
  capsule.captureRequests[0].logicalWitness=logicalWitness;candidate.pendingOperation=JSON.stringify(capsule);
  const operation={content:'accepted',input:{conditionalSavedSource:{captureId:id,logicalWitness}}},state={version:1,writer:candidate.writer,generation:1,base:{...observed,entryId:'unopened'},draft:'accepted',conflict:false,operation};
  if(kind==='uncertain-checkpoint'){capsule.checkpoint={key:'note/v1/unopened',expectedRevision:null,nextRevision:crypto.randomUUID(),encodedState:JSON.stringify(state)};candidate.pendingOperation=JSON.stringify(capsule);}
  if(kind==='journal-v1'||kind==='journal-v2'){capsule.operation=operation;if(kind==='journal-v1'){capsule.schemaVersion=1;delete capsule.captureRequests;}candidate.pendingOperation=JSON.stringify(capsule);}
  if(kind==='corrupt')candidate.pendingOperation='{ corrupt';
  f.provider.list=async options=>options?.entryId==='unopened'?[candidate]:[];f.provider.read=async address=>address.entryId==='unopened'?candidate:null;f.provider.isRetiredIncarnation=async()=>true;
  f.writes.listSavedSourceRequests=async()=>[{captureId:id,logicalWitness,legacy:kind==='legacy'}];
  if(kind==='canonical')f.writes.checkpoints.load=async key=>key==='note/v1/unopened'?{version:1,...scope,key,revision:crypto.randomUUID(),sequence:'1',encodedState:JSON.stringify(state),deleted:false,byteLength:Buffer.byteLength(JSON.stringify(state))}:null;
  const own=await f.buffer.captureConditionalSavedSource(witness);assert.deepEqual(f.releases,[]);assert.ok(own);await f.buffer.releaseConditionalSavedSource(own);
});
test('an invalid reply cannot make cleanup release a foreign response ID',async t=>{
  const f=await fixture(t);let requestId='';f.writes.captureSavedSource=async request=>{requestId=request.captureId;return{...request,captureId:crypto.randomUUID(),source:observed.content};};
  await assert.rejects(f.buffer.captureConditionalSavedSource(witness),/invalid conditional/);assert.deepEqual(f.releases,[requestId]);
});
test('lost release ACK retries the same ID with typed transport backoff and retains journal responsibility until acknowledged',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t),capture=(await f.buffer.captureConditionalSavedSource(witness))!;let calls=0;const seen:string[]=[];
  f.writes.releaseSavedSource=async id=>{seen.push(id);if(++calls===1)throw Object.assign(Error('lost ACK'),{code:'durable_transport_lost',source:'transport'});};
  const dropping=f.buffer.releaseConditionalSavedSource(capture);await until(()=>calls===1);await tick();assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'unattached');t.mock.timers.tick(500);await dropping;
  assert.deepEqual(seen,[capture.captureId,capture.captureId]);assert.equal(f.buffer.conditionalSavedSourceStatus(capture),'settled');
});

test('eight old same-note claims are reclaimed while unrelated current typing and a current request stay protected',async t=>{
  const f=await fixture(t),pending=new Map<string,{captureId:string;logicalWitness:typeof witness;legacy:false}>(),old=[];
  for(let i=0;i<8;i++){const captureId=crypto.randomUUID();old.push(abandonedCandidate(captureId,{writer:`old-${i}`}));pending.set(captureId,{captureId,logicalWitness:witness,legacy:false});}
  f.buffer.update('Current raw typing');await until(()=>f.journal.length>0);
  const current=()=>({...journalScope,entryId:'entry',writer:f.journal.at(-1)!.writer,revision:'1',generation:f.journal.at(-1)!.generation,deleted:false as const,baseline:f.journal.at(-1)!.baseline,draft:f.journal.at(-1)!.draft,checkpointRevision:f.journal.at(-1)!.checkpointRevision,pendingOperation:f.journal.at(-1)!.pendingOperation});
  f.writes.listSavedSourceRequests=async()=>[...pending.values()];f.writes.releaseSavedSource=async id=>{f.releases.push(id);pending.delete(id);};
  f.provider.list=async options=>{assert.deepEqual(options,{entryId:'entry'});return[...old,current()];};
  f.provider.read=async address=>address.incarnationId===journalScope.incarnationId?current():old.find(row=>row.writer===address.writer)??null;
  const certified:string[]=[];f.provider.isRetiredIncarnation=async incarnation=>{certified.push(incarnation);assert.notEqual(incarnation,journalScope.incarnationId);return true;};
  const acquire=f.writes.captureSavedSource!;f.writes.captureSavedSource=async request=>{assert.equal(pending.size,0,'Old same-note guards must not strand Native capacity');return acquire(request);};
  const own=await f.buffer.captureConditionalSavedSource(witness);assert.ok(own);assert.equal(f.releases.length,8);assert.ok(certified.length);assert.equal(f.buffer.text,'Current raw typing');assert.equal(f.journal.at(-1)!.draft,'Current raw typing');assert.ok(JSON.parse(f.journal.at(-1)!.pendingOperation!).captureRequests.some((request:any)=>request.captureId===own.captureId));await f.buffer.releaseConditionalSavedSource(own);
});
for(const kind of['candidate-body','candidate-checkpoint-reference','checkpoint-revision','checkpoint-sequence','checkpoint-byteLength'] as const)test(`malformed ${kind} evidence cannot authorize cleanup`,async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),candidate=abandonedCandidate(id,{entryId:'unopened'}),logicalWitness={...witness,entryId:'unopened'},capsule=JSON.parse(candidate.pendingOperation);
  capsule.captureRequests[0].logicalWitness=logicalWitness;candidate.pendingOperation=JSON.stringify(capsule);
  if(kind==='candidate-body')(candidate as any).draft=42;if(kind==='candidate-checkpoint-reference')(candidate as any).checkpointRevision='not-a-uuid';
  f.provider.list=async options=>options?.entryId==='unopened'?[candidate]:[];f.provider.read=async()=>candidate;f.provider.isRetiredIncarnation=async()=>true;f.writes.listSavedSourceRequests=async()=>[{captureId:id,logicalWitness,legacy:false}];
  if(kind.startsWith('checkpoint-')){const encodedState=JSON.stringify({version:1,writer:candidate.writer,generation:0,base:{...observed,entryId:'unopened'},draft:observed.content,conflict:false});
    f.writes.checkpoints.load=async key=>({version:1,...scope,key,revision:kind==='checkpoint-revision'?'invalid':crypto.randomUUID(),sequence:kind==='checkpoint-sequence'?'0':'1',encodedState,deleted:false,byteLength:Buffer.byteLength(encodedState)+(kind==='checkpoint-byteLength'?1:0)});}
  const own=await f.buffer.captureConditionalSavedSource(witness);assert.deepEqual(f.releases,[]);if(own)await f.buffer.releaseConditionalSavedSource(own);
});

test('a current actor loading an old operation guard during journal lookup prevents cleanup release before it can adopt or author',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),old=abandonedCandidate(id),lookup=held(),entered=held();let hold=true,adopterRead=false,adopted=false;
  f.writes.listSavedSourceRequests=async()=>[{captureId:id,logicalWitness:witness,legacy:false}];f.provider.isRetiredIncarnation=async()=>true;
  f.provider.list=async()=>[old];f.provider.read=async address=>{if(address.writer!==old.writer)return null;if(hold){entered.resolve();await lookup.promise;}return old;};
  const ownPending=f.buffer.captureConditionalSavedSource(witness);await entered.promise;
  const input={operationId:crypto.randomUUID(),path:'One.md',expectedEntryId:'entry',expectedRevision:'source-1',expectedContent:observed.content,content:'Original accepted transform',conditionalSavedSource:{captureId:id,logicalWitness:witness}};
  const encodedState=JSON.stringify({version:1,writer:'adopting-writer',generation:1,base:observed,draft:input.content,conflict:false,operation:{input,content:input.content}});
  const head:Checkpoint={version:1,...scope,key:'note/v1/entry',revision:crypto.randomUUID(),sequence:'1',encodedState,deleted:false,byteLength:Buffer.byteLength(encodedState)};
  f.writes.checkpoints.load=async()=>{if(adopterRead){adopterRead=false;return head;}return null;};adopterRead=true;
  const adopter=new NoteBuffer(f.vault,'One.md',{debounceMs:60000});t.after(()=>adopter.closeMetadataProjection());const loading=adopter.load('entry').then(()=>{adopted=true;});
  await tick();await tick();assert.equal(adopterRead,false);assert.equal(adopted,false,'Contending actor must join the gate before adopting or journaling its old guard');assert.equal(f.journal.some(row=>row.writer==='adopting-writer'),false);
  hold=false;lookup.resolve();const own=await ownPending;await loading;
  assert.ok(own);assert.equal(adopted,true);assert.deepEqual(f.releases,[]);assert.equal(adopter.text,input.content);assert.equal(f.native.length,1);await f.buffer.releaseConditionalSavedSource(own);
});
test('a current journal operation referencing the retired ID blocks release even when the owning old incarnation is certified',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),old=abandonedCandidate(id),live=abandonedCandidate(crypto.randomUUID(),{writer:'live-writer',incarnationId:journalScope.incarnationId});
  const capsule=JSON.parse(live.pendingOperation);capsule.captureRequests[0].scope=journalScope;capsule.operation={content:'accepted',input:{conditionalSavedSource:{captureId:id,logicalWitness:witness}}};live.pendingOperation=JSON.stringify(capsule);
  f.provider.list=async()=>[old,live];f.provider.read=async address=>address.writer===old.writer?old:live;f.provider.isRetiredIncarnation=async incarnation=>{assert.equal(incarnation,old.incarnationId);return true;};f.writes.listSavedSourceRequests=async()=>[{captureId:id,logicalWitness:witness,legacy:false}];
  const own=await f.buffer.captureConditionalSavedSource(witness);assert.deepEqual(f.releases,[]);assert.ok(own);await f.buffer.releaseConditionalSavedSource(own);
});

for(const unknown of[false,true])test(`an unrelated old journal owner's ${unknown?'unknown':'live'} certificate is not abandonment authority for the selected request`,async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),old=abandonedCandidate(id),unrelated=abandonedCandidate(crypto.randomUUID(),{writer:'unrelated-writer',incarnationId:'other-owner'});
  const capsule=JSON.parse(unrelated.pendingOperation);capsule.captureRequests[0].scope.incarnationId='other-owner';unrelated.pendingOperation=JSON.stringify(capsule);
  f.provider.list=async()=>[old,unrelated];f.provider.read=async address=>address.writer===old.writer?old:unrelated;
  f.provider.isRetiredIncarnation=async incarnation=>{if(incarnation===old.incarnationId)return true;if(unknown)throw Error('Unknown unrelated owner');return false;};f.writes.listSavedSourceRequests=async()=>[{captureId:id,logicalWitness:witness,legacy:false}];
  const own=await f.buffer.captureConditionalSavedSource(witness);assert.deepEqual(f.releases,[id]);assert.ok(own);await f.buffer.releaseConditionalSavedSource(own);
});

test('cancelling a capture does not wait for an unrelated held orphan-proof lookup',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),old=abandonedCandidate(id),lookup=held(),entered=held();
  f.writes.listSavedSourceRequests=async()=>[{captureId:id,logicalWitness:witness,legacy:false}];f.provider.isRetiredIncarnation=async()=>true;f.provider.list=async()=>[old];
  f.provider.read=async()=>{entered.resolve();await lookup.promise;return old;};
  const pending=f.buffer.captureConditionalSavedSource(witness);let rejected=false;void pending.catch(()=>{rejected=true;});await entered.promise;
  const ownId=JSON.parse(f.journal.at(-1)!.pendingOperation!).captureRequests[0].captureId,closing=f.buffer.dispose();void closing.catch(()=>{});await tick();await tick();
  assert.equal(rejected,true,'Owner cancellation must not wait for unrelated background evidence IO');assert.ok(f.releases.includes(ownId));assert.equal(f.native.length,0);
  lookup.resolve();await assert.rejects(pending,/closing/);await closing;
});

test('a malformed ACK after Native accepted cleanup keeps the ID sealed until an actual capture from a new actor retries that ID even with no pending row',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),old=abandonedCandidate(id);let pending=true,calls=0;
  f.writes.listSavedSourceRequests=async()=>pending?[{captureId:id,logicalWitness:witness,legacy:false}]:[];f.provider.isRetiredIncarnation=async()=>true;f.provider.list=async()=>[old];
  f.provider.read=async address=>address.writer===old.writer&&address.incarnationId===old.incarnationId?old:null;
  f.writes.releaseSavedSource=async captureId=>{f.releases.push(captureId);if(captureId===id){pending=false;if(++calls===1)throw Object.assign(Error('Malformed release ACK'),{code:'invalid_durable_response',source:'protocol'});}};
  const own=await f.buffer.captureConditionalSavedSource(witness);assert.ok(own);assert.equal(calls,1);assert.equal(pending,false);
  assert.throws(()=>claimCaptureRequest(scope,id,{}),{code:'capture_cleanup_unsettled'});
  const next=new NoteBuffer(f.vault,'One.md',{debounceMs:60000});t.after(()=>next.closeMetadataProjection());await next.load('entry');assert.equal(calls,1,'Ordinary note admission must not retry cleanup');const nextCapture=await next.captureConditionalSavedSource(witness);assert.ok(nextCapture);await until(()=>calls===2);await tick();
  assert.throws(()=>claimCaptureRequest(scope,id,{}),{code:'capture_request_released'});assert.deepEqual(f.releases,[id,id]);assert.deepEqual(f.native.map(request=>request.captureId),[own.captureId,nextCapture.captureId],'Only the two explicitly requested captures dispatch; cleanup never recaptures the orphan ID');await f.buffer.releaseConditionalSavedSource(own);await next.releaseConditionalSavedSource(nextCapture);
});
test('a cancelled unadmitted actor cannot claim an old guard after its contended proof wait wakes',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),old=abandonedCandidate(id),lookup=held(),entered=held();let hold=true,adopterRead=false;
  f.writes.listSavedSourceRequests=async()=>[{captureId:id,logicalWitness:witness,legacy:false}];f.provider.isRetiredIncarnation=async()=>true;f.provider.list=async()=>[old];
  f.provider.read=async address=>{if(address.writer!==old.writer)return null;if(hold){entered.resolve();await lookup.promise;}return old;};
  const ownPending=f.buffer.captureConditionalSavedSource(witness);await entered.promise;
  const input={operationId:crypto.randomUUID(),path:'One.md',expectedEntryId:'entry',expectedRevision:'source-1',expectedContent:observed.content,content:'Original accepted transform',conditionalSavedSource:{captureId:id,logicalWitness:witness}};
  const encodedState=JSON.stringify({version:1,writer:'cancelled-adopter',generation:1,base:observed,draft:input.content,conflict:false,operation:{input,content:input.content}});
  const head:Checkpoint={version:1,...scope,key:'note/v1/entry',revision:crypto.randomUUID(),sequence:'1',encodedState,deleted:false,byteLength:Buffer.byteLength(encodedState)};
  f.writes.checkpoints.load=async()=>{if(adopterRead){adopterRead=false;return head;}return null;};adopterRead=true;
  const adopter=new NoteBuffer(f.vault,'One.md'),loading=adopter.load('entry');void loading.catch(()=>{});await tick();await tick();assert.equal(adopterRead,false);await adopter.disposeUnadmitted();await assert.rejects(loading);
  hold=false;lookup.resolve();const own=await ownPending;assert.ok(own);await tick();await tick();assert.equal(f.journal.some(row=>row.writer==='cancelled-adopter'),false);assert.deepEqual(f.releases,[]);
  const second=await f.buffer.captureConditionalSavedSource(witness);assert.ok(second);assert.deepEqual(f.releases,[id],'Dead adopter must not strand the abandoned pending slot');await f.buffer.releaseConditionalSavedSource(own);await f.buffer.releaseConditionalSavedSource(second);
});

test('new actor positive admission wakes an exact release still waiting in a retired actor, while ordinary cleanup does not self-admit',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t),id=crypto.randomUUID(),old=abandonedCandidate(id);let pending=true,calls=0;
  f.writes.listSavedSourceRequests=async()=>pending?[{captureId:id,logicalWitness:witness,legacy:false}]:[];f.provider.isRetiredIncarnation=async()=>true;f.provider.list=async()=>[old];f.provider.read=async address=>address.writer===old.writer&&address.incarnationId===old.incarnationId?old:null;
  f.writes.releaseSavedSource=async captureId=>{f.releases.push(captureId);if(captureId===id){if(++calls===1)throw Object.assign(Error('Old host exited'),{code:'host_exited',source:'host'});pending=false;}};
  const capture=f.buffer.captureConditionalSavedSource(witness);void capture.catch(()=>{});await until(()=>calls===1);await tick();const closing=f.buffer.dispose();await assert.rejects(capture,/closing/);await closing;
  const next=new NoteBuffer(f.vault,'One.md',{debounceMs:60000});t.after(()=>next.closeMetadataProjection());await next.load('entry');await tick();t.mock.timers.tick(90000);await tick();assert.equal(calls,1,'Background retry must not invent positive admission for the retired release owner');
  next.coreAdmissionAvailable({...scope,clientId:'wrong-client'});await tick();assert.equal(calls,1);next.coreAdmissionAvailable(scope);await until(()=>calls===2);await tick();
  assert.equal(pending,false);assert.equal(f.releases.filter(value=>value===id).length,2);assert.equal(f.native.length,0);assert.throws(()=>claimCaptureRequest(scope,id,{}),{code:'capture_request_released'});
});
