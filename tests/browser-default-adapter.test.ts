import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultBrowserAdapter} from '../src/platform/browser-default.ts';
import {BrowserVaultError} from '../src/core/browser-vault.ts';
import type {BrowserCoreRuntime} from '../src/platform/browser-core-runtime.ts';
import type {BrowserClientContext} from '../src/platform/browser-client-admission.ts';
test('normal adapter installs admitted durable save and retains exact uncertain command identities',async()=>{
  const calls:any[]=[];let fail=true;
  const writes={} as BrowserClientContext['durableWrites'];
  const context={durableWrites:writes,recoverCommands:async()=>false,fileCommand:async(input:any)=>{calls.push(structuredClone(input));if(fail)throw new BrowserVaultError('outcome_unknown','unknown');}} as unknown as BrowserClientContext;
  const adapter=defaultBrowserAdapter({} as BrowserCoreRuntime,context);
  assert.equal(adapter.durableWrites,writes);assert.equal(adapter.durableNamespace,true);
  await assert.rejects(adapter.createText!('One.md','draft'),{code:'outcome_unknown'});
  await assert.rejects(adapter.createText!('One.md','different'),{code:'command_pending'});assert.equal(calls.length,1);
  fail=false;await adapter.createText!('One.md','draft');assert.deepEqual(calls[0],calls[1]);
  await adapter.createText!('One.md','different');assert.notEqual(calls[2].operationId,calls[0].operationId);
});
test('normal adapter snapshots binary bytes before asynchronous command dispatch',async()=>{
  let request:any;
  const context={durableWrites:{},recoverCommands:async()=>false,fileCommand:async(input:any)=>{await Promise.resolve();request=structuredClone(input);}} as unknown as BrowserClientContext;
  const adapter=defaultBrowserAdapter({} as BrowserCoreRuntime,context),bytes=new Uint8Array([0,255,7]);
  const operation=adapter.writeBinary!('blob.bin',bytes);bytes.fill(9);await operation;
  assert.deepEqual([...request.data],[0,255,7]);
});

test('ordinary browser selection requires Rust assets rather than falling back to the preview vault',async()=>{
  const saved=Object.getOwnPropertyDescriptor(globalThis,'window');
  try{
    Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
    const {createPlatformAdapter}=await import('../src/platform/index.ts');
    await assert.rejects(createPlatformAdapter(),{code:'core_assets_missing'});
  }finally{if(saved)Object.defineProperty(globalThis,'window',saved);else Reflect.deleteProperty(globalThis,'window');}
});

test('uncertain consumer release retries only release and does not recover commands again',async()=>{
  const {createBrowserRelease}=await import('../src/platform/browser-default.ts');
  let commands=0,releases=0,slots=0,completed=0;
  const release=createBrowserRelease({recoverCommands:async()=>{commands++;return false;},release:async()=>{releases++;if(releases===1)throw new Error('release response lost');}}, {release:async()=>{slots++;}},()=>{completed++;});
  await assert.rejects(release(),/response lost/);await release();await release();
  assert.equal(commands,1);assert.equal(releases,2);assert.equal(slots,1);assert.equal(completed,1);
});
test('registry release retry after consumer release never invokes the closed consumer',async()=>{
  const {createBrowserRelease}=await import('../src/platform/browser-default.ts');
  let commands=0,releases=0,slots=0;
  const release=createBrowserRelease({recoverCommands:async()=>{assert.equal(releases,0);commands++;return false;},release:async()=>{releases++;}}, {release:async()=>{slots++;if(slots===1)throw new Error('registry write failed');}},()=>{});
  await assert.rejects(release(),/registry write/);await release();
  assert.equal(commands,1);assert.equal(releases,1);assert.equal(slots,2);
});


test('mounted binary capability snapshots small upsert bytes, deduplicates calls, and retries original committed CAS target',async()=>{
  const calls:{kind:string;input?:any}[]=[],stages=new Map<string,any>();let metadata:any=null,reads=0,failCommit=true,failClose=false,releaseMetadata!:(value?:unknown)=>void;
  const blocked=new Promise(resolve=>{releaseMetadata=resolve;});
  const streams={limits:{maxFileBytes:'67108864',maxChunkBytes:2,smallReadBytes:'16'},
    async begin(input:any){calls.push({kind:'begin',input:structuredClone(input)});const ref={localStoreId:'store',clientId:'client',operationId:input.operationId,stageId:'stage-'+input.operationId};stages.set(input.operationId,{ref,phase:'receiving',acceptedLength:'0',nextSequence:0});return ref;},
    async append(ref:any,input:any){calls.push({kind:'append',input:structuredClone(input)});const row=stages.get(ref.operationId);row.acceptedLength=String(Number(input.offset)+input.bytes.length);row.nextSequence=input.sequence+1;return {sequence:input.sequence,offset:input.offset,bytes:input.bytes.length,digest:'a'.repeat(64),acceptedLength:row.acceptedLength};},
    async seal(ref:any,input:any){calls.push({kind:'seal',input});const finalized={length:input.finalLength,sha256:'a'.repeat(64)};Object.assign(stages.get(ref.operationId),{phase:'sealed',finalized});return finalized;},
    async commit(ref:any){calls.push({kind:'commit',input:structuredClone(ref)});Object.assign(stages.get(ref.operationId),{phase:'committed',outcome:{status:'committed',receipt:'original-receipt'}});if(failCommit)throw new BrowserVaultError('outcome_unknown','lost commit reply');return 'original-receipt';},
    async query(ref:any){calls.push({kind:'query'});return structuredClone(stages.get(ref.operationId));},
    async openRead(input:any){calls.push({kind:'openRead',input:structuredClone(input)});return {localStoreId:'store',clientId:'client',readId:'pin',entryId:input.entryId,entryRevision:input.expectedRevision,selectedContentEvent:'original-event',length:'3'};},
    async closeRead(ref:any){calls.push({kind:'closeRead',input:structuredClone(ref)});if(failClose){failClose=false;throw new BrowserVaultError('outcome_unknown','lost close reply');}},
    async read(){throw new Error('whole input body must not be read');},async abort(){throw new Error('must not abort uncertain commit');},
  };
  const runtime={async readMetadata(){reads++;await blocked;return structuredClone(metadata);}} as unknown as BrowserCoreRuntime;
  const context={durableWrites:{},binaryStreams:streams,recoverCommands:async()=>false,fileCommand:async()=>{throw new Error('legacy binary command forbidden');}} as unknown as BrowserClientContext;
  const adapter=defaultBrowserAdapter(runtime,context);assert.equal(adapter.binaryStreams,streams);
  await assert.rejects(adapter.createBinary!('too-big.bin',new Uint8Array(17)),{code:'stream_required'});assert.equal(calls.length,0);
  metadata={entry:{id:'original-entry',revision:'original-revision',kind:'file'}};
  const bytes=Uint8Array.of(0,255,7),first=adapter.writeBinary('existing.bin',bytes),duplicate=adapter.writeBinary('existing.bin',bytes);assert.equal(first,duplicate);bytes.fill(9);releaseMetadata();
  await assert.rejects(first,{code:'outcome_unknown'});assert.equal(reads,1);assert.deepEqual(calls.find(call=>call.kind==='begin')!.input.target,{kind:'write',entryId:'original-entry',expectedRevision:'original-revision',expectedContentEvent:'original-event'});assert.deepEqual(calls.filter(call=>call.kind==='append').flatMap(call=>[...call.input.bytes]),[0,255,7]);
  metadata={entry:{id:'replacement-entry',revision:'replacement-revision',kind:'file'}};
  await assert.rejects(adapter.writeBinary('existing.bin',Uint8Array.of(8)),{code:'command_pending'});failCommit=false;await adapter.writeBinary('existing.bin',Uint8Array.of(0,255,7));assert.equal(reads,1);assert.equal(calls.filter(call=>call.kind==='begin').length,1);const commits=calls.filter(call=>call.kind==='commit');assert.equal(commits.length,2);assert.deepEqual(commits[0].input,commits[1].input);
  metadata=null;await adapter.writeBinary('absent.bin',Uint8Array.of(1));assert.equal(calls.filter(call=>call.kind==='begin').at(-1)!.input.target.kind,'create');
  const readsBefore=reads;await adapter.createBinary!('explicit.bin',Uint8Array.of(2));assert.equal(reads,readsBefore);assert.equal(calls.filter(call=>call.kind==='begin').at(-1)!.input.target.kind,'create');
  metadata={entry:{id:'close-entry',revision:'close-revision',kind:'file'}};failClose=true;const beforeClose=calls.length,beforeReads=reads;await assert.rejects(adapter.writeBinary('close.bin',Uint8Array.of(3)),{code:'outcome_unknown'});metadata=null;await adapter.writeBinary('close.bin',Uint8Array.of(3));const closing=calls.slice(beforeClose);assert.equal(reads,beforeReads+1);assert.equal(closing.filter(call=>call.kind==='openRead').length,1);assert.deepEqual(closing.filter(call=>call.kind==='closeRead').map(call=>call.input.readId),['pin','pin']);assert.equal(closing.find(call=>call.kind==='begin')!.input.target.entryId,'close-entry');
});


test('owning terminal rejection settles retained binary bytes and permits a fresh operation after path resolution',async()=>{
  let occupied=true;const begins:any[]=[],stages=new Map<string,any>();
  const streams={limits:{maxFileBytes:'67108864',maxChunkBytes:131072,smallReadBytes:'16'},
    async begin(input:any){begins.push(structuredClone(input));const ref={localStoreId:'store',clientId:'client',operationId:input.operationId,stageId:'stage-'+input.operationId};stages.set(input.operationId,{ref,phase:'receiving',acceptedLength:'0',nextSequence:0});return ref;},
    async append(ref:any,input:any){Object.assign(stages.get(ref.operationId),{acceptedLength:String(input.bytes.length),nextSequence:1});return {sequence:input.sequence,offset:input.offset,bytes:input.bytes.length,digest:'a'.repeat(64),acceptedLength:String(input.bytes.length)};},
    async seal(ref:any,input:any){const finalized={length:input.finalLength,sha256:'a'.repeat(64)};Object.assign(stages.get(ref.operationId),{phase:'sealed',finalized});return finalized;},
    async commit(ref:any){const row=stages.get(ref.operationId);if(occupied){row.phase='rejected';row.outcome={status:'rejected',error:{code:'revision_conflict',message:'Destination exists',source:'rust'}};throw new BrowserVaultError('revision_conflict','Destination exists',undefined,'rust');}row.phase='committed';row.outcome={status:'committed',receipt:'receipt'};return 'receipt';},
    async query(ref:any){return structuredClone(stages.get(ref.operationId));},
  };
  const context={durableWrites:{},binaryStreams:streams,recoverCommands:async()=>false,fileCommand:async()=>{throw new Error('legacy binary command forbidden');}} as unknown as BrowserClientContext;
  const adapter=defaultBrowserAdapter({} as BrowserCoreRuntime,context);
  await assert.rejects(adapter.createBinary!('occupied.bin',Uint8Array.of(1)),{code:'revision_conflict',message:'Destination exists',source:'rust'});
  occupied=false;await adapter.createBinary!('occupied.bin',Uint8Array.of(2));assert.equal(begins.length,2);assert.notEqual(begins[0].operationId,begins[1].operationId);assert.notEqual(begins[0].target.entryId,begins[1].target.entryId);
});


test('browser rename forwards the captured witness and retains it in the uncertain request signature',async()=>{
  const calls:any[]=[];let fail=true;
  const context={durableWrites:{},recoverCommands:async()=>false,fileCommand:async(input:any)=>{calls.push(structuredClone(input));if(fail)throw new BrowserVaultError('outcome_unknown','unknown');}} as unknown as BrowserClientContext;
  const adapter=defaultBrowserAdapter({} as BrowserCoreRuntime,context),expected={entryId:'selected',revision:'selected-revision'};
  const pending=adapter.rename('Note.md','Renamed.md',expected);expected.entryId='replacement';
  await assert.rejects(pending,{code:'outcome_unknown'});
  assert.equal(calls[0].expectedEntryId,'selected');assert.equal(calls[0].expectedRevision,'selected-revision');
  await assert.rejects(adapter.rename('Note.md','Renamed.md',expected),{code:'command_pending'});
  await assert.rejects(adapter.rename('Note.md','Renamed.md'),{code:'command_pending'});
  assert.equal(calls.length,1);fail=false;
  await adapter.rename('Note.md','Renamed.md',{entryId:'selected',revision:'selected-revision'});
  assert.deepEqual(calls[1],calls[0]);
});
