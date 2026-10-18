import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopWorkBlocks} from '../src/platform/desktop.ts';
import {createPlatformAdapter} from '../src/platform/index.ts';
import type {DesktopWorkBlockRequest,WorkBlockCreate} from '../src/core/workblocks.ts';
const revision=Array.from({length:32},(_,i)=>255-i);
const create=():WorkBlockCreate=>({record:'record:Exact',generation:'generation/Exact',operation:'operation:Exact',range:{start_ms:'253402300800000',end_ms:'253402300801000',timezone:'UTC'},title:'你好😀'});
const receipt=(operation:unknown)=>({operation,revision,sequence:'9007199254740993'});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};}

test('renderer deduplicates concurrent operation and snapshots exact request before scheduling',async()=>{
  const gate=deferred<unknown>(),requests:DesktopWorkBlockRequest[]=[];
  const binding=createDesktopWorkBlocks(request=>{requests.push(request);return gate.promise;});
  const input=create(),first=binding.service.create(input),second=binding.service.create(input);
  input.range.start_ms='0'; // Runtime mutation of an input cannot rewrite queued work.
  assert.equal(first,second);await Promise.resolve();assert.equal(requests.length,1);
  assert.equal((requests[0].command.range as {start_ms:string}).start_ms,'253402300800000');
  await assert.rejects(binding.service.create({...create(),title:'different'}),{code:'operation_collision'});
  gate.resolve(receipt(create().operation));assert.deepEqual(await first,receipt(create().operation));await binding.release();
});

test('uncertain transport never automatically retries and only identical operation input may replay',async()=>{
  const requests:DesktopWorkBlockRequest[]=[];let fail=true;
  const binding=createDesktopWorkBlocks(async request=>{requests.push(structuredClone(request));if(fail)throw {code:'host_timeout',commitUncertain:true};return receipt(request.command.operation);});
  await assert.rejects(binding.service.create(create()),{code:'host_timeout'});assert.equal(requests.length,1);
  await assert.rejects(binding.service.create({...create(),title:'different'}),{code:'operation_collision'});assert.equal(requests.length,1);
  fail=false;await binding.service.create(create());assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  await binding.release();
});

test('malformed mutation result remains uncertain and preserves the exact opaque revision on retry',async()=>{
  const requests:DesktopWorkBlockRequest[]=[];let malformed=true;
  const binding=createDesktopWorkBlocks(async request=>{requests.push(request);return malformed?{...receipt(request.command.operation),revision:[1]}:receipt(request.command.operation);});
  const input={record:'r',generation:'g',operation:'move',expectedRevision:[...revision],range:{...create().range}};
  await assert.rejects(binding.service.move(input),{code:'invalid_workblock_response',commitUncertain:true});
  await assert.rejects(binding.service.move({...input,expectedRevision:[...revision].reverse()}),{code:'operation_collision'});
  malformed=false;await binding.service.move(input);assert.deepEqual(requests[0],requests[1]);assert.deepEqual(requests[0].command.expectedRevision,revision);await binding.release();
});

test('release drains accepted semantic requests, fences retained service and permits exact release retry',async()=>{
  const gate=deferred<unknown>();let calls=0;
  const binding=createDesktopWorkBlocks(()=>{calls++;return gate.promise;});
  const pending=binding.service.create(create());await Promise.resolve();let drained=false;
  const closing=binding.release().then(()=>{drained=true;});
  await assert.rejects(binding.service.create({...create(),operation:'new'}),{code:'client_not_admitted'});assert.equal(drained,false);
  gate.resolve(receipt(create().operation));await pending;await closing;await binding.release();assert.equal(calls,1);
});

test('pending uncertain mutation capacity is bounded without silently dropping replay identity',async()=>{
  let calls=0;const binding=createDesktopWorkBlocks(async()=>{calls++;throw {code:'host_timeout',commitUncertain:true};});
  for(let i=0;i<32;i++)await assert.rejects(binding.service.create({...create(),operation:`op${i}`}));
  await assert.rejects(binding.service.create({...create(),operation:'overflow'}),{code:'request_limit'});assert.equal(calls,32);
  await assert.rejects(binding.service.create({...create(),operation:'op0'}),{code:'host_timeout'});assert.equal(calls,33);await binding.release();
});

test('normal desktop platform injects only advertised admitted capability and drains before context release',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),calls:unknown[]=[];let advertised=true,releaseFails=true;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/vault',name:'Fixture'}),
    getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'store',clientId:'client'},...(advertised?{workBlocks:true}:{})}),
    durableInvoke:async(root:string,admission:string,method:string,args:unknown[])=>{assert.equal(root,'/vault');assert.equal(admission,'admitted');assert.equal(method,'workblockCommand');calls.push(args);return {workblocks:true,schemaVersion:1,ok:true,value:receipt((args[0] as DesktopWorkBlockRequest).command.operation)};},
    releaseDurableContext:async()=>{if(releaseFails){releaseFails=false;throw {code:'host_timeout',commitUncertain:true};}},
  }}});
  try{
    const platform=(await createPlatformAdapter())!;assert.ok(platform.workBlocks);await platform.workBlocks.create(create());assert.equal(calls.length,1);
    await assert.rejects(platform.release!(),{code:'host_timeout'});
    await assert.rejects(platform.workBlocks.create({...create(),operation:'late'}),{code:'client_not_admitted'});
    await platform.release!();advertised=false;const old=(await createPlatformAdapter())!;assert.equal(old.workBlocks,undefined);await old.release!();
  }finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});

test('renderer rejects getters without evaluating them or dispatching after release',async()=>{
  let gets=0,calls=0;const binding=createDesktopWorkBlocks(async request=>{calls++;return receipt(request.command.operation);});
  const input=create();Object.defineProperty(input,'title',{enumerable:true,get(){gets++;void binding.release();return 'title';}});
  await assert.rejects(binding.service.create(input),{code:'invalid_workblock_request'});assert.equal(gets,0);assert.equal(calls,0);
  await binding.service.create(create());assert.equal(calls,1);await binding.release();
});

test('normal admitted platform decodes cloneable bridge rejection and uncertainty in renderer',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');let reply:unknown;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/vault',name:'Fixture'}),getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'store',clientId:'client'},workBlocks:true}),
    durableInvoke:async()=>structuredClone(reply),releaseDurableContext:async()=>{},
  }}});
  try{
    const platform=(await createPlatformAdapter())!;
    reply={workblocks:true,schemaVersion:1,ok:false,error:{code:'stale_revision',source:'host',commitUncertain:false}};
    await assert.rejects(platform.workBlocks!.create(create()),{code:'stale_revision',source:'host',commitUncertain:false});
    reply={workblocks:true,schemaVersion:1,ok:false,error:{code:'workblock_transport_lost',source:'host',commitUncertain:true}};
    await assert.rejects(platform.workBlocks!.create(create()),{code:'workblock_transport_lost',commitUncertain:true});
    await assert.rejects(platform.workBlocks!.create({...create(),title:'changed'}),{code:'operation_collision'});
    reply={workblocks:true,schemaVersion:1,ok:true,value:receipt(create().operation)};assert.deepEqual(await platform.workBlocks!.create(create()),receipt(create().operation));
    reply={workblocks:true,schemaVersion:1,ok:false,error:{code:'invalid_request',source:'host',commitUncertain:'false'}};
    await assert.rejects(platform.workBlocks!.create({...create(),operation:'malformed'}),{code:'invalid_workblock_response',commitUncertain:true});
    await platform.release!();
  }finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});
