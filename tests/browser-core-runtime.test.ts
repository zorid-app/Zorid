import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserCoreRuntime } from '../src/platform/browser-core-runtime.ts';

test('worker runtime gates recovered commands until exact outcome acknowledgement and scopes opening identity', async () => {
  const originals = new Map(['Worker','document','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const calls: any[] = [];
  const listeners = new Map<string,()=>void>();
  let terminated = false;
  class FixtureWorker {
    onmessage?: (event:any)=>void;
    postMessage(message:any) {
      calls.push(message);
      queueMicrotask(() => this.onmessage?.({data:{id:message.id,ok:true,result:message.operation==='open'?{authorityId:'12345678-1234-4123-8123-123456789abc',recovery:['old-intent']}:message.operation==='execute'?'original-receipt':undefined}}));
    }
    terminate() { terminated = true; }
  }
  try {
    Object.defineProperty(globalThis,'Worker',{configurable:true,value:FixtureWorker});
    Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(name:string,fn:()=>void){listeners.set(name,fn);},removeEventListener(name:string){listeners.delete(name);},visibilityState:'visible'}});
    Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://zorid.test/',origin:'https://zorid.test'}});
    const runtime = await BrowserCoreRuntime.open({database:'zorid-core-vault:explicit',clientId:'22222222-2222-4222-8222-222222222222',
      wasmModuleUrl:'/assets/core.js',allowNewVault:true});
    assert.equal(calls[0].payload.clientId,'22222222-2222-4222-8222-222222222222');
    assert.deepEqual(runtime.durableScope,{vaultId:'12345678-1234-4123-8123-123456789abc',clientId:'22222222-2222-4222-8222-222222222222'});
    await assert.rejects(runtime.execute('new-intent','{}'),{code:'recovery_required'});
    assert.equal(calls.length,1,'gate sends no fresh mutation to worker');
    assert.equal(await runtime.execute('old-intent','original-json'),'original-receipt');
    assert.deepEqual(calls[1].payload,{intentId:'old-intent',requestJson:'original-json'});
    await runtime.acknowledge('old-intent',{status:'committed',receipt:'original-receipt'});
    const beforePrepare = calls.length;
    await runtime.prepare('new-intent','new-json');
    assert.equal(calls.length,beforePrepare+1);
    assert.equal(calls.at(-1).operation,'prepare','persisting a token does not authorize execution');
    await runtime.commit('new-intent');
    assert.equal(calls.at(-2).payload.intentId,'new-intent');
    const checkpoint={key:'draft',expectedRevision:null,nextRevision:'01234567-89ab-4cde-8123-0123456789ab',encodedState:'x'.repeat(32*1024*1024)};
    const beforeCheckpoint=calls.length;
    await assert.rejects(runtime.checkpoints!.compareAndSwap({...checkpoint,encodedState:checkpoint.encodedState+'x'}),{code:'checkpoint_too_large'});
    await assert.rejects(runtime.checkpoints!.compareAndSwap({...checkpoint,encodedState:'\ud800'}),{code:'checkpoint_too_large'});
    assert.equal(calls.length,beforeCheckpoint,'invalid checkpoint bodies never reach postMessage/structured clone');
    await runtime.checkpoints!.compareAndSwap(checkpoint);
    assert.equal(calls.at(-1).operation,'checkpoint-cas');
    assert.equal(calls.at(-1).payload.encodedState.length,32*1024*1024,'exact limit reaches transport unchanged');
    runtime.close(); assert.equal(terminated,true);
    await assert.rejects(runtime.intents(),{code:'storage_closed'});
  } finally {
    for (const [key,descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key);
    }
  }
});


async function runtimeFixture(action: (runtime:BrowserCoreRuntime,calls:any[],worker:any)=>Promise<void>, timeoutMs=20000) {
  const originals=new Map(['Worker','document','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const calls:any[]=[];let worker:any;const listeners=new Map<string,()=>void>();
  class FixtureWorker {
    onmessage?: (event:any)=>void;onerror?:()=>void;terminated=false;releaseCount=0;
    block?:string;blocked:any;onPosted?: (message:any)=>void;
    visibility(){listeners.get('visibilitychange')?.();}
    constructor(){worker=this;}
    completeBlocked(){const message=this.blocked;this.block=undefined;this.blocked=undefined;this.onmessage?.({data:{id:message.id,ok:true,result:[]}});}
    postMessage(message:any){calls.push(message);this.onPosted?.(message);if(this.block===message.operation){this.blocked=message;return;}queueMicrotask(()=>{
      if(message.operation==='release-client' && ++this.releaseCount===1){this.onmessage?.({data:{id:message.id,ok:false,error:{code:'outcome_unknown',message:'lost release ACK'}}});return;}
      this.onmessage?.({data:{id:message.id,ok:true,result:message.operation==='open'?{authorityId:'12345678-1234-4123-8123-123456789abc',recovery:[]}:undefined}});
    });}
    terminate(){this.terminated=true;}
  }
  let runtime:BrowserCoreRuntime|undefined;
  try {
    Object.defineProperty(globalThis,'Worker',{configurable:true,value:FixtureWorker});
    Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(name:string,fn:()=>void){listeners.set(name,fn);},removeEventListener(name:string){listeners.delete(name);},visibilityState:'visible'}});
    Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://zorid.test/',origin:'https://zorid.test'}});
    runtime=await BrowserCoreRuntime.open({database:'zorid-core-vault:fixture',clientId:'22222222-2222-4222-8222-222222222222',wasmModuleUrl:'/core.js',allowNewVault:true,timeoutMs});
    await action(runtime,calls,worker);
  } finally {
    runtime?.close();
    for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
}
test('runtime release fences new RPCs and retries only release after uncertain acknowledgement',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    runtime.assertActive();
    await assert.rejects(runtime.releaseClient(),{code:'outcome_unknown'});
    assert.throws(()=>runtime.assertActive(),{code:'client_ownership_lost'});
    const before=calls.length;
    await assert.rejects(runtime.prepare('new','{}'),{code:'client_not_admitted'});
    await assert.rejects(runtime.checkpoints!.load('note'),{code:'client_not_admitted'});
    assert.equal(calls.length,before);assert.equal(worker.terminated,false);
    await runtime.releaseClient();assert.equal(worker.terminated,true);
    assert.deepEqual(calls.map(call=>call.operation),['open','release-client','release-client']);
  });
});
test('worker failure immediately revokes runtime ownership instead of retaining a usable scope',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    worker.onerror();assert.equal(worker.terminated,true);
    assert.throws(()=>runtime.assertActive(),{code:'client_ownership_lost'});
    await assert.rejects(runtime.readEntry('Note.md'),{code:'storage_closed'});
    assert.equal(calls.length,1);
  });
});

function enteredRequest(worker:any,operation:string):Promise<void> {
  return new Promise(resolve=>{worker.onPosted=(message:any)=>{if(message.operation===operation)resolve();};});
}
test('runtime rechecks captured owner after queued RPC waits before posting commit or checkpoint CAS',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    let owner=true;runtime.installAdmissionGuard(()=>{if(!owner)throw Object.assign(new Error('retired'),{code:'owner_retired'});});
    worker.block='inventory';const entered=enteredRequest(worker,'inventory');
    const first=runtime.inventory();await entered;
    const commit=assert.rejects(runtime.commit('exact-intent'),{code:'owner_retired'});
    const checkpoint=assert.rejects(runtime.checkpoints!.compareAndSwap({key:'note',expectedRevision:null,nextRevision:'33333333-3333-4333-8333-333333333333',encodedState:'exact'}),{code:'owner_retired'});
    owner=false;worker.completeBlocked();await first;await Promise.all([commit,checkpoint]);
    assert.deepEqual(calls.map(call=>call.operation),['open','inventory']);
  });
});
test('runtime snapshots queued payloads before waiting for the current RPC',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    worker.block='inventory';const entered=enteredRequest(worker,'inventory');const first=runtime.inventory();await entered;
    const outcome={status:'committed' as const,receipt:'original exact receipt'};
    const ack=runtime.acknowledge('original-intent',outcome);outcome.receipt='mutated after admission';
    assert.equal(calls.length,2);worker.completeBlocked();await first;await ack;
    assert.equal(calls.at(-1).payload.outcome.receipt,'original exact receipt');
  });
});
test('transport timeout terminates the worker and leaves queued mutations unsent',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    worker.block='inventory';const entered=enteredRequest(worker,'inventory');
    const first=assert.rejects(runtime.inventory(),{code:'outcome_unknown'});await entered;
    const queued=assert.rejects(runtime.commit('must-not-send'),{code:'storage_closed'});
    await Promise.all([first,queued]);assert.equal(worker.terminated,true);
    assert.throws(()=>runtime.assertActive(),{code:'client_ownership_lost'});
    assert.deepEqual(calls.map(call=>call.operation),['open','inventory']);
  },30);
});
test('runtime bounds queued payload count while a worker request is stalled',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    worker.block='inventory';const entered=enteredRequest(worker,'inventory');
    const first=runtime.inventory();await entered;
    const queued=Array.from({length:7},()=>runtime.inventory());
    await assert.rejects(runtime.inventory(),{code:'client_queue_full'});
    assert.equal(calls.length,2);worker.completeBlocked();await Promise.all([first,...queued]);
  });
});

test('queued visibility refresh cancellation does not terminate ordered release',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    worker.releaseCount=1; // This fixture's next release receives a definite ACK.
    worker.block='inventory';const entered=enteredRequest(worker,'inventory');
    const first=runtime.inventory();await entered;worker.visibility();
    const releasing=runtime.releaseClient();worker.completeBlocked();await first;await releasing;
    assert.deepEqual(calls.map(call=>call.operation),['open','inventory','release-client']);
    assert.equal(worker.terminated,true);
  });
});

test('sync network waits do not block local editing or revocation RPCs',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    worker.block='sync-once';const entered=enteredRequest(worker,'sync-once');
    const syncing=runtime.syncOnce();await entered;
    await runtime.prepare('local-edit','exact-request');
    await runtime.revokeSync();
    assert.deepEqual(calls.map(call=>call.operation),['open','sync-once','prepare','sync-revoke']);
    worker.completeBlocked();await syncing;
  });
});
test('sync RPCs obey admission and credential snapshots are bounded before dispatch',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    const credentials={endpoint:'https://relay.test',realmId:'r',vaultId:'v',serverEpoch:'e',keyEpoch:1,bearerToken:'secret',keyBytes:new Uint8Array(32).fill(7)};
    await assert.rejects(runtime.configureSyncFixture({...credentials,keyBytes:new Uint8Array(33)}),{code:'invalid_sync_credentials'});
    assert.equal(calls.length,1);
    let captured:any;
    worker.onPosted=(message:any)=>{if(message.operation==='sync-configure')captured=structuredClone(message.payload);};
    await runtime.configureSyncFixture(credentials);
    assert.equal(captured.bearerToken,'secret');assert.equal(captured.keyBytes[0],7);
    assert.equal(calls.at(-1).payload.bearerToken,'');assert.ok(calls.at(-1).payload.keyBytes.every((v:number)=>v===0));
    assert.equal(credentials.keyBytes[0],7,'caller retains its own explicitly supplied key');
    let admitted=true;runtime.installAdmissionGuard(()=>{if(!admitted)throw Object.assign(new Error('retired'),{code:'owner_retired'});});
    admitted=false;await assert.rejects(runtime.syncOnce(),{code:'owner_retired'});
    assert.equal(calls.length,2);
  });
});
