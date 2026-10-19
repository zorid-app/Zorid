import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDocumentDraftService} from '../src/core/document-drafts.ts';
import type {DocumentDraftJob,DocumentDraftRequest,DocumentDraftTransport} from '../src/core/document-drafts.ts';
import {DocumentDraftProjection,documentDraftProjectionUsage,DOCUMENT_DRAFT_FRONTEND_BYTES} from '../src/ui/document-draft-projection.ts';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function until(predicate:()=>boolean,label='draft state'){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)assert.fail(`Timed out: ${label}`);await new Promise(resolve=>setTimeout(resolve,2));}}
function facts(text:string):any{return {schemaVersion:2,dialectVersion:'zorid-markdown-1',sourceLength:{bytes:Buffer.byteLength(text),utf16:text.length},frontmatter:{state:'absent',range:null,bodyStart:{byte:0,utf16:0}},properties:[],aliases:[`core:${text}`],tags:['from-core'],tagOccurrences:[],headings:text?[{text:'Supplied core heading',level:1,line:0,range:{bytes:[0,Buffer.byteLength(text)],utf16:[0,text.length]}}]:[],links:[],tasks:[],blocks:[],listItems:[],diagnostics:[]};}
interface Owned {job:DocumentDraftJob;source:{bytes:number;utf16:number;sha256:string};bytes:Uint8Array;received:number;sealed:boolean;wire?:Uint8Array;kind?:'ready'|'cancelled';}
function fixture(){
  const events:DocumentDraftRequest[]=[],jobs=new Map<string,Owned>(),receivers=new Set<{hint:()=>void;retire:()=>void}>();let sequence=0;
  const controls={requestGate:undefined as ReturnType<typeof deferred<void>>|undefined,readGate:undefined as ReturnType<typeof deferred<void>>|undefined,releaseFailures:0,facts:((text:string)=>facts(text)),wireLength:undefined as number|undefined};
  const hint=()=>{for(const slot of [...receivers])slot.hint();};
  const transport:DocumentDraftTransport={scope:{localStoreId:'store',clientId:'client'},subscribe(hint,retire){const slot={hint,retire};receivers.add(slot);return()=>receivers.delete(slot);},invoke:async(input,bytes)=>{
    events.push(input);
    const outcome=()=>[...jobs.values()].filter(row=>row.kind).map(row=>({job:row.job,kind:row.kind,reason:null}));
    const reply=(admitted:DocumentDraftJob|null=null,transfer:unknown=null)=>({result:{state:{admitted,replay:false,execution:'wait_for_acknowledgement',outcomes:outcome(),usage:{source_bytes:0,scratch_bytes:0,facts_bytes:0}},transfer,transfer_scratch_bytes:0},bytes:new Uint8Array()});
    if(input.op==='request'){
      const job={lifetime:'owner',id:String(++sequence),buffer_lifetime:input.buffer_lifetime,text_revision:input.text_revision};
      jobs.set(job.id,{job,source:input.source,bytes:new Uint8Array(input.source.bytes),received:0,sealed:false});const captured=reply(job);await controls.requestGate?.promise;return captured;
    }
    if(input.op==='snapshot')return reply();
    if(input.op==='release_buffer'){for(const [id,row]of jobs)if(row.job.buffer_lifetime===input.buffer_lifetime)jobs.delete(id);if(controls.releaseFailures-->0)throw {code:'release_failed'};return reply();}
    const row=jobs.get(input.job.id);if(!row)throw {code:'draft_expired'};
    const transfer=()=>({source_bytes_received:row.received,source_bytes_expected:row.source.bytes,source_sealed:row.sealed,facts_bytes:row.wire?controls.wireLength??row.wire.length:null,scratch_bytes:0});
    if(input.op==='upload_begin'||input.op==='progress')return reply(null,transfer());
    if(input.op==='upload_chunk'){assert.ok(bytes);assert.ok(bytes.length<=128*1024);assert.equal(Number(input.offset),row.received);row.bytes.set(bytes,row.received);row.received+=bytes.length;return reply(null,transfer());}
    if(input.op==='upload_seal'){
      assert.equal(row.received,row.source.bytes);assert.equal(createHash('sha256').update(row.bytes).digest('hex'),row.source.sha256);
      const text=new TextDecoder('utf-8',{fatal:true}).decode(row.bytes);assert.equal(text.length,row.source.utf16);
      row.sealed=true;row.wire=new TextEncoder().encode(JSON.stringify(controls.facts(text)));row.kind='ready';queueMicrotask(hint);return reply();
    }
    if(input.op==='facts_prepare')return reply(null,transfer());
    if(input.op==='facts_read'){const offset=Number(input.offset),wire=row.wire!,part=wire.slice(offset,offset+input.maximum),captured={result:{job:row.job,offset:input.offset,bytes:part.length,total_bytes:wire.length,eof:offset+part.length===wire.length},bytes:part};await controls.readGate?.promise;return captured;}
    if(input.op==='cancel'){row.kind='cancelled';queueMicrotask(hint);return reply();}
    if(input.op==='acknowledge'){jobs.delete(input.job.id);return reply();}
    throw Error('No feature parser/work controls are allowed');
  }};
  const service=createDocumentDraftService(transport),projections:DocumentDraftProjection[]=[];
  return {service,events,controls,jobs,hint,receivers,project(capable=true){const value=new DocumentDraftProjection({owner:service,service:capable?service:undefined,capable});projections.push(value);return value;},retire(){for(const slot of [...receivers])slot.retire();},async close(){for(const projection of projections)await projection.close();}};
}
const demand={demand:true},idle={demand:false};

test('clean observation is lazy and save-only notifications never request analysis',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project();projection.update('One.md','saved',idle);projection.update('One.md','saved',idle);
  assert.equal(projection.state.textRevision,'1');assert.equal(projection.state.status,'unsupported');assert.equal(f.events.length,0);
  projection.update('One.md','saved',demand);await until(()=>!!projection.current);const count=f.events.filter(e=>e.op==='request').length;
  projection.update('One.md','saved',demand);assert.equal(f.events.filter(e=>e.op==='request').length,count);assert.equal(projection.state.textRevision,'1');
  projection.update('One.md','saved',idle);assert.equal(projection.current,undefined);assert.equal(projection.state.status,'unsupported');
});

test('legacy metadata is cached per actual text revision and shared through path changes',async()=>{
  const projection=new DocumentDraftProjection({owner:{},capable:false});projection.update('One.md','# First',demand);const first=projection.current;
  projection.update('One.md','# First',demand);assert.equal(projection.current,first);projection.update('Renamed.md','# First',demand);assert.equal(projection.current?.path,'Renamed.md');assert.equal(projection.state.textRevision,'1');
  projection.update('Renamed.md','# Other',idle);projection.update('Renamed.md','# First',demand);assert.equal(projection.state.textRevision,'3');assert.notEqual(projection.current,first);await projection.close();
});

test('a malformed positive capability never acquires the legacy parser',async()=>{
  const projection=new DocumentDraftProjection({owner:{},capable:true});projection.update('One.md','# Legacy would find this',demand);
  assert.equal(projection.state.origin,'core');assert.equal(projection.state.status,'unavailable');assert.equal(projection.current,undefined);await projection.close();
});

test('core transfer preserves exact Unicode CRLF hash and supplied semantic facts',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project();projection.update('One.md','Hé😀\r\ncontent',demand);await until(()=>!!projection.current);
  assert.deepEqual(projection.current!.aliases,['core:Hé😀\r\ncontent']);assert.equal(projection.current!.headings[0]!.heading,'Supplied core heading');assert.deepEqual(projection.current!.tags,['from-core']);
  assert.equal(f.events.filter(e=>e.op==='request').length,1);assert.ok(f.events.some(e=>e.op==='acknowledge'));assert.ok(documentDraftProjectionUsage(f.service).bytes>0);
  await projection.close();assert.equal(documentDraftProjectionUsage(f.service).bytes,0);
});

test('rapid ABA input coalesces source preparation and retires a late admission without publishing it',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project(),gate=deferred<void>();f.controls.requestGate=gate;
  projection.update('One.md','A',demand);await until(()=>f.events.some(e=>e.op==='request'));
  projection.update('One.md','B',demand);projection.update('One.md','A',demand);assert.equal(projection.current,undefined);gate.resolve();f.controls.requestGate=undefined;
  await until(()=>projection.state.status==='current');assert.equal(projection.state.textRevision,'3');assert.deepEqual(projection.current!.aliases,['core:A']);
  assert.deepEqual(f.events.filter(e=>e.op==='request').map(e=>(e as any).text_revision),['1','3']);assert.ok(f.events.some(e=>e.op==='cancel'&&e.job.text_revision==='1'));
});

test('a delayed old facts read cannot replace newer text and its bytes stay charged until settled',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project(),gate=deferred<void>();f.controls.readGate=gate;
  projection.update('One.md','old',demand);await until(()=>f.events.some(e=>e.op==='facts_read'));
  projection.update('One.md','new',demand);assert.equal(projection.current,undefined);assert.ok(documentDraftProjectionUsage(f.service).components['facts-read']);
  gate.resolve();f.controls.readGate=undefined;await until(()=>projection.state.status==='current');assert.deepEqual(projection.current!.aliases,['core:new']);
});

test('source cap and malformed UTF16 become explicit unavailable before a core request',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project();projection.update('One.md','x'.repeat(16*1024*1024+1),demand);assert.equal(projection.state.code,'resource');assert.equal(f.events.length,0);
  projection.update('One.md','broken\ud800',demand);await until(()=>projection.state.status==='unavailable');assert.equal(projection.state.code,'invalid_text');assert.equal(f.events.length,0);
});

for(const malformed of ['identity','over-limit'] as const)test(`${malformed} core facts fail closed without a TS parser fallback`,async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project();
  if(malformed==='identity')f.controls.facts=text=>({...facts(text),entryId:'forged'});else f.controls.wireLength=16*1024*1024+1;
  projection.update('One.md','# Would be a TS heading',demand);await until(()=>projection.state.status==='unavailable');assert.equal(projection.current,undefined);
  assert.equal(projection.state.code,malformed==='identity'?'invalid_facts':'resource');if(malformed==='over-limit')assert.equal(f.events.some(e=>e.op==='facts_read'),false);
});

test('all buffers on the actual service share the logical view and staging ceiling',async t=>{
  const f=fixture();t.after(()=>f.close());f.controls.facts=text=>({...facts(text),aliases:Array(100000).fill('a')});
  const projections:DocumentDraftProjection[]=[];
  for(let i=0;i<4;i++){const projection=f.project();projections.push(projection);projection.update(`${i}.md`,String(i),demand);await until(()=>projection.state.status==='current'||projection.state.status==='unavailable');assert.ok(documentDraftProjectionUsage(f.service).bytes<=DOCUMENT_DRAFT_FRONTEND_BYTES);}
  assert.ok(projections.some(p=>p.state.status==='current'));assert.ok(projections.some(p=>p.state.code==='resource'));
  await f.close();assert.equal(documentDraftProjectionUsage(f.service).bytes,0);
});

test('close sends buffer release before admission ACK and joins the late owned job',async()=>{
  const f=fixture(),projection=f.project(),gate=deferred<void>();f.controls.requestGate=gate;projection.update('One.md','held',demand);await until(()=>f.events.some(e=>e.op==='request'));
  let done=false;const closing=projection.close().then(()=>{done=true;});assert.ok(f.events.some(e=>e.op==='release_buffer'));assert.equal(done,false);
  gate.resolve();await closing;assert.equal(f.events.filter(e=>e.op==='release_buffer').length,2);assert.equal(documentDraftProjectionUsage(f.service).bytes,0);
});

test('failed buffer release retains the same retired owner and view reservation for explicit retry',async()=>{
  const f=fixture(),projection=f.project();projection.update('One.md','retained',demand);await until(()=>!!projection.current);f.controls.releaseFailures=2;
  await assert.rejects(projection.close(),e=>(e as any).code==='release_failed');assert.equal(projection.current,undefined);assert.ok(documentDraftProjectionUsage(f.service).bytes>0);
  const before=f.events.filter(e=>e.op==='release_buffer').length;await projection.close();assert.equal(f.events.filter(e=>e.op==='release_buffer').length,before+2);assert.equal(documentDraftProjectionUsage(f.service).bytes,0);
});

for(const phase of ['admission','hash','read'] as const)test(`authoritative service retirement hands off core disposal during held ${phase}`,async t=>{
  const f=fixture(),projection=f.project(),gate=deferred<void>(),original=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  if(phase==='admission')f.controls.requestGate=gate;
  if(phase==='read')f.controls.readGate=gate;
  let hashing=false;
  if(phase==='hash')Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:crypto.randomUUID.bind(crypto),subtle:{digest:async(...args:Parameters<SubtleCrypto['digest']>)=>{hashing=true;await gate.promise;return original!.get?original!.get.call(globalThis).subtle.digest(...args):(original!.value as Crypto).subtle.digest(...args);}}}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'crypto',original);});
  projection.update('One.md','retiring',demand);await until(()=>phase==='hash'?hashing:f.events.some(e=>e.op===(phase==='admission'?'request':'facts_read')));
  f.retire();const calls=f.events.length;let done=false;const closing=projection.close().then(()=>{done=true;});assert.equal(done,false);gate.resolve();await closing;
  assert.equal(f.events.length,calls,'retired service receives no impossible cleanup RPC');assert.equal(projection.current,undefined);assert.equal(documentDraftProjectionUsage(f.service).bytes,0);assert.equal(f.receivers.size,0);
});
