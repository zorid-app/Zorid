'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {captureDraftRequest,captureDraftBody,decodeDraftReply,captureWorkRequest,decodeWorkReply,MAX_DRAFT_CHUNK}=require('../desktop/document-drafts.cjs');
const job={lifetime:'owner',id:'9007199254740993',buffer_lifetime:'buffer',text_revision:'18446744073709551615'};
const ticket={incarnation:'incarnation',lane:'draft',lifetime:'owner',id:'1'};
const empty={state:null,transfer:null,transfer_scratch_bytes:0};
test('stdio draft controls capture full token and reject renderer work and accessor compensation',()=>{
  const input={op:'upload_chunk',job:{...job},offset:'0'},captured=captureDraftRequest(input);input.job.id='2';assert.equal(captured.job.id,job.id);
  for(const value of [{op:'Complete',job},{op:'step',ticket},{op:'next_turn'},{op:'progress',job:{...job,id:'01'}},{op:'facts_read',job,offset:'0',maximum:131073}])assert.throws(()=>captureDraftRequest(value));
  let ran=false;const hidden={op:'progress',extra:job};Object.defineProperty(hidden,'job',{get(){ran=true;return job;}});assert.throws(()=>captureDraftRequest(hidden));assert.equal(ran,false);
});
test('raw upload capture is bounded, independent and exclusive to upload chunk',()=>{
  const input={op:'upload_chunk',job,offset:'0'},bytes=new Uint8Array([1,2]);const captured=captureDraftBody(input,bytes);bytes.fill(9);assert.deepEqual([...captured],[1,2]);
  assert.equal(captureDraftBody(input,new Uint8Array(MAX_DRAFT_CHUNK)).length,MAX_DRAFT_CHUNK);
  assert.throws(()=>captureDraftBody(input,new Uint8Array(MAX_DRAFT_CHUNK+1)),{code:'draft_invalid_chunk'});
  assert.throws(()=>captureDraftBody({op:'upload_seal',job},new Uint8Array([1])),{code:'draft_invalid_chunk'});
});
test('raw facts framing binds exact token offset length and EOF without decoding facts',()=>{
  const request={op:'facts_read',job,offset:'1',maximum:2},bytes=new Uint8Array([0x92,0xa9]);
  const result={job,offset:'1',bytes:2,total_bytes:5,eof:false};assert.deepEqual([...decodeDraftReply(request,result,bytes).bytes],[0x92,0xa9]);
  for(const changed of [{...result,job:{...job,lifetime:'other'}},{...result,offset:'2'},{...result,bytes:1},{...result,eof:true}])assert.throws(()=>decodeDraftReply(request,changed,bytes),{code:'invalid_document_response'});
  assert.throws(()=>decodeDraftReply({op:'snapshot'},empty,bytes),{code:'invalid_document_response'});
});
test('trusted work accepts identity only and close-ready must represent an actual drained selection',()=>{
  assert.deepEqual(captureWorkRequest({op:'step',ticket}),{op:'step',ticket});
  for(const value of [{op:'Complete',ticket},{op:'step',ticket:{...ticket,phase:'Parse'}},{op:'step',ticket:{...ticket,id:'0'}},{op:'next_turn',ticket}])assert.throws(()=>captureWorkRequest(value));
  const work={selected:null,last_settled:ticket,closing:true,close_ready:true};assert.deepEqual(decodeWorkReply({op:'close'},{work,turn:null},new Uint8Array()),{work,turn:null});
  assert.throws(()=>decodeWorkReply({op:'close'},{work:{...work,selected:ticket},turn:null},new Uint8Array()),{code:'invalid_document_response'});
  assert.throws(()=>decodeWorkReply({op:'next_turn'},{work:{...work,close_ready:false},turn:{state:'ready'}},new Uint8Array()),{code:'invalid_document_response'});
});
