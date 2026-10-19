import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentDraftService,documentDraftRequest,documentDraftReply,DOCUMENT_DRAFT_CHUNK_BYTES,DOCUMENT_DRAFT_PENDING_CALLS,DOCUMENT_DRAFT_SCRATCH_BYTES} from '../src/core/document-drafts.ts';
import type {DocumentDraftRequest,DocumentDraftTransport} from '../src/core/document-drafts.ts';
import {createDocumentService} from '../src/core/document-semantics.ts';
import type {DocumentTransport} from '../src/core/document-semantics.ts';
const job={lifetime:'draft-owner',id:'9007199254740993',buffer_lifetime:'buffer',text_revision:'18446744073709551615'};
const source={bytes:3,utf16:2,sha256:'0'.repeat(64)};
const request:DocumentDraftRequest={op:'request',buffer_lifetime:job.buffer_lifetime,text_revision:job.text_revision,source};
function reply(input:DocumentDraftRequest,transfer:unknown=null){return {result:{state:{admitted:input.op==='request'?job:null,replay:false,execution:'wait_for_input',outcomes:[],usage:{source_bytes:3,scratch_bytes:0,facts_bytes:0}},transfer,transfer_scratch_bytes:0},bytes:new Uint8Array()};}
const transfer={source_bytes_received:0,source_bytes_expected:3,source_sealed:false,facts_bytes:null,scratch_bytes:0};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(invoke:DocumentDraftTransport['invoke']){
  const slots:{listener:()=>void;onRetire:()=>void}[]=[];
  const transport:DocumentDraftTransport={scope:{localStoreId:'store',clientId:'client'},invoke,subscribe(listener,onRetire){const slot={listener,onRetire};slots.push(slot);return()=>{const i=slots.indexOf(slot);if(i>=0)slots.splice(i,1);};}};
  return {transport,slots,service:createDocumentDraftService(transport)};
}

test('draft controls preserve exact u64 tokens, capture identity and reject renderer work/parser controls',()=>{
  const input={...request,source:{...source}},captured=documentDraftRequest(input);input.source.bytes=4;assert.equal((captured as typeof request).source.bytes,3);assert.equal(Object.isFrozen(captured),true);
  for(const bad of [{op:'Complete',job},{op:'next_turn'},{op:'step',ticket:job},{...request,client_id:'other'}, {...request,text_revision:'01'},{...request,source:{...source,bytes:16777217}},{...request,source:{...source,utf16:4}},{...request,source:{...source,sha256:'A'.repeat(64)}},{op:'progress',job:{...job,id:'0'}},{op:'progress',job:{...job,id:'18446744073709551616'}},{op:'facts_read',job,offset:'0',maximum:131073}])assert.throws(()=>documentDraftRequest(bad),{code:'draft_invalid_request'});
  let ran=false;const accessor={get op(){ran=true;return 'snapshot';}};assert.throws(()=>documentDraftRequest(accessor),{code:'draft_invalid_request'});assert.equal(ran,false);
  const hidden={op:'request',buffer_lifetime:job.buffer_lifetime,text_revision:job.text_revision,extra:source};
  Object.defineProperty(hidden,'source',{get(){ran=true;return source;}});
  assert.throws(()=>documentDraftRequest(hidden),{code:'draft_invalid_request'});assert.equal(ran,false);
  const hiddenData={op:'request',buffer_lifetime:job.buffer_lifetime,text_revision:job.text_revision,extra:source};
  Object.defineProperty(hiddenData,'source',{value:source});assert.throws(()=>documentDraftRequest(hiddenData),{code:'draft_invalid_request'});
  assert.equal(documentDraftRequest({op:'progress',job:{...job,text_revision:'0'}}).op,'progress');
});

test('draft reply validates actual request admission and combined scratch, with no private phase/ticket escape',()=>{
  assert.deepEqual(documentDraftReply(request,reply(request)),reply(request).result);
  for(const bad of [
    {...reply(request),result:{...reply(request).result,state:{...reply(request).result.state,admitted:{...job,text_revision:'2'}}}},
    {...reply(request),result:{...reply(request).result,state:{...reply(request).result.state,phase:'Positions'}}},
    {...reply(request),result:{...reply(request).result,state:{...reply(request).result.state,outcomes:[{job,kind:'ready',reason:'resource'}]}}},
    {...reply(request),result:{...reply(request).result,state:{...reply(request).result.state,outcomes:[{job,kind:'ready',reason:null},{job,kind:'cancelled',reason:null}]}}},
    {...reply(request),result:{...reply(request).result,transfer_scratch_bytes:DOCUMENT_DRAFT_SCRATCH_BYTES,state:{...reply(request).result.state,usage:{source_bytes:3,scratch_bytes:1,facts_bytes:0}}}},
    {...reply(request),bytes:new Uint8Array([1])},
    {...reply(request),result:{...reply(request).result,ticket:job}},
  ])assert.throws(()=>documentDraftReply(request,bad),{code:'invalid_document_response'});
  assert.deepEqual(documentDraftReply({op:'snapshot'},{result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()}),{state:null,transfer:null,transfer_scratch_bytes:0});
});

test('transfer decoding preserves actual progress and rejects false sealed/encoded progress',()=>{
  const input:DocumentDraftRequest={op:'upload_chunk',job,offset:'0'};
  assert.equal((documentDraftReply(input,reply(input,transfer)) as any).transfer.source_bytes_expected,3);
  for(const bad of [null,{...transfer,source_bytes_received:4},{...transfer,source_sealed:true},{...transfer,facts_bytes:1},{...transfer,scratch_bytes:1},{...transfer,source_bytes_expected:16777217}])assert.throws(()=>documentDraftReply(input,reply(input,bad)),{code:'invalid_document_response'});
  assert.throws(()=>documentDraftReply({op:'facts_prepare',job},reply({op:'facts_prepare',job},{...transfer,source_bytes_received:3,source_sealed:true})),{code:'invalid_document_response'});
});

test('facts reads stay raw bounded chunks, exact job/offset and EOF without whole-result assembly',()=>{
  const input:DocumentDraftRequest={op:'facts_read',job,offset:'1',maximum:2};
  const frame={result:{job,offset:'1',bytes:2,total_bytes:5,eof:false},bytes:new Uint8Array([0x92,0xa9])};
  const decoded=documentDraftReply(input,frame) as any;assert.equal(decoded.bytes,frame.bytes);assert.deepEqual([...decoded.bytes],[0x92,0xa9],'a raw chunk may cut a UTF8 sequence');
  for(const bad of [
    {...frame,result:{...frame.result,job:{...job,lifetime:'expired'}}},
    {...frame,result:{...frame.result,offset:'2'}},
    {...frame,result:{...frame.result,eof:true}},
    {...frame,result:{...frame.result,total_bytes:67108865}},
    {...frame,bytes:new Uint8Array(3)},
    {result:{...frame.result,bytes:0},bytes:new Uint8Array()},
  ])assert.throws(()=>documentDraftReply(input,bad),{code:'invalid_document_response'});
});

test('positive pre-open draft capability requires the complete route and legacy contexts acquire no facade',()=>{
  for(const draftsAvailable of [undefined,false]){const legacy=createDocumentService({draftsAvailable} as DocumentTransport);assert.equal(legacy.draftsAvailable,false);assert.equal(legacy.drafts,undefined);}
  assert.throws(()=>createDocumentService({draftsAvailable:true} as DocumentTransport),{code:'invalid_document_response'});
  assert.throws(()=>createDocumentService({draftsAvailable:true,drafts:{scope:{localStoreId:'store',clientId:'client'},invoke:async()=>null}} as unknown as DocumentTransport),{code:'invalid_document_response'});
  let calls=0;const f=fixture(async()=>{calls++;throw Error('No pre-open request');});const service=createDocumentService({draftsAvailable:true,drafts:f.transport} as DocumentTransport);assert.equal(service.draftsAvailable,true);assert.ok(service.drafts);assert.equal(calls,0);
});

test('shared bridge credits precede chunk copies and survive facade reconstruction until actual settle',async()=>{
  const held:{input:DocumentDraftRequest;bytes:Uint8Array|undefined;gate:ReturnType<typeof deferred<unknown>>}[]=[];
  const f=fixture(async(input,bytes)=>{const gate=deferred<unknown>();held.push({input,bytes,gate});return gate.promise;}),other=createDocumentDraftService(f.transport);
  const original=new Uint8Array(DOCUMENT_DRAFT_CHUNK_BYTES).fill(7),pending:Promise<unknown>[]=[];
  for(let n=0;n<DOCUMENT_DRAFT_PENDING_CALLS;n++)pending.push(f.service.uploadChunk({job,offset:'0'},original));
  original.fill(9);assert.equal(held[0].bytes![0],7);assert.throws(()=>other.uploadChunk({job,offset:'0'},original),{code:'draft_capacity'});assert.equal(held.length,32);
  const rejected=assert.rejects(pending[0],{code:'draft_conflict'});held[0].gate.reject({code:'draft_conflict'});await rejected;
  const admitted=other.uploadChunk({job,offset:'0'},original);assert.equal(held.length,33);
  for(let i=1;i<held.length;i++)held[i].gate.resolve(reply(held[i].input,transfer));await Promise.all([...pending.slice(1),admitted]);
});

test('a browser transport may transfer the exclusive captured input without changing caller bytes',async()=>{
  const original=new Uint8Array([1,2,3]);let received:Uint8Array|undefined;
  const f=fixture(async(input,bytes)=>{received=structuredClone(bytes,{transfer:[bytes!.buffer as ArrayBuffer]});assert.equal(bytes!.byteLength,0);return reply(input,transfer);});
  await f.service.uploadChunk({job,offset:'0'},original);assert.deepEqual([...original],[1,2,3]);assert.deepEqual([...received!],[1,2,3]);
});

for(const outcome of ['success','rejection'])test(`transient owner retirement rejects late ${outcome} and stops owned hint receivers`,async()=>{
  const gate=deferred<unknown>(),f=fixture(async()=>gate.promise);let hints=0,retired=0;
  f.service.subscribe(()=>hints++,()=>retired++);const pending=f.service.snapshot(),rejecting=assert.rejects(pending,{code:'client_not_admitted'});
  const slot=f.slots[0];slot.listener();assert.equal(hints,1);slot.onRetire();assert.equal(retired,1);assert.equal(f.slots.length,0);
  if(outcome==='success')gate.resolve(reply({op:'snapshot'}));else gate.reject({code:'draft_not_ready'});await rejecting;
  assert.throws(()=>f.service.snapshot(),{code:'client_not_admitted'});
});

// The actual host's UploadSeal branch returns its reduction/outcomes with no
// transfer progress, both on first seal and exact Ready-seal replay.
test('upload seal accepts host-shaped normal and Ready replay reductions without synthesized transfer',()=>{
  const input:DocumentDraftRequest={op:'upload_seal',job};
  const first=reply(input);first.result.state.execution='dispatch';
  const ready={...reply(input),result:{...reply(input).result,state:{...reply(input).result.state,execution:'wait_for_acknowledgement',outcomes:[{job,kind:'ready',reason:null}]}}};
  const activeReplay={...first,result:{...first.result,state:{...first.result.state,admitted:job,replay:true}}};
  for(const frame of [first,activeReplay,ready])assert.deepEqual(documentDraftReply(input,frame),frame.result);
  for(const state of [{...activeReplay.result.state,replay:false},{...activeReplay.result.state,admitted:{...job,id:'2'}}])assert.throws(()=>documentDraftReply(input,{...activeReplay,result:{...activeReplay.result,state}}),{code:'invalid_document_response'});
});

test('a throwing transport unsubscribe does not skip retirement observers',()=>{
  let retire!:()=>void,notified=0;
  const service=createDocumentDraftService({scope:{localStoreId:'store',clientId:'client'},invoke:async()=>null,subscribe(_listener,onRetire){retire=onRetire;return()=>{throw Error('Receiver cleanup failed');};}});
  service.subscribe(()=>{},()=>{notified++;});retire();assert.equal(notified,1);
  assert.throws(()=>service.snapshot(),{code:'client_not_admitted'});
});
