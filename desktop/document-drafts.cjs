'use strict';
// Private stdio framing/identity only. Rust owns parser, transfers and work;
// the common facade owns public DTO decoding. No source or facts are assembled.
const MAX_DRAFT_CONTROL=64*1024,MAX_DRAFT_CHUNK=128*1024,MAX_DRAFT_SOURCE=16*1024*1024,MAX_DRAFT_FACTS=64*1024*1024,MAX_DRAFT_SCRATCH=128*1024*1024;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const keys=(v,names)=>object(v)&&Object.keys(v).length===names.length&&Object.keys(v).every(k=>names.includes(k))&&names.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable===true&&Object.hasOwn(d,'value');});
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const decimal=(v,positive=false)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n&&(!positive||v!=='0');
const integer=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max&&!Object.is(v,-0);
const fail=code=>Object.assign(new Error('Transient document analysis is unavailable.'),{code,commitUncertain:false});
const job=v=>keys(v,['lifetime','id','buffer_lifetime','text_revision'])&&id(v.lifetime)&&decimal(v.id,true)&&id(v.buffer_lifetime)&&decimal(v.text_revision);
const sameJob=(a,b)=>job(a)&&job(b)&&['lifetime','id','buffer_lifetime','text_revision'].every(k=>a[k]===b[k]);
const ticket=v=>keys(v,['incarnation','lane','lifetime','id'])&&id(v.incarnation)&&['committed','draft'].includes(v.lane)&&id(v.lifetime)&&decimal(v.id,true);
const sameTicket=(a,b)=>ticket(a)&&ticket(b)&&['incarnation','lane','lifetime','id'].every(k=>a[k]===b[k]);
function bounded(value,code){let text;try{text=JSON.stringify(value);}catch{throw fail(code);}if(typeof text!=='string'||Buffer.byteLength(text)>MAX_DRAFT_CONTROL)throw fail(code);}
function captureDraftRequest(value){
  if(!object(value)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,'op')??{},'value'))throw fail('draft_invalid_request');
  const op=value.op,fields=op==='request'?['buffer_lifetime','text_revision','source']:op==='release_buffer'?['buffer_lifetime']:op==='snapshot'?[]:op==='upload_chunk'?['job','offset']:op==='facts_read'?['job','offset','maximum']:['upload_begin','upload_seal','progress','facts_prepare','cancel','acknowledge'].includes(op)?['job']:null;
  if(!fields||!keys(value,['op',...fields]))throw fail('draft_invalid_request');
  if(fields.includes('job')&&!job(value.job)||fields.includes('buffer_lifetime')&&!id(value.buffer_lifetime)||fields.includes('offset')&&(!decimal(value.offset)||BigInt(value.offset)>BigInt(op==='upload_chunk'?MAX_DRAFT_SOURCE:MAX_DRAFT_FACTS)))throw fail('draft_invalid_request');
  if(op==='request'&&(!decimal(value.text_revision)||!keys(value.source,['bytes','utf16','sha256'])||!integer(value.source.bytes,MAX_DRAFT_SOURCE)||!integer(value.source.utf16,value.source.bytes)||(value.source.bytes===0)!==(value.source.utf16===0)||typeof value.source.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.source.sha256)))throw fail('draft_invalid_source');
  if(op==='facts_read'&&(!integer(value.maximum,MAX_DRAFT_CHUNK)||value.maximum===0))throw fail('draft_invalid_request');
  bounded(value,'draft_control_limit');return structuredClone(value);
}
function captureDraftBody(request,bytes=new Uint8Array()){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_DRAFT_CHUNK||request.op!=='upload_chunk'&&bytes.byteLength!==0)throw fail('draft_invalid_chunk');
  // This is one bounded JS capture, not a native scratch allocation grant.
  return new Uint8Array(bytes);
}
function decodeDraftReply(request,result,bytes,capture=true){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_DRAFT_CHUNK)throw fail('invalid_document_response');
  bounded(result,'invalid_document_response');
  if(request.op==='facts_read'){
    if(!keys(result,['job','offset','bytes','total_bytes','eof'])||!sameJob(result.job,request.job)||result.offset!==request.offset||!integer(result.bytes,request.maximum)||result.bytes!==bytes.byteLength||!integer(result.total_bytes,MAX_DRAFT_FACTS)||typeof result.eof!=='boolean'||BigInt(result.offset)+BigInt(result.bytes)>BigInt(result.total_bytes)||result.eof!==(BigInt(result.offset)+BigInt(result.bytes)===BigInt(result.total_bytes))||!result.eof&&result.bytes===0)throw fail('invalid_document_response');
  }else{
    if(bytes.byteLength!==0||!keys(result,['state','transfer','transfer_scratch_bytes'])||!integer(result.transfer_scratch_bytes,MAX_DRAFT_SCRATCH))throw fail('invalid_document_response');
    const state=result.state;
    if(state!==null&&(!keys(state,['admitted','replay','execution','outcomes','usage'])||state.admitted!==null&&!job(state.admitted)||typeof state.replay!=='boolean'||!['dispatch','wait_for_input','wait_for_acknowledgement','idle','quiesced'].includes(state.execution)||!Array.isArray(state.outcomes)||state.outcomes.length>32||!state.outcomes.every(v=>keys(v,['job','kind','reason'])&&job(v.job)&&['ready','superseded','cancelled','retired','unavailable'].includes(v.kind)&&(v.kind==='unavailable'?['resource','counter_exhausted'].includes(v.reason):v.reason===null))||!keys(state.usage,['source_bytes','scratch_bytes','facts_bytes'])||!integer(state.usage.source_bytes,32*1024*1024)||!integer(state.usage.scratch_bytes,MAX_DRAFT_SCRATCH)||!integer(state.usage.facts_bytes,MAX_DRAFT_FACTS)))throw fail('invalid_document_response');
    if((state?.usage.scratch_bytes??0)+result.transfer_scratch_bytes>MAX_DRAFT_SCRATCH||state===null&&result.transfer_scratch_bytes!==0)throw fail('invalid_document_response');
    const transfer=result.transfer;
    if(transfer!==null&&(!keys(transfer,['source_bytes_received','source_bytes_expected','source_sealed','facts_bytes','scratch_bytes'])||!integer(transfer.source_bytes_expected,MAX_DRAFT_SOURCE)||!integer(transfer.source_bytes_received,transfer.source_bytes_expected)||typeof transfer.source_sealed!=='boolean'||transfer.facts_bytes!==null&&!integer(transfer.facts_bytes,MAX_DRAFT_FACTS)||!integer(transfer.scratch_bytes,result.transfer_scratch_bytes)))throw fail('invalid_document_response');
  }
  return capture?{result:structuredClone(result),bytes:new Uint8Array(bytes)}:{result,bytes};
}
function validDraftReply(command,result,bytes){try{decodeDraftReply(command.request,result,bytes,false);return true;}catch{return false;}}
function captureWorkRequest(value){
  const descriptor=object(value)&&Object.getOwnPropertyDescriptor(value,'op');const op=descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;if(!['next_turn','snapshot','close','step'].includes(op)||!keys(value,op==='step'?['op','ticket']:['op'])||op==='step'&&!ticket(value.ticket))throw fail('draft_invalid_request');bounded(value,'draft_control_limit');return structuredClone(value);
}
function decodeWorkReply(request,result,bytes){
  bounded(result,'invalid_document_response');if(!(bytes instanceof Uint8Array)||bytes.byteLength!==0||!keys(result,['work','turn']))throw fail('invalid_document_response');
  const work=result.work,turn=result.turn;
  if(work!==null&&(!keys(work,['selected','last_settled','closing','close_ready'])||work.selected!==null&&!ticket(work.selected)||work.last_settled!==null&&!ticket(work.last_settled)||typeof work.closing!=='boolean'||typeof work.close_ready!=='boolean'||work.close_ready&&(!work.closing||work.selected!==null)))throw fail('invalid_document_response');
  if(turn!==null&&(request.op!=='next_turn'||!keys(turn,['state'])||!['ready','waiting','quiesced'].includes(turn.state))||request.op==='next_turn'&&work!==null&&turn===null||turn?.state==='ready'&&work?.selected==null)throw fail('invalid_document_response');
  return structuredClone(result);
}
function validWorkReply(command,result,bytes){try{decodeWorkReply(command.request,result,bytes);return true;}catch{return false;}}
module.exports={MAX_DRAFT_CONTROL,MAX_DRAFT_CHUNK,captureDraftRequest,captureDraftBody,decodeDraftReply,validDraftReply,captureWorkRequest,decodeWorkReply,validWorkReply,sameTicket};
