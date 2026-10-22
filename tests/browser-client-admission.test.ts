import test from 'node:test';
import assert from 'node:assert/strict';
import { admitBrowserFixtureClient } from '../src/platform/browser-client-admission.ts';
import type { BrowserFlushContext } from '../src/platform/browser-client-admission.ts';
import type { BrowserCoreRuntime } from '../src/platform/browser-core-runtime.ts';
import type { BrowserVaultIntent, BrowserVaultRead } from '../src/core/browser-vault.ts';
import type { CheckpointChange } from '../src/core/durable-checkpoints.ts';
import { BrowserVaultError } from '../src/core/browser-vault.ts';

function deferred() { let resolve!:()=>void; const promise=new Promise<void>(done=>{resolve=done;}); return {promise,resolve}; }
const failure=(code:string)=>new BrowserVaultError(code,'fixture failure');
function fixture() {
  const scope=Object.freeze({vaultId:'11111111-1111-4111-8111-111111111111',clientId:'22222222-2222-4222-8222-222222222222'});
  const entry:BrowserVaultRead={entry:{id:'entry-a',path:'Note.md',kind:'file',revision:'r1',deleted:false},
    bytes:new TextEncoder().encode('old'),presentation:{id:'entry-a',ctime_ms:1,mtime_ms:2,size_bytes:3}};
  const rows:BrowserVaultIntent[]=[];
  const events:string[]=[];
  let active=true, owner=true, releaseCount=0, loseRelease=false;
  let loadWait:Promise<void>|undefined, listWait:Promise<void>|undefined, casWait:Promise<void>|undefined;
  const backend={
    durableScope:scope,
    assertActive(){if(!active)throw failure('client_ownership_lost');},
    installAdmissionGuard(){ /* Actual queue/dispatch guard is tested on BrowserCoreRuntime. */ },
    checkpoints:{scope,
      async load(){events.push('load');if(loadWait)await loadWait;return null;},
      async compareAndSwap(input:CheckpointChange){const captured={...input};events.push('cas');if(casWait)await casWait;
        return {version:1 as const,...scope,...captured,revision:captured.nextRevision,sequence:'1',deleted:captured.encodedState===null,byteLength:captured.encodedState?.length??0};},
      async list(){return {items:[],cursor:null,highWater:'0'};},async changes(){return {items:[],cursor:null,highWater:'0'};},
    },
    async inventory(){return [structuredClone(entry)];},
    async readEntry(){return structuredClone(entry);},async readEntryById(){return structuredClone(entry);},
    async execute(){throw new Error('legacy write forbidden');},
    async prepare(token:string,json:string){events.push('prepare');rows.push({client_id:scope.clientId,intent_id:token,operation_id:token,request_json:json,order:'1',status:'prepared',acknowledged:false});},
    async intents(){events.push('intents');if(listWait)await listWait;return structuredClone(rows);},
    async commit(token:string){events.push('commit');const row=rows.find(value=>value.intent_id===token)!;row.status='committed';
      row.receipt=JSON.stringify({operation_id:token,sequence:'1',changes:[{before:entry.entry,after:{...entry.entry,revision:'r2'}}]});return row.receipt;},
    async acknowledge(){events.push('ack');},subscribe(){return ()=>{};},close(){active=false;},
    async releaseClient(){events.push('release');releaseCount++;if(loseRelease){loseRelease=false;throw failure('outcome_unknown');}active=false;},
  };
  const runtime=backend as unknown as BrowserCoreRuntime;
  const admit=()=>admitBrowserFixtureClient(runtime,{fixture:true,assertOwner:()=>{if(!owner)throw failure('owner_retired');}});
  return {scope,runtime,backend,events,admit,die(){active=false;},retire(){owner=false;},loseRelease(){loseRelease=true;},
    get releaseCount(){return releaseCount;},loadWait(value?:Promise<void>){loadWait=value;},listWait(value?:Promise<void>){listWait=value;},casWait(value?:Promise<void>){casWait=value;}};
}
const checkpoint={key:'note/v1/entry-a',expectedRevision:null,nextRevision:'55555555-5555-4555-8555-555555555555',encodedState:'exact draft'};
async function prepare(context:ReturnType<typeof admitBrowserFixtureClient>) {
  const plan=await context.durableWrites.planWrite({operationId:'operation-a',path:'Note.md',expectedEntryId:'entry-a',expectedRevision:'r1',expectedContent:'old',content:'new'});
  return context.durableWrites.prepare(plan);
}

test('admission derives frozen authority scope, rejects mismatch and duplicate consumer contexts',()=>{
  const f=fixture(),context=f.admit();
  assert.deepEqual(context.scope,f.scope);assert.equal(Object.isFrozen(context.scope),true);
  assert.throws(()=>f.admit(),{code:'client_already_admitted'});
  const bad=fixture();bad.backend.checkpoints.scope={...bad.scope,vaultId:'wrong'};
  assert.throws(()=>bad.admit(),{code:'client_scope_mismatch'});
  const retired=fixture();retired.retire();assert.throws(()=>retired.admit(),{code:'owner_retired'});
});
test('retiring ownership while commit awaits query blocks the actual mutation dispatch',async()=>{
  const f=fixture(),context=f.admit(),intent=await prepare(context),wait=deferred();
  f.listWait(wait.promise);
  const committing=context.durableWrites.commit(intent.ref);f.retire();wait.resolve();
  await assert.rejects(committing,{code:'owner_retired'});
  assert.equal(f.events.includes('commit'),false);
});
test('release blocks external calls, drains accepted calls and flushes only through temporary capability',async()=>{
  const f=fixture(),context=f.admit(),load=deferred(),flushStarted=deferred(),cas=deferred();
  f.loadWait(load.promise);f.casWait(cas.promise);
  const reading=context.durableWrites.checkpoints.load('note/v1/entry-a');
  let flushContext!:BrowserFlushContext,flushing!:Promise<unknown>;
  const closing=context.release(async gate=>{
    flushContext=gate;gate.assertActive();assert.deepEqual(gate.scope,context.scope);
    flushing=gate.durableWrites.checkpoints.compareAndSwap(checkpoint);flushStarted.resolve();
  });
  await assert.rejects(context.durableWrites.readText('Note.md'),{code:'client_not_admitted'});
  assert.equal(f.events.includes('cas'),false);assert.equal(f.releaseCount,0);
  load.resolve();await reading;await flushStarted.promise;
  // Let the completed gate revoke admission; accepted CAS remains in the drain.
  await Promise.resolve();await Promise.resolve();
  await assert.rejects(flushContext.durableWrites.checkpoints.load('note/v1/entry-a'),{code:'client_not_admitted'});
  assert.equal(f.releaseCount,0);cas.resolve();await flushing;await closing;
  assert.deepEqual(f.events,['load','cas','release']);
  await context.release(async()=>assert.fail('already released'));assert.equal(f.releaseCount,1);
});
test('failed flush retains ownership and old temporary capability never revives on a later attempt',async()=>{
  const f=fixture(),context=f.admit();let old!:BrowserFlushContext;
  await assert.rejects(context.release(async gate=>{old=gate;throw new Error('checkpoint failed');}),/checkpoint failed/);
  context.assertActive();assert.equal(f.releaseCount,0);
  await context.release(async gate=>{
    await assert.rejects(old.durableWrites.checkpoints.load('note/v1/entry-a'),{code:'client_not_admitted'});
    await gate.durableWrites.checkpoints.compareAndSwap(checkpoint);
  });
  assert.throws(()=>old.assertActive(),{code:'client_not_admitted'});
});
test('uncertain release disables consumer and exact release retry does not repeat successful flush',async()=>{
  const f=fixture(),context=f.admit();f.loseRelease();let flushes=0;
  await assert.rejects(context.release(async()=>{flushes++;}),{code:'outcome_unknown'});
  await assert.rejects(context.durableWrites.checkpoints.load('note/v1/entry-a'),{code:'client_not_admitted'});
  await context.release(async()=>{flushes++;});assert.equal(flushes,1);assert.equal(f.releaseCount,2);
});
test('worker loss invalidates previously admitted contexts and never falls back to legacy writes',async()=>{
  const f=fixture(),context=f.admit();f.die();
  assert.throws(()=>context.assertActive(),{code:'client_ownership_lost'});
  await assert.rejects(context.durableWrites.readText('Note.md'),{code:'client_ownership_lost'});
  await assert.rejects(context.release(async()=>{}),{code:'client_ownership_lost'});
  assert.equal(f.releaseCount,0);assert.deepEqual(f.events,[]);
});
test('missing flush gate cannot release or retire the active consumer',async()=>{
  const f=fixture(),context=f.admit();
  await assert.rejects(context.release(undefined as never),{code:'flush_gate_required'});
  context.assertActive();assert.equal(f.releaseCount,0);
});

test('failed gate drains accepted work before allowing external admission again',async()=>{
  const f=fixture(),context=f.admit(),wait=deferred(),entered=deferred();f.loadWait(wait.promise);
  let accepted!:Promise<unknown>,retired!:BrowserFlushContext,settled=false;
  const closing=context.release(gate=>{
    retired=gate;accepted=gate.durableWrites.checkpoints.load('note/v1/entry-a');entered.resolve();throw new Error('flush failed');
  });
  const rejected=assert.rejects(closing,/flush failed/).then(()=>{settled=true;});
  await entered.promise;
  assert.throws(()=>retired.assertActive(),{code:'client_not_admitted'});
  await assert.rejects(context.durableWrites.readText('Note.md'),{code:'client_not_admitted'});
  assert.equal(settled,false);assert.equal(f.releaseCount,0);
  wait.resolve();await accepted;await rejected;context.assertActive();
});
test('accepted flush commit dispatches after gate revocation and before lease release',async()=>{
  const f=fixture(),context=f.admit(),intent=await prepare(context),wait=deferred(),entered=deferred();f.listWait(wait.promise);
  let accepted!:Promise<unknown>,retired!:BrowserFlushContext;
  const closing=context.release(gate=>{
    retired=gate;accepted=gate.durableWrites.commit(intent.ref);entered.resolve();
  });
  await entered.promise;
  assert.throws(()=>retired.assertActive(),{code:'client_not_admitted'});
  assert.equal(f.events.includes('commit'),false);wait.resolve();await accepted;await closing;
  assert.ok(f.events.indexOf('commit')<f.events.indexOf('release'));
});

function richFixture(wait?:Promise<void>){
  const f=fixture(),requests:{method:string;input:unknown}[]=[];let guard:()=>void=()=>{};
  const invoke=async(method:string,input:unknown)=>{const captured=structuredClone(input);guard();requests.push({method,input:captured});if(wait)await wait;guard();return {method};};
  Object.assign(f.backend,{installAdmissionGuard(next:()=>void){guard=next;},documentIndex:{
    richStart:(input:unknown)=>invoke('start',input),richPrepare:(input:unknown)=>invoke('prepare',input),richPage:(input:unknown)=>invoke('page',input),richClose:async(input:unknown)=>{await invoke('close',input);},
  }});
  return Object.assign(f,{requests});
}
test('admitted rich methods forward through runtime ownership checks and capture before provider awaits',async()=>{
  const f=richFixture(),context=f.admit(),index=context.documentIndex!;
  assert.deepEqual(f.requests,[]);
  const start={pinId:'pin',spec:{query:'aa',caseSensitive:false,sort:'nameAsc' as const,context:'line' as const,explain:false}};
  const request=index.richStart(start);start.spec.query='mutated';assert.deepEqual(await request,{method:'start'});
  await index.richPrepare({pinId:'pin',queryId:'query'});await index.richPage({pinId:'pin',queryId:'query',cursor:'cursor'});await index.richClose({pinId:'pin',queryId:'query'});
  assert.deepEqual(f.requests,[{method:'start',input:{pinId:'pin',spec:{...start.spec,query:'aa'}}},{method:'prepare',input:{pinId:'pin',queryId:'query'}},{method:'page',input:{pinId:'pin',queryId:'query',cursor:'cursor'}},{method:'close',input:{pinId:'pin',queryId:'query'}}]);
  f.retire();await assert.rejects(index.richStart(start),{code:'owner_retired'});assert.equal(f.requests.length,4);
});
test('release drains accepted rich work and rejects newly admitted queries before runtime release',async()=>{
  const wait=deferred(),f=richFixture(wait.promise),context=f.admit(),index=context.documentIndex!,pending=index.richPrepare({pinId:'pin',queryId:'query'});
  const closing=context.release(async()=>{});await assert.rejects(index.richPage({pinId:'pin',queryId:'query',cursor:'cursor'}),{code:'client_not_admitted'});assert.equal(f.releaseCount,0);assert.equal(f.requests.length,1);
  wait.resolve();await pending;await closing;assert.equal(f.releaseCount,1);await assert.rejects(index.richClose({pinId:'pin',queryId:'query'}),{code:'client_not_admitted'});
});
test('owner retirement during a rich RPC preserves the runtime post-await error and cannot dispatch new work',async()=>{
  const wait=deferred(),f=richFixture(wait.promise),context=f.admit(),pending=context.documentIndex!.richPage({pinId:'pin',queryId:'query',cursor:'cursor'});f.retire();wait.resolve();await assert.rejects(pending,{code:'owner_retired'});await assert.rejects(context.documentIndex!.richClose({pinId:'pin',queryId:'query'}),{code:'owner_retired'});assert.equal(f.requests.length,1);
});

test('both index reconstruction layers preserve complete maintenance with post-await fences and failed-flush liveness',async()=>{
  const f=fixture(),wait=deferred();let controls=0,seq=0,retire:()=>void=()=>{};
  const frame={version:1,scope:{localStoreId:f.scope.vaultId,clientId:f.scope.clientId},update:null,outcomes:[]};
  Object.assign(f.backend,{documentIndex:{maintenance:{scope:frame.scope,allocateSequence:()=>String(++seq),allocateRequestId:()=>String(++seq),
    async observe(){await wait.promise;return frame;},async control(){controls++;return frame;},async ackControl(){},async ackOutcome(){},subscribe(_nudge:()=>void,onRetire:()=>void){retire=onRetire;return()=>{};}}}});
  const context=f.admit(),transport=context.documentIndex!.maintenance!;assert.ok(transport);assert.equal(transport.allocateSequence(),'1');let retired=0;transport.subscribe(()=>{},()=>retired++);
  await assert.rejects(context.release(()=>{throw new Error('flush rejected');}),/flush rejected/);assert.equal(retired,0);assert.equal(transport.allocateSequence(),'2');
  const observing=transport.observe();f.retire();wait.resolve();await assert.rejects(observing,{code:'owner_retired'});assert.throws(()=>transport.allocateSequence(),{code:'owner_retired'});await assert.rejects(transport.control({sequence:'3',command:{kind:'cancel',lifetime:'runtime',id:'1'}}),{code:'owner_retired'});assert.equal(controls,0);retire();assert.equal(retired,1);
});


function metadataFixture(wait?:Promise<void>){
  const f=fixture(),requests:unknown[]=[];let guard:()=>void=()=>{};
  Object.assign(f.backend,{installAdmissionGuard(next:()=>void){guard=next;},documentIndex:{metadataRowsAvailable:true,
    async metadataRows(input:unknown){const captured=structuredClone(input);guard();requests.push(captured);if(wait)await wait;guard();return {metadata:'page'};},
  }});
  return Object.assign(f,{requests});
}
test('both admitted index layers preserve positive metadata capability before any pin opens',async()=>{
  const f=metadataFixture(),context=f.admit(),index=context.documentIndex!;
  assert.equal(index.metadataRowsAvailable,true);assert.equal(typeof index.metadataRows,'function');assert.equal(Object.isFrozen(index),true);assert.deepEqual(f.requests,[]);
  const input={pinId:'destination',baseline:{pinId:'baseline',snapshot:{localStoreId:f.scope.vaultId,generationEpoch:'epoch',generation:'1',versions:{schema:2,extraction:'x',resolver:'r',query:'q'}}},limit:2};
  const expected=structuredClone(input),pending=index.metadataRows!(input);input.baseline.snapshot.generation='9';input.baseline.snapshot.versions.query='mutated';input.limit=32;
  assert.deepEqual(await pending,{metadata:'page'});assert.deepEqual(f.requests,[expected]);
  f.retire();await assert.rejects(index.metadataRows!({pinId:'destination'}),{code:'owner_retired'});assert.equal(f.requests.length,1);
});
test('broken positive metadata capability fails before admission and does not consume the runtime',()=>{
  for(const method of [undefined,null,'not callable']){
    const f=fixture();let installed=0;
    Object.assign(f.backend,{installAdmissionGuard(){installed++;},documentIndex:{metadataRowsAvailable:true,metadataRows:method}});
    assert.throws(()=>f.admit(),{code:'invalid_document_response'});assert.equal(installed,0);assert.deepEqual(f.events,[]);
    Object.assign(f.backend,{documentIndex:{metadataRowsAvailable:true,async metadataRows(){return null;}}});
    assert.equal(f.admit().documentIndex!.metadataRowsAvailable,true,'failed admission must not reserve this runtime');assert.equal(installed,1);
  }
});
test('unadvertised metadata methods stay legacy through both admission reconstruction layers',()=>{
  for(const advertisement of [{},{metadataRowsAvailable:false}]){
    const f=fixture();Object.assign(f.backend,{documentIndex:{...advertisement,async metadataRows(){assert.fail('unadvertised route must not be used');}}});
    const index=f.admit().documentIndex!;assert.notEqual(index.metadataRowsAvailable,true);assert.equal(index.metadataRows,undefined);
  }
});
test('release drains accepted metadata pages and rejects new pages before runtime ownership release',async()=>{
  const wait=deferred(),f=metadataFixture(wait.promise),context=f.admit(),index=context.documentIndex!;
  const pending=index.metadataRows!({pinId:'destination',cursor:'original'}),closing=context.release(async()=>{});
  await assert.rejects(index.metadataRows!({pinId:'destination',cursor:'new'}),{code:'client_not_admitted'});
  assert.equal(f.requests.length,1);assert.equal(f.releaseCount,0);
  wait.resolve();assert.deepEqual(await pending,{metadata:'page'});await closing;assert.equal(f.releaseCount,1);
  await assert.rejects(index.metadataRows!({pinId:'destination'}),{code:'client_not_admitted'});assert.equal(f.requests.length,1);
});
test('owner retirement during accepted metadata page preserves post-await fence and blocks later work',async()=>{
  const wait=deferred(),f=metadataFixture(wait.promise),context=f.admit(),index=context.documentIndex!;
  const pending=assert.rejects(index.metadataRows!({pinId:'destination',cursor:'original'}),{code:'owner_retired'});
  f.retire();wait.resolve();await pending;
  await assert.rejects(index.metadataRows!({pinId:'destination'}),{code:'owner_retired'});assert.equal(f.requests.length,1);assert.equal(f.releaseCount,0);
});

function draftFixture(wait?:Promise<void>,reject=false){
  const f=fixture(),requests:unknown[]=[],draftScope=Object.freeze({localStoreId:f.scope.vaultId,clientId:f.scope.clientId});
  let retire:()=>void=()=>{};
  const drafts={scope:draftScope,async invoke(request:unknown,bytes?:Uint8Array){requests.push({request,bytes});if(wait)await wait;if(reject)throw failure('draft_resource');return {result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()};},subscribe(_receiver:()=>void,onRetire:()=>void){retire=onRetire;return()=>{};}};
  const index={draftsAvailable:true,drafts};Object.assign(f.backend,{documentIndex:index});
  return Object.assign(f,{index,drafts,requests,retireDrafts(){retire();}});
}
test('both browser admission reconstruction layers preserve positive scoped drafts and reject partial or foreign capability',async()=>{
  const f=draftFixture(),context=f.admit(),drafts=context.documentIndex!.drafts!;
  assert.equal(context.documentIndex!.draftsAvailable,true);assert.deepEqual(drafts.scope,f.drafts.scope);
  assert.deepEqual(await drafts.invoke({op:'snapshot'}),{result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()});
  assert.equal(f.requests.length,1);let retired=0;drafts.subscribe(()=>{},()=>retired++);f.retireDrafts();assert.equal(retired,1);
  const partial=draftFixture();Object.assign(partial.index,{drafts:undefined});assert.throws(()=>partial.admit(),{code:'document_runtime_unavailable'});
  const foreign=draftFixture();Object.assign(foreign.drafts,{scope:{...foreign.drafts.scope,clientId:'other'}});assert.throws(()=>foreign.admit(),{code:'document_runtime_unavailable'});
  const legacy=draftFixture();legacy.index.draftsAvailable=false;assert.equal(legacy.admit().documentIndex!.drafts,undefined);
});
test('browser admitted draft replies recheck actual owner after both success and failure awaits',async()=>{
  for(const reject of [false,true]){
    const wait=deferred(),f=draftFixture(wait.promise,reject),context=f.admit();
    const pending=context.documentIndex!.drafts!.invoke({op:'snapshot'});f.retire();wait.resolve();
    await assert.rejects(pending,{code:'owner_retired'});assert.equal(f.requests.length,1);
  }
});
test('browser admitted draft calls join release drain before scoped flush and lease release',async()=>{
  const wait=deferred(),f=draftFixture(wait.promise),context=f.admit();let flushed=false;
  const pending=context.documentIndex!.drafts!.invoke({op:'snapshot'});
  const closing=context.release(()=>{flushed=true;});
  await assert.rejects(context.documentIndex!.drafts!.invoke({op:'snapshot'}),{code:'client_not_admitted'});
  assert.equal(flushed,false);assert.equal(f.releaseCount,0);wait.resolve();await pending;await closing;
  assert.equal(flushed,true);assert.equal(f.releaseCount,1);assert.equal(f.requests.length,1);
});

function previewFixture(wait?:Promise<void>,reject=false){const f=fixture(),requests:string[]=[];const index={basePreviewAvailable:true,async previewOpen(){requests.push('open');if(wait)await wait;if(reject)throw failure('index_preview_expired');return null;},async previewBase(){requests.push('base');return null;},async previewClose(){requests.push('close');return {closed:true};}};Object.assign(f.backend,{documentIndex:index});return Object.assign(f,{index,requests});}
test('both browser admission layers preserve complete preview routes and fail closed on partial positive capability',async()=>{
  const f=previewFixture(),context=f.admit();assert.equal(context.documentIndex!.basePreviewAvailable,true);assert.equal(await context.documentIndex!.previewOpen!({previewId:'1'}),null);assert.deepEqual(f.requests,['open']);
  for(const missing of ['previewOpen','previewBase','previewClose']){const partial=previewFixture();Reflect.deleteProperty(partial.index,missing);assert.throws(()=>partial.admit(),{code:'invalid_document_response'});assert.deepEqual(partial.requests,[]);}
  const legacy=previewFixture();legacy.index.basePreviewAvailable=false;assert.equal(legacy.admit().documentIndex!.previewOpen,undefined);
});
test('admitted preview calls fence both reply paths and join release drain before relinquishing the lease',async()=>{
  for(const rejected of [false,true]){const wait=deferred(),f=previewFixture(wait.promise,rejected),context=f.admit(),pending=context.documentIndex!.previewOpen!({previewId:'1'});f.retire();wait.resolve();await assert.rejects(pending,{code:'owner_retired'});}
  const wait=deferred(),f=previewFixture(wait.promise),context=f.admit(),pending=context.documentIndex!.previewOpen!({previewId:'1'}),closing=context.release(()=>{});
  await assert.rejects(context.documentIndex!.previewOpen!({previewId:'2'}),{code:'client_not_admitted'});assert.equal(f.releaseCount,0);wait.resolve();assert.equal(await pending,null);await closing;assert.equal(f.releaseCount,1);assert.deepEqual(f.requests,['open']);
});

test('ordinary note property target capability survives both admission layers and fences late owner replies',async()=>{
  const f=fixture(),wait=deferred(),requests:unknown[]=[];let guard:()=>void=()=>{};
  Object.assign(f.backend,{installAdmissionGuard(next:()=>void){guard=next;},documentIndex:{propertyTargetsAvailable:true,async propertyTargets(input:unknown){guard();requests.push(structuredClone(input));await wait.promise;guard();return {targets:'rust'};}}});
  const context=f.admit(),index=context.documentIndex!;assert.equal(index.propertyTargetsAvailable,true);assert.equal(typeof index.propertyTargets,'function');
  const pending=index.propertyTargets!({pinId:'note-pin',options:{currentEntryId:'entry-a',clockMs:0}});f.retire();wait.resolve();
  await assert.rejects(pending,{code:'owner_retired'});await assert.rejects(index.propertyTargets!({pinId:'note-pin'}),{code:'owner_retired'});assert.equal(requests.length,1);
  const broken=fixture();Object.assign(broken.backend,{documentIndex:{propertyTargetsAvailable:true}});assert.throws(()=>broken.admit(),{code:'invalid_document_response'});
});
