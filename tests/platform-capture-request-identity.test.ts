import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformAdapter} from '../src/platform/index.ts';
import {createDesktopConditionalSavedSources} from '../src/platform/desktop.ts';
import type {ConditionalSavedSourceRequest,DurableWrites} from '../src/core/durable-writes.ts';

const scope={vaultId:'capture-authority',clientId:'capture-client'};
const witness={entryId:'entry',revision:'revision',path:'Note.md'};
const captureId='00000000-0000-4000-8000-000000000001';
const request=():ConditionalSavedSourceRequest=>({captureId,logicalWitness:{...witness}});
const capture=(input:ConditionalSavedSourceRequest)=>({...input,logicalWitness:{...input.logicalWitness},source:'Exact physical source 😀\n'});
const grant={token:'independent-grant',scope:{...scope,incarnationId:'renderer-incarnation'}};
const binding=(admissionId:string)=>({admissionId,scope:{...scope},conditionalSavedSourceAvailable:true,independentJournal:structuredClone(grant)});
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){for(let n=0;n<100&&!check();n++)await drain();assert.ok(check());}
function held<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function platformFixture(t:TestContext,overrides:Record<string,unknown>={}){
  const calls:{admission:string;method:string;args:unknown[]}[]=[],receivers:{admission:string;retire:()=>void}[]=[];
  let recoveries=0;
  const bridge={getVault:async()=>({path:'/capture-fixture',name:'Capture fixture'}),getDurableContext:async()=>binding('old'),
    independentJournal:async()=>({independentJournal:true,schemaVersion:1,ok:true,value:[]}),
    recoverDurableContext:async()=>{recoveries++;return binding('fresh');},releaseDurableContext:async()=>{},onChange:()=>()=>{},
    onDocumentRuntimeNudge:(_path:string,admission:string,_nudge:()=>void,retire:()=>void)=>{receivers.push({admission,retire});return()=>{};},
    durableInvoke:async(_path:string,admission:string,method:string,args:unknown[])=>{
      calls.push({admission,method,args:structuredClone(args)});
      if(method==='captureSavedSource')return capture(args[0] as ConditionalSavedSourceRequest);
      if(method==='releaseSavedSource')return;
      if(method==='listSavedSourceRequests')return[{...request(),legacy:false}];
      throw Error('Unexpected '+method);
    },...overrides};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{zorid:bridge}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
  return{bridge,calls,receivers,get recoveries(){return recoveries;},async open(){return(await createPlatformAdapter())!;}};
}

test('capture request adapter snapshots caller UUID and exact witness before the first await',async()=>{
  const calls:{method:string;input:unknown}[]=[],gate=held<unknown>();
  const writes=createDesktopConditionalSavedSources(async(method,input)=>{calls.push({method,input});return gate.promise;},true);
  const input=request(),original=structuredClone(input),pending=writes.captureSavedSource(input);void pending.catch(()=>{});
  assert.equal(calls.length,1);assert.deepEqual(calls[0],{method:'captureSavedSource',input:original});
  assert.ok(Object.isFrozen(calls[0].input));assert.ok(Object.isFrozen((calls[0].input as ConditionalSavedSourceRequest).logicalWitness));
  (input.logicalWitness as {path:string}).path='Changed.md';gate.resolve(capture(original));
  const result=await pending;assert.equal(result.captureId,captureId);assert.deepEqual(result.logicalWitness,witness);
});

test('returned capture cannot replace the caller UUID or its immutable logical witness',async()=>{
  for(const changed of [{captureId:'00000000-0000-4000-8000-000000000002'},{logicalWitness:{...witness,revision:'other'}}]){
    const writes=createDesktopConditionalSavedSources(async()=>({...capture(request()),...changed}),true);
    await assert.rejects(writes.captureSavedSource(request()),{code:'invalid_saved_source'});
  }
});

test('new capture calls reject legacy witness-only and malformed request identities without dispatch',async()=>{
  let calls=0;const writes=createDesktopConditionalSavedSources(async()=>{calls++;return capture(request());},true);
  for(const input of [witness,{...request(),captureId:'legacy-opaque'},{...request(),captureId:captureId.toUpperCase().replace('0001','00AF')},{...request(),source:'renderer invented proof'},
    {...request(),logicalWitness:{...witness,path:'../Other.md'}}])await assert.rejects(writes.captureSavedSource(input as any),{code:'invalid_saved_source'});
  assert.equal(calls,0);
});

test('bounded pending request inventory is a strict immutable plain DTO list',async()=>{
  const row={...request(),legacy:false},rows=[row];let invoked:unknown;
  const writes=createDesktopConditionalSavedSources(async(method,input)=>{invoked={method,input};return rows;},true) as DurableWrites;
  assert.equal(typeof writes.listSavedSourceRequests,'function');
  const result=await writes.listSavedSourceRequests!();assert.deepEqual(invoked,{method:'listSavedSourceRequests',input:undefined});
  assert.deepEqual(result,rows);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result[0]));assert.ok(Object.isFrozen(result[0].logicalWitness));
  rows[0].logicalWitness.path='Changed.md';assert.equal(result[0].logicalWitness.path,'Note.md');
  for(const invalid of [[{...row,source:'body forbidden'}],Array.from({length:9},()=>({...request(),legacy:false})),[row,row],{items:[]},[{...request(),legacy:'false'}]]){
    const bad=createDesktopConditionalSavedSources(async()=>invalid,true) as DurableWrites;
    await assert.rejects(bad.listSavedSourceRequests!(),{code:'invalid_saved_source'});
  }
});

test('positive request advertisement requires a valid same-scope independent journal before editing',async t=>{
  for(const independentJournal of [undefined,{...grant,scope:{...grant.scope,clientId:'foreign'}},{...grant,token:''}]){
    const f=await platformFixture(t,{getDurableContext:async()=>{const value:any={...binding('old'),independentJournal};if(independentJournal===undefined)delete value.independentJournal;return value;}});
    await assert.rejects(f.open(),/independent|draft|conditional|capability/i);assert.equal(f.calls.length,0);
  }
});

test('caller request waits for positive same-scope admission and retries its exact original ID',async t=>{
  const old=held<unknown>(),renewal=held<ReturnType<typeof binding>>(),calls:{admission:string;input:ConditionalSavedSourceRequest}[]=[];void old.promise.catch(()=>{});
  const f=await platformFixture(t,{recoverDurableContext:()=>renewal.promise,durableInvoke:async(_path:string,admission:string,method:string,args:unknown[])=>{
    assert.equal(method,'captureSavedSource');const input=args[0] as ConditionalSavedSourceRequest;calls.push({admission,input:structuredClone(input)});
    return admission==='old'?old.promise:capture(input);
  }});
  const platform=await f.open(),input=request(),original=structuredClone(input);let settled=false;
  const pending=platform.adapter.durableWrites!.captureSavedSource!(input);void pending.then(()=>{settled=true;},()=>{settled=true;});
  old.reject(Object.assign(Error('Retired native host'),{code:'host_exited',source:'host',commitUncertain:true}));await drain();await drain();
  assert.equal(settled,false,'the original caller stays held until positive admission');assert.equal(calls.length,1);
  (input.logicalWitness as {revision:string}).revision='Newer unrelated revision';renewal.resolve(binding('fresh'));
  const result=await pending;assert.equal(result.captureId,original.captureId);assert.deepEqual(result.logicalWitness,original.logicalWitness);
  assert.deepEqual(calls,[{admission:'old',input:original},{admission:'fresh',input:original}]);
});

test('one caller capture cannot renew a second retired admission in the same bounded attempt',async t=>{
  const admissions:string[]=[];const f=await platformFixture(t,{durableInvoke:async(_path:string,admission:string)=>{admissions.push(admission);throw Object.assign(Error('Retired'),{code:'host_exited',source:'host',commitUncertain:true});}});
  const platform=await f.open();await assert.rejects(platform.adapter.durableWrites!.captureSavedSource!(request()),{code:'host_exited'});
  assert.deepEqual(admissions,['old','fresh']);assert.equal(f.recoveries,1);
});

for(const method of ['releaseSavedSource','listSavedSourceRequests'] as const)test(`${method} uses the same bounded positive-admission path and exact original arguments`,async t=>{
  const calls:{admission:string;method:string;args:unknown[]}[]=[];
  const f=await platformFixture(t,{durableInvoke:async(_path:string,admission:string,called:string,args:unknown[])=>{
    calls.push({admission,method:called,args:structuredClone(args)});assert.equal(called,method);
    if(admission==='old')throw Object.assign(Error('Retired'),{code:'client_not_admitted',source:'host',commitUncertain:false});
    return method==='releaseSavedSource'?undefined:[{captureId:'legacy-known-id',logicalWitness:{...witness},legacy:true}];
  }}),platform=await f.open(),writes=platform.adapter.durableWrites!;
  const result=method==='releaseSavedSource'?await writes.releaseSavedSource!(captureId):await writes.listSavedSourceRequests!();
  assert.deepEqual(calls.map(row=>row.admission),['old','fresh']);assert.deepEqual(calls[1].args,calls[0].args);assert.deepEqual(calls[0].args,method==='releaseSavedSource'?[captureId]:[]);
  if(method==='listSavedSourceRequests')assert.deepEqual(result,[{captureId:'legacy-known-id',logicalWitness:witness,legacy:true}]);assert.equal(f.recoveries,1);
});

test('shared capture capacity is preserved as typed host failure without pretending it is admission loss',async t=>{
  const capacity=Object.assign(Error('Shared capacity'),{code:'source_capture_capacity',source:'host',commitUncertain:false});
  const f=await platformFixture(t,{durableInvoke:async()=>{f.calls.push({admission:'old',method:'captureSavedSource',args:[]});throw capacity;}}),platform=await f.open();
  await assert.rejects(platform.adapter.durableWrites!.captureSavedSource!(request()),value=>value===capacity);assert.equal(f.calls.length,1);assert.equal(f.recoveries,0);
});

test('renewal cannot downgrade the capture capability or detach it from its independent journal',async t=>{
  for(const missing of ['capability','journal','journal-scope']){
    const fresh:any=binding('fresh');if(missing==='capability')delete fresh.conditionalSavedSourceAvailable;
    else if(missing==='journal')delete fresh.independentJournal;else fresh.independentJournal.scope.clientId='foreign';
    let calls=0;const f=await platformFixture(t,{recoverDurableContext:async()=>fresh,durableInvoke:async()=>{calls++;throw Object.assign(Error('Retired'),{code:'client_not_admitted',source:'host',commitUncertain:false});}}),platform=await f.open();
    await assert.rejects(platform.adapter.durableWrites!.captureSavedSource!(request()),{code:missing==='capability'?'durable_recovery_scope_changed':missing==='journal'?'unsupported_host_capability':'invalid_draft_response'});assert.equal(calls,1);
  }
});

test('terminal source and foreign renewed scope never replay a capture request',async t=>{
  for(const rejection of [Object.assign(Error('Definitive conflict'),{code:'conditional_source_changed',source:'host',commitUncertain:false}),Object.assign(Error('Protocol'),{code:'host_exited',source:'protocol',commitUncertain:true})]){
    const f=await platformFixture(t,{durableInvoke:async()=>{f.calls.push({admission:'old',method:'captureSavedSource',args:[]});throw rejection;}}),platform=await f.open();
    await assert.rejects(platform.adapter.durableWrites!.captureSavedSource!(request()),value=>value===rejection);assert.equal(f.calls.length,1);assert.equal(f.recoveries,0);
  }
  const f=await platformFixture(t,{recoverDurableContext:async()=>({...binding('fresh'),scope:{...scope,vaultId:'foreign'}}),durableInvoke:async()=>{f.calls.push({admission:'old',method:'captureSavedSource',args:[]});throw Object.assign(Error('Retired'),{code:'client_not_admitted',source:'host',commitUncertain:false});}}),platform=await f.open();
  await assert.rejects(platform.adapter.durableWrites!.captureSavedSource!(request()),{code:'durable_recovery_scope_changed'});assert.equal(f.calls.length,1);
});

test('ordinary owner release fences a held capture and cannot adopt its late reply',async t=>{
  const gate=held<unknown>();const f=await platformFixture(t,{durableInvoke:()=>gate.promise}),platform=await f.open();
  const pending=platform.adapter.durableWrites!.captureSavedSource!(request()),rejected=assert.rejects(pending,{code:'client_not_admitted'});
  await platform.release!();gate.resolve(capture(request()));await rejected;
});
