import test from 'node:test';
import assert from 'node:assert/strict';
import {browserDocumentRuntime} from '../src/core/browser-document-runtime.ts';
import type {BrowserDocumentRuntimeBackend,DocumentRuntimeEffect,DocumentRuntimeReduction,DocumentRuntimeIssued} from '../src/core/browser-document-runtime.ts';
import {BrowserVaultError} from '../src/core/browser-vault.ts';
const source={localStoreId:'store',watermark:'7'},snapshot={localStoreId:'store',generationEpoch:'epoch',generation:'1',versions:{}};
const observation={source,published:snapshot,current:true,rebuildRequired:false,coverageComplete:true};
const stage={source,snapshot,progress:{prepared:1,total:1,ready:true}};
const pause=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};
/** Scripted opaque-WASM double chooses effects only, not lifecycle policy.
 * Actual reducer and closed wire/handle rules require hosted Rust + wasm32. */
function fixture(effects:DocumentRuntimeEffect[]=[{kind:'observe'}]){
  const calls:string[]=[],commands:any[]=[],completions:any[]=[],stats={created:0,freed:0,handlesFreed:0};
  let position=0,replay:{id:string;report:string}|undefined,retired=false,denied=false;
  let barrier:Promise<void>|undefined,error:unknown,completionError=false,onInvoke:(()=>void)|undefined;
  let issued:DocumentRuntimeIssued;
  const report=():DocumentRuntimeReduction=>({effect:position<effects.length?issued:null,update:{lifetime:'runtime',revision:String(position),source,published:snapshot,freshness:'current',phase:'idle',progress:null,coverageComplete:true,hasForegroundDemand:false,error:null},requestOutcomes:[],execution:retired?'quiesced':position<effects.length?'dispatch':'waitForWake'});
  function next(){issued={lifetime:'runtime',effectId:String(position+1),priority:'background',targetSource:source,effect:effects[position]??{kind:'observe'}};}
  next();
  class Owner {
    constructor(){stats.created++;}
    commandJson(raw:string){const command=JSON.parse(raw);if(command.kind==='retire'&&Object.keys(command).length!==1)throw '{"code":"invalid_request"}';commands.push(command);if(command.kind==='retire'){retired=true;replay=undefined;}return JSON.stringify(report());}
    updateJson(){return JSON.stringify(report().update);}
    snapshotJson(){return JSON.stringify({update:report().update,inFlight:position<effects.length?issued:null,lastStep:replay?{lifetime:'runtime',effectId:replay.id,reduction:JSON.parse(replay.report)}:null});}
    replayJson(lifetime:string,id:string){assert.equal(lifetime,'runtime');return replay?.id===id?replay.report:undefined;}
    issued(lifetime:string,id:string){assert.equal(lifetime,'runtime');assert.equal(id,issued.effectId);const captured=structuredClone(issued);return {
      descriptorJson:()=>JSON.stringify(captured),free(){stats.handlesFreed++;},
      completeJson(raw:string){if(completionError)throw '{"code":"document_runtime_expired"}';completions.push(JSON.parse(raw));position++;next();const value=JSON.stringify(report());if(!retired)replay={id,report:value};return value;},
    };}
    free(){stats.freed++;}
  }
  const invoke=async(name:string,value?:unknown)=>{calls.push(name);onInvoke?.();await barrier;if(error)throw error;return value;};
  const backend:BrowserDocumentRuntimeBackend={assertActive(){if(denied)throw new BrowserVaultError('client_ownership_lost','lease gone');},
    observe:()=>invoke('observe',observation) as Promise<typeof observation>,initialize:()=>invoke('initialize') as Promise<void>,recoverStage:()=>invoke('recoverStage',stage) as Promise<typeof stage>,begin:()=>invoke('begin',stage) as Promise<typeof stage>,
    pump:async selected=>{assert.deepEqual(selected,snapshot);return invoke('pump',stage) as Promise<typeof stage>;},publish:async selected=>{assert.deepEqual(selected,snapshot);return invoke('publish',snapshot) as Promise<typeof snapshot>;},discard:async selected=>{assert.deepEqual(selected,snapshot);await invoke('discard');},rebuild:()=>invoke('rebuild') as Promise<void>};
  const maintenance=browserDocumentRuntime({authorityId:'store',wasm:{WasmDocumentRuntimeOwner:Owner},backend});
  return {maintenance,stats,calls,commands,completions,backend,token:()=>({lifetime:'runtime',effectId:issued.effectId}),hold(promise:Promise<void>){barrier=promise;},deny(){denied=true;},fail(value:unknown){error=value;},badComplete(){completionError=true;},onInvoke(callback:()=>void){onInvoke=callback;}};
}

test('runtime remains lazy and captures a checked monotonic clock independently of evaluation time',async()=>{
  const f=fixture();assert.equal(f.maintenance.update(),null);assert.equal(f.stats.created,0);
  assert.throws(()=>f.maintenance.command({kind:'wake',monotonicMs:1.5}),{code:'invalid_request'});
  const value=f.maintenance.command({kind:'wake',monotonicMs:123});assert.equal(f.commands[0].monotonicMs,'123');assert.ok(Object.isFrozen(value.update));assert.deepEqual(f.calls,[]);
  await f.maintenance.close();assert.equal(f.stats.freed,1);assert.equal(f.calls.length,0);assert.throws(()=>f.maintenance.command({kind:'continue'}),{code:'document_runtime_retired'});assert.equal(f.stats.created,1);
});
test('each step executes exactly one selected backend effect with actual small completion values',async()=>{
  const effects:DocumentRuntimeEffect[]=[{kind:'observe'},{kind:'initialize'},{kind:'recoverStage'},{kind:'begin'},{kind:'pump',snapshot},{kind:'publish',snapshot},{kind:'discard',snapshot},{kind:'rebuild'}];
  const f=fixture(effects);f.maintenance.command({kind:'wake',monotonicMs:0});
  for(let i=0;i<effects.length;i++){const result=await f.maintenance.step(f.token());assert.equal(f.calls.length,i+1);assert.equal(f.stats.handlesFreed,i+1);assert.ok(Object.isFrozen(result));}
  assert.deepEqual(f.calls,effects.map(e=>e.kind));assert.deepEqual(f.completions.map(c=>c.kind),['observed','done','recovered','stage','stage','published','done','done']);
  assert.deepEqual(f.completions[3].stage,stage);assert.deepEqual(f.completions[4].stage.source,source);await f.maintenance.close();assert.equal(f.calls.length,8);
});
test('exact completed step replays its one acknowledgment without IO or another effect',async()=>{
  const f=fixture([{kind:'pump',snapshot},{kind:'observe'}]);f.maintenance.command({kind:'continue'});const token=f.token(),first=await f.maintenance.step(token),replay=await f.maintenance.step(token);
  assert.deepEqual(replay,first);assert.deepEqual(f.calls,['pump']);assert.equal(f.stats.handlesFreed,1);await f.maintenance.step(f.token());assert.deepEqual(f.calls,['pump','observe']);await f.maintenance.close();
});
test('same in-flight token joins accepted work; close drains before free without accepting a new effect',async()=>{
  const f=fixture(),barrier=pause();f.maintenance.command({kind:'wake',monotonicMs:0});f.hold(barrier.promise);const token=f.token(),first=f.maintenance.step(token);assert.equal(first,f.maintenance.step(token));
  await assert.rejects(f.maintenance.step({...token,effectId:'99'}),{code:'document_runtime_busy'});
  const close=f.maintenance.close();assert.equal(f.stats.freed,0);assert.equal(f.commands.at(-1).kind,'retire');await assert.rejects(f.maintenance.step(token),{code:'document_runtime_retired'});
  barrier.resolve();await first;await close;assert.equal(f.stats.freed,1);assert.deepEqual(f.calls,['observe']);assert.equal(f.completions.length,1);
});
test('first failure preserves original error; exact retry retains only safe code and no IO',async()=>{
  const f=fixture(),original=new BrowserVaultError('storage_corrupt','private message',{privatePayload:'never retain'},'host');f.fail(original);f.maintenance.command({kind:'wake',monotonicMs:0});const token=f.token();
  await assert.rejects(f.maintenance.step(token),error=>error===original);await assert.rejects(f.maintenance.step(token),error=>{assert.ok(error instanceof BrowserVaultError);assert.equal(error.code,'storage_corrupt');assert.equal(error.source,'host');assert.equal(error.details,undefined);assert.ok(!error.message.includes('private message'));return true;});
  assert.deepEqual(f.completions,[{kind:'failed',failure:'invalidData'}]);assert.deepEqual(f.calls,['observe']);await f.maintenance.close();
});
test('post-await lease loss takes precedence over an operation error and never exposes a success',async()=>{
  const f=fixture(),barrier=pause();f.hold(barrier.promise);f.fail(new BrowserVaultError('index_source_changed','stale'));f.maintenance.command({kind:'wake',monotonicMs:0});const result=f.maintenance.step(f.token());await Promise.resolve();assert.deepEqual(f.calls,['observe']);f.deny();barrier.resolve();
  await assert.rejects(result,{code:'client_ownership_lost'});assert.deepEqual(f.completions,[{kind:'failed',failure:'fatal'}]);await f.maintenance.close();assert.equal(f.stats.freed,1);
});
test('rejected completion poisons the driver instead of repeating already performed IO',async()=>{
  const f=fixture();f.badComplete();f.maintenance.command({kind:'wake',monotonicMs:0});const token=f.token();await assert.rejects(f.maintenance.step(token),{code:'document_runtime_expired'});await assert.rejects(f.maintenance.step(token),{code:'document_runtime_expired'});assert.deepEqual(f.calls,['observe']);await f.maintenance.close();
});
test('missing generated runtime binding fails only when explicitly requested',async()=>{
  const f=fixture(),maintenance=browserDocumentRuntime({authorityId:'store',wasm:{},backend:f.backend});assert.equal(maintenance.update(),null);assert.throws(()=>maintenance.command({kind:'continue'}),{code:'document_runtime_unavailable'});await maintenance.close();assert.deepEqual(f.calls,[]);
});

test('rejected malformed retire preserves the single failed ACK safe error on retry',async()=>{
  const f=fixture();f.fail(new BrowserVaultError('storage_corrupt','private',{private:true}));f.maintenance.command({kind:'continue'});const token=f.token();await assert.rejects(f.maintenance.step(token),{code:'storage_corrupt'});
  assert.throws(()=>f.maintenance.command({kind:'retire',extra:1} as any),{code:'invalid_request'});await assert.rejects(f.maintenance.step(token),{code:'storage_corrupt'});assert.deepEqual(f.calls,['observe']);
  const state=f.maintenance.snapshot();assert.equal(state?.lastStep?.effectId,token.effectId);assert.deepEqual(f.completions,[{kind:'failed',failure:'invalidData'}]);await f.maintenance.close();
});
test('accepted-step reservation precedes a synchronous backend prefix that closes its owner',async()=>{
  const f=fixture();f.maintenance.command({kind:'continue'});let close:Promise<void>|undefined;f.onInvoke(()=>{close=f.maintenance.close();assert.equal(f.stats.freed,0);});
  const step=f.maintenance.step(f.token());await step;await close;assert.equal(f.stats.freed,1);assert.equal(f.completions.length,1);assert.deepEqual(f.calls,['observe']);
});
