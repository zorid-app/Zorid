import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopDocumentDraftTransport} from '../src/platform/desktop-document-drafts.ts';
import {createDocumentDraftService,DOCUMENT_DRAFT_PENDING_CALLS,DOCUMENT_DRAFT_CHUNK_BYTES} from '../src/core/document-drafts.ts';
const scope={localStoreId:'store',clientId:'client'},job={lifetime:'owner',id:'1',buffer_lifetime:'buffer',text_revision:'1'};
const value={result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()};
const envelope=(value:unknown)=>({documentDrafts:true,schemaVersion:1,ok:true,value});
function gate(){let resolve!:(value:unknown)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<unknown>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function binding(invoke:(request:unknown,bytes:Uint8Array)=>Promise<unknown>){let retire=()=>{};const result=createDesktopDocumentDraftTransport({scope,invoke,subscribe(_listener,onRetire){retire=onRetire;return()=>{};}});return {...result,retireUpstream:()=>retire()};}
test('desktop draft IPC marker retains typed generic errors and rejects diagnostic escape',async()=>{
  const f=binding(async()=>({documentDrafts:true,schemaVersion:1,ok:false,error:{code:'draft_conflict',commitUncertain:false}}));
  await assert.rejects(f.transport.invoke({op:'snapshot'}),{code:'draft_conflict',commitUncertain:false});
  for(const raw of [value,{...envelope(value),extra:true},{documentDrafts:true,schemaVersion:1,ok:false,error:{code:'draft_io',commitUncertain:false,details:{path:'/private'}}}]){
    const bad=binding(async()=>raw);await assert.rejects(bad.transport.invoke({op:'snapshot'}),{code:'invalid_document_response'});await bad.release();
  }
  let ran=false;const hidden={documentDrafts:true,schemaVersion:1,ok:true,extra:value};Object.defineProperty(hidden,'value',{get(){ran=true;return value;}});
  const guarded=binding(async()=>hidden);await assert.rejects(guarded.transport.invoke({op:'snapshot'}),{code:'invalid_document_response'});assert.equal(ran,false);await guarded.release();await f.release();
});
test('desktop IPC copy admission precedes allocation and release drains accepted calls',async()=>{
  const held:{bytes:Uint8Array;gate:ReturnType<typeof gate>}[]=[];
  const f=binding(async(_request,bytes)=>{const pending=gate();held.push({bytes,gate:pending});return pending.promise;});
  const original=new Uint8Array(DOCUMENT_DRAFT_CHUNK_BYTES).fill(3),pending:Promise<unknown>[]=[];
  for(let i=0;i<DOCUMENT_DRAFT_PENDING_CALLS;i++)pending.push(f.transport.invoke({op:'upload_chunk',job,offset:'0'},original));
  original.fill(8);assert.equal(held[0].bytes[0],3);assert.throws(()=>f.transport.invoke({op:'upload_chunk',job,offset:'0'},original),{code:'draft_capacity'});
  const rejected=pending.map(p=>assert.rejects(p,{code:'client_not_admitted'}));let done=false;const release=f.release().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);
  for(const item of held)item.gate.resolve(envelope(value));await Promise.all(rejected);await release;assert.equal(done,true);
});
for(const completion of ['success','rejection'])test(`desktop retirement fences late ${completion} through common service`,async()=>{
  const held=gate(),f=binding(async()=>held.promise),service=createDocumentDraftService(f.transport);let retired=0;service.subscribe(()=>{},()=>{retired++;});
  const pending=service.snapshot(),rejected=assert.rejects(pending,{code:'client_not_admitted'});f.retireUpstream();assert.equal(retired,1);
  if(completion==='success')held.resolve(envelope(value));else held.reject(Error('lost transport'));await rejected;await f.release();
});
