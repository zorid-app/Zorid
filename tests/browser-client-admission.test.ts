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
  return {...f,requests};
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
