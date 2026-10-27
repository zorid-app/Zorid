import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabaseService} from '../src/core/databases.ts';
import type {DatabaseRequest,DatabaseResponse} from '../src/core/databases.ts';
import {createPlatformAdapter} from '../src/platform/index.ts';
const collectionId='books0000001',revision='revision',fieldId='rating000001';
const response:DatabaseResponse={collections:[{id:collectionId,name:'Books',revision,deleted:false,properties:[{id:fieldId,name:'Rating',datatype:'number',options:[]}]}],entries:[],projection:{pending:0,issues:[]}};
const envelope=(value:unknown)=>({databases:true,schemaVersion:1,ok:true,value});
const error=(code:string,commitUncertain:boolean)=>({databases:true,schemaVersion:1,ok:false,error:{code,source:'host',commitUncertain}});

test('renderer service captures the exact operation before transport and preserves uncertainty for identical replay',async()=>{
  const calls:unknown[]=[];let lost=true;
  const service=createDatabaseService(async request=>{calls.push(structuredClone(request));return lost?error('host_timeout',true):envelope(response);});
  const command:DatabaseRequest={op:'create',operationId:'same-operation',name:'Books',properties:[{name:'Rating',datatype:'number'}]};
  await assert.rejects(service.request(command),{code:'host_timeout',commitUncertain:true});lost=false;await service.request(command);
  assert.deepEqual(calls[0],calls[1]);assert.equal((calls[0] as any).command.operationId,'same-operation');
  let getters=0;const malicious={op:'create',operationId:'op',get name(){getters++;return'Books';}};
  await assert.rejects(service.request(malicious as DatabaseRequest),{code:'invalid_database_request'});assert.equal(getters,0);assert.equal(calls.length,2);
});

test('normal desktop platform exposes database service only on positive capability and stops dispatch after release',async()=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'window');let advertised=true,calls=0;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/vault',name:'Fixture'}),
    getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'store',clientId:'client'},...(advertised?{databases:true}:{})}),
    durableInvoke:async(_vault:string,_admission:string,method:string,args:any[])=>{assert.equal(method,'databaseCommand');assert.equal(args[0].schemaVersion,1);calls++;return envelope(response);},
    releaseDurableContext:async()=>{},
  }}});
  try{
    const platform=(await createPlatformAdapter())!;assert.ok(platform.databases);assert.equal(platform.databases,platform.adapter.databases);
    assert.equal((await platform.adapter.databases!.request({op:'list'})).collections[0].id,collectionId);assert.equal(calls,1);
    await platform.release!();await assert.rejects(platform.adapter.databases!.request({op:'list'}),{code:'client_not_admitted'});assert.equal(calls,1);
    advertised=false;const older=(await createPlatformAdapter())!;assert.equal(older.databases,undefined);assert.equal(older.adapter.databases,undefined);await older.release!();
  }finally{if(old)Object.defineProperty(globalThis,'window',old);else Reflect.deleteProperty(globalThis,'window');}
});

test('post-bridge decoder rejects malformed success and preserves pending projection status',async()=>{
  const pending={...response,projection:{pending:1,issues:[{message:'External file changed'}]}};
  assert.equal((await createDatabaseService(async()=>envelope(pending)).request({op:'list'})).projection.pending,1);
  for(const value of [null,{...response,entries:[{entryId:'entry'}]},{...response,collections:[...response.collections,...response.collections]}]){
    await assert.rejects(createDatabaseService(async()=>envelope(value)).request({op:'create',operationId:'op',name:'Books'}),{code:'invalid_database_response',commitUncertain:true});
  }
});


test('managed note composition uses the same admitted scope and is absent on old hosts',async()=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'window');let advertised=true,calls=0;
  const composition={current:{entryId:'entry',revision:'new-rev',path:'A.md',content:'current'},content:'composed'};
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:{
    getVault:async()=>({path:'/vault',name:'Fixture'}),
    getDurableContext:async()=>({admissionId:'admitted',scope:{vaultId:'store',clientId:'client'},...(advertised?{databases:true}:{})}),
    durableInvoke:async(vault:string,admission:string,method:string,args:any[])=>{assert.equal(vault,'/vault');assert.equal(admission,'admitted');assert.equal(method,'composeNote');assert.equal(args[0].entryId,'entry');calls++;return composition;},
    releaseDurableContext:async()=>{},
  }}});
  try{
    const platform=(await createPlatformAdapter())!,input={entryId:'entry',path:'A.md',expectedRevision:'old',baseline:'base',proposed:'draft'};
    assert.deepEqual(await platform.adapter.durableWrites!.composeNote!(input),composition);assert.equal(calls,1);await platform.release!();
    await assert.rejects(platform.adapter.durableWrites!.composeNote!(input),{code:'client_not_admitted'});assert.equal(calls,1);
    advertised=false;const older=(await createPlatformAdapter())!;assert.equal(older.adapter.durableWrites!.composeNote,undefined);await older.release!();
  }finally{if(old)Object.defineProperty(globalThis,'window',old);else Reflect.deleteProperty(globalThis,'window');}
});
