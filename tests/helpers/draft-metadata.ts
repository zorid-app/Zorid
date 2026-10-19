import assert from 'node:assert/strict';
import {createDocumentDraftService} from '../../src/core/document-drafts.ts';
import type {DocumentDraftJob,DocumentDraftRequest,DocumentDraftTransport} from '../../src/core/document-drafts.ts';
export function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
export async function until(predicate:()=>boolean,label='draft metadata'){const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)assert.fail(`Timed out: ${label}`);await new Promise(resolve=>setTimeout(resolve,2));}}
/** Actual common facade with a deterministic trusted-host protocol fixture.
 * Facts are supplied data, deliberately different from the Markdown source. */
export function draftMetadataHarness(){
  const events:DocumentDraftRequest[]=[],listeners=new Set<{hint:()=>void;retire:()=>void}>(),jobs=new Map<string,{job:DocumentDraftJob;bytes:Uint8Array;received:number;sealed:boolean;wire?:Uint8Array;kind?:'ready'|'cancelled'}>();
  const failedLeases=new Set<string>();
  let id=0,requestGate:ReturnType<typeof deferred>|undefined,releaseGate:ReturnType<typeof deferred>|undefined,releaseFailures=0,invalid=false,rejectRequest=false;
  const hint=()=>{for(const entry of [...listeners])entry.hint();};
  const reply=(admitted:DocumentDraftJob|null=null,transfer:unknown=null)=>({result:{state:{admitted,replay:false,execution:'wait_for_acknowledgement',outcomes:[...jobs.values()].filter(row=>row.kind).map(row=>({job:row.job,kind:row.kind,reason:null})),usage:{source_bytes:0,scratch_bytes:0,facts_bytes:0}},transfer,transfer_scratch_bytes:0},bytes:new Uint8Array()});
  const transport:DocumentDraftTransport={scope:{localStoreId:'store',clientId:'client'},subscribe(hint,retire){const row={hint,retire};listeners.add(row);return()=>listeners.delete(row);},async invoke(input,part){
    events.push(input);
    if(input.op==='request'){
      if(rejectRequest)throw {code:'draft_resource_limit'};
      const job={lifetime:'owner',id:String(++id),buffer_lifetime:input.buffer_lifetime,text_revision:input.text_revision};jobs.set(job.id,{job,bytes:new Uint8Array(input.source.bytes),received:0,sealed:false});const captured=reply(job);await requestGate?.promise;return captured;
    }
    if(input.op==='snapshot')return reply();
    if(input.op==='release_buffer'){for(const [id,row]of jobs)if(row.job.buffer_lifetime===input.buffer_lifetime)jobs.delete(id);await releaseGate?.promise;if(failedLeases.has(input.buffer_lifetime)||releaseFailures>0){if(releaseFailures>0)releaseFailures--;throw {code:'release_failed'};}return reply();}
    const row=jobs.get(input.job.id);if(!row)throw {code:'draft_expired'};
    const transfer=()=>({source_bytes_received:row.received,source_bytes_expected:row.bytes.length,source_sealed:row.sealed,facts_bytes:row.wire?.length??null,scratch_bytes:0});
    if(input.op==='upload_begin'||input.op==='progress'||input.op==='facts_prepare')return reply(null,transfer());
    if(input.op==='upload_chunk'){assert.ok(part);row.bytes.set(part,Number(input.offset));row.received+=part.length;return reply(null,transfer());}
    if(input.op==='upload_seal'){
      const text=new TextDecoder('utf-8',{fatal:true}).decode(row.bytes),facts={schemaVersion:2,dialectVersion:'zorid-markdown-1',sourceLength:{bytes:row.bytes.length,utf16:text.length},frontmatter:{state:'absent',range:null,bodyStart:{byte:0,utf16:0}},properties:[],aliases:[`Rust ${text}`],tags:['rust'],tagOccurrences:[],headings:text?[{text:'Rust supplied heading',level:2,line:0,range:{bytes:[0,row.bytes.length],utf16:[0,text.length]}}]:[],links:[],tasks:[],blocks:[],listItems:[],diagnostics:[],...(invalid?{entryId:'forged'}:{})};
      row.sealed=true;row.kind='ready';row.wire=new TextEncoder().encode(JSON.stringify(facts));queueMicrotask(hint);return reply();
    }
    if(input.op==='facts_read'){const offset=Number(input.offset),wire=row.wire!,bytes=wire.slice(offset,offset+input.maximum);return {result:{job:row.job,offset:input.offset,bytes:bytes.length,total_bytes:wire.length,eof:offset+bytes.length===wire.length},bytes};}
    if(input.op==='cancel'){row.kind='cancelled';queueMicrotask(hint);return reply();}
    if(input.op==='acknowledge'){jobs.delete(input.job.id);return reply();}
    throw Error('Unexpected feature work control');
  }};
  return {service:createDocumentDraftService(transport),events,jobs,get subscriptions(){return listeners.size;},holdRequest(){return requestGate=deferred();},holdRelease(){return releaseGate=deferred();},failRelease(lease?:string){if(lease)failedLeases.add(lease);else releaseFailures++;},allowRelease(lease:string){failedLeases.delete(lease);},invalidFacts(){invalid=true;},rejectRequests(){rejectRequest=true;},retire(){for(const entry of [...listeners])entry.retire();}};
}
