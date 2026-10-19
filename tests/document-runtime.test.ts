import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDocumentRuntimeObservation, decodeDocumentRuntimeOutcome, decodeDocumentRuntimeUpdate, documentRuntimeCounter, DocumentRuntimeError } from '../src/core/document-runtime.ts';
const source={localStoreId:'store',watermark:'18446744073709551615'};
const snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'9007199254740993',versions:{schema:1,extraction:'zorid-markdown-1:metadata-2',resolver:'resolver-1',query:'query-1'}};
const observation=()=>({source,published:snapshot,current:true,rebuildRequired:false,coverageComplete:false});
const update=(revision='9007199254740994')=>({lifetime:'lifetime',revision,source,published:snapshot,freshness:'current',phase:'idle',progress:null,coverageComplete:false,hasForegroundDemand:false,error:null});
const rejects=(value:()=>unknown)=>assert.throws(value,DocumentRuntimeError);

test('strict runtime observations preserve source, snapshot and generation coverage without inventing coveredSource',()=>{
  const input=observation(),result=decodeDocumentRuntimeObservation(input,'store');assert.deepEqual(result,input);assert.equal(Object.hasOwn(result,'coveredSource'),false);
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.published?.versions));assert.notEqual(result.source,input.source);
  input.current=false;assert.equal(result.current,true);assert.equal(result.coverageComplete,false);
});

test('canonical full-u64 counters preserve values above Number precision and reject coercions',()=>{
  assert.equal(documentRuntimeCounter('0'),'0');assert.equal(documentRuntimeCounter('18446744073709551615'),'18446744073709551615');
  for(const value of ['',0,1,1n,'00','01','-1','+1','1.0',' 1','1e3','18446744073709551616','999999999999999999999'])rejects(()=>documentRuntimeCounter(value));
  assert.equal(decodeDocumentRuntimeUpdate(update()).revision,'9007199254740994');
});

test('runtime source and snapshot proofs reject foreign stores, unknown fields and impossible current states',()=>{
  rejects(()=>decodeDocumentRuntimeObservation(observation(),'foreign'));
  rejects(()=>decodeDocumentRuntimeObservation({...observation(),coveredSource:source}));
  rejects(()=>decodeDocumentRuntimeObservation({...observation(),published:null}));
  assert.equal(decodeDocumentRuntimeObservation({...observation(),coverageComplete:null}).coverageComplete,null);
  rejects(()=>decodeDocumentRuntimeObservation({...observation(),rebuildRequired:true}));
  rejects(()=>decodeDocumentRuntimeObservation({...observation(),published:{...snapshot,localStoreId:'other'}}));
  rejects(()=>decodeDocumentRuntimeObservation({...observation(),source:{...source,watermark:'01'}}));
  for(const change of [{generation:'0'},{generationEpoch:'not/an/id'},{versions:{...snapshot.versions,schema:0}},{versions:{...snapshot.versions,query:'invalid version'}}])rejects(()=>decodeDocumentRuntimeObservation({...observation(),published:{...snapshot,...change}}));
  assert.equal(decodeDocumentRuntimeObservation({...observation(),published:null,current:false,coverageComplete:null}).published,null);
});

test('strict runtime updates bound progress and reject public completion controls or malformed scalar text',()=>{
  const initial={...update('0'),source:null,published:null,freshness:'unknown',coverageComplete:null};assert.equal(decodeDocumentRuntimeUpdate(initial).source,null);
  rejects(()=>decodeDocumentRuntimeUpdate({...update(),effect:{kind:'observe'}}));
  rejects(()=>decodeDocumentRuntimeUpdate({...update(),progress:{prepared:2,total:1,ready:false}}));
  rejects(()=>decodeDocumentRuntimeUpdate({...update(),progress:{prepared:0,total:1,ready:false,bytes:1}}));
  rejects(()=>decodeDocumentRuntimeUpdate({...update(),phase:'complete'}));
  rejects(()=>decodeDocumentRuntimeUpdate({...update(),lifetime:'\ud800'}));
  rejects(()=>decodeDocumentRuntimeUpdate({...update(),published:{...snapshot,versions:{...snapshot.versions,extraction:'é'.repeat(65)}}}));
  rejects(()=>decodeDocumentRuntimeUpdate({...update(),hasForegroundDemand:1}));
  assert.throws(()=>decodeDocumentRuntimeUpdate({...update(),oversized:'x'.repeat(65536)}),error=>error instanceof DocumentRuntimeError&&error.code==='document_runtime_capacity');
});

test('outcomes are immutable independent records; cancellation need not change the update revision',()=>{
  const before=decodeDocumentRuntimeUpdate({...update(),hasForegroundDemand:true});
  const cancelled=decodeDocumentRuntimeOutcome({kind:'cancelled',id:'9007199254740995'});assert.equal(cancelled.kind,'cancelled');
  const after=decodeDocumentRuntimeUpdate({...update(),hasForegroundDemand:true});assert.equal(before.revision,after.revision);assert.ok(Object.isFrozen(cancelled));
  const finished=decodeDocumentRuntimeOutcome({kind:'finished',id:'1',observation:observation()},'store');assert.equal(finished.kind,'finished');
  rejects(()=>decodeDocumentRuntimeOutcome({kind:'finished',id:'1',observation:observation()},'foreign'));
  rejects(()=>decodeDocumentRuntimeOutcome({kind:'failed',id:'1',failure:'SQL raw text'}));
  rejects(()=>decodeDocumentRuntimeOutcome({kind:'cancelled',id:'1',observation:observation()}));
});

import { createDocumentMaintenance, decodeDocumentRuntimeControl, decodeDocumentRuntimeControlAck, decodeDocumentRuntimeFrame, DOCUMENT_RUNTIME_BYTES } from '../src/core/document-runtime.ts';
import type { DocumentRuntimeControl, DocumentRuntimeFrame, DocumentRuntimeOutcome, DocumentRuntimeTransport, DocumentRuntimeUpdate } from '../src/core/document-runtime.ts';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(value:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(predicate:()=>boolean,label='condition'){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)assert.fail(`Timeout: ${label}`);await new Promise(resolve=>setTimeout(resolve,1));}}
const expectedScope={localStoreId:'store',clientId:'client'};
function fixture(){
  const receivers=new Set<{listener:()=>void;retire:()=>void}>(),outcomes=new Map<string,DocumentRuntimeOutcome>(),active=new Set<string>();
  let sequence=0n,request=0n,observes=0,closed=false,subscriptions=0,unsubscribed=0,ackControlFailures=0,ackOutcomeFailures=0,loseRequestReply=false;
  let current:DocumentRuntimeUpdate|null=update() as DocumentRuntimeUpdate;
  const controls:DocumentRuntimeControl[]=[],controlAcks:string[]=[],outcomeAcks:string[]=[],replay=new Map<string,unknown>();
  let observeHook:(()=>Promise<unknown>)|undefined,controlHook:((input:DocumentRuntimeControl,reply:unknown)=>Promise<unknown>)|undefined;
  const frame=():DocumentRuntimeFrame=>structuredClone({version:1,scope:expectedScope,update:current,outcomes:[...outcomes.values()].map(outcome=>({lifetime:current!.lifetime,outcome}))});
  const emit=()=>{for(const receiver of [...receivers])receiver.listener();};
  const transport:DocumentRuntimeTransport={scope:expectedScope,allocateSequence:()=>String(++sequence),allocateRequestId:()=>String(++request),
    async observe(){observes++;if(closed)throw new Error('closed');return observeHook?observeHook():frame();},
    async control(input){controls.push(structuredClone(input));if(closed)throw new Error('closed');if(replay.has(input.sequence))return replay.get(input.sequence);
      const command=input.command;if(command.kind==='request')active.add(command.id);else{active.delete(command.id);outcomes.set(command.id,{kind:'cancelled',id:command.id});}
      const reply={...structuredClone(input),frame:frame()};replay.set(input.sequence,reply);
      if(loseRequestReply){loseRequestReply=false;throw new Error('lost reply');}return controlHook?controlHook(input,reply):reply;
    },
    async ackControl({sequence}){controlAcks.push(sequence);if(ackControlFailures-->0)throw new Error('lost control ack');},
    async ackOutcome({lifetime,id}){outcomeAcks.push(`${lifetime}:${id}`);if(ackOutcomeFailures-->0)throw new Error('lost outcome ack');outcomes.delete(id);active.delete(id);},
    subscribe(listener,retire){subscriptions++;const receiver={listener,retire};receivers.add(receiver);return()=>{if(receivers.delete(receiver))unsubscribed++;};},
  };
  return {transport,controls,controlAcks,outcomeAcks,active,frame,emit,get observes(){return observes;},get subscriptions(){return subscriptions;},get unsubscribed(){return unsubscribed;},get receiverCount(){return receivers.size;},
    set update(value:DocumentRuntimeUpdate|null){if(current?.lifetime!==value?.lifetime){outcomes.clear();active.clear();replay.clear();}current=value;},get update(){return current;},set observeHook(value:(()=>Promise<unknown>)|undefined){observeHook=value;},set controlHook(value:((input:DocumentRuntimeControl,reply:unknown)=>Promise<unknown>)|undefined){controlHook=value;},
    set ackControlFailures(value:number){ackControlFailures=value;},set ackOutcomeFailures(value:number){ackOutcomeFailures=value;},set loseRequestReply(value:boolean){loseRequestReply=value;},
    finish(id:string,result:DocumentRuntimeOutcome={kind:'finished',id,observation:observation()}){outcomes.set(id,result);emit();},
    retire(){closed=true;for(const receiver of [...receivers])receiver.retire();receivers.clear();},
  };
}
const code=(expected:string)=>(error:unknown)=>error instanceof DocumentRuntimeError&&error.code===expected;

test('strict public frames bind scope and lifetime-tagged unique outcomes within 32 slots and 64KiB',()=>{
  const f=fixture(),raw=f.frame(),decoded=decodeDocumentRuntimeFrame(raw,expectedScope);assert.ok(Object.isFrozen(decoded.outcomes));
  rejects(()=>decodeDocumentRuntimeFrame({...raw,scope:{...expectedScope,clientId:'other'}},expectedScope));
  rejects(()=>decodeDocumentRuntimeFrame({...raw,version:2},expectedScope));rejects(()=>decodeDocumentRuntimeFrame({...raw,inFlight:null},expectedScope));
  const delivery={lifetime:'lifetime',outcome:{kind:'cancelled',id:'1'}};
  rejects(()=>decodeDocumentRuntimeFrame({...raw,outcomes:[delivery,delivery]},expectedScope));
  rejects(()=>decodeDocumentRuntimeFrame({...raw,outcomes:Array.from({length:33},(_,index)=>({...delivery,outcome:{kind:'cancelled',id:String(index)}}))},expectedScope));
  const maxScope={localStoreId:'s'.repeat(128),clientId:'c'.repeat(128)},maxSource={localStoreId:maxScope.localStoreId,watermark:'18446744073709551615'};
  const maxSnapshot={localStoreId:maxScope.localStoreId,generationEpoch:'e'.repeat(128),generation:'18446744073709551615',versions:{schema:0xffffffff,extraction:'x'.repeat(128),resolver:'x'.repeat(128),query:'x'.repeat(128)}};
  const maxObservation={...observation(),source:maxSource,published:maxSnapshot};
  const full={version:1,scope:maxScope,update:{...raw.update!,lifetime:'x'.repeat(128),revision:'18446744073709551615',source:maxSource,published:maxSnapshot,progress:{prepared:0xffffffff,total:0xffffffff,ready:true}},outcomes:Array.from({length:32},(_,index)=>({lifetime:'x'.repeat(128),outcome:{kind:'finished',id:String(18446744073709551615n-BigInt(index)),observation:maxObservation}}))};
  assert.ok(new TextEncoder().encode(JSON.stringify(full)).byteLength<DOCUMENT_RUNTIME_BYTES);assert.equal(decodeDocumentRuntimeFrame(full,maxScope).outcomes.length,32);
  const maxControl=decodeDocumentRuntimeControl({sequence:'18446744073709551615',command:{kind:'request',lifetime:'x'.repeat(128),id:'18446744073709551615',maxPumps:128,maxRestarts:2,forceRebuild:true}}),maxAck={...maxControl,frame:full};
  assert.ok(new TextEncoder().encode(JSON.stringify(maxAck)).byteLength<DOCUMENT_RUNTIME_BYTES);assert.equal(decodeDocumentRuntimeControlAck(maxAck,maxScope,maxControl).frame.outcomes.length,32);
  assert.equal(decodeDocumentRuntimeFrame({...raw,update:null},expectedScope).update,null);
});

test('public controls reject trusted owner work and exact ACK cannot change sequence or request options',()=>{
  const input=decodeDocumentRuntimeControl({sequence:'1',command:{kind:'request',lifetime:'lifetime',id:'1',maxPumps:8,maxRestarts:1,forceRebuild:false}}),f=fixture();
  assert.ok(Object.isFrozen(input.command));assert.equal(decodeDocumentRuntimeControlAck({...input,frame:f.frame()},expectedScope,input).sequence,'1');
  for(const kind of ['wake','continue','sourceHint','retire','complete','step'])rejects(()=>decodeDocumentRuntimeControl({sequence:'1',command:{kind}}));
  rejects(()=>decodeDocumentRuntimeControlAck({...input,sequence:'2',frame:f.frame()},expectedScope,input));
  rejects(()=>decodeDocumentRuntimeControlAck({...input,command:{...input.command,maxPumps:9},frame:f.frame()},expectedScope,input));
  rejects(()=>decodeDocumentRuntimeControl({sequence:'1',command:{...input.command,maxPumps:0}}));
});

test('receiver registration precedes capture and a nudge during capture reobserves before registration resolves',async()=>{
  const f=fixture(),first=deferred<unknown>();let count=0;f.observeHook=async()=>++count===1?first.promise:f.frame();const service=createDocumentMaintenance(f.transport),seen:(DocumentRuntimeUpdate|null)[]=[];
  const registration=service.observeAndSubscribe(value=>seen.push(value));await until(()=>count===1);assert.equal(f.receiverCount,1);
  f.update={...f.update!,revision:'9007199254740995'};f.emit();first.resolve({...f.frame(),update:update()});const registered=await registration;
  assert.equal(registered.snapshot?.revision,'9007199254740995');assert.equal(count,2);assert.ok(seen.length>=1);registered.unsubscribe();assert.equal(f.receiverCount,0);
});

test('freshness handle is synchronous, copied, bounded and resolves only an actual owned outcome',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport),opts={maxPumps:2,maxRestarts:0,forceRebuild:false};const handle=service.requestFreshness(opts);opts.maxPumps=128;
  assert.ok(handle.result instanceof Promise);await until(()=>f.controls.length===1);assert.equal(f.controls[0].command.kind,'request');assert.equal((f.controls[0].command as any).maxPumps,2);
  assert.deepEqual(f.controlAcks,['1']);f.finish('1');assert.equal((await handle.result).current,true);await until(()=>f.outcomeAcks.length===1);assert.deepEqual(f.outcomeAcks,['lifetime:1']);await until(()=>f.receiverCount===0);
  assert.equal(Object.hasOwn(await handle.result,'coveredSource'),false);for(const opts of [{maxPumps:0},{maxRestarts:3},{forceRebuild:'yes'},{step:true}])rejects(()=>service.requestFreshness(opts as any));
});

test('cancel before any wire admission sends no request or forged outcome',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport),handle=service.requestFreshness();await handle.cancel();await assert.rejects(handle.result,code('document_runtime_cancelled'));
  await Promise.resolve();assert.equal(f.controls.length,0);assert.equal(f.outcomeAcks.length,0);assert.equal(f.receiverCount,0);
});

test('cancel before request ACK waits for exact acceptance then cancels only that demand',async()=>{
  const f=fixture(),held=deferred<unknown>();f.controlHook=async(input,reply)=>input.command.kind==='request'?held.promise:reply;
  const service=createDocumentMaintenance(f.transport),handle=service.requestFreshness();await until(()=>f.controls.length===1);const cancel=handle.cancel();await Promise.resolve();assert.equal(f.controls.length,1);
  held.resolve({...f.controls[0],frame:f.frame()});await cancel;await assert.rejects(handle.result,code('document_runtime_cancelled'));
  assert.deepEqual(f.controls.map(input=>input.command.kind),['request','cancel']);assert.deepEqual(f.controlAcks,['1','2']);assert.deepEqual(f.outcomeAcks,['lifetime:1']);assert.equal(f.receiverCount,0);
});

test('same-update cancellation and finished delivery are processed independently of revision while another demand stays live',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport),one=service.requestFreshness(),two=service.requestFreshness();await until(()=>f.controls.length===2);
  const revision=f.update!.revision;await one.cancel();await assert.rejects(one.result,code('document_runtime_cancelled'));assert.equal(f.update!.revision,revision);assert.ok(f.active.has('2'));
  f.finish('2');await two.result;await until(()=>f.receiverCount===0);assert.equal(f.outcomeAcks.length,2);
});

test('lost request response retries exact control/sequence before cancel without replaying a new demand',async()=>{
  const f=fixture();f.loseRequestReply=true;const service=createDocumentMaintenance(f.transport),handle=service.requestFreshness();await assert.rejects(handle.result,code('document_runtime_unavailable'));
  await handle.cancel();assert.equal(f.controls.length,3);assert.deepEqual(f.controls[0],f.controls[1]);assert.equal(f.controls[2].command.kind,'cancel');assert.deepEqual(f.controlAcks,['1','2']);assert.equal(f.active.size,0);
});

test('failed control ACK stays owned and retries ACK without resending the accepted request',async()=>{
  const f=fixture();f.ackControlFailures=1;const service=createDocumentMaintenance(f.transport),handle=service.requestFreshness();await assert.rejects(handle.result,code('document_runtime_unavailable'));
  await handle.cancel();assert.deepEqual(f.controls.map(input=>input.command.kind),['request','cancel']);assert.deepEqual(f.controlAcks,['1','1','2']);assert.equal(f.active.size,0);
});

test('failed outcome ACK keeps bounded ownership and exact replay retries only that ACK',async()=>{
  const f=fixture();f.ackOutcomeFailures=1;const service=createDocumentMaintenance(f.transport),handle=service.requestFreshness();await until(()=>f.controls.length===1);f.finish('1');await handle.result;
  await until(()=>f.outcomeAcks.length===1);assert.equal(f.receiverCount,1);f.emit();await until(()=>f.outcomeAcks.length===2);await until(()=>f.receiverCount===0);assert.deepEqual(f.outcomeAcks,['lifetime:1','lifetime:1']);
});

test('listener unsubscribe does not cancel a demand; authoritative provider retirement rejects pending work and unhooks',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport),registration=await service.observeAndSubscribe(()=>{}),handle=service.requestFreshness();await until(()=>f.controls.length===1);
  registration.unsubscribe();assert.equal(f.receiverCount,1);f.retire();await assert.rejects(handle.result,code('document_runtime_retired'));await assert.rejects(handle.cancel(),code('document_runtime_retired'));assert.equal(f.receiverCount,0);rejects(()=>service.requestFreshness());
});

test('new runtime lifetime expires old pending results without resubmitting explicit rebuild',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport),handle=service.requestFreshness({forceRebuild:true});await until(()=>f.controls.length===1);
  f.update={...f.update!,lifetime:'new-lifetime',revision:'0'};f.emit();await assert.rejects(handle.result,code('document_runtime_expired'));assert.equal(f.controls.length,1);assert.equal((f.controls[0].command as any).forceRebuild,true);f.retire();
});

test('32 local active/unacknowledged slots apply backpressure and transport allocators survive facade recreation',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport),handles=Array.from({length:32},()=>service.requestFreshness());rejects(()=>service.requestFreshness());await until(()=>f.controls.length===32);
  for(let index=1;index<=32;index++)f.finish(String(index));await Promise.all(handles.map(handle=>handle.result));await until(()=>f.outcomeAcks.length===32);await until(()=>f.receiverCount===0);
  const next=createDocumentMaintenance(f.transport).requestFreshness();await until(()=>f.controls.length===33);assert.equal(f.controls[32].command.id,'33');f.finish('33');await next.result;await until(()=>f.receiverCount===0);
});

test('late response after authoritative retirement cannot recreate the owner or issue further ACKs',async()=>{
  const f=fixture(),held=deferred<unknown>();f.controlHook=async()=>held.promise;const service=createDocumentMaintenance(f.transport),handle=service.requestFreshness();await until(()=>f.controls.length===1);
  f.retire();await assert.rejects(handle.result,code('document_runtime_retired'));held.resolve({...f.controls[0],frame:f.frame()});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.controlAcks.length,0);assert.equal(f.outcomeAcks.length,0);assert.equal(f.receiverCount,0);
});

test('inconsistent same-revision frame is rejected before settling or ACKing any included outcome',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport),handle=service.requestFreshness();await until(()=>f.controls.length===1);
  f.observeHook=async()=>({...f.frame(),update:{...f.update!,phase:'indexing'}});f.finish('1');await assert.rejects(handle.result,code('document_runtime_invalid_result'));assert.equal(f.outcomeAcks.length,0);
  f.observeHook=undefined;f.emit();await until(()=>f.outcomeAcks.length===1);await until(()=>f.receiverCount===0);
});

test('an authoritative empty runtime observation clears the old lifetime instead of reusing its proof',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport),handle=service.requestFreshness();await until(()=>f.controls.length===1);
  f.update=null;f.emit();await assert.rejects(handle.result,code('document_runtime_expired'));
  const registration=await service.observeAndSubscribe(()=>{});assert.equal(registration.snapshot,null);registration.unsubscribe();
  const next=service.requestFreshness();await assert.rejects(next.result,code('document_runtime_not_started'));assert.equal(f.controls.length,1);f.retire();
});

test('two registrations of one listener have independent unsubscribe ownership',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport);let calls=0;const listener=()=>{calls++;};
  const first=await service.observeAndSubscribe(listener),second=await service.observeAndSubscribe(listener);first.unsubscribe();const before=calls;
  f.update={...f.update!,revision:'9007199254740995'};f.emit();await until(()=>calls>before);assert.equal(calls,before+1);assert.equal(f.receiverCount,1);second.unsubscribe();assert.equal(f.receiverCount,0);
});

test('wire progress and coverage admit exactly the core proof states without inventing unknown coverage',()=>{
  rejects(()=>decodeDocumentRuntimeUpdate({...update(),progress:{prepared:1,total:2,ready:true}}));
  rejects(()=>decodeDocumentRuntimeObservation({...observation(),published:null,current:false,coverageComplete:false}));
  rejects(()=>decodeDocumentRuntimeUpdate({...update(),published:null,freshness:'lagging',coverageComplete:false}));
  assert.equal(decodeDocumentRuntimeObservation({...observation(),coverageComplete:null}).coverageComplete,null);
  assert.equal(decodeDocumentRuntimeUpdate({...update(),coverageComplete:null}).coverageComplete,null);
});

test('authoritative runtime replacement releases all32 old slots and expires held control ACK without cross-lifetime replay',async()=>{
  const f=fixture(),service=createDocumentMaintenance(f.transport),old=Array.from({length:32},()=>service.requestFreshness({forceRebuild:true}));await until(()=>f.controls.length===32);
  f.ackControlFailures=1;const cancelled=old[0].cancel();await assert.rejects(cancelled,code('document_runtime_unavailable'));
  const oldControls=f.controls.length,oldAcks=f.controlAcks.length,oldOutcomeAcks=f.outcomeAcks.length;
  f.update=null;f.emit();await Promise.all(old.map(handle=>assert.rejects(handle.result,error=>error instanceof DocumentRuntimeError)));
  f.update={...update('0'),lifetime:'replacement'} as DocumentRuntimeUpdate;
  const next=Array.from({length:32},()=>service.requestFreshness());await until(()=>f.controls.length===oldControls+32);
  assert.equal(f.controls.at(-1)!.command.lifetime,'replacement');assert.equal(f.controls.at(-1)!.command.id,'64');assert.equal(f.controlAcks.length,oldAcks+32);
  assert.equal(f.controls.filter(input=>input.command.kind==='request'&&(input.command as any).forceRebuild===true).length,32);
  for(let id=33;id<=64;id++)f.finish(String(id));await Promise.all(next.map(handle=>handle.result));await until(()=>f.receiverCount===0);assert.equal(f.outcomeAcks.filter(key=>key.startsWith('replacement:')).length,32);assert.equal(f.outcomeAcks.length,oldOutcomeAcks+32);
});

test('new lifetime expires an in-flight old control reply while allowing fresh control admission',async()=>{
  const f=fixture(),held=deferred<unknown>();f.controlHook=async(input,reply)=>input.command.id==='1'?held.promise:reply;
  const service=createDocumentMaintenance(f.transport),old=service.requestFreshness({forceRebuild:true});await until(()=>f.controls.length===1);
  f.update={...update('0'),lifetime:'replacement'} as DocumentRuntimeUpdate;f.emit();await assert.rejects(old.result,code('document_runtime_expired'));
  const next=service.requestFreshness();await until(()=>f.controls.length===2);held.resolve({...f.controls[0],frame:{...f.frame(),update:update()}});
  f.finish('2');await next.result;await until(()=>f.receiverCount===0);assert.deepEqual(f.controlAcks,['2']);assert.deepEqual(f.outcomeAcks,['replacement:2']);
});

import { catchUpDocumentIndex, createDocumentService, documentErrorCode } from '../src/core/document-semantics.ts';
import type { DocumentService, DocumentTransport } from '../src/core/document-semantics.ts';
import type { DocumentMaintenance, DocumentRuntimeObservation } from '../src/core/document-runtime.ts';
function semanticService(maintenance?:DocumentRuntimeTransport){
  const calls:Record<string,number>={};const mark=(name:string)=>{calls[name]=(calls[name]??0)+1;};
  const forbidden=(name:string)=>async():Promise<never>=>{mark(name);throw new Error(`Unexpected low-level ${name}`);};
  const actual={source,snapshot,coveredSource:{localStoreId:'store',watermark:'42'},current:false,rebuildRequired:false,coverageComplete:false};
  const transport:DocumentTransport={...(maintenance?{maintenance}:{}),status:async()=>{mark('status');return actual;},initialize:forbidden('initialize'),rebuild:forbidden('rebuild'),begin:forbidden('begin'),pump:forbidden('pump'),publish:forbidden('publish'),discard:forbidden('discard'),open:forbidden('open'),closePin:forbidden('closePin'),metadata:forbidden('metadata'),search:forbidden('search'),backlinks:forbidden('backlinks'),base:forbidden('base')};
  return {service:createDocumentService(transport),transport,calls,actual};
}
function fakeMaintenance(){
  const result=deferred<DocumentRuntimeObservation>();let cancels=0,unsubscribes=0,observes=0;const requests:any[]=[];let listener:((value:DocumentRuntimeUpdate|null)=>void)|undefined;
  const maintenance:DocumentMaintenance={observeAndSubscribe:async next=>{observes++;listener=next;return {snapshot:{...update(),phase:'indexing',progress:{prepared:2,total:3,ready:false}} as DocumentRuntimeUpdate,unsubscribe(){unsubscribes++;}};},requestFreshness(input){requests.push(structuredClone(input));return {result:result.promise,cancel:async()=>{cancels++;}};}};
  return {maintenance,result,requests,get cancels(){return cancels;},get unsubscribes(){return unsubscribes;},get observes(){return observes;},notify(value:DocumentRuntimeUpdate|null){listener?.(value);}};
}

test('service advertises only the complete positive maintenance transport and never eagerly observes',()=>{
  const legacy=semanticService();assert.equal(legacy.service.maintenance,undefined);
  const f=fixture(),positive=semanticService(f.transport);assert.ok(positive.service.maintenance);assert.equal(f.observes,0);assert.equal(f.receiverCount,0);
  rejects(()=>createDocumentService({...legacy.transport,maintenance:{scope:expectedScope,observe:async()=>f.frame()} as DocumentRuntimeTransport}));
});

test('capable catch-up uses one owned demand and exactly one actual status with no legacy maintenance calls',async()=>{
  const raw=semanticService(),runtime=fakeMaintenance(),service:DocumentService={...raw.service,maintenance:runtime.maintenance},progress:any[]=[];
  const run=catchUpDocumentIndex(service,{isCurrent:()=>true,maxPumps:3,maxRestarts:0,rebuild:true,onProgress:value=>progress.push(value)});await until(()=>runtime.requests.length===1);
  assert.deepEqual(runtime.requests,[{maxPumps:3,maxRestarts:0,forceRebuild:true}]);assert.deepEqual(raw.calls,{});runtime.result.resolve(observation());
  const result=await run;assert.deepEqual(result,raw.actual);assert.equal(result.coveredSource?.watermark,'42');assert.deepEqual(raw.calls,{status:1});
  assert.deepEqual(progress,[{phase:'indexing',prepared:2,total:3}]);assert.equal(runtime.cancels,1);assert.equal(runtime.unsubscribes,1);
  runtime.notify({...update(),phase:'publishing'} as DocumentRuntimeUpdate);assert.equal(progress.length,1);
});

test('capable catch-up sends explicit cancellation before an in-flight admission ACK and performs no final status read',async()=>{
  const f=fixture(),held=deferred<unknown>();f.controlHook=async(input,reply)=>input.command.kind==='request'?held.promise:reply;
  const {service,calls}=semanticService(f.transport),abort=new AbortController();const run=catchUpDocumentIndex(service,{isCurrent:()=>true,signal:abort.signal});
  await until(()=>f.controls.length===1);abort.abort();assert.equal(f.controls.length,1);held.resolve({...f.controls[0],frame:f.frame()});
  await assert.rejects(run,error=>documentErrorCode(error)==='document_request_cancelled');assert.deepEqual(f.controls.map(input=>input.command.kind),['request','cancel']);assert.deepEqual(calls,{});assert.equal(f.receiverCount,0);
});

test('abort before registration completion relinquishes the late listener and never admits a demand',async()=>{
  const raw=semanticService(),registered=deferred<{snapshot:DocumentRuntimeUpdate|null;unsubscribe():void}>();let unsubscribes=0,requests=0;
  const maintenance:DocumentMaintenance={observeAndSubscribe:()=>registered.promise,requestFreshness(){requests++;throw new Error('must not request');}};
  const service={...raw.service,maintenance},abort=new AbortController();const run=catchUpDocumentIndex(service,{isCurrent:()=>true,signal:abort.signal});abort.abort();
  await assert.rejects(run,error=>documentErrorCode(error)==='document_request_cancelled');registered.resolve({snapshot:update() as DocumentRuntimeUpdate,unsubscribe(){unsubscribes++;}});await Promise.resolve();
  assert.equal(unsubscribes,1);assert.equal(requests,0);assert.deepEqual(raw.calls,{});
});

test('pre-aborted and stale continuations create no maintenance demand; later stale result still cleans its owned handle',async()=>{
  const raw=semanticService(),runtime=fakeMaintenance(),service={...raw.service,maintenance:runtime.maintenance},abort=new AbortController();abort.abort();
  await assert.rejects(catchUpDocumentIndex(service,{isCurrent:()=>true,signal:abort.signal}),error=>documentErrorCode(error)==='document_request_cancelled');assert.equal(runtime.observes,0);
  let current=true;const run=catchUpDocumentIndex(service,{isCurrent:()=>current});await until(()=>runtime.requests.length===1);current=false;runtime.result.resolve(observation());
  await assert.rejects(run,error=>documentErrorCode(error)==='document_request_cancelled');assert.equal(runtime.cancels,1);assert.equal(runtime.unsubscribes,1);assert.deepEqual(raw.calls,{});
});

test('failed capable demand retains the primary diagnostic while unsubscribing and cancelling only its own handle',async()=>{
  const raw=semanticService(),runtime=fakeMaintenance(),service={...raw.service,maintenance:runtime.maintenance},run=catchUpDocumentIndex(service,{isCurrent:()=>true});await until(()=>runtime.requests.length===1);
  runtime.result.reject(new DocumentRuntimeError('document_runtime_unavailable'));await assert.rejects(run,code('document_runtime_unavailable'));
  assert.equal(runtime.cancels,1);assert.equal(runtime.unsubscribes,1);assert.deepEqual(raw.calls,{});
});

test('capable service rebuild is one force-rebuild demand and never a raw provider rebuild',async()=>{
  const f=fixture(),{service,calls}=semanticService(f.transport),run=service.rebuild();await until(()=>f.controls.length===1);
  assert.equal(f.controls[0].command.kind,'request');assert.equal((f.controls[0].command as any).forceRebuild,true);f.finish('1');await run;
  assert.equal(f.controls.length,1);assert.deepEqual(calls,{});assert.equal(f.receiverCount,0);
});
