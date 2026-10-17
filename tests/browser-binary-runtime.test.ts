import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserCoreRuntime } from '../src/platform/browser-core-runtime.ts';
import { admitBrowserClient } from '../src/platform/browser-client-admission.ts';
import type { Checkpoint } from '../src/core/durable-checkpoints.ts';
import type { BinaryStageRef, BinaryReadRef } from '../src/core/binary-streams.ts';
const authority='12345678-1234-4123-8123-123456789abc',clientId='22222222-2222-4222-8222-222222222222';
const limits={maxFileBytes:'67108864',maxChunkBytes:131072,smallReadBytes:'1048576'};
const stage:BinaryStageRef={localStoreId:authority,clientId,operationId:'operation',stageId:'stage'};
function deferred(){let resolve!:(value?:unknown)=>void;const promise=new Promise(resolveValue=>{resolve=resolveValue;});return {resolve,promise};}
async function fixture(action:(f:{runtime:BrowserCoreRuntime;calls:any[];heads:Map<string,Checkpoint>;worker:any})=>Promise<void>,options:{timeoutMs?:number;seed?:ReadStateSeed;empty?:boolean;legacyFixture?:true}={}){
  const saved=new Map(['Worker','document','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const calls:any[]=[],heads=new Map<string,Checkpoint>();let sequence=0,worker:any;
  if(options.seed){const state=options.seed,key='binary-read/v1/'+state.requestedReadId;heads.set(key,{version:1,vaultId:authority,clientId,key,revision:crypto.randomUUID(),sequence:'1',deleted:false,byteLength:1,encodedState:JSON.stringify(state)});}
  class WorkerFixture{
    onmessage?:any;terminated=false;block?:string;blocked:any;loseOpen=false;loseClose=false;
    constructor(){worker=this;}
    reply(message:any,result?:unknown,error?:string){queueMicrotask(()=>this.onmessage?.({data:error?{id:message.id,ok:false,error:{code:error,message:'synthetic'}}:{id:message.id,ok:true,result}}));}
    postMessage(message:any,transfer?:Transferable[]){calls.push({...structuredClone(message),transferCount:transfer?.length??0});const p=message.payload;
      if(this.block===message.operation){this.blocked=message;return;}
      switch(message.operation){
        case 'open':this.reply(message,{authorityId:authority,recovery:[],...(options.empty?{}:{binaryLimits:limits})});break;
        case 'binary-limits':this.reply(message,limits);break;
        case 'checkpoint-load':this.reply(message,structuredClone(heads.get(p)??null));break;
        case 'checkpoint-list':this.reply(message,{items:[...heads.values()],cursor:null,highWater:String(sequence)});break;
        case 'checkpoint-cas':{assert.equal(heads.get(p.key)?.revision??null,p.expectedRevision);const head:Checkpoint={version:1,vaultId:authority,clientId,key:p.key,revision:p.nextRevision,sequence:String(++sequence),deleted:p.encodedState===null,byteLength:p.encodedState?.length??0,encodedState:p.encodedState};heads.set(p.key,head);this.reply(message,structuredClone(head));break;}
        case 'binary-open-read':{if(this.loseOpen){this.loseOpen=false;this.reply(message,undefined,'outcome_unknown');break;}this.reply(message,{localStoreId:authority,clientId,readId:p.requestedReadId,entryId:p.input.entryId,entryRevision:p.input.expectedRevision??'revision',selectedContentEvent:p.input.expectedContentEvent??'event',length:'3'});break;}
        case 'binary-read':this.reply(message,{bytes:Uint8Array.of(1,2,3).slice(Number(p.input.offset),Number(p.input.offset)+p.input.maxBytes),nextOffset:String(Math.min(3,Number(p.input.offset)+p.input.maxBytes)),eof:Number(p.input.offset)+p.input.maxBytes>=3});break;
        case 'binary-close-read':if(this.loseClose){this.loseClose=false;this.reply(message,undefined,'outcome_unknown');}else this.reply(message);break;
        case 'binary-begin':this.reply(message,{...stage,operationId:p.operationId});break;
        default:this.reply(message);
      }
    }
    terminate(){this.terminated=true;}
    finish(result?:unknown){const message=this.blocked;this.block=undefined;this.blocked=undefined;this.reply(message,result);}
  }
  let runtime:BrowserCoreRuntime|undefined;
  try{Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerFixture});Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(){},removeEventListener(){},visibilityState:'visible'}});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://zorid.test/',origin:'https://zorid.test'}});
    runtime=await BrowserCoreRuntime.open({database:'normal-v7',clientId,wasmModuleUrl:'/core.js',allowNewVault:true,timeoutMs:options.timeoutMs??20000,...(options.legacyFixture?{legacyFixture:true}:{})});await action({runtime,calls,heads,worker});
  }finally{runtime?.close();for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}
}
interface ReadStateSeed{version:1;requestedReadId:string;input:{entryId:string;expectedRevision?:string;expectedContentEvent?:string};phase:'opening'|'opened'|'closing';ref?:BinaryReadRef}

test('binary append snapshots before async dispatch and leaves metadata calls independent',async()=>fixture(async({runtime,calls,worker})=>{
  worker.block='binary-append';const bytes=Uint8Array.of(1,2,3),pending=runtime.binaryStreams!.append(stage,{sequence:0,offset:'0',bytes});bytes.fill(42);await new Promise(resolve=>setImmediate(resolve));
  await runtime.readMetadata('Large.bin');assert.equal(calls.at(-1).operation,'read-metadata');const append=calls.find(value=>value.operation==='binary-append');assert.deepEqual(append.payload.input.bytes,Uint8Array.of(1,2,3));assert.equal(append.transferCount,1);assert.equal(bytes.byteLength,3);
  worker.finish({sequence:0,offset:'0',bytes:3,digest:'a'.repeat(64),acceptedLength:'3'});await pending;
}));
test('read request and returned pin persist before exposure; close ACK precedes tombstone and supports exact retry',async()=>fixture(async({runtime,calls,heads,worker})=>{
  const input={entryId:'entry',expectedRevision:'r',expectedContentEvent:'e'},opening=runtime.binaryStreams!.openRead(input);input.entryId='other';const ref=await opening;
  const phases=()=>calls.filter(value=>value.operation==='checkpoint-cas').map(value=>value.payload.encodedState===null?'tombstone':JSON.parse(value.payload.encodedState).phase);
  assert.deepEqual(phases(),['opening','opened']);assert.equal(ref.entryId,'entry');const open=calls.find(value=>value.operation==='binary-open-read');assert.equal(JSON.parse([...heads.values()][0].encodedState!).requestedReadId,open.payload.requestedReadId);
  const reading={offset:'0',maxBytes:3},part=runtime.binaryStreams!.read(ref,reading);reading.offset='999';assert.deepEqual((await part).bytes,Uint8Array.of(1,2,3));
  worker.loseClose=true;await assert.rejects(runtime.binaryStreams!.closeRead(ref),{code:'outcome_unknown'});assert.deepEqual(phases(),['opening','opened','closing']);await runtime.binaryStreams!.closeRead(ref);assert.equal([...heads.values()][0].deleted,true);assert.deepEqual(phases(),['opening','opened','closing','tombstone']);
}));
test('lost read-open ACK is closed only by original request before another explicit open',async()=>fixture(async({runtime,calls,worker,heads})=>{
  worker.loseOpen=true;await assert.rejects(runtime.binaryStreams!.openRead({entryId:'original'}),{code:'outcome_unknown'});const initial=calls.find(value=>value.operation==='binary-open-read');
  await runtime.binaryStreams!.openRead({entryId:'new-explicit'});const close=calls.find(value=>value.operation==='binary-close-request');assert.deepEqual(close.payload,initial.payload);assert.equal(calls.filter(value=>value.operation==='binary-open-read').length,2);assert.ok([...heads.values()].some(value=>value.deleted));
}));
test('startup retained read checkpoint closes original requested identity without reopening its entry',async()=>{
  const requestedReadId=crypto.randomUUID();await fixture(async({calls,heads})=>{assert.deepEqual(calls.find(value=>value.operation==='binary-close-request').payload,{requestedReadId,input:{entryId:'old-entry',expectedRevision:'old-revision',expectedContentEvent:'old-event'}});assert.equal(calls.some(value=>value.operation==='binary-open-read'),false);assert.equal([...heads.values()][0].deleted,true);},{seed:{version:1,requestedReadId,input:{entryId:'old-entry',expectedRevision:'old-revision',expectedContentEvent:'old-event'},phase:'opening'}});
});
test('binary IPC uses normal runtime deadline',async()=>fixture(async({runtime,worker})=>{
  worker.block='binary-query';await assert.rejects(runtime.binaryStreams!.query(stage),{code:'outcome_unknown'});assert.equal(worker.terminated,true);
},{timeoutMs:5}));
test('admission tracks a chunk call through release but does not admit another producer call',async()=>fixture(async({runtime,calls,worker})=>{
  const consumer=admitBrowserClient(runtime,{assertOwner(){}}),ref=await consumer.binaryStreams!.begin({operationId:'operation',target:{kind:'create',entryId:'entry',path:'Large.bin'}});
  worker.block='binary-append';const append=consumer.binaryStreams!.append(ref,{sequence:0,offset:'0',bytes:Uint8Array.of(1)});await new Promise(resolve=>setImmediate(resolve));const releasing=consumer.release(()=>{});await assert.rejects(consumer.binaryStreams!.query(ref),{code:'client_not_admitted'});assert.equal(calls.some(value=>value.operation==='release-client'),false);worker.finish({sequence:0,offset:'0',bytes:1,digest:'a'.repeat(64),acceptedLength:'1'});await append;await releasing;assert.equal(worker.terminated,true);
}));

test('empty normal fixture gains scoped binary capability after explicit enrollment; legacy fixture keeps reference path',async()=>{
  const credentials={endpoint:'https://relay.test',realmId:'r',vaultId:'v',serverEpoch:'e',keyEpoch:1,bearerToken:'secret',keyBytes:new Uint8Array(32),enrollEmpty:true};
  await fixture(async({runtime,calls})=>{assert.equal(runtime.binaryStreams,undefined);await runtime.configureSyncFixture(credentials);assert.deepEqual(runtime.binaryStreams!.limits,limits);assert.deepEqual(calls.map(call=>call.operation),['open','sync-configure','binary-limits','checkpoint-list']);await runtime.binaryStreams!.begin({operationId:'enrolled',target:{kind:'create',entryId:'entry',path:'Large.bin'}});assert.equal(calls.at(-1).operation,'binary-begin');},{empty:true});
  await fixture(async({runtime,calls})=>{assert.equal(calls[0].payload.legacyFixture,true);await runtime.configureSyncFixture(credentials);assert.equal(runtime.binaryStreams,undefined);await runtime.readMetadata('Large.bin');await runtime.readMetadataById('entry');assert.deepEqual(calls.map(call=>call.operation),['open','sync-configure','read','read-id']);},{empty:true,legacyFixture:true});
});

test('stalled binary calls share the bounded eight-call dispatch budget without retaining a file queue',async()=>fixture(async({runtime,calls,worker})=>{
  worker.block='binary-query';const accepted=Array.from({length:8},()=>runtime.binaryStreams!.query(stage));await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(runtime.binaryStreams!.query(stage),{code:'client_queue_full'});assert.equal(calls.filter(call=>call.operation==='binary-query').length,8);
  for(const call of calls.filter(call=>call.operation==='binary-query'))worker.reply(call,{ref:stage,phase:'receiving',acceptedLength:'0',nextSequence:0});
  await Promise.all(accepted);
}));
