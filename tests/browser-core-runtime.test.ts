import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentDraftService} from '../src/core/document-drafts.ts';
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
      wasmModuleUrl:'/assets/core.js',allowNewVault:true,initializeLocal:true});
    assert.equal(calls[0].payload.initializeLocal,true,'normal local bootstrap is an explicit worker startup decision');
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


async function runtimeFixture(action: (runtime:BrowserCoreRuntime,calls:any[],worker:any)=>Promise<void>, timeoutMs=20000, openFields:Record<string,unknown>={}, options:Partial<Parameters<typeof BrowserCoreRuntime.open>[0]>={}) {
  const originals=new Map(['Worker','document','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const calls:any[]=[];let worker:any;const listeners=new Map<string,()=>void>();
  class FixtureWorker {
    onmessage?: (event:any)=>void;onerror?:()=>void;terminated=false;releaseCount=0;
    block?:string;blocked:any;onPosted?: (message:any)=>void;
    draftReply=(_message:any)=>({result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()});
    visibility(){listeners.get('visibilitychange')?.();}
    constructor(){worker=this;}
    completeBlocked(error?:{code:string;message:string}){const message=this.blocked;this.block=undefined;this.blocked=undefined;this.onmessage?.({data:error?{id:message.id,ok:false,error}:{id:message.id,ok:true,...(message.operation==='document-drafts'?this.draftReply(message):{result:[]})}});}
    postMessage(message:any,transfer?:ArrayBuffer[]){if(transfer?.length)message=structuredClone(message,{transfer});calls.push(message);this.onPosted?.(message);if(this.block===message.operation){this.blocked=message;return;}queueMicrotask(()=>{
      if(message.operation==='release-client' && ++this.releaseCount===1){this.onmessage?.({data:{id:message.id,ok:false,error:{code:'outcome_unknown',message:'lost release ACK'}}});return;}
      if(message.operation==='document-drafts'){this.onmessage?.({data:{id:message.id,ok:true,...this.draftReply(message)}});return;}
      this.onmessage?.({data:{id:message.id,ok:true,result:message.operation==='open'?{authorityId:'12345678-1234-4123-8123-123456789abc',recovery:[],...openFields}:undefined}});
    });}
    terminate(){this.terminated=true;}
  }
  let runtime:BrowserCoreRuntime|undefined;
  try {
    Object.defineProperty(globalThis,'Worker',{configurable:true,value:FixtureWorker});
    Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(name:string,fn:()=>void){listeners.set(name,fn);},removeEventListener(name:string){listeners.delete(name);},visibilityState:'visible'}});
    Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://zorid.test/',origin:'https://zorid.test'}});
    runtime=await BrowserCoreRuntime.open({database:'zorid-core-vault:fixture',clientId:'22222222-2222-4222-8222-222222222222',wasmModuleUrl:'/core.js',allowNewVault:true,timeoutMs,...options});
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

test('fatal storage event from sync lane terminates runtime and rejects pending sync RPC',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    worker.block='sync-once';const entered=enteredRequest(worker,'sync-once');
    const pending=assert.rejects(runtime.syncOnce(),{code:'storage_corrupt'});await entered;
    worker.onmessage({data:{event:'storage-error',code:'storage_corrupt'}});await pending;
    assert.equal(worker.terminated,true);assert.throws(()=>runtime.assertActive(),{code:'client_ownership_lost'});
    await assert.rejects(runtime.prepare('later','{}'),{code:'storage_closed'});
  });
});

test('positive maintenance transport uses dedicated nudges, monotonic IDs and successful-close retirement',async()=>{
  const originals=new Map(['Worker','document','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const calls:any[]=[];let worker:any;const authorityId='12345678-1234-4123-8123-123456789abc';
  class FixtureWorker {onmessage?: (event:any)=>void;constructor(){worker=this;}postMessage(message:any){calls.push(message);queueMicrotask(()=>this.onmessage?.({data:{id:message.id,ok:true,result:message.operation==='open'?{authorityId,recovery:[],documentIndexAvailable:true,documentMaintenance:true}:message.operation==='document-runtime-observe'?{version:1,scope:{localStoreId:authorityId,clientId:'22222222-2222-4222-8222-222222222222'},update:null,outcomes:[]}:undefined}}));}terminate(){}}
  try{
    Object.defineProperty(globalThis,'Worker',{configurable:true,value:FixtureWorker});Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(){},removeEventListener(){},visibilityState:'visible'}});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://zorid.test/',origin:'https://zorid.test'}});
    const runtime=await BrowserCoreRuntime.open({database:'owned',clientId:'22222222-2222-4222-8222-222222222222',wasmModuleUrl:'/core.js',allowNewVault:true,documentMaintenance:true});
    const maintenance=runtime.documentIndex!.maintenance!;assert.ok(maintenance);assert.equal(maintenance.allocateSequence(),'1');assert.equal(maintenance.allocateSequence(),'2');assert.equal(maintenance.allocateRequestId(),'1');
    let nudges=0,changes=0,retired=0;runtime.subscribe(()=>changes++);const off=maintenance.subscribe(()=>nudges++,()=>retired++);
    worker.onmessage({data:{event:'document-runtime-nudge'}});worker.onmessage({data:{event:'document-runtime-nudge'}});assert.equal(nudges,2);assert.equal(changes,0);
    await maintenance.observe();await maintenance.ackControl({sequence:'1'});await maintenance.ackOutcome({lifetime:'runtime',id:'1'});assert.deepEqual(calls.slice(-3).map(row=>row.operation),['document-runtime-observe','document-runtime-ack-control','document-runtime-ack-outcome']);
    await runtime.releaseClient();assert.equal(retired,1);runtime.close();assert.equal(retired,1);assert.throws(()=>maintenance.allocateSequence(),{code:'client_ownership_lost'});off();
  }finally{for(const [key,value]of originals){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}
});

test('requested maintenance capability cannot silently fall back when worker marker is missing',async()=>{
  const originals=new Map(['Worker','document','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));let terminated=false;
  class FixtureWorker {onmessage?:(event:any)=>void;postMessage(message:any){queueMicrotask(()=>this.onmessage?.({data:{id:message.id,ok:true,result:{authorityId:'12345678-1234-4123-8123-123456789abc',recovery:[],documentIndexAvailable:true}}}));}terminate(){terminated=true;}}
  try{Object.defineProperty(globalThis,'Worker',{configurable:true,value:FixtureWorker});Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(){},removeEventListener(){}}});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://zorid.test/',origin:'https://zorid.test'}});
    await assert.rejects(BrowserCoreRuntime.open({database:'owned',clientId:'22222222-2222-4222-8222-222222222222',wasmModuleUrl:'/core.js',allowNewVault:true,documentMaintenance:true}),{code:'document_runtime_unavailable'});assert.equal(terminated,true);
  }finally{for(const[key,value]of originals){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}
});


const metadataCapability={documentIndexAvailable:true,metadataRowsAvailable:true};
const metadataSnapshot=()=>({localStoreId:'12345678-1234-4123-8123-123456789abc',generationEpoch:'epoch',generation:'1',versions:{schema:2,extraction:'extract-v1',resolver:'resolve-v1',query:'query-v1'}});
test('metadata rows capability and method are available before opening a document pin',async()=>{
  await runtimeFixture(async(runtime,calls)=>{
    assert.equal(runtime.documentIndex!.metadataRowsAvailable,true);
    assert.equal(typeof runtime.documentIndex!.metadataRows,'function');
    assert.deepEqual(calls.map(call=>call.operation),['open']);
    await runtime.documentIndex!.metadataRows!({pinId:'destination',limit:1});
    assert.deepEqual(calls.map(call=>call.operation),['open','document-index-metadata-rows']);
    assert.deepEqual(calls.at(-1).payload,{pinId:'destination',limit:1});
  },20000,metadataCapability);
});
test('metadata rows absent or false advertisement preserves legacy capability without a method',async()=>{
  for(const marker of [{documentIndexAvailable:true},{documentIndexAvailable:true,metadataRowsAvailable:false}]){
    await runtimeFixture(async(runtime,calls)=>{
      assert.notEqual(runtime.documentIndex!.metadataRowsAvailable,true);
      assert.equal(runtime.documentIndex!.metadataRows,undefined);
      assert.deepEqual(calls.map(call=>call.operation),['open']);
    },20000,marker);
  }
});
test('malformed or unsupported positive metadata capability fails runtime opening closed',async()=>{
  for(const marker of [{documentIndexAvailable:true,metadataRowsAvailable:'true'},{documentIndexAvailable:true,metadataRowsAvailable:null},{metadataRowsAvailable:true},{documentIndexAvailable:false,metadataRowsAvailable:true}]){
    await assert.rejects(runtimeFixture(async()=>assert.fail('malformed worker reply must not expose a runtime'),20000,marker),{code:'invalid_wasm_result'});
  }
});
test('metadata rows captures the exact nested baseline and limit before waiting for another RPC',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    worker.block='inventory';const entered=enteredRequest(worker,'inventory'),first=runtime.inventory();await entered;
    const request={pinId:'destination',baseline:{pinId:'baseline',snapshot:metadataSnapshot()},limit:7};
    const expected=structuredClone(request),pending=runtime.documentIndex!.metadataRows!(request);
    request.pinId='replacement';request.baseline.pinId='replacement';request.baseline.snapshot.generation='9';request.baseline.snapshot.versions.query='replacement';request.limit=32;
    assert.equal(calls.length,2);worker.completeBlocked();await first;await pending;
    assert.equal(calls.at(-1).operation,'document-index-metadata-rows');assert.deepEqual(calls.at(-1).payload,expected);
    await runtime.documentIndex!.metadataRows!({pinId:'destination',cursor:'opaque-continuation'});
    assert.deepEqual(calls.at(-1).payload,{pinId:'destination',cursor:'opaque-continuation'},'omitted continuation limit stays omitted for the host profile');
  },20000,metadataCapability);
});
test('metadata rows rejects malformed, oversized and continuation-baseline requests before worker dispatch',async()=>{
  await runtimeFixture(async(runtime,calls)=>{
    const page=runtime.documentIndex!.metadataRows!;
    const baseline={pinId:'baseline',snapshot:metadataSnapshot()};
    const invalid:unknown[]=[null,[],{pinId:''},{pinId:'bad pin'},{pinId:'destination',limit:0},{pinId:'destination',limit:33},{pinId:'destination',limit:1.5},
      {pinId:'destination',cursor:'cursor',baseline},{pinId:'destination',baseline:{snapshot:metadataSnapshot()}},{pinId:'destination',baseline:{pinId:'baseline'}},
      {pinId:'destination',baseline:{...baseline,expectedSnapshot:metadataSnapshot()}},{pinId:'destination',expectedSnapshot:metadataSnapshot()},
      {pinId:'destination',cursor:'x'.repeat(65537)},{pinId:'destination',baseline:{pinId:'baseline',snapshot:{...metadataSnapshot(),generation:'01'}}},
      {pinId:'destination',baseline:{pinId:'baseline',snapshot:{...metadataSnapshot(),versions:{...metadataSnapshot().versions,query:'雪'.repeat(23000)}}}}];
    for(const request of invalid)await assert.rejects(async()=>page(request as never),{code:'index_invalid_request'});
    assert.deepEqual(calls.map(call=>call.operation),['open'],'invalid metadata input never reaches postMessage or its structured clone');
    await page({pinId:'destination',baseline,limit:32});assert.equal(calls.at(-1).operation,'document-index-metadata-rows');
  },20000,metadataCapability);
});
test('queued metadata rows rechecks owner before worker dispatch',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    let owner=true;runtime.installAdmissionGuard(()=>{if(!owner)throw Object.assign(new Error('retired'),{code:'owner_retired'});});
    worker.block='inventory';const entered=enteredRequest(worker,'inventory'),first=runtime.inventory();await entered;
    const page=assert.rejects(runtime.documentIndex!.metadataRows!({pinId:'destination'}),{code:'owner_retired'});
    owner=false;worker.completeBlocked();await first;await page;
    assert.deepEqual(calls.map(call=>call.operation),['open','inventory']);
  },20000,metadataCapability);
});
test('accepted metadata rows fences both success and failure replies after owner retirement',async()=>{
  for(const replyError of [undefined,{code:'index_not_ready',message:'not ready'}])await runtimeFixture(async(runtime,calls,worker)=>{
    let owner=true;runtime.installAdmissionGuard(()=>{if(!owner)throw Object.assign(new Error('retired'),{code:'owner_retired'});});
    worker.block='document-index-metadata-rows';const entered=enteredRequest(worker,worker.block);
    const page=assert.rejects(runtime.documentIndex!.metadataRows!({pinId:'destination'}),{code:'owner_retired'});await entered;
    owner=false;worker.completeBlocked(replyError);await page;
    assert.deepEqual(calls.map(call=>call.operation),['open','document-index-metadata-rows']);
  },20000,metadataCapability);
});

const draftOptions={documentMaintenance:true} as const;
const draftCapabilities={documentIndexAvailable:true,documentMaintenance:true,draftsAvailable:true};
const draftJob={lifetime:'draft-life',id:'1',buffer_lifetime:'buffer',text_revision:'1'};
const emptyDraftState={admitted:null,replay:false,execution:'wait_for_input',outcomes:[],usage:{source_bytes:3,scratch_bytes:0,facts_bytes:0}};
test('browser drafts follow existing maintenance opt-in and preserve legacy backends without F',async()=>{
  await runtimeFixture(async runtime=>{assert.equal(runtime.documentIndex!.drafts,undefined);assert.notEqual(runtime.documentIndex!.draftsAvailable,true);},20000,{documentIndexAvailable:true,documentMaintenance:true},draftOptions);
  await assert.rejects(runtimeFixture(async()=>assert.fail('F without requested maintenance must not open'),20000,{documentIndexAvailable:true,draftsAvailable:true}),{code:'document_runtime_unavailable'});
  await assert.rejects(runtimeFixture(async()=>assert.fail('F without an index owner must not open'),20000,{documentMaintenance:true,draftsAvailable:true},draftOptions),{code:'document_runtime_unavailable'});
  await assert.rejects(runtimeFixture(async()=>assert.fail('malformed positive F marker must not open'),20000,{documentIndexAvailable:true,documentMaintenance:true,draftsAvailable:'yes'},draftOptions),{code:'document_runtime_unavailable'});
  await runtimeFixture(async runtime=>assert.equal(runtime.documentIndex,undefined));
});
test('browser draft raw route transfers only the exclusive captured chunk and preserves FIFO',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    assert.equal(calls[0].payload.documentMaintenance,true);
    const transport=runtime.documentIndex!.drafts!,service=createDocumentDraftService(transport);
    assert.deepEqual(transport.scope,{localStoreId:runtime.durableScope!.vaultId,clientId:runtime.durableScope!.clientId});
    worker.draftReply=()=>({result:{state:emptyDraftState,transfer:{source_bytes_received:3,source_bytes_expected:3,source_sealed:false,facts_bytes:null,scratch_bytes:0},transfer_scratch_bytes:0},bytes:new Uint8Array()});
    worker.block='inventory';const entered=enteredRequest(worker,'inventory'),first=runtime.inventory();await entered;
    const original=new Uint8Array([1,2,3]),pending=service.uploadChunk({job:draftJob,offset:'0'},original);original[0]=9;
    assert.equal(calls.length,2);worker.completeBlocked();await first;await pending;
    assert.deepEqual([...calls.at(-1).bytes],[1,2,3]);assert.deepEqual([...original],[9,2,3]);
    assert.equal(calls.at(-1).operation,'document-drafts');assert.equal(calls.some(call=>call.operation.startsWith('binary-')),false);
    const owned=new Uint8Array([4,5,6]);await transport.invoke({op:'upload_chunk',job:draftJob,offset:'0'},owned);
    assert.equal(owned.byteLength,0,'exact exclusively owned snapshot is moved, without a second body copy');
  },20000,draftCapabilities,draftOptions);
});
test('browser draft route bounds held calls, releases credits and rejects oversized or partial buffers',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    const drafts=runtime.documentIndex!.drafts!;
    await assert.rejects(drafts.invoke({op:'upload_chunk',job:draftJob,offset:'0'},new Uint8Array(0)),{code:'draft_invalid_chunk'});
    await assert.rejects(drafts.invoke({op:'upload_chunk',job:draftJob,offset:'0'},new Uint8Array(131073)),{code:'draft_invalid_chunk'});
    await assert.rejects(drafts.invoke({op:'upload_chunk',job:draftJob,offset:'0'},new Uint8Array(3).subarray(1)),{code:'draft_invalid_chunk'});
    worker.block='document-drafts';const entered=enteredRequest(worker,'document-drafts');
    const first=drafts.invoke({op:'snapshot'});await entered;
    const queued=Array.from({length:7},()=>drafts.invoke({op:'snapshot'}));
    await assert.rejects(drafts.invoke({op:'snapshot'}),{code:'draft_capacity'});assert.equal(calls.length,2);
    worker.completeBlocked();await Promise.all([first,...queued]);await drafts.invoke({op:'snapshot'});
    assert.equal(calls.filter(call=>call.operation==='document-drafts').length,9);
    worker.block='document-drafts';const retryEntered=enteredRequest(worker,'document-drafts'),failed=drafts.invoke({op:'snapshot'});await retryEntered;
    worker.completeBlocked({code:'draft_resource',message:'temporary'});await assert.rejects(failed,{code:'draft_resource'});
    await drafts.invoke({op:'snapshot'});assert.equal(worker.terminated,false,'transient draft rejection never poisons durable storage');
    await assert.rejects((runtime as any).call('document-drafts',{op:'snapshot'}),{code:'draft_invalid_request'});
    await assert.rejects(drafts.invoke({op:'Complete'} as any),{code:'draft_invalid_request'});
  },20000,draftCapabilities,draftOptions);
});
test('browser draft responses fence ownership on success and failure and validate bounded raw facts',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    let owner=true;runtime.installAdmissionGuard(()=>{if(!owner)throw Object.assign(new Error('retired'),{code:'owner_retired'});});
    const drafts=runtime.documentIndex!.drafts!;
    worker.draftReply=()=>({result:{job:draftJob,offset:'0',bytes:2,total_bytes:2,eof:true},bytes:new Uint8Array([1,2])});
    await assert.rejects(drafts.invoke({op:'facts_read',job:draftJob,offset:'0',maximum:1}),{code:'invalid_document_response'});
    const read=await drafts.invoke({op:'facts_read',job:draftJob,offset:'0',maximum:2}) as {bytes:Uint8Array};assert.deepEqual([...read.bytes],[1,2]);
    worker.draftReply=()=>({result:{job:draftJob,offset:'0',bytes:2,total_bytes:2,eof:true},bytes:new Uint8Array(128).subarray(0,2)});
    await assert.rejects(drafts.invoke({op:'facts_read',job:draftJob,offset:'0',maximum:2}),{code:'invalid_document_response'});
    worker.block='document-drafts';const entered=enteredRequest(worker,'document-drafts'),pending=drafts.invoke({op:'snapshot'});await entered;
    owner=false;worker.completeBlocked({code:'draft_resource',message:'transient'});await assert.rejects(pending,{code:'owner_retired'});
    owner=true;worker.block='document-drafts';const next=enteredRequest(worker,'document-drafts'),success=drafts.invoke({op:'snapshot'});await next;
    owner=false;worker.completeBlocked();await assert.rejects(success,{code:'owner_retired'});
  },20000,draftCapabilities,draftOptions);
});
test('browser release drains accepted draft frames before worker release and retires observers',async()=>{
  await runtimeFixture(async(runtime,calls,worker)=>{
    worker.releaseCount=1;const drafts=runtime.documentIndex!.drafts!;let nudges=0,retired=0;
    drafts.subscribe(()=>nudges++,()=>retired++);worker.onmessage({data:{event:'document-drafts-nudge'}});assert.equal(nudges,1);
    worker.block='document-drafts';const entered=enteredRequest(worker,'document-drafts'),pending=drafts.invoke({op:'snapshot'});await entered;
    const closing=runtime.releaseClient();await assert.rejects(drafts.invoke({op:'snapshot'}),{code:'client_not_admitted'});
    assert.equal(calls.some(call=>call.operation==='release-client'),false);worker.completeBlocked();await pending;await closing;
    assert.equal(calls.at(-1).operation,'release-client');assert.equal(retired,1);
  },20000,draftCapabilities,draftOptions);
});
