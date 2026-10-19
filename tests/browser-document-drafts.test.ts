import test from 'node:test';
import assert from 'node:assert/strict';
import {browserDraftFrames,browserDraftMethodsAvailable,draftJson,draftWasm} from '../src/core/browser-document-drafts.ts';
import type {BrowserDraftOwnerWasm} from '../src/core/browser-document-drafts.ts';
import {DOCUMENT_DRAFT_CHUNK_BYTES,DOCUMENT_DRAFT_PENDING_CALLS} from '../src/core/document-drafts.ts';
import {browserDocumentRuntime} from '../src/core/browser-document-runtime.ts';
import type {BrowserDocumentRuntimeBackend} from '../src/core/browser-document-runtime.ts';
import {BrowserVaultError} from '../src/core/browser-vault.ts';

const job={lifetime:'draft-life',id:'1',buffer_lifetime:'buffer',text_revision:'1'};
const snapshot={state:null,transfer:null,transfer_scratch_bytes:0};
const state={admitted:null,replay:false,execution:'wait_for_input',outcomes:[],usage:{source_bytes:3,scratch_bytes:0,facts_bytes:0}};
const transfer={source_bytes_received:3,source_bytes_expected:3,source_sealed:false,facts_bytes:null,scratch_bytes:0};
const ownerMethods=['free','commandJson','updateJson','snapshotJson','issued','replayJson','configureDrafts','draftCommandJson','draftUploadChunkJson','draftReadPlanJson','draftReadIntoJson','draftReleaseClientJson','workNextTurnJson','workSnapshotJson','workBeginCloseJson','workStepDraftJson','workIssued'];
const issuedMethods=['descriptorJson','replayJson','completeJson','free'];
function constructors(missingOwner?:string,missingIssued?:string){
  class Owner {} class Issued {}
  for(const method of ownerMethods)if(method!==missingOwner)Object.defineProperty(Owner.prototype,method,{value(){},configurable:true});
  for(const method of issuedMethods)if(method!==missingIssued)Object.defineProperty(Issued.prototype,method,{value(){},configurable:true});
  return {Owner,Issued};
}
test('browser draft capability requires every generated owner and opaque issued prototype method',()=>{
  const complete=constructors();assert.equal(browserDraftMethodsAvailable(complete.Owner,complete.Issued),true);
  for(const missing of ownerMethods){const partial=constructors(missing);assert.equal(browserDraftMethodsAvailable(partial.Owner,partial.Issued),false,missing);}
  for(const missing of issuedMethods){const partial=constructors(undefined,missing);assert.equal(browserDraftMethodsAvailable(partial.Owner,partial.Issued),false,missing);}
  for(const value of [undefined,null,{},()=>{}])assert.equal(browserDraftMethodsAvailable(value,complete.Issued),false);
  assert.equal(browserDraftMethodsAvailable(complete.Owner,undefined),false);
  assert.equal(browserDraftMethodsAvailable(new complete.Owner(),complete.Issued),false,'instance methods cannot advertise a generated owner constructor');
});
function frameFixture(){
  const events:string[]=[],seen:Uint8Array[]=[];let active=true,planned=3,failCopy=false,shortResult=false,retireDuringCopy=false;
  const owner={
    draftCommandJson(){events.push('control');return JSON.stringify(snapshot);},
    draftUploadChunkJson(_request:string,raw:Uint8Array){events.push('upload');seen.push(raw);return JSON.stringify({state,transfer,transfer_scratch_bytes:0});},
    draftReadPlanJson(){events.push('plan');return JSON.stringify({bytes:planned});},
    draftReadIntoJson(request:string,output:Uint8Array){events.push('copy');seen.push(output);if(failCopy)throw JSON.stringify({code:'draft_resource'});output.fill(7);if(retireDuringCopy)active=false;const input=JSON.parse(request);return JSON.stringify({job:input.job,offset:input.offset,bytes:shortResult?output.length+1:output.length,total_bytes:output.length,eof:true});},
  } as unknown as BrowserDraftOwnerWasm;
  const frames=browserDraftFrames({owner:()=>owner,assertActive(){if(!active)throw new BrowserVaultError('client_not_admitted','retired');}});
  return {frames,owner,events,seen,plan(value:number){planned=value;},failCopy(value:boolean){failCopy=value;},shortResult(value:boolean){shortResult=value;},retireDuringCopy(value:boolean){retireDuringCopy=value;},activate(){active=true;}};
}
const read={op:'facts_read',job,offset:'0',maximum:DOCUMENT_DRAFT_CHUNK_BYTES} as const;
test('browser draft upload passes the same bounded JS array reference into WASM without another body clone',()=>{
  const f=frameFixture(),raw=new Uint8Array([1,2,3]);
  const frame=f.frames.invoke({op:'upload_chunk',job,offset:'0'},raw);
  assert.equal(f.seen[0],raw);assert.deepEqual([...raw],[1,2,3]);assert.deepEqual(f.events,['upload']);assert.equal(frame.bytes.length,0);
  frame.release();frame.release();
  for(const bytes of [new Uint8Array(0),new Uint8Array(DOCUMENT_DRAFT_CHUNK_BYTES+1)])assert.throws(()=>f.frames.invoke({op:'upload_chunk',job,offset:'0'},bytes),{code:'draft_invalid_chunk'});
  assert.throws(()=>f.frames.invoke({op:'snapshot'},raw),{code:'draft_invalid_chunk'});assert.equal(f.seen.length,1,'invalid raw input never enters WASM');
});
test('browser draft facts plan precedes the exact bounded output allocation and copy response is strict',()=>{
  const f=frameFixture();f.plan(DOCUMENT_DRAFT_CHUNK_BYTES);
  const frame=f.frames.invoke(read);assert.deepEqual(f.events,['plan','copy']);assert.equal(frame.bytes,f.seen[0]);assert.equal(frame.bytes.length,DOCUMENT_DRAFT_CHUNK_BYTES);assert.equal(frame.bytes[0],7);frame.release();
  for(const size of [-1,1.5,DOCUMENT_DRAFT_CHUNK_BYTES+1]){f.events.length=0;f.plan(size);assert.throws(()=>f.frames.invoke(read),{code:'draft_contract'});assert.deepEqual(f.events,['plan'],'bad plan is rejected before copy/allocation handoff');}
  f.plan(3);f.events.length=0;assert.throws(()=>f.frames.invoke({...read,maximum:2}),{code:'draft_contract'});assert.deepEqual(f.events,['plan']);
  f.shortResult(true);assert.throws(()=>f.frames.invoke(read),{code:'invalid_document_response'});
  f.shortResult(false);const retry=f.frames.invoke(read);assert.equal(retry.bytes.length,3);retry.release();
});
test('browser output credits remain held until handoff and failed copy or lost owner releases only its actual reservation',()=>{
  for(const failure of ['copy','owner','reply'] as const){
    const f=frameFixture(),held=Array.from({length:DOCUMENT_DRAFT_PENDING_CALLS-1},()=>f.frames.invoke(read));
    if(failure==='copy')f.failCopy(true);else if(failure==='owner')f.retireDuringCopy(true);else f.shortResult(true);
    assert.throws(()=>f.frames.invoke(read),{code:failure==='copy'?'draft_resource':failure==='owner'?'client_not_admitted':'invalid_document_response'});
    f.failCopy(false);f.retireDuringCopy(false);f.shortResult(false);f.activate();
    const last=f.frames.invoke(read);assert.throws(()=>f.frames.invoke(read),{code:'draft_capacity'});
    held[0].release();held[0].release();const replacement=f.frames.invoke(read);assert.throws(()=>f.frames.invoke(read),{code:'draft_capacity'},'duplicate release never grants an extra slot');
    for(const frame of held)frame.release();last.release();replacement.release();
    const retry=f.frames.invoke(read);retry.release();
  }
});
test('browser draft decoding bounds control and maps only typed transient WASM errors',()=>{
  assert.throws(()=>draftJson(' '.repeat(64*1024+1)),{code:'draft_control_limit'});
  assert.throws(()=>draftJson('{'),{code:'draft_contract'});
  assert.throws(()=>draftWasm(()=>{throw JSON.stringify({code:'draft_resource'});}),{code:'draft_resource'});
  assert.throws(()=>draftWasm(()=>{throw JSON.stringify({code:'commit_uncertain'});}),{code:'draft_contract'});
  const original=new BrowserVaultError('client_not_admitted','retired');assert.throws(()=>draftWasm(()=>{throw original;}),error=>error===original);
});

function opaqueWorkFixture(){
  const events:string[]=[],source={localStoreId:'store',watermark:'7'};
  const update={lifetime:'runtime',revision:'1',source,published:null,freshness:'lagging',phase:'observing',progress:null,coverageComplete:null,hasForegroundDemand:false,error:null};
  const continued={effect:null,update,execution:'waitForWake',requestOutcomes:[{kind:'cancelled',id:'7'}]};
  const selected={incarnation:'work',lane:'committed',lifetime:'runtime',id:'1'};
  let closeReady=false,ownerFreed=0,handleFreed=0,configured=0,active=true,ioError:unknown;
  let barrier:Promise<void>|undefined,observePrefix:(()=>void)|undefined;const completions:unknown[]=[];
  class Issued {
    descriptorJson(){events.push('descriptor');return JSON.stringify({lifetime:'runtime',effectId:'1',priority:'background',targetSource:source,effect:{kind:'observe'}});}
    replayJson(){return undefined;}
    completeJson(text:string){completions.push(JSON.parse(text));events.push('complete');return JSON.stringify({...continued,requestOutcomes:[]});}
    free(){handleFreed++;}
  }
  class Owner {
    commandJson(){return JSON.stringify({...continued,requestOutcomes:[]});}
    updateJson(){return JSON.stringify(update);}
    snapshotJson(){return JSON.stringify({update,execution:'waitForWake',inFlight:null,lastStep:null});}
    issued():never{assert.fail('legacy issued route must not run under a composite selection');}
    replayJson(){return undefined;}
    free(){ownerFreed++;}
    configureDrafts(){configured++;}
    draftCommandJson(){return JSON.stringify(snapshot);}
    draftUploadChunkJson(){return JSON.stringify({state,transfer,transfer_scratch_bytes:0});}
    draftReadPlanJson(){return '{"bytes":0}';}
    draftReadIntoJson(){return JSON.stringify({job,offset:'0',bytes:0,total_bytes:0,eof:true});}
    draftReleaseClientJson(){closeReady=true;return this.workSnapshotJson();}
    workNextTurnJson(){events.push('next');return JSON.stringify({work:{selected,last_settled:null,closing:false,close_ready:false},turn:{state:'ready'},continued});}
    workSnapshotJson(){return JSON.stringify({work:{selected:null,last_settled:selected,closing:closeReady,close_ready:closeReady},turn:null});}
    workBeginCloseJson(){closeReady=true;return this.workSnapshotJson();}
    workStepDraftJson():never{assert.fail('core selected committed IO, not a draft parser phase');}
    workIssued(text:string){assert.deepEqual(JSON.parse(text),selected);events.push('issued');return new Issued();}
  }
  const unused=async():Promise<never>=>{assert.fail('unselected backend effect');};
  const backend:BrowserDocumentRuntimeBackend={assertActive(){if(!active)throw new BrowserVaultError('client_ownership_lost','lease revoked');},async observe(){events.push('observe');observePrefix?.();await barrier;if(ioError)throw ioError;return {source,published:null,current:false,rebuildRequired:false,coverageComplete:null};},initialize:unused,recoverStage:unused,begin:unused,pump:unused,publish:unused,discard:unused,rebuild:unused};
  const maintenance=browserDocumentRuntime({authorityId:'store',wasm:{WasmDocumentRuntimeOwner:Owner,WasmDocumentWorkIssued:Issued},backend});
  assert.equal(maintenance.draftsAvailable,true);maintenance.configureDrafts!({localStoreId:'store',clientId:'client'});maintenance.command({kind:'wake',monotonicMs:1});
  return {maintenance,events,completions,hold(value:Promise<void>){barrier=value;},onObserve(callback:()=>void){observePrefix=callback;},fail(value:unknown){ioError=value;},revoke(){active=false;},ownerFreed:()=>ownerFreed,handleFreed:()=>handleFreed,configured:()=>configured};
}
test('composite WASM binding adopts actual Continue outcomes before issuing CIO and frees only the opaque handle',async()=>{
  const f=opaqueWorkFixture();const turn=await f.maintenance.workTurn!(value=>{if(value.requestOutcomes.length)f.events.push('adopt:'+value.requestOutcomes[0].id);});
  assert.deepEqual(f.events,['next','adopt:7','issued','descriptor','observe','complete']);assert.equal(turn.reductions.length,2);assert.equal(f.handleFreed(),1);assert.equal(f.ownerFreed(),0);assert.equal(f.configured(),1);assert.deepEqual(f.completions.map(value=>(value as {kind:string}).kind),['observed']);
  f.maintenance.releaseDrafts!();await f.maintenance.close();assert.equal(f.ownerFreed(),1);assert.equal(f.handleFreed(),1);
});
test('failed CIO under a live lease settles exactly one actual Failed completion and yields a future Ready turn',async()=>{
  const f=opaqueWorkFixture(),original=new BrowserVaultError('storage_corrupt','actual IO failure');f.fail(original);
  const turn=await f.maintenance.workTurn!();assert.equal(turn.state,'ready');assert.equal(turn.error,original);assert.deepEqual(f.completions,[{kind:'failed',failure:'invalidData'}]);assert.equal(f.handleFreed(),1);assert.equal(f.ownerFreed(),0);
  f.maintenance.releaseDrafts!();await f.maintenance.close();assert.equal(f.ownerFreed(),1);
});
test('real lease revocation after CIO await prevents any private completion or later work RPC',async()=>{
  const f=opaqueWorkFixture();let resume!:()=>void;const barrier=new Promise<void>(resolve=>{resume=resolve;});f.hold(barrier);
  const turn=f.maintenance.workTurn!();await Promise.resolve();assert.equal(f.events.at(-1),'observe');f.revoke();resume();
  await assert.rejects(turn,{code:'client_ownership_lost'});assert.deepEqual(f.completions,[]);assert.equal(f.handleFreed(),1);assert.equal(f.ownerFreed(),0);
  const before=[...f.events];assert.throws(()=>f.maintenance.workTurn!(),{code:'client_ownership_lost'});assert.deepEqual(f.events,before,'guard rejection happens before next_turn or another private RPC');
});

test('composite pending reservation precedes synchronous Continue and backend re-entry and close awaits that same operation',async()=>{
  const f=opaqueWorkFixture();let resume!:()=>void;f.hold(new Promise<void>(resolve=>{resume=resolve;}));
  let fromContinue:ReturnType<NonNullable<typeof f.maintenance.workTurn>>|undefined,fromObserve:ReturnType<NonNullable<typeof f.maintenance.workTurn>>|undefined;
  f.onObserve(()=>{fromObserve=f.maintenance.workTurn!();assert.equal(fromObserve,first);});
  const first=f.maintenance.workTurn!(value=>{if(value.requestOutcomes.length){fromContinue=f.maintenance.workTurn!();assert.equal(fromContinue,first);}});
  assert.deepEqual(f.events,[],'reservation is visible before any callback or backend prefix runs');
  await Promise.resolve();assert.equal(fromContinue,first);assert.equal(fromObserve,first);
  assert.equal(f.events.filter(value=>value==='next').length,1);assert.equal(f.events.filter(value=>value==='observe').length,1);assert.equal(f.completions.length,0);assert.equal(f.handleFreed(),0);
  f.maintenance.releaseDrafts!();const closing=f.maintenance.close();await Promise.resolve();assert.equal(f.ownerFreed(),0,'even an optimistic close-ready mock cannot free an accepted pending operation');
  resume();await first;await closing;
  assert.equal(f.completions.length,1);assert.deepEqual(f.completions.map(value=>(value as {kind:string}).kind),['observed']);assert.equal(f.handleFreed(),1);assert.equal(f.ownerFreed(),1);
  assert.equal(f.events.filter(value=>value==='next').length,1);assert.equal(f.events.filter(value=>value==='observe').length,1);
});
