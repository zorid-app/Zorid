import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDocumentDraftService} from '../src/core/document-drafts.ts';
import type {DocumentDraftJob,DocumentDraftRequest,DocumentDraftTransport} from '../src/core/document-drafts.ts';
import {DocumentDraftProjection,documentDraftProjectionUsage,DOCUMENT_DRAFT_FRONTEND_BYTES} from '../src/ui/document-draft-projection.ts';
import type {DraftMetadataState} from '../src/ui/document-draft-projection.ts';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function until(predicate:()=>boolean,label='draft state'){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)assert.fail(`Timed out: ${label}`);await new Promise(resolve=>setTimeout(resolve,2));}}
function facts(text:string):any{return {schemaVersion:2,dialectVersion:'zorid-markdown-1',sourceLength:{bytes:Buffer.byteLength(text),utf16:text.length},frontmatter:{state:'absent',range:null,bodyStart:{byte:0,utf16:0}},properties:[],aliases:[`core:${text}`],tags:['from-core'],tagOccurrences:[],headings:text?[{text:'Supplied core heading',level:1,line:0,range:{bytes:[0,Buffer.byteLength(text)],utf16:[0,text.length]}}]:[],links:[],tasks:[],blocks:[],listItems:[],diagnostics:[]};}
interface Owned {job:DocumentDraftJob;source:{bytes:number;utf16:number;sha256:string};bytes:Uint8Array;received:number;sealed:boolean;wire?:Uint8Array;kind?:'ready'|'cancelled'|'superseded';}
function fixture(){
  const events:DocumentDraftRequest[]=[],jobs=new Map<string,Owned>(),receivers=new Set<{hint:()=>void;retire:()=>void}>();let sequence=0;
  const buffers=new Map<string,{revision:string;id:string;released:boolean}>();
  const controls={requestGate:undefined as ReturnType<typeof deferred<void>>|undefined,readGate:undefined as ReturnType<typeof deferred<void>>|undefined,hold:undefined as {op:'snapshot'|'cancel'|'acknowledge';gate:ReturnType<typeof deferred<void>>;reached:boolean;settled:boolean}|undefined,releaseFailures:0,retireOnRelease:false,lifetime:'owner',facts:((text:string)=>facts(text)),wireLength:undefined as number|undefined,autoReady:true,syncSnapshotHints:0,snapshotMode:'normal' as 'normal'|'null'|'other-life',controlMode:'normal' as 'normal'|'null'|'other-life',snapshotActive:0,snapshotMaximum:0};
  const hint=()=>{for(const slot of [...receivers])slot.hint();};
  const transport:DocumentDraftTransport={scope:{localStoreId:'store',clientId:'client'},subscribe(hint,retire){const slot={hint,retire};receivers.add(slot);return()=>receivers.delete(slot);},invoke:async(input,bytes)=>{
    events.push(input);
    const outcome=()=>[...jobs.values()].filter(row=>row.kind).map(row=>({job:row.job,kind:row.kind,reason:null}));
    const reply=(admitted:DocumentDraftJob|null=null,transfer:unknown=null)=>({result:{state:{admitted,replay:false,execution:'wait_for_acknowledgement',outcomes:outcome(),usage:{source_bytes:0,scratch_bytes:0,facts_bytes:0}},transfer,transfer_scratch_bytes:0},bytes:new Uint8Array()});
    if(input.op==='request'){
      const prior=buffers.get(input.buffer_lifetime);
      if(prior&&(prior.released||BigInt(input.text_revision)<BigInt(prior.revision)||input.text_revision===prior.revision&&!jobs.has(prior.id)))throw {code:'draft_expired'};
      if(prior&&input.text_revision===prior.revision){const captured=reply(jobs.get(prior.id)!.job);captured.result.state.replay=true;return captured;}
      if(prior){const old=jobs.get(prior.id);if(old)old.kind='superseded';}
      const job={lifetime:controls.lifetime,id:String(++sequence),buffer_lifetime:input.buffer_lifetime,text_revision:input.text_revision};
      buffers.set(input.buffer_lifetime,{revision:input.text_revision,id:job.id,released:false});
      jobs.set(job.id,{job,source:input.source,bytes:new Uint8Array(input.source.bytes),received:0,sealed:false});const captured=reply(job);await controls.requestGate?.promise;return captured;
    }
    if(input.op==='snapshot'){
      controls.snapshotActive++;controls.snapshotMaximum=Math.max(controls.snapshotMaximum,controls.snapshotActive);
      try{if(controls.syncSnapshotHints-->0)hint();await Promise.resolve();if(controls.snapshotMode==='null')return {result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()};
      const value=reply();if(controls.snapshotMode==='other-life')value.result.state.outcomes=[{job:{lifetime:controls.lifetime,id:'1',buffer_lifetime:'other',text_revision:'1'},kind:'ready',reason:null}];
      const held=controls.hold;if(held?.op==='snapshot'&&!held.reached){const old=[...jobs.values()][0];if(old)value.result.state.outcomes=[{job:old.job,kind:'cancelled',reason:null}];held.reached=true;await held.gate.promise;held.settled=true;}return value;
      }finally{controls.snapshotActive--;}
    }
    if(input.op==='release_buffer'){if(controls.retireOnRelease){controls.retireOnRelease=false;for(const slot of [...receivers])slot.retire();}const prior=buffers.get(input.buffer_lifetime);if(prior)prior.released=true;for(const [id,row]of jobs)if(row.job.buffer_lifetime===input.buffer_lifetime)jobs.delete(id);if(controls.releaseFailures-->0)throw {code:'release_failed'};return reply();}
    if(input.op==='cancel'&&controls.controlMode!=='normal'){
      if(controls.controlMode==='null')return {result:{state:null,transfer:null,transfer_scratch_bytes:0},bytes:new Uint8Array()};
      const value=reply();value.result.state.outcomes=[{job:{lifetime:controls.lifetime,id:'1',buffer_lifetime:'other',text_revision:'1'},kind:'ready',reason:null}];return value;
    }
    const row=jobs.get(input.job.id);if(!row)throw {code:'draft_expired'};
    const transfer=()=>({source_bytes_received:row.received,source_bytes_expected:row.source.bytes,source_sealed:row.sealed,facts_bytes:row.wire?controls.wireLength??row.wire.length:null,scratch_bytes:0});
    if(input.op==='upload_begin'||input.op==='progress')return reply(null,transfer());
    if(input.op==='upload_chunk'){assert.ok(bytes);assert.ok(bytes.length<=128*1024);assert.equal(Number(input.offset),row.received);row.bytes.set(bytes,row.received);row.received+=bytes.length;return reply(null,transfer());}
    if(input.op==='upload_seal'){
      assert.equal(row.received,row.source.bytes);assert.equal(createHash('sha256').update(row.bytes).digest('hex'),row.source.sha256);
      const text=new TextDecoder('utf-8',{fatal:true}).decode(row.bytes);assert.equal(text.length,row.source.utf16);
      row.sealed=true;row.wire=new TextEncoder().encode(JSON.stringify(controls.facts(text)));if(controls.autoReady)row.kind='ready';queueMicrotask(hint);return reply();
    }
    if(input.op==='facts_prepare')return reply(null,transfer());
    if(input.op==='facts_read'){const offset=Number(input.offset),wire=row.wire!,part=wire.slice(offset,offset+input.maximum),captured={result:{job:row.job,offset:input.offset,bytes:part.length,total_bytes:wire.length,eof:offset+part.length===wire.length},bytes:part};await controls.readGate?.promise;return captured;}
    if(input.op==='cancel'){row.kind='cancelled';queueMicrotask(hint);const value=reply(),held=controls.hold;if(held?.op==='cancel'&&!held.reached){held.reached=true;await held.gate.promise;held.settled=true;}return value;}
    if(input.op==='acknowledge'){jobs.delete(input.job.id);const value=reply(),held=controls.hold;if(held?.op==='acknowledge'&&!held.reached){value.result.state.outcomes=[{job:input.job,kind:'cancelled',reason:null}];held.reached=true;await held.gate.promise;held.settled=true;}return value;}
    throw Error('No feature parser/work controls are allowed');
  }};
  const service=createDocumentDraftService(transport),projections:DocumentDraftProjection[]=[];
  return {service,events,controls,jobs,hint,receivers,project(capable=true,onChange?:(state:DraftMetadataState)=>void){const value=new DocumentDraftProjection({owner:service,service:capable?service:undefined,capable,onChange});projections.push(value);return value;},resetOwner(){jobs.clear();buffers.clear();sequence=0;controls.lifetime='replacement';},ready(){for(const row of jobs.values())if(row.sealed)row.kind='ready';hint();},retire(){for(const slot of [...receivers])slot.retire();},async close(){for(const projection of projections)await projection.close();}};
}
const demand={demand:true},idle={demand:false};

test('clean observation is lazy and save-only notifications never request analysis',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project();projection.update('One.md','saved',idle);projection.update('One.md','saved',idle);
  assert.equal(projection.state.textRevision,'1');assert.equal(projection.state.status,'unsupported');assert.equal(f.events.length,0);
  projection.update('One.md','saved',demand);await until(()=>!!projection.current);const count=f.events.filter(e=>e.op==='request').length;
  projection.update('One.md','saved',demand);assert.equal(f.events.filter(e=>e.op==='request').length,count);assert.equal(projection.state.textRevision,'1');
  const cached=projection.current;projection.update('One.md','saved',idle);assert.equal(projection.current,undefined);assert.equal(projection.state.status,'unsupported');
  projection.update('One.md','saved',demand);assert.equal(projection.current,cached);assert.equal(f.events.filter(e=>e.op==='request').length,count);assert.equal(projection.state.textRevision,'1');
});

test('legacy metadata is cached per actual text revision and shared through path changes',async()=>{
  const projection=new DocumentDraftProjection({owner:{},capable:false});projection.update('One.md','# First',demand);const first=projection.current;
  projection.update('One.md','# First',idle);projection.update('One.md','# First',demand);assert.equal(projection.current,first,'demand toggles never reparse the same legacy revision');
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
  const first=f.events.find(e=>e.op==='request') as Extract<DocumentDraftRequest,{op:'request'}>;
  projection.update('One.md','next actual revision',demand);await until(()=>projection.current?.aliases[0]==='core:next actual revision');
  const next=f.events.filter(e=>e.op==='request').at(-1)!;assert.equal(next.buffer_lifetime,first.buffer_lifetime,'higher text revisions reuse the lease after terminal ACK');assert.equal(next.text_revision,'2');assert.equal(f.events.some(e=>e.op==='release_buffer'),false);
  await projection.close();assert.equal(documentDraftProjectionUsage(f.service).bytes,0);
});

test('rapid ABA input coalesces source preparation and retires a late admission without publishing it',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project(),gate=deferred<void>();f.controls.requestGate=gate;
  projection.update('One.md','A',demand);await until(()=>f.events.some(e=>e.op==='request'));
  projection.update('One.md','B',demand);projection.update('One.md','A',demand);assert.equal(projection.current,undefined);gate.resolve();f.controls.requestGate=undefined;
  await until(()=>projection.state.status==='current');assert.equal(projection.state.textRevision,'3');assert.deepEqual(projection.current!.aliases,['core:A']);
  assert.deepEqual(f.events.filter(e=>e.op==='request').map(e=>(e as any).text_revision),['1','3']);assert.ok(f.events.some(e=>e.op==='cancel'&&e.job.text_revision==='1'));
});

test('pending off/on reacquires the same text revision with a distinct lease while old admission is held',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project(),gate=deferred<void>();f.controls.requestGate=gate;
  projection.update('One.md','same',demand);await until(()=>f.events.some(e=>e.op==='request'));const first=f.events.find(e=>e.op==='request') as Extract<DocumentDraftRequest,{op:'request'}>,identity=projection.state.bufferLifetime;
  projection.update('One.md','same',idle);await until(()=>f.events.some(e=>e.op==='release_buffer'&&e.buffer_lifetime===first.buffer_lifetime));projection.update('One.md','same',demand);
  gate.resolve();f.controls.requestGate=undefined;await until(()=>!!projection.current);
  const requests=f.events.filter(e=>e.op==='request');assert.equal(requests.length,2);assert.notEqual(requests[1]!.buffer_lifetime,first.buffer_lifetime);assert.equal(requests[1]!.text_revision,first.text_revision);assert.equal(projection.state.bufferLifetime,identity);
  assert.ok(f.events.filter(e=>e.op==='release_buffer').every(e=>e.buffer_lifetime===first.buffer_lifetime),'late old release never targets the renewed lease');
});

test('Ready facts rejected locally can reacquire only through a fresh lease after terminal ACK',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project();f.controls.facts=text=>({...facts(text),entryId:'forged'});
  projection.update('One.md','same',demand);await until(()=>projection.state.status==='unavailable');await until(()=>f.events.some(e=>e.op==='acknowledge'));
  const first=f.events.find(e=>e.op==='request') as Extract<DocumentDraftRequest,{op:'request'}>;
  await assert.rejects(f.service.request({buffer_lifetime:first.buffer_lifetime,text_revision:first.text_revision,source:first.source}),e=>(e as any).code==='draft_expired','the strict fake core preserves equal-revision anti-resurrection');
  f.controls.facts=facts;projection.update('One.md','same',idle);projection.update('One.md','same',demand);await until(()=>!!projection.current);
  const last=f.events.filter(e=>e.op==='request').at(-1)!;assert.notEqual(last.buffer_lifetime,first.buffer_lifetime);assert.equal(last.text_revision,first.text_revision);
});

test('failed old releases bound renewable lease ownership instead of accumulating nonces forever',async t=>{
  const f=fixture();t.after(()=>f.close());const projection=f.project();f.controls.facts=text=>({...facts(text),entryId:'forged'});f.controls.releaseFailures=10000;
  try{
    for(let i=0;i<33;i++){projection.update('One.md','same',idle);projection.update('One.md','same',demand);await until(()=>projection.state.status==='unavailable');}
    const requests=f.events.filter(e=>e.op==='request');assert.equal(requests.length,32);assert.equal(new Set(requests.map(e=>e.buffer_lifetime)).size,32);assert.ok(requests.every(e=>e.text_revision==='1'));assert.equal(projection.state.code,'resource');
  }finally{f.controls.releaseFailures=0;}
});

test('synchronous snapshot hints reserve one observer before invoking transport',async t=>{
  const f=fixture();t.after(()=>f.close());f.controls.autoReady=false;f.controls.syncSnapshotHints=1;const projection=f.project();projection.update('One.md','waiting',demand);
  await until(()=>f.events.filter(e=>e.op==='snapshot').length>=2);assert.equal(f.controls.snapshotMaximum,1);assert.equal(projection.state.status,'pending');
});

for(const mode of ['null','other-life'] as const)test(`authoritative ${mode} loss permits only explicit renewed analysis and fences old control replies`,async t=>{
  for(const operation of ['snapshot','cancel','acknowledge'] as const){
    const f=fixture(),gate=deferred<void>();t.after(()=>{gate.resolve();return f.close();});f.controls.autoReady=false;const projection=f.project();
    if(operation==='snapshot')f.controls.hold={op:operation,gate,reached:false,settled:false};
    projection.update('One.md','first',demand);await until(()=>f.events.some(e=>e.op==='snapshot'));
    if(operation!=='snapshot'){
      f.controls.hold={op:operation,gate,reached:false,settled:false};projection.update('One.md','waiting',demand);
      await until(()=>f.events.filter(e=>e.op==='upload_seal').length===2);
    }
    await until(()=>!!f.controls.hold?.reached);const held=f.controls.hold!,identity=projection.state.bufferLifetime;
    // A held snapshot cannot deliver expiry itself. A cancellation response is
    // an independent authoritative observation of the now-missing owner.
    f.resetOwner();f.controls.snapshotMode=mode;
    if(operation==='snapshot')f.controls.controlMode=mode;
    f.hint();
    if(operation==='snapshot'){
      // Allow expiry via a newer admitted run while its old snapshot is held.
      projection.update('One.md','waiting',demand);
    }
    await until(()=>projection.state.status==='unavailable');assert.equal(projection.state.code,'unavailable');assert.equal(projection.current,undefined);
    const before=f.events.filter(e=>e.op==='request').length;await new Promise(resolve=>setImmediate(resolve));assert.equal(f.events.filter(e=>e.op==='request').length,before,'failed run never retargets itself');
    f.controls.snapshotMode='normal';f.controls.controlMode='normal';const revision=projection.state.textRevision;
    if(mode==='null')projection.update('One.md','renewed',demand);else{projection.update('One.md','waiting',idle);projection.update('One.md','waiting',demand);}
    await until(()=>f.events.filter(e=>e.op==='upload_seal').at(-1)?.job.lifetime==='replacement');assert.equal(projection.state.status,'pending');
    const next=f.events.filter(e=>e.op==='request').at(-1)!;assert.notEqual(next.buffer_lifetime,(f.events.find(e=>e.op==='request') as any).buffer_lifetime);assert.equal(projection.state.bufferLifetime,identity);if(mode==='other-life')assert.equal(projection.state.textRevision,revision);
    gate.resolve();await until(()=>held.settled);await new Promise(resolve=>setImmediate(resolve));assert.equal(projection.state.status,'pending','late old snapshot/cancel/ACK cannot relatch loss');
    f.ready();await until(()=>!!projection.current);assert.deepEqual(projection.current!.aliases,[`core:${mode==='null'?'renewed':'waiting'}`]);
  }
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

test('close reserves cleanup before delayed admission and synchronous service retirement',async()=>{
  const f=fixture(),projection=f.project(),gate=deferred<void>();f.controls.requestGate=gate;projection.update('One.md','held',demand);await until(()=>f.events.some(e=>e.op==='request'));
  let done=false;const closing=projection.close().then(()=>{done=true;});await until(()=>f.events.some(e=>e.op==='release_buffer'));assert.equal(done,false);
  gate.resolve();await closing;assert.equal(f.events.filter(e=>e.op==='release_buffer').length,2);assert.equal(documentDraftProjectionUsage(f.service).bytes,0);
  f.controls.requestGate=undefined;let second!:DocumentDraftProjection,reentrant:Promise<void>|undefined;
  second=f.project(true,state=>{if(state.status==='unavailable')reentrant=second.close();});second.update('Two.md','second',demand);await until(()=>!!second.current);
  f.controls.retireOnRelease=true;const retired=second.close();await retired;assert.equal(reentrant,retired,'retirement rejoins the already reserved close promise');assert.equal(documentDraftProjectionUsage(f.service).bytes,0);assert.equal(f.receivers.size,0);
});

test('failed buffer release retains the same retired owner and view reservation for explicit retry',async()=>{
  const f=fixture(),projection=f.project();projection.update('One.md','retained',demand);await until(()=>!!projection.current);f.controls.releaseFailures=2;
  await assert.rejects(projection.close(),e=>(e as any).code==='release_failed');assert.equal(projection.current,undefined);assert.ok(documentDraftProjectionUsage(f.service).bytes>0);
  const before=f.events.filter(e=>e.op==='release_buffer').length;await projection.close();assert.ok(f.events.filter(e=>e.op==='release_buffer').length>before);assert.equal(documentDraftProjectionUsage(f.service).bytes,0);
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
