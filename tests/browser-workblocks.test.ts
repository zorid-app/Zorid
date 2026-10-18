import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserWorkBlocks} from '../src/platform/browser-workblocks.ts';
import {admitBrowserClient} from '../src/platform/browser-client-admission.ts';
import {BrowserCoreRuntime} from '../src/platform/browser-core-runtime.ts';
import type {BrowserWorkBlockRequest} from '../src/platform/browser-workblocks.ts';
const revision=Array.from({length:32},(_,i)=>i);
const input=()=>({record:'record',generation:'generation',operation:'operation',range:{start_ms:'1',end_ms:'2',timezone:'UTC'},title:'title'});
const receipt=(operation='operation')=>({operation,revision,sequence:'9007199254740993'});
const envelope=(r:BrowserWorkBlockRequest,value:unknown)=>({schemaVersion:1,op:r.command.op,value});
const read=(record='record',generation='generation')=>({record,generation,revision,created:true,deleted:false,block:{ranges:[{operation:'original',range:{start_ms:'1',end_ms:'2',timezone:'UTC'}}],titles:[{operation:'title',title:null}],taskRefs:['task']},unresolved:{future_status:'9007199254740993'}});
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}

test('immutable descriptor capture, canonical fingerprint, concurrent dedupe and explicit retry',async()=>{
  const gate=deferred<unknown>(),requests:BrowserWorkBlockRequest[]=[];
  const b=createBrowserWorkBlocks(r=>{requests.push(r);return gate.promise;});
  const original=input(),one=b.service.create(original),two=b.service.create({...original});assert.equal(one,two);
  original.range.start_ms='changed';await Promise.resolve();assert.equal(requests.length,1);assert.equal((requests[0].command.range as any).start_ms,'1');assert.ok(Object.isFrozen(requests[0].command.range));
  await assert.rejects(b.service.create({...input(),title:'different'}),{code:'operation_collision'});
  gate.resolve(envelope(requests[0],receipt()));await one;
  b.stop();await b.drain();await assert.rejects(b.service.read({record:'r',generation:'g'}),{code:'client_not_admitted'});
});

test('getters, inherited data, oversize and hidden authority never dispatch',async()=>{
  let gets=0,calls=0;const b=createBrowserWorkBlocks(async()=>{calls++;return null;});
  const getter=input();Object.defineProperty(getter,'title',{enumerable:true,get(){gets++;return 'bad';}});
  await assert.rejects(b.service.create(getter),{code:'invalid_workblock_request'});
  await assert.rejects(b.service.create(Object.assign(Object.create({}),input())),{code:'invalid_workblock_request'});
  await assert.rejects(b.service.create({...input(),title:'😀'.repeat(5000)}),{code:'request_limit'});
  await assert.rejects(b.service.create({...input(),owner:'hidden'} as any),{code:'invalid_workblock_request'});
  assert.equal(gets,0);assert.equal(calls,0);
});

test('transport does not clone domain validation or replace exact decimal/revision input',async()=>{
  const seen:BrowserWorkBlockRequest[]=[];const b=createBrowserWorkBlocks(async r=>{seen.push(r);return envelope(r,receipt());});
  // Rust must decide validity, including range order, timezone, task identity and title.
  await b.service.move({record:'record',generation:'generation',operation:'operation',expectedRevision:revision,range:{start_ms:'253402300800000',end_ms:'-5',timezone:''}});
  assert.deepEqual(seen[0].command.expectedRevision,revision);assert.equal((seen[0].command.range as any).start_ms,'253402300800000');
});

test('malformed or wrong-operation receipt stays uncertain and same-ID retry retains fingerprint',async()=>{
  for(const bad of [{...receipt(),operation:'other'},{...receipt(),revision:[1]},{...receipt(),sequence:'0'},{...receipt(),sequence:'01'}]){
    let valid=false,calls=0;const b=createBrowserWorkBlocks(async r=>{calls++;return envelope(r,valid?receipt():bad);});
    await assert.rejects(b.service.create(input()),{code:'invalid_workblock_response',commitUncertain:true});
    await assert.rejects(b.service.create({...input(),title:'different'}),{code:'operation_collision'});
    assert.equal(calls,1);valid=true;await b.service.create(input());assert.equal(calls,2);
  }
});

test('unknown failures retain all 32 identities without eviction; definite structured rejection retires',async()=>{
  let reject=true;const b=createBrowserWorkBlocks(async r=>{if(reject)throw {code:'stale_revision',source:'rust'};return envelope(r,receipt(r.command.operation as string));});
  for(let i=0;i<32;i++)await assert.rejects(b.service.create({...input(),operation:`op${i}`}),{commitUncertain:true});
  await assert.rejects(b.service.create(input()),{code:'request_limit'});reject=false;await b.service.create({...input(),operation:'op0'});await b.service.create(input());
  const definite=createBrowserWorkBlocks(async()=>{throw {code:'invalid_request',source:'rust',commitUncertain:false};});
  await assert.rejects(definite.service.create(input()),{commitUncertain:false});await assert.rejects(definite.service.create({...input(),title:'changed'}),{code:'invalid_request'});
});

test('read target/generation binding preserves every conflict candidate and unknown status',async()=>{
  let value=read('other');const b=createBrowserWorkBlocks(async r=>envelope(r,value));
  await assert.rejects(b.service.read({record:'record',generation:'generation'}),{code:'invalid_workblock_response'});
  value=read('record','other');await assert.rejects(b.service.read({record:'record',generation:'generation'}));
  value=read();value.block.ranges.push({...value.block.ranges[0],operation:'conflict'});
  const result=await b.service.read({record:'record',generation:'generation'});assert.deepEqual(result,value);
});

test('window request-bound budget/progress/cursor validation',async()=>{
  const query={fromMs:'0',untilMs:'10',limit:2,byteLimit:1000,cursor:'old'};
  const good={blocks:[read()],cursor:'next',incomplete:true,watermark:'5',scanned:2,bytes:1000};
  for(const value of [{...good,scanned:3},{...good,bytes:1001},{...good,scanned:-1},{...good,cursor:'old'},{...good,incomplete:false},{...good,blocks:[],scanned:0,bytes:0}]){
    const b=createBrowserWorkBlocks(async r=>envelope(r,value));await assert.rejects(b.service.windowPage(query),{code:'invalid_workblock_response'});
  }
  const b=createBrowserWorkBlocks(async r=>envelope(r,good));assert.deepEqual(await b.service.windowPage(query),good);
});

test('changes strictly advance original after, limit and exact next; future statuses survive',async()=>{
  const row={sequence:'6',record_key:'["record","generation"]',update_id:'update',status:'future_status'};
  for(const value of [{changes:[row],next:'7'},{changes:[row,row],next:'6'},{changes:[{...row,sequence:'5'}],next:'5'},{changes:[],next:'6'},{changes:[{...row,record_key:'wrong'}],next:'6'}]){
    const b=createBrowserWorkBlocks(async r=>envelope(r,value));await assert.rejects(b.service.changes({after:'5',limit:1}),{code:'invalid_workblock_response'});
  }
  const good={changes:[row],next:'6'},b=createBrowserWorkBlocks(async r=>envelope(r,good));assert.deepEqual(await b.service.changes({after:'5',limit:1}),good);
});

test('stop synchronously fences new calls while draining accepted request',async()=>{
  const gate=deferred<unknown>();let request!:BrowserWorkBlockRequest;
  const b=createBrowserWorkBlocks(r=>{request=r;return gate.promise;});const accepted=b.service.create(input());
  b.stop();let drained=false;const closing=b.drain().then(()=>drained=true);await Promise.resolve();assert.equal(drained,false);
  await assert.rejects(b.service.create({...input(),operation:'new'}),{code:'client_not_admitted'});
  gate.resolve(envelope(request,receipt()));await accepted;await closing;assert.equal(drained,true);
});

async function runtimeFixture(action:(runtime:BrowserCoreRuntime,worker:any,calls:any[])=>Promise<void>,ready=true,timeoutMs=20000){
  const originals=new Map(['Worker','document','location'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));let worker:any;const calls:any[]=[];
  class WorkerDouble{
    onmessage?: (e:any)=>void;onerror?:()=>void;terminated=false;blocked:any;hold=false;holdConfigure=false;holdOperation='';configured:unknown={workBlocks:false};error:unknown;
    constructor(){worker=this;}
    complete(){const m=this.blocked;this.blocked=undefined;this.reply(m);}
    reply(m:any){this.onmessage?.({data:this.error&&m.operation==='workblock-command'?{id:m.id,ok:false,error:this.error}:{id:m.id,ok:true,result:m.operation==='open'?{authorityId:'12345678-1234-4123-8123-123456789abc',recovery:[],...(ready?{workBlocks:true}:{})}:m.operation==='workblock-command'?envelope(m.payload,receipt(m.payload.command.operation)):m.operation==='sync-configure'?this.configured:m.operation==='binary-limits'?{maxFileBytes:'100',smallReadBytes:'100',maxChunkBytes:10}:m.operation==='checkpoint-list'?{items:[],cursor:null}:undefined}});}
    postMessage(m:any){calls.push(m);if(this.hold&&m.operation==='workblock-command'||this.holdConfigure&&m.operation==='sync-configure'||this.holdOperation===m.operation){this.blocked=m;return;}queueMicrotask(()=>this.reply(m));}
    terminate(){this.terminated=true;}
  }
  let runtime:BrowserCoreRuntime|undefined;
  try{
    Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerDouble});
    Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(){},removeEventListener(){}}});
    Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://zorid.test/',origin:'https://zorid.test'}});
    runtime=await BrowserCoreRuntime.open({database:'source-double',clientId:'22222222-2222-4222-8222-222222222222',wasmModuleUrl:'/core.js',allowNewVault:true,timeoutMs});
    await action(runtime,worker,calls);
  }finally{runtime?.close();for(const [k,d]of originals){if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}}
}

test('runtime capability is optional; structured error keeps Rust source and commitUncertain',async()=>{
  await runtimeFixture(async runtime=>assert.equal(runtime.workBlocks,undefined),false);
  await runtimeFixture(async(runtime,worker)=>{
    worker.error={code:'stale_revision',source:'rust',commitUncertain:false};
    await assert.rejects(runtime.workBlocks!.create(input()),{code:'stale_revision',source:'rust',commitUncertain:false});
    worker.error={code:'stale_revision',source:'rust'};
    await assert.rejects(runtime.workBlocks!.create({...input(),title:'second'}),{code:'invalid_workblock_response',commitUncertain:true});
    worker.error=undefined;
    await assert.rejects(runtime.workBlocks!.create(input()),{code:'operation_collision'});
    await runtime.workBlocks!.create({...input(),title:'second'});
  });
});

test('runtime release drains accepted semantic call before worker release, fences new calls',async()=>{
  await runtimeFixture(async(runtime,worker,calls)=>{
    worker.hold=true;const accepted=runtime.workBlocks!.create(input());
    while(!worker.blocked)await new Promise(r=>setImmediate(r));
    const closing=runtime.releaseClient();await assert.rejects(runtime.workBlocks!.create({...input(),operation:'late'}),{code:'client_not_admitted'});
    await assert.rejects(runtime.inventory(),{code:'client_not_admitted'});assert.equal(calls.some(c=>c.operation==='release-client'),false);
    worker.complete();await accepted;await closing;assert.equal(worker.terminated,true);assert.equal(calls.at(-1).operation,'release-client');
  });
});

test('admission guards queued owner loss, drains all WorkBlock calls before release',async()=>{
  await runtimeFixture(async(runtime,worker,calls)=>{
    let owner=true;const context=admitBrowserClient(runtime,{assertOwner(){if(!owner)throw Object.assign(new Error('owner lost'),{code:'owner_retired'});}});
    worker.hold=true;const accepted=context.workBlocks!.create(input());
    while(!worker.blocked)await new Promise(r=>setImmediate(r));
    const queued=context.workBlocks!.create({...input(),operation:'queued'});owner=false;
    worker.complete();await assert.rejects(accepted,{code:'client_ownership_lost',commitUncertain:true});await assert.rejects(queued,{commitUncertain:true});
    assert.equal(calls.filter(c=>c.operation==='workblock-command').length,1);
    owner=true;worker.hold=false;await context.workBlocks!.create(input());
    worker.hold=true;const next=context.workBlocks!.create({...input(),operation:'next'});while(!worker.blocked)await new Promise(r=>setImmediate(r));
    const release=context.release(()=>{});await assert.rejects(context.workBlocks!.read({record:'record',generation:'generation'}),{code:'client_not_admitted'});
    assert.equal(calls.some(c=>c.operation==='release-client'),false);worker.complete();await next;await release;assert.equal(calls.at(-1).operation,'release-client');
  });
});

test('runtime Worker loss and timeout preserve mutation uncertainty',async()=>{
  await runtimeFixture(async(runtime,worker)=>{worker.hold=true;const pending=runtime.workBlocks!.create(input());while(!worker.blocked)await new Promise(r=>setImmediate(r));worker.onerror();await assert.rejects(pending,{code:'outcome_unknown',commitUncertain:true});});
  await runtimeFixture(async(runtime,worker)=>{worker.hold=true;await assert.rejects(runtime.workBlocks!.create(input()),{code:'outcome_unknown',commitUncertain:true});assert.equal(worker.terminated,true);},true,10);
});

test('response envelope and 4MiB ceiling reject mutation acknowledgement without retiring identity',async()=>{
  for(const reply of [{schemaVersion:2,op:'create',value:receipt()},{schemaVersion:1,op:'delete',value:receipt()},{schemaVersion:1,op:'create',value:{...receipt(),extra:'x'.repeat(4194304)}}]){
    const b=createBrowserWorkBlocks(async()=>reply);await assert.rejects(b.service.create(input()),{code:'invalid_workblock_response',commitUncertain:true});
    await assert.rejects(b.service.create({...input(),title:'different'}),{code:'operation_collision'});
  }
});

test('out-of-domain budgets reach Rust unchanged and preserve its definite Limit error',async()=>{
  const seen:BrowserWorkBlockRequest[]=[];
  const b=createBrowserWorkBlocks(async r=>{seen.push(r);throw {code:'limit',source:'rust',commitUncertain:false};});
  for(const budget of [{limit:65,byteLimit:1024},{limit:0,byteLimit:1024},{limit:1,byteLimit:0},{limit:1,byteLimit:1048577}]){
    await assert.rejects(b.service.windowPage({fromMs:'0',untilMs:'1',...budget}),{code:'limit',source:'rust',commitUncertain:false});
    assert.equal(seen.at(-1)!.command.limit,budget.limit);assert.equal(seen.at(-1)!.command.byteLimit,budget.byteLimit);
  }
  await assert.rejects(b.service.changes({after:'0',limit:65}),{code:'limit',source:'rust'});
  const calls=seen.length;
  await assert.rejects(b.service.windowPage({fromMs:'0',untilMs:'1',limit:'65',byteLimit:1024} as any),{code:'invalid_workblock_request'});
  await assert.rejects(b.service.changes({after:'0',limit:Infinity}),{code:'invalid_workblock_request'});
  assert.equal(seen.length,calls);
});

test('nested member order has one immutable mutation fingerprint across dedupe and explicit uncertain retry',async()=>{
  const gate=deferred<unknown>(),seen:BrowserWorkBlockRequest[]=[];let fail=true;
  const b=createBrowserWorkBlocks(async r=>{seen.push(r);if(fail){await gate.promise;throw {code:'outcome_unknown',commitUncertain:true};}return envelope(r,receipt());});
  const first=input(),reordered={title:first.title,range:{timezone:'UTC',end_ms:'2',start_ms:'1'},operation:first.operation,generation:first.generation,record:first.record};
  const one=b.service.create(first),two=b.service.create(reordered);assert.equal(one,two);
  first.range.start_ms='rewritten';await Promise.resolve();gate.resolve(null);
  await assert.rejects(one,{commitUncertain:true});assert.equal(seen.length,1);
  await assert.rejects(b.service.create({...reordered,range:{...reordered.range,end_ms:'different'}}),{code:'operation_collision'});
  fail=false;await b.service.create(reordered);assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);
  assert.ok(Object.isFrozen(seen[0].command.range));assert.equal((seen[0].command.range as any).start_ms,'1');
});

test('changes preserve visible-ASCII local operation identities including punctuation',async()=>{
  const value={changes:[{sequence:'1',record_key:'["r:1","g/1"]',update_id:'op:1/2',status:'future_status'}],next:'1'};
  const b=createBrowserWorkBlocks(async r=>envelope(r,value));assert.deepEqual(await b.service.changes({after:'0',limit:1}),value);
});

const credentials=()=>({endpoint:'https://relay.test',realmId:'r',vaultId:'v',serverEpoch:'e',keyEpoch:1,bearerToken:'secret',keyBytes:new Uint8Array(32)});

test('post-enrollment H readiness upgrades existing admitted context once and retains its service and uncertain fingerprints',async()=>{
  await runtimeFixture(async(runtime,worker)=>{
    const context=admitBrowserClient(runtime,{assertOwner(){}});
    assert.equal(runtime.workBlocks,undefined);assert.equal(context.workBlocks,undefined);
    await runtime.configureSyncFixture(credentials());assert.equal(context.workBlocks,undefined,'negative marker grants no capability');
    worker.configured={workBlocks:true};worker.holdConfigure=true;
    const configured=runtime.configureSyncFixture({...credentials(),enrollEmpty:true});while(!worker.blocked)await new Promise(r=>setImmediate(r));
    assert.equal(context.workBlocks,undefined,'pending configuration grants no capability');worker.complete();await configured;
    const raw=runtime.workBlocks,service=context.workBlocks;assert.ok(raw);assert.ok(service);assert.equal(context.workBlocks,service);
    worker.error={code:'outcome_unknown',source:'host',commitUncertain:true};await assert.rejects(service.create(input()),{commitUncertain:true});
    worker.holdConfigure=false;await runtime.configureSyncFixture(credentials());assert.equal(runtime.workBlocks,raw);assert.equal(context.workBlocks,service);
    await assert.rejects(service.create({...input(),title:'changed'}),{code:'operation_collision'});
    worker.error=undefined;await service.create(input());
    await context.release(()=>{});await assert.rejects(service.create({...input(),operation:'late'}),{code:'client_not_admitted'});
  },false);
});

test('malformed metadata and owner loss before configure ACK never install WorkBlocks',async()=>{
  await runtimeFixture(async(runtime,worker)=>{
    const context=admitBrowserClient(runtime,{assertOwner(){}});
    worker.configured={workBlocks:'true'};await assert.rejects(runtime.configureSyncFixture(credentials()),{code:'invalid_workblock_response'});
    assert.equal(runtime.workBlocks,undefined);assert.equal(context.workBlocks,undefined);
    worker.configured=undefined;await runtime.configureSyncFixture(credentials());assert.equal(context.workBlocks,undefined,'legacy metadata absence never grants readiness');
  },false);
  await runtimeFixture(async(runtime,worker)=>{
    let owner=true;admitBrowserClient(runtime,{assertOwner(){if(!owner)throw Object.assign(new Error('owner retired'),{code:'owner_retired'});}});
    worker.holdConfigure=true;worker.configured={workBlocks:true};const pending=runtime.configureSyncFixture(credentials());while(!worker.blocked)await new Promise(r=>setImmediate(r));
    owner=false;worker.complete();await assert.rejects(pending,{code:'owner_retired'});assert.equal(runtime.workBlocks,undefined);
  },false);
});

test('post-enrollment binary recovery await cannot publish readiness after owner loss',async()=>{
  await runtimeFixture(async(runtime,worker)=>{
    let owner=true;admitBrowserClient(runtime,{assertOwner(){if(!owner)throw Object.assign(new Error('owner retired'),{code:'owner_retired'});}});
    worker.holdOperation='binary-limits';worker.configured={workBlocks:true};
    const pending=runtime.configureSyncFixture({...credentials(),enrollEmpty:true});while(!worker.blocked)await new Promise(r=>setImmediate(r));
    assert.equal(runtime.workBlocks,undefined);owner=false;worker.complete();await assert.rejects(pending,{code:'owner_retired'});assert.equal(runtime.workBlocks,undefined);
  },false);
});


test('original uncertainty survives definite pre-journal retry abort until exact original receipt',async()=>{
  let calls=0;const seen:BrowserWorkBlockRequest[]=[];
  const b=createBrowserWorkBlocks(async r=>{
    calls++;seen.push(r);
    if(calls===1)throw {code:'outcome_unknown',commitUncertain:true};
    if(calls===2)throw {code:'sync_config_changed',source:'host',commitUncertain:false};
    return envelope(r,receipt());
  });
  await assert.rejects(b.service.create(input()),{code:'outcome_unknown',commitUncertain:true});
  await assert.rejects(b.service.create(input()),{code:'sync_config_changed',commitUncertain:true});
  await assert.rejects(b.service.create({...input(),title:'changed'}),{code:'operation_collision'});
  assert.equal(calls,2);
  assert.deepEqual(await b.service.create(input()),receipt());assert.equal(calls,3);
  assert.deepEqual(seen[0],seen[1]);assert.deepEqual(seen[0],seen[2]);
  // Correlated receipt retires the retained identity; changed input may dispatch.
  await b.service.create({...input(),title:'changed'});assert.equal(calls,4);
  b.stop();await b.drain();
});
