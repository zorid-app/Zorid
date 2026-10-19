/** Transient, identity-free core facts transport. No source parser, scheduler,
 * save authority, whole-result assembly or allocation grant lives here. */
export const DOCUMENT_DRAFT_CONTROL_BYTES=64*1024;
export const DOCUMENT_DRAFT_CHUNK_BYTES=128*1024;
export const DOCUMENT_DRAFT_SOURCE_BYTES=16*1024*1024;
export const DOCUMENT_DRAFT_INPUT_BYTES=32*1024*1024;
export const DOCUMENT_DRAFT_FACTS_BYTES=64*1024*1024;
export const DOCUMENT_DRAFT_SCRATCH_BYTES=128*1024*1024;
export const DOCUMENT_DRAFT_PENDING_CALLS=32,DOCUMENT_DRAFT_PENDING_BYTES=32*DOCUMENT_DRAFT_CHUNK_BYTES;
export interface DocumentDraftScope {readonly localStoreId:string;readonly clientId:string}
export interface DocumentDraftJob {readonly lifetime:string;readonly id:string;readonly buffer_lifetime:string;readonly text_revision:string}
export interface DocumentDraftSource {readonly bytes:number;readonly utf16:number;readonly sha256:string}
export type DocumentDraftRequest=
  |{readonly op:'request';readonly buffer_lifetime:string;readonly text_revision:string;readonly source:DocumentDraftSource}
  |{readonly op:'upload_begin'|'upload_seal'|'progress'|'facts_prepare'|'cancel'|'acknowledge';readonly job:DocumentDraftJob}
  |{readonly op:'upload_chunk';readonly job:DocumentDraftJob;readonly offset:string}
  |{readonly op:'facts_read';readonly job:DocumentDraftJob;readonly offset:string;readonly maximum:number}
  |{readonly op:'release_buffer';readonly buffer_lifetime:string}
  |{readonly op:'snapshot'};
export interface DocumentDraftUsage {readonly source_bytes:number;readonly scratch_bytes:number;readonly facts_bytes:number}
export interface DocumentDraftOutcome {readonly job:DocumentDraftJob;readonly kind:'ready'|'superseded'|'cancelled'|'retired'|'unavailable';readonly reason:'resource'|'counter_exhausted'|null}
export interface DocumentDraftState {
  readonly admitted:DocumentDraftJob|null;readonly replay:boolean;
  readonly execution:'dispatch'|'wait_for_input'|'wait_for_acknowledgement'|'idle'|'quiesced';
  readonly outcomes:readonly DocumentDraftOutcome[];readonly usage:DocumentDraftUsage;
}
export interface DocumentDraftTransfer {
  readonly source_bytes_received:number;readonly source_bytes_expected:number;readonly source_sealed:boolean;
  readonly facts_bytes:number|null;readonly scratch_bytes:number;
}
export interface DocumentDraftReply {readonly state:DocumentDraftState|null;readonly transfer:DocumentDraftTransfer|null;readonly transfer_scratch_bytes:number}
export interface DocumentDraftReadResult {readonly job:DocumentDraftJob;readonly offset:string;readonly bytes:number;readonly total_bytes:number;readonly eof:boolean}
export interface DocumentDraftRead {readonly result:DocumentDraftReadResult;readonly bytes:Uint8Array}
export interface DocumentDraftTransport {
  readonly scope:DocumentDraftScope;
  /** bytes is the facade's exclusive bounded snapshot. A transport may move /
   * detach it; the caller's source view is untouched. Credit stays charged until
   * invoke settles, and the facade never reads this view after invocation. */
  invoke(request:DocumentDraftRequest,bytes?:Uint8Array):Promise<unknown>;
  subscribe(listener:()=>void,onRetire:()=>void):()=>void;
}
// Bridge-owned copy admission survives facade reconstruction over the same
// admitted transport. It is not a native quota or semantic scheduling policy.
const copies=new WeakMap<DocumentDraftTransport,{calls:number;bytes:number}>();
export interface DocumentDraftService {
  readonly scope:DocumentDraftScope;
  request(input:{readonly buffer_lifetime:string;readonly text_revision:string;readonly source:DocumentDraftSource}):Promise<DocumentDraftReply>;
  uploadBegin(job:DocumentDraftJob):Promise<DocumentDraftReply>;
  uploadChunk(input:{readonly job:DocumentDraftJob;readonly offset:string},bytes:Uint8Array):Promise<DocumentDraftReply>;
  uploadSeal(job:DocumentDraftJob):Promise<DocumentDraftReply>;
  progress(job:DocumentDraftJob):Promise<DocumentDraftReply>;
  prepareFacts(job:DocumentDraftJob):Promise<DocumentDraftReply>;
  readFacts(input:{readonly job:DocumentDraftJob;readonly offset:string;readonly maximum:number}):Promise<DocumentDraftRead>;
  cancel(job:DocumentDraftJob):Promise<DocumentDraftReply>;
  acknowledge(job:DocumentDraftJob):Promise<DocumentDraftReply>;
  releaseBuffer(buffer_lifetime:string):Promise<DocumentDraftReply>;
  snapshot():Promise<DocumentDraftReply>;
  subscribe(listener:()=>void,onRetire?:()=>void):()=>void;
}
export class DocumentDraftError extends Error {
  readonly code:string;
  constructor(code:string){super('Transient document analysis is unavailable.');this.name='DocumentDraftError';this.code=code;}
}
const invalid=(code='invalid_document_response'):never=>{throw new DocumentDraftError(code);};
const object=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return invalid();
  return value as Record<string,unknown>;
};
function fields(value:unknown,names:readonly string[]):Record<string,unknown>{
  const row=object(value),keys=Object.keys(row);
  if(keys.length!==names.length||keys.some(name=>!names.includes(name))||!names.every(name=>{const descriptor=Object.getOwnPropertyDescriptor(row,name);return descriptor?.enumerable===true&&Object.hasOwn(descriptor,'value');}))return invalid();
  return row;
}
const identity=(value:unknown):string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:invalid();
function decimal(value:unknown,positive=false):string{
  if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>18446744073709551615n||positive&&value==='0')return invalid();return value;
}
function count(value:unknown,max:number):number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=max&&!Object.is(value,-0)?value:invalid();}
const boolean=(value:unknown):boolean=>typeof value==='boolean'?value:invalid();
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
function bounded(value:unknown){if(new TextEncoder().encode(JSON.stringify(value)).byteLength>DOCUMENT_DRAFT_CONTROL_BYTES)invalid('draft_control_limit');}
export function documentDraftJob(value:unknown):DocumentDraftJob{
  const row=fields(value,['lifetime','id','buffer_lifetime','text_revision']);return freeze({lifetime:identity(row.lifetime),id:decimal(row.id,true),buffer_lifetime:identity(row.buffer_lifetime),text_revision:decimal(row.text_revision)});
}
const sameJob=(a:DocumentDraftJob,b:DocumentDraftJob)=>a.lifetime===b.lifetime&&a.id===b.id&&a.buffer_lifetime===b.buffer_lifetime&&a.text_revision===b.text_revision;
/** Capture control arguments before awaiting. Raw bytes are captured separately,
 * in one bounded chunk; this never encodes or retains a complete JS source. */
export function documentDraftRequest(value:unknown):DocumentDraftRequest{
  try{
    const descriptor=Object.getOwnPropertyDescriptor(object(value),'op');if(!descriptor||!Object.hasOwn(descriptor,'value'))return invalid();const op=descriptor.value;let request:DocumentDraftRequest;
    if(op==='request'){
      const row=fields(value,['op','buffer_lifetime','text_revision','source']),source=fields(row.source,['bytes','utf16','sha256']);
      const bytes=count(source.bytes,DOCUMENT_DRAFT_SOURCE_BYTES),utf16=count(source.utf16,bytes);
      if((bytes===0)!==(utf16===0)||typeof source.sha256!=='string'||!/^[0-9a-f]{64}$/.test(source.sha256))return invalid();
      request={op,buffer_lifetime:identity(row.buffer_lifetime),text_revision:decimal(row.text_revision),source:{bytes,utf16,sha256:source.sha256}};
    }else if(op==='snapshot'){fields(value,['op']);request={op};}
    else if(op==='release_buffer'){const row=fields(value,['op','buffer_lifetime']);request={op,buffer_lifetime:identity(row.buffer_lifetime)};}
    else if(op==='upload_chunk'||op==='facts_read'){
      const row=fields(value,['op','job','offset',...(op==='facts_read'?['maximum']:[])]),job=documentDraftJob(row.job),offset=decimal(row.offset);
      if(BigInt(offset)>BigInt(op==='upload_chunk'?DOCUMENT_DRAFT_SOURCE_BYTES:DOCUMENT_DRAFT_FACTS_BYTES))return invalid();
      if(op==='facts_read'){const maximum=count(row.maximum,DOCUMENT_DRAFT_CHUNK_BYTES);if(maximum===0)return invalid();request={op,job,offset,maximum};}else request={op,job,offset};
    }else if(op==='upload_begin'||op==='upload_seal'||op==='progress'||op==='facts_prepare'||op==='cancel'||op==='acknowledge'){
      const row=fields(value,['op','job']);request={op,job:documentDraftJob(row.job)};
    }else return invalid();
    bounded(request);return freeze(request);
  }catch(error){if(error instanceof DocumentDraftError&&error.code!=='draft_control_limit')throw new DocumentDraftError('draft_invalid_request');throw error;}
}
function state(value:unknown,request:DocumentDraftRequest):DocumentDraftState|null{
  if(value===null){if(request.op==='request')return invalid();return null;}
  const row=fields(value,['admitted','replay','execution','outcomes','usage']),usage=fields(row.usage,['source_bytes','scratch_bytes','facts_bytes']);
  const admitted=row.admitted===null?null:documentDraftJob(row.admitted),replay=boolean(row.replay);
  if(request.op==='request'?(admitted===null||admitted.buffer_lifetime!==request.buffer_lifetime||admitted.text_revision!==request.text_revision):admitted!==null&&(request.op!=='upload_seal'||!replay||!sameJob(admitted,request.job)))return invalid();
  if(typeof row.execution!=='string'||!['dispatch','wait_for_input','wait_for_acknowledgement','idle','quiesced'].includes(row.execution)||!Array.isArray(row.outcomes)||row.outcomes.length>32)return invalid();
  const seen=new Set<string>();let lifetime=admitted?.lifetime;
  const outcomes=row.outcomes.map(value=>{
    const outcome=fields(value,['job','kind','reason']),job=documentDraftJob(outcome.job),key=job.lifetime+':'+job.id;
    if(seen.has(key)||lifetime!==undefined&&job.lifetime!==lifetime)return invalid();seen.add(key);lifetime??=job.lifetime;
    if(typeof outcome.kind!=='string'||!['ready','superseded','cancelled','retired','unavailable'].includes(outcome.kind)|| (outcome.kind==='unavailable'?typeof outcome.reason!=='string'||!['resource','counter_exhausted'].includes(outcome.reason):outcome.reason!==null))return invalid();
    return {job,kind:outcome.kind,reason:outcome.reason} as DocumentDraftOutcome;
  });
  return {admitted,replay,execution:row.execution as DocumentDraftState['execution'],outcomes,usage:{source_bytes:count(usage.source_bytes,DOCUMENT_DRAFT_INPUT_BYTES),scratch_bytes:count(usage.scratch_bytes,DOCUMENT_DRAFT_SCRATCH_BYTES),facts_bytes:count(usage.facts_bytes,DOCUMENT_DRAFT_FACTS_BYTES)}};
}
/** The native stdio frame owns its own bytes. This validates at most one raw
 * response chunk and bounded control, without parsing/collecting facts JSON. */
export function documentDraftReply(request:DocumentDraftRequest,value:unknown):DocumentDraftReply|DocumentDraftRead{
  const frame=fields(value,['result','bytes']);if(!(frame.bytes instanceof Uint8Array)||frame.bytes.byteLength>DOCUMENT_DRAFT_CHUNK_BYTES)return invalid();
  if(request.op==='facts_read'){
    const row=fields(frame.result,['job','offset','bytes','total_bytes','eof']),job=documentDraftJob(row.job),offset=decimal(row.offset),bytes=count(row.bytes,request.maximum),total_bytes=count(row.total_bytes,DOCUMENT_DRAFT_FACTS_BYTES),eof=boolean(row.eof);
    if(!sameJob(job,request.job)||offset!==request.offset||bytes!==frame.bytes.byteLength||BigInt(offset)+BigInt(bytes)>BigInt(total_bytes)||eof!==(BigInt(offset)+BigInt(bytes)===BigInt(total_bytes))||!eof&&bytes===0)return invalid();
    const result=freeze({job,offset,bytes,total_bytes,eof});bounded(result);return Object.freeze({result,bytes:frame.bytes});
  }
  if(frame.bytes.byteLength!==0)return invalid();
  const row=fields(frame.result,['state','transfer','transfer_scratch_bytes']),current=state(row.state,request),transfer_scratch_bytes=count(row.transfer_scratch_bytes,DOCUMENT_DRAFT_SCRATCH_BYTES);
  if((current?.usage.scratch_bytes??0)+transfer_scratch_bytes>DOCUMENT_DRAFT_SCRATCH_BYTES||current===null&&transfer_scratch_bytes!==0)return invalid();
  let transfer:DocumentDraftTransfer|null=null;
  const needsTransfer=['upload_begin','upload_chunk','progress','facts_prepare'].includes(request.op);
  if(row.transfer===null){if(needsTransfer)return invalid();}
  else{
    if(!needsTransfer||current===null)return invalid();
    const data=fields(row.transfer,['source_bytes_received','source_bytes_expected','source_sealed','facts_bytes','scratch_bytes']);
    const source_bytes_expected=count(data.source_bytes_expected,DOCUMENT_DRAFT_SOURCE_BYTES),source_bytes_received=count(data.source_bytes_received,source_bytes_expected),source_sealed=boolean(data.source_sealed),facts_bytes=data.facts_bytes===null?null:count(data.facts_bytes,DOCUMENT_DRAFT_FACTS_BYTES),scratch_bytes=count(data.scratch_bytes,transfer_scratch_bytes);
    if(source_sealed&&source_bytes_received!==source_bytes_expected||facts_bytes!==null&&!source_sealed||request.op==='facts_prepare'&&facts_bytes===null)return invalid();
    transfer={source_bytes_received,source_bytes_expected,source_sealed,facts_bytes,scratch_bytes};
  }
  const reply={state:current,transfer,transfer_scratch_bytes};bounded(reply);return freeze(reply);
}
/** Core owns admission/coalescing/selection/drop. This facade only captures,
 * routes, decodes and retires its already-admitted transport. */
export function createDocumentDraftService(transport:DocumentDraftTransport):DocumentDraftService{
  if(!transport||typeof transport.invoke!=='function'||typeof transport.subscribe!=='function')return invalid();
  const scopeRow=fields(transport.scope,['localStoreId','clientId']),scope=Object.freeze({localStoreId:identity(scopeRow.localStoreId),clientId:identity(scopeRow.clientId)});
  let owned=copies.get(transport);if(!owned){owned={calls:0,bytes:0};copies.set(transport,owned);}const admission=owned;
  let retired=false,stop=()=>{};const listeners=new Set<{listener:()=>void;onRetire:()=>void}>();
  const active=()=>{if(retired)throw new DocumentDraftError('client_not_admitted');};
  const retire=()=>{if(retired)return;retired=true;try{stop();}catch{/* A receiver failure cannot retain observers. */}for(const slot of [...listeners]){listeners.delete(slot);try{slot.onRetire();}catch{/* Retire every observer. */}}};
  const cleanup=transport.subscribe(()=>{if(!retired)for(const slot of [...listeners])try{slot.listener();}catch{/* A hint is not authoritative completion. */}},retire);
  if(typeof cleanup!=='function')return invalid();stop=cleanup;if(retired){stop();active();}
  const call=(input:DocumentDraftRequest,bytes?:Uint8Array):Promise<DocumentDraftReply|DocumentDraftRead>=>{
    active();const request=documentDraftRequest(input);
    if(request.op==='upload_chunk'?!(bytes instanceof Uint8Array)||bytes.byteLength>DOCUMENT_DRAFT_CHUNK_BYTES:bytes!==undefined)throw new DocumentDraftError('draft_invalid_chunk');
    const size=bytes?.byteLength??0;
    if(admission.calls>=DOCUMENT_DRAFT_PENDING_CALLS||admission.bytes+size>DOCUMENT_DRAFT_PENDING_BYTES)throw new DocumentDraftError('draft_capacity');
    admission.calls++;admission.bytes+=size;let captured:Uint8Array|undefined;
    try{captured=bytes===undefined?undefined:new Uint8Array(bytes);}catch(error){admission.calls--;admission.bytes-=size;throw error;}
    return (async()=>{try{let value:unknown;try{active();value=await transport.invoke(request,captured);}catch(error){active();throw error;}active();return documentDraftReply(request,value);}finally{admission.calls--;admission.bytes-=size;}})();
  };
  const control=(request:DocumentDraftRequest,bytes?:Uint8Array)=>call(request,bytes) as Promise<DocumentDraftReply>;
  const args=(input:unknown,names:readonly string[])=>{try{return fields(input,names);}catch{throw new DocumentDraftError('draft_invalid_request');}};
  return Object.freeze({scope,request:input=>control(documentDraftRequest({op:'request',...args(input,['buffer_lifetime','text_revision','source'])})),uploadBegin:job=>control({op:'upload_begin',job}),uploadChunk:(input,bytes)=>control(documentDraftRequest({op:'upload_chunk',...args(input,['job','offset'])}),bytes),uploadSeal:job=>control({op:'upload_seal',job}),progress:job=>control({op:'progress',job}),prepareFacts:job=>control({op:'facts_prepare',job}),readFacts:input=>call(documentDraftRequest({op:'facts_read',...args(input,['job','offset','maximum'])})) as Promise<DocumentDraftRead>,cancel:job=>control({op:'cancel',job}),acknowledge:job=>control({op:'acknowledge',job}),releaseBuffer:buffer_lifetime=>control({op:'release_buffer',buffer_lifetime}),snapshot:()=>control({op:'snapshot'}),subscribe(listener,onRetire=()=>{}){active();if(typeof listener!=='function'||typeof onRetire!=='function')throw new DocumentDraftError('draft_invalid_request');const slot={listener,onRetire};listeners.add(slot);return()=>{listeners.delete(slot);};}} satisfies DocumentDraftService);
}
